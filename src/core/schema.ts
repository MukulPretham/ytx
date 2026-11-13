/**
 * `meta.json` is the only description of a video directory, so it is validated
 * on every read and every write. A record that fails validation is never
 * written: a partial record is worse than a missing one.
 */

import { z } from "zod";
import { ARCHIVE_ID_RE, LOCAL_ID_RE, VIDEO_ID_RE, localIdForSha256, localOriginUrl } from "./paths.ts";

export const RECORD_SCHEMA = 2;

/**
 * Where a record's bytes came from. It decides which commands may touch the
 * record: `youtube` records are re-fetched through yt-dlp, `file` records are
 * only ever re-imported by hand.
 */
export const ORIGINS = ["youtube", "file"] as const;
export type Origin = (typeof ORIGINS)[number];

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

/**
 * The source of an imported file. The filename is a basename on purpose: the
 * library never learns where the file lived, so it stays relocatable.
 */
export const SourceFileSchema = z.object({
  kind: z.literal("file"),
  filename: z
    .string()
    .min(1)
    .refine((name) => !name.includes("/") && !name.includes("\\") && name !== "." && name !== "..", {
      message: "must be a bare filename",
    }),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "not a sha256 digest"),
});

export type SourceFile = z.infer<typeof SourceFileSchema>;

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
    /** Which binary fetched it: the runtime copy or one found on PATH. */
    ytdlp_source: z.enum(["managed", "system"]).optional(),
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
      if (value.ytdlp_source) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["ytdlp_source"],
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
    // `ytdlp_source` is written for every new caption record, but it is not
    // required on read: records archived before the field existed stay valid.
    // Forbidding it on `asr` above keeps the two provenance shapes distinct.
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

export const MetaSchema = z
  .object({
    schema: z.union([z.literal(1), z.literal(2)]),
    /** Absent in v1 records, which are all YouTube videos. */
    origin: z.enum(ORIGINS).default("youtube"),
    id: z.string().regex(ARCHIVE_ID_RE, "not a YouTube video id or a local id"),
    url: z.string().min(1),
    /** Present only for `origin: "file"`. */
    source: SourceFileSchema.optional(),
    title: z.string(),
    channel: ChannelSchema,
    duration_s: z.number().nonnegative(),
    published: z.string().nullable(),
    chapters: z.array(ChapterSchema),
    media: MediaSchema,
    transcript: TranscriptRecordSchema,
    transcript_history: z.array(TranscriptHistoryEntrySchema),
    /**
     * Non-fatal observations about this acquisition, e.g. "human captions repeat
     * a chorus line 41% of the time; repetition is not a rejection for human
     * captions". Warnings never block a record; they are the record's own note
     * about why something that looks odd was accepted.
     */
    warnings: z.array(z.string()).default([]),
    added_at: z.string().min(1),
    updated_at: z.string().min(1),
  })
  .superRefine((value, ctx) => {
    if (value.origin === "file") {
      if (value.schema !== 2) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["schema"],
          message: 'must be 2 for origin "file"',
        });
      }
      if (!LOCAL_ID_RE.test(value.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["id"],
          message: 'must be "local-" followed by 12 hex characters for origin "file"',
        });
      }
      if (!value.source) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["source"],
          message: 'required for origin "file"',
        });
        return;
      }
      if (value.url !== localOriginUrl(value.source.sha256)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["url"],
          message: "must be local:sha256:<source.sha256>",
        });
      }
      if (value.id !== localIdForSha256(value.source.sha256)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["id"],
          message: "must be derived from source.sha256",
        });
      }
      return;
    }

    if (!VIDEO_ID_RE.test(value.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: "not an 11-character YouTube video id",
      });
    }
    if (value.source) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["source"],
        message: 'file-only field, not valid for origin "youtube"',
      });
    }
    if (!/^https?:\/\//.test(value.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: 'must be an http(s) URL for origin "youtube"',
      });
    }
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
