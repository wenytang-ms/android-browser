import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostShare } from "../src/extension/share.js";
import { decodeMedia, MAX_BUFFER_BYTES } from "../src/shared/protocol.js";
import type {
  Channel,
  ClientMessage,
  MediaPacket,
  InputMessage,
  ServerMessage,
} from "../src/shared/protocol.js";

interface TestChannel {
  channel: Channel;
  ready: boolean;
  socket: { bufferedAmount: number; sent: Uint8Array[] };
  onMessage: (message: ServerMessage) => void;
  requests: ClientMessage[];
  resume(): void;
  stop(): void;
}
const channels = vi.hoisted(() => ({ items: [] as TestChannel[] }));
vi.mock("../src/shared/auth.js", () => ({ logout: vi.fn(async () => {}) }));

vi.mock("../src/shared/connection.js", () => ({
  ChannelConnection: class implements TestChannel {
    ready = false;
    requests: ClientMessage[] = [];
    socket = {
      bufferedAmount: 0,
      sent: [] as Uint8Array[],
      send: (data: Uint8Array) => {
        this.socket.sent.push(data);
      },
    };
    constructor(
      _base: URL,
      readonly channel: Channel,
      private readonly authenticate: () => ClientMessage,
      readonly onMessage: (message: ServerMessage) => void,
      _onStatus: (message: string) => void,
      private readonly onReady: () => void,
    ) {
      channels.items.push(this);
    }
    start() {
      this.ready = true;
      if (this.authenticate().type === "create")
        this.onMessage({
          v: 1,
          type: "created",
          session: "a".repeat(32),
          hostToken: "b".repeat(64),
          expiresAt: Date.now() + 1_800_000,
        });
      this.onReady();
    }
    send(message: ClientMessage) {
      if (!this.ready) return false;
      this.requests.push(message);
      if (message.type === "end")
        queueMicrotask(() =>
          this.onMessage({ v: 1, type: "ended", reason: "revoked" }),
        );
      return true;
    }
    resume() {
      this.ready = true;
      this.onReady();
    }
    stop() {
      this.ready = false;
    }
  },
}));

const configuration: MediaPacket = {
  session: "0".repeat(32),
  stream: 1,
  sequence: 0,
  kind: "configuration",
  keyframe: false,
  pts: 0n,
  width: 720,
  height: 1280,
  data: new Uint8Array([0, 0, 1, 0x67]),
};
function frame(sequence: number, keyframe = false): MediaPacket {
  return {
    ...configuration,
    kind: "data",
    sequence,
    keyframe,
    pts: BigInt(sequence),
    data: new Uint8Array([0, 0, 1, keyframe ? 0x65 : 0x41]),
  };
}

describe("host sharing isolated from USB playback", () => {
  let share: HostShare;
  let restart: ReturnType<typeof vi.fn<() => void>>;
  beforeEach(() => {
    vi.useFakeTimers();
    channels.items = [];
    restart = vi.fn<() => void>();
    share = new HostShare(
      () => {},
      () => {},
      restart,
      () => {},
      async () => {},
    );
  });
  afterEach(() => {
    share.dispose();
    vi.useRealTimers();
  });

  it("uses a session-only link and waits for a new keyframe without replaying cached video", async () => {
    await share.start(
      new URL("https://share.example.com"),
      "",
      "d".repeat(64),
      configuration,
    );
    const link = new URL(share.link);
    expect(link.searchParams.get("session")).toBe("a".repeat(32));
    expect(link.searchParams.has("token")).toBe(false);
    expect(link.hash).toBe("");
    const media = channels.items[1];
    share.push(frame(1));
    expect(media.socket.sent).toHaveLength(0);
    share.push(frame(2, true));
    expect(media.socket.sent.map(decodeMedia)).toMatchObject([
      { kind: "configuration", stream: 1, sequence: 0 },
      { kind: "data", stream: 1, sequence: 1, keyframe: true },
    ]);
  });

  it("rebuilds the media channel under congestion and restarts only at a fresh GOP", async () => {
    await share.start(
      new URL("https://share.example.com"),
      "",
      "d".repeat(64),
      configuration,
    );
    share.push(frame(1, true));
    const old = channels.items[1];
    old.socket.bufferedAmount = MAX_BUFFER_BYTES;
    share.push(frame(2));
    expect(old.ready).toBe(false);
    expect(old.socket.sent).toHaveLength(2);
    const current = channels.items[2];
    share.push(frame(3));
    expect(current.socket.sent).toHaveLength(0);
    share.push(frame(4, true));
    expect(current.socket.sent.map(decodeMedia)).toMatchObject([
      { kind: "configuration", stream: 2 },
      { kind: "data", stream: 2, keyframe: true },
    ]);
    expect(share.active).toBe(true);
  });

  it("requests a stream rebuild if a static screen cannot supply a timely fresh keyframe", async () => {
    await share.start(
      new URL("https://share.example.com"),
      "",
      "d".repeat(64),
      configuration,
    );
    share.push(frame(1, true));
    channels.items[0].onMessage({ v: 1, type: "resync" });
    await vi.advanceTimersByTimeAsync(2_500);
    expect(restart).toHaveBeenCalledOnce();
    expect(share.active).toBe(true);
  });

  it("revokes sharing without invoking a device/video restart", async () => {
    await share.start(
      new URL("https://share.example.com"),
      "",
      "d".repeat(64),
      configuration,
    );
    const stopped = share.stop();
    await vi.advanceTimersByTimeAsync(0);
    await stopped;
    expect(share.active).toBe(false);
    expect(share.link).toBe("");
    expect(restart).not.toHaveBeenCalled();
    expect(channels.items.every((channel) => !channel.ready)).toBe(true);
  });

  it("isolates remote packet failures instead of throwing into the USB video reader", async () => {
    await share.start(
      new URL("https://share.example.com"),
      "",
      "d".repeat(64),
      configuration,
    );
    expect(() => share.push({ ...frame(1, true), width: 0 })).not.toThrow();
    expect(share.active).toBe(false);
    expect(restart).not.toHaveBeenCalled();
  });

  it("checks the active control grant and screen before dispatching remote input to the device", async () => {
    const controller = vi.fn<(id: string | null) => void>();
    const consume = vi.fn<
      (message: InputMessage, stream: number) => Promise<void>
    >(async () => {});
    share = new HostShare(
      () => {},
      () => {},
      restart,
      controller,
      consume,
    );
    await share.start(
      new URL("https://share.example.com"),
      "",
      "d".repeat(64),
      configuration,
    );
    channels.items[0].onMessage({
      v: 1,
      type: "controller",
      controlId: "e".repeat(32),
    });
    share.push(frame(1, true));
    const message: InputMessage = {
      v: 1,
      type: "input",
      controlId: "e".repeat(32),
      stream: 1,
      sequence: 1,
      event: { kind: "key", action: "down", keyCode: 66, metaState: 0 },
    };
    channels.items[0].onMessage(message);
    expect(consume).toHaveBeenCalledWith(message, configuration.stream);
    channels.items[0].onMessage({ ...message, stream: 2, sequence: 2 });
    expect(consume).toHaveBeenCalledTimes(1);
    expect(share.active).toBe(false);
    expect(controller).toHaveBeenLastCalledWith(null);
  });

  it("keeps local takeover across reconnects and ignores in-flight remote input until a new grant arrives", async () => {
    const consume = vi.fn<
      (message: InputMessage, stream: number) => Promise<void>
    >(async () => {});
    share = new HostShare(
      () => {},
      () => {},
      restart,
      () => {},
      consume,
    );
    await share.start(
      new URL("https://share.example.com"),
      "",
      "d".repeat(64),
      configuration,
    );
    share.push(frame(1, true));
    const channel = channels.items[0];
    channel.onMessage({ v: 1, type: "controller", controlId: "e".repeat(32) });
    const message: InputMessage = {
      v: 1,
      type: "input",
      controlId: "e".repeat(32),
      stream: 1,
      sequence: 1,
      event: { kind: "key", action: "down", keyCode: 66, metaState: 0 },
    };
    share.setRemoteControlEnabled(false);
    channel.onMessage(message);
    channel.resume();
    expect(channel.requests.at(-1)).toEqual({
      v: 1,
      type: "control-permission",
      enabled: false,
    });
    expect(share.active).toBe(true);
    expect(consume).not.toHaveBeenCalled();
    share.setRemoteControlEnabled(true);
    channel.onMessage(message);
    expect(share.active).toBe(true);
    expect(consume).not.toHaveBeenCalled();
  });
});
