import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioPlayer } from "../src/shared/audio-player.js";

class BufferFixture {
  readonly channels: Float32Array[];
  constructor(
    channels: number,
    frames: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from(
      { length: channels },
      () => new Float32Array(frames),
    );
  }
  getChannelData(channel: number) {
    return this.channels[channel];
  }
}

class SourceFixture {
  buffer?: BufferFixture;
  onended: (() => void) | null = null;
  connect = vi.fn();
  disconnect = vi.fn();
  start = vi.fn<(time: number) => void>();
  stop = vi.fn();
}

class ContextFixture extends EventTarget {
  state: AudioContextState = "suspended";
  currentTime = 0;
  destination = {};
  sources: SourceFixture[] = [];
  gain = { connect: vi.fn(), disconnect: vi.fn() };
  createGain() {
    return this.gain;
  }
  createBuffer(channels: number, frames: number, rate: number) {
    return new BufferFixture(channels, frames, rate);
  }
  createBufferSource() {
    const source = new SourceFixture();
    this.sources.push(source);
    return source;
  }
  async resume() {
    this.state = "running";
    this.dispatchEvent(new Event("statechange"));
  }
  async close() {
    this.state = "closed";
    this.dispatchEvent(new Event("statechange"));
  }
}

describe("bounded local PCM audio playback", () => {
  let context: ContextFixture;
  let player: AudioPlayer;
  let errors: ReturnType<typeof vi.fn<(message: string) => void>>;
  beforeEach(() => {
    context = new ContextFixture();
    vi.stubGlobal("AudioContext", function () {
      return context;
    });
    errors = vi.fn();
    player = new AudioPlayer(errors);
  });
  afterEach(() => {
    player.dispose();
    vi.unstubAllGlobals();
  });

  it("deinterleaves signed little-endian PCM using the packet's actual byte offset", async () => {
    await player.resume();
    const data = new Uint8Array([99, 99, 0, 128, 255, 127, 0, 64, 0, 192, 99]);
    player.push({ stream: 1, pts: 0n, data: data.subarray(2, 10) });
    const buffer = context.sources[0].buffer!;
    expect(Array.from(buffer.channels[0])).toEqual([-1, 0.5]);
    expect(buffer.channels[1][0]).toBeCloseTo(32767 / 32768);
    expect(buffer.channels[1][1]).toBe(-0.5);
    expect(errors).not.toHaveBeenCalled();
  });

  it("discards queued audio on mute and plays only fresh packets on resume", async () => {
    await player.resume();
    const packet = { stream: 1, pts: 0n, data: new Uint8Array(960) };
    player.push(packet);
    player.mute();
    expect(context.sources[0].stop).toHaveBeenCalledOnce();
    player.push(packet);
    expect(context.sources).toHaveLength(1);
    context.currentTime = 10;
    await player.enable();
    player.push({ ...packet, pts: 10_000_000n });
    expect(context.sources).toHaveLength(2);
    expect(context.sources[1].start).toHaveBeenCalledWith(
      expect.closeTo(10.04),
    );
  });

  it("drops buffered sound instead of allowing an arrival burst to create unbounded latency", async () => {
    await player.resume();
    for (let index = 0; index < 60; ++index)
      player.push({
        stream: 1,
        pts: BigInt(index * 5_000),
        data: new Uint8Array(960),
      });
    expect(player.bufferedMs).toBeLessThanOrEqual(120.001);
    expect(
      context.sources.some((source) => source.stop.mock.calls.length),
    ).toBe(true);
    context.currentTime = 5;
    player.push({ stream: 1, pts: 5_000_000n, data: new Uint8Array(960) });
    expect(context.sources.at(-1)?.start).toHaveBeenCalledWith(
      expect.closeTo(5.04),
    );
  });

  it("schedules adjacent PCM blocks continuously despite small packet-arrival jitter", async () => {
    await player.resume();
    player.push({ stream: 1, pts: 0n, data: new Uint8Array(960) });
    context.currentTime = 0.006;
    player.push({ stream: 1, pts: 5_000n, data: new Uint8Array(960) });
    expect(context.sources[0].start).toHaveBeenCalledWith(expect.closeTo(0.04));
    expect(context.sources[1].start).toHaveBeenCalledWith(
      expect.closeTo(0.045),
    );
  });

  it("clears old-stream audio and ignores stale packets after a video-service restart", async () => {
    await player.resume();
    const packet = { stream: 1, pts: 0n, data: new Uint8Array(960) };
    player.push(packet);
    player.push({ ...packet, stream: 2 });
    expect(context.sources[0].stop).toHaveBeenCalled();
    player.push(packet);
    expect(context.sources).toHaveLength(2);
  });

  it("reports invalid PCM without growing the queue and supports an explicit retry", async () => {
    await player.resume();
    player.push({ stream: 1, pts: 0n, data: new Uint8Array(3) });
    expect(errors).toHaveBeenCalledWith(expect.stringContaining("播放失败"));
    expect(player.active).toBe(false);
    expect(context.sources).toHaveLength(0);
    await player.enable();
    player.push({ stream: 1, pts: 0n, data: new Uint8Array(960) });
    expect(player.active).toBe(true);
    expect(context.sources).toHaveLength(1);
  });
});
