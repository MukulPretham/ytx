/**
 * The transcription environment.
 *
 * mlx-whisper is a Python package and stays one: this process never imports
 * Python. A `uv`-managed venv lives in the runtime directory, and transcription
 * is a subprocess call with an explicit local model path, so a machine with
 * installed weights needs no network.
 */

import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fetchError, YtxError } from "../core/errors.ts";
import { lastLines, run } from "../core/exec.ts";
import type { RuntimePaths } from "../core/paths.ts";

export const VENV_PYTHON_VERSION = "3.12";
export const MLX_WHISPER_PACKAGE = "mlx-whisper";

export interface VenvStatus {
  ready: boolean;
  python: string | null;
  mlx_whisper: string | null;
  reason: string | null;
}

export interface EnsureVenvOptions {
  onLine?: (line: string) => void;
  /** Recreate the venv even when it already works. */
  force?: boolean;
}

/** Probe an existing venv without network access. */
export async function venvStatus(runtime: RuntimePaths): Promise<VenvStatus> {
  const python = runtime.venvPython;
  if (!existsSync(python)) {
    return { ready: false, python: null, mlx_whisper: null, reason: "venv is not created" };
  }
  const probe = await run(python, ["-c", PROBE_SCRIPT], { timeoutMs: 120_000 });
  if (probe.code !== 0) {
    return {
      ready: false,
      python,
      mlx_whisper: null,
      reason: (lastLines(probe.stderr, 2) || "mlx-whisper is not importable").split("\n")[0] ?? "broken venv",
    };
  }
  const version = probe.stdout.trim().split("\n").pop() ?? "";
  if (version === "MISSING" || version === "") {
    return { ready: false, python, mlx_whisper: null, reason: "mlx-whisper is not installed" };
  }
  return { ready: true, python, mlx_whisper: version, reason: null };
}

const PROBE_SCRIPT = [
  "import importlib.metadata as m, sys",
  "try:",
  "    import mlx_whisper  # noqa: F401",
  "except Exception:",
  "    print('MISSING'); sys.exit(0)",
  "print(m.version('mlx-whisper'))",
].join("\n");

export function findUv(runtime: RuntimePaths): string | null {
  const owned = join(runtime.bin, "uv");
  if (existsSync(owned)) return owned;
  return Bun.which("uv");
}

export function uvVersionSync(uv: string | null): string | null {
  if (!uv) return null;
  const result = Bun.spawnSync([uv, "--version"]);
  if (result.exitCode !== 0) return null;
  const line = new TextDecoder().decode(result.stdout).trim().split("\n")[0] ?? "";
  // `uv --version` prints "uv 0.11.23 (hash date arch)"; keep just the version.
  const match = /^uv (\S+)/.exec(line);
  return match?.[1] ?? (line === "" ? null : line);
}

/**
 * `ytx setup` uses this when no `uv` is on PATH: fetch the standalone build into
 * the runtime directory, because `ytx` must not depend on a package manager.
 */
export async function installUv(runtime: RuntimePaths, onLine?: (line: string) => void): Promise<string> {
  const asset = uvAssetName();
  const url = `https://github.com/astral-sh/uv/releases/latest/download/${asset}`;
  const archive = join(runtime.tmp, asset);
  mkdirSync(runtime.tmp, { recursive: true });
  mkdirSync(runtime.bin, { recursive: true });

  const part = `${archive}.part`;
  rmSync(part, { force: true });
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (err) {
    throw fetchError(
      "install uv",
      `the release could not be reached (${(err as Error).message})`,
      "install uv yourself (`brew install uv`, `pipx install uv`) and rerun `ytx setup`",
      "transient",
    );
  }
  if (!response.ok || !response.body) {
    throw fetchError(
      "install uv",
      `the release server answered HTTP ${response.status}`,
      "install uv yourself (`brew install uv`, `pipx install uv`) and rerun `ytx setup`",
      "transient",
    );
  }
  const writer = Bun.file(part).writer();
  for await (const chunk of response.body) writer.write(chunk);
  await writer.end();
  renameSync(part, archive);

  const extracted = join(runtime.tmp, "uv-extract");
  rmSync(extracted, { recursive: true, force: true });
  mkdirSync(extracted, { recursive: true });
  const untar = await run("tar", ["-xzf", archive, "-C", extracted], { timeoutMs: 120_000 });
  if (untar.code !== 0) {
    throw fetchError(
      "install uv",
      `the downloaded archive could not be extracted (${lastLines(untar.stderr, 2)})`,
      "install uv yourself and rerun `ytx setup`",
    );
  }
  const candidate = join(extracted, "uv-" + asset.replace(/\.tar\.gz$/, ""), "uv");
  const binary = existsSync(candidate) ? candidate : findFile(extracted, "uv");
  if (!binary) {
    throw fetchError(
      "install uv",
      "the archive did not contain a uv binary",
      "install uv yourself and rerun `ytx setup`",
    );
  }
  renameSync(binary, runtime.bin + "/uv");
  chmodSync(join(runtime.bin, "uv"), 0o755);
  rmSync(extracted, { recursive: true, force: true });
  rmSync(archive, { force: true });
  onLine?.(`installed uv at ${join(runtime.bin, "uv")}`);
  return join(runtime.bin, "uv");
}

export function uvAssetName(platform = process.platform, arch = process.arch): string {
  if (platform === "darwin") {
    return arch === "arm64" ? "uv-aarch64-apple-darwin.tar.gz" : "uv-x86_64-apple-darwin.tar.gz";
  }
  if (platform === "linux") {
    return arch === "arm64" ? "uv-aarch64-unknown-linux-gnu.tar.gz" : "uv-x86_64-unknown-linux-gnu.tar.gz";
  }
  throw fetchError(
    `uv ${platform}/${arch}`,
    "no standalone build is published for this platform",
    "install uv yourself and rerun `ytx setup`",
  );
}

/** Create or repair the venv. Idempotent: a working venv is left alone. */
export async function ensureVenv(
  runtime: RuntimePaths,
  options: EnsureVenvOptions = {},
): Promise<{ python: string; mlx_whisper: string; created: boolean }> {
  const existing = await venvStatus(runtime);
  if (existing.ready && !options.force) {
    return { python: existing.python!, mlx_whisper: existing.mlx_whisper!, created: false };
  }

  const uv = findUv(runtime);
  if (!uv) {
    throw new YtxError({
      what: "transcription environment",
      why: "uv is not installed, so the venv cannot be managed",
      next: "run `ytx setup` to install uv, or install it yourself",
      code: 3,
      kind: "dependency",
    });
  }

  mkdirSync(runtime.root, { recursive: true });

  if (options.force && existsSync(runtime.venv)) {
    // Build beside the old venv, then swap, so an interrupted rebuild leaves a
    // working transcription environment in place.
    const staging = `${runtime.venv}.new-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    await createVenv(uv, staging, options);
    const retired = `${runtime.venv}.old-${process.pid}`;
    rmSync(retired, { recursive: true, force: true });
    if (existsSync(runtime.venv)) renameSync(runtime.venv, retired);
    renameSync(staging, runtime.venv);
    rmSync(retired, { recursive: true, force: true });
  } else if (!existsSync(runtime.venv) || !existing.ready) {
    await createVenv(uv, runtime.venv, options);
  }

  const status = await venvStatus(runtime);
  if (!status.ready) {
    throw new YtxError({
      what: "transcription environment",
      why: `the venv is still not usable (${status.reason})`,
      next: "run `ytx update --all` to rebuild it, or `ytx setup --force`",
      code: 3,
      kind: "dependency",
    });
  }
  return { python: status.python!, mlx_whisper: status.mlx_whisper!, created: true };
}

async function createVenv(uv: string, target: string, options: EnsureVenvOptions): Promise<void> {
  rmSync(target, { recursive: true, force: true });
  const venv = await run(uv, ["venv", "--python", VENV_PYTHON_VERSION, target], {
    timeoutMs: 10 * 60_000,
    onStderrLine: options.onLine,
    onStdoutLine: options.onLine,
  });
  if (venv.code !== 0) {
    throw fetchError(
      "create the transcription venv",
      lastLines(venv.stderr || venv.stdout, 6) || `uv exited ${venv.code}`,
      "run `ytx setup`; if uv cannot fetch Python 3.12, install it and retry",
    );
  }

  const python = join(target, "bin", "python");
  const install = await run(
    uv,
    ["pip", "install", "--python", python, "--upgrade", MLX_WHISPER_PACKAGE],
    {
      timeoutMs: 30 * 60_000,
      onStderrLine: options.onLine,
      onStdoutLine: options.onLine,
    },
  );
  if (install.code !== 0) {
    rmSync(target, { recursive: true, force: true });
    throw fetchError(
      "install mlx-whisper",
      lastLines(install.stderr || install.stdout, 6) || `uv exited ${install.code}`,
      "check the network and rerun `ytx setup`; the half-built venv was removed",
    );
  }
}

function findFile(directory: string, name: string): string | null {
  for (const entry of new Bun.Glob(`**/${name}`).scanSync(directory)) {
    const path = join(directory, entry);
    if (existsSync(path)) return path;
  }
  return null;
}
