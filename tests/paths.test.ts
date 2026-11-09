import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalWatchUrl,
  defaultLibraryRoot,
  defaultRuntimeRoot,
  parseVideoUrl,
  resolveLibraryPaths,
  resolvePaths,
  resolveRuntimePaths,
  videoDir,
} from "../src/core/paths.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "ytx-paths-"));
}

describe("defaultRuntimeRoot", () => {
  test("honours XDG_DATA_HOME on every platform", () => {
    const root = defaultRuntimeRoot({
      env: { XDG_DATA_HOME: "/xdg/data" },
      platform: "darwin",
      home: "/home/someone",
    });
    expect(root).toBe("/xdg/data/ytx");
  });

  test("uses Application Support on macOS", () => {
    expect(
      defaultRuntimeRoot({ env: {}, platform: "darwin", home: "/Users/someone" }),
    ).toBe("/Users/someone/Library/Application Support/ytx");
  });

  test("uses .local/share on Linux", () => {
    expect(defaultRuntimeRoot({ env: {}, platform: "linux", home: "/home/someone" })).toBe(
      "/home/someone/.local/share/ytx",
    );
  });

  test("ignores an empty XDG_DATA_HOME", () => {
    expect(
      defaultRuntimeRoot({ env: { XDG_DATA_HOME: "  " }, platform: "linux", home: "/home/x" }),
    ).toBe("/home/x/.local/share/ytx");
  });
});

describe("resolveLibraryRoot precedence", () => {
  test("default is ~/.ytx/library", () => {
    const dir = scratch();
    const { paths, origin } = resolveLibraryPaths({ env: {}, cwd: dir, home: "/home/x" });
    expect(paths.root).toBe(join("/home/x", ".ytx", "library"));
    expect(origin).toBe("default");
    rmSync(dir, { recursive: true, force: true });
  });

  test("--store wins over YTX_HOME and the marker", () => {
    const dir = scratch();
    mkdirSync(join(dir, ".ytx"));
    const { paths, origin } = resolveLibraryPaths({
      env: { YTX_HOME: "/from-env" },
      cwd: dir,
      home: "/home/x",
      store: "/from-flag",
    });
    expect(paths.root).toBe("/from-flag");
    expect(origin).toBe("flag");
    rmSync(dir, { recursive: true, force: true });
  });

  test("YTX_HOME wins over the cwd marker", () => {
    const dir = scratch();
    mkdirSync(join(dir, ".ytx"));
    const { paths, origin } = resolveLibraryPaths({ env: { YTX_HOME: "/from-env" }, cwd: dir, home: "/home/x" });
    expect(paths.root).toBe("/from-env");
    expect(origin).toBe("env");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a .ytx directory in the cwd owns its own library", () => {
    const dir = scratch();
    mkdirSync(join(dir, ".ytx"));
    const { paths, origin } = resolveLibraryPaths({ env: {}, cwd: dir, home: "/home/x" });
    expect(paths.root).toBe(join(dir, ".ytx"));
    expect(origin).toBe("cwd-marker");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a .ytx file (not directory) does not shadow the default", () => {
    const dir = scratch();
    mkdirSync(join(dir, ".ytx", "videos"), { recursive: true });
    rmSync(join(dir, ".ytx"), { recursive: true, force: true });
    const { origin } = resolveLibraryPaths({ env: {}, cwd: dir, home: "/home/x" });
    expect(origin).toBe("default");
    rmSync(dir, { recursive: true, force: true });
  });

  test("relative paths resolve against the cwd", () => {
    const dir = scratch();
    const { paths } = resolveLibraryPaths({ env: {}, cwd: dir, home: "/home/x", store: "relative/lib" });
    expect(paths.root).toBe(join(dir, "relative", "lib"));
    rmSync(dir, { recursive: true, force: true });
  });

  test("derives config, queue and videos paths", () => {
    const { paths } = resolveLibraryPaths({ env: {}, cwd: "/tmp", home: "/home/x", store: "/lib" });
    expect(paths.config).toBe(join("/lib", "config.toml"));
    expect(paths.queue).toBe(join("/lib", "queue.jsonl"));
    expect(paths.videos).toBe(join("/lib", "videos"));
    expect(defaultLibraryRoot({ env: {}, home: "/home/x" })).toBe(join("/home/x", ".ytx", "library"));
  });
});

describe("resolveRuntimePaths", () => {
  test("separates binaries, venv, models, state and logs", () => {
    const runtime = resolveRuntimePaths({ env: { XDG_DATA_HOME: "/data" }, platform: "linux", home: "/home/x" });
    expect(runtime.root).toBe("/data/ytx");
    expect(runtime.ytdlp).toBe("/data/ytx/bin/yt-dlp");
    expect(runtime.ytdlpPrev).toBe("/data/ytx/bin/yt-dlp.prev");
    expect(runtime.ffmpeg).toBe("/data/ytx/bin/ffmpeg");
    expect(runtime.venvPython).toBe("/data/ytx/venv/bin/python");
    expect(runtime.models).toBe("/data/ytx/models");
    expect(runtime.state).toBe("/data/ytx/state.json");
    expect(runtime.logs).toBe("/data/ytx/logs");
  });

  test("YTX_MODELS_DIR relocates weights only", () => {
    const runtime = resolveRuntimePaths({
      env: { XDG_DATA_HOME: "/data", YTX_MODELS_DIR: "/mnt/weights" },
      cmd: undefined,
      platform: "linux",
      home: "/home/x",
      cwd: "/tmp",
    } as never);
    expect(runtime.models).toBe("/mnt/weights");
    expect(runtime.ytdlp).toBe("/data/ytx/bin/yt-dlp");
  });
});

describe("resolvePaths", () => {
  test("keeps runtime and library independent", () => {
    const paths = resolvePaths({
      env: { XDG_DATA_HOME: "/data" },
      platform: "linux",
      home: "/home/x",
      cwd: "/tmp",
      store: "/lib",
    });
    expect(paths.runtime.root).toBe("/data/ytx");
    expect(paths.library.root).toBe("/lib");
    expect(paths.libraryOrigin).toBe("flag");
  });
});

describe("videoDir", () => {
  test("nests one directory per video", () => {
    const { paths } = resolveLibraryPaths({ env: {}, cwd: "/tmp", home: "/home/x", store: "/lib" });
    expect(videoDir(paths, "dQw4w9WgXcQ")).toBe(join("/lib", "videos", "dQw4w9WgXcQ"));
  });
});

describe("parseVideoUrl", () => {
  test("accepts every watch URL shape", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?si=abc",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
      "www.youtube.com/watch?v=dQw4w9WgXcQ",
      "dQw4w9WgXcQ",
    ]) {
      expect(parseVideoUrl(url).id).toBe("dQw4w9WgXcQ");
    }
  });

  test("classifies playlists and channels", () => {
    expect(parseVideoUrl("https://www.youtube.com/playlist?list=PL123").kind).toBe("playlist");
    expect(parseVideoUrl("https://www.youtube.com/@channel").kind).toBe("channel");
    const withList = parseVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123");
    expect(withList.kind).toBe("video");
    expect(withList.playlistId).toBe("PL123");
  });

  test("rejects non-YouTube and malformed input", () => {
    expect(parseVideoUrl("https://vimeo.com/123").id).toBeNull();
    expect(parseVideoUrl("https://vimeo.com/123").kind).toBe("unknown");
    expect(parseVideoUrl("https://www.youtube.com/watch?v=short").id).toBeNull();
    expect(parseVideoUrl("").id).toBeNull();
  });

  test("builds the canonical watch URL", () => {
    expect(canonicalWatchUrl("dQw4w9WgXcQ")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});
