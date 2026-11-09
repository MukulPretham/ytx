/**
 * `<runtime>/state.json` records what `ytx setup` and `ytx update` installed, so
 * `doctor` can report versions without probing the network, and so a second
 * `setup` run can skip work that is already done.
 *
 * This file is machine-local: it names absolute paths in the runtime directory.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { formatZodIssues } from "./config.ts";
import { integrityError } from "./errors.ts";

export const STATE_SCHEMA = 1;

export const StateSchema = z.object({
  schema: z.number().int(),
  ytdlp: z
    .object({
      version: z.string(),
      channel: z.enum(["stable", "nightly"]),
      /** "managed" is the runtime copy; "system" is a yt-dlp found on PATH. */
      source: z.enum(["managed", "system"]).optional(),
      installed_at: z.string(),
      /** Version kept in `bin/yt-dlp.prev` for `update --rollback`. */
      previous_version: z.string().nullable(),
    })
    .nullable(),
  ffmpeg: z
    .object({
      path: z.string(),
      version: z.string(),
      source: z.enum(["path", "download"]),
    })
    .nullable(),
  uv: z.object({ path: z.string(), version: z.string() }).nullable(),
  venv: z
    .object({
      python: z.string(),
      mlx_whisper: z.string(),
      created_at: z.string(),
    })
    .nullable(),
  default_model: z.string().nullable(),
  updated_at: z.string(),
});

export type State = z.infer<typeof StateSchema>;

export function defaultState(): State {
  return {
    schema: STATE_SCHEMA,
    ytdlp: null,
    ffmpeg: null,
    uv: null,
    venv: null,
    default_model: null,
    updated_at: new Date().toISOString(),
  };
}

export function loadState(path: string): State {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return defaultState();
    throw integrityError(
      "state.json",
      `cannot be read (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
      `check permissions on ${path}`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw integrityError(
      "state.json",
      `not valid JSON (${(err as Error).message.split("\n")[0]})`,
      `delete ${path} and run \`ytx setup\` to rebuild it`,
    );
  }
  const parsed = StateSchema.safeParse(data);
  if (!parsed.success) {
    throw integrityError(
      "state.json",
      `failed validation: ${formatZodIssues(parsed.error)}`,
      `delete ${path} and run \`ytx setup\` to rebuild it`,
    );
  }
  return parsed.data;
}

export function saveState(path: string, state: State): void {
  const parsed = StateSchema.safeParse({ ...state, updated_at: new Date().toISOString() });
  if (!parsed.success) {
    throw integrityError(
      "state.json",
      `refusing to write invalid state: ${formatZodIssues(parsed.error)}`,
      "report this as a bug in ytx",
    );
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(parsed.data, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function updateState(path: string, patch: Partial<State>): State {
  const next = { ...loadState(path), ...patch };
  saveState(path, next);
  return next;
}
