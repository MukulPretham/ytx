/**
 * Shared plumbing for commands: paths, config, the terminal, and the resolved
 * external tools. Commands receive this instead of reaching for globals.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { defaultConfig, loadConfig, saveConfig, type Config } from "../core/config.ts";
import { SilentExit, fetchError, type YtxError } from "../core/errors.ts";
import { resolvePaths, type LibraryPaths, type Paths, type RuntimePaths } from "../core/paths.ts";
import { loadState, type State } from "../core/state.ts";
import { Ui } from "../core/ui.ts";
import { readVersion, resolveDownloader, type DownloaderOptions, type YtdlpSource } from "../ytdlp/run.ts";
import { findUv } from "../asr/venv.ts";

export interface GlobalFlags {
  json: boolean;
  debug: boolean;
  store?: string;
  yes: boolean;
  nonInteractive: boolean;
}

export interface CommandContext {
  ui: Ui;
  flags: GlobalFlags;
  paths: Paths;
  runtime: RuntimePaths;
  library: LibraryPaths;
  state: State;
  config: Config;
  downloader: DownloaderOptions;
  /** ffmpeg to use: the PATH one, else the runtime copy, else "ffmpeg". */
  ffmpeg: string;
  /** ffprobe paired with ffmpeg; `import` cannot run without it. */
  ffprobe: string;
  /** uv if one is available, else null. */
  uv: string | null;
  reload: () => void;
}

export function buildContext(flags: GlobalFlags, env = process.env, cwd = process.cwd()): CommandContext {
  const ui = new Ui({ json: flags.json, debug: flags.debug });
  const paths = resolvePaths({ env, cwd, store: flags.store });
  mkdirSync(paths.runtime.root, { recursive: true });

  const config = loadConfig(paths.library);
  const downloader = resolveDownloader(paths.runtime, config.ytdlp);
  const context: CommandContext = {
    ui,
    flags,
    paths,
    runtime: paths.runtime,
    library: paths.library,
    state: loadState(paths.runtime.state),
    config,
    downloader: {
      binary: downloader.binary,
      source: downloader.source,
      available: downloader.available,
      browser: "",
      onLine: flags.debug ? (line) => ui.note(line) : undefined,
    },
    ffmpeg: resolveFfmpegPath(paths.runtime),
    ffprobe: resolveFfprobePath(paths.runtime),
    uv: findUv(paths.runtime),
    reload: () => {
      context.state = loadState(paths.runtime.state);
      context.config = loadConfig(paths.library);
      const next = resolveDownloader(paths.runtime, context.config.ytdlp);
      context.downloader = {
        ...context.downloader,
        binary: next.binary,
        source: next.source,
        available: next.available,
      };
      context.ffmpeg = resolveFfmpegPath(paths.runtime);
      context.ffprobe = resolveFfprobePath(paths.runtime);
      context.uv = findUv(paths.runtime);
    },
  };
  context.downloader.browser = context.config.browser;
  return context;
}

export function resolveFfmpegPath(runtime: RuntimePaths): string {
  if (existsSync(runtime.ffmpeg)) return runtime.ffmpeg;
  return Bun.which("ffmpeg") ?? runtime.ffmpeg;
}

/**
 * ffprobe is normally installed beside ffmpeg: Homebrew puts both in the same
 * bin directory, and the static build downloads both into `runtime/bin`. A
 * PATH ffprobe is the fallback when a static ffmpeg was installed without it.
 */
export function resolveFfprobePath(runtime: RuntimePaths): string {
  const sibling = join(dirname(resolveFfmpegPath(runtime)), "ffprobe");
  if (existsSync(sibling)) return sibling;
  return Bun.which("ffprobe") ?? runtime.ffprobe;
}

export function requireFfmpeg(context: CommandContext): string {
  const path = context.ffmpeg;
  if (!existsSync(path) && Bun.which("ffmpeg") === null) {
    throw fetchError(
      "ffmpeg",
      "is not installed, and it is required to mux media and transcribe audio",
      "run `ytx setup` to install a static build",
    );
  }
  return path;
}

/** Import needs ffprobe for duration, streams, chapters and title. */
export function requireFfprobe(context: CommandContext): string {
  const path = context.ffprobe;
  if (!existsSync(path) && Bun.which("ffprobe") === null) {
    throw fetchError(
      "ffprobe",
      "is not installed, and importing a local file needs it to read the container",
      "run `ytx setup` to install a static build",
    );
  }
  return path;
}

/**
 * Preflight for commands that need the downloader. Runs before anything in the
 * library is created, so a missing binary leaves the store byte-identical.
 */
export async function requireDownloader(
  context: CommandContext,
): Promise<{ binary: string; version: string; source: YtdlpSource }> {
  const { binary, source, available } = context.downloader;
  const version = available === false ? null : await readVersion(binary);
  if (version !== null) return { binary, version, source };

  const why =
    context.config.ytdlp === "system"
      ? `no yt-dlp was found on PATH, and config.toml sets ytdlp = "system" (${binary})`
      : context.config.ytdlp === "managed"
        ? `${binary} is missing or does not run, and config.toml sets ytdlp = "managed"`
        : `${binary} is missing or does not run`;
  throw fetchError(
    "yt-dlp",
    why,
    context.config.ytdlp === "system"
      ? "install yt-dlp on PATH, or set `ytdlp = \"auto\"` in config.toml and run `ytx setup`"
      : "run `ytx setup` to install it",
  );
}

/**
 * Finish with a failure after a command has produced its result.
 *
 * `--json` consumers get one document: the payload plus an `error` field. Human
 * consumers get the usual three-part message. Either way the exit code is the
 * error's code and nothing is printed twice.
 */
export function failAfterEmit(
  context: CommandContext,
  payload: Record<string, unknown>,
  error: YtxError,
): never {
  if (context.flags.json) context.ui.emit({ ...payload, error: error.toJSON() });
  context.ui.printError(error);
  throw new SilentExit(error.code);
}

/** Create the library skeleton without touching existing data. */
export function ensureLibrary(context: CommandContext): void {
  mkdirSync(context.library.videos, { recursive: true });
  if (!existsSync(context.library.config)) {
    saveConfig(context.library, { ...defaultConfig(), ...context.config });
  }
}
