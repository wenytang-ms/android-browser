import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createRelay } from "../src/relay/server.js";
import {
  decodeMedia,
  encodeMedia,
  parseServerMessage,
} from "../src/shared/protocol.js";
import type {
  ClientMessage,
  MediaPacket,
  ServerMessage,
} from "../src/shared/protocol.js";

type Created = Extract<ServerMessage, { type: "created" }>;
type Item = ServerMessage | Uint8Array;

class TestClient {
  readonly items: Item[] = [];
  private waiters: (() => void)[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on("message", (data, binary) => {
      this.items.push(
        binary
          ? new Uint8Array(Buffer.from(data as Buffer))
          : parseServerMessage(data.toString()),
      );
      this.waiters.splice(0).forEach((wake) => wake());
    });
  }
  send(message: ClientMessage) {
    this.ws.send(JSON.stringify(message));
  }
  async take(predicate: (item: Item) => boolean): Promise<Item> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const index = this.items.findIndex(predicate);
      if (index !== -1) return this.items.splice(index, 1)[0];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    throw new Error(
      `Missing relay message; received ${JSON.stringify(this.items)}`,
    );
  }
  async message<T extends ServerMessage["type"]>(type: T) {
    return (await this.take(
      (item) => !(item instanceof Uint8Array) && item.type === type,
    )) as Extract<ServerMessage, { type: T }>;
  }
  async frame() {
    const bytes = await this.take((item) => item instanceof Uint8Array);
    if (!(bytes instanceof Uint8Array))
      throw new Error("Expected binary video");
    return decodeMedia(bytes);
  }
}

describe("real dual-WebSocket relay", () => {
  let relay: ReturnType<typeof createRelay>;
  let url: string;
  let clock: number;
  let clients: TestClient[];

  beforeEach(async () => {
    clock = Date.now();
    clients = [];
    relay = createRelay({
      publicUrl: "http://localhost:3000",
      viewerDir: resolve("viewer"),
      extensionOrigins: ["chrome-extension://test"],
      deploymentToken: "developer-secret",
      now: () => clock,
    });
    await new Promise<void>((done) =>
      relay.server.listen(0, "127.0.0.1", done),
    );
    url = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    for (const client of clients) client.ws.terminate();
    await relay.close();
  });

  async function connect(
    channel: "control" | "media",
    origin = "http://localhost:3000",
  ) {
    const ws = new WebSocket(`${url}/ws/${channel}`, { origin });
    const client = new TestClient(ws);
    clients.push(client);
    await new Promise<void>((done, reject) => {
      ws.once("open", done);
      ws.once("error", reject);
    });
    return client;
  }
  async function create() {
    const host = await connect("control", "chrome-extension://test");
    host.send({ v: 1, type: "create", deploymentToken: "developer-secret" });
    return { host, created: await host.message("created") };
  }
  async function authorize(
    created: Created,
    role: "host" | "viewer",
    channel: "control" | "media",
    viewerId = "b".repeat(32),
  ) {
    const client = await connect(channel);
    client.send({
      v: 1,
      type: "auth",
      role,
      session: created.session,
      token: role === "host" ? created.hostToken : created.viewerToken,
      viewerId,
    });
    await client.message("ready");
    return client;
  }
  function packet(
    created: Created,
    kind: "configuration" | "data",
    sequence: number,
    keyframe = false,
    stream = 1,
  ): MediaPacket {
    return {
      session: created.session,
      kind,
      sequence,
      keyframe,
      stream,
      pts: BigInt(sequence * 33333),
      width: 1280,
      height: 720,
      data: new Uint8Array([
        0,
        0,
        0,
        1,
        kind === "configuration" ? 0x67 : keyframe ? 0x65 : 0x41,
        sequence,
      ]),
    };
  }

  it("requires deployment authorization and independent viewer credentials", async () => {
    const rejected = await connect("control");
    rejected.send({ v: 1, type: "create", deploymentToken: "wrong" });
    expect((await rejected.message("error")).code).toBe("unauthorized");
    expect(relay.sessionCount()).toBe(0);
    const { created } = await create();
    const viewer = await connect("control");
    viewer.send({
      v: 1,
      type: "auth",
      role: "viewer",
      session: created.session,
      token: created.hostToken,
      viewerId: "b".repeat(32),
    });
    expect((await viewer.message("error")).code).toBe("unauthorized");
    await expect(
      connect("control", "https://untrusted.example"),
    ).rejects.toThrow("403");
  });

  it("binds media to the authorized control session and enforces one active viewer", async () => {
    const { created } = await create();
    const media = await connect("media");
    media.send({
      v: 1,
      type: "auth",
      role: "viewer",
      session: created.session,
      token: created.viewerToken,
      viewerId: "b".repeat(32),
    });
    expect((await media.message("error")).code).toBe("unauthorized");
    await authorize(created, "viewer", "control");
    const second = await connect("control");
    second.send({
      v: 1,
      type: "auth",
      role: "viewer",
      session: created.session,
      token: created.viewerToken,
      viewerId: "c".repeat(32),
    });
    expect((await second.message("error")).code).toBe("viewer-busy");
  });

  it("sends configuration before a fresh keyframe on join, reconnect and generation changes", async () => {
    const { host, created } = await create();
    const hostVideo = await authorize(created, "host", "media");
    hostVideo.ws.send(encodeMedia(packet(created, "configuration", 0)));
    hostVideo.ws.send(encodeMedia(packet(created, "data", 1, true)));
    await authorize(created, "viewer", "control");
    const video = await authorize(created, "viewer", "media");
    await host.message("resync");
    hostVideo.ws.send(encodeMedia(packet(created, "data", 2)));
    hostVideo.ws.send(encodeMedia(packet(created, "data", 3, true)));
    expect((await video.frame()).kind).toBe("configuration");
    expect((await video.frame()).sequence).toBe(3);
    video.ws.terminate();
    const resumed = await authorize(created, "viewer", "media");
    await host.message("resync");
    hostVideo.ws.send(encodeMedia(packet(created, "data", 4)));
    hostVideo.ws.send(encodeMedia(packet(created, "data", 5, true)));
    expect((await resumed.frame()).kind).toBe("configuration");
    expect((await resumed.frame()).sequence).toBe(5);
    hostVideo.ws.send(
      encodeMedia({
        ...packet(created, "configuration", 0, false, 2),
        width: 720,
        height: 1280,
      }),
    );
    hostVideo.ws.send(
      encodeMedia({
        ...packet(created, "data", 1, true, 2),
        width: 720,
        height: 1280,
      }),
    );
    expect(await resumed.frame()).toMatchObject({
      stream: 2,
      width: 720,
      height: 1280,
    });
    expect((await resumed.frame()).stream).toBe(2);
  });

  it("revokes both remote channels and cannot resurrect an ended session", async () => {
    const { host, created } = await create();
    await authorize(created, "host", "media");
    const viewer = await authorize(created, "viewer", "control");
    const video = await authorize(created, "viewer", "media");
    host.send({ v: 1, type: "end" });
    expect((await viewer.message("ended")).reason).toBe("revoked");
    expect((await video.message("ended")).reason).toBe("revoked");
    expect(relay.sessionCount()).toBe(0);
    const retry = await connect("control");
    retry.send({
      v: 1,
      type: "auth",
      role: "host",
      session: created.session,
      token: created.hostToken,
    });
    expect((await retry.message("error")).code).toBe("session-ended");
  });

  it("allows brief host reconnect but expires offline and wall-clock-expired credentials", async () => {
    const { host, created } = await create();
    const viewer = await authorize(created, "viewer", "control");
    const offline = viewer.take(
      (item) =>
        !(item instanceof Uint8Array) &&
        item.type === "state" &&
        item.state === "host-offline",
    );
    host.ws.terminate();
    await offline;
    clock += 5_000;
    const recovered = await authorize(created, "host", "control");
    expect(relay.sessionCount()).toBe(1);
    recovered.ws.terminate();
    await viewer.take(
      (item) =>
        !(item instanceof Uint8Array) &&
        item.type === "state" &&
        item.state === "host-offline",
    );
    clock += 15_001;
    relay.sweep();
    expect((await viewer.message("ended")).reason).toBe("host-offline");
    const fresh = await create();
    clock = fresh.created.expiresAt;
    relay.sweep();
    expect((await fresh.host.message("ended")).reason).toBe("expired");
    expect(relay.sessionCount()).toBe(0);
  });

  it("rejects duplicate creation and old stream generations", async () => {
    const { host, created } = await create();
    host.send({ v: 1, type: "create", deploymentToken: "developer-secret" });
    expect((await host.message("error")).code).toBe("duplicate-auth");
    const second = await create();
    const video = await authorize(second.created, "host", "media");
    video.ws.send(
      encodeMedia(packet(second.created, "configuration", 0, false, 2)),
    );
    video.ws.send(
      encodeMedia(packet(second.created, "configuration", 0, false, 1)),
    );
    expect((await video.message("error")).code).toBe("protocol");
    expect(created.session).not.toBe(second.created.session);
  });
});
