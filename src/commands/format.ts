/**
 * `ytx format <id> [type]` — write a transcript into the export folder.
 *
 * The folder is `export_dir` from config.toml ("" means ~/Desktop, a relative
 * value stays inside the library), overridable per run with `--dir`. Files are
 * named after the title and carry the record id, so two records with the same
 * title never overwrite each other.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../core/config.ts";
import { fetchError, usageError, YtxError } from "../core/errors.ts";
import {
  archiveIdFromInput,
  defaultExportDir,
  expandUserPath,
  resolveExportDir,
  toConfigPath,
} from "../core/paths.ts";
import { readMeta, readTranscript } from "../core/record.ts";
import { askExportDir } from "../prompts.ts";
import type { TranscriptSegment } from "../core/schema.ts";
import {
  TRANSCRIPT_FORMATS,
  exportBaseName,
  exportFileName,
  parseTranscriptFormat,
  renderTranscript,
  type TranscriptFormat,
} from "./render.ts";
import type { CommandContext } from "./context.ts";

export interface FormatFlags {
  /** Prefix txt/md paragraphs with their start time. */
  timestamps: boolean;
  /** Override the configured export folder. */
  dir: string | null;
}

export async function cmdFormat(
  context: CommandContext,
  positionals: string[],
  flags: FormatFlags,
): Promise<void> {
  const target = positionals[0];
  if (!target) {
    throw usageError(
      "format",
      "needs an archived video id",
      "run `ytx list` to copy an id, then `ytx format <id> md`",
    );
  }
  if (positionals.length > 2) {
    throw usageError(
      `format ${target}`,
      "takes at most one file type",
      `use \`ytx format <id> ${TRANSCRIPT_FORMATS.join("|")}|all\``,
    );
  }

  const requested = parseType(positionals[1] ?? "txt");
  const formats = requested === "all" ? [...TRANSCRIPT_FORMATS] : [requested];

  const id = archiveIdFromInput(target);
  if (id === null) {
    throw usageError(
      `format ${target}`,
      "is not an archived id or a YouTube URL",
      "run `ytx list` to see what is archived",
    );
  }

  const meta = readMeta(context.library, id);
  const segments = readTranscript(context.library, id);

  const interactive =
    Boolean(process.stdin.isTTY) &&
    !context.flags.nonInteractive &&
    !context.flags.json &&
    !context.flags.yes;

  let dir: string;
  if (flags.dir !== null) {
    dir = expandUserPath(flags.dir, { cwd: process.cwd(), home: homedir() });
  } else {
    const configured = resolveExportDir({
      configValue: context.config.export_dir,
      libraryRoot: context.library.root,
      home: homedir(),
    });
    if (configured !== null) {
      dir = configured;
    } else if (interactive) {
      // Ask once, save the answer, then continue with this same export.
      const suggested = toConfigPath(defaultExportDir(homedir()), homedir());
      const chosen = await askExportDir(suggested);
      if (chosen === null) {
        throw new YtxError({
          what: "format",
          why: "cancelled at the export folder question",
          next: "run `ytx format <id> <type>` again when you are ready",
          code: 130,
          kind: "cancelled",
        });
      }
      const config = { ...context.config, export_dir: chosen };
      saveConfig(context.library, config);
      context.config = config;
      const resolved = resolveExportDir({
        configValue: chosen,
        libraryRoot: context.library.root,
        home: homedir(),
      });
      if (resolved === null) throw new Error("an accepted export folder must resolve");
      dir = resolved;
      context.ui.ok(`export folder set to ${dir} (${context.library.config})`);
    } else {
      throw usageError(
        "format",
        "no export folder is configured",
        "pass `--dir <path>`, or set `export_dir` in config.toml; an interactive run asks once and saves the answer",
      );
    }
  }

  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw fetchError(
      "export folder",
      `${dir} cannot be created (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
      "pass `--dir <path>`, or set `export_dir` in config.toml",
    );
  }

  // Every record gets its own folder inside the export root, so formats from
  // different videos never mix and a re-export replaces one folder's files.
  const folder = join(dir, exportBaseName(meta.title, meta.id));
  try {
    mkdirSync(folder, { recursive: true });
  } catch (err) {
    throw fetchError(
      "export folder",
      `${folder} cannot be created (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
      "pass `--dir <path>`, or check the export folder's permissions",
    );
  }

  const files: { format: TranscriptFormat; path: string; bytes: number }[] = [];
  for (const format of formats) {
    const path = join(folder, exportFileName(meta.title, meta.id, format));
    const body = renderExport(meta.title, segments, format, flags.timestamps);
    try {
      writeFileSync(path, body, "utf8");
    } catch (err) {
      throw fetchError(
        `export ${format}`,
        `${path} cannot be written (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
        "check the folder's permissions, or pass `--dir <path>`",
      );
    }
    files.push({ format, path, bytes: Buffer.byteLength(body) });
    if (!context.flags.json) context.ui.ok(`${format} → ${path}`);
  }

  context.ui.emit({ id, export_dir: dir, folder, files });
}

function parseType(value: string): TranscriptFormat | "all" {
  if (value === "all") return "all";
  try {
    return parseTranscriptFormat(value);
  } catch {
    throw usageError(
      `format type ${value}`,
      "is not a transcript format",
      `use one of ${TRANSCRIPT_FORMATS.join(", ")}, or "all"`,
    );
  }
}

/** A markdown export is a document, so it gets its title as a heading. */
function renderExport(
  title: string,
  segments: readonly TranscriptSegment[],
  format: TranscriptFormat,
  timestamps: boolean,
): string {
  const body = renderTranscript(segments, format, { timestamps });
  return format === "md" ? `# ${title}\n\n${body}` : body;
}
