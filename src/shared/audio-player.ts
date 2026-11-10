import { errorText } from "./protocol.js";

// scrcpy 2.1 RAW output is 48 kHz stereo signed 16-bit little-endian PCM.
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAME_BYTES = CHANNELS * 2;
const TARGET_BUFFER = 0.04;
const MAX_BUFFER = 0.12;

export interface LocalAudioPacket {
  stream: number;
  pts: bigint;
  data: Uint8Array;
}

export interface LocalAudioStatus {
  state: "starting" | "forwarding" | "disabled" | "unavailable" | "stopped";
  message: string;
}

export class AudioPlayer {
  private context?: AudioContext;
  private gain?: GainNode;
  private sources = new Set<AudioBufferSourceNode>();
  private stream = 0;
  private nextTime = 0;
  private lastPts?: bigint;
  private failed = false;
  private disposed = false;
  muted = false;

  constructor(
    private readonly onError: (message: string) => void,
    private readonly onChanged: () => void = () => {},
  ) {}

  get active() {
    return !this.muted && !this.failed && this.context?.state === "running";
  }

  get bufferedMs() {
    return this.context
      ? Math.max(0, (this.nextTime - this.context.currentTime) * 1_000)
      : 0;
  }

  async resume() {
    if (this.disposed || this.muted) return;
    this.failed = false;
    let context = this.context;
    if (!context) {
      context = new AudioContext({
        sampleRate: SAMPLE_RATE,
        latencyHint: "interactive",
      });
      this.context = context;
      this.gain = context.createGain();
      this.gain.connect(context.destination);
      context.addEventListener("statechange", () => {
        if (this.context === context) this.onChanged();
      });
    }
    try {
      await context.resume();
    } catch (error) {
      if (this.context === context) throw error;
      return;
    }
    if (this.context === context) this.onChanged();
  }

  async enable() {
    this.muted = false;
    this.reset();
    await this.resume();
  }

  mute() {
    this.muted = true;
    this.reset();
    this.onChanged();
  }

  push(packet: LocalAudioPacket) {
    const context = this.context;
    const gain = this.gain;
    if (this.disposed || !this.active || !context || !gain) return;
    if (packet.stream < this.stream) return;
    try {
      const { data, pts } = packet;
      if (!data.byteLength) return;
      if (
        data.byteLength % FRAME_BYTES ||
        data.byteLength > 15_360 ||
        pts < 0n ||
        packet.stream < 1 ||
        !Number.isInteger(packet.stream)
      )
        throw new Error("手机 PCM 音频数据无效。");
      if (
        packet.stream !== this.stream ||
        (this.lastPts !== undefined &&
          (pts < this.lastPts || pts - this.lastPts > 250_000n))
      ) {
        this.reset();
        this.stream = packet.stream;
      }
      const frames = data.byteLength / FRAME_BYTES;
      const duration = frames / SAMPLE_RATE;
      const now = context.currentTime;
      let start =
        this.nextTime < now + 0.005 ? now + TARGET_BUFFER : this.nextTime;
      if (this.sources.size >= 32 || start + duration - now > MAX_BUFFER) {
        this.reset();
        start = now + TARGET_BUFFER;
      }
      const buffer = context.createBuffer(CHANNELS, frames, SAMPLE_RATE);
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      for (let channel = 0; channel < CHANNELS; ++channel) {
        const output = buffer.getChannelData(channel);
        for (let frame = 0; frame < frames; ++frame)
          output[frame] =
            view.getInt16(frame * FRAME_BYTES + channel * 2, true) / 32768;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(gain);
      source.onended = () => {
        this.sources.delete(source);
        source.disconnect();
      };
      source.start(start);
      this.sources.add(source);
      this.nextTime = start + duration;
      this.lastPts = pts;
      this.stream = packet.stream;
    } catch (error) {
      this.failed = true;
      this.reset();
      this.onError(
        `网页音频播放失败：${errorText(error)}。可点击启用声音重试，或停止投屏恢复手机发声。`,
      );
      this.onChanged();
    }
  }

  reset() {
    for (const source of this.sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.sources.clear();
    this.nextTime = 0;
    this.lastPts = undefined;
  }

  close() {
    this.reset();
    const context = this.context;
    this.context = undefined;
    this.gain?.disconnect();
    this.gain = undefined;
    this.stream = 0;
    this.onChanged();
    if (context && context.state !== "closed")
      void context
        .close()
        .catch((error: unknown) =>
          this.onError(`音频资源释放失败：${errorText(error)}`),
        );
  }

  dispose() {
    this.disposed = true;
    this.close();
  }
}
