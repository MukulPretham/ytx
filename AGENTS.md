# ytx

A command-line tool that archives YouTube videos or local media files together
with their transcripts into a self-contained local library, and records where
every transcript came from.

## Layout

```
src/
  main.ts       argument parsing and command dispatch
  help.ts       per-command help text
  wizard.ts     the interactive `setup` flow
  prompts.ts    the export-folder question shared by setup and `format`
  commands/     acquisition, library, import, format, models, render, system
  captions/     VTT parsing, normalization, quality gates, ladder, language
  local/        path identity, ffprobe parsing, staging, copy and publish
  asr/          venv management and transcription
  models/       catalog, hub validation, install, verify, remove
  ytdlp/        binary management, invocation, error classification
  core/         config, paths, record schema, queue, locks, errors, ui
tests/          bun test suites over the pure logic
assets/         canary.wav, used to prove a downloaded model loads
docs/           architecture notes and implementation plans
```

## Two directories, never mixed

- **Library** — pure data, relocatable, safe to copy. Default `~/.ytx/library`;
  `--store` then `YTX_HOME` override it, and a `.ytx/` directory in the working
  directory marks a directory-local library. Holds `config.toml`, `queue.jsonl`
  and `videos/<id>/`. Imports stage in `videos/.incoming-*` so the publish is a
  rename on the same filesystem; the dot prefix keeps staging out of listings.
- **Runtime** — machine-local, never synced. `$XDG_DATA_HOME/ytx`, else
  `~/Library/Application Support/ytx` on macOS. Holds the yt-dlp binaries, an
  optional static ffmpeg, the Whisper venv, model weights, state and logs.

Every path recorded inside `meta.json` is relative to the video directory.

## Invariants

- **Three provenance values, never two.** `caption-human`, `caption-auto`,
  `asr`. The platform's machine captions are a model's output, so collapsing
  them into "captions" would make machine output look authoritative.
- **Raw caption files are immutable; derived transcripts are replaceable.**
  A rewrite appends to `transcript_history` and never deletes the source track.
- **A local file is identified by its bytes, not its path.** Its id is
  `local-` + the first 12 hex characters of the SHA-256, and a record carries
  `origin: "file"` plus `source { filename, bytes, sha256 }`. No absolute path
  ever enters the library, and re-importing the same bytes is idempotent.
- **`add` fetches, `import` copies.** `add` is URL-only and queues transient
  failures; `import` is path-only, never calls yt-dlp, and never writes
  `queue.jsonl` because a local failure is fixed by hand.
- Every command supports `--json`.
- Exit codes: `0` ok, `2` usage, `3` fetch or dependency, `4` no transcript,
  `5` quality gate, `6` store integrity, `130` interrupted.
- Every error names what failed, why, and the single next action. Stack traces
  only behind `--debug`.

## Acquisition ladder (current)

1. Human captions in the preferred language
2. Human captions in another language, recording the actual language
3. *Not used.* Platform machine captions are not acquired (see gaps)
4. Local transcription from the audio

`ytx import` has no caption tiers: tier 4 is its whole ladder. Sidecar and
embedded subtitles are ignored, because their provenance (human or machine) is
unknowable and must not be guessed into the three-value scheme.

## Conventions

- Bun + TypeScript. Dependencies stay at three: `@clack/prompts`, `zod`,
  `smol-toml`. Flag parsing uses Bun's built-in `util.parseArgs`. `ytx setup`
  and the first `ytx format` are the only prompts; `format` saves its answer to
  `export_dir` in `config.toml`.
- `bun test` and `bunx tsc --noEmit` must both be clean.
- `bun build --compile src/main.ts --outfile dist/ytx` — then re-sign on macOS,
  or the binary is killed on launch (see gaps).
- Every yt-dlp invocation passes `--ignore-config` and reads `-J` JSON. Never
  scrape human-readable stdout.

## Known gaps

1. **Default library path collides with the per-directory marker.** The default
   is `~/.ytx/library` while `<cwd>/.ytx` marks a directory-local library, so
   running from `$HOME` resolves the store to `~/.ytx` itself instead of
   `~/.ytx/library`. Observed in practice: an `add` run from the home directory
   picked up a stray config and failed. Fix by moving the default out of `.ytx/`,
   or by ignoring `$HOME` in shadow resolution.
2. **Configuration failures are misclassified as transient.** An unreadable
   browser cookie store is reported `[transient]`, told to "retry later", and
   queued — it can never succeed. Should exit 2 as a configuration error naming
   the remedy.
3. **The wizard offers browsers without probing them.** It should check the
   cookie store is readable before offering a browser, and default to skip.
4. **The compiled binary is killed by macOS until re-signed.**
   `bun build --compile` invalidates the linker signature; the result dies with
   SIGKILL. The build must run
   `codesign --force --sign - --timestamp=none <binary>` afterwards.
5. **`setup` summary is misleading:** it prints `model none (captions only)`
   even when a model is installed and default.
6. **No installer and no published binaries.** Getting `ytx` onto another
   machine means cloning, building, re-signing, and wiring PATH by hand. Release
   builds per platform plus a small install script would close this.
7. **No `--copy` flag.** Transcripts reach the clipboard only by piping:
   `ytx show <id> --raw | pbcopy`.
8. **Two `setup` branches have never been exercised:** auto-installing `uv` and
   falling back to a static ffmpeg build. Both dependencies were already present
   on every machine used so far.
9. **`sync` is a stub** that exits 2. Playlist and channel sync are unimplemented.
10. **`import` ignores sidecar and embedded subtitle tracks.** A `.srt`/`.vtt`
    next to the file, or a subtitle stream inside the container, is reported but
    not imported (see open decisions).
11. **`import` always copies.** There is no `--move`, no `--link`, and no way to
    re-import from the stored record: the original path is not kept.
12. **Exports are snapshots.** `ytx rm` removes the record but leaves its export
    folder; re-exporting a renamed record creates a new folder and leaves the old
    one. Nothing reconciles the export root with the library.

## Open decisions

- Whether platform machine captions return as a fallback when transcription is
  unavailable or declined (`--no-asr` currently fails on such videos).
- The project's delivery posture now that it has a remote. It was registered
  local-only; the automated review pipeline is not installed anywhere it runs.
- Whether a sidecar subtitle file may be imported, and as which provenance. A
  `.srt` pulled from YouTube is not necessarily human-written; a fourth value
  (`caption-sidecar`) would break the three-value invariant, and `caption-human`
  would assert something the file cannot prove.

## Local workarounds on the development machine

Neither is a fix; both should disappear once gaps 1 and 4 are closed.

- The library lives at `~/ytx-library` with `YTX_HOME` exported in `~/.zshrc`,
  to dodge the default-path collision.
- The installed binary at `~/.local/bin/ytx` was re-signed by hand.

## Verifying a change

Unit tests cover the pure logic. Behaviour changes are proved against live
videos: a video with human captions, a video without, a forced local
transcription, and the failure paths (unreadable cookie store, missing model,
interrupted download). Local import is proved with a generated speech file:
import, re-import (idempotent), `--force`, `--transcript-only`, an audio-only
file, an `.mkv` with Opus, a file with no audio stream, a missing model, and an
interrupted run whose staging directory `prune` then removes. Exports are proved
with `ytx format <id> all`: one folder per record, every requested format inside,
`--dir` nesting the same way, and the first-run question saving `export_dir` on
a scratch library. Captured terminal output belongs with the task record, not
in this file.
