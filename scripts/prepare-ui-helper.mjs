import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const source = new URL("android/ui-helper/UiTreeServer.java", root);
const toolsFile = new URL("android/ui-helper/tools.json", root);
const tools = JSON.parse(await readFile(toolsFile, "utf8"));
const cache = fileURLToPath(
  new URL("node_modules/.cache/tango-ui-build/", root),
);
const target = fileURLToPath(new URL("extension/public/ui-helper.jar", root));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceHash = hash(
  Buffer.concat([
    await readFile(source),
    await readFile(toolsFile),
    await readFile(new URL(import.meta.url)),
  ]),
);
const stampFile = join(cache, "build.json");
try {
  const stamp = JSON.parse(await readFile(stampFile, "utf8"));
  if (
    stamp.sourceHash === sourceHash &&
    hash(await readFile(target)) === stamp.artifactHash
  ) {
    console.log("Bundled cached UI tree helper.");
    process.exit(0);
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
await mkdir(cache, { recursive: true });
const executable = (name) =>
  process.env.JAVA_HOME
    ? join(
        process.env.JAVA_HOME,
        "bin",
        `${name}${process.platform === "win32" ? ".exe" : ""}`,
      )
    : name;
const run = (name, args, cwd = cache) =>
  execFileSync(executable(name), args, { cwd, stdio: "inherit" });
run("javac", ["-version"]);
async function download(tool) {
  const path = join(cache, basename(new URL(tool.url).pathname));
  try {
    if (hash(await readFile(path)) !== tool.sha256)
      throw new Error(`Build tool checksum mismatch: ${path}`);
    return path;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const response = await fetch(tool.url, {
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok)
    throw new Error(`Android build tool download failed: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (hash(bytes) !== tool.sha256)
    throw new Error("Android build tool checksum mismatch.");
  await writeFile(path, bytes);
  return path;
}
const platformZip = await download(tools.platform);
const r8 = await download(tools.r8);
run("jar", ["xf", platformZip, tools.platform.entry]);
const androidJar = join(cache, ...tools.platform.entry.split("/"));
const build = join(cache, "build");
await rm(build, { recursive: true, force: true });
const classes = join(build, "classes");
const dex = join(build, "dex");
await mkdir(classes, { recursive: true });
await mkdir(dex, { recursive: true });
run("javac", [
  "--release",
  "8",
  "-encoding",
  "UTF-8",
  "-classpath",
  androidJar,
  "-d",
  classes,
  fileURLToPath(source),
]);
const classJar = join(build, "classes.jar");
run("jar", [
  "--create",
  "--file",
  classJar,
  "--no-manifest",
  "-C",
  classes,
  ".",
]);
run("java", [
  "-cp",
  r8,
  "com.android.tools.r8.D8",
  "--release",
  "--min-api",
  "24",
  "--lib",
  androidJar,
  "--output",
  dex,
  classJar,
]);
await mkdir(new URL("extension/public/", root), { recursive: true });
const timestamp = new Date("2020-01-01T00:00:00Z");
await utimes(join(dex, "classes.dex"), timestamp, timestamp);
run("jar", [
  "-J-Duser.timezone=UTC",
  "--create",
  "--file",
  target,
  "--no-manifest",
  "-C",
  dex,
  "classes.dex",
]);
await writeFile(
  stampFile,
  JSON.stringify({ sourceHash, artifactHash: hash(await readFile(target)) }),
);
console.log(
  "Bundled on-demand UI tree and node action helper (Android 7+, protocol 2).",
);
