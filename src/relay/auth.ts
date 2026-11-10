import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";

const LOGIN_MS = 5 * 60_000;
const ACCOUNT_MS = 60 * 60_000;
const MAX_LOGINS = 256;
const SECRET = /^[a-f0-9]{64}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9_-]{43,128}$/;

export interface GoogleAuthOptions {
  clientId: string;
  clientSecret: string;
  tokenFetch?: typeof fetch;
  keySet?: JWTVerifyGetKey;
}

interface Login {
  client: string;
  challenge: string;
  nonce: string;
  verifier: string;
  expiresAt: number;
}

interface Ticket {
  client: string;
  challenge: string;
  subject: string;
  expiresAt: number;
}

export interface Account {
  subject: string;
  expiresAt: number;
}

function equal(left: string, right: string) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

async function body(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > 4096) throw new Error("Request too large.");
    chunks.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString());
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid request.");
  return value as Record<string, unknown>;
}

export function createGoogleAuth(
  options: GoogleAuthOptions,
  publicOrigin: string,
  allowedOrigins: Set<string>,
  now: () => number,
  onRevoked: (token: string) => void,
) {
  if (!options.clientId || !options.clientSecret)
    throw new Error("Google OAuth client ID and secret are required.");
  const keySet =
    options.keySet ??
    createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  const tokenFetch = options.tokenFetch ?? fetch;
  const callback = new URL("/auth/callback", publicOrigin).href;
  const logins = new Map<string, Login>();
  const tickets = new Map<string, Ticket>();
  const accounts = new Map<string, Account>();
  const random = () => randomBytes(32).toString("hex");

  function revoke(token: string) {
    if (accounts.delete(token)) onRevoked(token);
  }

  function sweep() {
    for (const [key, value] of logins)
      if (now() >= value.expiresAt) logins.delete(key);
    for (const [key, value] of tickets)
      if (now() >= value.expiresAt) tickets.delete(key);
    for (const [key, value] of accounts)
      if (now() >= value.expiresAt) revoke(key);
  }

  function account(token: string): Account | undefined {
    const value = accounts.get(token);
    return value && now() < value.expiresAt ? value : undefined;
  }

  function redirectClient(
    response: ServerResponse,
    login: Login,
    code?: string,
  ) {
    const extension = /^chrome-extension:\/\/([a-p]{32})$/.exec(login.client);
    const destination = extension
      ? new URL(`https://${extension[1]}.chromiumapp.org/auth`)
      : new URL("/auth/complete", publicOrigin);
    destination.hash = new URLSearchParams({
      ...(code ? { code } : { error: "sign-in-failed" }),
      origin: login.client,
    }).toString();
    response.writeHead(302, { Location: destination.href }).end();
  }

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    if (!url.pathname.startsWith("/auth/")) return false;
    sweep();
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    const origin = request.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    }
    if (request.method === "OPTIONS") {
      response
        .writeHead(origin && allowedOrigins.has(origin) ? 204 : 403)
        .end();
      return true;
    }
    try {
      if (url.pathname === "/auth/start" && request.method === "GET") {
        const client = url.searchParams.get("client") ?? "";
        const challenge = url.searchParams.get("challenge") ?? "";
        const extension = /^chrome-extension:\/\/[a-p]{32}$/.test(client);
        if (
          !allowedOrigins.has(client) ||
          (!extension && client !== publicOrigin) ||
          !CHALLENGE.test(challenge)
        )
          throw new Error("Invalid login client.");
        if (logins.size + tickets.size + accounts.size >= MAX_LOGINS)
          throw new Error("Login capacity exceeded.");
        const state = random();
        const login: Login = {
          client,
          challenge,
          nonce: random(),
          verifier: randomBytes(32).toString("base64url"),
          expiresAt: now() + LOGIN_MS,
        };
        logins.set(state, login);
        const destination = new URL(
          "https://accounts.google.com/o/oauth2/v2/auth",
        );
        destination.search = new URLSearchParams({
          client_id: options.clientId,
          redirect_uri: callback,
          response_type: "code",
          scope: "openid",
          state,
          nonce: login.nonce,
          prompt: "select_account",
          code_challenge: digest(login.verifier),
          code_challenge_method: "S256",
        }).toString();
        response.writeHead(302, { Location: destination.href }).end();
      } else if (
        url.pathname === "/auth/callback" &&
        request.method === "GET"
      ) {
        const state = url.searchParams.get("state") ?? "";
        const login = logins.get(state);
        logins.delete(state);
        if (!login || now() >= login.expiresAt)
          throw new Error("Login expired.");
        try {
          const code = url.searchParams.get("code");
          if (!code || code.length > 4096 || url.searchParams.has("error"))
            throw new Error("Login declined.");
          const result = await tokenFetch(
            "https://oauth2.googleapis.com/token",
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                client_id: options.clientId,
                client_secret: options.clientSecret,
                grant_type: "authorization_code",
                code,
                redirect_uri: callback,
                code_verifier: login.verifier,
              }),
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (!result.ok) throw new Error("OAuth exchange failed.");
          const token: unknown = await result.json();
          if (
            typeof token !== "object" ||
            token === null ||
            !("id_token" in token) ||
            typeof token.id_token !== "string" ||
            token.id_token.length > 16_384
          )
            throw new Error("Missing ID token.");
          const { payload } = await jwtVerify(token.id_token, keySet, {
            algorithms: ["RS256"],
            audience: options.clientId,
            issuer: ["https://accounts.google.com", "accounts.google.com"],
            requiredClaims: ["sub", "exp", "iat", "nonce"],
            currentDate: new Date(now()),
            clockTolerance: 5,
          });
          if (
            payload.nonce !== login.nonce ||
            !payload.sub ||
            payload.sub.length > 255 ||
            (payload.azp !== undefined && payload.azp !== options.clientId)
          )
            throw new Error("ID token identity mismatch.");
          const ticket = random();
          tickets.set(ticket, {
            client: login.client,
            challenge: login.challenge,
            subject: payload.sub,
            expiresAt: now() + 60_000,
          });
          redirectClient(response, login, ticket);
        } catch {
          console.warn(
            "Google sign-in rejected; credentials and account identifiers omitted.",
          );
          redirectClient(response, login);
        }
      } else if (
        url.pathname === "/auth/complete" &&
        request.method === "GET"
      ) {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(
          '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Google sign-in</title><p>登录已处理，请返回原页面。</p><script src="/auth/complete.js"></script></html>',
        );
      } else if (
        url.pathname === "/auth/complete.js" &&
        request.method === "GET"
      ) {
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.end(`const result = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, "", location.pathname);
try {
  const saved = JSON.parse(sessionStorage.getItem("tango-login") || "null");
  if (!saved || typeof saved.returnTo !== "string" || result.get("origin") !== location.origin) throw new Error();
  const target = new URL(saved.returnTo, location.origin);
  if (target.origin !== location.origin || target.pathname !== "/" || !/^[a-f0-9]{32}$/.test(target.searchParams.get("session") || "")) throw new Error();
  sessionStorage.setItem("tango-login-result", JSON.stringify({ code: result.get("code"), error: result.get("error") }));
  location.replace(target.href);
} catch {
  document.querySelector("p").textContent = "登录会话已失效，请关闭此页并重新打开共享链接。";
}`);
      } else if (
        (url.pathname === "/auth/exchange" ||
          url.pathname === "/auth/logout") &&
        request.method === "POST"
      ) {
        if (
          !origin ||
          !allowedOrigins.has(origin) ||
          !request.headers["content-type"]?.startsWith("application/json")
        )
          throw new Error("Invalid request origin.");
        const value = await body(request);
        if (url.pathname === "/auth/logout") {
          if (
            typeof value.accountToken !== "string" ||
            !SECRET.test(value.accountToken)
          )
            throw new Error("Invalid credential.");
          revoke(value.accountToken);
          response.writeHead(204).end();
        } else {
          if (
            typeof value.code !== "string" ||
            !SECRET.test(value.code) ||
            typeof value.verifier !== "string" ||
            !VERIFIER.test(value.verifier)
          )
            throw new Error("Invalid ticket.");
          const ticket = tickets.get(value.code);
          tickets.delete(value.code);
          if (
            !ticket ||
            now() >= ticket.expiresAt ||
            ticket.client !== origin ||
            !equal(ticket.challenge, digest(value.verifier))
          )
            throw new Error("Login proof mismatch.");
          const token = random();
          const expiresAt = now() + ACCOUNT_MS;
          accounts.set(token, { subject: ticket.subject, expiresAt });
          response.setHeader("Content-Type", "application/json");
          response.end(JSON.stringify({ accountToken: token, expiresAt }));
        }
      } else response.writeHead(404).end("Not found");
    } catch {
      response.setHeader("Content-Type", "application/json");
      response
        .writeHead(400)
        .end(JSON.stringify({ error: "登录失败或已过期，请重新登录。" }));
    }
    return true;
  }
  return { handle, account, sweep };
}
