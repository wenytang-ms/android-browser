import { describe, expect, it, vi } from "vitest";
import { MaybeConsumable, ReadableStream } from "@yume-chan/stream-extra";
import type { ReadableStreamDefaultController } from "@yume-chan/stream-extra";
import type { AdbShellProtocolProcess } from "@yume-chan/adb";
import { AppLauncher } from "../src/extension/app-launch.js";
import { parsePackageName } from "../src/shared/app-launch.js";

const PACKAGE = "com.example.app";
const COMPONENT = `${PACKAGE}/.Main$Nested`;

function phone() {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  let exit!: (code: number) => void;
  let outClosed = false;
  let errClosed = false;
  const finish = (code = 0) => {
    if (!outClosed) {
      outClosed = true;
      out.close();
    }
    if (!errClosed) {
      errClosed = true;
      err.close();
    }
    exit(code);
  };
  const process: AdbShellProtocolProcess = {
    stdin: new MaybeConsumable.WritableStream<Uint8Array>({}),
    stdout: new ReadableStream({
      start(controller) {
        out = controller;
      },
      cancel() {
        outClosed = true;
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        err = controller;
      },
      cancel() {
        errClosed = true;
      },
    }),
    exited: new Promise<number>((resolve) => {
      exit = resolve;
    }),
    kill: vi.fn(async () => {
      finish();
    }),
  };
  return {
    process,
    finish,
    stdout: (bytes: Uint8Array) => out.enqueue(bytes),
    stderr: (bytes: Uint8Array) => err.enqueue(bytes),
  };
}

function completed(stdout: string, stderr = "", code = 0) {
  const command = phone();
  command.stdout(new TextEncoder().encode(stdout));
  command.stderr(new TextEncoder().encode(stderr));
  command.finish(code);
  return command;
}

describe("package-only app launch", () => {
  it("uses the first launcher entry for the current user, quotes every argument, and accepts an already-running app", async () => {
    const query = completed(`${COMPONENT}\r\n${PACKAGE}/.Other\n`);
    const start = completed(
      "Starting: Intent {...}\r\nStatus: ok\r\n",
      "Warning: Activity not started, intent delivered to existing instance.\n",
    );
    const spawn = vi
      .fn<ConstructorParameters<typeof AppLauncher>[0]>()
      .mockResolvedValueOnce(query.process)
      .mockResolvedValueOnce(start.process);
    await expect(new AppLauncher(spawn).launch(PACKAGE)).resolves.toEqual({
      packageName: PACKAGE,
      component: COMPONENT,
      accepted: true,
    });
    expect(spawn.mock.calls.map(([args]) => args.join(" "))).toEqual([
      `'cmd' 'package' 'query-activities' '--components' '--user' 'current' '-a' 'android.intent.action.MAIN' '-c' 'android.intent.category.LAUNCHER' '-p' '${PACKAGE}'`,
      `'am' 'start' '-W' '--user' 'current' '-a' 'android.intent.action.MAIN' '-c' 'android.intent.category.LAUNCHER' '-f' '0x10200000' '-n' '${COMPONENT}'`,
    ]);
    expect(query.process.kill).toHaveBeenCalledOnce();
    expect(start.process.kill).toHaveBeenCalledOnce();
  });

  it("rejects malformed or injection-like package names before creating any subprocess", async () => {
    const spawn = vi.fn<ConstructorParameters<typeof AppLauncher>[0]>();
    const launcher = new AppLauncher(spawn);
    for (const value of [
      "",
      "android",
      "com.foo/.Main",
      "com.foo;id",
      "com.foo\nid",
      "com.foo bar",
      "$(id)",
      "https://example.com",
      "com.foo.",
      `com.${"a".repeat(252)}`,
    ])
      await expect(launcher.launch(value)).rejects.toThrow("包名");
    expect(() => parsePackageName(null)).toThrow("包名");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each([
    ["No activities found\n", "", 0, "未找到应用桌面入口"],
    ["", "", 0, "未找到应用桌面入口"],
    ["other.package/.Main\n", "", 0, "不匹配"],
    [`${COMPONENT}\nother.package/.Main\n`, "", 0, "不匹配"],
    [`${PACKAGE}/.Main;id\n`, "", 0, "不匹配"],
    ["", "Error: permission denied", 0, "permission denied"],
    ["Unknown command: query-activities", "", 0, "Unknown command"],
    ["", "SecurityException: denied", 1, "denied"],
  ])(
    "rejects an unusable launcher query (%s)",
    async (stdout, stderr, code, error) => {
      const query = completed(stdout, stderr, code);
      const spawn = vi
        .fn<ConstructorParameters<typeof AppLauncher>[0]>()
        .mockResolvedValue(query.process);
      await expect(new AppLauncher(spawn).launch(PACKAGE)).rejects.toThrow(
        error,
      );
      expect(spawn).toHaveBeenCalledOnce();
    },
  );

  it.each([
    [
      "Status: ok\n",
      "Error: Activity not started, permission denied",
      0,
      "permission denied",
    ],
    ["Status: timeout\n", "", 0, "结果可能未知"],
    ["Starting: Intent {...}\n", "", 0, "未确认启动成功"],
    ["Status: ok\n", "", 1, "exit 1"],
  ])(
    "requires affirmative successful Android startup (%s)",
    async (stdout, stderr, code, error) => {
      const spawn = vi
        .fn<ConstructorParameters<typeof AppLauncher>[0]>()
        .mockResolvedValueOnce(completed(COMPONENT).process)
        .mockResolvedValueOnce(completed(stdout, stderr, code).process);
      await expect(new AppLauncher(spawn).launch(PACKAGE)).rejects.toThrow(
        error,
      );
      expect(spawn).toHaveBeenCalledTimes(2);
    },
  );

  it("drains both channels and decodes UTF-8 across chunks", async () => {
    const query = phone();
    const component = `${PACKAGE}/.\u754c\u9762`;
    for (const byte of new TextEncoder().encode(`${component}\n`))
      query.stdout(new Uint8Array([byte]));
    for (const byte of new TextEncoder().encode(
      "Warning: \u5df2\u7ecf\u542f\u52a8\n",
    ))
      query.stderr(new Uint8Array([byte]));
    query.finish();
    const spawn = vi
      .fn<ConstructorParameters<typeof AppLauncher>[0]>()
      .mockResolvedValueOnce(query.process)
      .mockResolvedValueOnce(completed("Status: ok\n").process);
    await expect(
      new AppLauncher(spawn).launch(PACKAGE),
    ).resolves.toHaveProperty("component", component);
  });

  it("bounds combined command output and closes the process without starting the app", async () => {
    const query = phone();
    query.stdout(new Uint8Array(33 * 1024).fill(65));
    query.stderr(new Uint8Array(33 * 1024).fill(66));
    const spawn = vi
      .fn<ConstructorParameters<typeof AppLauncher>[0]>()
      .mockResolvedValue(query.process);
    await expect(new AppLauncher(spawn).launch(PACKAGE)).rejects.toThrow(
      "64 KiB",
    );
    expect(query.process.kill).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("rejects invalid UTF-8 rather than launching a modified component", async () => {
    const query = phone();
    query.stdout(new Uint8Array([0xff]));
    const spawn = vi
      .fn<ConstructorParameters<typeof AppLauncher>[0]>()
      .mockResolvedValue(query.process);
    await expect(new AppLauncher(spawn).launch(PACKAGE)).rejects.toThrow();
    expect(query.process.kill).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("cancels a late spawn promptly, then closes it and never sends am start", async () => {
    const query = phone();
    let finish!: (value: AdbShellProtocolProcess) => void;
    const spawn = vi.fn<ConstructorParameters<typeof AppLauncher>[0]>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const launcher = new AppLauncher(spawn);
    const pending = expect(launcher.launch(PACKAGE)).rejects.toThrow("已取消");
    launcher.cancel();
    await pending;
    finish(query.process);
    await vi.waitFor(() => expect(query.process.kill).toHaveBeenCalledOnce());
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("rejects concurrent launches and times out a stalled am start without retry", async () => {
    const start = phone();
    const spawn = vi
      .fn<ConstructorParameters<typeof AppLauncher>[0]>()
      .mockResolvedValueOnce(completed(COMPONENT).process)
      .mockResolvedValueOnce(start.process);
    const launcher = new AppLauncher(spawn, { launch: 80, cleanup: 50 });
    const pending = expect(launcher.launch(PACKAGE)).rejects.toThrow(
      "结果可能未知",
    );
    await expect(launcher.launch(PACKAGE)).rejects.toThrow("正在进行");
    await pending;
    await vi.waitFor(() => expect(start.process.kill).toHaveBeenCalledOnce());
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("surfaces command cleanup failure instead of reporting success", async () => {
    const query = completed(COMPONENT);
    vi.mocked(query.process.kill).mockRejectedValue(
      new Error("socket close failed"),
    );
    const spawn = vi
      .fn<ConstructorParameters<typeof AppLauncher>[0]>()
      .mockResolvedValue(query.process);
    await expect(new AppLauncher(spawn).launch(PACKAGE)).rejects.toThrow(
      "socket close failed",
    );
    expect(spawn).toHaveBeenCalledOnce();
  });
});
