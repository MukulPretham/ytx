/**
 * Machine lifecycle: `setup`, `update`, `doctor`.
 *
 * Setup is idempotent and resumable: every step inspects what is already there
 * and only fills the gaps, and a component is either fully installed or absent.
 */

import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CANARY_URLS, defaultConfig, saveConfig } from "../core/config.ts";
import { EXIT, asYtxError, fetchError, YtxError } from "../core/errors.ts";
import { readAllMeta } from "../core/record.ts";
import { videoDir } from "../core/paths.ts";
import { saveState } from "../core/state.ts";
import { columns, formatBytes } from "../core/ui.ts";
import type { CommandContext, GlobalFlags } from "./context.ts";
import { failAfterEmit, resolveFfmpegPath } from "./context.ts";
import { effectiveDefault, listInstalled, verifyModel } from "../models/manager.ts";
import { modelDirName } from "../models/catalog.ts";
import { ensureVenv, findUv, installUv, uvVersionSync, venvStatus } from "../asr/venv.ts";
import { installYtdlp, rollbackYtdlp, ytdlpVersion } from "../ytdlp/binary.ts";
import { fetchInfo } from "../ytdlp/run.ts";
import { provenanceCounts } from "./render.ts";
import { runWizard, wizardDefaults, type WizardChoices } from "../wizard.ts";
import { addModel } from "../models/manager.ts";
import { runCanary } from "../asr/transcribe.ts";
import { acquireLock } from "../core/lock.ts";

/* ------------------------------------------------------------------ setup */

export interface SetupFlags {
  language?: string;
  model?: string;
  browser?: string;
  force: boolean;
}

export async function cmdSetup(
  context: CommandContext,
  flags: SetupFlags,
  global: GlobalFlags,
): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY) && !global.yes && !global.nonInteractive;
  const choices: WizardChoices = interactive
    ? await runWizard({ context, defaults: wizardDefaults(context) })
    : wizardDefaults(context, flags);

  if (!interactive && (flags.language || flags.model || flags.browser)) {
    context.ui.note("using the flags you passed; no prompt was shown");
  }

  const report = await applySetup(context, choices, flags.force);

  context.ui.emit({ choices: report.choices, steps: report.steps, doctor: report.doctor });
  if (!report.ok) {
    throw new YtxError({
      what: "setup",
      why: `${report.errors.length} step(s) failed`,
      next: report.errors[0]?.next ?? "read the messages above and rerun `ytx setup`",
      code: EXIT.fetch,
      kind: "setup-incomplete",
    });
  }
}

export interface SetupStep {
  name: string;
  status: "installed" | "present" | "skipped" | "failed";
  detail: string;
}

export interface SetupReport {
  ok: boolean;
  choices: WizardChoices;
  steps: SetupStep[];
  errors: YtxError[];
  doctor: DoctorReport;
}

export async function applySetup(
  context: CommandContext,
  choices: WizardChoices,
  force = false,
): Promise<SetupReport> {
  const steps: SetupStep[] = [];
  const errors: YtxError[] = [];
  const { ui } = context;

  mkdirSync(context.library.videos, { recursive: true });
  if (choices.library && choices.library !== context.library.root) {
    // The wizard can move the library; config and state follow the new path.
    const { resolveLibraryPaths } = await import("../core/paths.ts");
    context.library = resolveLibraryPaths({ env: process.env, cwd: process.cwd(), store: choices.library }).paths;
    mkdirSync(context.library.videos, { recursive: true });
  }

  const config = {
    ...defaultConfig(),
    ...context.config,
    language: choices.language,
    asr_model: choices.model,
    browser: choices.browser === "skip" ? "" : choices.browser,
    max_height: choices.maxHeight ?? context.config.max_height,
  };
  saveConfig(context.library, config);
  context.config = config;
  steps.push({ name: "config", status: "present", detail: context.library.config });

  // yt-dlp: always owned by ytx, in the runtime directory.
  try {
    const existing = await ytdlpVersion(context.runtime.ytdlp);
    if (existing !== null && !force) {
      steps.push({ name: "yt-dlp", status: "present", detail: existing });
      ui.ok(`yt-dlp ${existing} already installed`);
    } else {
      ui.note("installing yt-dlp…");
      const result = await installYtdlp(context.runtime, config.ytdlp_channel, {
        onProgress: (progress) => {
          ui.progress("  yt-dlp", progress.total ? progress.received / progress.total : null);
        },
      });
      ui.progressDone();
      context.state.ytdlp = {
        version: result.version,
        channel: config.ytdlp_channel,
        installed_at: new Date().toISOString(),
        previous_version: result.previous,
      };
      steps.push({ name: "yt-dlp", status: "installed", detail: result.version });
      ui.ok(`installed yt-dlp ${result.version}`);
    }
  } catch (err) {
    const error = asYtxError(err, "install yt-dlp", "check the network and rerun `ytx setup`");
    errors.push(error);
    steps.push({ name: "yt-dlp", status: "failed", detail: error.why });
    ui.fail(`yt-dlp: ${error.why}`);
  }

  // ffmpeg: PATH first, otherwise a static build into the runtime directory.
  try {
    const ffmpeg = await ensureFfmpeg(context);
    steps.push({ name: "ffmpeg", status: ffmpeg.status, detail: `${ffmpeg.version} (${ffmpeg.source})` });
    ui.ok(`ffmpeg ${ffmpeg.version} (${ffmpeg.source === "path" ? "on PATH" : context.runtime.ffmpeg})`);
  } catch (err) {
    const error = asYtxError(err, "install ffmpeg", "install ffmpeg yourself and rerun `ytx setup`");
    errors.push(error);
    steps.push({ name: "ffmpeg", status: "failed", detail: error.why });
    ui.fail(`ffmpeg: ${error.why}`);
  }

  // uv: needed only for transcription, but installing it early keeps `setup`
  // honest about what a machine can do.
  try {
    let uv = findUv(context.runtime);
    if (uv === null) {
      ui.note("installing uv…");
      uv = await installUv(context.runtime, (line) => ui.note(`  ${line}`));
      steps.push({ name: "uv", status: "installed", detail: join(context.runtime.bin, "uv") });
    } else {
      steps.push({ name: "uv", status: "present", detail: uv });
    }
    const version = uvVersionSync(uv);
    if (version) context.state.uv = { path: uv, version };
    ui.ok(`uv ${version ?? "installed"}`);
  } catch (err) {
    const error = asYtxError(err, "install uv", "install uv yourself and rerun `ytx setup`");
    errors.push(error);
    steps.push({ name: "uv", status: "failed", detail: error.why });
    ui.fail(`uv: ${error.why}`);
  }

  // Model + venv, unless transcription was declined.
  if (choices.model === "none") {
    steps.push({ name: "model", status: "skipped", detail: "transcription disabled" });
    steps.push({ name: "venv", status: "skipped", detail: "transcription disabled" });
  } else {
    const existingModel = listInstalled(context.runtime).find(
      (entry) => entry.name === modelDirName(choices.model),
    );
    if (existingModel && !force) {
      steps.push({ name: "model", status: "present", detail: existingModel.name });
      ui.ok(`model ${existingModel.name} already installed`);
    } else {
      try {
        ui.note(`installing model ${choices.model}…`);
        const added = await addModel(context.runtime, choices.model, {
          onUntested: (repo) =>
            ui.warn(`${repo} is not in the tested catalog; it will be canaried, but quality is unverified`),
          onProgress: (progress) => {
            ui.progress(`  ${progress.file}`, progress.size ? progress.received / progress.size : null);
          },
          canary: async (modelPath) => {
            ui.note("  running the canary transcription…");
            return runCanary({
              runtime: context.runtime,
              ffmpeg: context.ffmpeg,
              modelPath,
              modelName: choices.model,
              onLine: context.flags.debug ? (line) => ui.note(`    ${line}`) : undefined,
            });
          },
        });
        ui.progressDone();
        context.state.default_model = added.name;
        saveState(context.runtime.state, context.state);
        steps.push({ name: "model", status: "installed", detail: added.name });
        ui.ok(`installed model ${added.name} (${added.manifest.repo}@${added.manifest.revision.slice(0, 8)})`);
      } catch (err) {
        const error = asYtxError(err, `install model ${choices.model}`, "rerun `ytx setup` to resume");
        errors.push(error);
        steps.push({ name: "model", status: "failed", detail: error.why });
        ui.fail(`model: ${error.why}`);
      }
    }

    try {
      const venv = await ensureVenv(context.runtime, { force: force && choices.model !== "none" });
      context.state.venv = {
        python: venv.python,
        mlx_whisper: venv.mlx_whisper,
        created_at: new Date().toISOString(),
      };
      steps.push({ name: "venv", status: venv.created ? "installed" : "present", detail: `mlx-whisper ${venv.mlx_whisper}` });
      ui.ok(`transcription environment ready (mlx-whisper ${venv.mlx_whisper})`);
    } catch (err) {
      const error = asYtxError(err, "prepare the transcription environment", "rerun `ytx setup`");
      errors.push(error);
      steps.push({ name: "venv", status: "failed", detail: error.why });
      ui.fail(`venv: ${error.why}`);
    }
  }

  saveState(context.runtime.state, context.state);
  context.reload();

  const doctor = await doctorReport(context);
  if (!ui.json) printDoctor(context, doctor);

  return { ok: errors.length === 0, choices, steps, errors, doctor };
}

export interface FfmpegInfo {
  status: "present" | "installed";
  version: string;
  source: "path" | "download";
}

export async function ensureFfmpeg(context: CommandContext): Promise<FfmpegInfo> {
  const onPath = Bun.which("ffmpeg");
  if (onPath) {
    const version = await probeVersion(onPath);
    context.ffmpeg = onPath;
    context.state.ffmpeg = { path: onPath, version: version ?? "unknown", source: "path" };
    saveState(context.runtime.state, context.state);
    return { status: "present", version: version ?? "unknown", source: "path" };
  }

  if (existsSync(context.runtime.ffmpeg)) {
    const version = await probeVersion(context.runtime.ffmpeg);
    if (version) {
      context.state.ffmpeg = { path: context.runtime.ffmpeg, version, source: "download" };
      saveState(context.runtime.state, context.state);
      return { status: "present", version, source: "download" };
    }
  }

  const version = await downloadStaticFfmpeg(context.runtime);
  context.ffmpeg = resolveFfmpegPath(context.runtime);
  context.state.ffmpeg = { path: context.runtime.ffmpeg, version, source: "download" };
  saveState(context.runtime.state, context.state);
  return { status: "installed", version, source: "download" };
}

/**
 * Static builds are fetched from the ffmpeg-static release mirrors: they are the
 * only convenient redistributable macOS arm64 builds. ffprobe is fetched too
 * when available, because height reporting uses it.
 */
export async function downloadStaticFfmpeg(runtime: { bin: string; tmp: string; ffmpeg: string }): Promise<string> {
  const target = ffmpegStaticTarget();
  mkdirSync(runtime.bin, { recursive: true });
  mkdirSync(runtime.tmp, { recursive: true });

  const base = "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0";
  const ffmpegUrl = `${base}/ffmpeg-${target}`;
  const ffprobeUrl = `${base}/ffprobe-${target}`;

  await downloadTo(ffmpegUrl, runtime.ffmpeg);
  chmodSync(runtime.ffmpeg, 0o755);
  const version = await probeVersion(runtime.ffmpeg);
  if (!version) {
    rmSync(runtime.ffmpeg, { force: true });
    throw fetchError(
      "install ffmpeg",
      "the downloaded static build does not run on this machine",
      "install ffmpeg yourself (`brew install ffmpeg`) and rerun `ytx setup`",
    );
  }

  try {
    await downloadTo(ffprobeUrl, join(runtime.bin, "ffprobe"));
    chmodSync(join(runtime.bin, "ffprobe"), 0o755);
  } catch {
    // ffprobe is a nice-to-have: height reporting degrades gracefully without it.
  }
  return version;
}

async function downloadTo(url: string, dest: string): Promise<void> {
  const part = `${dest}.part`;
  rmSync(part, { force: true });
  let response: Response;
  try {
    response = await fetch(url, { redirect: "follow" });
  } catch (err) {
    throw fetchError("download a static build", (err as Error).message, "check the network and rerun `ytx setup`", "transient");
  }
  if (!response.ok || !response.body) {
    throw fetchError(
      "download a static build",
      `the release server answered HTTP ${response.status}`,
      "install the tool yourself and rerun `ytx setup`",
      "transient",
    );
  }
  const writer = Bun.file(part).writer();
  for await (const chunk of response.body) writer.write(chunk);
  await writer.end();
  renameSync(part, dest);
}

export function ffmpegStaticTarget(platform = process.platform, arch = process.arch): string {
  if (platform === "darwin") return arch === "arm64" ? "darwin-arm64" : "darwin-x64";
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : "linux-x64";
  if (platform === "win32") return "win32-x64";
  throw fetchError(`ffmpeg ${platform}/${arch}`, "no static build is published", "install ffmpeg yourself");
}

async function probeVersion(binary: string): Promise<string | null> {
  const { run } = await import("../core/exec.ts");
  const result = await run(binary, ["-version"], { timeoutMs: 20_000 });
  if (result.code !== 0) return null;
  const first = result.stdout.split("\n")[0] ?? "";
  const match = /ffmpeg version (\S+)/.exec(first);
  return match?.[1] ?? first.trim() ?? null;
}

/* ----------------------------------------------------------------- update */

export interface UpdateFlags {
  check: boolean;
  nightly: boolean;
  force: boolean;
  all: boolean;
  rollback: boolean;
}

export async function cmdUpdate(context: CommandContext, flags: UpdateFlags): Promise<void> {
  const channel = flags.nightly ? "nightly" : context.config.ytdlp_channel;
  const installed = await ytdlpVersion(context.runtime.ytdlp);

  if (flags.rollback) {
    const result = await rollbackYtdlp(context.runtime);
    context.state.ytdlp = context.state.ytdlp
      ? { ...context.state.ytdlp, version: result.version, previous_version: result.previous, installed_at: new Date().toISOString() }
      : { version: result.version, channel, installed_at: new Date().toISOString(), previous_version: result.previous };
    saveState(context.runtime.state, context.state);
    context.ui.ok(`rolled back to yt-dlp ${result.version}`);
    if (result.previous) context.ui.line(`  ${result.previous} is kept in bin/yt-dlp.prev`);
    context.ui.emit({ action: "rollback", version: result.version, previous: result.previous });
    return;
  }

  if (flags.check) {
    const latest = await latestVersion(channel);
    const outdated = installed !== latest;
    context.ui.line(`installed  ${installed ?? "none"}`);
    context.ui.line(`latest     ${latest ?? "unknown"} (${channel})`);
    context.ui.line(outdated ? "status     an update is available" : "status     up to date");
    context.ui.emit({ action: "check", channel, installed, latest, outdated });
    return;
  }

  const canaryUrls = context.config.canary_urls.length > 0 ? context.config.canary_urls : [...DEFAULT_CANARY_URLS];
  const lock = acquireLock(context.runtime.locks, "ytdlp", "ytx update");
  try {
    context.ui.note(`downloading yt-dlp (${channel})…`);
    const result = await installYtdlp(context.runtime, channel, {
      onProgress: (progress) => {
        context.ui.progress("  yt-dlp", progress.total ? progress.received / progress.total : null);
      },
      canary: flags.force
        ? undefined
        : async (staged, version) => {
            context.ui.note(`canarying yt-dlp ${version} against ${canaryUrls.length} reference video(s)…`);
            for (const url of canaryUrls) {
              try {
                const info = await fetchInfo(url, { binary: staged });
                if (!info.info.id) throw new Error("no video id in the metadata response");
                context.ui.note(`  ✓ ${url}`);
              } catch (err) {
                throw new YtxError({
                  what: "yt-dlp canary",
                  why: `${url} failed: ${(err as Error).message}`,
                  next: "the working binary was kept; retry with `ytx update`, or `--force` to skip the canary",
                  code: EXIT.fetch,
                  kind: "canary-failed",
                });
              }
            }
          },
    });

    context.ui.progressDone();
    context.state.ytdlp = {
      version: result.version,
      channel,
      installed_at: new Date().toISOString(),
      previous_version: result.previous,
    };
    saveState(context.runtime.state, context.state);

    context.ui.ok(`yt-dlp ${installed ?? "none"} → ${result.version}`);
    if (result.previous) context.ui.line(`  previous ${result.previous} kept at bin/yt-dlp.prev`);
    if (flags.force) context.ui.warn("the canary was skipped because --force was passed");

    if (flags.all) {
      context.ui.note("refreshing the transcription environment…");
      const venv = await ensureVenv(context.runtime, { force: true, onLine: context.flags.debug ? (line) => context.ui.note(`  ${line}`) : undefined });
      context.state.venv = { python: venv.python, mlx_whisper: venv.mlx_whisper, created_at: new Date().toISOString() };
      saveState(context.runtime.state, context.state);
      context.ui.ok(`transcription environment rebuilt (mlx-whisper ${venv.mlx_whisper})`);
    }

    context.ui.emit({
      action: "update",
      channel,
      from: installed,
      to: result.version,
      previous: result.previous,
      venv_refreshed: flags.all,
    });
  } catch (err) {
    const error = asYtxError(err, "update yt-dlp", "the working binary is untouched; retry `ytx update`");
    if (error.kind === "canary-failed") {
      throw new YtxError({
        what: "update yt-dlp",
        why: `the canary failed, so the working binary was kept: ${error.why}`,
        next: "retry `ytx update`; if the canary keeps failing, run `ytx update --force` and check `--check`",
        code: EXIT.fetch,
        kind: "canary-failed",
      });
    }
    throw error;
  } finally {
    lock.release();
  }
}

export async function latestVersion(channel: "stable" | "nightly"): Promise<string | null> {
  const repo = channel === "nightly" ? "yt-dlp/yt-dlp-nightly-builds" : "yt-dlp/yt-dlp";
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "ytx" },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { tag_name?: string };
    return data.tag_name ?? null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- doctor */

export interface DoctorCheck {
  group: string;
  name: string;
  ok: boolean;
  detail: string;
  fix: string | null;
}

export interface DoctorReport {
  runtime: string;
  library: string;
  library_origin: string;
  checks: DoctorCheck[];
  problems: { name: string; detail: string; fix: string | null }[];
  videos: number;
  provenance: Record<string, number>;
  queue: number;
  models: { name: string; default: boolean; ok: boolean; detail: string }[];
}

export async function doctorReport(context: CommandContext): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const push = (group: string, name: string, ok: boolean, detail: string, fix: string | null = null) => {
    checks.push({ group, name, ok, detail, fix });
  };

  // Dependencies
  const version = await ytdlpVersion(context.runtime.ytdlp);
  push(
    "dependencies",
    "yt-dlp",
    version !== null,
    version ? `${version} (${context.runtime.ytdlp})` : "not installed",
    version ? null : "run `ytx setup`",
  );

  const ffmpegPath = resolveFfmpegPath(context.runtime);
  const ffmpegVersion = existsSync(ffmpegPath) ? await probeVersion(ffmpegPath) : null;
  push(
    "dependencies",
    "ffmpeg",
    ffmpegVersion !== null,
    ffmpegVersion ? `${ffmpegVersion} (${ffmpegPath})` : "not installed",
    ffmpegVersion ? null : "run `ytx setup`",
  );

  const uv = findUv(context.runtime);
  push(
    "dependencies",
    "uv",
    uv !== null,
    uvVersionSync(uv) ?? (uv ? uv : "not installed"),
    uv ? null : "run `ytx setup`",
  );

  const venv = await venvStatus(context.runtime);
  push(
    "dependencies",
    "mlx-whisper venv",
    venv.ready,
    venv.ready ? `${venv.mlx_whisper} (${venv.python})` : (venv.reason ?? "not ready"),
    venv.ready ? null : "run `ytx setup`, or `ytx update --all` to rebuild it",
  );

  // Config
  try {
    push("library", "config.toml", true, context.library.config);
  } catch (err) {
    push("library", "config.toml", false, (err as Error).message, "delete it and run `ytx setup`");
  }

  // Models
  const installed = listInstalled(context.runtime);
  const defaultName = effectiveDefault(context.state.default_model);
  const modelRows: DoctorReport["models"] = [];
  for (const model of installed) {
    const verification = verifyModel(context.runtime, model.name);
    const isDefault = model.name === defaultName;
    modelRows.push({
      name: model.name,
      default: isDefault,
      ok: verification.ok,
      detail: verification.ok
        ? `${formatBytes(model.total_bytes)} · ${model.manifest ? `${model.manifest.repo}@${model.manifest.revision.slice(0, 8)}` : "no manifest"}`
        : verification.problems.join("; "),
    });
    push(
      "models",
      model.name,
      verification.ok,
      verification.ok ? `${formatBytes(model.total_bytes)}${isDefault ? " · default" : ""}` : verification.problems.join("; "),
      verification.ok ? null : "reinstall with `ytx models add`, or remove with `ytx models rm`",
    );
  }
  if (installed.length === 0) {
    push(
      "models",
      "installed models",
      context.config.asr_model === "none",
      context.config.asr_model === "none" ? "none needed (asr_model = none)" : "none installed",
      context.config.asr_model === "none" ? null : "run `ytx models add turbo`",
    );
  } else if (!installed.some((model) => model.name === modelDirName(defaultName))) {
    push(
      "models",
      "default model",
      false,
      `${defaultName} is not installed`,
      `run \`ytx models add ${defaultName}\`, or \`ytx models default <installed name>\``,
    );
  }

  // Library contents
  const { records, broken } = readAllMeta(context.library);
  const counts = provenanceCounts(records);
  push("library", "records", broken.length === 0, `${records.length} valid, ${broken.length} broken`);
  for (const entry of broken) {
    push("library", `record ${entry.id}`, false, entry.error.why, entry.error.next);
  }

  let missingFiles = 0;
  for (const record of records) {
    const dir = videoDir(context.library, record.id);
    const missing = [record.media.video, record.media.audio, record.media.mp3].filter(
      (name): name is string => typeof name === "string" && !existsSync(join(dir, name)),
    );
    if (missing.length === 0) continue;
    missingFiles += 1;
    push(
      "library",
      `media ${record.id}`,
      false,
      `missing ${missing.join(", ")}`,
      `re-add with \`ytx add --force ${record.url}\`, or \`ytx retry\` if it is queued`,
    );
  }
  if (records.length > 0 && missingFiles === 0) {
    push("library", "media files", true, "every recorded media file is present");
  }

  const queueEntries = existsSync(context.library.queue)
    ? (await import("../core/queue.ts")).readQueue(context.library)
    : [];
  push("library", "queue", true, queueEntries.length === 0 ? "empty" : `${queueEntries.length} pending retry`);

  push(
    "library",
    "provenance",
    true,
    `H ${counts["caption-human"]} · A ${counts["caption-auto"]} · M ${counts.asr}`,
  );

  const problems = checks.filter((check) => !check.ok).map((check) => ({
    name: `${check.group}/${check.name}`,
    detail: check.detail,
    fix: check.fix,
  }));

  return {
    runtime: context.runtime.root,
    library: context.library.root,
    library_origin: context.paths.libraryOrigin,
    checks,
    problems,
    videos: records.length,
    provenance: counts,
    queue: queueEntries.length,
    models: modelRows,
  };
}

export function printDoctor(context: CommandContext, report: DoctorReport): void {
  const { ui } = context;
  ui.heading("ytx doctor");
  ui.line(`runtime  ${report.runtime}`);
  ui.line(`library  ${report.library}  ${ui.dim(`(${report.library_origin})`)}`);
  ui.line("");

  const groups = [...new Set(report.checks.map((check) => check.group))];
  for (const group of groups) {
    ui.line(ui.bold(group));
    const rows = report.checks
      .filter((check) => check.group === group)
      .map((check) => [`  ${check.ok ? ui.cyan("✓") : ui.dim("✗")} ${check.name}`, check.detail]);
    ui.line(columns(rows).join("\n"));
  }

  const counts = report.provenance as Record<string, number>;
  ui.line("");
  ui.line(
    `videos ${report.videos} · human ${counts["caption-human"] ?? 0} · machine-caption ${counts["caption-auto"] ?? 0} · local-asr ${counts.asr ?? 0} · queue ${report.queue}`,
  );

  if (report.problems.length === 0) {
    ui.ok("no problems found");
    return;
  }

  ui.line("");
  ui.warn(`${report.problems.length} problem(s)`);
  for (const problem of report.problems) {
    ui.line(`  ${ui.bold(problem.name)}: ${problem.detail}`);
    if (problem.fix) ui.line(`    next: ${problem.fix}`);
  }
}

export async function cmdDoctor(context: CommandContext): Promise<void> {
  const report = await doctorReport(context);
  if (!context.flags.json) printDoctor(context, report);

  // Broken records and missing media files are both store integrity problems.
  const brokenRecords = report.problems.filter(
    (problem) => problem.name.startsWith("library/record ") || problem.name.startsWith("library/media "),
  );
  if (brokenRecords.length > 0) {
    failAfterEmit(context, { ...report }, new YtxError({
      what: "doctor",
      why: `${brokenRecords.length} integrity problem(s) in the library`,
      next: "fix or re-add the records named above; `ytx list --json` still shows the valid ones",
      code: EXIT.integrity,
      kind: "integrity",
    }));
  }

  const fatal = report.problems.some((problem) =>
    /^dependencies\/|^models\/|^library\/config/.test(problem.name),
  );
  if (fatal) {
    failAfterEmit(context, { ...report }, new YtxError({
      what: "doctor",
      why: "a required component is missing",
      next: report.problems[0]?.fix ?? "run `ytx setup`",
      code: EXIT.fetch,
      kind: "dependency",
    }));
  }
  context.ui.emit(report);
}
