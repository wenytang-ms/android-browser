import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoPlayer } from "../src/shared/player.js";
import type { MediaPacket } from "../src/shared/protocol.js";

vi.mock("@yume-chan/scrcpy", () => ({
  h264ParseConfiguration: () => ({
    profileIndex: 66,
    constraintSet: 224,
    levelIndex: 40,
    croppedWidth: 720,
    croppedHeight: 1280,
  }),
}));

class TestDecoder {
  static instances: TestDecoder[] = [];
  static isConfigSupported = vi.fn(async () => ({ supported: true }));
  state: "configured" | "unconfigured" | "closed" = "unconfigured";
  decodeQueueSize = 0;
  decode = vi.fn<(chunk: { options: EncodedVideoChunkInit }) => void>();
  reset = vi.fn(() => {
    this.state = "unconfigured";
    this.decodeQueueSize = 0;
  });
  configure = vi.fn(() => {
    this.state = "configured";
  });
  close = vi.fn(() => {
    this.state = "closed";
  });
  addEventListener = vi.fn();
  constructor(readonly options: VideoDecoderInit) {
    TestDecoder.instances.push(this);
  }
}

function packet(sequence: number, keyframe = false, stream = 1): MediaPacket {
  return {
    session: "a".repeat(32),
    stream,
    sequence,
    kind: "data",
    keyframe,
    pts: BigInt(sequence * 33333),
    width: 720,
    height: 1280,
    data: new Uint8Array([sequence]),
  };
}

describe("bounded H.264 playback", () => {
  let player: VideoPlayer;
  let errors = vi.fn<(message: string) => void>();
  let resync = vi.fn<() => void>();
  let callbacks: Map<number, FrameRequestCallback>;
  let draw: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    TestDecoder.instances = [];
    TestDecoder.isConfigSupported.mockResolvedValue({ supported: true });
    callbacks = new Map();
    let id = 0;
    vi.stubGlobal("VideoDecoder", TestDecoder);
    vi.stubGlobal(
      "EncodedVideoChunk",
      class {
        constructor(readonly options: EncodedVideoChunkInit) {}
      },
    );
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.set(++id, callback);
      return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (frameId: number) =>
      callbacks.delete(frameId),
    );
    errors = vi.fn<(message: string) => void>();
    resync = vi.fn<() => void>();
    draw = vi.fn();
    const canvas = {
      width: 1,
      height: 1,
      getContext: () => ({ drawImage: draw, clearRect: vi.fn() }),
    } as unknown as HTMLCanvasElement;
    player = new VideoPlayer(canvas, errors, resync);
  });
  afterEach(() => {
    player.dispose();
    vi.unstubAllGlobals();
  });

  async function configure(stream = 1) {
    player.push({
      ...packet(0, false, stream),
      kind: "configuration",
      data: new Uint8Array([0, 0, 1, 0x67]),
    });
    await Promise.resolve();
  }

  it("waits for a keyframe and prepends the current SPS/PPS when decoding resumes", async () => {
    await configure();
    const decoder = TestDecoder.instances[0];
    player.push(packet(1));
    expect(decoder.decode).not.toHaveBeenCalled();
    player.push(packet(2, true));
    const chunk = decoder.decode.mock.calls[0][0];
    expect(chunk.options.type).toBe("key");
    expect(chunk.options.timestamp).toBe(66666);
    expect(chunk.options.data).toEqual(new Uint8Array([0, 0, 1, 0x67, 2]));
  });

  it("abandons an overloaded dependent GOP and only resumes at a decodable keyframe", async () => {
    await configure();
    const decoder = TestDecoder.instances[0];
    player.push(packet(1, true));
    decoder.decodeQueueSize = 8;
    player.push(packet(2));
    player.push(packet(3));
    expect(decoder.reset).toHaveBeenCalledTimes(1);
    expect(decoder.decode).toHaveBeenCalledTimes(1);
    player.push(packet(4, true));
    player.push(packet(5));
    expect(decoder.decode).toHaveBeenCalledTimes(3);
    expect(player.stats.recoveries).toBe(1);
  });

  it("rejects old generations and waits for a new keyframe after a sequence gap", async () => {
    await configure();
    const old = TestDecoder.instances[0];
    player.push(packet(1, true));
    player.push(packet(3));
    expect(resync).toHaveBeenCalledOnce();
    expect(old.decode).toHaveBeenCalledOnce();
    await configure(2);
    expect(old.close).toHaveBeenCalledOnce();
    const current = TestDecoder.instances[1];
    player.push(packet(4, true, 1));
    expect(current.decode).not.toHaveBeenCalled();
    player.push(packet(1, true, 2));
    expect(current.decode).toHaveBeenCalledOnce();
  });

  it("renders only the latest decoded frame and releases replaced and pending frames", async () => {
    await configure();
    const first = { displayWidth: 720, displayHeight: 1280, close: vi.fn() };
    const second = { displayWidth: 1280, displayHeight: 720, close: vi.fn() };
    const output = TestDecoder.instances[0].options.output;
    output(first as unknown as VideoFrame);
    output(second as unknown as VideoFrame);
    expect(first.close).toHaveBeenCalledOnce();
    expect(callbacks.size).toBe(1);
    callbacks.values().next().value?.(0);
    expect(draw).toHaveBeenCalledWith(second, 0, 0);
    expect(second.close).toHaveBeenCalledOnce();
    expect(player.stats).toMatchObject({
      rendered: 1,
      width: 1280,
      height: 720,
    });
    const pending = { ...first, close: vi.fn() };
    output(pending as unknown as VideoFrame);
    player.dispose();
    expect(pending.close).toHaveBeenCalledOnce();
  });

  it("surfaces unsupported actual codec configurations instead of leaving a blank player", async () => {
    TestDecoder.isConfigSupported.mockResolvedValue({ supported: false });
    await configure();
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("不支持设备实际编码"),
    );
    expect(TestDecoder.instances).toHaveLength(0);
  });
});
