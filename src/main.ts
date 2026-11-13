#!/usr/bin/env bun
/**
 * ytx — archive YouTube videos with their transcripts.
 *
 * Flag parsing uses Bun's `util.parseArgs`, so there is no CLI framework
 * dependency. Exit codes are the contract: 0 ok, 2 usage, 3 fetch or dependency
 * failure, 4 no transcript obtainable, 5 quality gate failed, 6 store integrity.
 */

import { parseArgs } from "node:util";
import { EXIT, SilentExit, YtxError, usageError } from "./core/errors.ts";
import { buildContext, type GlobalFlags, type CommandContext } from "./commands/context.ts";
import {
  cmdAdd,
  cmdInit,
  cmdList,
  cmdPrune,
  cmdRetry,
  cmdRm,
  cmdSearch,
  cmdShow,
  cmdSync,
  cmdTranscript,
  provenanceFilter,
  type AddFlags,
} from "./commands/library.ts";
import { cmdImport, type ImportFlags } from "./commands/import.ts";
import { cmdFormat } from "./commands/format.ts";
import { parseTranscriptFormat } from "./commands/render.ts";
import { cmdModels } from "./commands/models.ts";
import { cmdDoctor, cmdSetup, cmdUpdate } from "./commands/system.ts";
import { VERSION } from "./version.ts";
import { HELP, COMMAND_HELP } from "./help.ts";

interface Parsed {
  values: Record<string, unknown>;
  positionals: string[];
}

const GLOBAL_OPTIONS = {
  json: { type: "boolean" },
  debug: { type: "boolean" },
  store: { type: "string" },
  yes: { type: "boolean" },
  "non-interactive": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "V" },
} as const;

const COMMAND_OPTIONS: Record<string, Record<string, { type: "boolean" | "string"; short?: string; multiple?: boolean }>> = {
  init: {},
  setup: {
    language: { type: "string" },
    model: { type: "string" },
    "with-model": { type: "string" },
    browser: { type: "string" },
    "export-dir": { type: "string" },
    force: { type: "boolean" },
  },
  update: {
    check: { type: "boolean" },
    nightly: { type: "boolean" },
    force: { type: "boolean" },
    all: { type: "boolean" },
    rollback: { type: "boolean" },
    from: { type: "string" },
  },
  doctor: {
    fix: { type: "boolean" },
  },
  add: {
    "max-height": { type: "string" },
    language: { type: "string" },
    lang: { type: "string" },
    quality: { type: "string" },
    asr: { type: "boolean" },
    "no-asr": { type: "boolean" },
    "strict-lang": { type: "boolean" },
    "allow-repetitive": { type: "boolean" },
    parallel: { type: "string" },
    "cookies-from-browser": { type: "string" },
    force: { type: "boolean" },
    "no-media": { type: "boolean" },
    "transcript-only": { type: "boolean" },
  },
  import: {
    language: { type: "string" },
    lang: { type: "string" },
    title: { type: "string" },
    "allow-repetitive": { type: "boolean" },
    parallel: { type: "string" },
    force: { type: "boolean" },
    "no-media": { type: "boolean" },
    "transcript-only": { type: "boolean" },
  },
  format: {
    timestamps: { type: "boolean" },
    dir: { type: "string" },
  },
  transcript: {
    language: { type: "string" },
    lang: { type: "string" },
    quality: { type: "string" },
    asr: { type: "boolean" },
    "no-asr": { type: "boolean" },
    "strict-lang": { type: "boolean" },
    "allow-repetitive": { type: "boolean" },
    format: { type: "string" },
    timestamps: { type: "boolean" },
  },
  show: {
    raw: { type: "boolean" },
    timestamps: { type: "boolean" },
    history: { type: "boolean" },
    format: { type: "string" },
  },
  list: {
    source: { type: "string" },
    sort: { type: "string" },
    limit: { type: "string" },
    "missing-transcript": { type: "boolean" },
    "missing-media": { type: "boolean" },
  },
  search: {
    source: { type: "string" },
    limit: { type: "string" },
    context: { type: "string" },
    id: { type: "string", multiple: true },
    transcripts: { type: "boolean" },
  },
  retry: {
    all: { type: "boolean" },
    limit: { type: "string" },
    "max-attempts": { type: "string" },
    "dry-run": { type: "boolean" },
  },
  rm: {},
  prune: {
    "dry-run": { type: "boolean" },
  },
  models: {
    as: { type: "string" },
    "no-default": { type: "boolean" },
    canary: { type: "boolean" },
    revision: { type: "string" },
    path: { type: "string" },
    force: { type: "boolean" },
    deep: { type: "boolean" },
  },
  sync: {},
};

const COMMANDS = Object.keys(COMMAND_OPTIONS);

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0) {
    process.stdout.write(`${HELP}\n`);
    return EXIT.ok;
  }

  const first = argv[0] ?? "";
  if (first === "--version" || first === "-V") {
    process.stdout.write(`ytx ${VERSION}\n`);
    return EXIT.ok;
  }
  if (first === "--help" || first === "-h" || first === "help") {
    process.stdout.write(`${HELP}\n`);
    return EXIT.ok;
  }

  const command = first;
  if (!COMMANDS.includes(command)) {
    process.stderr.write(`ytx: "${command}" is not a command\n\n${HELP}\n`);
    return EXIT.usage;
  }

  let parsed: Parsed;
  try {
    parsed = parseCommand(command, argv.slice(1)) as Parsed;
  } catch (err) {
    process.stderr.write(`ytx: ${(err as Error).message}\n  next: run \`ytx ${command} --help\`\n`);
    return EXIT.usage;
  }

  const flags = parsed.values;
  if (flags.help === true) {
    process.stdout.write(`${COMMAND_HELP[command] ?? HELP}\n`);
    return EXIT.ok;
  }

  const global: GlobalFlags = {
    json: flags.json === true,
    debug: flags.debug === true,
    store: typeof flags.store === "string" ? flags.store : undefined,
    yes: flags.yes === true,
    nonInteractive: flags["non-interactive"] === true,
  };

  const context = buildContext(global);

  try {
    await dispatch(command, context, parsed, global);
    return EXIT.ok;
  } catch (err) {
    if (err instanceof SilentExit) return err.code;
    const error = toYtxError(err, command);
    if (global.json) {
      context.ui.emit({ error: error.toJSON() });
    }
    context.ui.printError(error);
    if (error.code === 130) context.ui.note("  interrupted; completed work was kept");
    return error.code;
  }
}

async function dispatch(
  command: string,
  context: CommandContext,
  parsed: Parsed,
  global: GlobalFlags,
): Promise<void> {
  const values = parsed.values;
  const positionals = parsed.positionals;

  switch (command) {
    case "init":
      return cmdInit(context, positionals);

    case "setup":
      return cmdSetup(
        context,
        {
          language: stringFlag(values, "language"),
          withModel: stringFlag(values, "with-model"),
          model: stringFlag(values, "model"),
          browser: stringFlag(values, "browser"),
          exportDir: stringFlag(values, "export-dir"),
          force: values.force === true,
        },
        global,
      );

    case "update":
      return cmdUpdate(context, {
        check: values.check === true,
        nightly: values.nightly === true,
        force: values.force === true,
        all: values.all === true,
        rollback: values.rollback === true,
        from: stringFlag(values, "from"),
      });

    case "doctor":
      return cmdDoctor(context, { fix: values.fix === true });

    case "add": {
      const flags: AddFlags = {
        maxHeight: numberFlag(values, "max-height", context.config.max_height),
        quality: qualityFlag(values),
        language: languageFlag(values, context.config.language),
        asr: values.asr === true,
        noAsr: values["no-asr"] === true,
        strictLang: values["strict-lang"] === true,
        allowRepetitive: values["allow-repetitive"] === true,
        force: values.force === true,
        browser: stringFlag(values, "cookies-from-browser") ?? null,
        parallel: numberFlag(values, "parallel", context.config.parallel),
        noMedia: values["no-media"] === true || values["transcript-only"] === true,
      };
      if (flags.asr && flags.noAsr) {
        throw usageError("add", "--asr and --no-asr cannot both be set", "pick one");
      }
      return cmdAdd(context, positionals, flags);
    }

    case "import": {
      const flags: ImportFlags = {
        language: languageFlag(values, context.config.language),
        allowRepetitive: values["allow-repetitive"] === true,
        force: values.force === true,
        transcriptOnly: values["transcript-only"] === true || values["no-media"] === true,
        title: stringFlag(values, "title") ?? null,
        parallel: numberFlag(values, "parallel", context.config.parallel),
      };
      return cmdImport(context, positionals, flags);
    }

    case "format":
      return cmdFormat(context, positionals, {
        timestamps: values.timestamps === true,
        dir: stringFlag(values, "dir") ?? null,
      });

    case "transcript":
      return cmdTranscript(context, positionals, {
        quality: qualityFlag(values),
        language: languageFlag(values, context.config.language),
        asr: values.asr === true,
        noAsr: values["no-asr"] === true,
        strictLang: values["strict-lang"] === true,
        allowRepetitive: values["allow-repetitive"] === true,
        format: parseTranscriptFormat(stringFlag(values, "format")),
        timestamps: values.timestamps === true,
      });

    case "show":
      return cmdShow(context, positionals, {
        raw: values.raw === true,
        timestamps: values.timestamps === true,
        history: values.history === true,
        format: parseTranscriptFormat(stringFlag(values, "format")),
      });

    case "list":
      return cmdList(context, {
        source: stringFlag(values, "source"),
        sort: sortFlag(values),
        limit: numberFlag(values, "limit", 0) || undefined,
        missingTranscript: values["missing-transcript"] === true,
        missingMedia: values["missing-media"] === true,
      });

    case "search": {
      const source = stringFlag(values, "source");
      if (source !== undefined) provenanceFilter(source);
      return cmdSearch(context, positionals, {
        source,
        limit: numberFlag(values, "limit", 20),
        context: numberFlag(values, "context", 60),
        ids: Array.isArray(values.id) ? (values.id as string[]) : undefined,
        transcriptsOnly: values.transcripts === true,
      });
    }

    case "retry":
      return cmdRetry(context, {
        all: values.all === true,
        limit: numberFlag(values, "limit", 50),
        maxAttempts:
          stringFlag(values, "max-attempts") === undefined
            ? null
            : numberFlag(values, "max-attempts", 5),
        dryRun: values["dry-run"] === true,
      });

    case "rm":
      return cmdRm(context, positionals, { yes: global.yes });

    case "prune":
      return cmdPrune(context, { dryRun: values["dry-run"] === true, yes: global.yes });

    case "models":
      return cmdModels(context, positionals[0], positionals.slice(1), {
        json: global.json,
        as: stringFlag(values, "as"),
        noDefault: values["no-default"] === true,
        yes: global.yes,
        canary: values.canary === true,
        revision: stringFlag(values, "revision"),
        path: stringFlag(values, "path"),
        force: values.force === true,
        deep: values.deep === true,
      });

    case "sync":
      return cmdSync(context, positionals);

    default:
      throw usageError(command, "is not implemented", "run `ytx --help`");
  }
}

function parseCommand(command: string, args: string[]) {
  try {
    return parseArgs({
      args,
      options: { ...GLOBAL_OPTIONS, ...(COMMAND_OPTIONS[command] ?? {}) },
      allowPositionals: true,
      strict: true,
    });
  } catch (err) {
    const message = (err as Error).message;
    if (/Unknown option/i.test(message)) {
      throw new Error(`${message}\n  next: run \`ytx ${command} --help\``);
    }
    throw err;
  }
}

function toYtxError(err: unknown, command: string): YtxError {
  if (err instanceof YtxError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new YtxError({
    what: `ytx ${command}`,
    why: message,
    next: "run `ytx doctor` to check the installation; add `--debug` for a stack trace",
    code: EXIT.fetch,
    kind: "unexpected",
    cause: err,
  });
}

function stringFlag(values: Record<string, unknown>, key: string): string | undefined {
  const value = values[key];
  return typeof value === "string" ? value : undefined;
}

function numberFlag(values: Record<string, unknown>, key: string, fallback: number): number {
  const raw = values[key];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw usageError(`--${key}`, `expects a positive number, got "${String(raw)}"`, "for example `--limit 20`");
  }
  return Math.floor(value);
}

function qualityFlag(values: Record<string, unknown>): "auto" | "best" {
  const raw = stringFlag(values, "quality");
  if (raw === undefined) return "auto";
  if (raw === "auto" || raw === "best") return raw;
  throw usageError(
    `--quality ${raw}`,
    "is not a known quality",
    "use `--quality auto` (obey the ladder) or `--quality best` (skip machine captions)",
  );
}

function languageFlag(values: Record<string, unknown>, fallback: string): string {
  return stringFlag(values, "language") ?? stringFlag(values, "lang") ?? fallback;
}

function sortFlag(values: Record<string, unknown>): string | undefined {
  const raw = stringFlag(values, "sort");
  if (raw === undefined) return undefined;
  if (["recent", "oldest", "title", "duration"].includes(raw)) return raw;
  throw usageError(
    `--sort ${raw}`,
    "is not a known order",
    "use `--sort recent|oldest|title|duration`",
  );
}

if (import.meta.main) {
  const code = await main();
  process.exit(code);
}
