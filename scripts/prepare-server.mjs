import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const url =
  "https://github.com/Genymobile/scrcpy/releases/download/v2.1/scrcpy-server-v2.1";
const checksum =
  "5b8bf1940264b930c71a1c614c57da2247f52b2d4240bca865cc6d366dff6688";
const target = new URL(
  "../extension/public/scrcpy-server.jar",
  import.meta.url,
);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

try {
  if (hash(await readFile(target)) === checksum) process.exit(0);
  throw new Error(
    "Existing scrcpy JAR checksum mismatch; remove it and retry.",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const response = await fetch(url, {
  signal: AbortSignal.timeout(60_000),
});
if (!response.ok) throw new Error(`scrcpy download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (hash(bytes) !== checksum) throw new Error("scrcpy JAR checksum mismatch.");
await mkdir(new URL("../extension/public/", import.meta.url), {
  recursive: true,
});
await writeFile(target, bytes);
console.log("Bundled verified scrcpy-server 2.1.");
