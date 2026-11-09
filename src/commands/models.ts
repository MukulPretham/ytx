/**
 * `ytx models` — the visible, manageable side of model storage.
 *
 * Every model is a directory under the models root with a manifest. Nothing is
 * installed until its files verify and a canary transcription passes.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { EXIT, usageError, YtxError } from "../core/errors.ts";
import { saveState } from "../core/state.ts";
import { columns, formatAge, formatBytes } from "../core/ui.ts";
import type { CommandContext } from "./context.ts";
import { CATALOG, DEFAULT_MODEL_NAME, findCatalogEntry } from "../models/catalog.ts";
import {
  addModel,
  effectiveDefault,
  formatModelSummary,
  listInstalled,
  modelDir,
  modelsRoot,
  removeModel,
  resolveModelPath,
  verifyModel,
} from "../models/manager.ts";
import { runCanary } from "../asr/transcribe.ts";
import { requireFfmpeg } from "./context.ts";

export interface ModelsFlags {
  json: boolean;
  as?: string;
  noDefault: boolean;
  yes: boolean;
  canary: boolean;
}

export async function cmdModels(
  context: CommandContext,
  action: string | undefined,
  positionals: string[],
  flags: ModelsFlags,
): Promise<void> {
  switch (action) {
    case "list":
    case undefined:
      return list(context);
    case "add":
      return add(context, positionals, flags);
    case "rm":
      return remove(context, positionals, flags);
    case "verify":
      return verify(context, positionals, flags);
    case "default":
      return setDefault(context, positionals);
    case "path":
      return showPath(context, positionals);
    default:
      throw usageError(
        `models ${action}`,
        "is not a subcommand",
        "use `models list | add | rm | verify | default | path`",
      );
  }
}

function list(context: CommandContext): void {
  const installed = listInstalled(context.runtime);
  const defaultName = effectiveDefault(context.state.default_model);
  const rows: string[][] = [];

  if (!context.flags.json) {
    context.ui.line(context.ui.dim(`models root  ${modelsRoot(context.runtime)}`));
    context.ui.line(context.ui.dim(`default      ${defaultName}`));
    context.ui.line("");
  }

  for (const entry of installed) {
    const isDefault = entry.name === defaultName;
    rows.push([
      `${isDefault ? "*" : " "} ${entry.name}${isDefault ? context.ui.dim(" (default)") : ""}`,
      formatBytes(entry.total_bytes),
      entry.manifest?.catalog ? "catalog" : "custom",
      entry.manifest ? formatAge(entry.manifest.installed_at) : "unknown",
      entry.manifest ? `${entry.manifest.repo}@${entry.manifest.revision.slice(0, 8)}` : "no manifest",
    ]);
  }

  if (!context.flags.json) {
    if (rows.length === 0) {
      context.ui.line("no models installed");
      context.ui.note("  install one with `ytx models add turbo`");
    } else {
      context.ui.line(columns([["", "size", "source", "installed", "repo"], ...rows]).slice(1).join("\n"));
    }
    context.ui.line("");
    const known = CATALOG.map((entry) => `${entry.name} (${entry.size_mb / 1000 >= 1 ? `${(entry.size_mb / 1000).toFixed(1)} GB` : `${entry.size_mb} MB`})`);
    context.ui.line(context.ui.dim(`catalog: ${known.join(", ")}`));
  }

  context.ui.emit({
    models_root: modelsRoot(context.runtime),
    default: defaultName,
    installed: installed.map((entry) => ({
      name: entry.name,
      path: entry.path,
      bytes: entry.total_bytes,
      default: entry.name === defaultName,
      repo: entry.manifest?.repo ?? null,
      revision: entry.manifest?.revision ?? null,
      catalog: entry.manifest?.catalog ?? false,
      installed_at: entry.manifest?.installed_at ?? null,
      verified: entry.manifest ? verifyModel(context.runtime, entry.name).ok : false,
    })),
    catalog: CATALOG,
  });
}

async function add(
  context: CommandContext,
  positionals: string[],
  flags: ModelsFlags,
): Promise<void> {
  const input = positionals[0];
  if (!input) {
    throw usageError(
      "models add",
      "needs a model name or a hub repo",
      `use one of ${CATALOG.map((entry) => entry.name).join(", ")}, or \`owner/repo\``,
    );
  }

  requireFfmpeg(context);
  const isCatalog = Boolean(findCatalogEntry(input));
  const nameHint = flags.as ?? findCatalogEntry(input)?.name ?? input;

  if (!context.flags.json) {
    context.ui.note(`checking ${input} on the hub…`);
  }

  const result = await addModel(context.runtime, input, {
    as: flags.as,
    keepDefault: flags.noDefault,
    onUntested: (repo) => {
      context.ui.warn(
        `${repo} is not in the tested catalog; it will be downloaded and canaried, but quality is unverified`,
      );
    },
    onProgress: (progress) => {
      if (context.flags.json) return;
      const percent =
        progress.size && progress.size > 0
          ? ` ${Math.min(100, Math.round((progress.received / progress.size) * 100))}%`
          : "";
      const size = progress.size ? ` of ${formatBytes(progress.size)}` : "";
      writeProgress(`${progress.file}${percent}${size}`);
    },
    canary: async (modelPath) => {
      if (!context.flags.json) {
        clearProgress();
        context.ui.note("running the canary transcription…");
      }
      return runCanary({
        runtime: context.runtime,
        ffmpeg: context.ffmpeg,
        modelPath,
        modelName: String(nameHint),
        onLine: context.flags.debug ? (line) => context.ui.note(`  ${line}`) : undefined,
      });
    },
  });

  clearProgress();

  let isDefault = false;
  const currentDefault = context.state.default_model;
  if (!flags.noDefault && (currentDefault === null || currentDefault === result.name || isCatalog)) {
    context.state.default_model = result.name;
    saveState(context.runtime.state, context.state);
    isDefault = effectiveDefault(context.state.default_model) === result.name;
  }

  if (!context.flags.json) {
    context.ui.ok(`installed ${result.name} at ${result.path}`);
    context.ui.line(`  ${formatModelSummary(result.manifest)}`);
    if (result.manifest.canary?.passed) {
      context.ui.line(`  canary: "${truncate(result.manifest.canary.text, 70)}"`);
    }
    if (result.resumed) context.ui.line("  resumed a partial download");
    if (isDefault) context.ui.line(`  default model is now ${result.name}`);
    if (!isCatalog) {
      context.ui.warn("this repo is not in the tested catalog; run `ytx models verify --canary` after updates");
    }
  }

  context.ui.emit({
    installed: result.manifest,
    path: result.path,
    catalog: isCatalog,
    default: isDefault,
    resumed: result.resumed,
  });
}

function remove(context: CommandContext, positionals: string[], flags: ModelsFlags): void {
  const name = positionals[0];
  if (!name) {
    throw usageError("models rm", "needs a model name", "run `ytx models list` to see installed models");
  }

  const defaultName = effectiveDefault(context.state.default_model);
  if (!flags.yes && !context.flags.nonInteractive && process.stdin.isTTY) {
    const answer = prompt(`Remove model ${name}? [y/N]`);
    if (!answer || !/^y(es)?$/i.test(answer.trim())) {
      context.ui.line("skipped");
      context.ui.emit({ removed: null });
      return;
    }
  }

  const result = removeModel(context.runtime, name, { defaultName });

  if (context.state.default_model === result.name) {
    context.state.default_model = null;
    saveState(context.runtime.state, context.state);
  }

  if (!context.flags.json) {
    context.ui.ok(`removed ${result.name} (${formatBytes(result.freed_bytes)} freed)`);
    // The invariant worth stating: transcripts are already text on disk.
    context.ui.line(
      "  archived transcripts are unaffected: every transcript is already stored as text in the library",
    );
  }
  context.ui.emit({ removed: result.name, path: result.path, freed_bytes: result.freed_bytes });
}

async function verify(
  context: CommandContext,
  positionals: string[],
  flags: ModelsFlags,
): Promise<void> {
  const installed = listInstalled(context.runtime);
  const targets = positionals.length > 0 ? positionals : installed.map((entry) => entry.name);
  if (targets.length === 0) {
    throw usageError(
      "models verify",
      "found no installed models",
      "install one with `ytx models add turbo`",
    );
  }

  const results = [];
  let problems = 0;
  for (const name of targets) {
    const result = verifyModel(context.runtime, name);
    let canaryText: string | null = null;
    if (flags.canary && result.ok) {
      requireFfmpeg(context);
      const manifest = listInstalled(context.runtime).find((entry) => entry.name === name)?.manifest ?? null;
      try {
        canaryText = await runCanary({
          runtime: context.runtime,
          ffmpeg: context.ffmpeg,
          modelPath: result.path,
          modelName: name,
        });
        if (canaryText.trim() === "") {
          result.problems.push("canary transcription produced no text");
          result.ok = false;
        }
      } catch (err) {
        result.problems.push(`canary failed: ${(err as Error).message}`);
        result.ok = false;
      }
      void manifest;
    }
    if (!result.ok) problems += 1;
    results.push({ ...result, canary: canaryText });

    if (!context.flags.json) {
      if (result.ok) {
        context.ui.ok(`${name} verifies${canaryText ? ` (canary: "${truncate(canaryText, 60)}")` : ""}`);
      } else {
        context.ui.fail(`${name}: ${result.problems.join("; ")}`);
      }
    }
  }

  context.ui.emit({ results });
  if (problems > 0) {
    throw new YtxError({
      what: "models verify",
      why: `${problems} model(s) failed verification`,
      next: "reinstall them with `ytx models add`, or remove them with `ytx models rm`",
      code: EXIT.integrity,
      kind: "model-invalid",
    });
  }
}

function setDefault(context: CommandContext, positionals: string[]): void {
  const name = positionals[0];
  const current = effectiveDefault(context.state.default_model);

  if (!name) {
    context.ui.line(current);
    context.ui.emit({ default: current });
    return;
  }

  const dirName = modelDir(context.runtime, name).split("/").pop() ?? name;
  if (!existsSync(join(modelsRoot(context.runtime), dirName))) {
    const available = listInstalled(context.runtime).map((entry) => entry.name);
    throw new YtxError({
      what: `models default ${name}`,
      why: `is not installed${available.length > 0 ? ` (installed: ${available.join(", ")})` : ""}`,
      next: `install it first with \`ytx models add ${name}\``,
      code: EXIT.usage,
      kind: "model-missing",
    });
  }

  context.state.default_model = dirName;
  saveState(context.runtime.state, context.state);
  context.ui.ok(`default model is now ${dirName}`);
  context.ui.emit({ default: dirName });
}

function showPath(context: CommandContext, positionals: string[]): void {
  const name = positionals[0];
  if (!name) {
    context.ui.line(modelsRoot(context.runtime));
    context.ui.emit({ path: modelsRoot(context.runtime), default: effectiveDefault(context.state.default_model) });
    return;
  }
  const resolved = resolveModelPath(context.runtime, name);
  context.ui.line(resolved.path);
  context.ui.emit({
    path: resolved.path,
    name: resolved.name,
    manifest: resolved.manifest,
    default: resolved.name === effectiveDefault(context.state.default_model),
  });
}

let lastProgressWidth = 0;

function writeProgress(text: string): void {
  if (!process.stderr.isTTY) return;
  const padded = text.padEnd(lastProgressWidth, " ");
  lastProgressWidth = text.length;
  process.stderr.write(`\r${padded}`);
}

function clearProgress(): void {
  if (!process.stderr.isTTY || lastProgressWidth === 0) return;
  process.stderr.write(`\r${" ".repeat(lastProgressWidth)}\r`);
  lastProgressWidth = 0;
}

function truncate(text: string, width: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= width ? clean : `${clean.slice(0, width - 1)}…`;
}

export { DEFAULT_MODEL_NAME };
