import { Adb, AdbDaemonTransport } from "@yume-chan/adb";
import AdbWebCredentialStore from "@yume-chan/adb-credential-web";
import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import {
  AdbScrcpyClient,
  AdbScrcpyExitedError,
  AdbScrcpyOptions2_1,
} from "@yume-chan/adb-scrcpy";
import {
  AndroidScreenPowerMode,
  ScrcpyCodecOptions,
  DefaultServerPath,
  h264ParseConfiguration,
  ScrcpyVideoCodecId,
  ScrcpyAudioCodec,
} from "@yume-chan/scrcpy";
import {
  AbortController,
  ReadableStream,
  WritableStream,
} from "@yume-chan/stream-extra";
import { checkDecoderSupport } from "../shared/player.js";
import { errorText } from "../shared/protocol.js";
import type { MediaPacket, RemoteInput } from "../shared/protocol.js";
import { DeviceInputController } from "./input.js";
import { UiTreeSession } from "./ui-tree.js";
import { AppLauncher } from "./app-launch.js";
import { parsePackageName } from "../shared/app-launch.js";
import type { AppLaunchResult } from "../shared/app-launch.js";
import type {
  LocalUiTreeSnapshot,
  LocalUiNodeActionRequest,
  UiNodeActionResult,
} from "../shared/ui-tree.js";
import type {
  LocalAudioPacket,
  LocalAudioStatus,
} from "../shared/audio-player.js";

export const VIDEO_SETTINGS = {
  maxSize: 1280,
  maxFps: 30,
  videoBitRate: 4_000_000,
};
const LOCAL_SESSION = "00000000000000000000000000000000";
const LOCAL_CONTROLLER = "local";
type DeviceClient = AdbScrcpyClient<AdbScrcpyOptions2_1<true>>;

export class DeviceSession {
  private adb?: Adb;
  private client?: DeviceClient;
  private restoreDisplay = false;
  private audioAbort?: AbortController;
  private uiTree?: UiTreeSession;
  private uiInputEpoch = 0;
  private appLauncher?: AppLauncher;
  private appLaunchPending = false;
  private input?: DeviceInputController;
  private inputController = LOCAL_CONTROLLER;
  private operation = false;
  private epoch = 0;
  private stream = 0;
  private sequence = 0;
  private closing = false;
  private rawDevice?: USBDevice;
  private readonly usbDisconnect = (event: USBConnectionEvent) => {
    if (event.device === this.rawDevice)
      void this.shutdown("设备已拔出，请重新连接。");
  };
  configuration?: MediaPacket;
  connected = false;
  playing = false;
  screenOff = false;
  audioEnabled = true;
  audioForwarding = false;

  constructor(
    private readonly onStatus: (message: string) => void,
    private readonly onPacket: (packet: MediaPacket) => void,
    private readonly onEnded: () => void,
    private readonly onAudio: (packet: LocalAudioPacket) => void = () => {},
    private readonly onAudioStatus: (
      status: LocalAudioStatus,
    ) => void = () => {},
  ) {
    navigator.usb?.addEventListener("disconnect", this.usbDisconnect);
  }

  async connect() {
    if (this.operation || this.connected) return;
    this.operation = true;
    this.closing = false;
    const epoch = ++this.epoch;
    try {
      const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
      if (!manager) throw new Error("WebUSB 不可用，请使用桌面 Chrome 118+。");
      this.onStatus("请选择 USB 手机，并在手机上允许 USB 调试。");
      // The chooser must run before any await that would consume the user gesture.
      const device = await manager.requestDevice();
      if (!device) {
        this.onStatus("已取消设备选择，可再次点击连接。");
        return;
      }
      if (epoch !== this.epoch) return;
      this.rawDevice = device.raw;
      await checkDecoderSupport();
      if (epoch !== this.epoch) return;
      this.onStatus(
        "正在打开 USB；如失败，请关闭占用设备的 ADB 程序并检查驱动。",
      );
      const connection = await device.connect();
      if (epoch !== this.epoch) {
        await device.raw.close();
        return;
      }
      try {
        this.onStatus("正在进行 ADB 授权，请查看手机上的确认弹窗…");
        const timeout = setTimeout(() => {
          this.onStatus(
            "ADB 授权超时，已关闭 USB；请解锁手机确认 USB 调试后重试。",
          );
          void device.raw
            .close()
            .catch((error: unknown) =>
              this.onStatus(`USB 关闭失败：${errorText(error)}`),
            );
        }, 60_000);
        let transport: AdbDaemonTransport;
        try {
          transport = await AdbDaemonTransport.authenticate({
            serial: device.serial,
            connection,
            credentialStore: new AdbWebCredentialStore("Tango Android Share"),
            readTimeLimit: 15_000,
          });
        } finally {
          clearTimeout(timeout);
        }
        if (epoch !== this.epoch) {
          await transport.close();
          return;
        }
        this.adb = new Adb(transport);
        this.connected = true;
        void transport.disconnected.then(
          () => {
            if (this.adb?.transport === transport && !this.closing)
              void this.shutdown("ADB 连接已断开，请重新连接设备。");
          },
          (error: unknown) => {
            if (this.adb?.transport === transport && !this.closing)
              void this.shutdown(
                `USB/ADB 异常：${errorText(error)}。请重新连接。`,
              );
          },
        );
      } catch (error) {
        await device.raw.close();
        throw error;
      }
    } catch (error) {
      await this.shutdown(
        `设备连接失败：${errorText(error)}。请检查授权、USB 驱动和设备占用后重试。`,
      );
      throw error;
    } finally {
      this.operation = false;
    }
    if (this.connected) await this.start();
  }

  async start() {
    if (this.operation || this.playing) return;
    const adb = this.adb;
    if (!adb) throw new Error("请先连接 USB 设备。");
    this.operation = true;
    this.closing = false;
    const epoch = ++this.epoch;
    let startupTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await checkDecoderSupport();
      startupTimer = setTimeout(() => {
        void this.shutdown(
          "scrcpy 启动超时，已断开设备；请检查手机并重新连接。",
        );
      }, 30_000);
      this.onStatus("正在推送随扩展打包的 scrcpy-server 2.1…");
      const response = await fetch(chrome.runtime.getURL("scrcpy-server.jar"));
      if (!response.ok)
        throw new Error(`服务端文件读取失败 (${response.status})`);
      const data = new Uint8Array(await response.arrayBuffer());
      await AdbScrcpyClient.pushServer(
        adb,
        new ReadableStream({
          start(controller) {
            controller.enqueue(data);
            controller.close();
          },
        }),
      );
      if (epoch !== this.epoch) return;
      this.onStatus("正在启动手机视频服务…");
      this.onAudioStatus({
        state: this.audioEnabled ? "starting" : "disabled",
        message: this.audioEnabled
          ? "正在启动本地媒体音频转发…"
          : "未开启音频转发；手机按原方式发声。",
      });
      const client = await AdbScrcpyClient.start(
        adb,
        DefaultServerPath,
        new AdbScrcpyOptions2_1({
          ...VIDEO_SETTINGS,
          video: true,
          audio: this.audioEnabled,
          audioSource: "output",
          audioCodec: "raw",
          control: true,
          stayAwake: true,
          cleanup: true,
          clipboardAutosync: false,
          videoCodec: "h264",
          videoCodecOptions: new ScrcpyCodecOptions({
            iFrameInterval: 1,
            maxBframes: 0,
            repeatPreviousFrameAfter: 100_000,
          }),
          sendFrameMeta: true,
          sendCodecMeta: true,
          sendDeviceMeta: true,
          tunnelForward: true,
        }),
      );
      if (epoch !== this.epoch) {
        const abort = new AbortController();
        abort.abort();
        void this.readAudio(client, epoch, abort);
        await client.close();
        return;
      }
      this.client = client;
      if (this.audioEnabled) {
        const abort = new AbortController();
        this.audioAbort = abort;
        void this.readAudio(client, epoch, abort);
      }
      if (!client.controller) throw new Error("设备没有提供 scrcpy 控制通道。");
      const input = new DeviceInputController(client.controller, () =>
        this.playing ? this.configuration : undefined,
      );
      this.input = input;
      this.inputController = LOCAL_CONTROLLER;
      await input.setController(LOCAL_CONTROLLER);
      input.onReleaseError = (error) => {
        if (this.input !== input) return;
        const message = `设备按键释放失败：${errorText(error)}，投屏已停止，请重新开始。`;
        void this.stop().then(
          () => this.onStatus(message),
          (closeError: unknown) =>
            this.onStatus(`${message}\n${errorText(closeError)}`),
        );
      };
      void client.output
        .pipeTo(
          new WritableStream<string>({
            write: (line) => {
              console.info("[scrcpy]", line);
            },
          }),
        )
        .catch((error: unknown) => {
          if (this.client === client && !this.closing)
            void this.shutdown(`scrcpy 日志通道异常：${errorText(error)}`);
        });
      const video = await client.videoStream;
      if (epoch !== this.epoch) {
        await video.stream.cancel();
        return;
      }
      if (video.metadata.codec !== ScrcpyVideoCodecId.H264)
        throw new Error("设备没有返回 H.264 视频。");
      if (this.screenOff) {
        await this.writeScreenPower(client, true);
        if (epoch !== this.epoch) return;
      }
      this.playing = true;
      this.onStatus(
        `本地投屏中：${video.metadata.deviceName ?? "Android"}；1280 / 30 fps / 4 Mbps。`,
      );
      void video.stream
        .pipeTo(
          new WritableStream({
            write: (packet) => {
              if (epoch !== this.epoch) return;
              if (packet.type === "configuration") {
                const info = h264ParseConfiguration(packet.data);
                this.configuration = {
                  session: LOCAL_SESSION,
                  stream: ++this.stream,
                  sequence: (this.sequence = 0),
                  kind: "configuration",
                  keyframe: false,
                  pts: 0n,
                  width: info.croppedWidth,
                  height: info.croppedHeight,
                  data: new Uint8Array(packet.data),
                };
                void this.releaseInputs().catch(input.onReleaseError);
                this.onPacket(this.configuration);
              } else {
                if (!this.configuration || packet.pts === undefined)
                  throw new Error("视频缺少配置或时间戳。");
                this.onPacket({
                  ...this.configuration,
                  kind: "data",
                  keyframe: packet.keyframe === true,
                  pts: packet.pts,
                  sequence: ++this.sequence,
                  data: packet.data,
                });
              }
            },
          }),
        )
        .then(
          () => {
            if (this.client === client && !this.closing)
              void this.shutdown("视频服务已结束，请重新连接或开始投屏。");
          },
          (error: unknown) => {
            if (this.client === client && !this.closing)
              void this.shutdown(
                `视频通道异常：${errorText(error)}。请重新连接。`,
              );
          },
        );
    } catch (error) {
      const detail =
        error instanceof AdbScrcpyExitedError
          ? error.output.join("\n")
          : errorText(error);
      await this.stop();
      this.onStatus(`投屏启动失败：${detail}。可点击开始投屏重试。`);
      throw error;
    } finally {
      if (startupTimer) clearTimeout(startupTimer);
      this.operation = false;
    }
  }

  async restartVideo() {
    if (this.operation || !this.playing) return;
    await this.stop(true);
    this.onStatus("正在重建编码流，为观看者提供新的配置与关键帧…");
    await this.start();
  }

  private async readAudio(
    client: DeviceClient,
    epoch: number,
    abort: AbortController,
  ) {
    try {
      const audio = await client.audioStream;
      if (abort.signal.aborted) {
        if (audio?.type === "success") await audio.stream.cancel();
        return;
      }
      if (!audio || audio.type !== "success") {
        if (epoch === this.epoch)
          this.onAudioStatus({
            state: "unavailable",
            message:
              "音频不可用，视频继续。需要 Android 11+；Android 11 启动采集前请先解锁手机。",
          });
        return;
      }
      const supported = audio.codec === ScrcpyAudioCodec.Raw;
      if (epoch === this.epoch) {
        this.audioForwarding = supported;
        this.onAudioStatus({
          state: supported ? "forwarding" : "unavailable",
          message: supported
            ? "媒体声音已转发至本地网页，手机不再外放被转发的媒体声；电话、通知和闹钟不受影响。"
            : "设备未返回所需 PCM 音频；仅播放视频。",
        });
      }
      let valid = supported;
      await audio.stream.pipeTo(
        new WritableStream({
          write: (packet) => {
            if (epoch !== this.epoch || !valid) return;
            if (packet.type !== "data" || packet.pts === undefined) {
              valid = false;
              this.audioForwarding = false;
              this.onAudioStatus({
                state: "unavailable",
                message:
                  "音频缺少数据帧或时间戳；视频继续。请停止后重新开始投屏。",
              });
              return;
            }
            this.onAudio({ stream: epoch, pts: packet.pts, data: packet.data });
          },
        }),
        { signal: abort.signal },
      );
      if (epoch === this.epoch && !abort.signal.aborted) {
        this.audioForwarding = false;
        this.onAudioStatus({
          state: "unavailable",
          message: "手机音频流已结束；视频继续。可停止后重新开始投屏。",
        });
      }
    } catch (error) {
      if (epoch !== this.epoch || abort.signal.aborted) return;
      this.audioForwarding = false;
      this.onAudioStatus({
        state: "unavailable",
        message: `音频通道失败：${errorText(error)}；视频继续。`,
      });
    }
  }

  async setRemoteController(id: string | null) {
    if (id && (!this.playing || !this.input))
      throw new Error("设备控制通道不可用。");
    if (!id && this.inputController === LOCAL_CONTROLLER) return;
    this.inputController = id ?? LOCAL_CONTROLLER;
    await this.input?.setController(this.inputController);
  }

  async localInput(event: RemoteInput, stream: number) {
    const input = this.input;
    if (!this.playing || !input) throw new Error("设备未在投屏。");
    if (event.kind === "release" && this.inputController !== LOCAL_CONTROLLER)
      return;
    if (event.kind !== "release") this.invalidateUiActions();
    let release: Promise<void> | undefined;
    if (this.inputController !== LOCAL_CONTROLLER) {
      this.inputController = LOCAL_CONTROLLER;
      release = input.setController(LOCAL_CONTROLLER);
    }
    const write = input.write(LOCAL_CONTROLLER, event, stream);
    await Promise.all([release, write]);
  }

  async releaseInputs() {
    await this.input?.setController(this.inputController);
  }

  async getUiTree(): Promise<LocalUiTreeSnapshot> {
    if (this.appLaunchPending)
      throw new Error("应用正在启动，请等待结束后重新读取 UI tree。");
    const adb = this.adb;
    const stream = this.configuration?.stream;
    if (!adb || !this.playing || !stream)
      throw new Error("请先开始投屏并等待画面，再读取 UI tree。");
    const session = (this.uiTree ??= UiTreeSession.forAdb(adb));
    const revision = this.uiInputEpoch;
    try {
      const snapshot = await session.capture();
      if (
        this.adb !== adb ||
        !this.playing ||
        this.configuration?.stream !== stream
      ) {
        session.invalidate();
        throw new Error("读取期间画面已改变，请重新获取 UI tree。");
      }
      if (revision !== this.uiInputEpoch || this.uiTree !== session) {
        session.invalidate();
        throw new Error(
          "读取期间发生了其他输入或 helper 已改变，请重新获取 UI tree。",
        );
      }
      return { ...snapshot, stream };
    } catch (error) {
      return this.uiTreeFailure(session, error);
    }
  }

  async performUiAction(
    value: LocalUiNodeActionRequest,
  ): Promise<UiNodeActionResult> {
    const session = this.uiTree;
    const input = this.input;
    const stream = this.configuration?.stream;
    if (
      !this.playing ||
      !input ||
      !session ||
      !stream ||
      value.stream !== stream
    )
      throw new Error("节点动作对应的设备或画面已失效，请重新读取 UI tree。");
    const request = session.validateAction(value);
    const revision = this.uiInputEpoch;
    try {
      if (this.inputController !== LOCAL_CONTROLLER) {
        this.inputController = LOCAL_CONTROLLER;
        await input.setController(LOCAL_CONTROLLER);
      }
      return await input.execute(LOCAL_CONTROLLER, stream, async () => {
        if (
          this.uiTree !== session ||
          this.input !== input ||
          revision !== this.uiInputEpoch
        )
          throw new Error("节点动作已取消：设备或输入状态已改变，请重新读取。");
        ++this.uiInputEpoch;
        const result = await session.performAction(request);
        if (
          !this.playing ||
          this.configuration?.stream !== stream ||
          this.uiTree !== session
        )
          throw new Error("节点动作期间会话已改变，结果未知，请重新读取确认。");
        return result;
      });
    } catch (error) {
      return this.uiTreeFailure(session, error);
    }
  }

  private invalidateUiActions() {
    ++this.uiInputEpoch;
    this.uiTree?.invalidate();
  }

  async launchApp(value: string): Promise<AppLaunchResult> {
    const packageName = parsePackageName(value);
    const adb = this.adb;
    const input = this.input;
    const stream = this.configuration?.stream;
    if (!adb || !input || !this.playing || !stream)
      throw new Error("请先开始投屏并等待画面，再启动应用。");
    if (this.appLaunchPending) throw new Error("已有应用启动请求正在进行。");
    this.appLaunchPending = true;
    try {
      if (this.inputController !== LOCAL_CONTROLLER) {
        this.inputController = LOCAL_CONTROLLER;
        await input.setController(LOCAL_CONTROLLER);
      }
      return await input.execute(LOCAL_CONTROLLER, stream, async () => {
        if (this.adb !== adb || this.input !== input)
          throw new Error("设备会话已改变，未启动应用。");
        this.invalidateUiActions();
        const launcher = (this.appLauncher ??= AppLauncher.forAdb(adb));
        try {
          const result = await launcher.launch(packageName);
          if (this.adb !== adb || this.input !== input || !this.playing)
            throw new Error(
              "应用启动期间设备或画面已改变，结果可能未知，请确认当前页面。",
            );
          return result;
        } finally {
          this.invalidateUiActions();
        }
      });
    } finally {
      this.appLaunchPending = false;
    }
  }

  private async uiTreeFailure(
    session: UiTreeSession,
    error: unknown,
  ): Promise<never> {
    if (!session.usable) {
      if (this.uiTree === session) this.uiTree = undefined;
      try {
        await session.close();
      } catch (cleanupError) {
        throw new Error(
          `${errorText(error)}\nUI helper 关闭失败：${errorText(cleanupError)}`,
        );
      }
    }
    throw error;
  }

  get uiTreeActive() {
    return !!this.uiTree?.usable;
  }

  async stopUiTree() {
    const session = this.uiTree;
    this.uiTree = undefined;
    await session?.close();
  }

  async remoteInput(id: string, event: RemoteInput, stream: number) {
    if (!this.playing || !this.input) throw new Error("设备未在投屏。");
    if (event.kind !== "release") this.invalidateUiActions();
    await this.input.write(id, event, stream);
  }

  async setScreenOff(off: boolean) {
    const client = this.client;
    if (!this.playing || !client)
      throw new Error("请先开始投屏，再切换手机屏幕显示。");
    await this.writeScreenPower(client, off);
    if (this.client !== client) return;
    this.onStatus(
      off
        ? "已发送手机息屏请求；投屏和已授权的浏览器控制继续。"
        : "已发送恢复手机屏幕显示请求；不会绕过手机锁屏。",
    );
  }

  private async writeScreenPower(client: DeviceClient, off: boolean) {
    if (!client.controller) throw new Error("设备没有提供屏幕控制通道。");
    // A failed/pending OFF write may still reach Android; restore before teardown.
    if (off) this.restoreDisplay = true;
    await client.controller.setScreenPowerMode(
      off ? AndroidScreenPowerMode.Off : AndroidScreenPowerMode.Normal,
    );
    if (this.client !== client) return;
    this.screenOff = off;
    this.restoreDisplay = off;
  }

  async stop(preserveShare = false) {
    this.appLauncher?.cancel();
    this.invalidateUiActions();
    this.closing = true;
    ++this.epoch;
    this.playing = false;
    this.audioForwarding = false;
    const audioAbort = this.audioAbort;
    this.audioAbort = undefined;
    this.onAudioStatus({
      state: "stopped",
      message: "音频转发已停止；设备采集退出后手机恢复原有媒体输出。",
    });
    this.configuration = undefined;
    const client = this.client;
    this.client = undefined;
    const restoreDisplay = this.restoreDisplay;
    this.restoreDisplay = false;
    if (!preserveShare) this.screenOff = false;
    const input = this.input;
    this.input = undefined;
    if (!preserveShare) this.onEnded();
    const failures: string[] = [];
    const uiCleanup = preserveShare
      ? Promise.resolve()
      : this.stopUiTree().catch((error: unknown) => {
          failures.push(`UI helper 关闭失败：${errorText(error)}`);
        });
    if (client) {
      try {
        await input?.setController(null);
      } catch (error) {
        failures.push(`输入释放失败：${errorText(error)}`);
      }
      if (restoreDisplay && client.controller) {
        try {
          await client.controller.setScreenPowerMode(
            AndroidScreenPowerMode.Normal,
          );
        } catch (error) {
          failures.push(`恢复手机屏幕显示失败：${errorText(error)}`);
        }
      }
      try {
        await client.close();
      } catch (error) {
        failures.push(`scrcpy 关闭失败：${errorText(error)}`);
      } finally {
        audioAbort?.abort();
      }
    } else audioAbort?.abort();
    await uiCleanup;
    if (failures.length) {
      const error = new Error(failures.join("\n"));
      this.onStatus(
        `视频服务关闭失败：${errorText(error)}；请断开设备后重试。`,
      );
      throw error;
    }
    this.closing = false;
    this.onStatus(
      this.connected ? "本地投屏已停止，可以再次开始。" : "设备未连接。",
    );
  }

  async disconnect() {
    await this.shutdown("设备已断开，可以重新连接。");
  }

  private async shutdown(message: string) {
    this.closing = true;
    const adb = this.adb;
    this.adb = undefined;
    this.appLauncher?.cancel();
    this.appLauncher = undefined;
    this.connected = false;
    const cleanupErrors: string[] = [];
    try {
      await this.stop();
    } catch (error) {
      console.error("scrcpy cleanup failed:", error);
      cleanupErrors.push(`视频服务释放失败：${errorText(error)}`);
    } finally {
      try {
        await adb?.close();
      } catch (error) {
        cleanupErrors.push(`ADB 释放失败：${errorText(error)}`);
        console.error("ADB cleanup failed:", error);
      }
      try {
        if (this.rawDevice?.opened) await this.rawDevice.close();
      } catch (error) {
        cleanupErrors.push(
          `设备资源释放失败：${errorText(error)}。请拔插手机后重试。`,
        );
        console.error("USB cleanup failed:", error);
      }
      this.rawDevice = undefined;
      this.onStatus([message, ...cleanupErrors].join("\n"));
    }
  }

  dispose() {
    navigator.usb?.removeEventListener("disconnect", this.usbDisconnect);
    void this.disconnect();
  }
}
