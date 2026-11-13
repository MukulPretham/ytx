/**
 * Reading a local media file's container.
 *
 * ffprobe is the authority: an extension cannot say whether a file holds video,
 * audio, both, or neither. The parser is pure so the shape of ffprobe's JSON can
 * be tested against captured documents without the binary.
 */

import { basename } from "node:path";
import { fetchError } from "../core/errors.ts";
import { lastLines, run } from "../core/exec.ts";

export interface ProbedChapter {
  start_s: number;
  title: string;
}

export interface MediaProbe {
  durationS: number;
  height: number | null;
  width: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  /** ffprobe's `format_name`, e.g. "mov,mp4,m4a,3gp,3g2,mj2". */
  container: string | null;
  title: string | null;
  /** `YYYY-MM-DD` from a `creation_time` tag, when it parses. */
  published: string | null;
  chapters: ProbedChapter[];
}

type JsonObject = Record<string, unknown>;

export function parseProbeJson(text: string): MediaProbe {
  const root = asObject(JSON.parse(text));
  if (root === null) throw new Error("ffprobe output is not a JSON object");

  const streams = Array.isArray(root.streams) ? root.streams.map(asObject).filter(isObject) : [];
  const format = asObject(root.format) ?? {};

  // Cover art is a video stream with `attached_pic`; an mp3 with album art must
  // not be archived as if it had a picture track.
  const video = streams.find((stream) => stream.codec_type === "video" && !isAttachedPicture(stream)) ?? null;
  const audio = streams.find((stream) => stream.codec_type === "audio") ?? null;

  const formatTags = asObject(format.tags) ?? {};
  const videoTags = asObject(video?.tags) ?? {};
  const audioTags = asObject(audio?.tags) ?? {};

  const durations = [numberOf(format.duration), ...streams.map((stream) => numberOf(stream.duration))]
    .filter((value): value is number => value !== null && value > 0);
  const durationS = durations.length > 0 ? Math.max(...durations) : 0;

  return {
    durationS,
    height: integerOf(video?.height),
    width: integerOf(video?.width),
    videoCodec: stringOf(video?.codec_name) ?? null,
    audioCodec: stringOf(audio?.codec_name) ?? null,
    container: stringOf(format.format_name) ?? null,
    title: firstString([formatTags.title, videoTags.title, audioTags.title]),
    published: dateOf(formatTags.creation_time),
    chapters: chaptersOf(root.chapters),
  };
}

export async function probeMedia(ffprobe: string, path: string): Promise<MediaProbe> {
  const result = await run(
    ffprobe,
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "-show_chapters",
      path,
    ],
    { timeoutMs: 120_000 },
  );

  if (result.code !== 0) {
    throw fetchError(
      `probe ${basename(path)}`,
      lastLines(result.stderr, 3) || `ffprobe exited ${result.code}`,
      "check the file plays; if it is not media, pass the right file",
    );
  }

  try {
    return parseProbeJson(result.stdout);
  } catch (err) {
    throw fetchError(
      `probe ${basename(path)}`,
      `ffprobe did not return usable JSON (${(err as Error).message.split("\n")[0]})`,
      "run `ytx update` if ffprobe was installed by setup, then retry",
    );
  }
}

function chaptersOf(value: unknown): ProbedChapter[] {
  if (!Array.isArray(value)) return [];
  const chapters: ProbedChapter[] = [];
  for (const raw of value) {
    const chapter = asObject(raw);
    if (chapter === null) continue;
    const start = numberOf(chapter.start_time);
    const tags = asObject(chapter.tags) ?? {};
    const title = stringOf(tags.title);
    if (start === null || title === null) continue;
    chapters.push({ start_s: Math.max(0, start), title });
  }
  return chapters.sort((a, b) => a.start_s - b.start_s);
}

/** `2026-03-14T12:00:00.000000Z` → `2026-03-14`; anything else → null. */
function dateOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function isAttachedPicture(stream: JsonObject): boolean {
  const disposition = asObject(stream.disposition);
  return disposition !== null && disposition.attached_pic === 1;
}

function firstString(values: unknown[]): string | null {
  for (const value of values) {
    const text = stringOf(value);
    if (text !== null) return text;
  }
  return null;
}

function stringOf(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function integerOf(value: unknown): number | null {
  const number = numberOf(value);
  return number !== null && Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function numberOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "" || value.trim() === "N/A") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asObject(value: unknown): JsonObject | null {
  return isObject(value) ? value : null;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
