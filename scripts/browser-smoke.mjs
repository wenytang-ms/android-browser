import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { WebSocket } from "ws";
import { createRelay } from "../dist/relay/relay/server.js";
import { encodeMedia } from "../dist/relay/shared/protocol.js";

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
  const extensionPage = await context.newPage();
  const extensionErrors = [];
  extensionPage.on("pageerror", (error) => extensionErrors.push(error.message));
  await extensionPage.goto(`chrome-extension://${extension.id}/index.html`);
  await extensionPage.locator("#connect").waitFor();
  assert.equal(await extensionPage.locator("#connect").isEnabled(), true);
  assert.equal(await extensionPage.locator("#share").isDisabled(), true);
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
  });
  await new Promise((done) => relay.server.listen(0, "127.0.0.1", done));
  const port = relay.server.address().port;
  const origin = `http://localhost:${port}`;
  // The test uses the dynamically bound same-origin viewer.
  await relay.close();
  relay = createRelay({
    publicUrl: origin,
    viewerDir: resolve("dist/viewer"),
    extensionOrigins: ["chrome-extension://smoke-test"],
  });
  await new Promise((done) => relay.server.listen(port, "127.0.0.1", done));
  const created = await connect(`ws://localhost:${port}/ws/control`, {
    v: 1,
    type: "create",
    deploymentToken: "",
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
    })
  ).socket;
  const paired = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Viewer media pairing timed out")),
      5_000,
    );
    hostControl.on("message", (data) => {
      if (JSON.parse(data.toString()).type === "resync") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await page.goto(
    `${origin}/?session=${credentials.session}#token=${credentials.viewerToken}`,
  );
  await page.locator("#join").waitFor();
  assert.equal(
    new URL(page.url()).hash,
    "",
    "Viewer must strip credential fragment",
  );
  await page.locator("#join").click();
  await page
    .locator("#status")
    .filter({ hasText: /等待|在线/ })
    .waitFor();
  await paired;
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
  hostControl.send(JSON.stringify({ v: 1, type: "end" }));
  await page.waitForFunction(() =>
    document.querySelector("#status").textContent.includes("撤销"),
  );
  await page.goto(`${origin}/?session=${credentials.session}`);
  await page.waitForFunction(() => document.querySelector("#join").disabled);
  assert.equal(errors.length, 0, `Viewer runtime errors: ${errors.join("; ")}`);
  console.log(
    "Browser viewer: real H.264 decode, rendering, credential stripping and revocation passed.",
  );
} finally {
  hostControl?.terminate();
  hostMedia?.terminate();
  await relay?.close();
  await browser?.close();
  await rm(profile, { recursive: true, force: true });
}
