import { DeviceSession } from "./device.js";
import { HostShare } from "./share.js";
import { VideoPlayer } from "../shared/player.js";
import { element, trackStats } from "../shared/ui.js";
import { errorText, relayUrl } from "../shared/protocol.js";
import "../shared/style.css";

const buttons = {
  connect: element("connect", HTMLButtonElement),
  start: element("start", HTMLButtonElement),
  stop: element("stop", HTMLButtonElement),
  disconnect: element("disconnect", HTMLButtonElement),
  share: element("share", HTMLButtonElement),
  unshare: element("unshare", HTMLButtonElement),
};
const deviceStatus = element("device-status", HTMLParagraphElement);
const shareStatus = element("share-status", HTMLParagraphElement);
const relay = element("relay", HTMLInputElement);
const deploymentToken = element("deployment-token", HTMLInputElement);
const link = element("link", HTMLInputElement);
let busy = false;
let shareBusy = false;
const share = new HostShare(
  (message) => {
    shareStatus.textContent = message;
  },
  update,
  () => {
    void deviceAction(() => device.restartVideo());
  },
);
const player = new VideoPlayer(
  element("screen", HTMLCanvasElement),
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
);
const device = new DeviceSession(
  (message) => {
    deviceStatus.textContent = message;
    update();
  },
  (packet) => {
    player.push(packet);
    share.push(packet);
  },
  () => {
    player.reset();
    void share.stop().catch((error: unknown) => {
      shareStatus.textContent = `分享结束失败：${errorText(error)}`;
    });
    update();
  },
);

function update() {
  buttons.connect.disabled = busy || device.connected;
  buttons.start.disabled = busy || !device.connected || device.playing;
  buttons.stop.disabled = busy || !device.playing;
  buttons.disconnect.disabled = busy || !device.connected;
  buttons.share.disabled = shareBusy || busy || !device.playing || share.active;
  buttons.unshare.disabled = shareBusy || !share.active;
  relay.disabled = share.active;
  deploymentToken.disabled = share.active;
  element("share-link", HTMLDivElement).hidden = !share.link;
  link.value = share.link;
  element("expiry", HTMLParagraphElement).textContent = share.link
    ? `到期：${new Date(share.expiresAt).toLocaleString()}`
    : "";
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
    update();
  }
}

buttons.connect.onclick = () => {
  void deviceAction(() => device.connect());
};
buttons.start.onclick = () => {
  void deviceAction(() => device.start());
};
buttons.stop.onclick = () => {
  void deviceAction(() => device.stop());
};
buttons.disconnect.onclick = () => {
  void deviceAction(() => device.disconnect());
};
buttons.share.onclick = () => {
  void (async () => {
    shareBusy = true;
    update();
    try {
      const base = relayUrl(relay.value.trim());
      await chrome.storage.local.set({ relay: base.origin });
      await share.start(base, deploymentToken.value, device.configuration);
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
    share.dispose();
    player.dispose();
    device.dispose();
  },
  { once: true },
);
if (!navigator.usb || typeof VideoDecoder === "undefined") {
  deviceStatus.textContent =
    "当前浏览器缺少 WebUSB 或 WebCodecs，请使用桌面 Chrome 118+。";
  buttons.connect.disabled = true;
}
