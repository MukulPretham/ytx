/**
 * Rendering shared by `show`, `list`, `search` and `doctor`.
 * Kept apart from the commands so the provenance header has exactly one owner.
 */

import { PROVENANCE_LABELS, PROVENANCE_MARKERS, type Meta, type Provenance, type TranscriptSegment } from "../core/schema.ts";
import { formatDuration } from "../core/ui.ts";
import { formatTimestamp } from "../captions/vtt.ts";

export const TRANSCRIPT_FORMATS = ["txt", "json", "srt", "vtt", "md"] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

/**
 * One renderer for every command that prints a transcript, so `show`, `transcript`
 * and any future export agree on what each format means.
 */
export function renderTranscript(
  segments: readonly TranscriptSegment[],
  format: TranscriptFormat = "txt",
  options: { timestamps?: boolean } = {},
): string {
  const timestamps = options.timestamps ?? false;
  switch (format) {
    case "json":
      return `${JSON.stringify(segments, null, 2)}\n`;
    case "srt":
      return segments
        .map((segment, index) => {
          const start = formatTimestamp(segment.start, ",");
          const end = formatTimestamp(segment.end, ",");
          return `${index + 1}\n${start} --> ${end}\n${segment.text}`;
        })
        .join("\n\n") + "\n";
    case "vtt":
      return (
        "WEBVTT\n\n" +
        segments
          .map((segment, index) => {
            const start = formatTimestamp(segment.start);
            const end = formatTimestamp(segment.end);
            return `${index + 1}\n${start} --> ${end}\n${segment.text}`;
          })
          .join("\n\n") +
        "\n"
      );
    case "md":
      return segments
        .map((segment) =>
          timestamps
            ? `**${formatClock(segment.start)}** ${segment.text}`
            : segment.text,
        )
        .join("\n\n") + "\n";
    default:
      return segments
        .map((segment) =>
          timestamps
            ? `[${formatClock(segment.start)}] ${segment.text}`
            : segment.text,
        )
        .join("\n\n") + "\n";
  }
}

export function provenanceLine(meta: Meta): string {
  const transcript = meta.transcript;
  const marker = PROVENANCE_MARKERS[transcript.source];
  const label = PROVENANCE_LABELS[transcript.source];
  const bits = [
    `${marker} ${label}`,
    transcript.language,
    `${transcript.segments} segments`,
    `${formatNumber(transcript.chars)} chars`,
    `coverage ${(transcript.coverage * 100).toFixed(0)}%`,
  ];
  if (transcript.source === "asr") {
    const model = transcript.model ?? "unknown model";
    const revision = transcript.model_revision ? `@${transcript.model_revision.slice(0, 8)}` : "";
    bits.push(`model ${model}${revision}`);
  } else if (transcript.ytdlp_version) {
    bits.push(`yt-dlp ${transcript.ytdlp_version}${transcript.ytdlp_source ? ` (${transcript.ytdlp_source})` : ""}`);
  }
  return bits.join(" · ");
}

export function mediaLine(meta: Meta): string {
  const parts: string[] = [];
  if (meta.media.video) {
    parts.push(`${meta.media.video}${meta.media.height ? ` (${meta.media.height}p)` : ""}`);
  } else {
    parts.push("no video (audio only)");
  }
  if (meta.media.audio) parts.push(meta.media.audio);
  if (meta.media.mp3) parts.push(meta.media.mp3);
  return parts.join(" · ");
}

export function chapterLines(meta: Meta, limit = 8): string[] {
  if (meta.chapters.length === 0) return [];
  const shown = meta.chapters.slice(0, limit);
  const lines = shown.map(
    (chapter) => `  ${formatClock(chapter.start_s)}  ${chapter.title}`,
  );
  if (meta.chapters.length > limit) lines.push(`  … ${meta.chapters.length - limit} more`);
  return lines;
}

export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function provenanceCounts(records: readonly Meta[]): Record<Provenance, number> {
  const counts: Record<Provenance, number> = { "caption-human": 0, "caption-auto": 0, asr: 0 };
  for (const record of records) counts[record.transcript.source] += 1;
  return counts;
}

export function totalDuration(records: readonly Meta[]): number {
  return records.reduce((sum, record) => sum + record.duration_s, 0);
}

export function metaSummary(meta: Meta): string {
  const marker = PROVENANCE_MARKERS[meta.transcript.source];
  return `${marker} ${meta.id} ${formatDuration(meta.duration_s)} ${meta.transcript.language} ${meta.title}`;
}

/** Short window of text around a match, with ellipses where text was cut. */
export function snippet(text: string, index: number, length: number, context = 60): string {
  const start = Math.max(0, index - context);
  const end = Math.min(text.length, index + length + context);
  const before = text.slice(start, index).replace(/\s+/g, " ");
  const match = text.slice(index, index + length).replace(/\s+/g, " ");
  const after = text.slice(index + length, end).replace(/\s+/g, " ");
  return `${start > 0 ? "…" : ""}${before}${match}${after}${end < text.length ? "…" : ""}`.trim();
}
