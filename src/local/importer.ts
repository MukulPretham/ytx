/**
 * Bringing a local file into the library.
 *
 * Three jobs live here: fingerprinting bytes while copying them (the hash is
 * the record's identity), extracting an audio track ffmpeg can transcribe, and
 * publishing a staged directory into `videos/` without ever exposing a
 * half-written record.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs";
import { open } from "node:fs/promises";
import { extname, join } from "node:path";
import { qualityError } from "../core/errors.ts";
import { lastLines, run } from "../core/exec.ts";
import { META_FILE } from "../core/record.ts";
import type { Media } from "../core/schema.ts";

const CHUNK_BYTES = 4 * 1024 * 1024;
const PROGRESS_EVERY = 64 * 1024 * 1024;

export interface HashResult {
  sha256: string;
  bytes: number;
}

/**
 * Read `source` once: hash every byte and, when `destination` is given, write
 * the same bytes there. The two passes are fused so a multi-gigabyte file is
 * never read twice just to learn its id.
 */
export async function hashAndCopy(
  source: string,
  destination: string | null,
  onProgress?: (bytes: number) => void,
): Promise<HashResult> {
  const hash = createHash("sha256");
  const input = await open(source, "r");
  const output = destination === null ? null : await open(destination, "w");
  const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
  let bytes = 0;
  let reported = 0;
  try {
    for (;;) {
      const { bytesRead } = await input.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      if (output !== null) {
        let written = 0;
        while (written < bytesRead) {
          const { bytesWritten } = await output.write(chunk, written, bytesRead - written);
          if (bytesWritten === 0) throw new Error("copy made no progress");
          written += bytesWritten;
        }
      }
      bytes += bytesRead;
      if (onProgress !== undefined && bytes - reported >= PROGRESS_EVERY) {
        reported = bytes;
        onProgress(bytes);
      }
    }
  } finally {
    await input.close();
    if (output !== null) await output.close();
  }
  onProgress?.(bytes);
  return { sha256: hash.digest("hex"), bytes };
}

/** The container extension the library keeps; the bytes are never transcoded. */
export function sourceExtension(path: string): string {
  const ext = extname(path).slice(1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "mkv";
}

export interface AudioPlan {
  ext: string;
  /** True when the codec can be moved into `ext` without re-encoding. */
  copy: boolean;
}

/**
 * Which container the extracted original audio goes into. Anything with a
 * lossless remux target is copied; the rest becomes AAC. The source file keeps
 * the untouched bytes either way, so a transcode here never loses the master.
 */
export function audioPlan(codec: string | null): AudioPlan {
  switch ((codec ?? "").toLowerCase()) {
    case "aac":
      return { ext: "m4a", copy: true };
    case "mp3":
      return { ext: "mp3", copy: true };
    case "opus":
      return { ext: "opus", copy: true };
    case "vorbis":
      return { ext: "ogg", copy: true };
    case "flac":
      return { ext: "flac", copy: true };
    case "alac":
      return { ext: "m4a", copy: true };
    default:
      return { ext: "m4a", copy: false };
  }
}

export interface AudioExtraction {
  path: string;
  ext: string;
  warnings: string[];
}

/**
 * Extract the first audio stream. A remux that ffmpeg refuses (a codec that
 * does not fit the container it looked like) falls back to AAC rather than
 * failing the import: the original file is still in the library.
 */
export async function extractAudio(input: {
  ffmpeg: string;
  source: string;
  /** Absolute path without an extension, e.g. `<incoming>/<id>`. */
  base: string;
  codec: string | null;
  onLine?: (line: string) => void;
}): Promise<AudioExtraction> {
  const warnings: string[] = [];
  const plan = audioPlan(input.codec);

  if (plan.copy) {
    const target = `${input.base}.${plan.ext}`;
    const copied = await run(
      input.ffmpeg,
      ["-y", "-loglevel", "error", "-i", input.source, "-vn", "-c:a", "copy", target],
      { timeoutMs: 30 * 60_000, onStderrLine: input.onLine },
    );
    if (copied.code === 0) return { path: target, ext: plan.ext, warnings };
    rmSync(target, { force: true });
    warnings.push(
      `could not copy the ${input.codec ?? "unknown"} audio into .${plan.ext}; transcoded it to AAC instead`,
    );
  }

  const target = `${input.base}.m4a`;
  const transcoded = await run(
    input.ffmpeg,
    ["-y", "-loglevel", "error", "-i", input.source, "-vn", "-c:a", "aac", "-b:a", "192k", target],
    { timeoutMs: 60 * 60_000, onStderrLine: input.onLine },
  );
  if (transcoded.code !== 0) {
    throw qualityError(
      "extract audio",
      lastLines(transcoded.stderr, 4) || `ffmpeg exited ${transcoded.code}`,
      "check that the file's audio plays; nothing was written to the library",
    );
  }
  return { path: target, ext: "m4a", warnings };
}

/**
 * Scratch directory inside the library, not the runtime tmp: a multi-gigabyte
 * file must be published with a rename on the same filesystem. The leading dot
 * keeps it out of `listVideoIds`.
 */
export function stagingDirectory(videosDir: string): string {
  mkdirSync(videosDir, { recursive: true });
  return mkdtempSync(join(videosDir, ".incoming-"));
}

/**
 * Move a finished staging directory into place. A new record is one atomic
 * directory rename; a re-import moves file by file with `meta.json` last, so a
 * reader never sees a new record pointing at files that are not there yet.
 */
export function publishImport(incoming: string, target: string, options: { force: boolean }): void {
  if (!existsSync(target)) {
    renameSync(incoming, target);
    return;
  }
  if (!options.force) {
    throw new Error(`${target} appeared during the import; nothing was overwritten`);
  }
  const names = readdirSync(incoming).filter((name) => !name.startsWith("."));
  const ordered = [
    ...names.filter((name) => name !== META_FILE).sort(),
    ...names.filter((name) => name === META_FILE),
  ];
  for (const name of ordered) renameSync(join(incoming, name), join(target, name));
  rmSync(incoming, { recursive: true, force: true });
}

/**
 * After a `--force` re-import, drop media files the previous record named that
 * the new one does not. Captions and transcripts are never touched by this.
 */
export function removeStaleMedia(target: string, previous: Media, keep: readonly string[]): string[] {
  const keepSet = new Set(keep);
  const removed: string[] = [];
  for (const name of [previous.video, previous.audio, previous.mp3]) {
    if (name === null || keepSet.has(name)) continue;
    rmSync(join(target, name), { force: true });
    removed.push(name);
  }
  return removed;
}
