// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getPlatformSpec } from "../../scripts/download-node.mjs";

describe("download-node getPlatformSpec", () => {
  it("maps explicit darwin arches to the matching distribution", () => {
    expect(getPlatformSpec("22.12.0", "darwin", "x64")).toEqual({
      name: "node-v22.12.0-darwin-x64",
      ext: "tar.gz",
    });
    expect(getPlatformSpec("22.12.0", "darwin", "arm64")).toEqual({
      name: "node-v22.12.0-darwin-arm64",
      ext: "tar.gz",
    });
  });

  it("maps linux arches to the matching distribution", () => {
    expect(getPlatformSpec("22.12.0", "linux", "x64")).toEqual({
      name: "node-v22.12.0-linux-x64",
      ext: "tar.gz",
    });
    expect(getPlatformSpec("22.12.0", "linux", "arm64")).toEqual({
      name: "node-v22.12.0-linux-arm64",
      ext: "tar.gz",
    });
  });

  it("maps win32 arches to the zip distribution", () => {
    expect(getPlatformSpec("22.12.0", "win32", "x64")).toEqual({
      name: "node-v22.12.0-win-x64",
      ext: "zip",
    });
    expect(getPlatformSpec("22.12.0", "win32", "arm64")).toEqual({
      name: "node-v22.12.0-win-arm64",
      ext: "zip",
    });
  });

  it("defaults platform/arch to the host values", () => {
    const spec = getPlatformSpec("22.12.0");
    expect(spec.name.startsWith("node-v22.12.0-")).toBe(true);
    const platform = process.platform === "win32" ? "win" : process.platform;
    expect(spec.name).toBe(`node-v22.12.0-${platform}-${process.arch}`);
  });

  it("throws for an unsupported platform", () => {
    expect(() => getPlatformSpec("22.12.0", "freebsd", "x64")).toThrow(
      /Unsupported platform for Node download: freebsd\/x64/,
    );
  });
});
