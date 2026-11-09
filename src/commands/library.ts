/**
 * Library commands: init, add, transcript, show, list, search, retry, rm, prune.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, saveConfig } from "../core/config.ts";
import { EXIT, asYtxError, usageError, YtxError } from "../core/errors.ts";
import { canonicalWatchUrl, parseVideoUrl, videoDir } from "../core/paths.ts";
import {
  META_FILE,
  TRANSCRIPT_TXT,
  listVideoIds,
  readAllMeta,
  readMeta,
  readTranscript,
  tryReadMeta,
  writeMeta,
  writeTranscript,
} from "../core/record.ts";
import {
  PROVENANCES,
  type Media,
  type Meta,
  type Provenance,
  type TranscriptHistoryEntry,
  type TranscriptRecord,
  type TranscriptSegment,
} from "../core/schema.ts";
import { dueEntries, enqueue, readQueue, removeFromQueue, scheduleEntry } from "../core/queue.ts";
import { saveState } from "../core/state.ts";
import { columns, formatBytes, formatDuration } from "../core/ui.ts";
import { chapterLines, formatClock, mediaLine, provenanceLine, snippet } from "./render.ts";
import { acquireTranscript, acquisitionOptions } from "./acquisition.ts";
import type { CommandContext } from "./context.ts";
import { ensureLibrary, failAfterEmit, requireFfmpeg } from "./context.ts";
import { downloadMedia, fetchInfo, type YtdlpRawInfo } from "../ytdlp/run.ts";
import { acquireLock } from "../core/lock.ts";

/** Acquisition flags shared by `add`, `transcript` and `retry`. */
export interface QuestionFlags {
  quality: "auto" | "best";
  language: string;
  asr: boolean;
  noAsr: boolean;
  strictLang: boolean;
}

export interface AddFlags extends QuestionFlags {
  maxHeight: number;
  force: boolean;
  browser: string | null;
  parallel: number;
  noMedia: boolean;
}

export async function cmdInit(context: CommandContext, positionals: string[]): Promise<void> {
  const target = positionals[0];
  if (target) {
    // `ytx init <path>` writes a new library at an explicit location.
    const { resolveLibraryPaths } = await import("../core/paths.ts");
    const { paths } = resolveLibraryPaths({ env: process.env, cwd: process.cwd(), store: target });
    context.library = paths;
  }
  mkdirSync(context.library.videos, { recursive: true });
  if (!existsSync(context.library.config)) saveConfig(context.library, defaultConfig());
  if (!existsSync(context.library.queue)) writeFileSync(context.library.queue, "", "utf8");

  context.ui.ok(`library ready at ${context.library.root}`);
  context.ui.line(`  config   ${context.library.config}`);
  context.ui.line(`  videos   ${context.library.videos}`);
  context.ui.line(`  runtime  ${context.runtime.root}`);
  context.ui.emit({
    library: context.library.root,
    runtime: context.runtime.root,
    config: context.library.config,
    videos: context.library.videos,
  });
}

export async function cmdAdd(
  context: CommandContext,
  positionals: string[],
  flags: AddFlags,
): Promise<void> {
  if (positionals.length === 0) {
    throw usageError(
      "add",
      "needs at least one video URL",
      "run `ytx add https://www.youtube.com/watch?v=<id>`",
    );
  }

  ensureLibrary(context);
  context.config.max_height = flags.maxHeight;
  const acquired: string[] = [];
  const failures: YtxError[] = [];

  const targets = positionals.map((input) => {
    const parsed = parseVideoUrl(input);
    if (parsed.id === null) {
      if (parsed.kind === "playlist" || parsed.kind === "channel") {
        throw usageError(
          `add ${input}`,
          `is a ${parsed.kind}, and playlist or channel sync is not implemented in v1`,
          "pass one video URL at a time; `ytx sync` is a stub",
        );
      }
      throw usageError(
        `add ${input}`,
        "is not a YouTube video URL",
        "use a `youtube.com/watch?v=…`, `youtu.be/…` or `youtube.com/shorts/…` URL",
      );
    }
    return { url: canonicalWatchUrl(parsed.id), id: parsed.id };
  });

  const limit = Math.max(1, flags.parallel);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, targets.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const target = targets[index];
      if (!target) return;
      try {
        await addOne(context, target.url, target.id, flags);
        // Success clears any pending retry for this video.
        removeFromQueue(context.library, target.id);
        acquired.push(target.id);
      } catch (err) {
        const error = asYtxError(err, `add ${target.id}`, "see the message above");
        // Transient and upstream failures are queued with their class and a
        // next attempt time; permanent ones are never queued.
        if (
          error.kind !== "media-pending" &&
          (error.failureClass === "transient" || error.failureClass === "format-unavailable")
        ) {
          enqueue(context.library, {
            id: target.id,
            url: target.url,
            failure_class: error.failureClass === "format-unavailable" ? "format-unavailable" : "transient",
            attempts: 0,
            next_attempt_at: new Date().toISOString(),
            added_at: new Date().toISOString(),
            last_error: `${error.what}: ${error.why}`,
            stage: "add",
          });
          context.ui.note(`  queued ${target.id} for retry (\`ytx retry\`)`);
        }
        failures.push(error);
      }
    }
  });
  await Promise.all(workers);

  if (failures.length > 0) {
    failAfterEmit(context, { added: acquired, failed: failures.map((error) => error.toJSON()) }, failures[0]!);
  }
  context.ui.emit({ added: acquired, failed: [] });
}

async function addOne(
  context: CommandContext,
  url: string,
  videoId: string,
  flags: AddFlags,
): Promise<Meta> {
  const { ui } = context;
  const dir = videoDir(context.library, videoId);

  const existing = tryReadMeta(context.library, videoId);
  if (existing.ok && !flags.force) {
    throw new YtxError({
      what: `add ${videoId}`,
      why: `is already archived in ${dir}`,
      next: `use \`ytx transcript ${videoId}\` to refresh its transcript, or \`ytx add --force\` to re-archive`,
      code: EXIT.usage,
      kind: "already-archived",
    });
  }

  mkdirSync(dir, { recursive: true });
  ui.note(`fetching metadata for ${videoId}…`);
  const info = await fetchInfo(url, { ...context.downloader, browser: resolveBrowser(flags, context) });
  const raw = info.info;
  const durationS = typeof raw.duration === "number" && raw.duration > 0 ? raw.duration : 0;

  const acquired = await acquireTranscript(context, {
    videoId,
    url,
    durationS,
    availability: info.availability,
    ytdlpVersion: info.version,
    videoDir: dir,
    ensureAudio: async () => {
      const { downloadAudioStream, findExistingAudio } = await import("../ytdlp/run.ts");
      const present = findExistingAudio(dir, videoId);
      if (present) return present;
      requireFfmpeg(context);
      ui.note("  downloading audio for transcription…");
      const stream = await downloadAudioStream(url, videoId, dir, context.downloader, []);
      return stream.path;
    },
    options: acquisitionOptions(context, {
      quality: flags.quality,
      language: flags.language,
      forceAsr: flags.asr,
      noAsr: flags.noAsr,
      strictLang: flags.strictLang,
    }),
  });

  if (acquired.rawCaption) {
    const captionFile = join(dir, `caption.${acquired.rawCaption.language}.vtt`);
    // Raw platform tracks are immutable: never overwrite an existing one.
    if (!existsSync(captionFile)) writeFileSync(captionFile, acquired.rawCaption.vtt, "utf8");
  }

  writeTranscript(context.library, videoId, acquired.segments);

  const now = new Date().toISOString();
  const transcript: TranscriptRecord = {
    source: acquired.source,
    language: acquired.language,
    coverage: acquired.coverage,
    segments: acquired.segments.length,
    chars: acquired.segments.reduce((total, segment) => total + segment.text.length, 0),
    fetched_at: now,
    ...(acquired.source === "asr"
      ? { model: acquired.model ?? "unknown", model_revision: acquired.modelRevision ?? "unknown" }
      : { ytdlp_version: acquired.ytdlpVersion ?? info.version }),
  };

  const previous = existing.ok ? existing.meta : null;
  const previousTranscript = previous
    ? { ...previous.transcript, superseded_at: now } satisfies TranscriptHistoryEntry
    : null;

  const meta: Meta = {
    schema: 1,
    id: videoId,
    url,
    title: typeof raw.title === "string" ? raw.title : videoId,
    channel: channelOf(raw),
    duration_s: durationS,
    published: publishedOf(raw),
    chapters: chaptersOf(raw),
    media: previous?.media ?? { video: null, audio: null, mp3: null, height: null },
    transcript,
    transcript_history: [
      ...(previous?.transcript_history ?? []),
      ...(previousTranscript ? [previousTranscript] : []),
    ],
    added_at: previous?.added_at ?? now,
    updated_at: now,
  };
  writeMeta(context.library, meta);
  ui.ok(`${videoId} transcript archived (${acquired.source}, ${acquired.segments.length} segments)`);

  if (flags.noMedia) return meta;

  try {
    await downloadAndAttachMedia(context, meta, url, flags);
  } catch (err) {
    const error = asYtxError(err, `download media for ${videoId}`, "run `ytx retry` to try again");
    enqueue(context.library, {
      id: videoId,
      url,
      failure_class: error.failureClass === "format-unavailable" ? "format-unavailable" : "transient",
      attempts: 0,
      next_attempt_at: new Date().toISOString(),
      added_at: new Date().toISOString(),
      last_error: `${error.what}: ${error.why}`,
      stage: "media",
    });
    throw new YtxError({
      what: `add ${videoId}`,
      why: `the transcript is archived, but the media download failed: ${error.why}`,
      next: `${error.next}; \`ytx retry\` re-attempts the media only`,
      code: EXIT.fetch,
      failureClass: error.failureClass,
      kind: "media-pending",
    });
  }

  return meta;
}

export async function downloadAndAttachMedia(
  context: CommandContext,
  meta: Meta,
  url: string,
  flags: { maxHeight: number },
): Promise<Media> {
  const { ui } = context;
  const dir = videoDir(context.library, meta.id);
  requireFfmpeg(context);
  ui.note(`downloading media for ${meta.id} (max ${flags.maxHeight}p)…`);
  const result = await downloadMedia(url, meta.id, dir, context.downloader, {
    maxHeight: flags.maxHeight,
    ffmpeg: context.ffmpeg,
  });
  for (const warning of result.warnings) ui.warn(warning);

  const media: Media = {
    video: result.video ? basename(result.video) : null,
    audio: result.audio ? basename(result.audio) : null,
    mp3: result.mp3 ? basename(result.mp3) : null,
    height: result.height,
  };
  meta.media = media;
  meta.updated_at = new Date().toISOString();
  writeMeta(context.library, meta);

  context.state = {
    ...context.state,
    ytdlp: context.state.ytdlp
      ? context.state.ytdlp
      : { version: "unknown", channel: "stable", installed_at: new Date().toISOString(), previous_version: null },
  };
  saveState(context.runtime.state, context.state);

  const parts = [
    media.video ? `${media.video}${media.height ? ` (${media.height}p)` : ""}` : "audio only",
    media.audio ? media.audio : "no audio",
    media.mp3 ? media.mp3 : "no mp3",
  ];
  ui.ok(`media archived: ${parts.join(" · ")}`);
  return media;
}

export async function cmdTranscript(
  context: CommandContext,
  positionals: string[],
  flags: QuestionFlags,
): Promise<void> {
  const target = requireTarget(positionals, "transcript");
  const meta = readMeta(context.library, target);

  const info = await fetchInfo(meta.url, context.downloader);
  const durationS = typeof info.info.duration === "number" ? info.info.duration : meta.duration_s;
  const dir = videoDir(context.library, meta.id);

  const acquired = await acquireTranscript(context, {
    videoId: meta.id,
    url: meta.url,
    durationS,
    availability: info.availability,
    ytdlpVersion: info.version,
    videoDir: dir,
    ensureAudio: async () => {
      const { downloadAudioStream, findExistingAudio } = await import("../ytdlp/run.ts");
      const present = findExistingAudio(dir, meta.id);
      if (present) return present;
      requireFfmpeg(context);
      const stream = await downloadAudioStream(meta.url, meta.id, dir, context.downloader, []);
      return stream.path;
    },
    options: acquisitionOptions(context, {
      quality: flags.quality,
      language: flags.language,
      forceAsr: flags.asr,
      noAsr: flags.noAsr,
      strictLang: flags.strictLang,
    }),
  });

  if (acquired.rawCaption) {
    const captionFile = join(dir, `caption.${acquired.rawCaption.language}.vtt`);
    if (!existsSync(captionFile)) writeFileSync(captionFile, acquired.rawCaption.vtt, "utf8");
  }
  writeTranscript(context.library, meta.id, acquired.segments);

  const now = new Date().toISOString();
  const next: TranscriptRecord = {
    source: acquired.source,
    language: acquired.language,
    coverage: acquired.coverage,
    segments: acquired.segments.length,
    chars: acquired.segments.reduce((total, segment) => total + segment.text.length, 0),
    fetched_at: now,
    ...(acquired.source === "asr"
      ? { model: acquired.model ?? "unknown", model_revision: acquired.modelRevision ?? "unknown" }
      : { ytdlp_version: acquired.ytdlpVersion ?? info.version }),
  };

  // Every rewrite appends the superseded entry; nothing is lost.
  meta.transcript_history = [
    ...meta.transcript_history,
    { ...meta.transcript, superseded_at: now },
  ];
  meta.transcript = next;
  meta.updated_at = now;
  writeMeta(context.library, meta);

  context.ui.ok(`${meta.id} transcript replaced (${acquired.source}, ${acquired.segments.length} segments)`);
  context.ui.line(`  ${provenanceLine(meta)}`);
  context.ui.emit({ id: meta.id, transcript: next, attempts: acquired.attempts });
}

export async function cmdShow(
  context: CommandContext,
  positionals: string[],
  flags: { raw: boolean; timestamps: boolean; history: boolean },
): Promise<void> {
  const id = requireTarget(positionals, "show");
  const meta = readMeta(context.library, id);
  const segments = readTranscript(context.library, id);

  if (flags.raw) {
    if (context.flags.json) {
      context.ui.emit({ id, transcript: segments });
    } else {
      process.stdout.write(readFileSync(join(videoDir(context.library, id), TRANSCRIPT_TXT), "utf8"));
    }
    return;
  }

  if (flags.timestamps && !context.flags.json) {
    for (const segment of segments) {
      context.ui.line(`${formatClock(segment.start)}  ${segment.text}`);
    }
    return;
  }

  const { ui } = context;
  ui.heading(`${meta.channel.name} — ${meta.title}`);
  ui.line(`${meta.id} · ${formatDuration(meta.duration_s)} · published ${meta.published ?? "unknown"}`);
  ui.line(`provenance  ${provenanceLine(meta)}`);
  ui.line(`media       ${mediaLine(meta)}`);
  ui.line(`added       ${meta.added_at}${meta.transcript_history.length > 0 ? ` · ${meta.transcript_history.length} earlier transcript(s)` : ""}`);
  const chapters = chapterLines(meta);
  if (chapters.length > 0) {
    ui.line("chapters");
    for (const chapter of chapters) ui.line(chapter);
  }
  ui.line("");
  for (const segment of segments) ui.line(segment.text);
  ui.emit({ meta, segments });

  if (flags.history) {
    for (const entry of meta.transcript_history) {
      ui.line(`  superseded ${entry.superseded_at}: ${entry.source} ${entry.language} (${entry.segments} segments)`);
    }
  }
}

export async function cmdList(
  context: CommandContext,
  flags: { source?: string; sort?: string; limit?: number },
): Promise<void> {
  const { records, broken } = readAllMeta(context.library);
  const wanted = flags.source ? provenanceFilter(flags.source) : null;
  const filtered = wanted ? records.filter((record) => record.transcript.source === wanted) : records;

  const sorted = [...filtered].sort((a, b) => {
    if (flags.sort === "title") return a.title.localeCompare(b.title);
    if (flags.sort === "duration") return b.duration_s - a.duration_s;
    if (flags.sort === "oldest") return a.added_at.localeCompare(b.added_at);
    return b.added_at.localeCompare(a.added_at);
  });
  const shown = flags.limit ? sorted.slice(0, flags.limit) : sorted;

  if (!context.flags.json) {
    if (shown.length === 0) {
      context.ui.line("no videos archived yet");
      context.ui.note("  add one with `ytx add <url>`");
    } else {
      const rows = shown.map((record) => [
        markerOf(record),
        record.id,
        formatDuration(record.duration_s),
        record.transcript.language,
        `${record.transcript.segments}`,
        record.title,
      ]);
      context.ui.line(
        columns([
          ["", "id", "length", "lang", "seg", "title"],
          ...rows,
        ])
          .slice(1)
          .join("\n"),
      );
    }
    if (broken.length > 0) {
      context.ui.warn(`${broken.length} record(s) failed validation; run \`ytx doctor\` for detail`);
    }
  }

  context.ui.emit({
    videos: shown.map((record) => ({
      id: record.id,
      title: record.title,
      channel: record.channel.name,
      duration_s: record.duration_s,
      language: record.transcript.language,
      source: record.transcript.source,
      marker: markerOf(record),
      segments: record.transcript.segments,
      chars: record.transcript.chars,
      coverage: record.transcript.coverage,
      added_at: record.added_at,
    })),
    broken: broken.map((entry) => ({ id: entry.id, error: entry.error.toJSON() })),
  });
}

export async function cmdSearch(
  context: CommandContext,
  positionals: string[],
  flags: { source?: string; limit: number; context: number; ids?: string[] },
): Promise<void> {
  const query = positionals.join(" ").trim();
  if (query === "") {
    throw usageError("search", "needs a query", "run `ytx search \"some words\"`");
  }
  const needle = query.toLowerCase();
  const { records } = readAllMeta(context.library);
  const wanted = flags.source ? provenanceFilter(flags.source) : null;
  const candidates = wanted ? records.filter((record) => record.transcript.source === wanted) : records;

  type Match = {
    id: string;
    title: string;
    source: Provenance;
    marker: string;
    start: number;
    end: number;
    text: string;
    snippet: string;
  };
  const matches: Match[] = [];

  for (const record of candidates) {
    if (flags.ids && flags.ids.length > 0 && !flags.ids.includes(record.id)) continue;
    let segments: TranscriptSegment[];
    try {
      segments = readTranscript(context.library, record.id);
    } catch {
      continue;
    }
    for (const segment of segments) {
      const index = segment.text.toLowerCase().indexOf(needle);
      if (index < 0) continue;
      matches.push({
        id: record.id,
        title: record.title,
        source: record.transcript.source,
        marker: markerOf(record),
        start: segment.start,
        end: segment.end,
        text: segment.text,
        snippet: snippet(segment.text, index, needle.length, flags.context),
      });
      if (matches.length >= flags.limit) break;
    }
    if (matches.length >= flags.limit) break;
  }

  if (!context.flags.json) {
    if (matches.length === 0) {
      context.ui.line(`no matches for "${query}"`);
    } else {
      for (const match of matches) {
        context.ui.line(
          `${match.marker} ${context.ui.bold(match.id)} ${context.ui.cyan(formatClock(match.start))}  ${match.snippet}`,
        );
      }
      context.ui.note(`${matches.length} match(es) for "${query}"`);
    }
  }
  context.ui.emit({ query, matches });
}

export async function cmdRetry(
  context: CommandContext,
  flags: { all: boolean; limit: number },
): Promise<void> {
  const entries = flags.all ? readQueue(context.library) : dueEntries(context.library);
  if (entries.length === 0) {
    context.ui.line("queue is empty; nothing to retry");
    context.ui.emit({ retried: [], remaining: readQueue(context.library).length });
    return;
  }

  const retried: string[] = [];
  const failed: { id: string; reason: string }[] = [];

  for (const entry of entries.slice(0, flags.limit)) {
    context.ui.note(`retrying ${entry.id} (${entry.stage})…`);
    try {
      if (entry.stage === "add") {
        // The queue records "this video still needs archiving". If it is
        // archived now, the work is done - re-downloading it would only spend
        // quota to reach the same state.
        const archived = tryReadMeta(context.library, entry.id);
        if (archived.ok && archived.meta.media.audio !== null) {
          removeFromQueue(context.library, entry.id);
          retried.push(entry.id);
          context.ui.ok(`${entry.id} was archived by an earlier run; removed from the queue`);
          continue;
        }
      }
      if (entry.stage === "media") {
        const meta = readMeta(context.library, entry.id);
        await downloadAndAttachMedia(context, meta, entry.url, { maxHeight: context.config.max_height });
      } else {
        await addOne(context, canonicalWatchUrl(entry.id), entry.id, {
          ...defaultAddFlags(context),
          force: true,
        });
      }
      removeFromQueue(context.library, entry.id);
      retried.push(entry.id);
      context.ui.ok(`${entry.id} retried successfully`);
    } catch (err) {
      const error = asYtxError(err, `retry ${entry.id}`, "fix the cause above");
      const permanent = error.failureClass === "gone-or-private" || error.failureClass === "bot-check";
      if (permanent) {
        removeFromQueue(context.library, entry.id);
        failed.push({ id: entry.id, reason: error.why });
        context.ui.fail(`${entry.id}: ${error.why} (removed from the queue)`);
        continue;
      }
      const next = scheduleEntry(entry, entry.attempts + 1, error.why);
      enqueue(context.library, next);
      failed.push({ id: entry.id, reason: error.why });
      context.ui.warn(`${entry.id}: ${error.why}; next attempt ${next.next_attempt_at}`);
    }
  }

  const payload = { retried, failed, remaining: readQueue(context.library).length };
  if (failed.length > 0 && retried.length === 0) {
    failAfterEmit(
      context,
      payload,
      new YtxError({
        what: "retry",
        why: `${failed.length} item(s) still failing`,
        next: "see the message above; transient failures stay queued with a backoff",
        code: EXIT.fetch,
        kind: "retry-failed",
      }),
    );
  }
  context.ui.emit(payload);
}

export function defaultAddFlags(context: CommandContext): AddFlags {
  return {
    maxHeight: context.config.max_height,
    force: false,
    browser: context.config.browser,
    parallel: context.config.parallel,
    noMedia: false,
    quality: context.config.quality,
    language: context.config.language,
    asr: false,
    noAsr: false,
    strictLang: false,
  };
}

export async function cmdRm(
  context: CommandContext,
  positionals: string[],
  flags: { yes: boolean },
): Promise<void> {
  if (positionals.length === 0) {
    throw usageError("rm", "needs at least one video id", "run `ytx list` to see what is archived");
  }
  const targets = positionals.map((input) => parseVideoUrl(input).id ?? input);
  const lock = acquireLock(context.runtime.locks, "library", `ytx rm`);
  const removed: string[] = [];
  try {
    for (const id of targets) {
      const dir = videoDir(context.library, id);
      if (!existsSync(dir)) {
        context.ui.warn(`${id} is not archived`);
        continue;
      }
      if (!flags.yes && !context.flags.nonInteractive) {
        if (!process.stdin.isTTY) {
          throw usageError(
            `rm ${id}`,
            "would delete data and stdin is not a terminal, so confirmation cannot be asked",
            "re-run with `--yes` to confirm",
          );
        }
        const answer = prompt(`Delete ${dir}? [y/N]`);
        if (!answer || !/^y(es)?$/i.test(answer.trim())) {
          context.ui.line(`skipped ${id}`);
          continue;
        }
      }
      const size = dirSize(dir);
      rmSync(dir, { recursive: true, force: true });
      removed.push(id);
      context.ui.ok(`removed ${id} (${formatBytes(size)} freed)`);
    }
  } finally {
    lock.release();
  }
  context.ui.emit({ removed });
}

export async function cmdPrune(
  context: CommandContext,
  flags: { dryRun: boolean; yes: boolean },
): Promise<void> {
  const targets: { path: string; reason: string; bytes: number }[] = [];

  const { stagingDirectories } = await import("../models/manager.ts");
  for (const path of stagingDirectories(context.runtime)) {
    targets.push({ path, reason: "unfinished model download", bytes: dirSize(path) });
  }

  if (existsSync(context.library.videos)) {
    for (const id of listVideoIds(context.library)) {
      const dir = videoDir(context.library, id);
      if (existsSync(join(dir, META_FILE))) continue;
      targets.push({ path: dir, reason: "video directory without meta.json", bytes: dirSize(dir) });
    }
  }

  if (existsSync(context.runtime.tmp)) {
    targets.push({ path: context.runtime.tmp, reason: "runtime scratch files", bytes: dirSize(context.runtime.tmp) });
  }

  const total = targets.reduce((sum, target) => sum + target.bytes, 0);
  if (!context.flags.json) {
    if (targets.length === 0) {
      context.ui.line("nothing to prune");
    } else {
      for (const target of targets) {
        context.ui.line(`${formatBytes(target.bytes).padStart(9)}  ${target.path}  ${context.ui.dim(target.reason)}`);
      }
      context.ui.line(`${formatBytes(total)} reclaimable`);
    }
  }

  if (!flags.dryRun && targets.length > 0) {
    if (!flags.yes && !context.flags.nonInteractive && process.stdin.isTTY) {
      const answer = prompt(`Delete ${targets.length} path(s)? [y/N]`);
      if (!answer || !/^y(es)?$/i.test(answer.trim())) {
        context.ui.line("skipped");
        context.ui.emit({ pruned: [], reclaimed_bytes: 0, dry_run: flags.dryRun });
        return;
      }
    }
    for (const target of targets) rmSync(target.path, { recursive: true, force: true });
    context.ui.ok(`freed ${formatBytes(total)}`);
  }

  context.ui.emit({
    dry_run: flags.dryRun,
    pruned: flags.dryRun ? [] : targets.map((target) => target.path),
    candidates: targets.map((target) => ({ path: target.path, reason: target.reason, bytes: target.bytes })),
    reclaimed_bytes: flags.dryRun ? 0 : total,
  });
}

export async function cmdSync(_context: CommandContext, positionals: string[]): Promise<void> {
  void positionals;
  throw new YtxError({
    what: "sync",
    why: "playlist and channel sync is a stub in v1; it is not implemented",
    next: "archiving individual videos with `ytx add <url>` is fully supported",
    code: EXIT.usage,
    kind: "not-implemented",
  });
}

function requireTarget(positionals: string[], command: string): string {
  const input = positionals[0];
  if (!input) {
    throw usageError(
      command,
      "needs a video id or URL",
      "run `ytx list` to see archived videos",
    );
  }
  const parsed = parseVideoUrl(input);
  if (parsed.id === null) {
    if (/^[A-Za-z0-9_-]{11}$/.test(input)) return input;
    throw usageError(`${command} ${input}`, "is not a video id or URL", "pass an 11-character id or a YouTube URL");
  }
  return parsed.id;
}

export function provenanceFilter(value: string): Provenance | null {
  const normalized = value.trim().toLowerCase();
  const alias: Record<string, Provenance> = {
    h: "caption-human",
    human: "caption-human",
    "caption-human": "caption-human",
    a: "caption-auto",
    auto: "caption-auto",
    machine: "caption-auto",
    "caption-auto": "caption-auto",
    m: "asr",
    asr: "asr",
    local: "asr",
    whisper: "asr",
  };
  const found = alias[normalized];
  if (!found) {
    throw usageError(
      `--source ${value}`,
      `is not a provenance; expected one of ${PROVENANCES.join(", ")}`,
      "use `--source caption-human`, `--source caption-auto` or `--source asr`",
    );
  }
  return found;
}

function markerOf(record: Meta): string {
  return { "caption-human": "H", "caption-auto": "A", asr: "M" }[record.transcript.source];
}

function resolveBrowser(flags: AddFlags, context: CommandContext): string {
  if (flags.browser !== null) return flags.browser;
  return context.config.browser;
}

function channelOf(info: YtdlpRawInfo): Meta["channel"] {
  return {
    id: typeof info.channel_id === "string" ? info.channel_id : null,
    name:
      typeof info.channel === "string"
        ? info.channel
        : typeof info.uploader === "string"
          ? info.uploader
          : "unknown channel",
  };
}

function publishedOf(info: YtdlpRawInfo): string | null {
  const raw = info.upload_date;
  if (typeof raw !== "string" || !/^\d{8}$/.test(raw)) return null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function chaptersOf(info: YtdlpRawInfo): Meta["chapters"] {
  if (!Array.isArray(info.chapters)) return [];
  return info.chapters
    .filter((chapter) => typeof chapter?.title === "string" && Number.isFinite(chapter.start_time))
    .map((chapter) => ({ start_s: Number(chapter.start_time), title: String(chapter.title) }));
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function dirSize(path: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      try {
        total += entry.isDirectory() ? dirSize(child) : statSync(child).size;
      } catch {
        // A file may vanish mid-scan; sizes are advisory.
      }
    }
  } catch {
    return 0;
  }
  return total;
}
