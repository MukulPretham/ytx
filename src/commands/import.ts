/**
 * `ytx import <path>...` — archive a local media file.
 *
 * The only provenance a local file can produce is `asr`, so this command skips
 * the caption ladder entirely and calls tier 4 directly. It never touches
 * yt-dlp and never writes to `queue.jsonl`: a local failure is fixed by hand,
 * not by re-fetching a URL.
 */

import { accessSync, constants, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { EXIT, asYtxError, fetchError, noTranscriptError, usageError, YtxError } from "../core/errors.ts";
import { localIdForSha256, localOriginUrl, videoDir } from "../core/paths.ts";
import { tryReadMeta, writeMetaFile, writeTranscriptFiles } from "../core/record.ts";
import { charsOf, type Media, type Meta, type TranscriptHistoryEntry, type TranscriptRecord } from "../core/schema.ts";
import { formatBytes, formatDuration } from "../core/ui.ts";
import { acquireTranscript, acquisitionOptions, requireAsrReady } from "./acquisition.ts";
import {
  ensureLibrary,
  failAfterEmit,
  requireFfmpeg,
  requireFfprobe,
  type CommandContext,
} from "./context.ts";
import { displayName, looksRemote, resolveImportPath } from "../local/identify.ts";
import {
  extractAudio,
  hashAndCopy,
  publishImport,
  removeStaleMedia,
  sourceExtension,
  stagingDirectory,
} from "../local/importer.ts";
import { probeMedia } from "../local/probe.ts";
import { makeMp3 } from "../ytdlp/run.ts";

export interface ImportFlags {
  language: string;
  allowRepetitive: boolean;
  force: boolean;
  transcriptOnly: boolean;
  title: string | null;
  parallel: number;
}

interface ImportTarget {
  /** The argument as typed, for error messages and `--force` advice. */
  input: string;
  /** The absolute path actually read. */
  path: string;
}

export async function cmdImport(
  context: CommandContext,
  positionals: string[],
  flags: ImportFlags,
): Promise<void> {
  if (positionals.length === 0) {
    throw usageError("import", "needs at least one file path", "run `ytx import ./talk.mp4`");
  }
  if (positionals.some((input) => input.trim() === "")) {
    throw usageError("import", "got an empty path", "pass a file path, for example `./talk.mp4`");
  }
  if (flags.title !== null && positionals.length > 1) {
    throw usageError(
      "import --title",
      "can only name one file at a time",
      "drop `--title`, or import the file on its own",
    );
  }
  if (flags.title !== null && flags.title.trim() === "") {
    throw usageError("import --title", "needs a non-empty title", "pass `--title \"A talk about archives\"`");
  }

  const targets = positionals.map(resolveTarget);
  await preflightImport(context, targets);

  ensureLibrary(context);

  const imported: string[] = [];
  const failures: YtxError[] = [];
  const limit = Math.max(1, flags.parallel);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, targets.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const target = targets[index];
      if (!target) return;
      try {
        const meta = await importOne(context, target, flags);
        imported.push(meta.id);
      } catch (err) {
        failures.push(asYtxError(err, `import ${target.input}`, "see the message above"));
      }
    }
  });
  await Promise.all(workers);

  const payload = { imported, failed: failures.map((error) => error.toJSON()) };
  if (failures.length > 0) failAfterEmit(context, payload, failures[0]!);
  context.ui.emit(payload);
}

function resolveTarget(input: string): ImportTarget {
  if (looksRemote(input)) {
    throw usageError(
      `import ${input}`,
      "is a URL, not a local file",
      "use `ytx add <url>` to archive a YouTube video",
    );
  }

  const path = resolveImportPath(input, { cwd: process.cwd(), home: homedir() });
  let stat;
  try {
    stat = statSync(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unknown error";
    const idShaped = /^[A-Za-z0-9_-]{11}$/.test(input.trim());
    throw usageError(
      `import ${input}`,
      `no such file (${path}; ${code})`,
      idShaped
        ? "that looks like a video id; use `ytx show <id>` or `ytx add <url>`"
        : "check the path; if it contains spaces, wrap the whole path in double quotes",
    );
  }
  if (stat.isDirectory()) {
    throw usageError(
      `import ${input}`,
      `${path} is a directory`,
      "pass the files, for example `ytx import ./talks/*.mp4`",
    );
  }
  if (!stat.isFile()) {
    throw usageError(`import ${input}`, `${path} is not a regular file`, "pass a media file");
  }
  return { input, path };
}

/**
 * Everything `import` needs, checked before the library is touched. yt-dlp is
 * deliberately absent: importing works on a machine that has never installed it.
 */
async function preflightImport(
  context: CommandContext,
  targets: readonly ImportTarget[],
): Promise<void> {
  for (const target of targets) {
    try {
      accessSync(target.path, constants.R_OK);
    } catch {
      throw fetchError(
        `file ${displayName(target.path)}`,
        "cannot be read",
        "check its permissions, or copy it somewhere readable",
      );
    }
  }
  requireFfprobe(context);
  requireFfmpeg(context);
  await requireAsrReady(context);
}

async function importOne(
  context: CommandContext,
  target: ImportTarget,
  flags: ImportFlags,
): Promise<Meta> {
  const { ui } = context;
  const filename = displayName(target.path);
  const stat = statSync(target.path);
  const probe = await probeMedia(context.ffprobe, target.path);

  if (probe.audioCodec === null) {
    throw noTranscriptError(
      `transcript for ${filename}`,
      "the file has no audio track, so there is nothing to transcribe",
      "re-mux it with an audio track, or keep it outside ytx",
    );
  }

  const details = [
    probe.durationS > 0 ? formatDuration(probe.durationS) : null,
    probe.height ? `${probe.width ? `${probe.width}x` : ""}${probe.height}` : "audio only",
    formatBytes(stat.size),
  ].filter((part): part is string => part !== null);
  ui.note(`importing ${filename} · ${details.join(" · ")}`);

  const incoming = stagingDirectory(context.library.videos);
  try {
    const ext = sourceExtension(target.path);
    const copyTarget = flags.transcriptOnly ? null : join(incoming, `source.${ext}`);
    const hashed = await hashAndCopy(target.path, copyTarget, (done) => {
      ui.progress(
        flags.transcriptOnly ? "hashing" : "hashing and copying",
        stat.size > 0 ? done / stat.size : null,
      );
    });
    ui.progressDone();

    const id = localIdForSha256(hashed.sha256);
    const dir = videoDir(context.library, id);
    const existing = tryReadMeta(context.library, id);
    if (existing.ok && !flags.force) {
      throw alreadyArchived(target, id);
    }
    const previous = existing.ok ? existing.meta : null;

    // The copy is named after the id, which is only known once every byte has
    // been hashed. Renaming inside the staging directory is free.
    const copied = copyTarget === null ? null : join(incoming, `${id}.${ext}`);
    if (copyTarget !== null && copied !== null) renameSync(copyTarget, copied);

    const warnings: string[] = [];
    const base = join(incoming, id);
    let audioPath: string;
    let audioName: string | null = null;

    if (probe.videoCodec === null) {
      // Audio-only input: the copied bytes are already the audio track, so no
      // extraction is needed. With --transcript-only the source is read in place.
      audioPath = copied ?? target.path;
      audioName = copied === null ? null : `${id}.${ext}`;
    } else {
      const extracted = await extractAudio({
        ffmpeg: context.ffmpeg,
        source: copied ?? target.path,
        base,
        codec: probe.audioCodec,
        onLine: context.flags.debug ? (line) => ui.note(`    ${line}`) : undefined,
      });
      audioPath = extracted.path;
      audioName = flags.transcriptOnly ? null : basename(extracted.path);
      warnings.push(...extracted.warnings);
    }

    const acquired = await acquireTranscript(context, {
      videoId: id,
      url: localOriginUrl(hashed.sha256),
      durationS: probe.durationS,
      availability: { human: {}, auto: {}, originalLanguage: null },
      ytdlpVersion: null,
      videoDir: incoming,
      ensureAudio: async () => audioPath,
      options: acquisitionOptions(context, {
        language: flags.language,
        // A local file has no caption tiers; tier 4 is the whole ladder.
        forceAsr: true,
        noAsr: false,
        strictLang: false,
        allowRepetitive: flags.allowRepetitive,
      }),
    });

    let mp3Name: string | null = null;
    if (!flags.transcriptOnly) {
      // An mp3 source is already the deliverable; re-encoding it would write
      // the same path as the input. Its `media.audio` is the mp3.
      if (!audioPath.toLowerCase().endsWith(".mp3")) {
        try {
          await makeMp3(context.ffmpeg, audioPath, join(incoming, `${id}.mp3`));
          mp3Name = `${id}.mp3`;
        } catch (err) {
          warnings.push(`could not generate the mp3 (${(err as YtxError).why ?? (err as Error).message})`);
          // Same bytes, same id: a previously generated mp3 is still the right
          // audio, so a transient conversion failure must not drop it.
          const kept = previous?.media.mp3;
          if (kept !== null && kept !== undefined && existsSync(join(dir, kept))) {
            mp3Name = kept;
          }
        }
      }
    } else if (audioPath.startsWith(base)) {
      // The extracted audio exists only to feed ASR. `publishImport` moves every
      // file in the staging directory, so remove it before publishing.
      rmSync(audioPath, { force: true });
    }

    // A transcript-only re-import keeps the media the record already has; it
    // must never delete files just because this run did not ask for them.
    const media: Media =
      (flags.transcriptOnly ? previous?.media : null) ?? {
        video: !flags.transcriptOnly && probe.videoCodec !== null ? `${id}.${ext}` : null,
        audio: flags.transcriptOnly ? null : audioName,
        mp3: mp3Name,
        height: !flags.transcriptOnly && probe.videoCodec !== null ? probe.height : null,
      };

    const now = new Date().toISOString();
    const transcript: TranscriptRecord = {
      source: "asr",
      language: acquired.language,
      model: acquired.model ?? "unknown",
      model_revision: acquired.modelRevision ?? "unknown",
      coverage: acquired.coverage,
      segments: acquired.segments.length,
      chars: charsOf(acquired.segments),
      fetched_at: now,
    };

    const meta: Meta = {
      schema: 2,
      origin: "file",
      id,
      url: localOriginUrl(hashed.sha256),
      source: { kind: "file", filename, bytes: hashed.bytes, sha256: hashed.sha256 },
      title: titleOf(target.path, probe.title, flags.title),
      channel: { id: null, name: "local file" },
      duration_s: probe.durationS,
      published: probe.published,
      chapters: probe.chapters,
      media,
      transcript,
      transcript_history: historyOf(previous, now),
      warnings: [...acquired.warnings, ...warnings],
      added_at: previous?.added_at ?? now,
      updated_at: now,
    };

    writeTranscriptFiles(incoming, id, acquired.segments);
    writeMetaFile(incoming, meta);

    if (existsSync(dir) && !flags.force) throw alreadyArchived(target, id);
    publishImport(incoming, dir, { force: flags.force });
    if (previous) {
      removeStaleMedia(
        dir,
        previous.media,
        [media.video, media.audio, media.mp3].filter((name): name is string => name !== null),
      );
    }

    ui.ok(`${id} transcript archived (${acquired.source}, ${acquired.segments.length} segments)`);
    for (const warning of meta.warnings) ui.warn(`  recorded warning: ${warning}`);
    if (!flags.transcriptOnly) ui.ok(`media archived: ${mediaSummary(media)}`);
    return meta;
  } finally {
    // A no-op once the staging directory was renamed into place.
    try {
      rmSync(incoming, { recursive: true, force: true });
    } catch {
      // Cleanup is best effort; `prune` sweeps anything left behind.
    }
  }
}

function alreadyArchived(target: ImportTarget, id: string): YtxError {
  return new YtxError({
    what: `import ${displayName(target.path)}`,
    why: `these bytes are already archived as ${id}`,
    next: `use \`ytx show ${id}\` to read it, or \`ytx import --force ${target.input}\` to replace it`,
    code: EXIT.usage,
    kind: "already-archived",
  });
}

function titleOf(path: string, probed: string | null, override: string | null): string {
  if (override !== null && override.trim() !== "") return override.trim();
  if (probed !== null) return probed;
  const stem = basename(path, extname(path)).trim();
  return stem !== "" ? stem : displayName(path);
}

function historyOf(previous: Meta | null, now: string): TranscriptHistoryEntry[] {
  if (previous === null) return [];
  return [...previous.transcript_history, { ...previous.transcript, superseded_at: now }];
}

function mediaSummary(media: Media): string {
  const parts = [
    media.video ? `${media.video}${media.height ? ` (${media.height}p)` : ""}` : "audio only",
    media.audio,
    media.mp3,
  ].filter((part): part is string => part !== null);
  return parts.join(" · ");
}
