import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const checksum =
  "108d1bd50c494c0a9f74234190f92df56c0929d6b50ae52a1f4df87404d21e76";
const cache = new URL("extension/public/scrcpy-license.txt", root);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
let license;
try {
  license = await readFile(cache);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  const response = await fetch(
    "https://raw.githubusercontent.com/Genymobile/scrcpy/v2.1/LICENSE",
    { signal: AbortSignal.timeout(60_000) },
  );
  if (!response.ok)
    throw new Error(`License download failed: ${response.status}`);
  license = Buffer.from(await response.arrayBuffer());
}
if (hash(license) !== checksum)
  throw new Error("scrcpy license checksum mismatch.");
await mkdir(new URL("extension/public/", root), { recursive: true });
await writeFile(cache, license);
const lock = JSON.parse(
  await readFile(new URL("package-lock.json", root), "utf8"),
);
const sections = [
  "scrcpy-server 2.1\nhttps://github.com/Genymobile/scrcpy/tree/v2.1\n\n" +
    license.toString("utf8"),
];
for (const [path, metadata] of Object.entries(lock.packages)) {
  if (!path || metadata.dev) continue;
  const directory = new URL(`${path}/`, root);
  const names = (await readdir(directory)).filter((name) =>
    /^(license|licence|copying)(\..*)?$/i.test(name),
  );
  if (!names.length) throw new Error(`Missing redistribution license: ${path}`);
  for (const name of names) {
    sections.push(
      `${path} ${metadata.version} (${metadata.license})\n\n` +
        (await readFile(new URL(name, directory), "utf8")),
    );
  }
}
for (const path of ["extension/public/", "viewer/public/"]) {
  const directory = new URL(path, root);
  await mkdir(directory, { recursive: true });
  await writeFile(
    new URL("third-party-notices.txt", directory),
    sections.join("\n\n" + "=".repeat(72) + "\n\n"),
  );
}
console.log("Bundled third-party redistribution notices.");
