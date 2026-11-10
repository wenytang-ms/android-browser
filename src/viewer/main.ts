import { ChannelConnection } from "../shared/connection.js";
import { hasLoginResult, login, logout } from "../shared/auth.js";
import { checkDecoderSupport, VideoPlayer } from "../shared/player.js";
import { decodeMedia, errorText, isSessionId } from "../shared/protocol.js";
import type { RemoteInput } from "../shared/protocol.js";
import { element, trackStats } from "../shared/ui.js";
import { CanvasInput } from "../shared/input.js";
import "../shared/style.css";

const base = new URL(location.origin);
const join = element("join", HTMLButtonElement);
const leave = element("leave", HTMLButtonElement);
const status = element("status", HTMLParagraphElement);
const expiry = element("expiry", HTMLParagraphElement);
const session = new URL(location.href).searchParams.get("session");
const canvas = element("screen", HTMLCanvasElement);
const text = element("input-text", HTMLTextAreaElement);
const controls = element("controls", HTMLFieldSetElement);
const viewerId = crypto.randomUUID().replaceAll("-", "");
let accountToken = "";
let controlId: string | null = null;
let sequence = 0;
let displayedStream = 0;
let configurationStream = 0;
let control: ChannelConnection | undefined;
let media: ChannelConnection | undefined;
let active = false;
let epoch = 0;
let lastResync = 0;
let lastRendered = 0;
let hostOnline = false;
let remoteControlEnabled = true;
const input = new CanvasInput(canvas, sendInput);
const player = new VideoPlayer(
  canvas,
  stop,
  () => {
    pauseInput();
    if (Date.now() - lastResync > 1_000) {
      lastResync = Date.now();
      control?.send({ v: 1, type: "resync" });
      status.textContent = "视频积压或序列中断，等待配置与关键帧恢复…";
    }
  },
  (stream) => {
    if (stream !== configurationStream) return;
    displayedStream = stream;
    const enabled =
      active &&
      hostOnline &&
      remoteControlEnabled &&
      !!controlId &&
      !!control?.ready;
    input.setEnabled(enabled);
    controls.disabled = !enabled;
  },
);

history.replaceState(null, "", `${location.pathname}${location.search}`);
if (!isSessionId(session)) {
  status.textContent = "分享链接缺少有效会话 ID。";
  join.disabled = true;
} else
  status.textContent =
    "请登录创建分享的同一 Google 账号；登录后可观看和控制手机。";

function pauseInput() {
  input.setEnabled(false, false);
  displayedStream = 0;
  configurationStream = 0;
  controls.disabled = true;
}

function sendInput(event: RemoteInput) {
  if (
    !active ||
    !hostOnline ||
    !remoteControlEnabled ||
    !controlId ||
    !displayedStream ||
    !control?.ready
  )
    return;
  if (
    !control.send({
      v: 1,
      type: "input",
      controlId,
      stream: displayedStream,
      sequence: ++sequence,
      event,
    })
  )
    stop("控制连接已中断，请重新加入。");
}

function stop(message: string) {
  input.setEnabled(false);
  ++epoch;
  active = false;
  hostOnline = false;
  controlId = null;
  pauseInput();
  control?.stop();
  media?.stop();
  control = undefined;
  media = undefined;
  player.reset();
  join.disabled = !isSessionId(session);
  leave.disabled = true;
  status.textContent = message;
  const token = accountToken;
  accountToken = "";
  if (token)
    void logout(base, token).catch((error: unknown) => {
      status.textContent = `${message}\n${errorText(error)}`;
    });
}

function openMedia() {
  if (!active || !session || !accountToken) return;
  pauseInput();
  media?.stop();
  player.reset();
  media = new ChannelConnection(
    base,
    "media",
    () => ({
      v: 1,
      type: "auth",
      role: "viewer",
      session,
      accountToken,
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
      if (packet.kind === "configuration") {
        pauseInput();
        configurationStream = packet.stream;
      }
      player.push(packet);
    },
    () => {
      pauseInput();
      player.reset();
    },
    stop,
  );
  media.start();
}

join.onclick = () => {
  void (async () => {
    join.disabled = true;
    leave.disabled = false;
    const operation = ++epoch;
    status.textContent = "请登录创建分享的同一 Google 账号…";
    try {
      const account = await login(base);
      if (operation !== epoch) {
        await logout(base, account.accountToken);
        return;
      }
      accountToken = account.accountToken;
      await checkDecoderSupport();
      if (!session) throw new Error("分享会话不完整。");
      active = true;
      control = new ChannelConnection(
        base,
        "control",
        () => ({
          v: 1,
          type: "auth",
          role: "viewer",
          session,
          accountToken,
          viewerId,
        }),
        (message) => {
          if (message.type === "ready") {
            expiry.textContent = `分享到期：${new Date(message.expiresAt).toLocaleString()}`;
          } else if (message.type === "controller") {
            if (message.controlId === controlId) return;
            pauseInput();
            controlId = message.controlId;
            sequence = 0;
          } else if (message.type === "control-permission") {
            remoteControlEnabled = message.enabled;
            if (!message.enabled) {
              input.setEnabled(false, false);
              controls.disabled = true;
              status.textContent = "宿主本地已接管；远端只读，画面继续播放。";
            }
          } else if (message.type === "state") {
            hostOnline = message.state === "online";
            if (!hostOnline) {
              pauseInput();
              player.reset();
              status.textContent =
                message.state === "host-offline"
                  ? "宿主离线，输入已禁用；等待恢复。"
                  : "宿主在线，等待视频连接与关键帧…";
            } else status.textContent = "同账号授权成功，等待画面…";
          }
        },
        (message) => {
          status.textContent = message;
        },
        openMedia,
        undefined,
        () => {
          hostOnline = false;
          controlId = null;
          pauseInput();
          media?.stop();
          player.reset();
        },
        stop,
      );
      control.start();
    } catch (error) {
      stop(`无法加入：${errorText(error)}`);
    }
  })();
};
if (isSessionId(session) && hasLoginResult()) join.click();
leave.onclick = () => stop("已退出并注销本次登录；未撤销宿主共享。");
for (const [id, key] of [
  ["back", 4],
  ["home", 3],
  ["apps", 187],
] as const)
  element(id, HTMLButtonElement).onclick = () => input.press(key);
element("send-text", HTMLButtonElement).onclick = () => {
  try {
    input.text(text.value);
    text.value = "";
  } catch (error) {
    status.textContent = `文本发送失败：${errorText(error)}`;
  }
};
const stopStats = trackStats(
  element("stats", HTMLParagraphElement),
  player.stats,
);
const playbackStatus = setInterval(() => {
  if (active && hostOnline && player.stats.rendered > lastRendered)
    status.textContent =
      remoteControlEnabled && controlId
        ? "远程播放中（同账号，可控制）。点击画面使用键盘；拖动可滑动。"
        : "远程播放中（只读，宿主本地已接管）。";
  lastRendered = player.stats.rendered;
}, 1_000);
window.addEventListener(
  "pagehide",
  () => {
    stop("远程页面已关闭。");
    input.dispose();
    player.dispose();
    stopStats();
    clearInterval(playbackStatus);
  },
  { once: true },
);
