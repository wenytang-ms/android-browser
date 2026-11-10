import { DeviceSession } from "./device.js";
import { HostShare } from "./share.js";
import { VideoPlayer } from "../shared/player.js";
import { element, trackStats } from "../shared/ui.js";
import { errorText, relayUrl } from "../shared/protocol.js";
import { login, logout } from "../shared/auth.js";
import { CanvasInput } from "../shared/input.js";
import { AudioPlayer } from "../shared/audio-player.js";
import type { LocalAudioStatus } from "../shared/audio-player.js";
import "../shared/style.css";

const buttons = {
  connect: element("connect", HTMLButtonElement),
  start: element("start", HTMLButtonElement),
  stop: element("stop", HTMLButtonElement),
  disconnect: element("disconnect", HTMLButtonElement),
  screenOff: element("screen-off", HTMLButtonElement),
  screenOn: element("screen-on", HTMLButtonElement),
  audio: element("audio-toggle", HTMLButtonElement),
  share: element("share", HTMLButtonElement),
  unshare: element("unshare", HTMLButtonElement),
};
const deviceStatus = element("device-status", HTMLParagraphElement);
const screenStatus = element("screen-status", HTMLParagraphElement);
const audioStatus = element("audio-status", HTMLParagraphElement);
const audioForward = element("audio-forward", HTMLInputElement);
const shareStatus = element("share-status", HTMLParagraphElement);
const relay = element("relay", HTMLInputElement);
const deploymentToken = element("deployment-token", HTMLInputElement);
const link = element("link", HTMLInputElement);
const canvas = element("screen", HTMLCanvasElement);
const localControls = element("local-controls", HTMLFieldSetElement);
const localText = element("local-text", HTMLTextAreaElement);
const remoteControl = element("remote-control", HTMLInputElement);
let busy = false;
let shareBusy = false;
let localStream = 0;
let localConfigurationStream = 0;
let audioError = "";
let audioState: LocalAudioStatus = {
  state: "stopped",
  message: "连接后可在本地网页播放手机媒体声音。",
};
const audioPlayer = new AudioPlayer((message) => {
  audioError = message;
  updateAudio();
}, updateAudio);
const localInput = new CanvasInput(canvas, (event) => {
  const stream = localStream;
  if (!stream) return;
  if (event.kind !== "release") share.setRemoteControlEnabled(false);
  void device.localInput(event, stream).catch((error: unknown) => {
    if (!device.playing || stream !== localStream) return;
    const message = `本地输入失败：${errorText(error)}；请重新开始投屏。`;
    stopForInputError(message);
  });
});
const share = new HostShare(
  (message) => {
    shareStatus.textContent = message;
  },
  update,
  () => {
    void deviceAction(() => device.restartVideo());
  },
  (id) => {
    if (id) localInput.setEnabled(false, false);
    void device.setRemoteController(id).catch((error: unknown) => {
      shareStatus.textContent = `控制通道失败：${errorText(error)}；已停止远程控制。`;
      if (device.playing) void deviceAction(() => device.stop());
      void share.stop().catch((stopError: unknown) => {
        shareStatus.textContent = `撤销失败：${errorText(stopError)}`;
      });
      update();
    });
    update();
  },
  (message, stream) =>
    device.remoteInput(message.controlId, message.event, stream),
);
const player = new VideoPlayer(
  canvas,
  (message) => {
    deviceStatus.textContent = message;
    void device.stop().then(
      () => {
        deviceStatus.textContent = message;
      },
      (error: unknown) => {
        deviceStatus.textContent = `${message}\n关闭失败：${errorText(error)}`;
      },
    );
  },
  undefined,
  (stream) => {
    if (stream !== localConfigurationStream || stream === localStream) return;
    localStream = stream;
    update();
  },
);
const device = new DeviceSession(
  (message) => {
    deviceStatus.textContent = message;
    update();
  },
  (packet) => {
    if (packet.kind === "configuration") {
      pauseLocalInput();
      localConfigurationStream = packet.stream;
    }
    player.push(packet);
    share.push(packet);
  },
  () => {
    pauseLocalInput();
    player.reset();
    audioPlayer.close();
    void share.stop().catch((error: unknown) => {
      shareStatus.textContent = `分享结束失败：${errorText(error)}`;
    });
    update();
  },
  (packet) => audioPlayer.push(packet),
  (status) => {
    audioState = status;
    if (status.state !== "forwarding") audioPlayer.reset();
    if (status.state === "unavailable" || status.state === "disabled")
      audioPlayer.close();
    updateAudio();
  },
);

function update() {
  buttons.connect.disabled = busy || device.connected;
  buttons.start.disabled = busy || !device.connected || device.playing;
  buttons.stop.disabled = busy || !device.playing;
  buttons.disconnect.disabled = busy || !device.connected;
  buttons.screenOff.disabled = busy || !device.playing;
  buttons.screenOn.disabled = busy || !device.playing;
  screenStatus.textContent = !device.playing
    ? "开始投屏后可关闭手机实体屏幕。"
    : device.screenOff
      ? "已请求息屏：浏览器画面与控制继续。"
      : "未请求息屏／已请求恢复显示。";
  buttons.share.disabled = shareBusy || busy || !device.playing || share.active;
  buttons.unshare.disabled = shareBusy || !share.active;
  relay.disabled = share.active;
  deploymentToken.disabled = share.active;
  remoteControl.disabled = !share.active || shareBusy;
  remoteControl.checked = share.remoteControlEnabled;
  const localEnabled = device.playing && !!localStream && !busy;
  localControls.disabled = !localEnabled;
  localInput.setEnabled(localEnabled);
  element("share-link", HTMLDivElement).hidden = !share.link;
  link.value = share.link;
  element("expiry", HTMLParagraphElement).textContent = share.link
    ? `到期：${new Date(share.expiresAt).toLocaleString()}`
    : "";
  updateAudio();
}

function updateAudio() {
  audioForward.disabled = busy || device.playing;
  buttons.audio.disabled = busy || !device.playing || !device.audioForwarding;
  buttons.audio.textContent = audioPlayer.active ? "网页静音" : "启用网页声音";
  const playback =
    audioError ||
    (audioState.state === "forwarding"
      ? audioPlayer.active
        ? "网页正在播放手机媒体声音（仅本地）。"
        : audioPlayer.muted
          ? "网页已静音；手机媒体声仍在转发。"
          : "请点击“启用网页声音”；手机媒体声仍在转发。"
      : "");
  audioStatus.textContent = `${audioState.message}${playback ? `\n${playback}` : ""}`;
}

function audioFailure(error: unknown) {
  audioError = `网页声音未能启用：${errorText(error)}。可点击启用声音重试，或停止投屏恢复手机发声。`;
  updateAudio();
}

function prepareAudio() {
  device.audioEnabled = audioForward.checked;
  audioError = "";
  if (device.audioEnabled) void audioPlayer.resume().catch(audioFailure);
}

function pauseLocalInput() {
  localInput.setEnabled(false, false);
  localControls.disabled = true;
  localStream = 0;
  localConfigurationStream = 0;
}

function stopForInputError(message: string) {
  void deviceAction(async () => {
    try {
      await device.stop();
    } finally {
      deviceStatus.textContent = message;
    }
  });
}

async function deviceAction(action: () => Promise<void>) {
  busy = true;
  update();
  try {
    await action();
  } catch (error) {
    deviceStatus.textContent = `${deviceStatus.textContent}\n${errorText(error)}`;
  } finally {
    busy = false;
    if (!device.playing) audioPlayer.close();
    update();
  }
}

buttons.connect.onclick = () => {
  prepareAudio();
  void deviceAction(() => device.connect());
};
buttons.start.onclick = () => {
  prepareAudio();
  void deviceAction(() => device.start());
};
buttons.stop.onclick = () => {
  void deviceAction(() => device.stop());
};
buttons.disconnect.onclick = () => {
  void deviceAction(() => device.disconnect());
};
buttons.screenOff.onclick = () => {
  void deviceAction(() => device.setScreenOff(true));
};
buttons.screenOn.onclick = () => {
  void deviceAction(() => device.setScreenOff(false));
};
buttons.audio.onclick = () => {
  if (audioPlayer.active) audioPlayer.mute();
  else {
    audioError = "";
    void audioPlayer.enable().catch(audioFailure);
  }
};
buttons.share.onclick = () => {
  void (async () => {
    shareBusy = true;
    update();
    try {
      const base = relayUrl(relay.value.trim());
      shareStatus.textContent =
        "请登录 Google；开启共享将授权同账号远端观看和控制手机。";
      const account = await login(base, true);
      try {
        await chrome.storage.local.set({ relay: base.origin });
        await share.start(
          base,
          deploymentToken.value,
          account.accountToken,
          device.configuration,
        );
      } catch (error) {
        try {
          await logout(base, account.accountToken);
        } catch (cleanupError) {
          throw new Error(`${errorText(error)}\n${errorText(cleanupError)}`);
        }
        throw error;
      }
    } catch (error) {
      shareStatus.textContent = `分享失败：${errorText(error)}`;
    } finally {
      shareBusy = false;
      update();
    }
  })();
};
buttons.unshare.onclick = () => {
  void share.stop().catch((error: unknown) => {
    shareStatus.textContent = `撤销失败：${errorText(error)}`;
  });
};
remoteControl.onchange = () => {
  if (remoteControl.checked) {
    localInput.setEnabled(false, false);
    void device.releaseInputs().catch((error: unknown) => {
      stopForInputError(`输入释放失败：${errorText(error)}；请重新开始投屏。`);
    });
  }
  share.setRemoteControlEnabled(remoteControl.checked);
  update();
};
for (const [id, key] of [
  ["local-back", 4],
  ["local-home", 3],
  ["local-apps", 187],
] as const)
  element(id, HTMLButtonElement).onclick = () => localInput.press(key);
element("local-send-text", HTMLButtonElement).onclick = () => {
  try {
    localInput.text(localText.value);
    localText.value = "";
  } catch (error) {
    deviceStatus.textContent = `文本发送失败：${errorText(error)}`;
  }
};
element("copy", HTMLButtonElement).onclick = () => {
  void navigator.clipboard.writeText(share.link).then(
    () => {
      shareStatus.textContent = "已复制分享链接。";
    },
    (error: unknown) => {
      link.select();
      shareStatus.textContent = `复制失败：${errorText(error)}。请手动复制已选中的链接。`;
    },
  );
};
void chrome.storage.local.get("relay").then(
  (saved) => {
    if (typeof saved.relay === "string") relay.value = saved.relay;
  },
  (error: unknown) => {
    shareStatus.textContent = `中继设置读取失败：${errorText(error)}。请手动填写地址。`;
  },
);
const stopStats = trackStats(
  element("stats", HTMLParagraphElement),
  player.stats,
  () => ` | 上行队列 ${share.bufferedBytes} B | 上行恢复 ${share.recoveries}`,
);
window.addEventListener(
  "pagehide",
  () => {
    stopStats();
    localInput.setEnabled(false, false);
    localInput.dispose();
    share.dispose();
    player.dispose();
    audioPlayer.dispose();
    device.dispose();
  },
  { once: true },
);
if (!navigator.usb || typeof VideoDecoder === "undefined") {
  deviceStatus.textContent =
    "当前浏览器缺少 WebUSB 或 WebCodecs，请使用桌面 Chrome 118+。";
  buttons.connect.disabled = true;
}
