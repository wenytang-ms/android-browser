import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReadableStream } from "@yume-chan/stream-extra";
import type { ReadableStreamDefaultController } from "@yume-chan/stream-extra";
import { DeviceSession } from "../src/extension/device.js";
import type { MediaPacket } from "../src/shared/protocol.js";

const services = vi.hoisted(() => ({
  requestDevice: vi.fn(),
  authenticate: vi.fn(),
  pushServer: vi.fn(),
  start: vi.fn(),
  adbClose: vi.fn(),
}));

vi.mock("@yume-chan/adb-daemon-webusb", () => ({
  AdbDaemonWebUsbDeviceManager: {
    BROWSER: { requestDevice: services.requestDevice },
  },
}));
vi.mock("@yume-chan/adb", () => ({
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
  let clients: { close: ReturnType<typeof vi.fn<() => Promise<void>>> }[];
  let disconnectTransport: () => void;

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
    services.start.mockImplementation(async () => {
      let output: ReadableStreamDefaultController<string>;
      let video: ReadableStreamDefaultController<{
        type: "data";
        pts: bigint;
        keyframe: boolean;
        data: Uint8Array;
      }>;
      const client = {
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
    device = new DeviceSession(status, packet, ended);
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
});
