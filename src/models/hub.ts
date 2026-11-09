/**
 * Hub validation and model-file download.
 *
 * A custom repo is checked against the hub API before any bytes are pulled, so
 * the failure is specific: wrong name (404), gated or private (401/403), or a
 * repo that is not an MLX Whisper checkpoint at all. Downloads resume by byte
 * range, so a cancelled run restarts where it stopped instead of from zero.
 */

import { createWriteStream, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { EXIT, fetchError, YtxError } from "../core/errors.ts";
import { CATALOG, catalogEntryForRepo, parseRepoInput } from "./catalog.ts";

export interface HubFile {
  name: string;
  size: number | null;
}

export interface RepoInfo {
  repo: string;
  revision: string;
  files: HubFile[];
  total_bytes: number;
  /** True when the repo carries MLX weights and config. */
  mlx_whisper: boolean;
  /** Raw file names, for building a useful "not a checkpoint" message. */
  fileNames: string[];
}

const HF_API = "https://huggingface.co/api/models";

export async function fetchRepoInfo(repo: string): Promise<RepoInfo> {
  const url = `${HF_API}/${repo}?blobs=true`;
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (err) {
    throw fetchError(
      `model repo ${repo}`,
      `the hub could not be reached (${(err as Error).message})`,
      "check the network and retry `ytx models add`",
      "transient",
    );
  }

  if (response.status !== 200) {
    const body = await response.text().catch(() => "");
    // The hub answers 401 "Invalid username or password." for a repo that does
    // not exist AND for a private/gated one, so a 401 must never be reported as
    // a 404. Only a real 404 is a definite "not found".
    if (response.status === 404) {
      throw missingRepoError(repo, 404);
    }
    if (response.status === 401 || response.status === 403) {
      throw missingRepoError(repo, response.status);
    }
    throw fetchError(
      `model repo ${repo}`,
      `the hub answered HTTP ${response.status}${body === "" ? "" : ` (${body.slice(0, 120)})`}`,
      "retry `ytx models add` in a few minutes",
      "transient",
    );
  }

  const data = (await response.json()) as {
    sha?: string;
    gated?: boolean | string;
    private?: boolean;
    siblings?: { rfilename?: string; size?: number; lfs?: { size?: number } }[];
  };

  if (data.private === true) {
    throw gatedError(repo);
  }
  if (data.gated !== undefined && data.gated !== false) {
    throw gatedError(repo, typeof data.gated === "string" ? data.gated : "manual");
  }

  const files: HubFile[] = (data.siblings ?? [])
    .filter((sibling): sibling is { rfilename: string; size?: number; lfs?: { size?: number } } =>
      typeof sibling.rfilename === "string",
    )
    .map((sibling) => ({
      name: sibling.rfilename,
      size: sibling.lfs?.size ?? sibling.size ?? null,
    }))
    .filter((file) => isModelFile(file.name));

  const fileNames = files.map((file) => file.name);
  const total = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
  const hasConfig = fileNames.includes("config.json");
  const hasWeights = fileNames.some((name) => /^weights\.(npz|safetensors)$/i.test(name));

  return {
    repo,
    revision: data.sha ?? "main",
    files,
    total_bytes: total,
    mlx_whisper: hasConfig && hasWeights,
    fileNames: (data.siblings ?? []).map((sibling) => sibling.rfilename ?? "").filter(Boolean),
  };
}

/**
 * A 401 from the hub means one of two things and the response cannot tell them
 * apart: the repo does not exist, or it is private/gated. Say both, and give
 * the two concrete next steps rather than asserting a 404 that never happened.
 */
function missingRepoError(repo: string, status: number): YtxError {
  return new YtxError({
    what: `model repo ${repo}`,
    why:
      status === 404
        ? "was not found on the hub (HTTP 404)"
        : "is either not found or private/gated (HTTP 401)",
    next:
      status === 404
        ? "check the owner/repo spelling at https://huggingface.co/models?search=whisper"
        : "check the owner/repo spelling at https://huggingface.co/models?search=whisper; if the repo is gated, accept its terms and run `huggingface-cli login` (or set HF_TOKEN), then retry",
    code: EXIT.fetch,
    kind: "model-repo-missing",
  });
}

function gatedError(repo: string, mode = "manual"): YtxError {
  return new YtxError({
    what: `model repo ${repo}`,
    why: `is gated or private (access mode "${mode}")`,
    next: `accept the model's terms at https://huggingface.co/${repo}, run \`huggingface-cli login\` (or set HF_TOKEN), then retry; other checkpoints are listed at https://huggingface.co/models?search=whisper`,
    code: EXIT.fetch,
    kind: "model-repo-gated",
  });
}

function isModelFile(name: string): boolean {
  if (name === "config.json") return true;
  if (/^weights\.(npz|safetensors)$/i.test(name)) return true;
  return false;
}

/**
 * The message a valid-but-not-MLX repo gets. Naming the likely fix is the whole
 * point: "not a checkpoint" alone leaves the user guessing.
 */
export function notACheckpointError(repo: string, fileNames: readonly string[]): YtxError {
  const suggestion = suggestMlxRepo(repo);
  const looksPyTorch = fileNames.some((name) => /^(pytorch_model|model)\.(bin|safetensors)$/i.test(name));
  const looksGguf = fileNames.some((name) => name.endsWith(".gguf"));
  const why = looksPyTorch
    ? "is a PyTorch checkpoint; mlx-whisper cannot load it"
    : looksGguf
      ? "is a GGUF checkpoint; mlx-whisper cannot load it"
      : "has no config.json plus MLX weights (weights.npz or weights.safetensors)";

  return new YtxError({
    what: `model repo ${repo}`,
    why,
    next: `use ${suggestion} instead${catalogEntryForRepo(suggestion) ? ` (\`ytx models add ${catalogEntryForRepo(suggestion)?.name}\`)` : ` (\`ytx models add ${suggestion}\`)`}`,
    code: EXIT.fetch,
    kind: "model-repo-not-mlx",
  });
}

export function suggestMlxRepo(repo: string): string {
  const tail = (repo.split("/")[1] ?? repo).toLowerCase();
  const direct = CATALOG.find((entry) => tail.includes(entry.name.replace(/^.*\//, "")));
  if (direct) return direct.repo;

  // `openai/whisper-large-v3` -> `mlx-community/whisper-large-v3-mlx`
  const whisper = /^whisper-(.+)$/.exec(tail);
  if (whisper) return `mlx-community/whisper-${whisper[1]}-mlx`;
  return "mlx-community/whisper-large-v3-turbo";
}

export interface DownloadFileProgress {
  file: string;
  index: number;
  total: number;
  received: number;
  size: number | null;
}

/**
 * Download every model file into `destination`, resuming partial files by
 * requesting only the missing byte range.
 */
export async function downloadRepoFiles(
  info: RepoInfo,
  destination: string,
  options: { onProgress?: (progress: DownloadFileProgress) => void } = {},
): Promise<void> {
  mkdirSync(destination, { recursive: true });

  for (let index = 0; index < info.files.length; index += 1) {
    const file = info.files[index]!;
    const target = join(destination, file.name);
    await downloadOne(info, file, target, (received) =>
      options.onProgress?.({
        file: file.name,
        index,
        total: info.files.length,
        received,
        size: file.size,
      }),
    );
  }
}

async function downloadOne(
  info: RepoInfo,
  file: HubFile,
  target: string,
  onProgress: (received: number) => void,
): Promise<void> {
  let existing = 0;
  if (existsSync(target)) {
    existing = statSync(target).size;
    if (file.size !== null && existing === file.size) {
      onProgress(existing);
      return;
    }
    if (file.size !== null && existing > file.size) {
      rmSync(target, { force: true });
      existing = 0;
    }
  }

  const url = `https://huggingface.co/${info.repo}/resolve/${info.revision}/${file.name}`;
  const headers: Record<string, string> = {};
  if (existing > 0) headers.Range = `bytes=${existing}-`;
  const token = process.env.HF_TOKEN;
  if (token && token.trim() !== "") headers.Authorization = `Bearer ${token.trim()}`;

  let response: Response;
  try {
    response = await fetch(url, { headers, redirect: "follow" });
  } catch (err) {
    throw fetchError(
      `download ${info.repo}/${file.name}`,
      `the hub could not be reached (${(err as Error).message})`,
      "retry `ytx models add`; the partial file is kept so the download resumes",
      "transient",
    );
  }

  // A server that ignores Range answers 200 with the whole body; start over.
  if (response.status === 200 && existing > 0) existing = 0;
  if (!response.ok && response.status !== 206) {
    throw fetchError(
      `download ${info.repo}/${file.name}`,
      `the hub answered HTTP ${response.status}`,
      "retry `ytx models add`; the partial file is kept so the download resumes",
      "transient",
    );
  }
  if (!response.body) {
    throw fetchError(
      `download ${info.repo}/${file.name}`,
      "the hub sent an empty body",
      "retry `ytx models add`",
      "transient",
    );
  }

  const stream = createWriteStream(target, { flags: existing > 0 ? "a" : "w" });
  let received = existing;
  try {
    for await (const chunk of response.body) {
      await new Promise<void>((resolve, reject) => {
        stream.write(chunk, (err) => (err ? reject(err) : resolve()));
      });
      received += chunk.byteLength;
      onProgress(received);
    }
  } finally {
    await new Promise<void>((resolve) => stream.end(resolve));
  }

  if (file.size !== null && received !== file.size) {
    throw fetchError(
      `download ${info.repo}/${file.name}`,
      `expected ${file.size} bytes but received ${received}`,
      "retry `ytx models add`; the partial file is kept so the download resumes",
      "transient",
    );
  }
}

export { parseRepoInput };
