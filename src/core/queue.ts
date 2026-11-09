/**
 * `<library>/queue.jsonl` holds the work that failed for a reason that may
 * clear on its own: transient upstream errors and failures worth retrying.
 *
 * Permanent failures (gone, private, bot check) are never queued; retrying them
 * only wastes the user's time and the origin's quota.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { formatZodIssues } from "./config.ts";
import { integrityError } from "./errors.ts";
import type { LibraryPaths } from "./paths.ts";

export const QUEUE_CLASSES = ["transient", "format-unavailable"] as const;

export const QueueEntrySchema = z.object({
  id: z.string().min(1),
  url: z.string().min(1),
  failure_class: z.enum(QUEUE_CLASSES),
  attempts: z.number().int().nonnegative(),
  next_attempt_at: z.string().min(1),
  added_at: z.string().min(1),
  last_error: z.string(),
  /** What to retry: the whole acquisition, or only the media download. */
  stage: z.enum(["add", "media"]),
});

export type QueueEntry = z.infer<typeof QueueEntrySchema>;

/** Backoff with jitter, capped: 2^attempts minutes, never more than an hour. */
export function nextAttemptAt(attempts: number, now: Date, random = Math.random): Date {
  const baseSeconds = Math.min(60 * 60, 60 * 2 ** Math.min(attempts, 6));
  const jitter = 0.75 + random() * 0.5;
  return new Date(now.getTime() + Math.round(baseSeconds * jitter) * 1000);
}

export function readQueue(library: LibraryPaths): QueueEntry[] {
  if (!existsSync(library.queue)) return [];
  const text = readFileSync(library.queue, "utf8");
  const entries: QueueEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      // A torn final line is the expected shape of an interrupted append; skip
      // blank and partial trailing lines rather than losing the whole queue.
      continue;
    }
    const raw = typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    const parsed = QueueEntrySchema.safeParse({ stage: "add", ...raw });
    if (!parsed.success) {
      throw integrityError(
        "queue.jsonl",
        `line ${i + 1} failed validation: ${formatZodIssues(parsed.error)}`,
        `fix or delete ${library.queue}`,
      );
    }
    entries.push(parsed.data);
  }
  return entries;
}

export function writeQueue(library: LibraryPaths, entries: QueueEntry[]): void {
  const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
  const tmp = `${library.queue}.tmp-${process.pid}`;
  writeFileSync(tmp, (body === "" ? "" : body + "\n") as string, "utf8");
  renameSync(tmp, library.queue);
}

/** Upsert by video id: one pending entry per video, with the attempt counted. */
export function enqueue(library: LibraryPaths, entry: QueueEntry): QueueEntry {
  const entries = readQueue(library);
  const index = entries.findIndex((candidate) => candidate.id === entry.id);
  if (index >= 0) {
    const previous = entries[index]!;
    const merged: QueueEntry = { ...entry, attempts: previous.attempts + 1, added_at: previous.added_at };
    entries[index] = merged;
    writeQueue(library, entries);
    return merged;
  }
  entries.push(entry);
  writeQueue(library, entries);
  return entry;
}

export function removeFromQueue(library: LibraryPaths, id: string): boolean {
  const entries = readQueue(library);
  const next = entries.filter((entry) => entry.id !== id);
  writeQueue(library, next);
  return next.length !== entries.length;
}

export function dueEntries(library: LibraryPaths, now = new Date()): QueueEntry[] {
  return readQueue(library).filter((entry) => new Date(entry.next_attempt_at) <= now);
}

export function scheduleEntry(
  entry: QueueEntry,
  attempts: number,
  lastError: string,
  now = new Date(),
  random = Math.random,
): QueueEntry {
  return {
    ...entry,
    attempts,
    last_error: lastError,
    next_attempt_at: nextAttemptAt(attempts, now, random).toISOString(),
  };
}
