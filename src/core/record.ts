/**
 * Reading and writing the on-disk record set.
 *
 * Writes are atomic (temp file + rename) and validated first, so an interrupted
 * write leaves either the old record or the new one, never half of each.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { formatZodIssues } from "./config.ts";
import { integrityError, YtxError } from "./errors.ts";
import {
  MetaSchema,
  TranscriptSchema,
  type Meta,
  type TranscriptSegment,
} from "./schema.ts";
import type { LibraryPaths } from "./paths.ts";
import { videoDir } from "./paths.ts";

export const META_FILE = "meta.json";
export const TRANSCRIPT_JSON = "transcript.json";
export const TRANSCRIPT_TXT = "transcript.txt";

export function metaPath(library: LibraryPaths, videoId: string): string {
  return join(videoDir(library, videoId), META_FILE);
}

export function transcriptJsonPath(library: LibraryPaths, videoId: string): string {
  return join(videoDir(library, videoId), TRANSCRIPT_JSON);
}

export function transcriptTxtPath(library: LibraryPaths, videoId: string): string {
  return join(videoDir(library, videoId), TRANSCRIPT_TXT);
}

export type MetaReadResult =
  | { ok: true; meta: Meta }
  | { ok: false; error: YtxError; path: string };

/**
 * Validate a record without throwing. `doctor` needs to name every broken
 * record and keep going, so the throwing path below is built on this.
 */
export function tryReadMeta(library: LibraryPaths, videoId: string): MetaReadResult {
  const path = metaPath(library, videoId);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    return {
      ok: false,
      path,
      error: integrityError(
        `record ${videoId}`,
        code === "ENOENT" ? "meta.json is missing" : `meta.json cannot be read (${code})`,
        `re-add the video with \`ytx add https://www.youtube.com/watch?v=${videoId}\``,
      ),
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      path,
      error: integrityError(
        `record ${videoId}`,
        `meta.json is not valid JSON (${(err as Error).message.split("\n")[0]})`,
        `restore ${path} from a backup, or re-add the video`,
      ),
    };
  }

  const parsed = MetaSchema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      path,
      error: integrityError(
        `record ${videoId}`,
        `meta.json failed validation: ${formatZodIssues(parsed.error)}`,
        `restore ${path} from a backup, or re-add the video`,
      ),
    };
  }
  return { ok: true, meta: parsed.data };
}

export function readMeta(library: LibraryPaths, videoId: string): Meta {
  const result = tryReadMeta(library, videoId);
  if (!result.ok) throw result.error;
  return result.meta;
}

/** Write a record only after validation; a rejected record touches nothing. */
export function writeMeta(library: LibraryPaths, meta: Meta): void {
  writeJsonValidated(metaPath(library, meta.id), MetaSchema, meta, "meta.json");
}

export function readTranscript(library: LibraryPaths, videoId: string): TranscriptSegment[] {
  const path = transcriptJsonPath(library, videoId);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown";
    throw integrityError(
      `transcript for ${videoId}`,
      code === "ENOENT" ? "transcript.json is missing" : `transcript.json cannot be read (${code})`,
      "re-run `ytx transcript <url>` to regenerate it",
    );
  }
  return parseTranscriptText(text, path);
}

export function parseTranscriptText(text: string, label: string): TranscriptSegment[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw integrityError(
      `transcript ${label}`,
      `not valid JSON (${(err as Error).message.split("\n")[0]})`,
      "re-run `ytx transcript <url>` to regenerate it",
    );
  }
  const parsed = TranscriptSchema.safeParse(data);
  if (!parsed.success) {
    throw integrityError(
      `transcript ${label}`,
      `failed validation: ${formatZodIssues(parsed.error)}`,
      "re-run `ytx transcript <url>` to regenerate it",
    );
  }
  return parsed.data;
}

export function writeTranscript(
  library: LibraryPaths,
  videoId: string,
  segments: TranscriptSegment[],
): void {
  const parsed = TranscriptSchema.safeParse(segments);
  if (!parsed.success) {
    throw integrityError(
      `transcript for ${videoId}`,
      `refusing to write invalid segments: ${formatZodIssues(parsed.error)}`,
      "report this as a bug in ytx",
    );
  }
  writeJsonValidated(transcriptJsonPath(library, videoId), TranscriptSchema, parsed.data, "transcript.json");
  writeFileSync(transcriptTxtPath(library, videoId), renderTranscriptText(parsed.data), "utf8");
}

/** The plain-text rendering: paragraph blocks separated by a blank line. */
export function renderTranscriptText(segments: readonly TranscriptSegment[]): string {
  return segments.map((segment) => segment.text.trim()).join("\n\n") + "\n";
}

/** Every directory name under `videos/`, sorted, whether or not it validates. */
export function listVideoIds(library: LibraryPaths): string[] {
  try {
    return readdirSync(library.videos, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw new YtxError({
      what: "library",
      why: `cannot list ${library.videos} (${code ?? "unknown error"})`,
      next: "check the library path and its permissions",
      code: 6,
      kind: "integrity",
      cause: err,
    });
  }
}

/** Read every valid record, reporting broken ones instead of throwing. */
export function readAllMeta(library: LibraryPaths): {
  records: Meta[];
  broken: { id: string; error: YtxError }[];
} {
  const records: Meta[] = [];
  const broken: { id: string; error: YtxError }[] = [];
  for (const id of listVideoIds(library)) {
    const result = tryReadMeta(library, id);
    if (result.ok) records.push(result.meta);
    else broken.push({ id, error: result.error });
  }
  return { records, broken };
}

function writeJsonValidated<T>(
  path: string,
  schema: z.ZodType<T>,
  value: T,
  label: string,
): void {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw integrityError(
      label,
      `refusing to write an invalid record: ${formatZodIssues(parsed.error)}`,
      "report this as a bug in ytx",
    );
  }
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(parsed.data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}
