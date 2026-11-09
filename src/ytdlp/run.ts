/**
 * yt-dlp invocations.
 *
 * Two rules hold for every call: `--ignore-config` (a user's yt-dlp config must
 * not change this tool's behaviour) and JSON output for every read (`-J`), never
 * human-readable parsing. Whatever produced a transcript, its yt-dlp version is
 * recorded next to it.
 */

import { existsSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EXIT, fetchError, qualityError, YtxError } from "../core/errors.ts";
import { lastLines, run } from "../core/exec.ts";
import type { RuntimePaths } from "../core/paths.ts";
import { classifyFailure, type Classified } from "./classify.ts";
import type { Availability, CaptionFormat } from "../captions/ladder.ts";

export type YtdlpSource = "managed" | "system";

export interface DownloaderOptions {
  binary: string;
  /** Whether `binary` is the runtime copy or a yt-dlp found on PATH. */
  source: YtdlpSource;
  /** False when the configured mode has no binary at all (e.g. system with no PATH install). */
  available?: boolean;
  /** Browser to read cookies from, for bot-check resilience. "" means none. */
  browser?: string;
  /** Alternate player client, used after a format-unavailable failure. */
  playerClient?: string | null;
  onLine?: (line: string) => void;
  timeoutMs?: number;
}

export interface YtdlpRawInfo {
  id?: string;
  title?: string;
  duration?: number;
  upload_date?: string;
  uploader?: string;
  channel?: string;
  channel_id?: string;
  uploader_id?: string;
  webpage_url?: string;
  language?: string | null;
  chapters?: { start_time?: number; title?: string }[] | null;
  subtitles?: Record<string, CaptionFormatRecord[]>;
  automatic_captions?: Record<string, CaptionFormatRecord[]>;
  formats?: RawFormat[];
  [key: string]: unknown;
}

interface CaptionFormatRecord {
  ext?: string;
  url?: string;
  name?: string | null;
}

interface RawFormat {
  height?: number | null;
  ext?: string;
  vcodec?: string | null;
  acodec?: string | null;
}

export interface InfoResult {
  info: YtdlpRawInfo;
  version: string;
  /** Which binary produced this metadata; recorded alongside every caption. */
  source: YtdlpSource;
  availability: Availability;
}

/** Base flags shared by every invocation. */
export function baseArgs(options: DownloaderOptions): string[] {
  const args = ["--ignore-config", "--no-warnings", "--no-playlist", "--socket-timeout", "20", "--retries", "3"];
  if (options.browser && options.browser.trim() !== "" && options.browser !== "none") {
    args.push("--cookies-from-browser", options.browser.trim());
  }
  if (options.playerClient) {
    args.push("--extractor-args", `youtube:player_client=${options.playerClient}`);
  }
  return args;
}

/**
 * Which binary to use, following `config.ytdlp`:
 *
 *   auto     the runtime copy when it exists, else a yt-dlp on PATH
 *   managed  only the runtime copy; never a PATH binary
 *   system   only a yt-dlp on PATH; never the runtime copy
 *
 * The fallback exists because a GitHub outage must not make the whole tool
 * unusable on a machine that already has yt-dlp installed.
 */
export function resolveDownloader(
  runtime: RuntimePaths,
  mode: "auto" | "managed" | "system" = "auto",
): { binary: string; source: YtdlpSource; available: boolean } {
  const system = Bun.which("yt-dlp");
  if (mode === "system") {
    return system
      ? { binary: system, source: "system", available: true }
      : { binary: runtime.ytdlp, source: "system", available: false };
  }
  if (mode === "managed") {
    return { binary: runtime.ytdlp, source: "managed", available: existsSync(runtime.ytdlp) };
  }
  if (existsSync(runtime.ytdlp)) return { binary: runtime.ytdlp, source: "managed", available: true };
  if (system) return { binary: system, source: "system", available: true };
  return { binary: runtime.ytdlp, source: "managed", available: false };
}

export async function readVersion(binary: string): Promise<string | null> {
  if (!existsSync(binary)) return null;
  const result = await run(binary, ["--version"], { timeoutMs: 15_000 });
  if (result.code !== 0) return null;
  return result.stdout.trim().split("\n")[0] ?? null;
}

export async function fetchInfo(url: string, options: DownloaderOptions): Promise<InfoResult> {
  const version = await readVersion(options.binary);
  if (version === null) {
    throw fetchError(
      "yt-dlp",
      `${options.binary} is missing or does not run`,
      "run `ytx setup` to install it",
    );
  }

  const result = await run(options.binary, [...baseArgs(options), "-J", url], {
    timeoutMs: options.timeoutMs ?? 120_000,
    onStderrLine: options.onLine,
    // `-J` output is not small: a four-minute video can produce 8 MB of
    // format metadata. The default 4 MB tail would keep only the end of the
    // JSON and make it unparseable, so metadata reads get their own ceiling.
    captureLimit: 64 * 1024 * 1024,
  });

  if (result.code !== 0) {
    throw classifyToError(result.stderr, result.stdout, "read video metadata for", url);
  }

  let info: YtdlpRawInfo;
  try {
    info = JSON.parse(result.stdout) as YtdlpRawInfo;
  } catch (err) {
    throw fetchError(
      "yt-dlp output",
      `-J did not return JSON (${(err as Error).message.split("\n")[0]})`,
      "run `ytx update`, then retry",
    );
  }

  return { info, version, source: options.source, availability: availabilityOf(info) };
}

/** Turn a failed yt-dlp run into an error whose class drives the caller's response. */
export function classifyToError(
  stderr: string,
  stdout: string,
  action: string,
  url: string,
): YtxError {
  const classified: Classified = classifyFailure(`${stderr}\n${stdout}`, 1);
  const why = classified.evidence || "yt-dlp failed without a recognized message";
  return new YtxError({
    what: `${action} ${url}`.trim(),
    why: `[${classified.class}] ${why}`,
    next: classified.next,
    code: EXIT.fetch,
    failureClass: classified.class,
    kind: "fetch",
  });
}

export function availabilityOf(info: YtdlpRawInfo): Availability {
  return {
    human: normalizeTracks(info.subtitles),
    auto: normalizeTracks(info.automatic_captions),
    originalLanguage: typeof info.language === "string" && info.language !== "" ? info.language : null,
  };
}

function normalizeTracks(source: Record<string, CaptionFormatRecord[]> | undefined): Record<string, CaptionFormat[]> {
  const out: Record<string, CaptionFormat[]> = {};
  for (const [language, formats] of Object.entries(source ?? {})) {
    if (!Array.isArray(formats)) continue;
    const usable = formats
      .filter((format) => typeof format?.url === "string" && format.url !== "")
      .map((format) => ({
        ext: typeof format.ext === "string" ? format.ext : "vtt",
        url: String(format.url),
        name: format.name ?? null,
        translated: isTranslatedUrl(String(format.url)),
      }));
    if (usable.length > 0) out[language] = usable;
  }
  return out;
}

/** `tlang` marks a machine translation of the ASR track, not the track itself. */
function isTranslatedUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.has("tlang");
  } catch {
    return false;
  }
}

/** Prefer WebVTT, then SRT; the platform serves both. */
export function pickCaptionFormat(formats: readonly CaptionFormat[]): CaptionFormat | null {
  return (
    formats.find((format) => format.ext === "vtt") ??
    formats.find((format) => format.ext === "srt") ??
    formats.find((format) => format.ext === "json3") ??
    null
  );
}

export interface CaptionTrack {
  text: string;
  ext: "vtt" | "srt" | "other";
  /** File the downloader actually wrote, for diagnostics. */
  path: string;
}

/**
 * Fetch one caption track through yt-dlp rather than by URL.
 *
 * The direct URL is not always a subtitle file: for some videos the platform
 * answers with an HLS playlist (`#EXTM3U`) that only yt-dlp knows how to
 * resolve. Going through the downloader also means the same cookie and client
 * behaviour applies to captions as to media.
 */
export async function fetchCaptionTrack(
  url: string,
  trackKey: string,
  source: "human" | "auto",
  destination: string,
  options: DownloaderOptions,
): Promise<CaptionTrack | null> {
  const args = [
    ...baseArgs(options),
    "--skip-download",
    source === "auto" ? "--write-auto-subs" : "--write-subs",
    "--sub-langs",
    trackKey,
    "--sub-format",
    "vtt/srt/best",
    "-o",
    join(destination, "%(id)s.%(ext)s"),
    url,
  ];
  const result = await run(options.binary, args, {
    timeoutMs: options.timeoutMs ?? 120_000,
    onStderrLine: options.onLine,
  });
  if (result.code !== 0) {
    throw classifyToError(result.stderr, result.stdout, `fetch captions (${trackKey}) for`, url);
  }

  const produced = findCaptionFile(destination);
  if (produced === null) return null;

  let text: string;
  try {
    text = await Bun.file(produced).text();
  } catch (err) {
    throw fetchError(
      `caption file ${produced}`,
      `cannot be read (${(err as Error).message})`,
      "retry `ytx add`",
    );
  }
  const lowered = produced.toLowerCase();
  const ext = lowered.endsWith(".vtt") ? "vtt" : lowered.endsWith(".srt") ? "srt" : "other";
  return { text, ext, path: produced };
}

function findCaptionFile(directory: string): string | null {
  try {
    const names = readdirSync(directory)
      .filter((name) => /\.(vtt|srt)$/i.test(name) && !name.endsWith(".part"))
      .sort();
    const first = names[0];
    return first ? join(directory, first) : null;
  } catch {
    return null;
  }
}

export interface MediaQuality {
  /** Height ceiling; 0 means "no ceiling". */
  maxHeight: number;
  ffmpeg: string;
}

export interface MediaResult {
  video: string | null;
  audio: string;
  mp3: string | null;
  height: number | null;
  warnings: string[];
}

export function videoSelector(maxHeight: number): string {
  const cap = maxHeight > 0 ? `[height<=${maxHeight}]` : "";
  return [
    `bv*${cap}[ext=mp4][vcodec^=avc1]`,
    `bv*${cap}[ext=mp4]`,
    `bv*${cap}`,
    `b${cap}`,
  ].join("/");
}

export function audioSelector(): string {
  return ["ba[ext=m4a]", "ba[acodec^=mp4a]", "ba", "b"].join("/");
}

/**
 * Fetch video and audio as separate streams, then mux them. Downloading the
 * audio on its own is what lets the original track stay untouched on disk while
 * the mp4 carries a muxed copy.
 */
export async function downloadMedia(
  url: string,
  videoId: string,
  destination: string,
  options: DownloaderOptions,
  quality: MediaQuality,
): Promise<MediaResult> {
  const warnings: string[] = [];
  const existingAudio = findExistingAudio(destination, videoId);
  const audio =
    existingAudio !== null
      ? { path: existingAudio }
      : await downloadAudioStream(url, videoId, destination, options, warnings);

  let video: { path: string } | null = null;
  try {
    video = await downloadVideoStream(url, videoId, destination, options, quality);
  } catch (err) {
    if (err instanceof YtxError && err.failureClass === "format-unavailable") {
      // Second response to format-unavailable: another player client.
      warnings.push(`video stream unavailable (${err.why}); retrying with another client`);
      try {
        video = await downloadVideoStream(url, videoId, destination, options, quality, "android,web");
      } catch (retryError) {
        if (retryError instanceof YtxError && retryError.failureClass === "format-unavailable") {
          // Third response: degrade to audio-only rather than failing the add.
          warnings.push("no video stream at this height; archived audio only");
          video = null;
        } else {
          throw retryError;
        }
      }
    } else {
      throw err;
    }
  }

  const audioPath = audio.path;
  let mp4: string | null = null;
  let height: number | null = null;
  if (video) {
    mp4 = join(destination, `${videoId}.mp4`);
    try {
      await muxMp4(quality.ffmpeg, video.path, audioPath, mp4);
      height = await probeHeight(quality.ffmpeg, mp4);
    } catch (err) {
      warnings.push(`could not mux the mp4 (${(err as Error).message}); kept the separate streams`);
      mp4 = null;
    }
    rmSync(video.path, { force: true });
  }

  let mp3: string | null = null;
  const mp3Path = join(destination, `${videoId}.mp3`);
  try {
    await makeMp3(quality.ffmpeg, audioPath, mp3Path);
    mp3 = mp3Path;
  } catch (err) {
    warnings.push(`could not generate the mp3 (${(err as Error).message})`);
  }

  return { video: mp4, audio: audioPath, mp3, height, warnings };
}

export async function downloadVideoStream(
  url: string,
  videoId: string,
  destination: string,
  options: DownloaderOptions,
  quality: MediaQuality,
  playerClient?: string,
): Promise<{ path: string }> {
  const args = [
    ...baseArgs({ ...options, playerClient: playerClient ?? options.playerClient ?? null }),
    "-f",
    videoSelector(quality.maxHeight),
    "-o",
    join(destination, `${videoId}.video.%(ext)s`),
    url,
  ];
  const result = await run(options.binary, args, {
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    onStderrLine: options.onLine,
  });
  if (result.code !== 0) {
    throw classifyToError(result.stderr, result.stdout, "download video for", url);
  }
  const produced = findProduced(destination, `${videoId}.video.`);
  if (produced === null) {
    throw fetchError(
      `video stream for ${videoId}`,
      "yt-dlp reported success but produced no file",
      "retry `ytx add`; if it repeats, run `ytx update`",
    );
  }
  return { path: produced };
}

export async function downloadAudioStream(
  url: string,
  videoId: string,
  destination: string,
  options: DownloaderOptions,
  warnings: string[],
): Promise<{ path: string }> {
  const args = [
    ...baseArgs(options),
    "-f",
    audioSelector(),
    "-o",
    join(destination, `${videoId}.audio.%(ext)s`),
    url,
  ];
  const result = await run(options.binary, args, {
    timeoutMs: options.timeoutMs ?? 30 * 60_000,
    onStderrLine: options.onLine,
  });
  if (result.code !== 0) {
    throw classifyToError(result.stderr, result.stdout, "download audio for", url);
  }
  const produced = findProduced(destination, `${videoId}.audio.`);
  if (produced === null) {
    throw fetchError(
      `audio stream for ${videoId}`,
      "yt-dlp reported success but produced no file",
      "retry `ytx add`; if it repeats, run `ytx update`",
    );
  }

  const extension = produced.split(".").pop() ?? "m4a";
  if (extension !== "m4a") {
    warnings.push(
      `the original audio track is .${extension}, not .m4a; it is kept as-is rather than re-encoded`,
    );
  }
  // Keep the original bytes; only the name is normalized to the video id.
  const target = join(destination, `${videoId}.${extension}`);
  if (produced !== target) renameSync(produced, target);
  return { path: target };
}

export async function muxMp4(ffmpeg: string, video: string, audio: string, out: string): Promise<void> {
  const copy = await run(
    ffmpeg,
    ["-y", "-loglevel", "error", "-i", video, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-c", "copy", "-movflags", "+faststart", out],
    { timeoutMs: 20 * 60_000 },
  );
  if (copy.code === 0) return;

  // Some video codecs will not remux into mp4. Transcoding is the expensive
  // fallback; it is still better than losing the picture.
  rmSync(out, { force: true });
  const transcode = await run(
    ffmpeg,
    [
      "-y",
      "-loglevel",
      "error",
      "-i",
      video,
      "-i",
      audio,
      "-map",
      "0:v:0",
      "-map",
      "1:a:0",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      "-c:a",
      "copy",
      "-movflags",
      "+faststart",
      out,
    ],
    { timeoutMs: 60 * 60_000 },
  );
  if (transcode.code !== 0) {
    throw qualityError(
      "mux mp4",
      lastLines(transcode.stderr, 3) || `ffmpeg exited ${transcode.code}`,
      "the original streams are still on disk; run `ffmpeg` by hand or re-add with `--max-height 720`",
    );
  }
}

export async function makeMp3(ffmpeg: string, input: string, out: string): Promise<void> {
  const result = await run(
    ffmpeg,
    ["-y", "-loglevel", "error", "-i", input, "-vn", "-c:a", "libmp3lame", "-q:a", "2", out],
    { timeoutMs: 20 * 60_000 },
  );
  if (result.code !== 0) {
    throw qualityError(
      "generate mp3",
      lastLines(result.stderr, 3) || `ffmpeg exited ${result.code}`,
      "check that ffmpeg is installed (`ytx setup` installs a static build)",
    );
  }
}

export async function probeHeight(ffmpeg: string, file: string): Promise<number | null> {
  const ffprobe = join(ffmpeg, "..", "ffprobe");
  if (!existsSync(ffprobe)) return null;
  const result = await run(
    ffprobe,
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=height", "-of", "csv=p=0", file],
    { timeoutMs: 60_000 },
  );
  if (result.code !== 0) return null;
  const height = Number(result.stdout.trim().split("\n")[0]);
  return Number.isFinite(height) && height > 0 ? height : null;
}

/** The `--version` string yt-dlp reports, or null when it cannot run. */
export async function captureVersion(binary: string): Promise<string | null> {
  return readVersion(binary);
}

/** An audio track already on disk for this video, in any container. */
export function findExistingAudio(directory: string, videoId: string): string | null {
  try {
    const names = readdirSync(directory)
      .filter((name) => name.startsWith(`${videoId}.`) && /\.(m4a|mp3|opus|webm|aac|ogg)$/i.test(name))
      .sort();
    const first = names[0];
    return first ? join(directory, first) : null;
  } catch {
    return null;
  }
}

export function findProduced(directory: string, prefix: string): string | null {
  try {
    const matches = readdirSync(directory)
      .filter((name) => name.startsWith(prefix) && !name.endsWith(".part"))
      .sort();
    const first = matches[0];
    return first ? join(directory, first) : null;
  } catch {
    return null;
  }
}
