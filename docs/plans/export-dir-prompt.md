# Plan: ask for the export folder, then remember it

Status: **implemented** with `~/Desktop/ytx-transcripts` as the suggested default. Builds on the `ytx format` command and `export_dir` key that
already exist. `docs/architecture.md` owns the current contract; update it when
this lands.

## The flow being asked for

1. The library already holds a config: `<library>/config.toml` (the `.ytx`
   directory in the marker layout). No new file is needed; only one key changes
   meaning.
2. On a **first** `ytx setup`, the wizard asks where exported transcripts should
   go, with a suggested path, and writes the answer to `config.toml`.
3. On a library where setup already ran and the key is still empty, the first
   `ytx format <id> <type>` detects that, asks the same question right there,
   writes the answer to `config.toml`, and **continues formatting** without
   asking again.

In one sentence: `export_dir = ""` stops meaning "Desktop" and starts meaning
"not configured yet; ask once".

## Semantics

| situation | behaviour |
| --- | --- |
| `--dir <path>` given | use it for this run; never prompt, never save |
| `export_dir` non-empty | use it; never prompt |
| `export_dir` empty, interactive | prompt with `~/Desktop/ytx-transcripts` as the initial value, create the folder, save the answer, continue |
| `export_dir` empty, not interactive (`--json`, `--non-interactive`, `--yes`, no TTY) | exit `2`: pass `--dir`, or set `export_dir` in `config.toml` |
| prompt cancelled (Ctrl-C) | exit `130`; config untouched; nothing written |
| folder cannot be created | re-ask (up to 3 attempts), then exit `2` naming `--dir` |

The answer is stored home-relative when possible (`~/Desktop/ytx`), absolute
otherwise, so a copied config stays readable. Relative values already in
`config.toml` keep resolving against the library root. `--dir` stays ephemeral.

`ytx setup --export-dir <path>` is the scripted counterpart. Non-interactive
setup without it leaves the key empty, so a later interactive `format` still
asks.

## Setup integration

- `WizardChoices` gains `exportDir: string`.
- The wizard asks one more question, after the library path:
  "Where should `ytx format` write transcripts?" — initial value
  `defaults.exportDir || ~/Desktop/ytx-transcripts`.
- The path is validated by attempting `mkdirSync(recursive)`. A bad path re-asks
  instead of failing setup later.
- The summary lists `formats  <path>` next to library/language/model/browser.
- `applySetup` writes `export_dir` into `config.toml`, creates the folder, and
  adds an `exports` step to the setup report.
- `setup --force` re-asks even when the key is set; without `--force`, a
  configured value is accepted silently (setup stays idempotent).
- Non-interactive setup (`--yes`, `--non-interactive`, `--json`) never prompts:
  the flag wins if given, otherwise the key is left as it is.

## Format integration

`cmdFormat` resolves the destination in this order:

```
--dir  →  config.export_dir  →  prompt (interactive)  →  usage error
```

The prompt happens after the record and transcript have been read, so a bad id
never asks for a folder. On a successful answer:

1. `saveConfig(library, { ...config, export_dir: answer })` (atomic write, same
   validation as every other config write);
2. print `export folder set to <path> (config.toml)`;
3. continue to the requested formats.

`--json` mode emits `export_dir` as it does today; the prompt is disabled there
because prompts would corrupt the single JSON document.

## Prompt implementation

- New `src/prompts.ts` with `askExportDir(initialValue): Promise<string | null>`
  (null = cancelled), built on `@clack/prompts` `text` — the same UI as setup.
- It expands `~`, resolves relative input against the cwd, tries
  `mkdirSync(recursive)`, and returns a home-relative path for config.
- `wizard.ts` and `commands/format.ts` both call it, so cancellation and
  validation have one owner. The AGENTS convention "clack is used only by the
  wizard" becomes "clack is used only for setup and the first-run export
  question".
- `cancelGuard` in the wizard stops leaking clack's symbol for this question:
  a null return maps to the existing setup-cancelled error.

## Doctor

Add a non-fatal `library/exports` row:

```
✓ exports  ~/Desktop                       (configured)
✓ exports  not set yet; the first `ytx format` asks
```

It never turns `doctor` red: an unanswered export folder only affects `format`.

## Files

| file | change |
| --- | --- |
| `src/core/paths.ts` | `export_dir: ""` → `resolveExportDir` returns `null`; add `toConfigPath(path, home)` |
| `src/core/config.ts` | comment on `export_dir`: empty means "ask on first use" |
| `src/prompts.ts` (new) | `askExportDir`, path expansion, mkdir validation, 3 attempts |
| `src/wizard.ts` | one question, `exportDir` in `WizardChoices`, summary line |
| `src/commands/system.ts` | `setup --export-dir`, persist and create the folder, setup step/summary, doctor row |
| `src/commands/format.ts` | destination resolution, prompt + save + continue, non-interactive error |
| `src/main.ts` | `setup --export-dir` option |
| `src/help.ts`, `README.md`, `docs/architecture.md`, `AGENTS.md` | the flow, the empty-key meaning, the non-interactive rule |
| `tests/export.test.ts`, `tests/config.test.ts` | `""` → null, `toConfigPath`, config round-trip |

## Tests and live verification

Unit (no TTY):

- `resolveExportDir("")` is `null`; non-empty values unchanged.
- `toConfigPath`: home → `~`, inside home → `~/…`, outside → absolute.
- Config with `export_dir = ""` loads; a written value round-trips.
- Doctor reports the exports row without failing.

Live, on a **scratch library copied from one record** (leaving the real
`~/ytx-library` unset so the owner answers the first prompt themselves):

1. Allocate a PTY (`script -q /dev/null …`), run `format <id> md`, type a temp
   folder → file written, `config.toml` contains that folder.
2. Run the same command again → no prompt.
3. Cancel at the prompt → exit `130`, config unchanged, no file.
4. Non-TTY with the key empty → exit `2`, message names `--dir`.
5. `--dir /tmp/x` with the key empty → no prompt, no config write.
6. `setup --non-interactive --export-dir ~/…` on a scratch store → key written
   and folder created.
7. Rebuild, `codesign`, reinstall `~/.local/bin/ytx`; then the real first run.

## Open choices

- Suggested default in the prompt: **`~/Desktop/ytx-transcripts`** (chosen).
- Non-interactive with no key: **exit `2`** rather than silently writing to
  Desktop, so automation never picks a folder the user did not choose.
- Setup asks only when the key is empty (or `--force`), keeping reruns quiet.
