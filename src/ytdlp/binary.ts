/**
 * The downloader is a self-managed standalone binary in the runtime directory,
 * never a package dependency: yt-dlp needs to move faster than any distro, and
 * `ytx update` has to be able to replace it without touching a package manager.
 *
 * Every invocation elsewhere in this repo passes `--ignore-config`, because a
 * user's own `~/.config/yt-dlp/config` must not change this tool's behaviour.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fetchError, YtxError } from "../core/errors.ts";
import { run } from "../core/exec.ts";
import type { RuntimePaths } from "../core/paths.ts";

export type Channel = "stable" | "nightly";

export interface Asset {
  url: string;
  sumsUrl: string;
}

export function platformAsset(channel: Channel, platform = process.platform, arch = process.arch): Asset {
  const base =
    channel === "nightly"
      ? "https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download"
      : "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
  let name: string;
  if (platform === "darwin") name = "yt-dlp_macos";
  else if (platform === "linux") name = arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux";
  else if (platform === "win32") name = "yt-dlp.exe";
  else {
    throw fetchError(
      `yt-dlp ${platform}/${arch}`,
      "no standalone build is published for this platform",
      "install yt-dlp yourself and put it on PATH, then run `ytx setup`",
    );
  }
  return { url: `${base}/${name}`, sumsUrl: `${base}/SHA2-256SUMS` };
}

export async function ytdlpVersion(binary: string): Promise<string | null> {
  if (!existsSync(binary)) return null;
  const result = await run(binary, ["--version"], { timeoutMs: 20_000 });
  if (result.code !== 0) return null;
  const version = result.stdout.trim().split("\n")[0] ?? "";
  return version === "" ? null : version;
}

export interface DownloadProgress {
  received: number;
  total: number | null;
}

/**
 * Download a release asset to `dest`. Writes to `dest.part` first so an
 * interrupted download leaves no half-installed binary behind.
 */
export async function downloadAsset(
  asset: Asset,
  dest: string,
  options: { onProgress?: (progress: DownloadProgress) => void } = {},
): Promise<{ bytes: number; sha256: string }> {
  const part = `${dest}.part`;
  rmSync(part, { force: true });

  let response: Response;
  try {
    response = await fetch(asset.url, { redirect: "follow" });
  } catch (err) {
    throw fetchError(
      "download yt-dlp",
      `the release could not be reached (${(err as Error).message})`,
      "check the network, then run `ytx update`",
      "transient",
    );
  }
  if (!response.ok || !response.body) {
    throw fetchError(
      "download yt-dlp",
      `the release server answered HTTP ${response.status}`,
      "retry `ytx update` in a few minutes",
      "transient",
    );
  }

  const total = Number(response.headers.get("content-length") ?? "") || null;
  const handle = Bun.file(part).writer();
  const hash = createHash("sha256");
  let received = 0;
  for await (const chunk of response.body) {
    handle.write(chunk);
    hash.update(chunk);
    received += chunk.byteLength;
    options.onProgress?.({ received, total });
  }
  await handle.end();

  const sha256 = hash.digest("hex");
  return { bytes: received, sha256 };
}

/** Fetch and verify the release's checksum list; null when it is unavailable. */
export async function expectedChecksum(sumsUrl: string, fileName: string): Promise<string | null> {
  try {
    const response = await fetch(sumsUrl, { redirect: "follow" });
    if (!response.ok) return null;
    const text = await response.text();
    for (const line of text.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === fileName) return parts[0] ?? null;
    }
    return null;
  } catch {
    return null;
  }
}

export interface InstallResult {
  version: string;
  path: string;
  bytes: number;
  /** The version that was moved to `bin/yt-dlp.prev`, if any. */
  previous: string | null;
  sha256: string;
}

/**
 * Install (or replace) the downloader. The caller decides whether a canary has
 * to pass first: `install` takes a `promote` callback that receives the staged
 * binary and returns the version, throwing to abort the swap.
 */
export async function installYtdlp(
  runtime: RuntimePaths,
  channel: Channel,
  options: {
    onProgress?: (progress: DownloadProgress) => void;
    /** Runs against the staged binary before it replaces the working one. */
    canary?: (stagedPath: string, version: string) => Promise<void>;
  } = {},
): Promise<InstallResult> {
  mkdirSync(runtime.bin, { recursive: true });
  mkdirSync(runtime.tmp, { recursive: true });

  const asset = platformAsset(channel);
  const fileName = asset.url.split("/").pop() ?? "yt-dlp";
  const staged = join(runtime.tmp, `yt-dlp-${channel}-${process.pid}`);

  let downloaded: { bytes: number; sha256: string };
  try {
    downloaded = await downloadAsset(asset, staged, { onProgress: options.onProgress });
    renameSync(`${staged}.part`, staged);
  } catch (err) {
    rmSync(`${staged}.part`, { force: true });
    throw err;
  }

  const expected = await expectedChecksum(asset.sumsUrl, fileName);
  if (expected !== null && expected !== downloaded.sha256) {
    rmSync(staged, { force: true });
    throw fetchError(
      "download yt-dlp",
      `checksum mismatch: expected ${expected.slice(0, 12)}…, got ${downloaded.sha256.slice(0, 12)}…`,
      "retry `ytx update`; if it repeats, the mirror is serving a bad build",
    );
  }

  chmodSync(staged, 0o755);
  const version = await ytdlpVersion(staged);
  if (version === null) {
    rmSync(staged, { force: true });
    throw fetchError(
      "download yt-dlp",
      "the downloaded binary does not run on this machine",
      "run `ytx update --nightly` or install yt-dlp manually",
    );
  }

  const previousVersion = await ytdlpVersion(runtime.ytdlp);
  if (options.canary) {
    try {
      await options.canary(staged, version);
    } catch (err) {
      rmSync(staged, { force: true });
      rmSync(`${staged}.part`, { force: true });
      throw err;
    }
  }

  if (existsSync(runtime.ytdlp)) {
    rmSync(runtime.ytdlpPrev, { force: true });
    renameSync(runtime.ytdlp, runtime.ytdlpPrev);
  }
  renameSync(staged, runtime.ytdlp);
  chmodSync(runtime.ytdlp, 0o755);

  writeVersionFile(runtime, version);
  return {
    version,
    path: runtime.ytdlp,
    bytes: downloaded.bytes,
    previous: previousVersion,
    sha256: downloaded.sha256,
  };
}

/** Swap the previous binary back in. */
export async function rollbackYtdlp(runtime: RuntimePaths): Promise<{ version: string; previous: string | null }> {
  if (!existsSync(runtime.ytdlpPrev)) {
    throw new YtxError({
      what: "yt-dlp rollback",
      why: "there is no previous binary to roll back to",
      next: "run `ytx update` to install one",
      code: 3,
      kind: "dependency",
    });
  }
  const currentVersion = await ytdlpVersion(runtime.ytdlp);
  const previousVersion = await ytdlpVersion(runtime.ytdlpPrev);
  if (previousVersion === null) {
    throw new YtxError({
      what: "yt-dlp rollback",
      why: `${runtime.ytdlpPrev} does not run`,
      next: "run `ytx update --force` to install a fresh binary",
      code: 3,
      kind: "dependency",
    });
  }

  const parked = `${runtime.ytdlp}.rollback`;
  rmSync(parked, { force: true });
  if (existsSync(runtime.ytdlp)) renameSync(runtime.ytdlp, parked);
  renameSync(runtime.ytdlpPrev, runtime.ytdlp);
  chmodSync(runtime.ytdlp, 0o755);
  if (existsSync(parked)) renameSync(parked, runtime.ytdlpPrev);

  writeVersionFile(runtime, previousVersion);
  return { version: previousVersion, previous: currentVersion };
}

/** Human-readable size of the installed binary, for `doctor`. */
export function binarySize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export function readVersionFile(runtime: RuntimePaths): string | null {
  try {
    return readFileSync(join(runtime.bin, "yt-dlp.version"), "utf8").trim();
  } catch {
    return null;
  }
}

function writeVersionFile(runtime: RuntimePaths, version: string): void {
  writeFileSync(join(runtime.bin, "yt-dlp.version"), `${version}\n`, "utf8");
}
