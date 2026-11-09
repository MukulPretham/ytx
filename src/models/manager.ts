/**
 * Model installation and removal.
 *
 * Weights live in `<runtime>/models`, deliberately visible: one directory per
 * model, a `manifest.json` inside it, and nothing hidden in a tool cache. A
 * model only appears there after its files are verified and a canary
 * transcription passes, which is why a killed download leaves no installed
 * model at all - only a resumable staging directory.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { formatZodIssues } from "../core/config.ts";
import { fetchError, integrityError, YtxError } from "../core/errors.ts";
import { acquireLock, isLocked, readLock, type LockHandle } from "../core/lock.ts";
import type { RuntimePaths } from "../core/paths.ts";
import { formatBytes } from "../core/ui.ts";
import {
  CATALOG,
  DEFAULT_MODEL_NAME,
  catalogEntryForRepo,
  findCatalogEntry,
  modelDirName,
  parseRepoInput,
  type CatalogEntry,
} from "./catalog.ts";
import {
  downloadRepoFiles,
  fetchRepoInfo,
  notACheckpointError,
  type DownloadFileProgress,
  type RepoInfo,
} from "./hub.ts";

export const MANIFEST_FILE = "manifest.json";
export const MANIFEST_SCHEMA = 1;

export const ManifestSchema = z.object({
  schema: z.number().int(),
  name: z.string().min(1),
  repo: z.string().min(1),
  revision: z.string().min(1),
  catalog: z.boolean(),
  files: z.array(z.object({ name: z.string().min(1), size: z.number().int().nonnegative() })),
  total_bytes: z.number().int().nonnegative(),
  installed_at: z.string().min(1),
  canary: z
    .object({ passed: z.boolean(), text: z.string(), at: z.string().min(1) })
    .nullable(),
});

export type ModelManifest = z.infer<typeof ManifestSchema>;

export interface InstalledModel {
  name: string;
  path: string;
  manifest: ModelManifest | null;
  total_bytes: number;
}

export function modelsRoot(runtime: RuntimePaths): string {
  return runtime.models;
}

export function modelDir(runtime: RuntimePaths, name: string): string {
  return join(runtime.models, modelDirName(name));
}

export function stagingDir(runtime: RuntimePaths, name: string): string {
  return join(runtime.models, `.tmp-${modelDirName(name)}`);
}

export function listInstalled(runtime: RuntimePaths): InstalledModel[] {
  const root = runtime.models;
  if (!existsSync(root)) return [];
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .sort((a, b) => a.name.localeCompare(b.name));

  return entries.map((entry) => {
    const path = join(root, entry.name);
    const manifest = readManifest(path);
    const bytes = manifest?.total_bytes ?? directorySize(path);
    return { name: manifest?.name ?? entry.name, path, manifest, total_bytes: bytes };
  });
}

export function readManifest(modelPath: string): ModelManifest | null {
  const file = join(modelPath, MANIFEST_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function directorySize(path: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      try {
        total += entry.isDirectory() ? directorySize(child) : statSync(child).size;
      } catch {
        // A file may vanish mid-scan; the size is advisory.
      }
    }
  } catch {
    return 0;
  }
  return total;
}

/** The model to transcribe with: state's default, else the catalog default. */
export function effectiveDefault(defaultFromState: string | null): string {
  const stored = defaultFromState?.trim();
  return stored && stored !== "" ? stored : DEFAULT_MODEL_NAME;
}

export function resolveModelPath(
  runtime: RuntimePaths,
  name: string,
): { name: string; path: string; manifest: ModelManifest | null } {
  const dirName = modelDirName(name);
  const path = join(runtime.models, dirName);
  if (!existsSync(path)) {
    throw new YtxError({
      what: `model ${name}`,
      why: `is not installed in ${runtime.models}`,
      next: `run \`ytx models add ${name}\`, or \`ytx models list\` to see what is installed`,
      code: 3,
      kind: "model-missing",
    });
  }
  return { name: dirName, path, manifest: readManifest(path) };
}

export type CanaryRunner = (modelPath: string) => Promise<string>;

export interface AddModelOptions {
  /** Explicit name for a custom repo; defaults to the sanitized repo. */
  as?: string;
  /** Do not switch the default to this model. */
  keepDefault?: boolean;
  force?: boolean;
  onProgress?: (progress: DownloadFileProgress) => void;
  canary?: CanaryRunner;
  /** Called once when an untested repo is about to be downloaded. */
  onUntested?: (repo: string) => void;
}

export interface AddModelResult {
  name: string;
  path: string;
  manifest: ModelManifest;
  catalog: CatalogEntry | null;
  resumed: boolean;
}

export async function addModel(
  runtime: RuntimePaths,
  input: string,
  options: AddModelOptions = {},
): Promise<AddModelResult> {
  const lock = acquireLock(runtime.locks, "models", `ytx models add ${input}`);
  try {
    return await addModelLocked(runtime, input, options);
  } finally {
    lock.release();
  }
}

async function addModelLocked(
  runtime: RuntimePaths,
  input: string,
  options: AddModelOptions,
): Promise<AddModelResult> {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new YtxError({
      what: "models add",
      why: "no model name or repo was given",
      next: "use `ytx models add turbo`, or `ytx models add owner/repo`",
      code: 2,
      kind: "usage",
    });
  }

  const catalogEntry = findCatalogEntry(trimmed);
  const repo = catalogEntry ? catalogEntry.repo : parseRepoInput(trimmed);
  if (repo === null) {
    throw new YtxError({
      what: `models add ${trimmed}`,
      why: "is neither a catalog name nor a hub repo (owner/repo)",
      next: `use one of ${CATALOG.map((entry) => entry.name).join(", ")}, or \`owner/repo\``,
      code: 2,
      kind: "usage",
    });
  }

  const name = options.as ?? catalogEntry?.name ?? modelDirName(repo);
  const target = join(runtime.models, modelDirName(name));
  const staging = stagingDir(runtime, name);
  mkdirSync(runtime.models, { recursive: true });

  // Validate against the hub before touching the disk.
  const info = await fetchRepoInfo(repo);
  if (!info.mlx_whisper) {
    throw notACheckpointError(repo, info.fileNames);
  }
  if (!catalogEntry) options.onUntested?.(repo);

  const expectedBytes = info.total_bytes || (catalogEntry?.size_mb ?? 0) * 1_000_000;
  const free = freeBytes(runtime.models);
  if (free !== null && expectedBytes > 0 && free < expectedBytes * 1.05) {
    throw fetchError(
      `model ${name}`,
      `needs about ${formatBytes(expectedBytes)} but ${formatBytes(free)} is free in ${runtime.models}`,
      "free some space, or set YTX_MODELS_DIR to a larger volume and retry",
    );
  }

  const resumed = existsSync(staging) && directorySize(staging) > 0;
  if (existsSync(staging) && !resumed) rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  const revision = catalogEntry?.revision ?? info.revision;
  const downloadInfo: RepoInfo = { ...info, revision };

  try {
    await downloadRepoFiles(downloadInfo, staging, { onProgress: options.onProgress });
    verifyFiles(staging, downloadInfo);

    let canaryText = "";
    let canaryPassed = false;
    if (options.canary) {
      canaryText = (await options.canary(staging)).trim();
      canaryPassed = canaryText !== "";
      if (!canaryPassed) {
        throw fetchError(
          `model ${name}`,
          "the canary transcription produced no text",
          "the download is incomplete or corrupt; retry `ytx models add`",
        );
      }
    }

    const manifest: ModelManifest = {
      schema: MANIFEST_SCHEMA,
      name: modelDirName(name),
      repo,
      revision,
      catalog: Boolean(catalogEntry),
      files: downloadInfo.files.map((file) => ({ name: file.name, size: file.size ?? 0 })),
      total_bytes: expectedBytes,
      installed_at: new Date().toISOString(),
      canary: options.canary
        ? { passed: canaryPassed, text: canaryText.slice(0, 500), at: new Date().toISOString() }
        : null,
    };
    writeFileSync(join(staging, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n", "utf8");

    if (existsSync(target)) {
      const retired = join(runtime.models, `.old-${modelDirName(name)}-${process.pid}`);
      rmSync(retired, { recursive: true, force: true });
      renameSync(target, retired);
      renameSync(staging, target);
      rmSync(retired, { recursive: true, force: true });
    } else {
      renameSync(staging, target);
    }

    return { name: manifest.name, path: target, manifest, catalog: catalogEntry ?? null, resumed };
  } catch (err) {
    // Keep the staging directory: a rerun resumes from the bytes already here.
    // Nothing is installed, because the model directory never appeared.
    throw err;
  }
}

function verifyFiles(path: string, info: RepoInfo): void {
  for (const file of info.files) {
    const target = join(path, file.name);
    if (!existsSync(target)) {
      throw integrityError(
        `model file ${file.name}`,
        "is missing after the download",
        "retry `ytx models add`; the partial download is kept",
      );
    }
    if (file.size !== null) {
      const actual = statSync(target).size;
      if (actual !== file.size) {
        throw integrityError(
          `model file ${file.name}`,
          `is ${actual} bytes but the hub says ${file.size}`,
          "delete the staging directory under `ytx models path` and retry",
        );
      }
    }
  }
}

export interface VerifyResult {
  name: string;
  path: string;
  ok: boolean;
  problems: string[];
}

export function verifyModel(runtime: RuntimePaths, name: string): VerifyResult {
  const path = join(runtime.models, modelDirName(name));
  const problems: string[] = [];
  if (!existsSync(path)) {
    return { name, path, ok: false, problems: ["model directory does not exist"] };
  }
  const manifest = readManifest(path);
  if (!manifest) {
    problems.push("manifest.json is missing or unreadable");
  } else {
    for (const file of manifest.files) {
      const target = join(path, file.name);
      if (!existsSync(target)) {
        problems.push(`${file.name} is missing`);
        continue;
      }
      if (file.size > 0) {
        const actual = statSync(target).size;
        if (actual !== file.size) problems.push(`${file.name} is ${actual} bytes, expected ${file.size}`);
      }
    }
  }
  if (!existsSync(join(path, "config.json"))) problems.push("config.json is missing");
  return { name, path, ok: problems.length === 0, problems };
}

export function removeModel(
  runtime: RuntimePaths,
  name: string,
  options: { defaultName: string; force?: boolean },
): { name: string; path: string; freed_bytes: number } {
  const dirName = modelDirName(name);
  const path = join(runtime.models, dirName);
  if (!existsSync(path)) {
    throw new YtxError({
      what: `model ${name}`,
      why: "is not installed",
      next: "`ytx models list` shows what is installed",
      code: 3,
      kind: "model-missing",
    });
  }
  if (dirName === modelDirName(options.defaultName)) {
    throw new YtxError({
      what: `model ${name}`,
      why: "is the default model, and removing it would break transcription",
      next: `switch first with \`ytx models default <other>\`, then retry`,
      code: 2,
      kind: "model-is-default",
    });
  }

  const readers = activeTranscriptions(runtime);
  if (readers.length > 0) {
    throw new YtxError({
      what: `model ${name}`,
      why: `is in use by a running transcription (pid ${readers.map((lock) => lock.pid).join(", ")})`,
      next: "wait for the transcription to finish, then retry",
      code: 3,
      kind: "model-busy",
    });
  }

  const lock = acquireLock(runtime.locks, "models", `ytx models rm ${name}`);
  try {
    const freed = directorySize(path);
    rmSync(path, { recursive: true, force: true });
    return { name: dirName, path, freed_bytes: freed };
  } finally {
    lock.release();
  }
}

/** Read locks held by running transcriptions, used to guard `models rm`. */
export function activeTranscriptions(runtime: RuntimePaths): { pid: number; owner: string }[] {
  const dir = runtime.locks;
  if (!existsSync(dir)) return [];
  const active: { pid: number; owner: string }[] = [];
  for (const file of readdirSync(dir)) {
    if (!/^models-read\..*\.lock$/.test(file)) continue;
    const info = readLock(join(dir, file));
    if (info && isLocked(dir, file.replace(/\.lock$/, ""))) {
      active.push({ pid: info.pid, owner: info.owner });
    }
  }
  return active;
}

/**
 * Claim a read lock for a transcription. Fails while an exclusive model
 * operation is running, so weights cannot disappear mid-run.
 */
export function beginTranscriptionRead(runtime: RuntimePaths, owner: string): LockHandle {
  const exclusive = isLocked(runtime.locks, "models");
  if (exclusive) {
    throw new YtxError({
      what: "transcription",
      why: `is blocked by \`${exclusive.owner}\` (pid ${exclusive.pid}) changing the model directory`,
      next: "wait for it to finish, then retry",
      code: 3,
      kind: "model-busy",
    });
  }
  return acquireLock(runtime.locks, `models-read.${process.pid}`, owner);
}

export function freeBytes(path: string): number | null {
  try {
    const stats = statfsSync(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

/** Staging directories a cancelled download left behind, for `prune`. */
export function stagingDirectories(runtime: RuntimePaths): string[] {
  if (!existsSync(runtime.models)) return [];
  return readdirSync(runtime.models)
    .filter((name) => name.startsWith(".tmp-") || name.startsWith(".old-"))
    .map((name) => join(runtime.models, name));
}

/** Convenience for callers that only know a repo string. */
export function catalogFor(repo: string): CatalogEntry | undefined {
  return catalogEntryForRepo(repo);
}

export function formatModelSummary(manifest: ModelManifest): string {
  return `${manifest.repo}@${manifest.revision.slice(0, 8)} (${formatBytes(manifest.total_bytes)})`;
}

export function modelManifestIssues(manifest: ModelManifest | null): string | null {
  if (!manifest) return "manifest.json is missing or unreadable";
  const parsed = ManifestSchema.safeParse(manifest);
  return parsed.success ? null : formatZodIssues(parsed.error);
}
