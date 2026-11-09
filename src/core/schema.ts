/**
 * `meta.json` is the only description of a video directory, so it is validated
 * on every read and every write. A record that fails validation is never
 * written: a partial record is worse than a missing one.
 */

import { z } from "zod";

export const RECORD_SCHEMA = 1;

export const PROVENANCES = ["caption-human", "caption-auto", "asr"] as const;
export type Provenance = (typeof PROVENANCES)[number];

export const TranscriptSegmentSchema = z
  .object({
    start: z.number().nonnegative(),
    end: z.number().nonnegative(),
    text: z.string(),
  })
  .refine((s) => s.end >= s.start, { message: "end must be >= start" });

export type TranscriptSegment = z.infer<typeof TranscriptSegmentSchema>;

export const TranscriptSchema = z.array(TranscriptSegmentSchema);

const relativeFile = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(p), {
    message: "must be relative to the video directory",
  })
  .refine((p) => !p.split("/").includes(".."), {
    message: "must not escape the video directory",
  });

export const ChapterSchema = z.object({
  start_s: z.number().nonnegative(),
  title: z.string(),
});

export const ChannelSchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
});

export const MediaSchema = z.object({
  video: relativeFile.nullable(),
  /** The original audio track, kept exactly as downloaded. */
  audio: relativeFile.nullable(),
  /** MP3 generated from the original; null only when conversion is impossible. */
  mp3: relativeFile.nullable(),
  height: z.number().int().positive().nullable(),
});

export const TranscriptRecordSchema = z
  .object({
    source: z.enum(PROVENANCES),
    language: z.string().min(1),
    /** Whisper repo name, present only for `asr`. */
    model: z.string().min(1).optional(),
    /** Pinned checkpoint revision, present only for `asr`. */
    model_revision: z.string().min(1).optional(),
    /** yt-dlp version that fetched the track, present only for caption sources. */
    ytdlp_version: z.string().min(1).optional(),
    coverage: z.number().nonnegative(),
    segments: z.number().int().nonnegative(),
    chars: z.number().int().nonnegative(),
    fetched_at: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.source === "asr") {
      if (!value.model) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["model"], message: "required for asr" });
      }
      if (!value.model_revision) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["model_revision"],
          message: "required for asr so the transcript can be reproduced",
        });
      }
      if (value.ytdlp_version) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ytdlp_version"],
          message: "caption-only field, not valid for asr",
        });
      }
      return;
    }
    if (!value.ytdlp_version) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["ytdlp_version"],
        message: "required for caption sources so the fetch can be reproduced",
      });
    }
    if (value.model || value.model_revision) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model"],
        message: "asr-only field, not valid for caption sources",
      });
    }
  });

export const TranscriptHistoryEntrySchema = TranscriptRecordSchema.and(
  z.object({ superseded_at: z.string().min(1) }),
);

export const MetaSchema = z.object({
  schema: z.number().int(),
  id: z.string().regex(/^[A-Za-z0-9_-]{11}$/, "not a YouTube video id"),
  url: z.string().min(1),
  title: z.string(),
  channel: ChannelSchema,
  duration_s: z.number().nonnegative(),
  published: z.string().nullable(),
  chapters: z.array(ChapterSchema),
  media: MediaSchema,
  transcript: TranscriptRecordSchema,
  transcript_history: z.array(TranscriptHistoryEntrySchema),
  added_at: z.string().min(1),
  updated_at: z.string().min(1),
});

export type Meta = z.infer<typeof MetaSchema>;
export type Media = z.infer<typeof MediaSchema>;
export type TranscriptRecord = z.infer<typeof TranscriptRecordSchema>;
export type TranscriptHistoryEntry = z.infer<typeof TranscriptHistoryEntrySchema>;

export const PROVENANCE_LABELS: Record<Provenance, string> = {
  "caption-human": "human captions",
  "caption-auto": "platform machine captions",
  asr: "local speech recognition",
};

/** The single-character marker `ytx list` prints. H human, A auto, M machine-local. */
export const PROVENANCE_MARKERS: Record<Provenance, string> = {
  "caption-human": "H",
  "caption-auto": "A",
  asr: "M",
};

export function charsOf(segments: readonly TranscriptSegment[]): number {
  return segments.reduce((total, segment) => total + [...segment.text].length, 0);
}

/** Last cue end divided by the video duration, clamped to [0, 1]. */
export function coverageOf(segments: readonly TranscriptSegment[], durationS: number): number {
  if (segments.length === 0 || durationS <= 0) return 0;
  const lastEnd = segments[segments.length - 1]?.end ?? 0;
  const ratio = lastEnd / durationS;
  if (!Number.isFinite(ratio)) return 0;
  return Math.max(0, Math.min(1, ratio));
}
