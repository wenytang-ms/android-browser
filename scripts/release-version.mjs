import { appendFile, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export function parseReleaseVersion(input) {
  const version = input.replace(/^v/, "");
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(
      version,
    );
  if (
    !match ||
    match[0] !== version ||
    match.slice(1, 4).some((part) => Number(part) > 65535) ||
    match.slice(1, 4).every((part) => Number(part) === 0) ||
    match[4]?.split(".").some((part) => /^\d+$/.test(part) && /^0\d/.test(part))
  )
    throw new Error(
      "Use major.minor.patch[-prerelease], with Chrome version components from 0 to 65535 and a non-zero version.",
    );
  return {
    version,
    chromeVersion: match.slice(1, 4).join("."),
    tag: `v${version}`,
    prerelease: match[4] !== undefined,
    archive: `tango-android-share-${version}.zip`,
  };
}

export async function stampReleaseVersion(input, root) {
  const release = parseReleaseVersion(input);
  const files = [
    "package.json",
    "package-lock.json",
    "extension/public/manifest.json",
  ];
  const values = await Promise.all(
    files.map(async (file) =>
      JSON.parse(await readFile(new URL(file, root), "utf8")),
    ),
  );
  values[0].version = release.version;
  values[1].version = release.version;
  values[1].packages[""].version = release.version;
  values[2].version = release.chromeVersion;
  values[2].version_name = release.version;
  await Promise.all(
    files.map((file, index) =>
      writeFile(
        new URL(file, root),
        `${JSON.stringify(values[index], null, 2)}\n`,
      ),
    ),
  );
  return release;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const release = await stampReleaseVersion(
    process.argv[2] ?? "",
    new URL("../", import.meta.url),
  );
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      Object.entries(release)
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  console.log(
    `Release ${release.tag}; Chrome version ${release.chromeVersion}.`,
  );
}
