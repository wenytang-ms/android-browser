import { ChannelConnection } from "../shared/connection.js";
import {
  encodeMedia,
  errorText,
  HEADER_BYTES,
  MAX_BUFFER_BYTES,
  MAX_PACKET_BYTES,
} from "../shared/protocol.js";
import type { MediaPacket, ServerMessage } from "../shared/protocol.js";

export class HostShare {
  active = false;
  link = "";
  expiresAt = 0;
  bufferedBytes = 0;
  recoveries = 0;
  private control?: ChannelConnection;
  private media?: ChannelConnection;
  private session = "";
  private hostToken = "";
  private viewerToken = "";
  private configuration?: MediaPacket;
  private stream = 0;
  private sequence = 0;
  private needsSync = true;
  private resolveStart?: () => void;
  private rejectStart?: (error: Error) => void;
  private resolveEnd?: () => void;
  private endTimer?: ReturnType<typeof setTimeout>;
  private startTimer?: ReturnType<typeof setTimeout>;
  private syncTimer?: ReturnType<typeof setTimeout>;
  private base?: URL;

  constructor(
    private readonly onStatus: (message: string) => void,
    private readonly onChanged: () => void,
    private readonly onRestartVideo: () => void,
  ) {}

  async start(base: URL, deploymentToken: string, configuration?: MediaPacket) {
    if (this.active) throw new Error("分享已经开启。");
    this.active = true;
    this.base = base;
    this.configuration = configuration;
    this.stream = 0;
    this.session = "";
    this.hostToken = "";
    this.link = "";
    this.needsSync = true;
    const started = new Promise<void>((resolve, reject) => {
      this.resolveStart = resolve;
      this.rejectStart = reject;
    });
    this.startTimer = setTimeout(
      () => this.finish("中继启动超时，请检查连接地址与授权。"),
      30_000,
    );
    this.control = new ChannelConnection(
      base,
      "control",
      () =>
        this.session
          ? {
              v: 1,
              type: "auth",
              role: "host",
              session: this.session,
              token: this.hostToken,
            }
          : { v: 1, type: "create", deploymentToken },
      (message) => this.message(message),
      this.onStatus,
      () => this.openMedia(),
      undefined,
      () => {
        this.media?.stop();
        this.needsSync = true;
      },
      (message) => this.finish(message),
    );
    this.control.start();
    this.onChanged();
    await started;
  }

  private message(message: ServerMessage) {
    if (message.type === "created") {
      this.session = message.session;
      this.hostToken = message.hostToken;
      this.viewerToken = message.viewerToken;
      this.expiresAt = message.expiresAt;
    } else if (message.type === "resync") {
      this.needsSync = true;
      this.waitForKeyframe();
    } else if (message.type === "ended") {
      this.resolveEnd?.();
      this.finish(
        message.reason === "revoked"
          ? "远程分享已撤销，本地投屏不受影响。"
          : `分享已结束：${message.reason}`,
      );
    }
  }

  private openMedia() {
    if (!this.base || !this.active) return;
    this.media?.stop();
    this.media = new ChannelConnection(
      this.base,
      "media",
      () => ({
        v: 1,
        type: "auth",
        role: "host",
        session: this.session,
        token: this.hostToken,
      }),
      (message) => this.message(message),
      this.onStatus,
      () => {
        this.needsSync = true;
        this.waitForKeyframe();
        const link = new URL("/", this.base);
        link.searchParams.set("session", this.session);
        link.hash = `token=${this.viewerToken}`;
        this.link = link.href;
        this.onStatus("远程分享已开启，等待观看者；链接凭据有效 30 分钟。");
        this.resolveStart?.();
        this.resolveStart = undefined;
        this.rejectStart = undefined;
        if (this.startTimer) clearTimeout(this.startTimer);
        this.startTimer = undefined;
        this.onChanged();
      },
      undefined,
      () => {
        this.needsSync = true;
      },
      (message) => this.finish(message),
    );
    this.media.start();
  }

  push(packet: MediaPacket) {
    if (packet.kind === "configuration") {
      this.configuration = { ...packet, data: new Uint8Array(packet.data) };
      this.needsSync = true;
      return;
    }
    const socket = this.media?.socket;
    if (!this.active || !this.media?.ready || !socket || !this.configuration)
      return;
    if (packet.data.byteLength > MAX_PACKET_BYTES - HEADER_BYTES) {
      this.finish("单帧视频超过中继上限，请降低分辨率或码率后重新分享。");
      return;
    }
    this.bufferedBytes = socket.bufferedAmount;
    const configurationBytes =
      this.needsSync && packet.keyframe
        ? this.configuration.data.byteLength + HEADER_BYTES
        : 0;
    if (
      socket.bufferedAmount +
        packet.data.byteLength +
        HEADER_BYTES +
        configurationBytes >
      MAX_BUFFER_BYTES
    ) {
      this.recoveries++;
      this.needsSync = true;
      this.onStatus(
        "上行视频积压，正在重建视频连接并等待关键帧；本地继续播放。",
      );
      this.openMedia();
      return;
    }
    if (this.needsSync) {
      if (!packet.keyframe) return;
      this.stream++;
      this.sequence = 0;
      if (
        !this.sendMedia(socket, {
          ...this.configuration,
          session: this.session,
          stream: this.stream,
          sequence: 0,
        })
      )
        return;
      this.needsSync = false;
      if (this.syncTimer) clearTimeout(this.syncTimer);
      this.syncTimer = undefined;
    }

    this.sendMedia(socket, {
      ...packet,
      session: this.session,
      stream: this.stream,
      sequence: ++this.sequence,
    });
  }

  private sendMedia(socket: WebSocket, packet: MediaPacket): boolean {
    try {
      socket.send(encodeMedia(packet));
      return true;
    } catch (error) {
      this.finish(`远程视频发送失败：${errorText(error)}；本地投屏不受影响。`);
      return false;
    }
  }

  private waitForKeyframe() {
    if (this.syncTimer) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      if (this.active && this.media?.ready && this.needsSync) {
        this.onStatus("设备未及时产生关键帧，正在重建编码流以恢复观看。");
        this.onRestartVideo();
      }
    }, 2_500);
  }

  async stop() {
    if (!this.active) return;
    if (!this.control?.send({ v: 1, type: "end" })) {
      this.finish(
        "分享连接已关闭；当前无法即时撤销，旧会话将在宿主离线超时（约 20 秒内）结束。",
      );
      return;
    }
    const ended = new Promise<void>((resolve) => {
      this.resolveEnd = resolve;
    });
    this.endTimer = setTimeout(() => {
      this.resolveEnd?.();
      this.finish(
        "撤销确认超时；连接已关闭，旧会话将在宿主离线超时（约 20 秒内）结束。",
      );
    }, 3_000);
    await ended;
  }

  private finish(message: string) {
    if (!this.active) return;
    this.active = false;
    this.control?.send({ v: 1, type: "end" });
    this.control?.stop();
    this.media?.stop();
    this.control = undefined;
    this.media = undefined;
    if (this.startTimer) clearTimeout(this.startTimer);
    if (this.endTimer) clearTimeout(this.endTimer);
    if (this.syncTimer) clearTimeout(this.syncTimer);
    this.startTimer = undefined;
    this.endTimer = undefined;
    this.syncTimer = undefined;
    this.rejectStart?.(new Error(message));
    this.rejectStart = undefined;
    this.resolveStart = undefined;
    this.resolveEnd?.();
    this.resolveEnd = undefined;
    this.session = "";
    this.hostToken = "";
    this.viewerToken = "";
    this.link = "";
    this.configuration = undefined;
    this.bufferedBytes = 0;
    this.onStatus(message);
    this.onChanged();
  }

  dispose() {
    this.finish("宿主页面已关闭。");
  }
}
