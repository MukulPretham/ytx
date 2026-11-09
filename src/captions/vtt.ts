/**
 * WebVTT and SRT parsing, written here rather than pulled from a package.
 *
 * The platform emits WebVTT; older tracks and third-party tooling emit SRT. Both
 * reduce to the same cue list, and everything downstream works on cues.
 */

export interface RawCue {
  /** Position in the file, 0-based. Used only for diagnostics. */
  index: number;
  start: number;
  end: number;
  /** Anything after the end timestamp (`align:start position:0%`). Dropped later. */
  settings: string;
  /** Payload lines exactly as they appeared, before any cleanup. */
  lines: string[];
}

export interface ParsedCaptions {
  format: "vtt" | "srt";
  /** Header lines (`Kind:`, `Language:`, ...) when the file is WebVTT. */
  header: string[];
  cues: RawCue[];
}

const TIMESTAMP = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;
const TIMING_LINE = /^\s*(\S+)\s*-->\s*(\S+)\s*(.*)$/;

export function parseCaptions(input: string): ParsedCaptions {
  const text = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  const isVtt = (lines[0] ?? "").toUpperCase().startsWith("WEBVTT");
  const format: "vtt" | "srt" = isVtt ? "vtt" : "srt";

  const header: string[] = [];
  let i = 0;
  if (isVtt) {
    // Consume the WEBVTT line and any following metadata up to the first blank.
    header.push(lines[0] ?? "");
    i = 1;
    while (i < lines.length && (lines[i] ?? "").trim() !== "") {
      header.push(lines[i] ?? "");
      i += 1;
    }
  }

  const cues: RawCue[] = [];
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    const trimmed = line.trim();
    // Non-cue blocks: NOTE/STYLE/REGION/CUE run until a blank line.
    if (/^(NOTE|STYLE|REGION|CUE)\b/i.test(trimmed) && !TIMING_LINE.test(trimmed)) {
      while (i < lines.length && (lines[i] ?? "").trim() !== "") i += 1;
      continue;
    }

    let cursor = i;
    let timing = TIMING_LINE.exec(lines[cursor] ?? "");
    if (!timing) {
      // A cue identifier line precedes the timing line.
      cursor += 1;
      timing = TIMING_LINE.exec(lines[cursor] ?? "");
      if (!timing) {
        // Unparseable block; skip it rather than inventing a cue.
        i += 1;
        continue;
      }
    }
    const start = parseTimestamp(timing[1] ?? "");
    const end = parseTimestamp(timing[2] ?? "");
    cursor += 1;

    // The platform emits a whitespace-only line between the timing line and the
    // payload; skip those without treating them as the end of the cue.
    while (cursor < lines.length && (lines[cursor] ?? "").trim() === "") cursor += 1;

    const payload: string[] = [];
    while (cursor < lines.length && !isCueBoundary(lines[cursor] ?? "")) {
      payload.push(lines[cursor] ?? "");
      cursor += 1;
    }

    if (start !== null && end !== null && end >= start) {
      cues.push({
        index: cues.length,
        start,
        end,
        settings: (timing[3] ?? "").trim(),
        lines: payload,
      });
    }
    i = cursor;
  }

  return { format, header, cues };
}

/** A cue ends at a truly empty line, or where the next cue's timing starts. */
function isCueBoundary(line: string): boolean {
  if (line === "") return true;
  return TIMING_LINE.test(line);
}

export function parseTimestamp(value: string): number | null {
  const match = TIMESTAMP.exec(value.trim());
  if (!match) return null;
  const hours = match[1] === undefined ? 0 : Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const millis = Number((match[4] ?? "0").padEnd(3, "0").slice(0, 3));
  if (minutes > 59 || seconds > 59) return null;
  return hours * 3600 + minutes * 60 + seconds + millis / 1000;
}

export function formatTimestamp(seconds: number, separator: "." | "," = "."): string {
  const clamped = Math.max(0, seconds);
  const hours = Math.floor(clamped / 3600);
  const minutes = Math.floor((clamped % 3600) / 60);
  const secs = Math.floor(clamped % 60);
  const millis = Math.round((clamped - Math.floor(clamped)) * 1000) % 1000;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${separator}${pad(millis, 3)}`;
}

/** Render cues back to WebVTT. Used when the platform only offered SRT. */
export function toVtt(cues: readonly RawCue[]): string {
  const blocks = cues.map((cue, index) => {
    const settings = cue.settings ? ` ${cue.settings}` : "";
    const body = cue.lines.join("\n");
    return `${index + 1}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}${settings}\n${body}`;
  });
  return `WEBVTT\n\n${blocks.join("\n\n")}\n`;
}

/** Header metadata lookup, e.g. `Language: en`. */
export function headerValue(parsed: ParsedCaptions, key: string): string | null {
  const prefix = `${key.toLowerCase()}:`;
  for (const line of parsed.header) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith(prefix)) {
      return trimmed.slice(prefix.length).trim();
    }
  }
  return null;
}
