/**
 * The one interactive question outside the setup wizard.
 *
 * `ytx format` needs a destination before it can write anything. Rather than
 * inventing one, it asks once, saves the answer to `config.toml`, and continues.
 * The wizard asks the same question during setup, so the wording, validation and
 * cancellation behaviour have exactly one owner.
 */

import { isCancel, log, text } from "@clack/prompts";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { usageError } from "./core/errors.ts";
import { expandUserPath, toConfigPath } from "./core/paths.ts";

const ATTEMPTS = 3;

/**
 * Ask for a folder and return the value to store in `config.toml` (e.g.
 * `~/Desktop/ytx-transcripts`), or null when the user cancelled.
 *
 * The folder is created here: a path that cannot be created must be re-asked,
 * not saved and discovered later by a failed export.
 */
export async function askExportDir(initialValue: string): Promise<string | null> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const answer = await text({
      message: "Where should `ytx format` write transcripts?",
      // `defaultValue` accepts Enter, `placeholder` shows what Enter will use,
      // and typing starts a fresh path instead of appending to a prefill.
      defaultValue: initialValue,
      placeholder: initialValue,
    });
    if (isCancel(answer)) return null;

    const raw = String(answer ?? "").trim() || initialValue;
    const path = expandUserPath(raw, { cwd: process.cwd(), home: homedir() });
    try {
      mkdirSync(path, { recursive: true });
    } catch (err) {
      log.error(
        `${path} cannot be created (${(err as NodeJS.ErrnoException).code ?? "unknown error"}); try another folder`,
      );
      continue;
    }
    return toConfigPath(path, homedir());
  }

  throw usageError(
    "export folder",
    `no usable folder was provided after ${ATTEMPTS} attempts`,
    "pass `--dir <path>`, or set `export_dir` in config.toml",
  );
}
