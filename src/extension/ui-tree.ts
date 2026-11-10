import type { Adb, AdbShellProtocolProcess } from "@yume-chan/adb";
import { AdbScrcpyClient } from "@yume-chan/adb-scrcpy";
import { ReadableStream, WritableStream } from "@yume-chan/stream-extra";
import { errorText } from "../shared/protocol.js";
import {
  MAX_UI_TREE_BYTES,
  parseUiTree,
  parseUiNodeAction,
  parseUiNodeActionResult,
  UI_TREE_PROTOCOL_VERSION,
  uiRecord,
} from "../shared/ui-tree.js";
import type {
  UiTreeSnapshot,
  UiNodeActionRequest,
  UiNodeActionResult,
} from "../shared/ui-tree.js";

type Pending<T> = {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};
type Writer = ReturnType<AdbShellProtocolProcess["stdin"]["getWriter"]>;
type UiPending = { id: number } & (
  | ({ type: "snapshot" } & Pending<UiTreeSnapshot>)
  | ({
      type: "action";
      request: UiNodeActionRequest;
    } & Pending<UiNodeActionResult>)
);

async function launch(
  adb: Adb,
  signal: AbortSignal,
): Promise<AdbShellProtocolProcess> {
  const shell = adb.subprocess.shellProtocol;
  if (!shell?.isSupported)
    throw new Error("UI tree 需要 Android 7+ 和 ADB shell v2。");
  const response = await fetch(chrome.runtime.getURL("ui-helper.jar"), {
    signal,
  });
  if (!response.ok)
    throw new Error(`UI helper 文件读取失败 (${response.status})。`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > MAX_UI_TREE_BYTES)
    throw new Error("UI helper 文件大小无效。");
  const path = `/data/local/tmp/tango-ui-${crypto.randomUUID()}.jar`;
  try {
    await AdbScrcpyClient.pushServer(
      adb,
      new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      path,
    );
    signal.throwIfAborted();
    const process = await shell.spawn([
      `CLASSPATH=${path}`,
      "exec",
      "app_process",
      "/",
      "com.tango.uitree.UiTreeServer",
    ]);
    return {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      exited: process.exited,
      async kill() {
        try {
          await process.kill();
        } finally {
          await adb.rm(path);
        }
      },
    };
  } catch (error) {
    try {
      await adb.rm(path);
    } catch (cleanupError) {
      throw new Error(
        `${errorText(error)}\nUI helper 文件清理失败：${errorText(cleanupError)}`,
      );
    }
    throw error;
  }
}

export class UiTreeSession {
  private readonly abort = new AbortController();
  private process?: AdbShellProtocolProcess;
  private writer?: Writer;
  private starting?: Promise<void>;
  private closing?: Promise<void>;
  private ready?: Pending<void>;
  private pending?: UiPending;
  private current?: { snapshot: UiTreeSnapshot; expires: number };
  private busy = false;
  private closed = false;
  private failure?: Error;
  private sequence = 0;
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  constructor(
    private readonly spawn: (
      signal: AbortSignal,
    ) => Promise<AdbShellProtocolProcess>,
    private readonly timeouts: {
      startup: number;
      snapshot: number;
      cleanup?: number;
    } = { startup: 20_000, snapshot: 8_000 },
  ) {}

  static forAdb(adb: Adb) {
    return new UiTreeSession((signal) => launch(adb, signal));
  }

  get usable() {
    return !this.closed;
  }

  capture(): Promise<UiTreeSnapshot> {
    return this.request("snapshot");
  }

  invalidate() {
    this.current = undefined;
  }

  validateAction(value: UiNodeActionRequest): UiNodeActionRequest {
    const request = parseUiNodeAction(value);
    if (this.closed) throw new Error("UI tree 会话已结束，请重新读取。");
    if (this.busy) throw new Error("已有 UI helper 请求正在进行，请稍后重试。");
    const current = this.current;
    if (
      !current ||
      current.snapshot.snapshotRef !== request.snapshotRef ||
      performance.now() >= current.expires
    )
      throw new Error("节点引用已失效或过期，请重新读取 UI tree。");
    const node = current.snapshot.nodes[request.nodeId];
    if (
      !node ||
      !node.enabled ||
      !node.visible ||
      !node.actions.includes(request.action)
    )
      throw new Error("当前节点不支持此动作或不可操作，请重新读取。");
    return request;
  }

  async performAction(value: UiNodeActionRequest): Promise<UiNodeActionResult> {
    const request = this.validateAction(value);
    this.invalidate();
    return this.request("action", request);
  }

  private request(method: "snapshot"): Promise<UiTreeSnapshot>;
  private request(
    method: "action",
    request: UiNodeActionRequest,
  ): Promise<UiNodeActionResult>;
  private async request(
    method: "snapshot" | "action",
    request?: UiNodeActionRequest,
  ): Promise<UiTreeSnapshot | UiNodeActionResult> {
    if (this.closed) throw new Error("UI tree 会话已结束，请重新读取。");
    if (this.busy) throw new Error("已有 UI helper 请求正在进行，请稍后重试。");
    if (method === "snapshot") this.invalidate();
    this.busy = true;
    try {
      this.starting ??= this.deadline(
        Promise.race([
          this.open(),
          new Promise<never>((_, reject) => {
            this.abort.signal.addEventListener(
              "abort",
              () => reject(this.abort.signal.reason),
              { once: true },
            );
          }),
        ]),
        this.timeouts.startup,
        "UI helper 启动超时。",
      );
      try {
        await this.starting;
      } catch (error) {
        this.fail(new Error(errorText(error)));
        throw error;
      }
      if (this.closed) throw new Error("UI tree 会话已结束。");
      const id = ++this.sequence;
      return await this.deadline(
        new Promise<UiTreeSnapshot | UiNodeActionResult>((resolve, reject) => {
          if (method === "action") {
            if (!request) throw new Error("缺少节点动作。");
            this.pending = { type: "action", request, id, resolve, reject };
          } else this.pending = { type: "snapshot", id, resolve, reject };
          void this.writer!.write(
            new TextEncoder().encode(
              `${JSON.stringify({ v: UI_TREE_PROTOCOL_VERSION, id, method, ...(request ? { request } : {}) })}\n`,
            ),
          ).catch((error: unknown) =>
            this.fail(new Error(`UI helper 请求发送失败：${errorText(error)}`)),
          );
        }),
        this.timeouts.snapshot,
        method === "snapshot"
          ? "UI tree 读取超时；没有返回旧快照。"
          : "节点动作超时，结果未知；请重新读取确认，不要自动重试。",
      );
    } finally {
      this.busy = false;
    }
  }

  private deadline<T>(
    operation: Promise<T>,
    milliseconds: number,
    message: string,
    terminate = true,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(message);
        if (terminate) this.fail(error);
        reject(error);
      }, milliseconds);
      operation.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private async open() {
    const process = await this.spawn(this.abort.signal);
    if (this.closed) {
      void process.stdout
        .pipeTo(new WritableStream({ write: () => {} }))
        .catch((error: unknown) =>
          console.error("Cancelled UI helper stdout:", error),
        );
      void process.stderr
        .pipeTo(new WritableStream({ write: () => {} }))
        .catch((error: unknown) =>
          console.error("Cancelled UI helper stderr:", error),
        );
      void process.exited.catch((error: unknown) =>
        console.error("Cancelled UI helper exit:", error),
      );
      try {
        await process.kill();
      } catch (error) {
        console.error("Cancelled UI helper cleanup failed:", error);
        throw error;
      }
      throw new Error("UI tree 会话已取消。");
    }
    const ready = new Promise<void>((resolve, reject) => {
      this.ready = { resolve, reject };
    });
    this.process = process;
    this.writer = process.stdin.getWriter();
    void process.stdout
      .pipeTo(
        new WritableStream({
          write: (bytes) => this.receive(bytes),
        }),
      )
      .then(
        () => {
          if (!this.closed)
            this.fail(new Error("UI helper 输出已结束，请重新读取。"));
        },
        (error: unknown) => {
          if (!this.closed)
            this.fail(new Error(`UI helper 输出失败：${errorText(error)}`));
        },
      );
    void process.stderr
      .pipeTo(
        new WritableStream({
          // Drain diagnostics without retaining or logging potentially sensitive device output.
          write: () => {},
        }),
      )
      .catch((error: unknown) => {
        if (!this.closed)
          this.fail(new Error(`UI helper 日志通道失败：${errorText(error)}`));
      });
    void process.exited.then(
      (code) => {
        if (!this.closed)
          this.fail(
            new Error(
              `UI helper 已退出 (${code})，请检查 Android/OEM 兼容性或其他 UI 自动化工具占用。`,
            ),
          );
      },
      (error: unknown) => {
        if (!this.closed)
          this.fail(new Error(`UI helper 连接失败：${errorText(error)}`));
      },
    );
    await ready;
  }

  private receive(bytes: Uint8Array) {
    if (this.closed) return;
    this.buffer += this.decoder.decode(bytes, { stream: true });
    if (new TextEncoder().encode(this.buffer).byteLength > MAX_UI_TREE_BYTES)
      throw new Error("UI helper 响应超过 1 MiB。");
    let end: number;
    while ((end = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      const message: unknown = JSON.parse(line);
      if (!uiRecord(message) || message.v !== UI_TREE_PROTOCOL_VERSION)
        throw new Error("UI helper 协议版本无效。");
      if (
        message.type === "ready" &&
        message.helperVersion === UI_TREE_PROTOCOL_VERSION &&
        this.ready
      ) {
        this.ready.resolve();
        this.ready = undefined;
      } else if (
        message.type === "error" &&
        typeof message.code === "string" &&
        typeof message.message === "string" &&
        message.message.length <= 2048
      ) {
        if (message.id !== 0 && message.id !== this.pending?.id)
          throw new Error("UI helper 错误响应序号无效。");
        const error = new Error(`UI tree ${message.code}：${message.message}`);
        if (message.id === 0) this.fail(error);
        else {
          this.pending?.reject(error);
          this.pending = undefined;
        }
      } else if (
        message.type === "snapshot" &&
        this.pending?.type === "snapshot" &&
        message.id === this.pending.id
      ) {
        const snapshot = parseUiTree(message.snapshot);
        if (snapshot.snapshotId !== message.id)
          throw new Error("UI tree 快照序号不匹配。");
        this.current = {
          snapshot,
          expires: performance.now() + snapshot.expiresInMs,
        };
        this.pending.resolve(snapshot);
        this.pending = undefined;
      } else if (
        message.type === "action" &&
        this.pending?.type === "action" &&
        message.id === this.pending.id
      ) {
        const result = parseUiNodeActionResult(message.result);
        const request = this.pending.request;
        if (
          result.snapshotRef !== request.snapshotRef ||
          result.nodeId !== request.nodeId ||
          result.action !== request.action
        )
          throw new Error(
            "UI helper 节点动作回执与请求不匹配；结果未知，请重新读取确认。",
          );
        this.pending.resolve(result);
        this.pending = undefined;
      } else throw new Error("UI helper 返回了未知或过期响应。");
    }
  }

  private fail(error: Error) {
    this.failure ??= error;
    this.ready?.reject(error);
    this.ready = undefined;
    this.pending?.reject(error);
    this.pending = undefined;
    void this.close().catch((cleanupError: unknown) =>
      console.error("UI helper cleanup failed:", cleanupError),
    );
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.invalidate();
    const error = this.failure ?? new Error("UI tree 会话已取消。");
    this.abort.abort(error);
    this.ready?.reject(error);
    this.ready = undefined;
    this.pending?.reject(error);
    this.pending = undefined;
    this.buffer = "";
    const process = this.process;
    this.process = undefined;
    const writer = this.writer;
    this.writer = undefined;
    this.closing = this.deadline(
      Promise.resolve().then(async () => {
        const failures: string[] = [];
        try {
          if (writer)
            await this.deadline(
              writer.close(),
              500,
              "UI helper 标准输入关闭超时。",
              false,
            );
        } catch (error) {
          failures.push(errorText(error));
        }
        try {
          await process?.kill();
        } catch (error) {
          failures.push(errorText(error));
        } finally {
          writer?.releaseLock();
        }
        if (failures.length) throw new Error(failures.join("\n"));
      }),
      this.timeouts.cleanup ?? 3000,
      "UI helper 关闭超时；投屏资源将继续释放。",
      false,
    );
    return this.closing;
  }
}
