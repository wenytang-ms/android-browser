import { ChannelConnection } from "../shared/connection.js";
import { checkDecoderSupport, VideoPlayer } from "../shared/player.js";
import { decodeMedia, errorText, isSessionId } from "../shared/protocol.js";
import { element, trackStats } from "../shared/ui.js";
import "../shared/style.css";

const join = element("join", HTMLButtonElement);
const leave = element("leave", HTMLButtonElement);
const status = element("status", HTMLParagraphElement);
const expiry = element("expiry", HTMLParagraphElement);
const session = new URL(location.href).searchParams.get("session");
let token = new URLSearchParams(location.hash.slice(1)).get("token");
let viewerId = crypto.randomUUID().replaceAll("-", "");
let control: ChannelConnection | undefined;
let media: ChannelConnection | undefined;
let active = false;
let lastResync = 0;
let lastRendered = 0;
let hostOnline = false;
const player = new VideoPlayer(
  element("screen", HTMLCanvasElement),
  (message) => {
    stop(message);
  },
  () => {
    if (Date.now() - lastResync > 1_000) {
      lastResync = Date.now();
      control?.send({ v: 1, type: "resync" });
      status.textContent = "视频积压或序列中断，等待配置与关键帧恢复…";
    }
  },
);

try {
  if (!isSessionId(session)) throw new Error("分享链接缺少有效会话 ID。");
  const key = `tango-viewer:${session}`;
  if (token && /^[a-f0-9]{64}$/.test(token)) {
    sessionStorage.setItem(key, token);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  } else token = sessionStorage.getItem(key);
  const savedId = sessionStorage.getItem(`${key}:id`);
  if (isSessionId(savedId)) viewerId = savedId;
  else sessionStorage.setItem(`${key}:id`, viewerId);
  if (!token || !/^[a-f0-9]{64}$/.test(token))
    throw new Error(
      "缺少分享凭据，仅会话 ID 不能观看。请打开宿主给出的完整链接。",
    );
  status.textContent = "点击授权并观看，使用链接中的凭据加入会话。";
} catch (error) {
  status.textContent = errorText(error);
  join.disabled = true;
}

function stop(message: string) {
  active = false;
  hostOnline = false;
  control?.stop();
  media?.stop();
  control = undefined;
  media = undefined;
  player.reset();
  join.disabled = false;
  leave.disabled = true;
  status.textContent = message;
}

function openMedia() {
  if (!active || !session || !token) return;
  media?.stop();
  player.reset();
  media = new ChannelConnection(
    new URL(location.origin),
    "media",
    () => ({
      v: 1,
      type: "auth",
      role: "viewer",
      session,
      token: token!,
      viewerId,
    }),
    () => {},
    (message) => {
      if (hostOnline) status.textContent = message;
    },
    () => {
      status.textContent = hostOnline
        ? "已授权，等待配置与关键帧…"
        : "宿主离线，等待恢复…";
    },
    (bytes) => {
      const packet = decodeMedia(bytes);
      if (packet.session !== session) throw new Error("视频属于其他会话。");
      player.push(packet);
    },
    () => player.reset(),
    (message) => stop(message),
  );
  media.start();
}

join.onclick = () => {
  void (async () => {
    join.disabled = true;
    status.textContent = "正在检查解码能力…";
    try {
      await checkDecoderSupport();
      if (!session || !token) throw new Error("分享凭据不完整。");
      active = true;
      leave.disabled = false;
      control = new ChannelConnection(
        new URL(location.origin),
        "control",
        () => ({
          v: 1,
          type: "auth",
          role: "viewer",
          session,
          token: token!,
          viewerId,
        }),
        (message) => {
          if (message.type === "ready")
            expiry.textContent = `分享到期：${new Date(message.expiresAt).toLocaleString()}`;
          else if (message.type === "state") {
            hostOnline = message.state === "online";
            if (message.state === "host-offline") {
              player.reset();
              status.textContent = "宿主离线，等待恢复；超时后会话结束。";
            } else if (message.state === "waiting-video") {
              player.reset();
              status.textContent = "宿主在线，等待视频连接与关键帧…";
            } else status.textContent = "宿主在线，正在等待可解码画面…";
          }
        },
        (message) => {
          status.textContent = message;
        },
        openMedia,
        undefined,
        () => {
          hostOnline = false;
          media?.stop();
          player.reset();
        },
        (message) => {
          if (session) sessionStorage.removeItem(`tango-viewer:${session}`);
          stop(message);
        },
      );
      control.start();
    } catch (error) {
      stop(`无法观看：${errorText(error)}`);
    }
  })();
};
leave.onclick = () => stop("已结束观看；未撤销宿主的分享。");
const stopStats = trackStats(
  element("stats", HTMLParagraphElement),
  player.stats,
);
const playbackStatus = setInterval(() => {
  if (active && hostOnline && player.stats.rendered > lastRendered)
    status.textContent = "远程播放中（只读）。";
  lastRendered = player.stats.rendered;
}, 1_000);
window.addEventListener(
  "pagehide",
  () => {
    stop("观看页面已关闭。");
    player.dispose();
    stopStats();
    clearInterval(playbackStatus);
  },
  { once: true },
);
