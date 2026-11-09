/**
 * Library config: `<library>/config.toml`.
 *
 * Config is data, so it lives in the library, not the runtime directory. A
 * library copied to another machine keeps its preferences; the runtime
 * directory (binaries, weights) is what gets rebuilt by `ytx setup`.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { z } from "zod";
import { integrityError, YtxError } from "./errors.ts";
import type { LibraryPaths } from "./paths.ts";

export const CONFIG_SCHEMA = 1;

/**
 * Long-lived reference videos used by `ytx update` as a canary. They are old,
 * short, public, and unlikely to disappear; a canary only needs metadata, never
 * a download, so it stays fast.
 */
export const DEFAULT_CANARY_URLS = [
  "https://www.youtube.com/watch?v=jNQXAC9IVRw",
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
] as const;

export const ConfigSchema = z.object({
  schema: z.number().int(),
  /** Preferred caption language, or "auto" to take the video's original. */
  language: z.string().min(1),
  /** Ceiling for the archived video track; audio is never upscaled. */
  max_height: z.number().int().positive(),
  /** "auto" obeys the acquisition ladder; "best" skips machine captions. */
  quality: z.enum(["auto", "best"]),
  /** Catalog name, explicit repo, or "none". */
  asr_model: z.string().min(1),
  /** Concurrent ASR transcriptions. 1 keeps memory bounded. */
  parallel: z.number().int().positive(),
  /** Browser to pull cookies from for bot-check resilience; "" means none. */
  browser: z.string(),
  /** yt-dlp release channel that `ytx update` follows. */
  ytdlp_channel: z.enum(["stable", "nightly"]),
  /** Reference videos `ytx update` canaries a new binary against. */
  canary_urls: z.array(z.string().min(1)).min(1),
});

export type Config = z.infer<typeof ConfigSchema>;

export function defaultConfig(): Config {
  return {
    schema: CONFIG_SCHEMA,
    language: "en",
    max_height: 1080,
    quality: "auto",
    asr_model: "turbo",
    parallel: 1,
    browser: "",
    ytdlp_channel: "stable",
    canary_urls: [...DEFAULT_CANARY_URLS],
  };
}

export function loadConfig(library: LibraryPaths): Config {
  const text = readIfPresent(library.config);
  if (text === null) return defaultConfig();
  let data: unknown;
  try {
    data = parseToml(text);
  } catch (err) {
    throw integrityError(
      "config.toml",
      `not valid TOML (${(err as Error).message.split("\n")[0]})`,
      `fix ${library.config}, or delete it and run \`ytx setup\` again`,
    );
  }
  const parsed = ConfigSchema.safeParse(data);
  if (!parsed.success) {
    throw integrityError(
      "config.toml",
      `failed validation: ${formatZodIssues(parsed.error)}`,
      `fix ${library.config}, or delete it and run \`ytx setup\` again`,
    );
  }
  return parsed.data;
}

export function saveConfig(library: LibraryPaths, config: Config): void {
  const parsed = ConfigSchema.safeParse(config);
  if (!parsed.success) {
    throw integrityError(
      "config.toml",
      `refusing to write invalid config: ${formatZodIssues(parsed.error)}`,
      "report this as a bug in ytx",
    );
  }
  mkdirSync(dirname(library.config), { recursive: true });
  const text = stringifyToml(parsed.data as unknown as Record<string, unknown>) + "\n";
  const tmp = `${library.config}.tmp-${process.pid}`;
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, library.config);
}

export function formatZodIssues(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

function readIfPresent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new YtxError({
      what: path,
      why: `cannot be read (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
      next: "check the file's permissions",
      code: 6,
      kind: "integrity",
      cause: err,
    });
  }
}
