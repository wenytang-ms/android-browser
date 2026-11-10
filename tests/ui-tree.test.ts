import { afterEach, describe, expect, it, vi } from "vitest";
import { MaybeConsumable, ReadableStream } from "@yume-chan/stream-extra";
import type { ReadableStreamDefaultController } from "@yume-chan/stream-extra";
import type { AdbShellProtocolProcess } from "@yume-chan/adb";
import { UiTreeSession } from "../src/extension/ui-tree.js";
import {
  MAX_UI_TREE_BYTES,
  parseUiTree,
  UI_TREE_PROTOCOL_VERSION as V,
  UI_NODE_ACTIONS,
} from "../src/shared/ui-tree.js";
import type {
  UiNodeActionRequest,
  UiNodeAction,
} from "../src/shared/ui-tree.js";
import { uiTreeFixture } from "./ui-tree-fixture.js";

function fixture() {
  let stdout!: ReadableStreamDefaultController<Uint8Array>;
  let stderr!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  let stdoutClosed = false;
  let stderrClosed = false;
  const requests: {
    v: number;
    id: number;
    method: string;
    request?: UiNodeActionRequest;
  }[] = [];
  const process: AdbShellProtocolProcess = {
    stdin: new MaybeConsumable.WritableStream<Uint8Array>({
      write(bytes) {
        requests.push(JSON.parse(new TextDecoder().decode(bytes)));
      },
    }),
    stdout: new ReadableStream({
      start(controller) {
        stdout = controller;
      },
      cancel() {
        stdoutClosed = true;
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        stderr = controller;
      },
      cancel() {
        stderrClosed = true;
      },
    }),
    exited: new Promise<number>((resolve) => {
      exit = resolve;
    }),
    kill: vi.fn(async () => {
      if (!stdoutClosed) {
        stdoutClosed = true;
        stdout.close();
      }
      if (!stderrClosed) {
        stderrClosed = true;
        stderr.close();
      }
      exit(0);
    }),
  };
  const send = (message: unknown, fragment = 0) => {
    const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    if (!fragment) stdout.enqueue(bytes);
    else
      for (let offset = 0; offset < bytes.length; offset += fragment)
        stdout.enqueue(bytes.slice(offset, offset + fragment));
  };
  const spawn = vi.fn(async () => {
    send({ v: V, type: "ready", helperVersion: V });
    return process;
  });
  return {
    process,
    requests,
    spawn,
    send,
    raw: (bytes: Uint8Array) => stdout.enqueue(bytes),
  };
}

describe("on-demand UI tree", () => {
  const sessions: UiTreeSession[] = [];
  const create = (
    spawn: ConstructorParameters<typeof UiTreeSession>[0],
    snapshot = 1000,
    startup = 1000,
  ) => {
    const session = new UiTreeSession(spawn, { startup, snapshot });
    sessions.push(session);
    return session;
  };
  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
  });

  it("lazily starts once, reads fresh snapshots only on demand and handles fragmented UTF-8", async () => {
    const phone = fixture();
    const session = create(phone.spawn);
    expect(phone.spawn).not.toHaveBeenCalled();
    const first = session.capture();
    await vi.waitFor(() => expect(phone.requests).toHaveLength(1));
    phone.send(
      { v: V, type: "snapshot", id: 1, snapshot: uiTreeFixture(1) },
      7,
    );
    expect((await first).nodes[1].description).toBe("\u8bbe\u7f6e");
    const second = session.capture();
    await vi.waitFor(() => expect(phone.requests).toHaveLength(2));
    phone.send({ v: V, type: "snapshot", id: 2, snapshot: uiTreeFixture(2) });
    expect((await second).snapshotId).toBe(2);
    expect(phone.spawn).toHaveBeenCalledOnce();
    expect(phone.requests.map(({ method }) => method)).toEqual([
      "snapshot",
      "snapshot",
    ]);
  });

  it("rejects concurrent capture without interrupting the first request", async () => {
    const phone = fixture();
    const session = create(phone.spawn);
    const first = session.capture();
    await vi.waitFor(() => expect(phone.requests).toHaveLength(1));
    await expect(session.capture()).rejects.toThrow("正在进行");
    expect(phone.process.kill).not.toHaveBeenCalled();
    phone.send({ v: V, type: "snapshot", id: 1, snapshot: uiTreeFixture(1) });
    await expect(first).resolves.toHaveProperty("snapshotId", 1);
  });

  it("returns explicit root-unavailable errors rather than an old or empty tree", async () => {
    const phone = fixture();
    const session = create(phone.spawn);
    const result = expect(session.capture()).rejects.toThrow(
      "ROOT_UNAVAILABLE",
    );
    await vi.waitFor(() => expect(phone.requests).toHaveLength(1));
    phone.send({
      v: V,
      id: 1,
      type: "error",
      code: "ROOT_UNAVAILABLE",
      message: "No active root.",
    });
    await result;
    expect(session.usable).toBe(true);
  });

  it("times out stalled capture and closes only the helper process", async () => {
    const phone = fixture();
    const session = create(phone.spawn, 30);
    await expect(session.capture()).rejects.toThrow("读取超时");
    await session.close();
    expect(phone.process.kill).toHaveBeenCalledOnce();
    await expect(session.capture()).rejects.toThrow("已结束");
  });

  it("rejects stale response IDs and oversized output, then tears down the helper", async () => {
    for (const oversized of [false, true]) {
      const phone = fixture();
      const session = create(phone.spawn);
      const result = expect(session.capture()).rejects.toThrow();
      await vi.waitFor(() => expect(phone.requests).toHaveLength(1));
      if (oversized) phone.raw(new Uint8Array(MAX_UI_TREE_BYTES + 1).fill(65));
      else
        phone.send({
          v: V,
          type: "snapshot",
          id: 99,
          snapshot: uiTreeFixture(99),
        });
      await result;
      await session.close();
      expect(phone.process.kill).toHaveBeenCalledOnce();
    }
  });

  it("cleans up a helper that finishes launching after cancellation", async () => {
    const phone = fixture();
    let launched!: (process: AdbShellProtocolProcess) => void;
    const session = create(
      () =>
        new Promise((resolve) => {
          launched = resolve;
        }),
    );
    const result = expect(session.capture()).rejects.toThrow("已取消");
    await session.close();
    launched(phone.process);
    await result;
    expect(phone.process.kill).toHaveBeenCalledOnce();
  });

  it("cancels a pending launch immediately without waiting for the factory or startup timeout", async () => {
    const session = create(() => new Promise(() => {}));
    const result = expect(session.capture()).rejects.toThrow("已取消");
    await session.close();
    await result;
  });

  it("surfaces startup failure and rejects invalid handshakes", async () => {
    const failed = create(async () => {
      throw new Error("shell unavailable");
    });
    await expect(failed.capture()).rejects.toThrow("shell unavailable");
    expect(failed.usable).toBe(false);
    const phone = fixture();
    const session = create(async () => phone.process);
    const result = expect(session.capture()).rejects.toThrow("INIT_FAILED");
    phone.send({
      v: V,
      id: 0,
      type: "error",
      code: "INIT_FAILED",
      message: "UiAutomation unavailable.",
    });
    await result;
    expect(session.usable).toBe(false);
    await session.close();
    expect(phone.process.kill).toHaveBeenCalledOnce();
  });

  it("bounds startup and cleanup time when the phone stops responding", async () => {
    const phone = fixture();
    const session = new UiTreeSession(async () => phone.process, {
      startup: 30,
      snapshot: 1000,
      cleanup: 30,
    });
    sessions.push(session);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(session.capture()).rejects.toThrow("启动超时");
    await session.close();
    expect(phone.process.kill).toHaveBeenCalledOnce();
    logged.mockRestore();
    const stuck = fixture();
    const cleanup = new UiTreeSession(stuck.spawn, {
      startup: 1000,
      snapshot: 1000,
      cleanup: 30,
    });
    const pending = expect(cleanup.capture()).rejects.toThrow("已取消");
    await vi.waitFor(() => expect(stuck.requests).toHaveLength(1));
    stuck.process.kill = vi.fn(() => new Promise<void>(() => {}));
    await expect(cleanup.close()).rejects.toThrow("关闭超时");
    await pending;
  });

  it("validates hierarchy and bounds, preserves truncation and strips password contents", () => {
    const tree = uiTreeFixture();
    tree.truncated = true;
    const parsed = parseUiTree(tree);
    expect(parsed.truncated).toBe(true);
    expect(parsed.nodes[2].text).toBe("");
    expect(parsed.nodes[2].description).toBe("");
    tree.nodes[1].parentId = 1;
    expect(() => parseUiTree(tree)).toThrow("响应无效");
    tree.nodes[1].parentId = 0;
    tree.nodes[1].bounds = [30, 0, 10, 10];
    expect(() => parseUiTree(tree)).toThrow("响应无效");
  });

  async function read(
    session: UiTreeSession,
    phone: ReturnType<typeof fixture>,
    id = 1,
  ) {
    const pending = session.capture();
    await vi.waitFor(() => expect(phone.requests.at(-1)?.id).toBe(id));
    const snapshot = uiTreeFixture(id);
    phone.send({ v: V, type: "snapshot", id, snapshot });
    return pending;
  }

  it.each(
    Object.keys(UI_NODE_ACTIONS).filter(
      (value): value is UiNodeAction => value in UI_NODE_ACTIONS,
    ),
  )(
    "executes the advertised %s action once using its snapshot reference",
    async (action) => {
      const phone = fixture();
      const session = create(phone.spawn);
      const snapshot = await read(session, phone);
      const nodeId =
        action === "setText"
          ? 2
          : action === "click" || action === "longClick"
            ? 1
            : 0;
      const target = { snapshotRef: snapshot.snapshotRef, nodeId };
      const request: UiNodeActionRequest =
        action === "setText"
          ? { ...target, action, text: "\u4f60\u597d\n" }
          : { ...target, action };
      const pending = session.performAction(request);
      await vi.waitFor(() => expect(phone.requests).toHaveLength(2));
      expect(phone.requests[1]).toEqual({
        v: V,
        id: 2,
        method: "action",
        request,
      });
      const result = { ...target, action, accepted: true };
      phone.send({ v: V, type: "action", id: 2, result });
      await expect(pending).resolves.toEqual(result);
      await expect(session.performAction(request)).rejects.toThrow("失效");
      expect(phone.requests).toHaveLength(2);
    },
  );

  it("rejects unsupported, invalid, expired and invalidated references without sending an action", async () => {
    const phone = fixture();
    const session = create(phone.spawn);
    const snapshot = await read(session, phone);
    const target = { snapshotRef: snapshot.snapshotRef, nodeId: 1 };
    await expect(
      session.performAction({
        ...target,
        action: "setText",
        text: "not editable",
      }),
    ).rejects.toThrow("不支持");
    await expect(
      session.performAction({
        snapshotRef: snapshot.snapshotRef,
        nodeId: 2,
        action: "setText",
        text: "\u4f60".repeat(342),
      }),
    ).rejects.toThrow("1024");
    await expect(
      session.performAction({
        ...target,
        snapshotRef: uiTreeFixture(99).snapshotRef,
        action: "click",
      }),
    ).rejects.toThrow("失效");
    const clock = vi
      .spyOn(performance, "now")
      .mockReturnValue(performance.now() + 30_001);
    await expect(
      session.performAction({ ...target, action: "click" }),
    ).rejects.toThrow("过期");
    clock.mockRestore();
    session.invalidate();
    await expect(
      session.performAction({ ...target, action: "click" }),
    ).rejects.toThrow("失效");
    expect(phone.requests).toHaveLength(1);
  });

  it("preserves empty setText and consumes the reference on Android rejection without retry or coordinate fallback", async () => {
    const phone = fixture();
    const session = create(phone.spawn);
    const snapshot = await read(session, phone);
    const request = {
      snapshotRef: snapshot.snapshotRef,
      nodeId: 2,
      action: "setText",
      text: "",
    } as const;
    const pending = expect(session.performAction(request)).rejects.toThrow(
      "ACTION_REJECTED",
    );
    await vi.waitFor(() => expect(phone.requests).toHaveLength(2));
    expect(phone.requests[1].request).toEqual(request);
    phone.send({
      v: V,
      type: "error",
      id: 2,
      code: "ACTION_REJECTED",
      message: "Android did not handle the action.",
    });
    await pending;
    expect(session.usable).toBe(true);
    await expect(session.performAction(request)).rejects.toThrow("失效");
    await read(session, phone, 3);
    expect(phone.spawn).toHaveBeenCalledOnce();
  });

  it("closes on a mismatched action receipt and reports timeout as unknown, without replay", async () => {
    for (const mismatch of [true, false]) {
      const phone = fixture();
      const session = create(phone.spawn, mismatch ? 1000 : 150);
      const snapshot = await read(session, phone);
      const pending = expect(
        session.performAction({
          snapshotRef: snapshot.snapshotRef,
          nodeId: 1,
          action: "click",
        }),
      ).rejects.toThrow(mismatch ? "不匹配" : "结果未知");
      await vi.waitFor(() => expect(phone.requests).toHaveLength(2));
      if (mismatch)
        phone.send({
          v: V,
          type: "action",
          id: 2,
          result: {
            snapshotRef: snapshot.snapshotRef,
            nodeId: 2,
            action: "click",
            accepted: true,
          },
        });
      await pending;
      await session.close();
      expect(phone.process.kill).toHaveBeenCalledOnce();
      expect(phone.requests).toHaveLength(2);
    }
  });

  it("rejects old protocol versions and unknown node capabilities", async () => {
    const phone = fixture();
    const session = create(async () => phone.process);
    const pending = expect(session.capture()).rejects.toThrow("协议版本");
    phone.send({ v: V - 1, type: "ready", helperVersion: V - 1 });
    await pending;
    const snapshot = uiTreeFixture();
    expect(() =>
      parseUiTree({
        ...snapshot,
        nodes: [{ ...snapshot.nodes[0], actions: ["custom"] }],
      }),
    ).toThrow("响应无效");
  });
});
