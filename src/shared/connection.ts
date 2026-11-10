import {
  channelUrl,
  errorText,
  HEARTBEAT_MS,
  OFFLINE_MS,
  parseServerMessage,
} from "./protocol.js";
import type { Channel, ClientMessage, ServerMessage } from "./protocol.js";

export class ChannelConnection {
  socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private retry?: ReturnType<typeof setTimeout>;
  private lastSeen = 0;
  private attempt = 0;
  private generation = 0;
  private stopped = true;
  private authorized = false;
  private expiresAt = Infinity;

  constructor(
    private readonly base: URL,
    private readonly channel: Channel,
    private readonly authenticate: () => ClientMessage,
    private readonly onMessage: (message: ServerMessage) => void,
    private readonly onStatus: (message: string) => void,
    private readonly onReady: () => void,
    private readonly onBinary: (bytes: Uint8Array) => void = () => {},
    private readonly onLost: () => void = () => {},
    private readonly onTerminal: (message: string) => void = () => {},
  ) {}

  start() {
    this.stop();
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  get ready(): boolean {
    return this.authorized && this.socket?.readyState === WebSocket.OPEN;
  }

  send(message: ClientMessage): boolean {
    if (!this.ready || !this.socket) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  private connect() {
    if (this.stopped) return;
    if (Date.now() >= this.expiresAt) {
      this.terminal("分享已过期，不能恢复旧凭据。");
      return;
    }
    const generation = ++this.generation;
    this.authorized = false;
    this.onStatus(
      this.attempt ? `正在重连（${this.attempt}/5）…` : "正在连接中继…",
    );
    const socket = new WebSocket(channelUrl(this.base, this.channel));
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    this.lastSeen = Date.now();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastSeen >= OFFLINE_MS) {
        socket.close(4001, "heartbeat-timeout");
      } else if (this.ready) this.send({ v: 1, type: "ping" });
    }, HEARTBEAT_MS);
    socket.onopen = () => {
      if (generation !== this.generation) return;
      socket.send(JSON.stringify(this.authenticate()));
    };
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (generation !== this.generation || this.stopped) return;
      this.lastSeen = Date.now();
      try {
        if (event.data instanceof ArrayBuffer) {
          if (!this.authorized) throw new Error("收到未授权视频。");
          this.onBinary(new Uint8Array(event.data));
          return;
        }
        if (typeof event.data !== "string")
          throw new Error("未知中继消息格式。");
        const message = parseServerMessage(event.data);
        if (message.type === "error") {
          this.terminal(`${message.message} (${message.code})`);
          return;
        }
        if (message.type === "ended") {
          this.onMessage(message);
          this.terminal(
            {
              revoked: "分享已被宿主撤销。",
              expired: "分享已过期。",
              "host-offline": "宿主离线，分享会话已结束。",
              "relay-shutdown": "中继关闭，分享会话已结束。",
              "login-expired": "Google 登录已注销或过期，请重新登录。",
            }[message.reason] ?? `会话已结束：${message.reason}`,
          );
          return;
        }
        if (message.type === "created" || message.type === "ready") {
          this.expiresAt = message.expiresAt;
          this.authorized = true;
          this.attempt = 0;
          this.onMessage(message);
          this.onReady();
          return;
        }
        this.onMessage(message);
      } catch (error) {
        this.terminal(`中继协议错误：${errorText(error)}`);
      }
    };
    socket.onerror = () => {
      if (generation === this.generation)
        this.onStatus("中继连接异常，检查地址、证书与网络；正在等待重连。");
    };
    socket.onclose = (event) => {
      if (generation !== this.generation) return;
      this.authorized = false;
      this.clearHeartbeat();
      this.onLost();
      if (this.stopped) return;
      if (event.code === 4000 || event.code === 4003) {
        this.terminal(`连接已结束：${event.reason || "会话不再有效"}`);
        return;
      }
      if (++this.attempt > 5) {
        this.terminal("重连失败，请检查网络后重新开始。");
        return;
      }
      this.onStatus(`连接中断，等待重连（${this.attempt}/5）…`);
      this.retry = setTimeout(
        () => this.connect(),
        Math.min(500 * 2 ** (this.attempt - 1), 4_000),
      );
    };
  }

  private terminal(message: string) {
    this.stop();
    this.onStatus(message);
    this.onTerminal(message);
  }

  private clearHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  stop() {
    this.stopped = true;
    this.authorized = false;
    ++this.generation;
    this.clearHeartbeat();
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    this.socket?.close(1000, "client-stop");
    this.socket = undefined;
  }
}
