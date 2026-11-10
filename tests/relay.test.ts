import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { createRelay } from "../src/relay/server.js";
import { googleFixture } from "./google-fixture.js";
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
  let google: Awaited<ReturnType<typeof googleFixture>>;
  let accountToken: string;

  beforeEach(async () => {
    clock = Date.now();
    clients = [];
    google = await googleFixture();
    relay = createRelay({
      publicUrl: "http://localhost:3000",
      viewerDir: resolve("viewer"),
      extensionOrigins: ["chrome-extension://test"],
      deploymentToken: "developer-secret",
      now: () => clock,
      google: google.options,
    });
    await new Promise<void>((done) =>
      relay.server.listen(0, "127.0.0.1", done),
    );
    url = `ws://127.0.0.1:${(relay.server.address() as AddressInfo).port}`;
    accountToken = await google.login(url.replace("ws:", "http:"));
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
    host.send({
      v: 1,
      type: "create",
      deploymentToken: "developer-secret",
      accountToken,
    });
    return { host, created: await host.message("created") };
  }
  async function authorize(
    created: Created,
    role: "host" | "viewer",
    channel: "control" | "media",
    viewerId = "b".repeat(32),
    loginToken = accountToken,
  ) {
    const client = await connect(channel);
    client.send({
      v: 1,
      type: "auth",
      role,
      session: created.session,
      token: role === "host" ? created.hostToken : undefined,
      accountToken: loginToken,
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

  it("requires deployment authorization and the verified owner account even with a leaked host token", async () => {
    const rejected = await connect("control");
    rejected.send({
      v: 1,
      type: "create",
      deploymentToken: "wrong",
      accountToken,
    });
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
      accountToken: await google.login(
        url.replace("ws:", "http:"),
        "another-account",
      ),
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
      accountToken,
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
      accountToken,
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
      accountToken,
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
    host.send({
      v: 1,
      type: "create",
      deploymentToken: "developer-secret",
      accountToken,
    });
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

  it("verifies signed Google identity claims and binds one-use login tickets to PKCE and Origin", async () => {
    const base = url.replace("ws:", "http:");
    for (const claims of [
      { aud: "another-client" },
      { iss: "https://untrusted.example" },
      { exp: 1 },
      { nonce: "wrong-nonce" },
      { fixture_bad_signature: true },
    ])
      expect((await google.ticket(base, "owner", claims)).code).toBeNull();
    const ticket = await google.ticket(base, "owner");
    const untrusted = await google.exchange(base, {
      ...ticket,
      origin: "https://untrusted.example",
    });
    expect(untrusted.status).toBe(400);
    expect((await google.exchange(base, ticket, "x".repeat(43))).status).toBe(
      400,
    );
    expect((await google.exchange(base, ticket)).status).toBe(400);
    const good = await google.ticket(base, "owner");
    expect((await google.exchange(base, good)).status).toBe(200);
    expect((await google.exchange(base, good)).status).toBe(400);
    const noLogin = await connect("control");
    noLogin.send({
      v: 1,
      type: "create",
      deploymentToken: "developer-secret",
      accountToken: "0".repeat(64),
    });
    expect((await noLogin.message("error")).code).toBe("login-required");
  });

  it("forwards scoped owner input, rejects replay and releases control on disconnect", async () => {
    const { host, created } = await create();
    const hostVideo = await authorize(created, "host", "media");
    const viewer = await authorize(created, "viewer", "control");
    const controller = await viewer.message("controller");
    expect(controller.controlId).not.toBeNull();
    const video = await authorize(created, "viewer", "media");
    hostVideo.ws.send(encodeMedia(packet(created, "configuration", 0)));
    hostVideo.ws.send(encodeMedia(packet(created, "data", 1, true)));
    await video.frame();
    await video.frame();
    const event = {
      v: 1,
      type: "input",
      controlId: controller.controlId!,
      stream: 1,
      sequence: 1,
      event: { kind: "touch", action: "down", pointerId: 0, x: 0.25, y: 0.75 },
    } as const;
    viewer.send(event);
    expect(await host.message("input")).toEqual(event);
    viewer.send(event);
    expect((await viewer.message("error")).code).toBe("forbidden");
    await host.take(
      (item) =>
        !(item instanceof Uint8Array) &&
        item.type === "controller" &&
        item.controlId === null,
    );
    expect(relay.sessionCount()).toBe(1);
  });

  it("discards stale-screen input, replaces its controller grant and resynchronizes instead of executing it", async () => {
    const { host, created } = await create();
    const hostVideo = await authorize(created, "host", "media");
    const viewer = await authorize(created, "viewer", "control");
    const previous = await viewer.message("controller");
    const video = await authorize(created, "viewer", "media");
    await host.message("resync");
    hostVideo.ws.send(encodeMedia(packet(created, "configuration", 0)));
    hostVideo.ws.send(encodeMedia(packet(created, "data", 1, true)));
    await video.frame();
    await video.frame();
    viewer.send({
      v: 1,
      type: "input",
      controlId: previous.controlId!,
      stream: 2,
      sequence: 1,
      event: { kind: "key", action: "down", keyCode: 66, metaState: 0 },
    });
    const current = await viewer.message("controller");
    expect(current.controlId).not.toBe(previous.controlId);
    await host.message("resync");
    expect(
      host.items.some(
        (item) => !(item instanceof Uint8Array) && item.type === "input",
      ),
    ).toBe(false);
    expect(relay.sessionCount()).toBe(1);
  });

  it("keeps video running during local takeover and only lets the host restore remote input with a fresh grant", async () => {
    const { host, created } = await create();
    const hostVideo = await authorize(created, "host", "media");
    const viewer = await authorize(created, "viewer", "control");
    const previous = await viewer.message("controller");
    expect((await viewer.message("control-permission")).enabled).toBe(true);
    const video = await authorize(created, "viewer", "media");
    await host.message("resync");
    hostVideo.ws.send(encodeMedia(packet(created, "configuration", 0)));
    hostVideo.ws.send(encodeMedia(packet(created, "data", 1, true)));
    await video.frame();
    await video.frame();
    host.send({ v: 1, type: "control-permission", enabled: false });
    expect((await viewer.message("control-permission")).enabled).toBe(false);
    expect((await viewer.message("controller")).controlId).toBeNull();
    const event = {
      v: 1,
      type: "input",
      controlId: previous.controlId!,
      stream: 1,
      sequence: 1,
      event: { kind: "key", action: "down", keyCode: 66, metaState: 0 },
    } as const;
    viewer.send(event);
    expect((await viewer.message("controller")).controlId).toBeNull();
    hostVideo.ws.send(encodeMedia(packet(created, "data", 2)));
    expect((await video.frame()).sequence).toBe(2);
    expect(
      host.items.some(
        (item) => !(item instanceof Uint8Array) && item.type === "input",
      ),
    ).toBe(false);
    host.send({ v: 1, type: "control-permission", enabled: true });
    expect((await viewer.message("control-permission")).enabled).toBe(true);
    const current = await viewer.message("controller");
    expect(current.controlId).not.toBeNull();
    expect(current.controlId).not.toBe(previous.controlId);
    await host.message("resync");
    hostVideo.ws.send(encodeMedia(packet(created, "data", 3, true)));
    await video.frame();
    await video.frame();
    viewer.send({ ...event, controlId: current.controlId! });
    expect((await host.message("input")).controlId).toBe(current.controlId);
    host.send({ v: 1, type: "control-permission", enabled: false });
    await viewer.message("control-permission");
    viewer.send({ v: 1, type: "control-permission", enabled: true });
    expect((await viewer.message("error")).code).toBe("forbidden");
    expect(relay.sessionCount()).toBe(1);
  });

  it("preserves read-only permission when the host and viewer reconnect", async () => {
    const { host, created } = await create();
    const viewer = await authorize(created, "viewer", "control");
    await viewer.message("control-permission");
    await viewer.message("controller");
    host.send({ v: 1, type: "control-permission", enabled: false });
    await viewer.message("control-permission");
    host.ws.terminate();
    await viewer.take(
      (item) =>
        !(item instanceof Uint8Array) &&
        item.type === "state" &&
        item.state === "host-offline",
    );
    const resumedHost = await authorize(created, "host", "control");
    expect((await resumedHost.message("controller")).controlId).toBeNull();
    viewer.ws.terminate();
    await resumedHost.message("controller");
    const resumedViewer = await authorize(
      created,
      "viewer",
      "control",
      "c".repeat(32),
    );
    expect((await resumedViewer.message("control-permission")).enabled).toBe(
      false,
    );
    expect((await resumedViewer.message("controller")).controlId).toBeNull();
  });

  it("revokes login-bound connections without giving a viewer authority to end the host share", async () => {
    const base = url.replace("ws:", "http:");
    const { host, created } = await create();
    const viewerToken = await google.login(base);
    const viewer = await authorize(
      created,
      "viewer",
      "control",
      "b".repeat(32),
      viewerToken,
    );
    await fetch(new URL("/auth/logout", base), {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accountToken: viewerToken }),
    });
    expect((await viewer.message("error")).code).toBe("login-required");
    expect(relay.sessionCount()).toBe(1);
    await fetch(new URL("/auth/logout", base), {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ accountToken }),
    });
    expect((await host.message("ended")).reason).toBe("login-expired");
    expect(relay.sessionCount()).toBe(0);
  });
});
