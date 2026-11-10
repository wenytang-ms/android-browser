import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import type { RawData } from "ws";
import { createGoogleAuth } from "./auth.js";
import type { GoogleAuthOptions } from "./auth.js";
import {
  decodeMedia,
  errorText,
  HEARTBEAT_MS,
  MAX_BUFFER_BYTES,
  MAX_PACKET_BYTES,
  OFFLINE_MS,
  parseClientMessage,
  SESSION_MS,
} from "../shared/protocol.js";
import type {
  Channel,
  ClientMessage,
  Role,
  ServerMessage,
  SessionState,
} from "../shared/protocol.js";

interface Peer {
  socket: WebSocket;
  channel: Channel;
  role?: Role;
  session?: Session;
  viewerId?: string;
  lastSeen: number;
  authDeadline: number;
  requests: number;
  requestWindow: number;
  accountToken?: string;
  inputWindow: number;
  inputs: number;
}

interface Session {
  id: string;
  hostToken: string;
  owner: string;
  expiresAt: number;
  offlineAt?: number;
  hostControl?: Peer;
  hostMedia?: Peer;
  viewerControl?: Peer;
  viewerMedia?: Peer;
  viewerId?: string;
  controlId?: string;
  controlEnabled: boolean;
  inputSequence: number;
  configuration?: Uint8Array;
  stream: number;
  sequence: number;
  width: number;
  height: number;
  waitingKey: boolean;
  mediaWindow: number;
  mediaBytes: number;
}

export interface RelayOptions {
  publicUrl: string;
  viewerDir: string;
  extensionOrigins?: string[];
  deploymentToken?: string;
  google: GoogleAuthOptions;
  sessionMs?: number;
  offlineMs?: number;
  maxSessions?: number;
  now?: () => number;
}

function rawBytes(data: RawData): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return data;
}

function secretEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createRelay(options: RelayOptions) {
  const now = options.now ?? Date.now;
  const sessionMs = options.sessionMs ?? SESSION_MS;
  const offlineMs = options.offlineMs ?? OFFLINE_MS;
  const sessions = new Map<string, Session>();
  const peers = new Set<Peer>();
  const publicOrigin = new URL(options.publicUrl).origin;
  const allowedOrigins = new Set([
    publicOrigin,
    ...(options.extensionOrigins ?? []),
  ]);
  const viewerRoot = resolve(options.viewerDir);
  const identity = createGoogleAuth(
    options.google,
    publicOrigin,
    allowedOrigins,
    now,
    (token) => {
      for (const peer of peers) {
        if (peer.accountToken !== token) continue;
        if (peer.role === "host" && peer.session)
          end(peer.session, "login-expired");
        else {
          if (peer.session?.viewerControl === peer)
            setController(peer.session, undefined);
          fail(peer, "login-required", "登录已注销或过期，请重新登录。");
        }
      }
    },
  );

  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("Referrer-Policy", "no-referrer");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Cache-Control", "no-store");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
      );
      const requestUrl = new URL(request.url ?? "/", publicOrigin);
      if (await identity.handle(request, response, requestUrl)) return;
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405).end("Method not allowed");
        return;
      }
      const path = requestUrl.pathname;
      if (path === "/health") {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ status: "ok", sessions: sessions.size }));
        return;
      }
      const target = resolve(
        viewerRoot,
        path === "/" ? "index.html" : `.${decodeURIComponent(path)}`,
      );
      if (!target.startsWith(viewerRoot + sep)) {
        response.writeHead(403).end("Forbidden");
        return;
      }
      try {
        const body = await readFile(target);
        const extension = target.slice(target.lastIndexOf("."));
        const mime: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
        };
        response.setHeader(
          "Content-Type",
          mime[extension] ?? "application/octet-stream",
        );
        response.end(request.method === "HEAD" ? undefined : body);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          (error.code === "ENOENT" || error.code === "EISDIR")
        ) {
          response.writeHead(404).end("Not found");
          return;
        }
        throw error;
      }
    })().catch((error: unknown) => {
      console.error("HTTP request failed:", errorText(error));
      if (!response.headersSent) response.writeHead(500);
      response.end("Internal server error");
    });
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_PACKET_BYTES,
    perMessageDeflate: false,
  });

  function send(peer: Peer | undefined, message: ServerMessage) {
    if (!peer || peer.socket.readyState !== WebSocket.OPEN) return;
    if (peer.socket.bufferedAmount > 64 * 1024) {
      peer.socket.terminate();
      return;
    }
    peer.socket.send(JSON.stringify(message));
  }

  function fail(peer: Peer, code: string, message: string) {
    send(peer, { v: 1, type: "error", code, message });
    peer.socket.close(4003, code);
  }

  function state(session: Session): SessionState {
    if (!session.hostControl) return "host-offline";
    return session.hostMedia ? "online" : "waiting-video";
  }

  function broadcastState(session: Session) {
    const message: ServerMessage = {
      v: 1,
      type: "state",
      state: state(session),
    };
    send(session.hostControl, message);
    send(session.viewerControl, message);
  }

  function setController(session: Session, controlId: string | undefined) {
    session.controlId = controlId;
    session.inputSequence = 0;
    const message: ServerMessage = {
      v: 1,
      type: "controller",
      controlId: controlId ?? null,
    };
    send(session.hostControl, message);
    send(session.viewerControl, message);
  }

  function clearMedia(session: Session) {
    session.configuration = undefined;
    session.waitingKey = true;
    const media = session.hostMedia;
    session.hostMedia = undefined;
    media?.socket.close(4001, "media-reset");
  }

  function end(session: Session, reason: string) {
    if (!sessions.delete(session.id)) return;
    for (const peer of [
      session.hostControl,
      session.hostMedia,
      session.viewerControl,
      session.viewerMedia,
    ]) {
      send(peer, { v: 1, type: "ended", reason });
      peer?.socket.close(4000, reason);
    }
    session.configuration = undefined;
  }

  function live(peer: Peer): Session | undefined {
    const session = peer.session;
    if (!session || !sessions.has(session.id)) {
      fail(peer, "unauthorized", "请先完成会话授权。");
      return;
    }
    const account = identity.account(peer.accountToken ?? "");
    if (!account || account.subject !== session.owner) {
      if (peer.role === "host") end(session, "login-expired");
      else fail(peer, "login-required", "请重新登录创建分享的 Google 账号。");
      return;
    }
    if (now() >= session.expiresAt) {
      end(session, "expired");
      return;
    }
    if (
      session.offlineAt !== undefined &&
      now() - session.offlineAt >= offlineMs
    ) {
      end(session, "host-offline");
      return;
    }
    const current =
      peer.role === "host"
        ? peer.channel === "control"
          ? session.hostControl
          : session.hostMedia
        : peer.channel === "control"
          ? session.viewerControl
          : session.viewerMedia;
    if (current !== peer) {
      fail(peer, "superseded", "连接已被新的会话连接替换。");
      return;
    }
    return session;
  }

  function auth(peer: Peer, message: Extract<ClientMessage, { type: "auth" }>) {
    const account = identity.account(message.accountToken);
    if (!account) {
      fail(peer, "login-required", "须先完成 Google 登录。");
      return;
    }
    const session = sessions.get(message.session);
    if (!session) {
      fail(peer, "session-ended", "会话不存在、已撤销或已过期。");
      return;
    }
    if (
      now() >= session.expiresAt ||
      (session.offlineAt !== undefined &&
        now() - session.offlineAt >= offlineMs)
    ) {
      end(session, now() >= session.expiresAt ? "expired" : "host-offline");
      fail(peer, "session-ended", "会话已结束，不能恢复旧凭据。");
      return;
    }
    if (
      account.subject !== session.owner ||
      (message.role === "host" &&
        !secretEqual(message.token ?? "", session.hostToken))
    ) {
      fail(peer, "unauthorized", "只能使用创建分享的同一 Google 账号访问。");
      return;
    }
    if (message.role === "viewer") {
      if (
        session.viewerId &&
        session.viewerId !== message.viewerId &&
        session.viewerControl
      ) {
        fail(peer, "viewer-busy", "首版只允许一个远端观看者。");
        return;
      }
      if (
        peer.channel === "media" &&
        (!session.viewerControl || session.viewerId !== message.viewerId)
      ) {
        fail(peer, "unauthorized", "视频连接必须绑定已授权的观看会话。");
        return;
      }
      session.viewerId = message.viewerId;
      peer.viewerId = message.viewerId;
    } else if (peer.channel === "media" && !session.hostControl) {
      fail(peer, "host-offline", "宿主会话通道尚未连接。");
      return;
    }
    peer.role = message.role;
    peer.accountToken = message.accountToken;
    peer.session = session;
    const slot =
      message.role === "host"
        ? peer.channel === "control"
          ? "hostControl"
          : "hostMedia"
        : peer.channel === "control"
          ? "viewerControl"
          : "viewerMedia";
    const old = session[slot];
    session[slot] = peer;
    old?.socket.close(4003, "superseded");
    if (slot === "hostControl") session.offlineAt = undefined;
    if (slot === "hostMedia") {
      session.configuration = undefined;
      session.waitingKey = true;
    }
    if (slot === "viewerMedia") {
      session.waitingKey = true;
      send(session.hostControl, { v: 1, type: "resync" });
    }
    send(peer, { v: 1, type: "ready", expiresAt: session.expiresAt });
    if (slot === "viewerControl")
      send(peer, {
        v: 1,
        type: "control-permission",
        enabled: session.controlEnabled,
      });
    if (
      slot === "viewerControl" ||
      (slot === "hostControl" && session.viewerControl)
    )
      setController(
        session,
        session.controlEnabled ? randomBytes(16).toString("hex") : undefined,
      );
    broadcastState(session);
  }

  function control(peer: Peer, message: ClientMessage) {
    if (message.type === "create" || message.type === "auth") {
      if (peer.session) {
        fail(peer, "duplicate-auth", "连接已经授权，不能重复创建或加入。");
        return;
      }
      if (message.type === "auth") {
        auth(peer, message);
        return;
      }
      if (peer.channel !== "control") {
        fail(peer, "wrong-channel", "须在会话通道创建分享。");
        return;
      }
      const account = identity.account(message.accountToken);
      if (!account) {
        fail(peer, "login-required", "创建分享前须先完成 Google 登录。");
        return;
      }
      if (
        options.deploymentToken &&
        !secretEqual(message.deploymentToken, options.deploymentToken)
      ) {
        fail(peer, "unauthorized", "中继创建密钥不正确。");
        return;
      }
      if (sessions.size >= (options.maxSessions ?? 64)) {
        fail(peer, "capacity", "中继会话已满，请稍后重试。");
        return;
      }
      const session: Session = {
        id: randomBytes(16).toString("hex"),
        hostToken: randomBytes(32).toString("hex"),
        owner: account.subject,
        expiresAt: Math.min(now() + sessionMs, account.expiresAt),
        hostControl: peer,
        stream: 0,
        sequence: 0,
        width: 0,
        height: 0,
        waitingKey: true,
        mediaWindow: now(),
        mediaBytes: 0,
        inputSequence: 0,
        controlEnabled: true,
      };
      sessions.set(session.id, session);
      peer.role = "host";
      peer.session = session;
      peer.accountToken = message.accountToken;
      send(peer, {
        v: 1,
        type: "created",
        session: session.id,
        hostToken: session.hostToken,
        expiresAt: session.expiresAt,
      });
      return;
    }
    const session = live(peer);
    if (!session) return;
    switch (message.type) {
      case "control-permission":
        if (peer.role !== "host" || peer.channel !== "control") {
          fail(peer, "forbidden", "只有宿主可以切换远程控制权限。");
          break;
        }
        session.controlEnabled = message.enabled;
        setController(
          session,
          message.enabled && session.viewerControl
            ? randomBytes(16).toString("hex")
            : undefined,
        );
        send(session.viewerControl, message);
        if (message.enabled && session.viewerMedia) {
          session.waitingKey = true;
          send(session.hostControl, { v: 1, type: "resync" });
        }
        break;
      case "input":
        if (
          peer.role !== "viewer" ||
          peer.channel !== "control" ||
          session.viewerControl !== peer
        ) {
          fail(peer, "forbidden", "只有当前同账号远端控制连接可以发送输入。");
          break;
        }
        if (
          message.controlId !== session.controlId ||
          !session.controlEnabled ||
          !session.hostControl ||
          !session.hostMedia
        ) {
          send(peer, {
            v: 1,
            type: "controller",
            controlId: session.controlId ?? null,
          });
          break;
        }
        if (message.sequence !== session.inputSequence + 1) {
          fail(peer, "forbidden", "输入序列重复或已失效，请重新加入。");
          break;
        }
        session.inputSequence = message.sequence;
        if (
          !session.configuration ||
          session.waitingKey ||
          message.stream !== session.stream
        ) {
          setController(session, randomBytes(16).toString("hex"));
          session.waitingKey = true;
          send(session.hostControl, { v: 1, type: "resync" });
          break;
        }
        send(session.hostControl, message);
        break;
      case "ping":
        send(peer, { v: 1, type: "pong" });
        break;
      case "end":
        if (peer.role !== "host" || peer.channel !== "control")
          fail(peer, "forbidden", "只有宿主可以撤销分享。");
        else end(session, "revoked");
        break;
      case "resync":
        if (peer.role !== "viewer" || peer.channel !== "control") {
          fail(peer, "forbidden", "未知的视频同步请求来源。");
          break;
        }
        session.waitingKey = true;
        send(session.hostControl, { v: 1, type: "resync" });
        break;
    }
  }

  function media(peer: Peer, bytes: Uint8Array) {
    const session = live(peer);
    if (!session) return;
    if (
      peer.role !== "host" ||
      peer.channel !== "media" ||
      session.hostMedia !== peer
    ) {
      fail(peer, "forbidden", "观看端不可发送视频。");
      return;
    }
    if (now() - session.mediaWindow >= 1_000) {
      session.mediaWindow = now();
      session.mediaBytes = 0;
    }
    session.mediaBytes += bytes.byteLength;
    if (session.mediaBytes > 4 * 1024 * 1024) {
      fail(peer, "rate-limit", "视频发送速率过高，请降低码率。");
      return;
    }
    const packet = decodeMedia(bytes);
    if (packet.session !== session.id)
      throw new Error("Media session mismatch.");
    if (packet.kind === "configuration") {
      if (packet.stream <= session.stream || packet.sequence !== 0)
        throw new Error("Stale stream configuration.");
      session.stream = packet.stream;
      session.sequence = 0;
      session.width = packet.width;
      session.height = packet.height;
      session.configuration = new Uint8Array(bytes);
      session.waitingKey = true;
      return;
    }
    if (
      !session.configuration ||
      packet.stream !== session.stream ||
      packet.sequence !== session.sequence + 1 ||
      packet.width !== session.width ||
      packet.height !== session.height
    )
      throw new Error("Video stream sequence mismatch.");
    session.sequence = packet.sequence;
    const viewer = session.viewerMedia;
    if (!viewer || viewer.socket.readyState !== WebSocket.OPEN) return;
    const configurationBytes = session.waitingKey
      ? session.configuration.byteLength
      : 0;
    if (
      viewer.socket.bufferedAmount + configurationBytes + bytes.byteLength >
      MAX_BUFFER_BYTES
    ) {
      // Closing the socket discards the whole dependent GOP, never an arbitrary reference frame.
      viewer.socket.terminate();
      session.viewerMedia = undefined;
      session.waitingKey = true;
      return;
    }
    if (session.waitingKey) {
      if (!packet.keyframe) return;
      viewer.socket.send(session.configuration);
      session.waitingKey = false;
    }
    viewer.socket.send(bytes);
  }

  function disconnected(peer: Peer) {
    peers.delete(peer);
    const session = peer.session;
    if (!session || !sessions.has(session.id)) return;
    if (session.hostControl === peer) {
      setController(session, undefined);
      session.hostControl = undefined;
      session.offlineAt = now();
      clearMedia(session);
      const viewer = session.viewerMedia;
      session.viewerMedia = undefined;
      viewer?.socket.close(4001, "host-offline");
    }
    if (session.hostMedia === peer) {
      session.hostMedia = undefined;
      session.configuration = undefined;
      session.waitingKey = true;
    }
    if (session.viewerControl === peer) {
      setController(session, undefined);
      session.viewerControl = undefined;
      const viewer = session.viewerMedia;
      session.viewerMedia = undefined;
      viewer?.socket.close(4001, "viewer-control-offline");
    }
    if (session.viewerMedia === peer) {
      session.viewerMedia = undefined;
      session.waitingKey = true;
    }
    broadcastState(session);
  }

  function connected(socket: WebSocket, channel: Channel) {
    const peer: Peer = {
      socket,
      channel,
      lastSeen: now(),
      authDeadline: now() + 5_000,
      requests: 0,
      requestWindow: now(),
      inputWindow: now(),
      inputs: 0,
    };
    peers.add(peer);
    socket.on("pong", () => {
      peer.lastSeen = now();
    });
    socket.on("message", (data, binary) => {
      try {
        peer.lastSeen = now();
        if (!binary) {
          if (data.toString().length > 4096)
            throw new Error("Request too large.");
          const message = parseClientMessage(data.toString());
          if (message.type === "input") {
            if (now() - peer.inputWindow >= 1_000) {
              peer.inputWindow = now();
              peer.inputs = 0;
            }
            if (++peer.inputs > 120) throw new Error("Too many input events.");
          } else {
            if (now() - peer.requestWindow >= 10_000) {
              peer.requestWindow = now();
              peer.requests = 0;
            }
            if (++peer.requests > 60) throw new Error("Too many requests.");
          }
          control(peer, message);
        } else media(peer, rawBytes(data));
      } catch (error) {
        fail(peer, "protocol", errorText(error));
      }
    });
    socket.on("close", () => disconnected(peer));
    socket.on("error", (error) => {
      console.error("WebSocket transport error:", error.message);
      socket.terminate();
    });
  }

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const path = new URL(request.url ?? "/", publicOrigin).pathname;
    if (
      (path !== "/ws/control" && path !== "/ws/media") ||
      !request.headers.origin ||
      !allowedOrigins.has(request.headers.origin) ||
      peers.size >= 256
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) =>
      connected(ws, path === "/ws/control" ? "control" : "media"),
    );
  });

  function sweep() {
    identity.sweep();
    for (const session of sessions.values()) {
      if (now() >= session.expiresAt) end(session, "expired");
      else if (
        session.offlineAt !== undefined &&
        now() - session.offlineAt >= offlineMs
      )
        end(session, "host-offline");
    }
    for (const peer of peers) {
      if (
        (!peer.session && now() >= peer.authDeadline) ||
        now() - peer.lastSeen >= offlineMs
      ) {
        peer.socket.terminate();
      } else if (peer.socket.readyState === WebSocket.OPEN) peer.socket.ping();
    }
  }
  const interval = setInterval(sweep, HEARTBEAT_MS);
  interval.unref();

  return {
    server,
    sweep,
    sessionCount: () => sessions.size,
    async close() {
      clearInterval(interval);
      for (const session of sessions.values()) end(session, "relay-shutdown");
      for (const peer of peers) peer.socket.terminate();
      await new Promise<void>((done) => wss.close(() => done()));
      if (server.listening)
        await new Promise<void>((done, reject) =>
          server.close((error) => (error ? reject(error) : done())),
        );
    },
  };
}
