import { escapeArg } from "@yume-chan/adb";
import type { Adb, AdbShellProtocolProcess } from "@yume-chan/adb";
import { AbortController, WritableStream } from "@yume-chan/stream-extra";
import type { AbortSignal, ReadableStream } from "@yume-chan/stream-extra";
import { parsePackageName } from "../shared/app-launch.js";
import type { AppLaunchResult } from "../shared/app-launch.js";
import { errorText } from "../shared/protocol.js";

type Spawn = (
  command: readonly string[],
  signal: AbortSignal,
) => Promise<AdbShellProtocolProcess>;
interface Output {
  stdout: string;
  stderr: string;
  code: number;
}
const MAX_OUTPUT = 64 * 1024;
const MAIN = "android.intent.action.MAIN";
const LAUNCHER = "android.intent.category.LAUNCHER";

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort);
    if (signal.aborted) abort();
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("应用启动命令关闭超时。")),
      milliseconds,
    );
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

function androidFailure(output: Output, phase: string) {
  const detail = `${output.stdout}\n${output.stderr}`
    .split(/\r?\n/)
    .find((line) =>
      /^\s*(?:Error\b|Exception\b|(?:java|android)\.[\w.]*Exception\b|SecurityException\b|Permission Denial\b|Unknown (?:command|option)\b)/i.test(
        line,
      ),
    );
  if (output.code !== 0 || detail)
    throw new Error(
      `${phase}失败 (exit ${output.code})${detail ? `：${detail.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 512)}` : "；请检查 Android/OEM 权限和命令支持情况。"}`,
    );
}

export class AppLauncher {
  private active?: AbortController;

  constructor(
    private readonly spawn: Spawn,
    private readonly timeouts = { launch: 15_000, cleanup: 1000 },
  ) {}

  static forAdb(adb: Adb) {
    const shell = adb.subprocess.shellProtocol;
    if (!shell?.isSupported)
      throw new Error("启动应用需要 Android 7+ 和 ADB shell v2。");
    return new AppLauncher((command, signal) => shell.spawn(command, signal));
  }

  cancel() {
    this.active?.abort(
      new Error(
        "应用启动已取消；若启动命令已发送，结果可能未知，请确认手机当前页面。",
      ),
    );
  }

  async launch(value: string): Promise<AppLaunchResult> {
    const packageName = parsePackageName(value);
    if (this.active) throw new Error("已有应用启动请求正在进行。");
    const abort = new AbortController();
    this.active = abort;
    const timer = setTimeout(
      () =>
        abort.abort(
          new Error(
            "应用启动超时，结果可能未知；请确认当前页面，不要自动重试。",
          ),
        ),
      this.timeouts.launch,
    );
    try {
      const entries = await this.command(
        [
          "cmd",
          "package",
          "query-activities",
          "--components",
          "--user",
          "current",
          "-a",
          MAIN,
          "-c",
          LAUNCHER,
          "-p",
          packageName,
        ],
        abort.signal,
      );
      androidFailure(entries, "查询应用入口");
      const lines = entries.stdout.trim().split(/\r?\n/).filter(Boolean);
      if (
        !entries.stdout.trim() ||
        (lines.length === 1 && lines[0] === "No activities found")
      )
        throw new Error(
          "当前 Android 用户下未找到应用桌面入口：应用可能未安装、已停用或没有启动入口。",
        );
      for (const component of lines) {
        const parts = component.split("/");
        if (
          parts.length !== 2 ||
          parts[0] !== packageName ||
          !/^\.?[\p{ID_Start}_$][\p{ID_Continue}$]*(?:\.[\p{ID_Start}_$][\p{ID_Continue}$]*)*$/u.test(
            parts[1],
          )
        )
          throw new Error(
            "Android 返回的应用入口格式或包名不匹配，未执行启动。",
          );
      }
      const component = lines[0]!;
      abort.signal.throwIfAborted();
      const started = await this.command(
        [
          "am",
          "start",
          "-W",
          "--user",
          "current",
          "-a",
          MAIN,
          "-c",
          LAUNCHER,
          "-f",
          "0x10200000",
          "-n",
          component,
        ],
        abort.signal,
      );
      androidFailure(started, "启动应用");
      if (!/^Status:\s*ok\s*$/m.test(started.stdout.replace(/\r/g, "")))
        throw new Error(
          "Android 未确认启动成功，结果可能未知；请检查手机当前页面，不要自动重试。",
        );
      return { packageName, component, accepted: true };
    } finally {
      clearTimeout(timer);
      this.active = undefined;
    }
  }

  private command(
    command: readonly string[],
    signal: AbortSignal,
  ): Promise<Output> {
    const operation = this.spawn(command.map(escapeArg), signal).then(
      async (process) => {
        let total = 0;
        const read = async (stream: ReadableStream<Uint8Array>) => {
          let text = "";
          const decoder = new TextDecoder("utf-8", { fatal: true });
          await stream.pipeTo(
            new WritableStream<Uint8Array>({
              write(bytes) {
                total += bytes.byteLength;
                if (total > MAX_OUTPUT)
                  throw new Error(
                    "应用启动命令输出超过 64 KiB，已中止；启动结果可能未知。",
                  );
                text += decoder.decode(bytes, { stream: true });
              },
            }),
          );
          return text + decoder.decode();
        };
        const result = Promise.all([
          read(process.stdout),
          read(process.stderr),
          process.exited,
        ]);
        let failure: unknown;
        try {
          const [stdout, stderr, code] = await abortable(result, signal);
          return { stdout, stderr, code };
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          try {
            await bounded(
              Promise.resolve().then(() => process.kill()),
              this.timeouts.cleanup,
            );
          } catch (error) {
            if (signal.aborted)
              console.error("App launch process cleanup failed:", error);
            else
              throw new Error(
                `${failure ? `${errorText(failure)}\n` : ""}应用启动命令关闭失败：${errorText(error)}`,
              );
          }
        }
      },
    );
    return abortable(operation, signal);
  }
}
