/**
 * Shared plumbing for commands: paths, config, the terminal, and the resolved
 * external tools. Commands receive this instead of reaching for globals.
 */

import { existsSync, mkdirSync } from "node:fs";
import { defaultConfig, loadConfig, saveConfig, type Config } from "../core/config.ts";
import { usageError } from "../core/errors.ts";
import { resolvePaths, type LibraryPaths, type Paths, type RuntimePaths } from "../core/paths.ts";
import { loadState, type State } from "../core/state.ts";
import { Ui } from "../core/ui.ts";
import { resolveDownloader, type DownloaderOptions } from "../ytdlp/run.ts";
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
  /** uv if one is available, else null. */
  uv: string | null;
  reload: () => void;
}

export function buildContext(flags: GlobalFlags, env = process.env, cwd = process.cwd()): CommandContext {
  const ui = new Ui({ json: flags.json, debug: flags.debug });
  const paths = resolvePaths({ env, cwd, store: flags.store });
  mkdirSync(paths.runtime.root, { recursive: true });

  const context: CommandContext = {
    ui,
    flags,
    paths,
    runtime: paths.runtime,
    library: paths.library,
    state: loadState(paths.runtime.state),
    config: loadConfig(paths.library),
    downloader: {
      binary: resolveDownloader(paths.runtime),
      browser: "",
      onLine: flags.debug ? (line) => ui.note(line) : undefined,
    },
    ffmpeg: resolveFfmpegPath(paths.runtime),
    uv: findUv(paths.runtime),
    reload: () => {
      context.state = loadState(paths.runtime.state);
      context.config = loadConfig(paths.library);
      context.downloader = { ...context.downloader, binary: resolveDownloader(paths.runtime) };
      context.ffmpeg = resolveFfmpegPath(paths.runtime);
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

export function requireFfmpeg(context: CommandContext): string {
  const path = context.ffmpeg;
  if (!existsSync(path) && Bun.which("ffmpeg") === null) {
    throw usageError(
      "ffmpeg",
      "is not installed, and it is required to mux media and transcribe audio",
      "run `ytx setup` to install a static build",
    );
  }
  return path;
}

/** Create the library skeleton without touching existing data. */
export function ensureLibrary(context: CommandContext): void {
  mkdirSync(context.library.videos, { recursive: true });
  if (!existsSync(context.library.config)) {
    saveConfig(context.library, { ...defaultConfig(), ...context.config });
  }
}
