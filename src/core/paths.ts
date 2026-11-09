/**
 * Two directories, never mixed.
 *
 *   runtime  - machine-local binaries and weights. Never copied between machines.
 *   library  - pure data. Relocatable, safe to copy, safe to back up.
 *
 * Nothing in the library points at an absolute path; everything in `meta.json`
 * that names a file is relative to that video's directory.
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface Env {
  [key: string]: string | undefined;
}

export interface PathInputs {
  env?: Env;
  cwd?: string;
  /** `--store <path>` from the command line, already parsed. */
  store?: string;
  platform?: NodeJS.Platform;
  home?: string;
}

export interface RuntimePaths {
  root: string;
  bin: string;
  ytdlp: string;
  ytdlpPrev: string;
  /** Downloaded static ffmpeg, when the machine had none on PATH. */
  ffmpeg: string;
  venv: string;
  venvPython: string;
  models: string;
  state: string;
  logs: string;
  tmp: string;
  locks: string;
}

export interface LibraryPaths {
  root: string;
  config: string;
  queue: string;
  videos: string;
}

export interface Paths {
  runtime: RuntimePaths;
  library: LibraryPaths;
  /** Where the library path came from, for `doctor` and `--json`. */
  libraryOrigin: "flag" | "env" | "cwd-marker" | "default";
}

export function homeDir(inputs: PathInputs): string {
  return inputs.home ?? inputs.env?.HOME ?? homedir();
}

/** `$XDG_DATA_HOME/ytx`, else the per-platform application data directory. */
export function defaultRuntimeRoot(inputs: PathInputs = {}): string {
  const env = inputs.env ?? process.env;
  const platform = inputs.platform ?? process.platform;
  const xdg = env.XDG_DATA_HOME;
  if (xdg && xdg.trim() !== "") return resolve(xdg, "ytx");
  const home = homeDir({ ...inputs, env });
  if (platform === "darwin") return join(home, "Library", "Application Support", "ytx");
  return join(home, ".local", "share", "ytx");
}

export function defaultLibraryRoot(inputs: PathInputs = {}): string {
  return join(homeDir(inputs), ".ytx", "library");
}

/**
 * Precedence: `--store`, then `YTX_HOME`, then a `.ytx` directory in the
 * working directory (so a directory can own its own library), then the default.
 */
export function resolveLibraryRoot(inputs: PathInputs = {}): {
  root: string;
  origin: Paths["libraryOrigin"];
} {
  const env = inputs.env ?? process.env;
  const cwd = inputs.cwd ?? process.cwd();

  if (inputs.store && inputs.store.trim() !== "") {
    return { root: absolutize(inputs.store, cwd), origin: "flag" };
  }
  const fromEnv = env.YTX_HOME;
  if (fromEnv && fromEnv.trim() !== "") {
    return { root: absolutize(fromEnv, cwd), origin: "env" };
  }
  const marker = join(cwd, ".ytx");
  if (isDirectory(marker)) {
    return { root: marker, origin: "cwd-marker" };
  }
  return { root: defaultLibraryRoot(inputs), origin: "default" };
}

export function resolveRuntimePaths(inputs: PathInputs = {}): RuntimePaths {
  const env = inputs.env ?? process.env;
  const root = defaultRuntimeRoot(inputs);
  const modelsOverride = env.YTX_MODELS_DIR;
  const models =
    modelsOverride && modelsOverride.trim() !== ""
      ? absolutize(modelsOverride, inputs.cwd ?? process.cwd())
      : join(root, "models");
  return {
    root,
    bin: join(root, "bin"),
    ytdlp: join(root, "bin", "yt-dlp"),
    ytdlpPrev: join(root, "bin", "yt-dlp.prev"),
    ffmpeg: join(root, "bin", "ffmpeg"),
    venv: join(root, "venv"),
    venvPython: join(root, "venv", "bin", "python"),
    models,
    state: join(root, "state.json"),
    logs: join(root, "logs"),
    tmp: join(root, "tmp"),
    locks: join(root, "locks"),
  };
}

export function resolveLibraryPaths(inputs: PathInputs = {}): {
  paths: LibraryPaths;
  origin: Paths["libraryOrigin"];
} {
  const { root, origin } = resolveLibraryRoot(inputs);
  return {
    origin,
    paths: {
      root,
      config: join(root, "config.toml"),
      queue: join(root, "queue.jsonl"),
      videos: join(root, "videos"),
    },
  };
}

export function resolvePaths(inputs: PathInputs = {}): Paths {
  const { paths: library, origin } = resolveLibraryPaths(inputs);
  return { runtime: resolveRuntimePaths(inputs), library, libraryOrigin: origin };
}

export function videoDir(library: LibraryPaths, videoId: string): string {
  return join(library.videos, videoId);
}

/** Every file path in a record is relative to the video directory. */
export function videoFile(library: LibraryPaths, videoId: string, relative: string): string {
  return join(videoDir(library, videoId), relative);
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

function absolutize(path: string, cwd: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

/** The 17-character YouTube id, as produced by every URL shape we accept. */
export const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export type UrlKind = "video" | "playlist" | "channel" | "shorts" | "unknown";

export interface ParsedUrl {
  url: string;
  id: string | null;
  kind: UrlKind;
  /** Playlist list id when the URL carries one. */
  playlistId: string | null;
}

/**
 * Parse the URL shapes `ytx add` accepts. Deliberately pure and network-free so
 * it can be unit tested: no yt-dlp call is made to answer "which video is this".
 */
export function parseVideoUrl(input: string): ParsedUrl {
  const raw = input.trim();
  // A bare id is what spellcheckers leave alone; accept it.
  if (VIDEO_ID_RE.test(raw)) {
    return { url: canonicalWatchUrl(raw), id: raw, kind: "video", playlistId: null };
  }
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { url: raw, id: null, kind: "unknown", playlistId: null };
  }

  const host = url.hostname.replace(/^www\./, "").replace(/^m\./, "");
  const playlistId = url.searchParams.get("list");

  if (host === "youtu.be") {
    const id = url.pathname.split("/").filter(Boolean)[0] ?? null;
    return { url: raw, id: isValidId(id) ? id : null, kind: isValidId(id) ? "video" : "unknown", playlistId };
  }

  if (host !== "youtube.com" && host !== "youtube-nocookie.com" && host !== "music.youtube.com") {
    return { url: raw, id: null, kind: "unknown", playlistId };
  }

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] === "watch") {
    const id = url.searchParams.get("v");
    const ok = isValidId(id);
    return {
      url: raw,
      id: ok ? id : null,
      kind: ok ? "video" : playlistId ? "playlist" : "unknown",
      playlistId,
    };
  }
  if (parts[0] === "shorts" || parts[0] === "live" || parts[0] === "embed" || parts[0] === "v") {
    const id = parts[1] ?? null;
    const ok = isValidId(id);
    return {
      url: raw,
      id: ok ? id : null,
      kind: ok ? (parts[0] === "shorts" ? "shorts" : "video") : "unknown",
      playlistId,
    };
  }
  if (parts[0] === "playlist" && playlistId) {
    return { url: raw, id: null, kind: "playlist", playlistId };
  }
  if (parts[0] === "channel" || parts[0]?.startsWith("@")) {
    return { url: raw, id: null, kind: "channel", playlistId };
  }
  return { url: raw, id: null, kind: playlistId ? "playlist" : "unknown", playlistId };
}

function isValidId(id: string | null): id is string {
  return typeof id === "string" && VIDEO_ID_RE.test(id);
}

export function canonicalWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
