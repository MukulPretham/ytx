# ytx

A command-line tool that archives YouTube videos together with their transcripts
into a self-contained local library, and records where every transcript came from.

## Layout

```
src/
  main.ts       argument parsing and command dispatch
  help.ts       per-command help text
  wizard.ts     the interactive `setup` flow
  commands/     acquisition, library, models, render, system
  captions/     VTT parsing, normalization, quality gates, ladder, language
  asr/          venv management and transcription
  models/       catalog, hub validation, install, verify, remove
  ytdlp/        binary management, invocation, error classification
  core/         config, paths, record schema, queue, locks, errors, ui
tests/          bun test suites over the pure logic
assets/         canary.wav, used to prove a downloaded model loads
docs/           architecture notes
```

## Two directories, never mixed

- **Library** — pure data, relocatable, safe to copy. Default `~/.ytx/library`;
  `--store` then `YTX_HOME` override it, and a `.ytx/` directory in the working
  directory marks a directory-local library. Holds `config.toml`, `queue.jsonl`
  and `videos/<id>/`.
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

## Conventions

- Bun + TypeScript. Dependencies stay at three: `@clack/prompts`, `zod`,
  `smol-toml`. Flag parsing uses Bun's built-in `util.parseArgs`.
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

## Open decisions

- Whether platform machine captions return as a fallback when transcription is
  unavailable or declined (`--no-asr` currently fails on such videos).
- The project's delivery posture now that it has a remote. It was registered
  local-only; the automated review pipeline is not installed anywhere it runs.

## Local workarounds on the development machine

Neither is a fix; both should disappear once gaps 1 and 4 are closed.

- The library lives at `~/ytx-library` with `YTX_HOME` exported in `~/.zshrc`,
  to dodge the default-path collision.
- The installed binary at `~/.local/bin/ytx` was re-signed by hand.

## Verifying a change

Unit tests cover the pure logic. Behaviour changes are proved against live
videos: a video with human captions, a video without, a forced local
transcription, and the failure paths (unreadable cookie store, missing model,
interrupted download). Captured terminal output belongs with the task record, not
in this file.
