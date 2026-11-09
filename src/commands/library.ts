/**
 * Library commands: init, add, transcript, show, list, search, retry, rm, prune.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { defaultConfig, saveConfig } from "../core/config.ts";
import { EXIT, asYtxError, fetchError, usageError, YtxError } from "../core/errors.ts";
import { canonicalWatchUrl, parseVideoUrl, videoDir } from "../core/paths.ts";
import {
  META_FILE,
  TRANSCRIPT_JSON,
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
import {
  TRANSCRIPT_FORMATS,
  chapterLines,
  formatClock,
  mediaLine,
  provenanceLine,
  renderTranscript,
  snippet,
  type TranscriptFormat,
} from "./render.ts";
import { acquireTranscript, acquisitionOptions } from "./acquisition.ts";
import type { CommandContext } from "./context.ts";
import { ensureLibrary, failAfterEmit, requireDownloader, requireFfmpeg } from "./context.ts";
import {
  downloadAudioStream,
  downloadMedia,
  fetchInfo,
  findExistingAudio,
  type YtdlpRawInfo,
} from "../ytdlp/run.ts";
import { acquireLock } from "../core/lock.ts";
import { catalogChoices } from "../models/catalog.ts";
import { configuredModel, resolveModelPath } from "../models/manager.ts";
import { findUv } from "../asr/venv.ts";

/** Acquisition flags shared by `add`, `transcript` and `retry`. */
export interface QuestionFlags {
  quality: "auto" | "best";
  language: string;
  asr: boolean;
  noAsr: boolean;
  strictLang: boolean;
  /** `--allow-repetitive`: bypass the repetition gate for any source. */
  allowRepetitive: boolean;
}

export interface AddFlags extends QuestionFlags {
  maxHeight: number;
  force: boolean;
  browser: string | null;
  parallel: number;
  noMedia: boolean;
}

export interface TranscriptFlags extends QuestionFlags {
  format: TranscriptFormat;
  timestamps: boolean;
}

export interface ShowFlags {
  raw: boolean;
  timestamps: boolean;
  history: boolean;
  format: TranscriptFormat;
}

export interface ListFlags {
  source?: string;
  sort?: string;
  limit?: number;
  missingTranscript: boolean;
  missingMedia: boolean;
}

export interface SearchFlags {
  source?: string;
  limit: number;
  context: number;
  ids?: string[];
  transcriptsOnly: boolean;
}

export interface RetryFlags {
  all: boolean;
  limit: number;
  /** Drop an entry once it has failed this many times. null means no cap. */
  maxAttempts: number | null;
  dryRun: boolean;
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

/**
 * Everything `add` will need, checked before the first byte is written to the
 * library. A dependency failure therefore leaves the store byte-identical.
 */
async function preflightAdd(context: CommandContext, flags: AddFlags): Promise<void> {
  await requireDownloader(context);
  if (!flags.noMedia) requireFfmpeg(context);
  // Tier 4 is only certain under `--asr`; without it, captions may satisfy the
  // ladder and the model is not needed. The staging directory still protects
  // the store when a fallback to ASR fails.
  if (flags.asr) await requireAsrReady(context);
}

/** Fail with the model choices, not a download, when ASR cannot run. */
async function requireAsrReady(context: CommandContext): Promise<void> {
  const name = configuredModel(context.state.default_model, context.config.asr_model);
  if (name === "none") {
    throw usageError(
      "transcription",
      'no local model is configured (asr_model = "none")',
      `choose one with \`ytx models add <name>\` (${catalogChoices()}), then \`ytx models default <name>\``,
    );
  }
  resolveModelPath(context.runtime, name);
  requireFfmpeg(context);
  if (findUv(context.runtime) === null) {
    throw fetchError(
      "transcription environment",
      "uv is not installed, so the mlx-whisper venv cannot be created",
      "run `ytx setup` to install it",
    );
  }
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

  const targets = positionals.map((input) => {
    const parsed = parseVideoUrl(input);
    if (parsed.id === null) {
      if (parsed.kind === "playlist" || parsed.kind === "channel") {
        throw usageError(
          `add ${input}`,
          `is a ${parsed.kind}, and playlist or channel sync is not implemented in v1`,
          "pass one video URL at a time; `ytx sync` is not implemented in v1",
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

  // Preflight runs before ensureLibrary so a dependency failure does not even
  // create the store skeleton on a fresh machine.
  await preflightAdd(context, flags);

  ensureLibrary(context);
  context.config.max_height = flags.maxHeight;
  const acquired: string[] = [];
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
      next: `use \`ytx add --force\` to re-archive it, or \`ytx show ${videoId}\` to read the transcript`,
      code: EXIT.usage,
      kind: "already-archived",
    });
  }

  ui.note(`fetching metadata for ${videoId}…`);
  const info = await fetchInfo(url, { ...context.downloader, browser: resolveBrowser(flags, context) });
  const raw = info.info;
  const durationS = typeof raw.duration === "number" && raw.duration > 0 ? raw.duration : 0;

  // Acquisition writes only to this scratch directory. The library directory
  // appears after a transcript exists, so a failed acquisition leaves no
  // meta-less record directory behind.
  mkdirSync(context.runtime.tmp, { recursive: true });
  const staging = mkdtempSync(join(context.runtime.tmp, `add-${videoId}-`));
  try {
    const acquired = await acquireTranscript(context, {
      videoId,
      url,
      durationS,
      availability: info.availability,
      ytdlpVersion: info.version,
      videoDir: staging,
      ensureAudio: async () => {
        const present = findExistingAudio(dir, videoId);
        if (present) return present;
        const staged = findExistingAudio(staging, videoId);
        if (staged) return staged;
        requireFfmpeg(context);
        ui.note("  downloading audio for transcription…");
        const stream = await downloadAudioStream(url, videoId, staging, context.downloader, []);
        return stream.path;
      },
      options: acquisitionOptions(context, {
        quality: flags.quality,
        language: flags.language,
        forceAsr: flags.asr,
        noAsr: flags.noAsr,
        strictLang: flags.strictLang,
        allowRepetitive: flags.allowRepetitive,
      }),
    });

    // The transcript exists; from here on the library is written deliberately.
    mkdirSync(dir, { recursive: true });
    if (acquired.rawCaption) {
      const captionFile = join(dir, `caption.${acquired.rawCaption.language}.vtt`);
      // Raw platform tracks are immutable: never overwrite an existing one.
      if (!existsSync(captionFile)) writeFileSync(captionFile, acquired.rawCaption.vtt, "utf8");
    }
    // Keep the audio downloaded for ASR only when media will be archived too:
    // it is the original track and saves a second download. `--transcript-only`
    // means no media files, so the scratch copy is discarded with the staging
    // directory instead of leaving an unrecorded m4a beside the transcript.
    if (!flags.noMedia) {
      const stagedAudio = findExistingAudio(staging, videoId);
      if (stagedAudio && !findExistingAudio(dir, videoId)) {
        renameSync(stagedAudio, join(dir, basename(stagedAudio)));
      }
    }

    writeTranscript(context.library, videoId, acquired.segments);

    const now = new Date().toISOString();
    const transcript = transcriptRecordOf(acquired, info.version, info.source, now);

    const previous = existing.ok ? existing.meta : null;
    const previousTranscript = previous
      ? ({ ...previous.transcript, superseded_at: now } satisfies TranscriptHistoryEntry)
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
      warnings: acquired.warnings,
      added_at: previous?.added_at ?? now,
      updated_at: now,
    };
    writeMeta(context.library, meta);
    ui.ok(`${videoId} transcript archived (${acquired.source}, ${acquired.segments.length} segments)`);
    for (const warning of acquired.warnings) ui.warn(`  recorded warning: ${warning}`);

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
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function transcriptRecordOf(
  acquired: Awaited<ReturnType<typeof acquireTranscript>>,
  ytdlpVersion: string,
  ytdlpSource: "managed" | "system",
  now: string,
): TranscriptRecord {
  return {
    source: acquired.source,
    language: acquired.language,
    coverage: acquired.coverage,
    segments: acquired.segments.length,
    chars: acquired.segments.reduce((total, segment) => total + segment.text.length, 0),
    fetched_at: now,
    ...(acquired.source === "asr"
      ? { model: acquired.model ?? "unknown", model_revision: acquired.modelRevision ?? "unknown" }
      : { ytdlp_version: acquired.ytdlpVersion ?? ytdlpVersion, ytdlp_source: ytdlpSource }),
  };
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
      : {
          version: "unknown",
          channel: "stable",
          source: context.downloader.source,
          installed_at: new Date().toISOString(),
          previous_version: null,
        },
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

/**
 * `transcript <url>` fetches and prints without writing; `transcript <id>` reads
 * the store and prints in the requested format. A URL never mutates a library.
 */
export async function cmdTranscript(
  context: CommandContext,
  positionals: string[],
  flags: TranscriptFlags,
): Promise<void> {
  const input = positionals[0];
  if (!input) {
    throw usageError(
      "transcript",
      "needs a video id or URL",
      "run `ytx transcript <url>` to preview, or `ytx transcript <id>` to read the store",
    );
  }

  const looksLikeUrl = !/^[A-Za-z0-9_-]{11}$/.test(input.trim());
  if (looksLikeUrl) {
    return previewTranscript(context, input, flags);
  }

  const meta = readMeta(context.library, input);
  const segments = readTranscript(context.library, input);
  outputTranscript(context, {
    id: meta.id,
    source: meta.transcript.source,
    language: meta.transcript.language,
    segments,
    format: flags.format,
    timestamps: flags.timestamps,
    meta,
  });
}

async function previewTranscript(
  context: CommandContext,
  input: string,
  flags: TranscriptFlags,
): Promise<void> {
  const parsed = parseVideoUrl(input);
  if (parsed.id === null) {
    throw usageError(
      `transcript ${input}`,
      "is not a YouTube video URL",
      "pass a watch URL, youtu.be link, or an archived 11-character id",
    );
  }
  await requireDownloader(context);
  if (flags.asr) await requireAsrReady(context);

  const videoId = parsed.id;
  const url = canonicalWatchUrl(videoId);
  const info = await fetchInfo(url, { ...context.downloader, browser: context.config.browser });
  const durationS = typeof info.info.duration === "number" ? info.info.duration : 0;

  mkdirSync(context.runtime.tmp, { recursive: true });
  const staging = mkdtempSync(join(context.runtime.tmp, `transcript-${videoId}-`));
  try {
    const acquired = await acquireTranscript(context, {
      videoId,
      url,
      durationS,
      availability: info.availability,
      ytdlpVersion: info.version,
      videoDir: staging,
      ensureAudio: async () => {
        requireFfmpeg(context);
        context.ui.note("  downloading audio for transcription…");
        const stream = await downloadAudioStream(url, videoId, staging, context.downloader, []);
        return stream.path;
      },
      options: acquisitionOptions(context, {
        quality: flags.quality,
        language: flags.language,
        forceAsr: flags.asr,
        noAsr: flags.noAsr,
        strictLang: flags.strictLang,
        allowRepetitive: flags.allowRepetitive,
      }),
    });

    // Preview only: nothing is written to the library.
    context.ui.note(
      `  ${acquired.source} · ${acquired.language} · ${acquired.segments.length} segments (not written)`,
    );
    outputTranscript(context, {
      id: videoId,
      source: acquired.source,
      language: acquired.language,
      segments: acquired.segments,
      format: flags.format,
      timestamps: flags.timestamps,
      warnings: acquired.warnings,
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function outputTranscript(
  context: CommandContext,
  input: {
    id: string;
    source: Provenance;
    language: string;
    segments: TranscriptSegment[];
    format: TranscriptFormat;
    timestamps: boolean;
    warnings?: string[];
    meta?: Meta;
  },
): void {
  if (context.flags.json) {
    context.ui.emit({
      id: input.id,
      source: input.source,
      language: input.language,
      format: input.format,
      warnings: input.warnings ?? input.meta?.warnings ?? [],
      segments: input.segments,
    });
    return;
  }
  process.stdout.write(renderTranscript(input.segments, input.format, { timestamps: input.timestamps }));
}

export async function cmdShow(
  context: CommandContext,
  positionals: string[],
  flags: ShowFlags,
): Promise<void> {
  const id = requireTarget(positionals, "show");
  const meta = readMeta(context.library, id);
  const segments = readTranscript(context.library, id);

  if (flags.raw) {
    if (context.flags.json) {
      context.ui.emit({ id, transcript: segments });
    } else {
      process.stdout.write(renderTranscript(segments, flags.format, { timestamps: flags.timestamps }));
    }
    return;
  }

  if (context.flags.json) {
    context.ui.emit({ meta, segments, format: flags.format });
    return;
  }

  const { ui } = context;
  ui.heading(`${meta.channel.name} — ${meta.title}`);
  ui.line(`${meta.id} · ${formatDuration(meta.duration_s)} · published ${meta.published ?? "unknown"}`);
  ui.line(`provenance  ${provenanceLine(meta)}`);
  ui.line(`media       ${mediaLine(meta)}`);
  ui.line(
    `added       ${meta.added_at}${meta.transcript_history.length > 0 ? ` · ${meta.transcript_history.length} earlier transcript(s)` : ""}`,
  );
  const chapters = chapterLines(meta);
  if (chapters.length > 0) {
    ui.line("chapters");
    for (const chapter of chapters) ui.line(chapter);
  }
  if (meta.warnings.length > 0) {
    for (const warning of meta.warnings) ui.warn(`  recorded warning: ${warning}`);
  }
  ui.line("");
  process.stdout.write(renderTranscript(segments, flags.format, { timestamps: flags.timestamps }));

  if (flags.history) {
    for (const entry of meta.transcript_history) {
      ui.line(`  superseded ${entry.superseded_at}: ${entry.source} ${entry.language} (${entry.segments} segments)`);
    }
  }
}

export async function cmdList(context: CommandContext, flags: ListFlags): Promise<void> {
  const { records, broken } = readAllMeta(context.library);
  const wanted = flags.source ? provenanceFilter(flags.source) : null;
  let filtered = wanted ? records.filter((record) => record.transcript.source === wanted) : records;
  if (flags.missingTranscript) filtered = filtered.filter((record) => missingTranscript(context, record));
  if (flags.missingMedia) filtered = filtered.filter((record) => missingMedia(context, record));

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
      missing_transcript: missingTranscript(context, record),
      missing_media: missingMedia(context, record),
      added_at: record.added_at,
    })),
    broken: broken.map((entry) => ({ id: entry.id, error: entry.error.toJSON() })),
  });
}

export async function cmdSearch(
  context: CommandContext,
  positionals: string[],
  flags: SearchFlags,
): Promise<void> {
  const query = positionals.join(" ").trim();
  if (query === "") {
    throw usageError("search", "needs a query", "run `ytx search \"some words\"`");
  }
  const needle = query.toLowerCase();
  const { records } = readAllMeta(context.library);
  const wanted = flags.source ? provenanceFilter(flags.source) : null;
  const candidates = wanted ? records.filter((record) => record.transcript.source === wanted) : records;

  type Where = "title" | "channel" | "transcript";
  type Match = {
    id: string;
    title: string;
    channel: string;
    source: Provenance;
    marker: string;
    where: Where;
    start: number | null;
    end: number | null;
    text: string;
    snippet: string;
  };
  const matches: Match[] = [];

  const push = (record: Meta, where: Where, text: string, index: number, start: number | null, end: number | null) => {
    matches.push({
      id: record.id,
      title: record.title,
      channel: record.channel.name,
      source: record.transcript.source,
      marker: markerOf(record),
      where,
      start,
      end,
      text,
      snippet: snippet(text, index, needle.length, flags.context),
    });
  };

  for (const record of candidates) {
    if (flags.ids && flags.ids.length > 0 && !flags.ids.includes(record.id)) continue;

    if (!flags.transcriptsOnly) {
      const titleIndex = record.title.toLowerCase().indexOf(needle);
      if (titleIndex >= 0) push(record, "title", record.title, titleIndex, null, null);
      const channelIndex = record.channel.name.toLowerCase().indexOf(needle);
      if (channelIndex >= 0) push(record, "channel", record.channel.name, channelIndex, null, null);
      if (matches.length >= flags.limit) break;
    }

    let segments: TranscriptSegment[];
    try {
      segments = readTranscript(context.library, record.id);
    } catch {
      continue;
    }
    for (const segment of segments) {
      const index = segment.text.toLowerCase().indexOf(needle);
      if (index < 0) continue;
      push(record, "transcript", segment.text, index, segment.start, segment.end);
      if (matches.length >= flags.limit) break;
    }
    if (matches.length >= flags.limit) break;
  }

  if (!context.flags.json) {
    if (matches.length === 0) {
      context.ui.line(`no matches for "${query}"`);
    } else {
      for (const match of matches) {
        const time = match.where === "transcript" && match.start !== null ? ` ${context.ui.cyan(formatClock(match.start))}` : "";
        context.ui.line(
          `${match.marker} ${context.ui.bold(match.id)} ${context.ui.dim(match.where.padEnd(10))}${time}  ${match.snippet}`,
        );
      }
      context.ui.note(`${matches.length} match(es) for "${query}"`);
    }
  }
  context.ui.emit({ query, transcripts_only: flags.transcriptsOnly, matches });
}

export async function cmdRetry(context: CommandContext, flags: RetryFlags): Promise<void> {
  const entries = flags.all ? readQueue(context.library) : dueEntries(context.library);
  if (entries.length === 0) {
    context.ui.line("queue is empty; nothing to retry");
    context.ui.emit({ retried: [], exhausted: [], failed: [], dry_run: flags.dryRun, remaining: readQueue(context.library).length });
    return;
  }

  const planned = entries.slice(0, flags.limit);
  if (flags.dryRun) {
    if (!context.flags.json) {
      for (const entry of planned) {
        context.ui.line(
          `${entry.id}  ${entry.stage}  attempts ${entry.attempts}  next ${entry.next_attempt_at}  ${context.ui.dim(entry.last_error)}`,
        );
      }
      context.ui.note(`${planned.length} queued item(s); --dry-run changed nothing`);
    }
    context.ui.emit({
      dry_run: true,
      retried: [],
      exhausted: [],
      failed: [],
      planned: planned.map((entry) => ({ ...entry })),
      remaining: readQueue(context.library).length,
    });
    return;
  }

  const retried: string[] = [];
  const failed: { id: string; reason: string }[] = [];
  const exhausted: string[] = [];

  for (const entry of planned) {
    if (flags.maxAttempts !== null && entry.attempts >= flags.maxAttempts) {
      removeFromQueue(context.library, entry.id);
      exhausted.push(entry.id);
      context.ui.warn(`${entry.id} failed ${entry.attempts} time(s); removed from the queue (--max-attempts ${flags.maxAttempts})`);
      continue;
    }
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

  const payload = {
    retried,
    exhausted,
    failed,
    dry_run: false,
    remaining: readQueue(context.library).length,
  };
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
    allowRepetitive: false,
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
  const removed: { id: string; freed_bytes: number }[] = [];
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
      removed.push({ id, freed_bytes: size });
      context.ui.ok(`removed ${id} (${formatBytes(size)} freed)`);
    }
  } finally {
    lock.release();
  }
  const total = removed.reduce((sum, entry) => sum + entry.freed_bytes, 0);
  if (removed.length > 0) context.ui.line(`${formatBytes(total)} reclaimed in total`);
  context.ui.emit({ removed: removed.map((entry) => entry.id), freed_bytes: total, items: removed });
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
      const empty = dirSize(dir) === 0;
      targets.push({
        path: dir,
        reason: empty ? "empty video directory" : "video directory without meta.json",
        bytes: dirSize(dir),
      });
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
    why: "playlist and channel sync is not implemented in v1",
    next: "archive individual videos with `ytx add <url>`; that is fully supported",
    code: EXIT.usage,
    kind: "not-implemented",
  });
}

export function parseTranscriptFormat(value: string | undefined): TranscriptFormat {
  if (value === undefined) return "txt";
  if ((TRANSCRIPT_FORMATS as readonly string[]).includes(value)) return value as TranscriptFormat;
  throw usageError(
    `--format ${value}`,
    "is not a transcript format",
    `use one of ${TRANSCRIPT_FORMATS.join(", ")}`,
  );
}

function requireTarget(positionals: string[], command: string): string {
  const input = positionals[0];
  if (!input) {
    throw usageError(command, "needs a video id or URL", "run `ytx list` to see archived videos");
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

/** A record has no usable transcript file, or its transcript is empty. */
function missingTranscript(context: CommandContext, record: Meta): boolean {
  const dir = videoDir(context.library, record.id);
  if (!existsSync(join(dir, TRANSCRIPT_JSON)) && !existsSync(join(dir, TRANSCRIPT_TXT))) return true;
  try {
    return readTranscript(context.library, record.id).length === 0;
  } catch {
    return true;
  }
}

/** Any recorded media file is absent, or the record has no media at all. */
function missingMedia(context: CommandContext, record: Meta): boolean {
  const dir = videoDir(context.library, record.id);
  const names = [record.media.video, record.media.audio, record.media.mp3].filter(
    (name): name is string => typeof name === "string",
  );
  if (names.length === 0) return true;
  return names.some((name) => !existsSync(join(dir, name)));
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
