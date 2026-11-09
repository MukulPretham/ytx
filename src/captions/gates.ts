/**
 * Quality gates.
 *
 * A caption track is accepted only if it plausibly covers the whole video, is
 * written in the language we asked for, carries enough text, and is not a loop
 * of repeated lines. A rejected track records the reason and the acquisition
 * ladder falls through to the next tier.
 */

import type { LanguageGuess } from "./lang.ts";
import { matchesLanguage } from "./lang.ts";
import { charsPerMinute, type Cue } from "./normalize.ts";

export const COVERAGE_MIN = 0.9;
export const DENSITY_MIN_CHARS_PER_MINUTE = 20;
export const REPETITION_MAX = 0.25;

export type GateName = "coverage" | "language" | "density" | "repetition";

export interface GateFailure {
  gate: GateName;
  detail: string;
}

export interface GateMetrics {
  coverage: number;
  chars_per_minute: number;
  duplicate_line_ratio: number;
  chars: number;
  last_cue_end: number;
  detected_language: string | null;
  language_confidence: number;
}

export interface GateResult {
  pass: boolean;
  failures: GateFailure[];
  metrics: GateMetrics;
}

export interface GateInput {
  cues: readonly Cue[];
  durationS: number;
  /** Language the track claims, for the diagnostic message only. */
  trackLanguage: string;
  /** Language we want; "auto" means the gate does not judge. */
  wantLanguage: string;
  detected: LanguageGuess;
  duplicateLineRatio: number;
}

export function coverageOf(cues: readonly Cue[], durationS: number): number {
  if (cues.length === 0 || durationS <= 0) return 0;
  const lastEnd = cues[cues.length - 1]?.end ?? 0;
  const ratio = lastEnd / durationS;
  if (!Number.isFinite(ratio)) return 0;
  // A track may run past the reported duration; coverage is still at most 1.
  return Math.min(1, Math.max(0, ratio));
}

export function evaluateGates(input: GateInput): GateResult {
  const { cues, durationS, detected, duplicateLineRatio } = input;
  const chars = cues.reduce((total, cue) => total + [...cue.text].length, 0);
  const coverage = coverageOf(cues, durationS);
  const density = charsPerMinute(chars, durationS);
  const lastCueEnd = cues[cues.length - 1]?.end ?? 0;

  const failures: GateFailure[] = [];

  if (cues.length === 0) {
    failures.push({ gate: "coverage", detail: "no cues survived normalization" });
  } else if (durationS > 0 && coverage < COVERAGE_MIN) {
    failures.push({
      gate: "coverage",
      detail: `last cue ends at ${lastCueEnd.toFixed(1)}s of ${durationS.toFixed(1)}s (${(coverage * 100).toFixed(1)}% < ${(COVERAGE_MIN * 100).toFixed(0)}%)`,
    });
  }

  if (input.wantLanguage !== "auto" && !matchesLanguage(detected, input.wantLanguage)) {
    failures.push({
      gate: "language",
      detail: `track tagged "${input.trackLanguage}" reads as ${detected.language} (confidence ${detected.confidence.toFixed(2)}), wanted ${input.wantLanguage}`,
    });
  }

  if (density < DENSITY_MIN_CHARS_PER_MINUTE) {
    failures.push({
      gate: "density",
      detail: `${density.toFixed(1)} chars/min < ${DENSITY_MIN_CHARS_PER_MINUTE}`,
    });
  }

  if (duplicateLineRatio > REPETITION_MAX) {
    failures.push({
      gate: "repetition",
      detail: `${(duplicateLineRatio * 100).toFixed(1)}% duplicate lines > ${(REPETITION_MAX * 100).toFixed(0)}%`,
    });
  }

  return {
    pass: failures.length === 0,
    failures,
    metrics: {
      coverage,
      chars_per_minute: density,
      duplicate_line_ratio: duplicateLineRatio,
      chars,
      last_cue_end: lastCueEnd,
      detected_language: detected.language,
      language_confidence: detected.confidence,
    },
  };
}

/** One line per rejection, for `--json` details and `doctor` output. */
export function describeFailures(failures: readonly GateFailure[]): string {
  return failures.map((failure) => `${failure.gate}: ${failure.detail}`).join("; ");
}
