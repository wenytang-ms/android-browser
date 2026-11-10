import { createHash, randomBytes } from "node:crypto";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import type { JWTPayload } from "jose";
import type { GoogleAuthOptions } from "../src/relay/auth.js";

export async function googleFixture() {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const clientId = "fixture.apps.googleusercontent.com";
  const codes = new Map<
    string,
    { nonce: string; challenge: string; subject: string; claims: JWTPayload }
  >();
  const options: GoogleAuthOptions = {
    clientId,
    clientSecret: "fixture-not-a-real-secret",
    keySet: createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), kid: "fixture", alg: "RS256" }],
    }),
    tokenFetch: async (_url, init) => {
      const request = new URLSearchParams(String(init?.body));
      const code = request.get("code") ?? "";
      const value = codes.get(code);
      codes.delete(code);
      if (
        !value ||
        hash(request.get("code_verifier") ?? "") !== value.challenge
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      const token = await new SignJWT({
        iss: "https://accounts.google.com",
        aud: clientId,
        sub: value.subject,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 300,
        nonce: value.nonce,
        ...value.claims,
      })
        .setProtectedHeader({ alg: "RS256", kid: "fixture" })
        .sign(privateKey);
      if (value.claims.fixture_bad_signature) {
        const parts = token.split(".");
        parts[2] = (parts[2][0] === "a" ? "b" : "a") + parts[2].slice(1);
        return Response.json({ id_token: parts.join(".") });
      }
      return Response.json({ id_token: token });
    },
  };
  function issueCode(url: URL, subject: string, claims: JWTPayload = {}) {
    const code = randomBytes(16).toString("hex");
    codes.set(code, {
      nonce: url.searchParams.get("nonce") ?? "",
      challenge: url.searchParams.get("code_challenge") ?? "",
      subject,
      claims,
    });
    return code;
  }
  async function ticket(
    base: string,
    subject: string,
    claims: JWTPayload = {},
    origin = "http://localhost:3000",
  ) {
    const verifier = randomBytes(32).toString("base64url");
    const start = new URL("/auth/start", base);
    start.search = new URLSearchParams({
      client: origin,
      challenge: hash(verifier),
    }).toString();
    const authorization = await fetch(start, { redirect: "manual" });
    const url = new URL(authorization.headers.get("location") ?? "");
    const callback = new URL("/auth/callback", base);
    callback.search = new URLSearchParams({
      state: url.searchParams.get("state") ?? "",
      code: issueCode(url, subject, claims),
    }).toString();
    const result = await fetch(callback, { redirect: "manual" });
    const destination = new URL(result.headers.get("location") ?? "");
    return {
      code: new URLSearchParams(destination.hash.slice(1)).get("code"),
      verifier,
      origin,
    };
  }
  async function exchange(
    base: string,
    value: Awaited<ReturnType<typeof ticket>>,
    verifier = value.verifier,
  ) {
    return fetch(new URL("/auth/exchange", base), {
      method: "POST",
      headers: { Origin: value.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ code: value.code, verifier }),
    });
  }
  async function login(
    base: string,
    subject = "owner",
    origin = "http://localhost:3000",
  ) {
    const response = await exchange(
      base,
      await ticket(base, subject, {}, origin),
    );
    if (!response.ok) throw new Error("Fixture login failed.");
    const data = (await response.json()) as {
      accountToken: string;
      expiresAt: number;
    };
    return data.accountToken;
  }
  return { options, login, ticket, exchange, issueCode };
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}
