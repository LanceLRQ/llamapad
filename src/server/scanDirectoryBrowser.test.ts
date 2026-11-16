import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listScanDirectories } from "./scanDirectoryBrowser";

describe("listScanDirectories", () => {
  let fixture: string;
  let panel: string;

  beforeEach(async () => {
    fixture = await mkdtemp(join(tmpdir(), "llamapad-scan-browse-"));
    panel = join(fixture, "mount");
    await Promise.all([
      mkdir(join(panel, "archive", "2026"), { recursive: true }),
      mkdir(join(panel, "new, models"), { recursive: true }),
      mkdir(join(panel, ".cache"), { recursive: true }),
      mkdir(join(fixture, "outside")),
    ]);
    await Promise.all([
      writeFile(join(panel, "model.gguf"), ""),
      symlink(join(fixture, "outside"), join(panel, "elsewhere")),
    ]);
  });

  afterEach(async () => {
    await rm(fixture, { recursive: true, force: true });
  });

  it("lists mounted directories as host paths and omits missing and file mounts", async () => {
    expect(await listScanDirectories([
      { host: "/srv/models", panel },
      { host: "/srv/missing", panel: join(fixture, "missing") },
      { host: "/srv/file", panel: join(panel, "model.gguf") },
      { host: "/srv/other", panel: join(fixture, "outside") },
      { host: "", panel },
    ], null)).toEqual(["/srv/models", "/srv/other"]);
  });

  it("lists immediate child directories, skipping hidden directories, files and symlinks", async () => {
    const mounts = [{ host: "/srv/models", panel }];
    expect(await listScanDirectories(mounts, "/srv/models")).toEqual([
      "/srv/models/archive",
      "/srv/models/new, models",
    ]);
    expect(await listScanDirectories(mounts, "/srv/models/archive")).toEqual(["/srv/models/archive/2026"]);
    expect(await listScanDirectories(mounts, "/srv/models/archive/2026")).toEqual([]);
  });

  it("rejects paths outside the mount and symlinks leading out of it", async () => {
    const mounts = [{ host: "/srv/models", panel }];
    for (const path of ["/srv/models2", "/srv/models/../other", "/srv/models/elsewhere", "/srv/models/.cache"]) {
      expect(await listScanDirectories(mounts, path)).toBeNull();
    }
  });

  it("uses the most specific host mapping for a nested mount", async () => {
    expect(await listScanDirectories([
      { host: "/srv/models", panel },
      { host: "/srv/models/archive", panel: join(fixture, "outside") },
    ], "/srv/models/archive")).toEqual([]);
  });
});
