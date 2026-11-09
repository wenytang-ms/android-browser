import { h264ParseConfiguration } from "@yume-chan/scrcpy";
import { errorText, MAX_DECODE_QUEUE } from "./protocol.js";
import type { MediaPacket } from "./protocol.js";

export interface PlayerStats {
  decoded: number;
  rendered: number;
  recoveries: number;
  decodeQueue: number;
  width: number;
  height: number;
}

export function h264Config(data: Uint8Array): VideoDecoderConfig {
  const parsed = h264ParseConfiguration(data);
  const codec = [parsed.profileIndex, parsed.constraintSet, parsed.levelIndex]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
  return {
    codec: `avc1.${codec}`,
    codedWidth: parsed.croppedWidth,
    codedHeight: parsed.croppedHeight,
    optimizeForLatency: true,
    hardwareAcceleration: "no-preference",
  };
}

export async function checkDecoderSupport() {
  if (!globalThis.isSecureContext)
    throw new Error("视频播放需要 HTTPS 或 localhost 安全上下文。");
  if (typeof VideoDecoder === "undefined")
    throw new Error("浏览器不支持 WebCodecs，请使用桌面 Chrome 118+。");
  const result = await VideoDecoder.isConfigSupported({
    codec: "avc1.42E028",
    optimizeForLatency: true,
  });
  if (!result.supported)
    throw new Error("当前浏览器或显卡不支持所需 H.264 解码，请检查硬件加速。");
}

export class VideoPlayer {
  readonly stats: PlayerStats = {
    decoded: 0,
    rendered: 0,
    recoveries: 0,
    decodeQueue: 0,
    width: 0,
    height: 0,
  };
  private decoder?: VideoDecoder;
  private configuration?: Uint8Array;
  private decoderConfig?: VideoDecoderConfig;
  private stream = 0;
  private sequence = 0;
  private waitingKey = true;
  private epoch = 0;
  private pendingFrame?: VideoFrame;
  private animation?: number;
  private disposed = false;
  private readonly context: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onError: (message: string) => void,
    private readonly onResync: () => void = () => {},
  ) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法创建 Canvas 播放画布。");
    this.context = context;
  }

  push(packet: MediaPacket) {
    if (this.disposed) return;
    if (packet.kind === "configuration") {
      if (packet.stream <= this.stream) return;
      this.stream = packet.stream;
      this.sequence = packet.sequence;
      void this.configure(packet.data);
      return;
    }
    if (packet.stream !== this.stream) return;
    if (this.sequence !== 0 && packet.sequence !== this.sequence + 1) {
      this.recover();
      this.onResync();
    }
    this.sequence = packet.sequence;
    const decoder = this.decoder;
    if (!decoder || decoder.state !== "configured") return;
    if (decoder.decodeQueueSize >= MAX_DECODE_QUEUE) this.recover();
    if (this.waitingKey && !packet.keyframe) return;
    if (packet.pts > BigInt(Number.MAX_SAFE_INTEGER)) {
      this.fail("视频时间戳超出解码范围，请重新开始投屏。");
      return;
    }
    let data: Uint8Array<ArrayBuffer> = new Uint8Array(packet.data);
    if (packet.keyframe && this.configuration) {
      data = new Uint8Array(
        this.configuration.byteLength + packet.data.byteLength,
      );
      data.set(this.configuration);
      data.set(packet.data, this.configuration.byteLength);
    }
    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: packet.keyframe ? "key" : "delta",
          timestamp: Number(packet.pts),
          data,
        }),
      );
      this.waitingKey = false;
      this.stats.decodeQueue = decoder.decodeQueueSize;
    } catch (error) {
      this.fail(`视频解码失败：${errorText(error)}。请重新连接。`);
    }
  }

  private async configure(data: Uint8Array) {
    const epoch = ++this.epoch;
    this.closeDecoder();
    this.pendingFrame?.close();
    this.pendingFrame = undefined;
    this.waitingKey = true;
    this.configuration = new Uint8Array(data);
    try {
      const config = h264Config(data);
      const support = await VideoDecoder.isConfigSupported(config);
      if (this.disposed || epoch !== this.epoch) return;
      if (!support.supported)
        throw new Error(
          `不支持设备实际编码 ${config.codec}，请更换浏览器或显卡配置`,
        );
      this.decoderConfig = config;
      this.decoder = new VideoDecoder({
        output: (frame) => this.output(frame),
        error: (error) => this.fail(`H.264 解码异常：${error.message}`),
      });
      this.decoder.addEventListener("dequeue", () => {
        this.stats.decodeQueue = this.decoder?.decodeQueueSize ?? 0;
      });
      this.decoder.configure(config);
    } catch (error) {
      if (epoch === this.epoch && !this.disposed) this.fail(errorText(error));
    }
  }

  private recover() {
    this.waitingKey = true;
    this.stats.recoveries++;
    this.pendingFrame?.close();
    this.pendingFrame = undefined;
    if (this.decoder?.state === "configured" && this.decoderConfig) {
      this.decoder.reset();
      this.decoder.configure(this.decoderConfig);
    }
    this.stats.decodeQueue = 0;
  }

  private output(frame: VideoFrame) {
    if (this.disposed) {
      frame.close();
      return;
    }
    this.stats.decoded++;
    this.pendingFrame?.close();
    this.pendingFrame = frame;
    if (this.animation !== undefined) return;
    this.animation = requestAnimationFrame(() => {
      this.animation = undefined;
      const latest = this.pendingFrame;
      this.pendingFrame = undefined;
      if (!latest) return;
      try {
        if (
          this.canvas.width !== latest.displayWidth ||
          this.canvas.height !== latest.displayHeight
        ) {
          this.canvas.width = latest.displayWidth;
          this.canvas.height = latest.displayHeight;
        }
        this.stats.width = latest.displayWidth;
        this.stats.height = latest.displayHeight;
        this.context.drawImage(latest, 0, 0);
        this.stats.rendered++;
      } catch (error) {
        this.fail(`画面显示失败：${errorText(error)}`);
      } finally {
        latest.close();
      }
    });
  }

  reset() {
    ++this.epoch;
    this.closeDecoder();
    this.stream = 0;
    this.sequence = 0;
    this.waitingKey = true;
    this.configuration = undefined;
    this.decoderConfig = undefined;
    if (this.animation !== undefined) cancelAnimationFrame(this.animation);
    this.animation = undefined;
    this.pendingFrame?.close();
    this.pendingFrame = undefined;
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private closeDecoder() {
    if (this.decoder && this.decoder.state !== "closed") this.decoder.close();
    this.decoder = undefined;
    this.stats.decodeQueue = 0;
  }

  private fail(message: string) {
    this.reset();
    this.onError(message);
  }

  dispose() {
    this.disposed = true;
    this.reset();
  }
}
