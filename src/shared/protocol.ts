export const VERSION = 1;
export const HEADER_BYTES = 52;
export const MAX_PACKET_BYTES = 1024 * 1024;
export const MAX_CONFIG_BYTES = 64 * 1024;
export const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
export const HEARTBEAT_MS = 5_000;
export const OFFLINE_MS = 15_000;
export const SESSION_MS = 30 * 60_000;
export const MAX_DECODE_QUEUE = 8;

export type Role = "host" | "viewer";
export type Channel = "control" | "media";
export type SessionState = "online" | "host-offline" | "waiting-video";

export type ClientMessage =
  | { v: 1; type: "create"; deploymentToken: string }
  | {
      v: 1;
      type: "auth";
      role: Role;
      session: string;
      token: string;
      viewerId?: string;
    }
  | { v: 1; type: "ping" }
  | { v: 1; type: "end" }
  | { v: 1; type: "resync" };

export type ServerMessage =
  | {
      v: 1;
      type: "created";
      session: string;
      hostToken: string;
      viewerToken: string;
      expiresAt: number;
    }
  | { v: 1; type: "ready"; expiresAt: number }
  | { v: 1; type: "state"; state: SessionState }
  | { v: 1; type: "resync" }
  | { v: 1; type: "pong" }
  | { v: 1; type: "ended"; reason: string }
  | { v: 1; type: "error"; code: string; message: string };

export interface MediaPacket {
  session: string;
  stream: number;
  sequence: number;
  kind: "configuration" | "data";
  keyframe: boolean;
  pts: bigint;
  width: number;
  height: number;
  data: Uint8Array;
}

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseClientMessage(text: string): ClientMessage {
  const value: unknown = JSON.parse(text);
  if (!record(value) || value.v !== VERSION)
    throw new Error("Unsupported protocol version.");
  switch (value.type) {
    case "create":
      if (
        typeof value.deploymentToken === "string" &&
        value.deploymentToken.length <= 256
      )
        return { v: 1, type: "create", deploymentToken: value.deploymentToken };
      break;
    case "auth":
      if (
        (value.role === "host" || value.role === "viewer") &&
        isSessionId(value.session) &&
        typeof value.token === "string" &&
        /^[a-f0-9]{64}$/.test(value.token) &&
        (value.role === "host" || isSessionId(value.viewerId))
      )
        return {
          v: 1,
          type: "auth",
          role: value.role,
          session: value.session,
          token: value.token,
          viewerId:
            typeof value.viewerId === "string" ? value.viewerId : undefined,
        };
      break;
    case "ping":
    case "end":
    case "resync":
      return { v: 1, type: value.type };
  }
  throw new Error("Malformed or unknown request.");
}

export function parseServerMessage(text: string): ServerMessage {
  const value: unknown = JSON.parse(text);
  if (!record(value) || value.v !== VERSION)
    throw new Error("Unsupported relay protocol.");
  switch (value.type) {
    case "created":
      if (
        isSessionId(value.session) &&
        typeof value.hostToken === "string" &&
        /^[a-f0-9]{64}$/.test(value.hostToken) &&
        typeof value.viewerToken === "string" &&
        /^[a-f0-9]{64}$/.test(value.viewerToken) &&
        typeof value.expiresAt === "number"
      )
        return {
          v: 1,
          type: "created",
          session: value.session,
          hostToken: value.hostToken,
          viewerToken: value.viewerToken,
          expiresAt: value.expiresAt,
        };
      break;
    case "ready":
      if (typeof value.expiresAt === "number")
        return { v: 1, type: "ready", expiresAt: value.expiresAt };
      break;
    case "state":
      if (
        value.state === "online" ||
        value.state === "host-offline" ||
        value.state === "waiting-video"
      )
        return { v: 1, type: "state", state: value.state };
      break;
    case "pong":
    case "resync":
      return { v: 1, type: value.type };
    case "ended":
      if (typeof value.reason === "string")
        return { v: 1, type: "ended", reason: value.reason };
      break;
    case "error":
      if (typeof value.code === "string" && typeof value.message === "string")
        return {
          v: 1,
          type: "error",
          code: value.code,
          message: value.message,
        };
  }
  throw new Error("Malformed relay response.");
}

export function encodeMedia(packet: MediaPacket): Uint8Array<ArrayBuffer> {
  if (!isSessionId(packet.session)) throw new Error("Invalid media session.");
  const bytes = new Uint8Array(HEADER_BYTES + packet.data.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x544e474f);
  view.setUint8(4, VERSION);
  view.setUint8(5, packet.kind === "configuration" ? 0 : 1);
  view.setUint8(6, packet.keyframe ? 1 : 0);
  for (let i = 0; i < 16; i++)
    bytes[8 + i] = Number.parseInt(packet.session.slice(i * 2, i * 2 + 2), 16);
  view.setUint32(24, packet.stream);
  view.setUint32(28, packet.sequence);
  view.setBigUint64(32, packet.pts);
  view.setUint32(40, packet.width);
  view.setUint32(44, packet.height);
  view.setUint32(48, packet.data.byteLength);
  bytes.set(packet.data, HEADER_BYTES);
  decodeMedia(bytes);
  return bytes;
}

export function decodeMedia(bytes: Uint8Array): MediaPacket {
  if (bytes.byteLength < HEADER_BYTES || bytes.byteLength > MAX_PACKET_BYTES)
    throw new Error("Media packet exceeds bounds.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kind = view.getUint8(5);
  const width = view.getUint32(40);
  const height = view.getUint32(44);
  const length = view.getUint32(48);
  if (
    view.getUint32(0) !== 0x544e474f ||
    view.getUint8(4) !== VERSION ||
    kind > 1 ||
    view.getUint8(6) > 1 ||
    view.getUint8(7) !== 0 ||
    view.getUint32(24) === 0 ||
    width === 0 ||
    height === 0 ||
    width > 8192 ||
    height > 8192 ||
    length === 0 ||
    length !== bytes.byteLength - HEADER_BYTES ||
    (kind === 0 && length > MAX_CONFIG_BYTES)
  )
    throw new Error("Invalid media header.");
  return {
    session: Array.from(bytes.subarray(8, 24), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join(""),
    stream: view.getUint32(24),
    sequence: view.getUint32(28),
    kind: kind === 0 ? "configuration" : "data",
    keyframe: view.getUint8(6) === 1,
    pts: view.getBigUint64(32),
    width,
    height,
    data: bytes.subarray(HEADER_BYTES),
  };
}

export function relayUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("中继地址须为 HTTPS 源地址；仅本机开发允许 HTTP。");
  return url;
}

export function channelUrl(base: URL, channel: Channel): string {
  const url = new URL(`/ws/${channel}`, base);
  url.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  return url.href;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
