import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { build } from "vite";
import { WebSocket } from "ws";
import { createRelay } from "../dist/relay/relay/server.js";
import { encodeMedia } from "../dist/relay/shared/protocol.js";
import { googleFixture } from "../tests/google-fixture.ts";

const executablePath =
  process.env.CHROME_PATH ??
  [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].find(existsSync);
if (!executablePath)
  throw new Error("Set CHROME_PATH to a local Chrome/Chromium executable.");
const profile = await mkdtemp(resolve("node_modules/.tango-browser-"));
let browser;
let relay;
let hostControl;
let hostMedia;
let fixtureDirectory;

function connect(url, authentication) {
  return new Promise((done, reject) => {
    const socket = new WebSocket(url, {
      origin: "chrome-extension://smoke-test",
    });
    socket.once("error", reject);
    socket.once("open", () => socket.send(JSON.stringify(authentication)));
    socket.on("message", (bytes, binary) => {
      if (binary) return;
      const message = JSON.parse(bytes.toString());
      if (message.type === "created" || message.type === "ready")
        done({ socket, message });
      else if (message.type === "error") reject(new Error(message.message));
    });
  });
}

try {
  fixtureDirectory = await mkdtemp(
    resolve("node_modules", ".tango-extension-"),
  );
  await build({
    mode: "extension",
    logLevel: "error",
    plugins: [
      {
        name: "synthetic-browser-device",
        enforce: "pre",
        resolveId(source, importer) {
          if (
            source === "./device.js" &&
            importer &&
            resolve(importer) === resolve("src", "extension", "main.ts")
          )
            return resolve("tests", "browser-device.ts");
        },
      },
    ],
    build: { outDir: fixtureDirectory },
  });
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--enable-unsafe-extension-debugging"],
  });
  browser = context.browser();
  if (!browser) throw new Error("Persistent browser context unavailable");
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const cdp = await browser.newBrowserCDPSession();
  const extension = await cdp.send("Extensions.loadUnpacked", {
    path: resolve("dist/extension"),
  });
  const google = await googleFixture();
  const fixtureExtension = await cdp.send("Extensions.loadUnpacked", {
    path: fixtureDirectory,
  });
  const extensionPage = await context.newPage();
  const extensionErrors = [];
  extensionPage.on("pageerror", (error) => extensionErrors.push(error.message));
  await extensionPage.goto(`chrome-extension://${extension.id}/index.html`);
  await extensionPage.locator("#connect").waitFor();
  assert.equal(await extensionPage.locator("#connect").isEnabled(), true);
  assert.equal(await extensionPage.locator("#share").isDisabled(), true);
  assert.equal(await extensionPage.locator("#screen-off").isDisabled(), true);
  assert.equal(await extensionPage.locator("#screen-on").isDisabled(), true);
  assert.equal(extensionErrors.length, 0, extensionErrors.join("; "));
  console.log(
    "MV3 extension: unpacked load, bundled SDK, CSP and initial device UI passed.",
  );
  const fixture = await extensionPage.evaluate(async () => {
    const canvas = new OffscreenCanvas(64, 64);
    const context = canvas.getContext("2d");
    context.fillStyle = "#24a86b";
    context.fillRect(0, 0, 64, 64);
    let bytes;
    let failure;
    const encoder = new VideoEncoder({
      output(chunk) {
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        bytes = Array.from(data);
      },
      error(error) {
        failure = error.message;
      },
    });
    encoder.configure({
      codec: "avc1.42E01E",
      width: 64,
      height: 64,
      bitrate: 500_000,
      framerate: 30,
      latencyMode: "realtime",
      avc: { format: "annexb" },
    });
    const frame = new VideoFrame(canvas, { timestamp: 0 });
    encoder.encode(frame, { keyFrame: true });
    frame.close();
    await encoder.flush();
    encoder.close();
    if (failure || !bytes)
      throw new Error(failure ?? "No H.264 fixture produced");
    return bytes;
  });

  const encoded = new Uint8Array(fixture);
  const units = [];
  for (let i = 0; i < encoded.length - 3; i++) {
    if (encoded[i] === 0 && encoded[i + 1] === 0) {
      const prefix =
        encoded[i + 2] === 1
          ? 3
          : encoded[i + 2] === 0 && encoded[i + 3] === 1
            ? 4
            : 0;
      if (prefix) {
        units.push({ start: i, type: encoded[i + prefix] & 31 });
        i += prefix - 1;
      }
    }
  }
  const parameterSets = units.flatMap((unit, i) =>
    unit.type === 7 || unit.type === 8
      ? Array.from(
          encoded.subarray(unit.start, units[i + 1]?.start ?? encoded.length),
        )
      : [],
  );
  assert(parameterSets.length > 0, "Encoder must provide Annex-B SPS/PPS");
  relay = createRelay({
    publicUrl: "http://localhost:3000",
    viewerDir: resolve("dist/viewer"),
    extensionOrigins: ["chrome-extension://smoke-test"],
    google: google.options,
  });
  await new Promise((done) => relay.server.listen(0, "127.0.0.1", done));
  const port = relay.server.address().port;
  const origin = `http://localhost:${port}`;
  // The test uses the dynamically bound same-origin viewer.
  await relay.close();
  relay = createRelay({
    publicUrl: origin,
    viewerDir: resolve("dist/viewer"),
    extensionOrigins: [
      "chrome-extension://smoke-test",
      `chrome-extension://${extension.id}`,
      `chrome-extension://${fixtureExtension.id}`,
    ],
    google: google.options,
  });
  await new Promise((done) => relay.server.listen(port, "127.0.0.1", done));
  const ticket = await google.ticket(
    origin,
    "owner",
    {},
    `chrome-extension://${extension.id}`,
  );
  const extensionLogin = await extensionPage.evaluate(
    async ({ origin, ticket }) => {
      const response = await fetch(`${origin}/auth/exchange`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: ticket.code, verifier: ticket.verifier }),
      });
      if (!response.ok) throw new Error("Extension account exchange failed.");
      const account = await response.json();
      const revoked = await fetch(`${origin}/auth/logout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountToken: account.accountToken }),
      });
      return revoked.status;
    },
    { origin, ticket },
  );
  assert.equal(
    extensionLogin,
    204,
    "MV3 must exchange and revoke verified identity with real extension Origin.",
  );
  await context.route(
    (url) => url.origin === origin && url.pathname === "/auth/start",
    async (route) => {
      const response = await route.fetch({ maxRedirects: 0 });
      assert.equal(response.status(), 302);
      const url = new URL(response.headers().location);
      const callback = new URL("/auth/callback", origin);
      callback.search = new URLSearchParams({
        state: url.searchParams.get("state"),
        code: google.issueCode(url, "owner"),
      }).toString();
      await route.fulfill({
        status: 302,
        headers: { Location: callback.href },
      });
    },
  );
  const accountToken = await google.login(origin, "owner", origin);
  const created = await connect(`ws://localhost:${port}/ws/control`, {
    v: 1,
    type: "create",
    deploymentToken: "",
    accountToken,
  });
  hostControl = created.socket;
  const credentials = created.message;
  hostMedia = (
    await connect(`ws://localhost:${port}/ws/media`, {
      v: 1,
      type: "auth",
      role: "host",
      session: credentials.session,
      token: credentials.hostToken,
      accountToken,
    })
  ).socket;
  const paired = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Viewer media pairing timed out")),
      15_000,
    );
    hostControl.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "resync") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await page.goto(`${origin}/?session=${credentials.session}`);
  await page.locator("#join").waitFor();
  assert.equal(
    new URL(page.url()).hash,
    "",
    "Sharing link must not contain credentials",
  );
  await page.locator("#join").click();
  await paired.catch(async (error) => {
    console.error(
      "Viewer login status:",
      await page
        .locator("#status")
        .textContent()
        .catch(() => "unavailable"),
    );
    console.error("Viewer route:", new URL(page.url()).pathname);
    console.error("Viewer runtime errors:", errors);
    throw error;
  });
  const config = {
    session: credentials.session,
    stream: 1,
    sequence: 0,
    kind: "configuration",
    keyframe: false,
    pts: 0n,
    width: 64,
    height: 64,
    data: new Uint8Array(parameterSets),
  };
  hostMedia.send(encodeMedia(config));
  for (let sequence = 1; sequence <= 15; sequence++) {
    hostMedia.send(
      encodeMedia({
        ...config,
        kind: "data",
        keyframe: true,
        sequence,
        pts: BigInt(sequence * 100_000),
        data: encoded,
      }),
    );
    await new Promise((done) => setTimeout(done, 100));
  }
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("远程播放中"),
  );
  const pixel = await page
    .locator("#screen")
    .evaluate((canvas) =>
      Array.from(canvas.getContext("2d").getImageData(20, 20, 1, 1).data),
    );
  assert(
    pixel[1] > pixel[0] && pixel[1] > pixel[2],
    "Viewer must render the relayed green H.264 frame",
  );
  const inputs = [];
  hostControl.on("message", (data) => {
    const message = JSON.parse(data.toString());
    if (message.type === "input") inputs.push(message.event);
  });
  await page.bringToFront();
  await page.locator("#screen").click();
  const remoteBounds = await page.locator("#screen").boundingBox();
  assert(remoteBounds, "Remote canvas must be visible.");
  await page.mouse.move(remoteBounds.x + 10, remoteBounds.y + 10);
  await page.mouse.down();
  await page.mouse.move(remoteBounds.x + 45, remoteBounds.y + 45, { steps: 4 });
  await page.evaluate(() => new Promise(requestAnimationFrame));
  await page.mouse.up();
  await page.keyboard.press("ArrowRight");
  await page.locator("#input-text").fill("\u4f60\u597d");
  await page.locator("#send-text").click();
  const inputDeadline = Date.now() + 5_000;
  while (
    !inputs.some((event) => event.kind === "text") &&
    Date.now() < inputDeadline
  )
    await new Promise((done) => setTimeout(done, 25));
  assert(
    inputs.some((event) => event.kind === "touch" && event.action === "down"),
  );
  assert(
    inputs.some((event) => event.kind === "touch" && event.action === "up"),
  );
  assert(
    inputs.some((event) => event.kind === "touch" && event.action === "move"),
  );
  assert(inputs.some((event) => event.kind === "key" && event.keyCode === 22));
  assert(
    inputs.some(
      (event) => event.kind === "text" && event.text === "\u4f60\u597d",
    ),
  );
  hostControl.send(JSON.stringify({ v: 1, type: "end" }));
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("撤销"),
  );
  await page.goto(`${origin}/?session=${credentials.session}`);
  await page.locator("#join").click();
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("会话不存在"),
  );
  assert.equal(await page.locator("#back").isDisabled(), true);
  assert.equal(await page.locator("#input-text").isDisabled(), true);
  assert.equal(errors.length, 0, `Viewer runtime errors: ${errors.join("; ")}`);
  console.log(
    "Browser viewer: signed identity flow, real H.264, touch/key/text controls and revocation passed (synthetic Google/Android fixtures).",
  );
  const localPage = await context.newPage();
  localPage.on("pageerror", (error) => extensionErrors.push(error.message));
  await localPage.exposeFunction("fixtureLogin", async (startUrl) => {
    const response = await fetch(startUrl, { redirect: "manual" });
    assert.equal(response.status, 302);
    const authorization = new URL(response.headers.get("location"));
    const callback = new URL("/auth/callback", origin);
    callback.search = new URLSearchParams({
      state: authorization.searchParams.get("state"),
      code: google.issueCode(authorization, "owner"),
    }).toString();
    const result = await fetch(callback, { redirect: "manual" });
    assert.equal(result.status, 302);
    return result.headers.get("location");
  });
  await localPage.goto(`chrome-extension://${fixtureExtension.id}/index.html`);
  await localPage.evaluate(
    ({ parameterSets, fixture }) => {
      globalThis.tangoFixture.configuration = parameterSets;
      globalThis.tangoFixture.frame = fixture;
      chrome.identity.launchWebAuthFlow = ({ url }) =>
        globalThis.fixtureLogin(url);
    },
    { parameterSets, fixture },
  );
  assert.equal(await localPage.locator("#local-back").isDisabled(), true);
  await localPage.locator("#connect").click();
  await localPage.waitForFunction(
    () =>
      !document.querySelector("#local-back").disabled &&
      !document.querySelector("#local-controls").disabled,
  );
  await localPage.evaluate(() => {
    globalThis.tangoFixture.failScreenPower = true;
  });
  await localPage.locator("#screen-off").click();
  await localPage.waitForFunction(() =>
    document
      .querySelector("#device-status")
      .textContent.includes("Synthetic display write failed"),
  );
  assert.equal(await localPage.locator("#local-back").isEnabled(), true);
  await localPage.evaluate(() => {
    globalThis.tangoFixture.failScreenPower = false;
  });
  await localPage.locator("#screen-off").click();
  await localPage.waitForFunction(() =>
    document.querySelector("#screen-status").textContent.includes("已请求息屏"),
  );
  await localPage.locator("#screen").click();
  const bounds = await localPage.locator("#screen").boundingBox();
  assert(bounds, "Local canvas must be visible.");
  await localPage.mouse.move(bounds.x + 10, bounds.y + 10);
  await localPage.mouse.down();
  await localPage.mouse.move(bounds.x + 45, bounds.y + 45, { steps: 4 });
  await localPage.waitForFunction(() =>
    globalThis.tangoFixture.inputs.some(
      ({ event }) => event.kind === "touch" && event.action === "move",
    ),
  );
  await localPage.mouse.up();
  await localPage.keyboard.press("ArrowRight");
  await localPage.locator("#local-text").fill("\u4f60\u597d");
  await localPage.locator("#local-send-text").click();
  const localEvents = await localPage.evaluate(() =>
    globalThis.tangoFixture.inputs
      .filter(({ source }) => source === "local")
      .map(({ event }) => event),
  );
  assert(
    localEvents.some(
      (event) => event.kind === "touch" && event.action === "down",
    ),
  );
  assert(
    localEvents.some(
      (event) => event.kind === "touch" && event.action === "up",
    ),
  );
  assert(
    localEvents.some((event) => event.kind === "key" && event.keyCode === 22),
  );
  assert(
    localEvents.some(
      (event) => event.kind === "text" && event.text === "\u4f60\u597d",
    ),
  );
  await localPage.locator("#relay").fill(origin);
  await localPage.locator("#share").click();
  await localPage.waitForFunction(
    () => !!document.querySelector("#link").value,
  );
  assert.equal(await localPage.locator("#remote-control").isChecked(), true);
  await page.goto(await localPage.locator("#link").inputValue());
  await page.locator("#join").click();
  await page.waitForFunction(
    () => !document.querySelector("#controls").disabled,
  );
  await localPage.locator("#screen-on").click();
  await localPage.waitForFunction(() =>
    document
      .querySelector("#screen-status")
      .textContent.includes("已请求恢复显示"),
  );
  await localPage.locator("#screen-off").click();
  await localPage.waitForFunction(() =>
    document.querySelector("#screen-status").textContent.includes("已请求息屏"),
  );
  assert.equal(await localPage.locator("#remote-control").isChecked(), true);
  await page.bringToFront();
  await page.locator("#screen").click();
  await page.keyboard.press("ArrowDown");
  await localPage.waitForFunction(() =>
    globalThis.tangoFixture.inputs.some(
      ({ source, event }) =>
        source === "remote" && event.kind === "key" && event.keyCode === 20,
    ),
  );
  await localPage.locator("#screen").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#controls").disabled &&
      document.querySelector("#status").textContent.includes("只读"),
  );
  assert.equal(await localPage.locator("#remote-control").isChecked(), false);
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("远程播放中（只读"),
  );
  const remoteCount = await localPage.evaluate(
    () =>
      globalThis.tangoFixture.inputs.filter(({ source }) => source === "remote")
        .length,
  );
  await page.locator("#screen").click();
  await page.keyboard.press("ArrowUp");
  await localPage.locator("#local-home").click();
  assert.equal(
    await localPage.evaluate(
      () =>
        globalThis.tangoFixture.inputs.filter(
          ({ source }) => source === "remote",
        ).length,
    ),
    remoteCount,
  );
  await localPage.locator("#remote-control").check();
  await page.waitForFunction(
    () => !document.querySelector("#controls").disabled,
  );
  await page.locator("#screen").click();
  await page.keyboard.press("ArrowUp");
  await localPage.waitForFunction(() =>
    globalThis.tangoFixture.inputs.some(
      ({ source, event }) =>
        source === "remote" && event.kind === "key" && event.keyCode === 19,
    ),
  );
  await localPage.locator("#screen").focus();
  await localPage.keyboard.press("ArrowLeft");
  await page.waitForFunction(
    () => document.querySelector("#controls").disabled,
  );
  assert.equal(await localPage.locator("#remote-control").isChecked(), false);
  await localPage.locator("#remote-control").check();
  await page.waitForFunction(
    () => !document.querySelector("#controls").disabled,
  );
  await localPage.locator("#local-text").fill("local takeover");
  await localPage.locator("#local-send-text").click();
  await page.waitForFunction(
    () => document.querySelector("#controls").disabled,
  );
  assert.equal(await localPage.locator("#remote-control").isChecked(), false);
  await localPage.locator("#unshare").click();
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("撤销"),
  );
  assert.equal(await localPage.locator("#local-home").isEnabled(), true);
  assert(
    (await localPage.locator("#screen-status").textContent()).includes(
      "已请求息屏",
    ),
    "Stopping only remote sharing must not change the phone display mode.",
  );
  await localPage.locator("#stop").click();
  assert.equal(await localPage.locator("#local-home").isDisabled(), true);
  assert.equal(await localPage.locator("#screen-off").isDisabled(), true);
  assert.equal(await localPage.locator("#screen-on").isDisabled(), true);
  assert.equal(
    await localPage.evaluate(() =>
      globalThis.tangoFixture.screenPowerRequests.at(-1),
    ),
    false,
  );
  await localPage.locator("#start").click();
  await localPage.waitForFunction(
    () => !document.querySelector("#local-controls").disabled,
  );
  assert(
    (await localPage.locator("#screen-status").textContent()).includes(
      "已请求恢复显示",
    ),
  );
  assert.equal(
    extensionErrors.length,
    0,
    `Extension runtime errors: ${extensionErrors.join("; ")}`,
  );
  assert.equal(errors.length, 0, `Viewer runtime errors: ${errors.join("; ")}`);
  console.log(
    "Browser host: local/remote input, display-off controls and error reporting, local takeover, read-only video, remote re-enable and lifecycle passed (synthetic device session).",
  );
} finally {
  hostControl?.terminate();
  hostMedia?.terminate();
  await relay?.close();
  await browser?.close();
  await rm(profile, { recursive: true, force: true });
  if (fixtureDirectory)
    await rm(fixtureDirectory, { recursive: true, force: true });
}
