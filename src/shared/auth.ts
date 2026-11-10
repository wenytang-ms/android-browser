export interface AccountLogin {
  accountToken: string;
  expiresAt: number;
}

export function hasLoginResult() {
  return sessionStorage.getItem("tango-login-result") !== null;
}

export async function login(
  base: URL,
  extension = false,
): Promise<AccountLogin> {
  let verifier: string;
  let code: string;
  if (!extension && hasLoginResult()) {
    const saved: unknown = JSON.parse(
      sessionStorage.getItem("tango-login") ?? "null",
    );
    const result: unknown = JSON.parse(
      sessionStorage.getItem("tango-login-result") ?? "null",
    );
    sessionStorage.removeItem("tango-login");
    sessionStorage.removeItem("tango-login-result");
    if (
      typeof saved !== "object" ||
      saved === null ||
      !("verifier" in saved) ||
      typeof saved.verifier !== "string" ||
      typeof result !== "object" ||
      result === null ||
      !("code" in result) ||
      typeof result.code !== "string"
    )
      throw new Error("Google 登录未完成，请重试。");
    verifier = saved.verifier;
    code = result.code;
  } else {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    verifier = base64(bytes);
    const challenge = base64(
      new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(verifier),
        ),
      ),
    );
    const start = new URL("/auth/start", base);
    start.searchParams.set(
      "client",
      extension ? `chrome-extension://${chrome.runtime.id}` : location.origin,
    );
    start.searchParams.set("challenge", challenge);
    if (extension) {
      const result = await chrome.identity.launchWebAuthFlow({
        url: start.href,
        interactive: true,
      });
      if (!result) throw new Error("已取消 Google 登录。");
      const url = new URL(result);
      const expected = new URL(chrome.identity.getRedirectURL("auth"));
      if (url.origin !== expected.origin || url.pathname !== expected.pathname)
        throw new Error("登录返回地址不匹配。");
      const params = new URLSearchParams(url.hash.slice(1));
      code = params.get("code") ?? "";
    } else {
      sessionStorage.setItem(
        "tango-login",
        JSON.stringify({
          verifier,
          returnTo: location.pathname + location.search,
        }),
      );
      // The viewer may navigate; the USB-owning extension must use launchWebAuthFlow instead.
      location.assign(start.href);
      return await new Promise<never>(() => {});
    }
  }
  if (!/^[a-f0-9]{64}$/.test(code))
    throw new Error("Google 登录失败，请重新选择账号。");
  const response = await fetch(new URL("/auth/exchange", base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, verifier }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error("登录凭据校验失败，请重新登录。");
  const result: unknown = await response.json();
  if (
    typeof result !== "object" ||
    result === null ||
    !("accountToken" in result) ||
    typeof result.accountToken !== "string" ||
    !/^[a-f0-9]{64}$/.test(result.accountToken) ||
    !("expiresAt" in result) ||
    typeof result.expiresAt !== "number" ||
    result.expiresAt <= Date.now()
  )
    throw new Error("登录响应无效。");
  return { accountToken: result.accountToken, expiresAt: result.expiresAt };
}

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export async function logout(base: URL, accountToken: string) {
  const response = await fetch(new URL("/auth/logout", base), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountToken }),
    keepalive: true,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("登录凭据注销未确认；凭据将在到期后失效。");
}
