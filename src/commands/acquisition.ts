/**
 * Executing the acquisition ladder.
 *
 * The plan comes from `captions/ladder.ts` (pure); this module performs the
 * fetches, applies the quality gates, and reports every rejected attempt so a
 * failure says why each tier lost rather than "no transcript".
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { noTranscriptError, qualityError, YtxError } from "../core/errors.ts";
import { detectLanguage, type LanguageGuess } from "../captions/lang.ts";
import { describeFailures, evaluateGates, type GateMetrics } from "../captions/gates.ts";
import { normalizeTrack, segmentCues, type NormalizedTrack } from "../captions/normalize.ts";
import { planLadder, type Availability, type LadderPlan } from "../captions/ladder.ts";
import { parseCaptions, toVtt, type ParsedCaptions } from "../captions/vtt.ts";
import type { TranscriptSegment } from "../core/schema.ts";
import type { CommandContext } from "./context.ts";
import type { DownloaderOptions } from "../ytdlp/run.ts";
import { fetchCaptionTrack } from "../ytdlp/run.ts";
import { transcribe } from "../asr/transcribe.ts";

export interface AcquisitionOptions {
  quality: "auto" | "best";
  language: string;
  forceAsr: boolean;
  noAsr: boolean;
  strictLang: boolean;
}

export interface AttemptRecord {
  tier: number;
  source: string;
  language: string;
  track: string | null;
  accepted: boolean;
  reason: string;
  metrics?: GateMetrics;
}

export interface AcquiredTranscript {
  source: "caption-human" | "caption-auto" | "asr";
  language: string;
  segments: TranscriptSegment[];
  /** Raw platform track, exactly as fetched (converted to VTT only in name). */
  rawCaption: { language: string; vtt: string } | null;
  model: string | null;
  modelRevision: string | null;
  ytdlpVersion: string | null;
  detectedLanguage: LanguageGuess | null;
  rolling: boolean;
  duplicateLineRatio: number;
  coverage: number;
  normalized: NormalizedTrack | null;
  plan: LadderPlan;
  attempts: AttemptRecord[];
}

export interface AcquireContext extends CommandContext {
  downloader: DownloaderOptions;
}

export function acquisitionOptions(
  context: CommandContext,
  overrides: Partial<AcquisitionOptions> = {},
): AcquisitionOptions {
  return {
    quality: context.config.quality,
    language: context.config.language,
    forceAsr: false,
    noAsr: false,
    strictLang: false,
    ...overrides,
  };
}

/**
 * Walk the ladder. Returns the first accepting tier; throws when every tier is
 * rejected, naming the gates that rejected each one.
 */
export async function acquireTranscript(
  context: AcquireContext,
  input: {
    videoId: string;
    url: string;
    durationS: number;
    availability: Availability;
    ytdlpVersion: string;
    /** Directory holding the media, for ASR. Created when needed. */
    videoDir: string;
    /** Audio file for ASR, downloaded lazily by this function. */
    ensureAudio: () => Promise<string>;
    options: AcquisitionOptions;
  },
): Promise<AcquiredTranscript> {
  const { ui } = context;
  const options = input.options;
  const plan = planLadder(input.availability, {
    preferredLanguage: options.language,
    quality: options.quality,
    forceAsr: options.forceAsr,
    noAsr: options.noAsr,
    strictLang: options.strictLang,
  });

  if (plan.steps.length === 0) {
    const skipped = plan.skipped.map((entry) => `tier ${entry.tier}: ${entry.reason}`).join("; ");
    throw noTranscriptError(
      `transcript for ${input.videoId}`,
      `no acquisition tier is available. ${skipped}`,
      "drop `--no-asr`, or add `--asr` to transcribe locally",
    );
  }

  const attempts: AttemptRecord[] = [];
  const workRoot = mkdtempSync(join(tmpdir(), `ytx-captions-${input.videoId}-`));

  try {
    for (const step of plan.steps) {
      if (step.source === "asr") {
        ui.note(`  tier 4 · transcribing locally`);
        const audio = await input.ensureAudio();
        const acquired = await runAsr(context, audio, input.durationS, workRoot, attempts);
        if (acquired) {
          return { ...acquired, plan, attempts };
        }
        continue;
      }

      const trackKey = step.trackKey;
      if (trackKey === null) continue;
      ui.note(
        `  tier ${step.tier} · ${step.source === "caption-human" ? "human" : "machine"} captions (${trackKey})`,
      );

      let track;
      try {
        track = await fetchWithRetry(context, input.url, trackKey, step.source, workRoot);
      } catch (err) {
        const error = err as YtxError;
        attempts.push({
          tier: step.tier,
          source: step.source,
          language: step.language,
          track: trackKey,
          accepted: false,
          reason: `fetch failed: ${error.why ?? (err as Error).message}`,
        });
        // A network problem is not a verdict about this track: it must not be
        // read as "no captions here" and silently push the video into ASR.
        if (
          error.failureClass === "bot-check" ||
          error.failureClass === "needs-update" ||
          error.failureClass === "transient" ||
          error.failureClass === "gone-or-private"
        ) {
          throw error;
        }
        continue;
      }

      if (track === null) {
        attempts.push({
          tier: step.tier,
          source: step.source,
          language: step.language,
          track: trackKey,
          accepted: false,
          reason: "the downloader produced no caption file for this track",
        });
        continue;
      }

      const parsed: ParsedCaptions = parseCaptions(track.text);
      if (parsed.cues.length === 0) {
        attempts.push({
          tier: step.tier,
          source: step.source,
          language: step.language,
          track: trackKey,
          accepted: false,
          reason: `the track contained no cues (${track.ext}, ${track.text.length} bytes)`,
        });
        continue;
      }

      const normalized = normalizeTrack(parsed.cues);
      const segments = segmentCues(normalized.cues);
      const joined = segments.map((segment) => segment.text).join(" ");
      const detected = detectLanguage(joined);
      const gates = evaluateGates({
        cues: normalized.cues,
        durationS: input.durationS,
        trackLanguage: trackKey,
        wantLanguage: step.language === "auto" ? "auto" : options.language,
        detected,
        duplicateLineRatio: normalized.duplicate_line_ratio,
      });

      if (!gates.pass) {
        const reason = describeFailures(gates.failures);
        attempts.push({
          tier: step.tier,
          source: step.source,
          language: step.language,
          track: trackKey,
          accepted: false,
          reason,
          metrics: gates.metrics,
        });
        ui.note(`    rejected: ${reason}`);
        continue;
      }

      attempts.push({
        tier: step.tier,
        source: step.source,
        language: step.language,
        track: trackKey,
        accepted: true,
        reason: "passed every gate",
        metrics: gates.metrics,
      });

      return {
        source: step.source,
        language: resolvedLanguage(step.language, detected, options.language),
        segments,
        rawCaption: {
          language: resolvedLanguage(step.language, detected, options.language),
          // SRT is converted to WebVTT text; the cues themselves are untouched.
          vtt: track.ext === "vtt" ? track.text : toVtt(parsed.cues),
        },
        model: null,
        modelRevision: null,
        ytdlpVersion: input.ytdlpVersion,
        detectedLanguage: detected,
        rolling: normalized.rolling,
        duplicateLineRatio: normalized.duplicate_line_ratio,
        coverage: gates.metrics.coverage,
        normalized,
        plan,
        attempts,
      };
    }
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }

  throw transcriptFailure(input.videoId, plan, attempts, options);
}

/**
 * Caption fetches are cheap but rate limited. A transient failure is retried
 * twice with a short backoff before it is reported, because the alternative -
 * falling through to local transcription - would silently produce a worse
 * transcript for a video whose captions exist.
 */
async function fetchWithRetry(
  context: AcquireContext,
  url: string,
  trackKey: string,
  source: "caption-human" | "caption-auto",
  workRoot: string,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchCaptionTrack(url, trackKey, source === "caption-human" ? "human" : "auto", workRoot, context.downloader);
    } catch (err) {
      lastError = err;
      const error = err as YtxError;
      if (error.failureClass !== "transient" || attempt === 2) throw err;
      const delay = 1000 * (attempt + 1);
      context.ui.note(`    transient failure; retrying in ${delay / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
}

async function runAsr(
  context: AcquireContext,
  audioPath: string,
  durationS: number,
  workRoot: string,
  attempts: AttemptRecord[],
): Promise<Omit<AcquiredTranscript, "plan" | "attempts"> | null> {
  const { runtime, state } = context;
  const modelName = context.config.asr_model;
  if (modelName === "none") {
    attempts.push({
      tier: 4,
      source: "asr",
      language: context.config.language,
      track: null,
      accepted: false,
      reason: "no transcription model is configured (asr_model = \"none\")",
    });
    return null;
  }

  const { effectiveDefault, resolveModelPath } = await import("../models/manager.ts");
  const name = effectiveDefault(state.default_model ?? modelName);
  let modelPath: string;
  let manifestRevision: string;
  let modelRepo: string;
  try {
    const resolved = resolveModelPath(runtime, name);
    modelPath = resolved.path;
    manifestRevision = resolved.manifest?.revision ?? "unknown";
    modelRepo = resolved.manifest?.repo ?? name;
  } catch (err) {
    attempts.push({
      tier: 4,
      source: "asr",
      language: context.config.language,
      track: null,
      accepted: false,
      reason: (err as YtxError).why ?? (err as Error).message,
    });
    return null;
  }

  const result = await transcribe({
    runtime,
    ffmpeg: context.ffmpeg,
    modelPath,
    modelName: name,
    language: context.config.language === "auto" ? "auto" : context.config.language,
    audioPath,
    workDir: join(workRoot, "asr"),
    onLine: context.flags.debug ? (line) => context.ui.note(`    ${line}`) : undefined,
  });

  if (result.segments.length === 0) {
    attempts.push({
      tier: 4,
      source: "asr",
      language: result.language,
      track: null,
      accepted: false,
      reason: "the transcription returned no segments",
    });
    return null;
  }

  const lastEnd = result.segments[result.segments.length - 1]?.end ?? 0;
  const coverage = durationS > 0 ? Math.max(0, Math.min(1, lastEnd / durationS)) : 0;

  attempts.push({
    tier: 4,
    source: "asr",
    language: result.language,
    track: null,
    accepted: true,
    reason: `transcribed locally with ${name}`,
  });

  return {
    source: "asr",
    language: result.language,
    segments: result.segments,
    rawCaption: null,
    // Record the checkpoint's own name (owner stripped), matching the spec's
    // example and pinning it with model_revision.
    model: modelRepo.split("/").pop() ?? modelRepo,
    modelRevision: manifestRevision,
    ytdlpVersion: null,
    detectedLanguage: null,
    rolling: false,
    duplicateLineRatio: 0,
    coverage,
    normalized: null,
  };
}

function resolvedLanguage(trackLanguage: string, detected: LanguageGuess, preferred: string): string {
  if (detected.language && detected.confidence >= 0.2) return detected.language;
  if (trackLanguage !== "auto") return trackLanguage;
  return preferred === "auto" ? "en" : preferred;
}

/**
 * A transcript that could not be obtained is exit 4; one that was obtained but
 * rejected by the gates everywhere is exit 5, because the user can act on it.
 */
function transcriptFailure(
  videoId: string,
  plan: LadderPlan,
  attempts: AttemptRecord[],
  options: AcquisitionOptions,
): YtxError {
  const summary = attempts
    .map((attempt) => `tier ${attempt.tier} (${attempt.source}): ${attempt.reason}`)
    .join("; ");
  const skipped = plan.skipped.map((entry) => `tier ${entry.tier} skipped: ${entry.reason}`).join("; ");
  const gated = attempts.some((attempt) => attempt.metrics !== undefined);
  const detail = summary === "" ? skipped : summary;

  if (gated) {
    return qualityError(
      `transcript for ${videoId}`,
      `every caption track failed the quality gates. ${detail}`,
      options.forceAsr
        ? "no tier remains: the local transcript was also unusable"
        : "use `--asr` to transcribe locally, or `--quality best` to skip machine captions",
    );
  }

  return noTranscriptError(
    `transcript for ${videoId}`,
    `no caption track was available. ${detail}`,
    options.noAsr
      ? "remove `--no-asr` and run `ytx setup` to install a transcription model"
      : "run `ytx models add turbo` to enable local transcription, then retry",
  );
}
