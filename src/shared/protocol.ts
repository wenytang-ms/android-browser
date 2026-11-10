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

export type RemoteInput =
  | {
      kind: "touch";
      action: "down" | "move" | "up";
      pointerId: number;
      x: number;
      y: number;
    }
  | {
      kind: "key";
      action: "down" | "up";
      keyCode: AndroidKeyCode;
      metaState: AndroidKeyEventMeta;
    }
  | { kind: "text"; text: string }
  | { kind: "release" };

export interface InputMessage {
  v: 1;
  type: "input";
  controlId: string;
  stream: number;
  sequence: number;
  event: RemoteInput;
}

export type ClientMessage =
  | { v: 1; type: "create"; deploymentToken: string; accountToken: string }
  | {
      v: 1;
      type: "auth";
      role: Role;
      session: string;
      accountToken: string;
      token?: string;
      viewerId?: string;
    }
  | InputMessage
  | { v: 1; type: "control-permission"; enabled: boolean }
  | { v: 1; type: "ping" }
  | { v: 1; type: "end" }
  | { v: 1; type: "resync" };

export type ServerMessage =
  | {
      v: 1;
      type: "created";
      session: string;
      hostToken: string;
      expiresAt: number;
    }
  | { v: 1; type: "ready"; expiresAt: number }
  | { v: 1; type: "state"; state: SessionState }
  | { v: 1; type: "resync" }
  | { v: 1; type: "controller"; controlId: string | null }
  | { v: 1; type: "control-permission"; enabled: boolean }
  | InputMessage
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

function credential(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function integer(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}

function allowedKey(value: unknown): value is AndroidKeyCode {
  return (
    integer(value, 0, 255) &&
    ([3, 4, 24, 25, 26, 82, 92, 93, 111, 112, 122, 123, 124, 187].includes(
      value,
    ) ||
      (value >= 7 && value <= 16) ||
      (value >= 19 && value <= 23) ||
      (value >= 29 && value <= 62) ||
      (value >= 66 && value <= 76))
  );
}

function allowedMeta(value: unknown): value is AndroidKeyEventMeta {
  return integer(value, 0, 0x11003) && (value & ~0x11003) === 0;
}

export function parseRemoteInput(value: unknown): RemoteInput {
  if (!record(value)) throw new Error("Invalid input event.");
  switch (value.kind) {
    case "touch":
      if (
        (value.action === "down" ||
          value.action === "move" ||
          value.action === "up") &&
        integer(value.pointerId, 0, 9) &&
        typeof value.x === "number" &&
        Number.isFinite(value.x) &&
        value.x >= 0 &&
        value.x <= 1 &&
        typeof value.y === "number" &&
        Number.isFinite(value.y) &&
        value.y >= 0 &&
        value.y <= 1
      )
        return {
          kind: "touch",
          action: value.action,
          pointerId: value.pointerId,
          x: value.x,
          y: value.y,
        };
      break;
    case "key":
      if (
        (value.action === "down" || value.action === "up") &&
        allowedKey(value.keyCode) &&
        allowedMeta(value.metaState)
      )
        return {
          kind: "key",
          action: value.action,
          keyCode: value.keyCode,
          metaState: value.metaState,
        };
      break;
    case "text":
      if (
        typeof value.text === "string" &&
        value.text.length > 0 &&
        new TextEncoder().encode(value.text).byteLength <= 1024 &&
        !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text)
      )
        return { kind: "text", text: value.text };
      break;
    case "release":
      return { kind: "release" };
  }
  throw new Error("Input is outside the touch/key/text allowlist.");
}

function parseInputMessage(value: Record<string, unknown>): InputMessage {
  if (
    !isSessionId(value.controlId) ||
    !integer(value.stream, 1, 0xffffffff) ||
    !integer(value.sequence, 1, 0xffffffff)
  )
    throw new Error("Invalid input generation or sequence.");
  return {
    v: 1,
    type: "input",
    controlId: value.controlId,
    stream: value.stream,
    sequence: value.sequence,
    event: parseRemoteInput(value.event),
  };
}

export function parseClientMessage(text: string): ClientMessage {
  const value: unknown = JSON.parse(text);
  if (!record(value) || value.v !== VERSION)
    throw new Error("Unsupported protocol version.");
  switch (value.type) {
    case "create":
      if (
        typeof value.deploymentToken === "string" &&
        value.deploymentToken.length <= 256 &&
        credential(value.accountToken)
      )
        return {
          v: 1,
          type: "create",
          deploymentToken: value.deploymentToken,
          accountToken: value.accountToken,
        };
      break;
    case "auth":
      if (
        (value.role === "host" || value.role === "viewer") &&
        isSessionId(value.session) &&
        credential(value.accountToken) &&
        (value.role === "viewer" || credential(value.token)) &&
        (value.role === "host" || isSessionId(value.viewerId))
      )
        return {
          v: 1,
          type: "auth",
          role: value.role,
          session: value.session,
          accountToken: value.accountToken,
          token: credential(value.token) ? value.token : undefined,
          viewerId:
            typeof value.viewerId === "string" ? value.viewerId : undefined,
        };
      break;
    case "input":
      return parseInputMessage(value);
    case "control-permission":
      if (typeof value.enabled === "boolean")
        return { v: 1, type: "control-permission", enabled: value.enabled };
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
        typeof value.expiresAt === "number"
      )
        return {
          v: 1,
          type: "created",
          session: value.session,
          hostToken: value.hostToken,
          expiresAt: value.expiresAt,
        };
      break;
    case "input":
      return parseInputMessage(value);
    case "control-permission":
      if (typeof value.enabled === "boolean")
        return { v: 1, type: "control-permission", enabled: value.enabled };
      break;
    case "controller":
      if (value.controlId === null || isSessionId(value.controlId))
        return { v: 1, type: "controller", controlId: value.controlId };
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
import type { AndroidKeyCode, AndroidKeyEventMeta } from "@yume-chan/scrcpy";
