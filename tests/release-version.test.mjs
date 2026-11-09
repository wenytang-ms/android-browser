import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parseReleaseVersion,
  stampReleaseVersion,
} from "../scripts/release-version.mjs";

describe("Chrome release versioning", () => {
  it("maps alpha and stable releases to valid numeric Chrome versions", () => {
    expect(parseReleaseVersion("v0.0.1-alpha")).toEqual({
      version: "0.0.1-alpha",
      chromeVersion: "0.0.1",
      tag: "v0.0.1-alpha",
      prerelease: true,
      archive: "tango-android-share-0.0.1-alpha.zip",
    });
    expect(parseReleaseVersion("1.2.3")).toMatchObject({
      chromeVersion: "1.2.3",
      prerelease: false,
    });
  });

  it("rejects invalid versions and path or shell input", () => {
    for (const version of [
      "",
      "0.0.0",
      "01.0.1",
      "65536.0.1",
      "0.0.1-alpha.01",
      "../0.0.1",
      "0.0.1;echo secret",
      "0.0.1\n",
      "0.0.1\nINJECTED=value",
    ])
      expect(() => parseReleaseVersion(version)).toThrow();
  });

  it("keeps the package, lockfile and Chrome display version consistent", async () => {
    const directory = await mkdtemp(
      join(process.cwd(), "node_modules", ".release-version-"),
    );
    const root = pathToFileURL(`${directory}${sep}`);
    try {
      await mkdir(new URL("extension/public/", root), { recursive: true });
      await writeFile(new URL("package.json", root), '{"version":"0.1.0"}');
      await writeFile(
        new URL("package-lock.json", root),
        '{"version":"0.1.0","packages":{"":{"version":"0.1.0"}}}',
      );
      await writeFile(
        new URL("extension/public/manifest.json", root),
        '{"version":"0.1.0","manifest_version":3}',
      );
      await stampReleaseVersion("0.0.1-alpha", root);
      const read = async (file) =>
        JSON.parse(await readFile(new URL(file, root), "utf8"));
      expect((await read("package.json")).version).toBe("0.0.1-alpha");
      expect((await read("package-lock.json")).packages[""].version).toBe(
        "0.0.1-alpha",
      );
      expect(await read("extension/public/manifest.json")).toMatchObject({
        manifest_version: 3,
        version: "0.0.1",
        version_name: "0.0.1-alpha",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
