/**
 * Caption normalization.
 *
 * The platform ships three artefacts that are not transcripts: inline markup,
 * rolling-window cues (each cue repeats the previous cue's words), and cue
 * boundaries that fall wherever a caption renderer liked. This module turns all
 * three into sentence-shaped segments with real start and end times.
 */

import type { RawCue } from "./vtt.ts";
import type { TranscriptSegment } from "../core/schema.ts";

export interface Cue {
  start: number;
  end: number;
  text: string;
}

export interface NormalizedTrack {
  cues: Cue[];
  /** True when the source used rolling-window cues and they were collapsed. */
  rolling: boolean;
  /** Fraction of lines that repeat an earlier line after normalization. */
  duplicate_line_ratio: number;
  chars: number;
}

/** Tags the platform emits: `<c>`, `<c.colorE5E5E5>`, `<v Name>`, `<00:00:01.000>`. */
const INLINE_TAG = /<(?:\/?[a-zA-Z][^<>]*|[0-9:.,]+)>/g;
const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\uFEFF]/g;
const TERMINAL_PUNCTUATION = /[.!?…。！？][)"'”’\]]*$/u;

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
  "&#39;": "'",
  "&nbsp;": " ",
  "&lrm;": "",
  "&rlm;": "",
};

/** Strip markup and entities from one line of caption text. */
export function cleanLine(line: string): string {
  let text = line.replace(INLINE_TAG, "");
  text = text.replace(/&#(\d+);/g, (_, code: string) => {
    const value = Number(code);
    return Number.isFinite(value) && value > 0 ? String.fromCodePoint(value) : "";
  });
  text = text.replace(/&[a-zA-Z]+;|&#39;/g, (entity) => ENTITIES[entity] ?? entity);
  text = text.replace(ZERO_WIDTH, "").replace(/\s+/g, " ").trim();
  return text;
}

export function cleanCueLines(lines: readonly string[]): string[] {
  const cleaned: string[] = [];
  for (const line of lines) {
    const text = cleanLine(line);
    if (text === "") continue;
    // Adjacent identical lines inside one cue are a renderer artefact.
    if (cleaned.length > 0 && cleaned[cleaned.length - 1] === text) continue;
    cleaned.push(text);
  }
  return cleaned;
}

/**
 * Rolling-window detection. A pair is rolling when the earlier cue's text is a
 * prefix of the later one (the platform repeats what it already showed). Tracks
 * are classified as a whole so a single coincidental overlap cannot trigger
 * collapsing on human captions.
 */
export function isRollingTrack(cues: readonly Cue[]): boolean {
  if (cues.length < 3) return false;
  let prefixed = 0;
  let extended = 0;
  let pairs = 0;
  for (let i = 1; i < cues.length; i += 1) {
    const a = tokens(cues[i - 1]!.text);
    const b = tokens(cues[i]!.text);
    if (a.length === 0 || b.length === 0) continue;
    pairs += 1;
    // A rolling track repeats the previous text and then adds to it. Equal cues
    // count too: the platform emits 10ms flush cues that repeat verbatim.
    if (overlapLength(a, b) === a.length) {
      prefixed += 1;
      if (b.length > a.length) extended += 1;
    }
  }
  if (pairs === 0) return false;
  // A track that only ever repeats itself (no growth) is a looping defect, not
  // a rolling window: collapsing it would hide the very thing the repetition
  // gate exists to catch.
  return prefixed / pairs >= 0.5 && extended / pairs >= 0.25;
}

export function normalizeTrack(rawCues: readonly RawCue[]): NormalizedTrack {
  const cleaned: Cue[] = [];
  for (const raw of rawCues) {
    const lines = cleanCueLines(raw.lines);
    if (lines.length === 0) continue;
    cleaned.push({ start: raw.start, end: raw.end, text: lines.join(" ") });
  }

  const rolling = isRollingTrack(cleaned);
  // Collapse rolling windows first: that repetition is structural, not a track
  // defect. Whatever repeats after that is what the repetition gate measures.
  const collapsed = rolling ? collapseRolling(cleaned) : cleaned;
  const usable = dedupeExactCues(collapsed).filter(
    (cue) => cue.text.trim() !== "" && cue.end > cue.start,
  );

  return {
    cues: usable,
    rolling,
    duplicate_line_ratio: duplicateRatio(collapsed),
    chars: usable.reduce((total, cue) => total + [...cue.text].length, 0),
  };
}

/**
 * Word-level suffix/prefix collapse. For each cue, drop the longest prefix that
 * equals the tail of everything committed so far; the remainder is new speech.
 */
export function collapseRolling(cues: readonly Cue[]): Cue[] {
  const out: Cue[] = [];
  let committed: string[] = [];
  const separator = usesGraphemes(cues) ? "" : " ";

  for (const cue of cues) {
    const words = tokens(cue.text);
    if (words.length === 0) continue;
    const overlap = overlapLength(committed, words);
    if (overlap >= words.length) continue;
    const fresh = words.slice(overlap);
    out.push({ start: cue.start, end: cue.end, text: fresh.join(separator) });
    committed = committed.concat(fresh);
    // Only the tail can ever match the next cue's head; keep memory bounded.
    if (committed.length > 400) committed = committed.slice(-200);
  }
  return out;
}

function dedupeExactCues(cues: readonly Cue[]): Cue[] {
  const out: Cue[] = [];
  let previous = "";
  for (const cue of cues) {
    const normalized = cue.text.toLowerCase().replace(/\s+/g, " ").trim();
    if (normalized !== "" && normalized === previous) continue;
    out.push(cue);
    previous = normalized;
  }
  return out;
}

function duplicateRatio(cues: readonly Cue[]): number {
  const counts = new Map<string, number>();
  let total = 0;
  for (const cue of cues) {
    for (const line of cue.text.split("\n")) {
      const key = line
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, "")
        .trim();
      if (key === "") continue;
      total += 1;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (total === 0) return 0;
  let duplicates = 0;
  for (const count of counts.values()) duplicates += count - 1;
  return duplicates / total;
}

/** Longest suffix of `a` that is a prefix of `b`, in tokens. */
export function overlapLength(a: readonly string[], b: readonly string[]): number {
  const max = Math.min(a.length, b.length);
  for (let k = max; k > 0; k -= 1) {
    let matched = true;
    for (let i = 0; i < k; i += 1) {
      if (a[a.length - k + i] !== b[i]) {
        matched = false;
        break;
      }
    }
    if (matched) return k;
  }
  return 0;
}

export type SegmentOptions = {
  /** Close a segment once it reaches this many characters. */
  maxChars?: number;
  /** Close a segment across a silence longer than this many seconds. */
  maxPause?: number;
};

/**
 * Reassemble sentence-level segments. A segment closes at terminal punctuation,
 * across a long pause, or once it is roughly `maxChars` long - whichever comes
 * first. Its `start` is the first cue's start and its `end` the last cue's end,
 * so no timestamp is invented.
 */
export function segmentCues(
  cues: readonly Cue[],
  options: SegmentOptions = {},
): TranscriptSegment[] {
  const maxChars = options.maxChars ?? 200;
  const maxPause = options.maxPause ?? 0.8;
  const segments: TranscriptSegment[] = [];

  let start = 0;
  let end = 0;
  let parts: string[] = [];
  let length = 0;

  const flush = () => {
    if (parts.length === 0) return;
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (text !== "") segments.push({ start: round(start), end: round(end), text });
    parts = [];
    length = 0;
  };

  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i]!;
    const text = cue.text.replace(/\s+/g, " ").trim();
    if (text === "") continue;
    if (parts.length === 0) start = cue.start;
    parts.push(text);
    length += [...text].length + 1;
    end = cue.end;

    const next = cues[i + 1];
    const closesAtPunctuation = TERMINAL_PUNCTUATION.test(text);
    const closesAtPause = next ? next.start - cue.end > maxPause : true;
    const closesAtLength = length >= maxChars;
    if (closesAtPunctuation || closesAtPause || closesAtLength) flush();
  }
  flush();
  return segments;
}

export function endsWithTerminalPunctuation(text: string): boolean {
  return TERMINAL_PUNCTUATION.test(text.trim());
}

/** Characters per minute of audio; the density gate's unit. */
export function charsPerMinute(chars: number, durationS: number): number {
  if (durationS <= 0) return 0;
  return chars / (durationS / 60);
}

function tokens(text: string): string[] {
  if (usesGraphemesText(text)) return [...text.replace(/\s+/g, "")];
  return text.split(/\s+/).filter((token) => token !== "");
}

function usesGraphemesText(text: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u.test(text);
}

function usesGraphemes(cues: readonly Cue[]): boolean {
  return cues.some((cue) => usesGraphemesText(cue.text));
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
