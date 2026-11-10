import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadableStream } from "@yume-chan/stream-extra";
import type { ReadableStreamDefaultController } from "@yume-chan/stream-extra";
import { DeviceSession } from "../src/extension/device.js";
import { UiTreeSession } from "../src/extension/ui-tree.js";
import { AppLauncher } from "../src/extension/app-launch.js";
import { uiTreeFixture } from "./ui-tree-fixture.js";
import { parseUiNodeAction } from "../src/shared/ui-tree.js";
import type { MediaPacket } from "../src/shared/protocol.js";
import type {
  ScrcpyControlMessageWriter,
  ScrcpyMediaStreamPacket,
} from "@yume-chan/scrcpy";
import { AndroidScreenPowerMode, ScrcpyAudioCodec } from "@yume-chan/scrcpy";
import type { AdbScrcpyAudioStreamMetadata } from "@yume-chan/adb-scrcpy";
import type {
  LocalAudioPacket,
  LocalAudioStatus,
} from "../src/shared/audio-player.js";

const mockController = () => ({
  injectTouch: vi.fn<ScrcpyControlMessageWriter["injectTouch"]>(async () => {}),
  injectKeyCode: vi.fn<ScrcpyControlMessageWriter["injectKeyCode"]>(
    async () => {},
  ),
  setClipboard: vi.fn<ScrcpyControlMessageWriter["setClipboard"]>(
    async () => {},
  ),
  setScreenPowerMode: vi.fn<ScrcpyControlMessageWriter["setScreenPowerMode"]>(
    async () => {},
  ),
});

const screen: MediaPacket = {
  session: "0".repeat(32),
  stream: 1,
  sequence: 0,
  kind: "configuration",
  keyframe: false,
  pts: 0n,
  width: 720,
  height: 1280,
  data: new Uint8Array([0, 0, 0, 1]),
};

const services = vi.hoisted(() => ({
  requestDevice: vi.fn(),
  authenticate: vi.fn(),
  pushServer: vi.fn(),
  start: vi.fn(),
  adbClose: vi.fn(),
  audio: vi.fn<() => Promise<AdbScrcpyAudioStreamMetadata>>(),
}));

vi.mock("@yume-chan/adb-daemon-webusb", () => ({
  AdbDaemonWebUsbDeviceManager: {
    BROWSER: { requestDevice: services.requestDevice },
  },
}));
vi.mock("@yume-chan/adb", async (original) => ({
  ...(await original<typeof import("@yume-chan/adb")>()),
  AdbDaemonTransport: { authenticate: services.authenticate },
  Adb: class {
    constructor(readonly transport: object) {}
    close() {
      return services.adbClose();
    }
  },
}));
vi.mock("@yume-chan/adb-credential-web", () => ({ default: class {} }));
vi.mock("@yume-chan/adb-scrcpy", async (original) => ({
  ...(await original<typeof import("@yume-chan/adb-scrcpy")>()),
  AdbScrcpyClient: {
    pushServer: services.pushServer,
    start: services.start,
  },
}));
vi.mock("@yume-chan/scrcpy", async (original) => ({
  ...(await original<typeof import("@yume-chan/scrcpy")>()),
  h264ParseConfiguration: () => ({ croppedWidth: 720, croppedHeight: 1280 }),
}));
vi.mock("../src/shared/player.js", () => ({
  checkDecoderSupport: async () => {},
}));

describe("single Tango device lifecycle", () => {
  let device: DeviceSession;
  let ended: ReturnType<typeof vi.fn<() => void>>;
  let packet: ReturnType<typeof vi.fn<(packet: MediaPacket) => void>>;
  let status: ReturnType<typeof vi.fn<(message: string) => void>>;
  let raw: {
    opened: boolean;
    close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  };
  let clients: {
    close: ReturnType<typeof vi.fn<() => Promise<void>>>;
    controller: ReturnType<typeof mockController>;
  }[];
  let disconnectTransport: () => void;
  let audioPacket: ReturnType<typeof vi.fn<(packet: LocalAudioPacket) => void>>;
  let audioStatus: ReturnType<typeof vi.fn<(status: LocalAudioStatus) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    clients = [];
    raw = {
      opened: true,
      close: vi.fn(async () => {
        raw.opened = false;
      }),
    };
    const disconnected = new Promise<void>((resolve) => {
      disconnectTransport = resolve;
    });
    services.authenticate.mockResolvedValue({
      disconnected,
      close: vi.fn(async () => {}),
    });
    services.requestDevice.mockResolvedValue({
      raw,
      serial: "test-usb",
      connect: async () => ({}),
    });
    services.pushServer.mockResolvedValue(undefined);
    services.adbClose.mockResolvedValue(undefined);
    services.audio.mockResolvedValue({ type: "disabled" });
    services.start.mockImplementation(async () => {
      let output: ReadableStreamDefaultController<string>;
      let video: ReadableStreamDefaultController<{
        type: "data";
        pts: bigint;
        keyframe: boolean;
        data: Uint8Array;
      }>;
      const client = {
        controller: mockController(),
        audioStream: services.audio(),
        output: new ReadableStream<string>({
          start(controller) {
            output = controller;
            controller.enqueue("server started");
          },
        }),
        videoStream: Promise.resolve({
          metadata: { codec: 0x68323634, deviceName: "Synthetic Android" },
          stream: new ReadableStream({
            start(controller) {
              video = controller;
            },
          }),
        }),
        close: vi.fn(async () => {
          output.close();
          video.close();
        }),
      };
      clients.push(client);
      return client;
    });
    vi.stubGlobal("navigator", {
      usb: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    vi.stubGlobal("chrome", {
      runtime: { getURL: (path: string) => `chrome-extension://test/${path}` },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    );
    ended = vi.fn<() => void>();
    status = vi.fn<(message: string) => void>();
    packet = vi.fn<(packet: MediaPacket) => void>();
    audioPacket = vi.fn();
    audioStatus = vi.fn();
    device = new DeviceSession(status, packet, ended, audioPacket, audioStatus);
  });
  afterEach(async () => {
    await device.disconnect();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps the authenticated USB session when stopping and starting video again", async () => {
    await device.connect();
    expect(device.connected).toBe(true);
    expect(device.playing).toBe(true);
    await device.stop();
    expect(device.playing).toBe(false);
    expect(device.connected).toBe(true);
    expect(clients[0].close).toHaveBeenCalledOnce();
    expect(services.adbClose).not.toHaveBeenCalled();
    await device.start();
    expect(services.authenticate).toHaveBeenCalledOnce();
    expect(services.start).toHaveBeenCalledTimes(2);
    expect(device.playing).toBe(true);
  });

  it("rebuilds video for keyframe recovery without ending the shared device session", async () => {
    await device.connect();
    await device.restartVideo();
    expect(clients[0].close).toHaveBeenCalledOnce();
    expect(services.start).toHaveBeenCalledTimes(2);
    expect(services.authenticate).toHaveBeenCalledOnce();
    expect(ended).not.toHaveBeenCalled();
    expect(device.connected && device.playing).toBe(true);
  });

  it("still observes USB/ADB disconnection after local video has been stopped", async () => {
    await device.connect();
    await device.stop();
    disconnectTransport();
    await vi.waitFor(() => expect(device.connected).toBe(false));
    await vi.waitFor(() => expect(raw.close).toHaveBeenCalledOnce());
    expect(status).toHaveBeenCalledWith(
      expect.stringContaining("ADB 连接已断开"),
    );
  });

  it("releases USB even when ADB teardown fails and preserves the error in the UI", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await device.connect();
    services.adbClose.mockRejectedValueOnce(
      new Error("transport close failed"),
    );
    await device.disconnect();
    expect(raw.close).toHaveBeenCalledOnce();
    expect(device.connected).toBe(false);
    expect(status).toHaveBeenLastCalledWith(
      expect.stringContaining("transport close failed"),
    );
    expect(logged).toHaveBeenCalled();
  });

  it("starts the UI helper only on request, reuses it across video recovery and closes it independently", async () => {
    const helper = new UiTreeSession(async () => {
      throw new Error("Unexpected helper launch");
    });
    const capture = vi
      .spyOn(helper, "capture")
      .mockResolvedValue(uiTreeFixture());
    const close = vi.spyOn(helper, "close").mockResolvedValue();
    const factory = vi.spyOn(UiTreeSession, "forAdb").mockReturnValue(helper);
    await expect(device.getUiTree()).rejects.toThrow("先开始投屏");
    await device.connect();
    expect(factory).not.toHaveBeenCalled();
    device.configuration = screen;
    await expect(device.getUiTree()).resolves.toHaveProperty("stream", 1);
    await device.getUiTree();
    expect(capture).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenCalledOnce();
    await device.restartVideo();
    expect(close).not.toHaveBeenCalled();
    expect(device.uiTreeActive).toBe(true);
    device.configuration = { ...screen, stream: 2 };
    await device.getUiTree();
    expect(factory).toHaveBeenCalledOnce();
    await device.stopUiTree();
    expect(close).toHaveBeenCalledOnce();
    expect(device.playing).toBe(true);
    expect(device.uiTreeActive).toBe(false);
    await device.localInput({ kind: "text", text: "still usable" }, 2);
    expect(clients[1].controller.setClipboard).toHaveBeenCalledOnce();
  });

  it("rejects a UI snapshot from an old video stream and leaves input usable after a helper error", async () => {
    const helper = new UiTreeSession(async () => {
      throw new Error("Unexpected helper launch");
    });
    const capture = vi.spyOn(helper, "capture");
    vi.spyOn(UiTreeSession, "forAdb").mockReturnValue(helper);
    await device.connect();
    device.configuration = screen;
    let finish!: (tree: ReturnType<typeof uiTreeFixture>) => void;
    capture.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = expect(device.getUiTree()).rejects.toThrow("画面已改变");
    device.configuration = { ...screen, stream: 2 };
    finish(uiTreeFixture());
    await pending;
    capture.mockRejectedValueOnce(new Error("ROOT_UNAVAILABLE"));
    await expect(device.getUiTree()).rejects.toThrow("ROOT_UNAVAILABLE");
    await device.localInput({ kind: "text", text: "after helper failure" }, 2);
    expect(clients[0].controller.setClipboard).toHaveBeenCalledOnce();
    expect(device.playing).toBe(true);
    expect(clients[0].close).not.toHaveBeenCalled();
  });

  it("releases held input, restores display and closes scrcpy even if UI helper cleanup fails", async () => {
    const helper = new UiTreeSession(async () => {
      throw new Error("Unexpected helper launch");
    });
    vi.spyOn(helper, "capture").mockResolvedValue(uiTreeFixture());
    const close = vi
      .spyOn(helper, "close")
      .mockRejectedValue(new Error("helper cleanup failed"));
    vi.spyOn(UiTreeSession, "forAdb").mockReturnValue(helper);
    await device.connect();
    device.configuration = screen;
    await device.getUiTree();
    await device.localInput(
      { kind: "key", action: "down", keyCode: 66, metaState: 0 },
      1,
    );
    await device.setScreenOff(true);
    await expect(device.stop()).rejects.toThrow("helper cleanup failed");
    expect(close).toHaveBeenCalledOnce();
    expect(clients[0].controller.injectKeyCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 1 }),
    );
    expect(clients[0].controller.setScreenPowerMode).toHaveBeenLastCalledWith(
      AndroidScreenPowerMode.Normal,
    );
    expect(clients[0].close).toHaveBeenCalledOnce();
    expect(device.uiTreeActive).toBe(false);
  });

  it("takes local control for semantic actions, releases remote held input and never uses a coordinate fallback", async () => {
    const helper = new UiTreeSession(async () => {
      throw new Error("Unexpected helper launch");
    });
    vi.spyOn(helper, "capture").mockResolvedValue(uiTreeFixture());
    vi.spyOn(helper, "validateAction").mockImplementation(parseUiNodeAction);
    const action = vi
      .spyOn(helper, "performAction")
      .mockImplementation(async (request) => ({
        snapshotRef: request.snapshotRef,
        nodeId: request.nodeId,
        action: request.action,
        accepted: true,
      }));
    vi.spyOn(UiTreeSession, "forAdb").mockReturnValue(helper);
    const request = {
      snapshotRef: uiTreeFixture().snapshotRef,
      nodeId: 1,
      action: "click",
      stream: 1,
    } as const;
    await expect(device.performUiAction(request)).rejects.toThrow("已失效");
    await device.connect();
    device.configuration = screen;
    const remote = "a".repeat(32);
    await device.setRemoteController(remote);
    await device.remoteInput(
      remote,
      { kind: "key", action: "down", keyCode: 66, metaState: 0 },
      1,
    );
    await device.getUiTree();
    await expect(device.performUiAction(request)).resolves.toHaveProperty(
      "accepted",
      true,
    );
    expect(clients[0].controller.injectKeyCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 1 }),
    );
    expect(
      clients[0].controller.injectKeyCode.mock.invocationCallOrder.at(-1)!,
    ).toBeLessThan(action.mock.invocationCallOrder[0]);
    await expect(
      device.remoteInput(
        remote,
        { kind: "key", action: "down", keyCode: 66, metaState: 0 },
        1,
      ),
    ).rejects.toThrow("授权");
    await expect(
      device.performUiAction({ ...request, stream: 2 }),
    ).rejects.toThrow("已失效");
    await device.getUiTree();
    action.mockRejectedValueOnce(new Error("ACTION_REJECTED"));
    await expect(device.performUiAction(request)).rejects.toThrow(
      "ACTION_REJECTED",
    );
    expect(clients[0].controller.injectTouch).not.toHaveBeenCalled();
    expect(clients[0].controller.setClipboard).not.toHaveBeenCalled();
    expect(clients[0].close).not.toHaveBeenCalled();
    expect(device.playing).toBe(true);
    await device.localInput({ kind: "text", text: "Tango still available" }, 1);
    expect(clients[0].controller.setClipboard).toHaveBeenCalledOnce();
  });

  it("invalidates a pending snapshot after real input but not after a release-only event", async () => {
    const helper = new UiTreeSession(async () => {
      throw new Error("Unexpected helper launch");
    });
    const capture = vi.spyOn(helper, "capture");
    vi.spyOn(UiTreeSession, "forAdb").mockReturnValue(helper);
    await device.connect();
    device.configuration = screen;
    let finish!: (value: ReturnType<typeof uiTreeFixture>) => void;
    capture.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const first = device.getUiTree();
    await device.localInput({ kind: "release" }, 1);
    finish(uiTreeFixture());
    await expect(first).resolves.toHaveProperty("stream", 1);
    const second = expect(device.getUiTree()).rejects.toThrow("发生了其他输入");
    await device.localInput({ kind: "text", text: "changes the UI" }, 1);
    finish(uiTreeFixture(2));
    await second;
  });

  it("launches packages lazily with local takeover, held-input release and UI reference invalidation", async () => {
    const launcher = new AppLauncher(async () => {
      throw new Error("Unexpected command");
    });
    const launch = vi.spyOn(launcher, "launch").mockResolvedValue({
      packageName: "com.example.app",
      component: "com.example.app/.Main",
      accepted: true,
    });
    const factory = vi.spyOn(AppLauncher, "forAdb").mockReturnValue(launcher);
    const helper = new UiTreeSession(async () => {
      throw new Error("Unexpected helper");
    });
    vi.spyOn(helper, "capture").mockResolvedValue(uiTreeFixture());
    const invalidate = vi.spyOn(helper, "invalidate");
    vi.spyOn(UiTreeSession, "forAdb").mockReturnValue(helper);
    await expect(device.launchApp("com.example.app")).rejects.toThrow(
      "先开始投屏",
    );
    await device.connect();
    expect(factory).not.toHaveBeenCalled();
    device.configuration = screen;
    const remote = "a".repeat(32);
    await device.setRemoteController(remote);
    await expect(device.launchApp("com.example.app;id")).rejects.toThrow(
      "包名",
    );
    await device.remoteInput(
      remote,
      { kind: "key", action: "down", keyCode: 66, metaState: 0 },
      1,
    );
    await device.getUiTree();
    const previous = invalidate.mock.calls.length;
    await expect(device.launchApp("com.example.app")).resolves.toHaveProperty(
      "accepted",
      true,
    );
    expect(factory).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledWith("com.example.app");
    expect(invalidate.mock.calls.length).toBeGreaterThanOrEqual(previous + 2);
    const writer = clients[0].controller;
    expect(writer.injectKeyCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 1 }),
    );
    expect(writer.injectKeyCode.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      launch.mock.invocationCallOrder[0],
    );
    await expect(
      device.remoteInput(remote, { kind: "text", text: "not authorized" }, 1),
    ).rejects.toThrow("授权");
    expect(writer.injectTouch).not.toHaveBeenCalled();
    expect(writer.setClipboard).not.toHaveBeenCalled();
    launch.mockRejectedValueOnce(new Error("No launcher activity"));
    await expect(device.launchApp("com.example.app")).rejects.toThrow(
      "No launcher activity",
    );
    await device.localInput({ kind: "text", text: "still usable" }, 1);
    expect(writer.setClipboard).toHaveBeenCalledOnce();
    expect(device.playing).toBe(true);
    expect(clients[0].close).not.toHaveBeenCalled();
  });

  it("blocks captures and concurrent launches, rejects in-flight old trees, and accepts launch-triggered rotation", async () => {
    let finish!: (value: Awaited<ReturnType<AppLauncher["launch"]>>) => void;
    const launcher = new AppLauncher(async () => {
      throw new Error("Unexpected command");
    });
    const launch = vi.spyOn(launcher, "launch").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.spyOn(AppLauncher, "forAdb").mockReturnValue(launcher);
    let finishTree!: (tree: ReturnType<typeof uiTreeFixture>) => void;
    const helper = new UiTreeSession(async () => {
      throw new Error("Unexpected helper");
    });
    vi.spyOn(helper, "capture").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishTree = resolve;
        }),
    );
    vi.spyOn(UiTreeSession, "forAdb").mockReturnValue(helper);
    await device.connect();
    device.configuration = screen;
    const tree = expect(device.getUiTree()).rejects.toThrow("发生了其他输入");
    const pending = device.launchApp("com.example.app");
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    finishTree(uiTreeFixture());
    await tree;
    await expect(device.getUiTree()).rejects.toThrow("正在启动");
    await expect(device.launchApp("com.example.app")).rejects.toThrow(
      "正在进行",
    );
    device.configuration = { ...screen, stream: 2 };
    finish({
      packageName: "com.example.app",
      component: "com.example.app/.Main",
      accepted: true,
    });
    await expect(pending).resolves.toHaveProperty("accepted", true);
  });

  it.each(["stop", "disconnect", "restartVideo"] as const)(
    "cancels a pending app launch during %s without waiting for a stalled shell spawn",
    async (action) => {
      const spawn = vi.fn<ConstructorParameters<typeof AppLauncher>[0]>(
        () => new Promise(() => {}),
      );
      const launcher = new AppLauncher(spawn);
      const cancel = vi.spyOn(launcher, "cancel");
      vi.spyOn(AppLauncher, "forAdb").mockReturnValue(launcher);
      await device.connect();
      device.configuration = screen;
      const pending = expect(
        device.launchApp("com.example.app"),
      ).rejects.toThrow("已取消");
      await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
      await device[action]();
      await pending;
      expect(cancel).toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledOnce();
    },
  );

  it("never dispatches a queued app launch after stopping during held-key release", async () => {
    const launcher = new AppLauncher(async () => {
      throw new Error("Unexpected command");
    });
    const launch = vi.spyOn(launcher, "launch");
    vi.spyOn(AppLauncher, "forAdb").mockReturnValue(launcher);
    await device.connect();
    device.configuration = screen;
    const writer = clients[0].controller;
    await device.localInput(
      { kind: "key", action: "down", keyCode: 66, metaState: 0 },
      1,
    );
    let released!: () => void;
    writer.injectKeyCode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          released = resolve;
        }),
    );
    const pending = expect(device.launchApp("com.example.app")).rejects.toThrow(
      "已取消",
    );
    await vi.waitFor(() =>
      expect(writer.injectKeyCode).toHaveBeenCalledTimes(2),
    );
    const stop = device.stop();
    released();
    await Promise.all([pending, stop]);
    expect(launch).not.toHaveBeenCalled();
  });

  it("supports local clicks, drags, keys and Unicode paste without a remote share or Google login", async () => {
    await device.connect();
    device.configuration = screen;
    for (const action of ["down", "move", "up"] as const)
      await device.localInput(
        { kind: "touch", action, pointerId: 0, x: 0.5, y: 0.5 },
        1,
      );
    await device.localInput(
      { kind: "key", action: "down", keyCode: 29, metaState: 0 },
      1,
    );
    await device.localInput(
      { kind: "key", action: "up", keyCode: 29, metaState: 0 },
      1,
    );
    await device.localInput({ kind: "text", text: "\u4f60\u597d" }, 1);
    const writer = clients[0].controller;
    expect(
      writer.injectTouch.mock.calls.map(([event]) => event.action),
    ).toEqual([0, 2, 1]);
    expect(
      writer.injectKeyCode.mock.calls.map(([event]) => event.action),
    ).toEqual([0, 1]);
    expect(writer.setClipboard).toHaveBeenCalledWith({
      sequence: 0n,
      paste: true,
      content: "\u4f60\u597d",
    });
  });

  it("releases the previous controller on takeover and preserves local input when remote control disconnects", async () => {
    await device.connect();
    device.configuration = screen;
    const id = "a".repeat(32);
    await device.setRemoteController(id);
    await device.remoteInput(
      id,
      { kind: "key", action: "down", keyCode: 66, metaState: 0 },
      1,
    );
    await device.localInput(
      { kind: "touch", action: "down", pointerId: 0, x: 0, y: 0 },
      1,
    );
    expect(clients[0].controller.injectKeyCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 1 }),
    );
    await device.setRemoteController(null);
    await device.localInput(
      { kind: "touch", action: "move", pointerId: 0, x: 0.5, y: 0.5 },
      1,
    );
    await expect(
      device.remoteInput(
        id,
        { kind: "key", action: "down", keyCode: 66, metaState: 0 },
        1,
      ),
    ).rejects.toThrow("授权");
    await device.setRemoteController("b".repeat(32));
    expect(clients[0].controller.injectTouch).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 1 }),
    );
    expect(device.playing).toBe(true);
  });

  it("turns off only the physical display while local and authorized remote input remain usable", async () => {
    await expect(device.setScreenOff(true)).rejects.toThrow("先开始投屏");
    await device.connect();
    device.configuration = screen;
    const writer = clients[0].controller;
    await device.setScreenOff(true);
    expect(services.start.mock.calls[0][2].value.stayAwake).toBe(true);
    expect(writer.setScreenPowerMode).toHaveBeenLastCalledWith(
      AndroidScreenPowerMode.Off,
    );
    await device.localInput(
      { kind: "key", action: "down", keyCode: 29, metaState: 0 },
      1,
    );
    const id = "a".repeat(32);
    await device.setRemoteController(id);
    await device.setScreenOff(false);
    await device.setScreenOff(true);
    await device.remoteInput(
      id,
      { kind: "key", action: "down", keyCode: 66, metaState: 0 },
      1,
    );
    expect(writer.injectKeyCode).toHaveBeenLastCalledWith(
      expect.objectContaining({ action: 0, keyCode: 66 }),
    );
    expect(device.playing && device.screenOff).toBe(true);
    expect(device.configuration).toBe(screen);
    expect(clients[0].close).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
  });

  it("restores normal display mode on stop, reapplies OFF after recovery, and resets it on manual restart", async () => {
    await device.connect();
    await device.setScreenOff(true);
    await device.restartVideo();
    expect(
      clients[0].controller.setScreenPowerMode.mock.calls.map(([mode]) => mode),
    ).toEqual([AndroidScreenPowerMode.Off, AndroidScreenPowerMode.Normal]);
    expect(clients[1].controller.setScreenPowerMode).toHaveBeenCalledWith(
      AndroidScreenPowerMode.Off,
    );
    expect(device.screenOff).toBe(true);
    expect(ended).not.toHaveBeenCalled();
    await device.stop();
    expect(clients[1].controller.setScreenPowerMode).toHaveBeenLastCalledWith(
      AndroidScreenPowerMode.Normal,
    );
    expect(device.screenOff).toBe(false);
    await device.start();
    expect(clients[2].controller.setScreenPowerMode).not.toHaveBeenCalled();
  });

  it.each(["input", "display"] as const)(
    "still closes scrcpy and surfaces a %s restoration failure",
    async (failure) => {
      await device.connect();
      device.configuration = screen;
      await device.localInput(
        { kind: "key", action: "down", keyCode: 66, metaState: 0 },
        1,
      );
      await device.setScreenOff(true);
      const writer = clients[0].controller;
      if (failure === "input")
        writer.injectKeyCode.mockRejectedValueOnce(
          new Error("key release failed"),
        );
      else
        writer.setScreenPowerMode.mockRejectedValueOnce(
          new Error("display restore failed"),
        );
      await expect(device.stop()).rejects.toThrow(
        failure === "input" ? "key release failed" : "display restore failed",
      );
      expect(writer.setScreenPowerMode).toHaveBeenLastCalledWith(
        AndroidScreenPowerMode.Normal,
      );
      expect(clients[0].close).toHaveBeenCalledOnce();
      expect(device.playing).toBe(false);
      expect(status).toHaveBeenLastCalledWith(
        expect.stringContaining("关闭失败"),
      );
    },
  );

  it("reports failed OFF writes and still attempts display restoration before closing", async () => {
    await device.connect();
    clients[0].controller.setScreenPowerMode.mockRejectedValueOnce(
      new Error("display write failed"),
    );
    await expect(device.setScreenOff(true)).rejects.toThrow(
      "display write failed",
    );
    expect(device.screenOff).toBe(false);
    expect(device.playing).toBe(true);
    await device.stop();
    expect(clients[0].controller.setScreenPowerMode).toHaveBeenLastCalledWith(
      AndroidScreenPowerMode.Normal,
    );
  });

  it("does not restore stale screen-off state after disconnect during a pending OFF request", async () => {
    await device.connect();
    let unblock!: () => void;
    clients[0].controller.setScreenPowerMode.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          unblock = resolve;
        }),
    );
    const off = device.setScreenOff(true);
    const disconnected = device.disconnect();
    unblock();
    await Promise.all([off, disconnected]);
    expect(device.screenOff).toBe(false);
    expect(device.connected).toBe(false);
    expect(clients[0].controller.setScreenPowerMode).toHaveBeenLastCalledWith(
      AndroidScreenPowerMode.Normal,
    );
  });

  it("consumes RAW output audio only through the local callback and cancels capture on stop", async () => {
    let send!: ReadableStreamDefaultController<ScrcpyMediaStreamPacket>;
    const cancel = vi.fn();
    services.audio.mockResolvedValue({
      type: "success",
      codec: ScrcpyAudioCodec.Raw,
      stream: new ReadableStream({
        start(controller) {
          send = controller;
        },
        cancel,
      }),
    });
    await device.connect();
    const options = services.start.mock.calls[0][2].value;
    expect(
      options.audio &&
        options.audioSource === "output" &&
        options.audioCodec === "raw",
    ).toBe(true);
    send.enqueue({ type: "data", pts: 1_000n, data: new Uint8Array(960) });
    await vi.waitFor(() => expect(audioPacket).toHaveBeenCalledOnce());
    expect(audioPacket).toHaveBeenCalledWith(
      expect.objectContaining({ pts: 1_000n }),
    );
    expect(packet).not.toHaveBeenCalled();
    expect(device.audioForwarding && device.playing).toBe(true);
    await device.stop();
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(clients[0].close.mock.invocationCallOrder[0]).toBeLessThan(
      cancel.mock.invocationCallOrder[0],
    );
    expect(device.audioForwarding).toBe(false);
    expect(audioStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: "stopped" }),
    );
  });

  it("reports unavailable audio without preventing local video and input", async () => {
    services.audio.mockResolvedValue({ type: "disabled" });
    await device.connect();
    await vi.waitFor(() =>
      expect(audioStatus).toHaveBeenCalledWith(
        expect.objectContaining({ state: "unavailable" }),
      ),
    );
    device.configuration = screen;
    await device.localInput(
      { kind: "key", action: "down", keyCode: 66, metaState: 0 },
      1,
    );
    expect(device.playing).toBe(true);
    expect(clients[0].close).not.toHaveBeenCalled();
  });

  it("reports audio transport failure while leaving video running", async () => {
    let send!: ReadableStreamDefaultController<ScrcpyMediaStreamPacket>;
    services.audio.mockResolvedValue({
      type: "success",
      codec: ScrcpyAudioCodec.Raw,
      stream: new ReadableStream({
        start(controller) {
          send = controller;
        },
      }),
    });
    await device.connect();
    send.error(new Error("synthetic audio failure"));
    await vi.waitFor(() =>
      expect(audioStatus).toHaveBeenCalledWith(
        expect.objectContaining({
          state: "unavailable",
          message: expect.stringContaining("synthetic audio failure"),
        }),
      ),
    );
    expect(device.playing).toBe(true);
    expect(device.audioForwarding).toBe(false);
  });

  it("lets a stopped session opt out of capturing the phone's media audio", async () => {
    device.audioEnabled = false;
    await device.connect();
    expect(services.start.mock.calls[0][2].value.audio).toBe(false);
    expect(audioStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "disabled" }),
    );
    expect(device.playing).toBe(true);
    expect(device.audioForwarding).toBe(false);
  });
});
