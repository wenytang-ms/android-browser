import type { MediaPacket, RemoteInput } from "../src/shared/protocol.js";
import type {
  LocalAudioPacket,
  LocalAudioStatus,
} from "../src/shared/audio-player.js";
import { parseUiTree, parseUiNodeAction } from "../src/shared/ui-tree.js";
import type {
  LocalUiTreeSnapshot,
  LocalUiNodeActionRequest,
  UiNodeActionRequest,
  UiNodeActionResult,
} from "../src/shared/ui-tree.js";
import { uiTreeFixture } from "./ui-tree-fixture.js";
import { parsePackageName } from "../src/shared/app-launch.js";
import type { AppLaunchResult } from "../src/shared/app-launch.js";

const fixture: {
  configuration: number[];
  frame: number[];
  inputs: { source: "local" | "remote"; event: RemoteInput }[];
  screenPowerRequests: boolean[];
  failScreenPower: boolean;
  audioAvailable: boolean;
  audioPackets: number;
  uiCaptures: number;
  uiStops: number;
  failUiTree: boolean;
  uiActions: UiNodeActionRequest[];
  failUiAction: boolean;
  uiExpiryMs: number;
  appLaunches: string[];
  failAppLaunch: boolean;
  holdAppLaunch: boolean;
  completeAppLaunch?: () => void;
} = {
  configuration: [],
  frame: [],
  inputs: [],
  screenPowerRequests: [],
  failScreenPower: false,
  audioAvailable: true,
  audioPackets: 0,
  uiCaptures: 0,
  uiStops: 0,
  failUiTree: false,
  uiActions: [],
  failUiAction: false,
  uiExpiryMs: 30_000,
  appLaunches: [],
  failAppLaunch: false,
  holdAppLaunch: false,
};
Object.defineProperty(globalThis, "tangoFixture", { value: fixture });

// Only the browser-smoke test build substitutes this synthetic USB boundary.
export class DeviceSession {
  configuration?: MediaPacket;
  connected = false;
  playing = false;
  screenOff = false;
  audioEnabled = true;
  audioForwarding = false;
  private stream = 0;
  private sequence = 0;
  private timer?: ReturnType<typeof setInterval>;
  private audioTimer?: ReturnType<typeof setInterval>;
  private controller: string | null = null;
  uiTreeActive = false;
  private uiSnapshot?: LocalUiTreeSnapshot;
  private uiDeadline = 0;

  constructor(
    private readonly onStatus: (message: string) => void,
    private readonly onPacket: (packet: MediaPacket) => void,
    private readonly onEnded: () => void,
    private readonly onAudio: (packet: LocalAudioPacket) => void = () => {},
    private readonly onAudioStatus: (
      status: LocalAudioStatus,
    ) => void = () => {},
  ) {}

  async connect() {
    this.connected = true;
    await this.start();
  }

  async start() {
    this.playing = true;
    this.sequence = 0;
    const configuration: MediaPacket = {
      session: "0".repeat(32),
      stream: ++this.stream,
      sequence: 0,
      kind: "configuration",
      keyframe: false,
      pts: 0n,
      width: 64,
      height: 64,
      data: new Uint8Array(fixture.configuration),
    };
    this.configuration = configuration;
    this.onStatus("Synthetic Android connected.");
    this.onPacket(this.configuration);
    this.audioForwarding = this.audioEnabled && fixture.audioAvailable;
    this.onAudioStatus({
      state: this.audioForwarding
        ? "forwarding"
        : this.audioEnabled
          ? "unavailable"
          : "disabled",
      message: this.audioForwarding
        ? "Synthetic local audio forwarding."
        : this.audioEnabled
          ? "Synthetic audio unavailable."
          : "Synthetic audio disabled.",
    });
    if (this.audioForwarding) {
      let samples = 0;
      const stream = this.stream;
      this.audioTimer = setInterval(() => {
        const data = new Uint8Array(960);
        const view = new DataView(data.buffer);
        for (let frame = 0; frame < 240; ++frame) {
          const sample = Math.round(
            Math.sin(((samples + frame) * 2 * Math.PI * 440) / 48_000) * 10_000,
          );
          view.setInt16(frame * 4, sample, true);
          view.setInt16(frame * 4 + 2, sample, true);
        }
        ++fixture.audioPackets;
        this.onAudio({
          stream,
          pts: BigInt(Math.floor((samples * 1_000_000) / 48_000)),
          data,
        });
        samples += 240;
      }, 5);
    }
    this.timer = setInterval(() => {
      this.onPacket({
        ...configuration,
        kind: "data",
        keyframe: true,
        sequence: ++this.sequence,
        pts: BigInt(this.sequence * 100_000),
        data: new Uint8Array(fixture.frame),
      });
    }, 100);
  }

  async restartVideo() {
    await this.stop(true);
    await this.start();
  }

  async setRemoteController(id: string | null) {
    this.controller = id;
  }

  async localInput(event: RemoteInput, stream: number) {
    if (!this.playing || stream !== this.configuration?.stream)
      throw new Error("Local input used a stale screen.");
    fixture.inputs.push({ source: "local", event });
    if (event.kind !== "release") this.uiSnapshot = undefined;
  }

  async remoteInput(id: string, event: RemoteInput, stream: number) {
    if (
      !this.playing ||
      id !== this.controller ||
      stream !== this.configuration?.stream
    )
      throw new Error("Remote input used a stale controller or screen.");
    fixture.inputs.push({ source: "remote", event });
    if (event.kind !== "release") this.uiSnapshot = undefined;
  }

  async releaseInputs() {}

  async getUiTree(): Promise<LocalUiTreeSnapshot> {
    this.uiTreeActive = true;
    ++fixture.uiCaptures;
    this.uiSnapshot = undefined;
    if (fixture.failUiTree) throw new Error("Synthetic UI root unavailable.");
    const snapshot = {
      ...parseUiTree(uiTreeFixture(fixture.uiCaptures)),
      stream: this.stream,
      expiresInMs: fixture.uiExpiryMs,
    };
    this.uiSnapshot = snapshot;
    this.uiDeadline = performance.now() + snapshot.expiresInMs;
    return snapshot;
  }

  async performUiAction(
    value: LocalUiNodeActionRequest,
  ): Promise<UiNodeActionResult> {
    const request = parseUiNodeAction(value);
    if (
      !this.playing ||
      value.stream !== this.stream ||
      this.uiSnapshot?.snapshotRef !== request.snapshotRef ||
      performance.now() >= this.uiDeadline
    )
      throw new Error("Synthetic stale node reference.");
    if (
      !this.uiSnapshot.nodes[request.nodeId]?.actions.includes(request.action)
    )
      throw new Error("Synthetic unsupported node action.");
    this.uiSnapshot = undefined;
    fixture.uiActions.push(request);
    if (fixture.failUiAction) throw new Error("Synthetic ACTION_REJECTED.");
    return {
      snapshotRef: request.snapshotRef,
      nodeId: request.nodeId,
      action: request.action,
      accepted: true,
    };
  }

  async stopUiTree() {
    this.uiTreeActive = false;
    this.uiSnapshot = undefined;
    ++fixture.uiStops;
  }

  async launchApp(value: string): Promise<AppLaunchResult> {
    const packageName = parsePackageName(value);
    if (!this.playing || !this.configuration)
      throw new Error("Synthetic device is not playing.");
    this.controller = null;
    this.uiSnapshot = undefined;
    fixture.appLaunches.push(packageName);
    if (fixture.holdAppLaunch)
      await new Promise<void>((resolve) => {
        fixture.completeAppLaunch = resolve;
      });
    fixture.completeAppLaunch = undefined;
    if (fixture.failAppLaunch)
      throw new Error("Synthetic app launch rejected.");
    return { packageName, component: `${packageName}/.Main`, accepted: true };
  }

  async setScreenOff(off: boolean) {
    if (!this.playing) throw new Error("Synthetic device is not playing.");
    if (fixture.failScreenPower)
      throw new Error("Synthetic display write failed.");
    fixture.screenPowerRequests.push(off);
    this.screenOff = off;
    this.onStatus("Synthetic display request sent.");
  }

  async stop(preserveShare = false) {
    clearInterval(this.timer);
    clearInterval(this.audioTimer);
    this.audioForwarding = false;
    this.onAudioStatus({
      state: "stopped",
      message: "Synthetic audio stopped.",
    });
    if (this.screenOff) fixture.screenPowerRequests.push(false);
    if (!preserveShare) this.screenOff = false;
    this.playing = false;
    this.configuration = undefined;
    if (!preserveShare) await this.stopUiTree();
    if (!preserveShare) this.onEnded();
    this.onStatus("Synthetic Android stopped.");
  }

  async disconnect() {
    this.connected = false;
    await this.stop();
  }

  dispose() {
    clearInterval(this.timer);
    clearInterval(this.audioTimer);
  }
}
