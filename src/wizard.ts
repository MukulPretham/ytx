/**
 * The first-run wizard.
 *
 * Six questions, in a fixed order, each with a default so plain Enter is a
 * valid path. Nothing is installed while asking: the summary is the last chance
 * to change your mind, and Ctrl-C at any point exits 130 leaving whatever was
 * already installed intact.
 */

import { intro, isCancel, log, note, outro, select, text } from "@clack/prompts";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { YtxError } from "./core/errors.ts";
import { defaultExportDir, toConfigPath } from "./core/paths.ts";
import { askExportDir } from "./prompts.ts";
import { CATALOG, parseRepoInput } from "./models/catalog.ts";
import { fetchRepoInfo, notACheckpointError } from "./models/hub.ts";
import { formatBytes } from "./core/ui.ts";
import type { CommandContext } from "./commands/context.ts";

export interface WizardChoices {
  library: string;
  /** Where `ytx format` writes; "" means the first format asks. */
  exportDir: string;
  language: string;
  /** "none", a catalog name, or an explicit `owner/repo`. */
  model: string;
  /** Browser name, or "skip". */
  browser: string;
  maxHeight: number;
}

const LANGUAGES: { value: string; label: string; hint: string }[] = [
  { value: "en", label: "English", hint: "en" },
  { value: "hi", label: "Hindi", hint: "hi" },
  { value: "es", label: "Spanish", hint: "es" },
  { value: "fr", label: "French", hint: "fr" },
  { value: "de", label: "German", hint: "de" },
  { value: "ja", label: "Japanese", hint: "ja" },
  { value: "auto", label: "Auto-detect", hint: "use each video's original language" },
  { value: "__other__", label: "Other", hint: "type a language code" },
];

const BROWSERS = [
  { value: "chrome", label: "Chrome", hint: "reads its cookie store" },
  { value: "safari", label: "Safari", hint: "macOS only" },
  { value: "firefox", label: "Firefox", hint: "" },
  { value: "edge", label: "Edge", hint: "" },
  { value: "brave", label: "Brave", hint: "" },
  { value: "skip", label: "Skip", hint: "no cookies; some videos may hit a bot check" },
];

export interface WizardOverrides {
  language?: string;
  model?: string;
  browser?: string;
  exportDir?: string;
}

export function wizardDefaults(
  context: CommandContext,
  overrides: WizardOverrides = {},
): WizardChoices {
  return {
    library: context.library.root,
    exportDir: overrides.exportDir ?? context.config.export_dir,
    language: overrides.language || context.config.language || "en",
    // A3: no model unless the user asks for one. Plain Enter must not pull
    // 1.5 GB of weights.
    model: overrides.model || context.config.asr_model || "none",
    // An empty browser means "skip"; "" must not become a selected option.
    browser: overrides.browser || context.config.browser || "skip",
    maxHeight: context.config.max_height,
  };
}

export async function runWizard(input: {
  context: CommandContext;
  defaults: WizardChoices;
}): Promise<WizardChoices> {
  const { context, defaults } = input;
  const ui = context.ui;

  intro("ytx setup");

  const choices: WizardChoices = { ...defaults };

  // 1. Library location
  const library = cancelGuard(
    await text({
      message: "Where should the library live?",
      initialValue: defaults.library,
      placeholder: defaults.library,
      validate: (value) => {
        if (!value || value.trim() === "") return "enter a path";
        return undefined;
      },
    }),
    context,
  );
  choices.library = library.trim();

  // 2. Export folder. The suggested value is created and saved only when the
  // answer is accepted; a library configured by an older build starts empty and
  // lets `ytx format` ask instead, so setup does not force a choice here.
  const suggestedExport =
    defaults.exportDir !== ""
      ? defaults.exportDir
      : toConfigPath(defaultExportDir(homedir()), homedir());
  const exported = await askExportDir(suggestedExport);
  if (exported === null) cancelSetup(context);
  choices.exportDir = exported;

  // 3. Preferred language
  const language = cancelGuard(
    await select({
      message: "Preferred caption language?",
      initialValue: defaults.language,
      options: LANGUAGES.map((entry) => ({
        value: entry.value,
        label: entry.value === "__other__" ? entry.label : `${entry.label} (${entry.hint})`,
        hint: entry.value === "__other__" ? entry.hint : "",
      })),
    }),
    context,
  );
  if (language === "__other__") {
    const other = cancelGuard(
      await text({
        message: "Language code (for example sv, pt-BR, ko)",
        initialValue: defaults.language === "auto" ? "" : defaults.language,
        validate: (value) =>
          value && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})?$/.test(value.trim())
            ? undefined
            : "enter a language code such as sv or pt-BR",
      }),
      context,
    );
    choices.language = other.trim();
  } else {
    choices.language = String(language);
  }

  // 4. Transcription model
  const modelChoice = cancelGuard(
    await select({
      message: "Which transcription model?",
      initialValue: defaults.model,
      options: [
        { value: "none", label: "None", hint: "captions only; faster setup, no local transcription" },
        ...CATALOG.map((entry) => ({
          value: entry.name,
          label: `${entry.name}  ${formatMb(entry.size_mb)}${entry.default ? "  (recommended)" : ""}`,
          hint: entry.note,
        })),
        { value: "custom", label: "Custom repo", hint: "any MLX Whisper checkpoint on the hub" },
      ],
    }),
    context,
  );

  if (modelChoice === "custom") {
    choices.model = await askCustomRepo(context);
  } else {
    choices.model = String(modelChoice);
  }

  // 5. Browser for cookies
  const browser = cancelGuard(
    await select({
      message: "Read cookies from a signed-in browser? (helps with bot checks)",
      initialValue: defaults.browser,
      options: BROWSERS.map((entry) => ({ value: entry.value, label: entry.label, hint: entry.hint })),
    }),
    context,
  );
  choices.browser = String(browser);

  // 6. Summary + confirm
  const modelEntry = CATALOG.find((entry) => entry.name === choices.model);
  const customSize = modelEntry ? 0 : await customRepoSize(choices.model);
  const modelBytes = modelEntry ? modelEntry.size_mb * 1_000_000 : customSize;
  const transcriptionBytes = choices.model === "none" ? 0 : 60 * 1_000_000; // mlx-whisper + deps
  const ytdlpBytes = 38 * 1_000_000;
  const total = modelBytes + transcriptionBytes + ytdlpBytes;

  note(
    [
      `library      ${choices.library}`,
      `formats      ${choices.exportDir === "" ? "not set (the first ytx format asks)" : choices.exportDir}`,
      `language     ${choices.language === "auto" ? "auto-detect (each video's original)" : choices.language}`,
      `model        ${choices.model}${modelEntry ? `  ${formatMb(modelEntry.size_mb)}` : ""}`,
      `browser      ${choices.browser === "skip" ? "skipped" : choices.browser}`,
      "",
      `downloads    about ${formatBytes(total)} total (yt-dlp ${formatBytes(ytdlpBytes)}${choices.model === "none" ? "" : `, model ${formatBytes(modelBytes)}, transcription deps ${formatBytes(transcriptionBytes)}`})`,
    ].join("\n"),
    "Summary",
  );

  const confirmed = cancelGuard(
    await select({
      message: "Proceed?",
      initialValue: "yes",
      options: [
        { value: "yes", label: "Install", hint: "writes config.toml and installs what is missing" },
        { value: "no", label: "Cancel", hint: "nothing is installed" },
      ],
    }),
    context,
  );

  if (confirmed !== "yes") {
    outro("cancelled; nothing was installed");
    throw new YtxError({
      what: "setup",
      why: "cancelled at the confirmation step",
      next: "run `ytx setup` again when you are ready",
      code: 130,
      kind: "cancelled",
    });
  }

  outro("installing");
  ui.note("  every step below is idempotent: rerunning `ytx setup` resumes where this stopped");
  return choices;
}

async function askCustomRepo(context: CommandContext): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = cancelGuard(
      await text({
        message: "Model repo (owner/repo, hf.co/owner/repo, or a full hub URL)",
        placeholder: "mlx-community/whisper-large-v3-turbo",
        validate: (value) => (parseRepoInput(String(value ?? "")) ? undefined : "not a hub repo"),
      }),
      context,
    );
    const repo = parseRepoInput(String(answer));
    if (!repo) {
      log.error("that is not a hub repo; expected owner/repo");
      continue;
    }
    try {
      const info = await fetchRepoInfo(repo);
      if (!info.mlx_whisper) {
        const error = notACheckpointError(repo, info.fileNames);
        log.error(`${error.why}. next: ${error.next}`);
        continue;
      }
      log.success(`${repo} looks like an MLX Whisper checkpoint (${formatBytes(info.total_bytes)})`);
      return repo;
    } catch (err) {
      const error = err as YtxError;
      log.error(`${error.why ?? (err as Error).message}${error.next ? `. next: ${error.next}` : ""}`);
    }
  }
  throw new YtxError({
    what: "setup",
    why: "no usable model repo was provided after three attempts",
    next: "run `ytx setup` again, or pick a catalog model",
    code: 130,
    kind: "cancelled",
  });
}

async function customRepoSize(repo: string): Promise<number> {
  if (repo === "none" || CATALOG.some((entry) => entry.name === repo)) return 0;
  try {
    const info = await fetchRepoInfo(repo);
    return info.total_bytes;
  } catch {
    return 0;
  }
}

function cancelSetup(context: CommandContext): never {
  // Ctrl-C: drop scratch space, keep anything already installed.
  rmSync(context.runtime.tmp, { recursive: true, force: true });
  throw new YtxError({
    what: "setup",
    why: "interrupted with Ctrl-C",
    next: "completed components were kept; rerun `ytx setup` to resume",
    code: 130,
    kind: "cancelled",
  });
}

function cancelGuard<T>(value: T | symbol, context: CommandContext): T {
  if (isCancel(value)) cancelSetup(context);
  return value as T;
}

function formatMb(mb: number): string {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
}
