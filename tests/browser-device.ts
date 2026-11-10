import type { MediaPacket, RemoteInput } from "../src/shared/protocol.js";

const fixture: {
  configuration: number[];
  frame: number[];
  inputs: { source: "local" | "remote"; event: RemoteInput }[];
  screenPowerRequests: boolean[];
  failScreenPower: boolean;
} = {
  configuration: [],
  frame: [],
  inputs: [],
  screenPowerRequests: [],
  failScreenPower: false,
};
Object.defineProperty(globalThis, "tangoFixture", { value: fixture });

// Only the browser-smoke test build substitutes this synthetic USB boundary.
export class DeviceSession {
  configuration?: MediaPacket;
  connected = false;
  playing = false;
  screenOff = false;
  private stream = 0;
  private sequence = 0;
  private timer?: ReturnType<typeof setInterval>;
  private controller: string | null = null;

  constructor(
    private readonly onStatus: (message: string) => void,
    private readonly onPacket: (packet: MediaPacket) => void,
    private readonly onEnded: () => void,
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
  }

  async remoteInput(id: string, event: RemoteInput, stream: number) {
    if (
      !this.playing ||
      id !== this.controller ||
      stream !== this.configuration?.stream
    )
      throw new Error("Remote input used a stale controller or screen.");
    fixture.inputs.push({ source: "remote", event });
  }

  async releaseInputs() {}

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
    if (this.screenOff) fixture.screenPowerRequests.push(false);
    if (!preserveShare) this.screenOff = false;
    this.playing = false;
    this.configuration = undefined;
    if (!preserveShare) this.onEnded();
    this.onStatus("Synthetic Android stopped.");
  }

  async disconnect() {
    this.connected = false;
    await this.stop();
  }

  dispose() {
    clearInterval(this.timer);
  }
}
