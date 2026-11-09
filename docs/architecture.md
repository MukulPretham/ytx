# ytx architecture

Five contracts decide almost everything else here: the directory split, the
provenance model, the acquisition ladder, the no-partial-store rule, and the
rule that records are validated on every read and write. This note is the single
owner of each.

## Two directories, never mixed

**Runtime** is machine-local: absolute paths, binaries, Python, model weights.
It is never copied between machines and is fully rebuilt by `ytx setup`.

```
<runtime>/                  # $XDG_DATA_HOME/ytx, ~/Library/Application Support/ytx, ~/.local/share/ytx
  bin/yt-dlp                # self-managed standalone binary
  bin/yt-dlp.prev           # previous binary, for `ytx update --rollback`
  bin/ffmpeg, bin/ffprobe   # only when the machine had none on PATH
  bin/uv                    # only when the machine had none on PATH
  venv/                     # uv-managed, holds mlx-whisper
  models/                   # one directory per model, each with manifest.json
  state.json                # versions of everything installed above
  logs/, tmp/, locks/
```

**Library** is pure data: relocatable, safe to copy, safe to back up.

```
<library>/                  # ~/.ytx/library, or --store/YTX_HOME/.ytx marker
  config.toml
  queue.jsonl
  videos/<videoId>/
    meta.json
    <videoId>.mp4           # muxed video with audio
    <videoId>.m4a           # the original audio track, kept as-is
    <videoId>.mp3           # generated from the original
    caption.<lang>.vtt      # raw platform track, immutable
    transcript.json
    transcript.txt
```

The rule that keeps them apart: **every path inside `meta.json` is relative to
the video directory.** A record never names the runtime, never names an absolute
path, and never names the library root, so moving the library cannot break it.
`zod` enforces this - a record with an absolute or escaping media path is
refused before it is written.

Library resolution order: `--store <path>`, then `YTX_HOME`, then a `.ytx`
directory in the working directory, then the default. `YTX_MODELS_DIR` relocates
weights only.

## Provenance: three sources, never two

```
caption-human   human-written track            H
caption-auto    the platform's own ASR output  A
asr             local Whisper                  M
```

The distinction that mattered when all three were acquired is `caption-human`
versus `caption-auto`: machine captions are a model's output that happens to
live on the platform, while local Whisper is a model's output that lives here.
Recording both as "machine" would make the most useful distinction in the
library unanswerable: did a human write this, or did a model guess at it? The
schema keeps all three values so libraries archived before the change stay
distinguishable; new adds produce `caption-human` or `asr`.

Provenance surfaces everywhere: `list` prints `H`/`A`/`M`, `show` prints a
provenance header that `--raw` suppresses, `search --source caption-human`
filters, `doctor` prints the distribution, and `meta.json` stores it.

`caption-auto` is a **legacy** value in this build: new adds never produce it
(see "Acquisition ladder" below), but libraries archived before the change keep
validating, listing and searching it.

Alongside the source, `meta.json` records what makes the transcript reproducible:

- caption sources: `ytdlp_version` and `ytdlp_source` (`managed` or `system`)
- ASR: `model` and `model_revision` (a pinned hub commit)

The field that does not apply is absent, never `null`. `ytdlp_source` is written
for every new caption record but is optional on read, so a library archived
before the field existed stays valid.

`meta.json` also carries a `warnings` array: non-fatal observations such as
"human captions repeat a chorus 65% of the time; repetition is not a rejection
for human captions". A warning never blocks a record; it is the record's own note
about why something that looks odd was accepted.

**Raw caption files are immutable; derived transcripts are replaceable.**
Re-running ASR never deletes a stored caption track, and every rewrite appends
the superseded transcript entry to `transcript_history`. Switching a video from
human captions to ASR therefore loses nothing: the `.vtt` stays, and the old
transcript record stays in history.

## Acquisition ladder

The first tier that passes the gates wins.

1. human captions in the preferred language
2. human captions in another language (the actual language is recorded)
3. **not used in this build** - platform machine captions
4. local transcription from the audio

Platform machine captions were removed deliberately. YouTube's `timedtext`
endpoint answered HTTP 429 for the automatic track (and always for the
translated `tlang` variants), so a video with only machine captions could fail
intermittently. The instruction is now: use human captions, otherwise transcribe
locally. The ladder falls through to tier 4 when no human track exists or every
human track fails a gate. `--quality auto` and `--quality best` are equivalent;
the flag remains for compatibility. `--asr` forces tier 4, `--no-asr` stops
after tier 2 (exit 4 when nothing passes), `--strict-lang` turns the preference
into a hard filter and removes tier 2.

Language is a preference, not a filter: a video whose original language is
Spanish still yields Spanish captions for a user who asked for English, and tier
2 records `es` rather than pretending it is `en`.

### Quality gates

A caption track is evaluated before it is accepted:

| gate | rule |
| --- | --- |
| coverage | last cue end ÷ video duration ≥ 0.90 |
| language | detected from the caption body, not the tag |
| density | ≥ 20 characters per minute of audio |
| repetition | ≤ 25% duplicate lines, **for `caption-auto` only** |

A rejected track records its reason, and the ladder falls through. The
repetition gate measures duplicates *after* rolling windows are collapsed, so a
legitimate rolling track is not punished for the platform's cue format.

The repetition rule is source-aware because human captions legitimately repeat a
chorus, a chant, or a refrain. Rejecting a music video's human captions at tier 1
would send it to a worse source for a property that is not a defect:

| source | duplicate lines over 25% |
| --- | --- |
| `caption-auto` (legacy) | rejection; the ladder falls through |
| `caption-human` | accepted, with a warning recorded in `meta.json` |
| `asr` | accepted, with a report-only warning |

`--allow-repetitive` bypasses the gate for any source.

### Normalization

The platform's tracks are not transcripts. Normalization:

1. strips `<c>` tags, inline `<00:00:01.000>` timestamps, voice tags, and cue
   settings such as `align:`/`position:`;
2. detects rolling-window cues as a *track-level* property (each cue repeats the
   previous cue's words and adds to them) and collapses them by suffix/prefix
   comparison, so a single coincidental overlap in human captions does not
   trigger collapse;
3. reassembles sentence-level segments, joining cues until terminal punctuation,
   a pause longer than 0.8 s, or roughly 200 characters.

A segment's `start` is the first cue it absorbed and its `end` is the last, so no
timestamp is invented.

## No partial store

A failed `add` must leave the library byte-identical. Two mechanisms enforce it:

1. **Preflight.** Before the library is touched, `add` resolves the downloader
   and verifies it runs, checks ffmpeg when media will be downloaded, and checks
   the ASR model and venv when `--asr` forces tier 4. A missing dependency exits
   `3` without creating even the store skeleton.
2. **Staging.** Transcript acquisition (caption fetches, ASR audio, transcription)
   writes only to a scratch directory under the runtime. The video directory is
   created after a transcript exists. A failed acquisition, a rejected track, or
   an unconfigured ASR model therefore leaves no meta-less directory behind.

`prune` removes empty directories and directories without `meta.json`; `doctor
--fix` removes empty ones and regenerates a missing `transcript.txt` from
`transcript.json`.

ASR audio downloaded into staging is moved into the video directory only when
media will be archived too, so `--transcript-only` records have no unrecorded
media files.

## Setup downloads no weights by default

`asr_model` defaults to `"none"`. Weights are installed only by:

- `ytx setup --with-model <name>`
- answering the wizard's model question with a catalog entry or custom repo
- `ytx models add <name|repo>`

When a command reaches tier 4 with no model configured, it prints the catalog
with sizes once and exits `2`; it never downloads implicitly. `doctor` reports
`asr_model = none` as healthy and still prints the library's provenance mix.

## Records

`meta.json` is validated with `zod` on every read and every write. A record that
fails validation is refused rather than partially written, and reads go through a
non-throwing variant so `doctor` can name every broken record and keep going.
Writes are atomic (temp file + rename), so an interrupted write leaves either the
old record or the new one.

`transcript.json` is validated the same way, and its `end >= start` invariant is
part of the schema.

## Media

Media is downloaded *after* the transcript exists, so an `add` produces a
searchable record within seconds. The video and audio streams are fetched
separately: the audio stream is kept untouched as the original track, the video
stream is muxed with a copy of it into `<id>.mp4`, and the mp3 is generated from
the original. Nothing transcodes the original away.

If the mp4 mux fails, the separate streams are kept and the failure is reported.
If the video stream is unavailable, the add degrades to audio-only rather than
failing: the transcript is the point.

## Downloader resolution and the GitHub fallback

`yt-dlp` is a self-managed standalone binary, but a GitHub outage must not make
the tool unusable on a machine that already has one. `config.toml` gains
`ytdlp = "auto" | "managed" | "system"`:

| mode | resolution |
| --- | --- |
| `auto` (default) | `bin/yt-dlp` when present, else a `yt-dlp` on `PATH`; setup/update fall back to `PATH` when the managed download fails |
| `managed` | only `bin/yt-dlp`; a missing binary is an error, never a fallback |
| `system` | only a `yt-dlp` on `PATH`; setup and update never download |

Every caption record stores which binary fetched it (`ytdlp_source`) and its
version, and `doctor` prints the resolved source and version. `ytx update --from
<path>` adopts a specific binary: verify it runs, canary it, promote atomically,
keep the previous one.

## Failure handling

yt-dlp exit codes cannot distinguish "gone" from "rate limited" from "too old",
so stderr is classified instead:

| class | response |
| --- | --- |
| `bot-check` | never retried; point at `--cookies-from-browser` |
| `needs-update` | point at `ytx update` |
| `format-unavailable` | retry with another player client, then degrade to audio-only |
| `transient` | back off with jitter and a one-hour cap; queue the video |
| `gone-or-private` | mark permanently, never queue |

Transient failures are queued in `queue.jsonl` with their class and next attempt
time; `ytx retry` drains the queue. A transient caption-fetch failure is retried
twice before it is reported, because silently falling through to local
transcription would produce a worse transcript for a video whose captions exist.

## Hub validation

A custom model repo is checked against the hub before any bytes are pulled. The
hub answers `401` both for a repo that does not exist and for a private or gated
one; the error says both, because asserting "not found" for a `401` would be
false. A real `404` says not found. Both point at
`https://huggingface.co/models?search=whisper`, and a gated repo additionally
points at accepting its terms and `huggingface-cli login` (or `HF_TOKEN`). A
PyTorch or GGUF checkpoint gets the likely MLX equivalent named.

## Why each dependency exists

| dependency | why it is here, and why not something else |
| --- | --- |
| `@clack/prompts` | the first-run wizard needs real prompts with defaults and a cancel path. It is the only interactive dependency and is used only by the wizard. |
| `zod` | `meta.json`, `config.toml`, `state.json`, `queue.jsonl`, and `transcript.json` all have contracts. Hand-written guards drift; one schema per record is also the error message ("duration_s: Expected number"). |
| `smol-toml` | config is read and written as TOML, so a human can edit it. |
| Bun `util.parseArgs` | flag parsing is not worth a framework: the surface is small and hierarchy-free. |
| yt-dlp (binary, not a package) | it needs to move faster than any distro, and `ytx update` must be able to replace it. A package-manager copy would be invisible to this tool's own update and rollback path. |
| ffmpeg (PATH or static) | muxing, mp3 generation, and 16 kHz PCM extraction. Preferring the PATH copy means the runtime does not carry a 70 MB duplicate unless the machine has none. |
| uv + mlx-whisper (Python) | local transcription. Python stays in a subprocess with an explicit local model directory; the TypeScript process never imports Python, so a broken venv cannot take the CLI down and installed weights need no network. |
| WebVTT/SRT parsing (in-repo) | the parsing is small, the platform's quirks are specific, and it is the code that must be unit tested. |

## Command surface

`init`, `setup`, `update`, `doctor`, `add`, `transcript`, `show`, `list`,
`search`, `retry`, `rm`, `prune`, `models`, and `sync` (which exits `2` and says
it is not implemented in v1).

`--quality` is accepted but no longer changes the plan: platform machine
captions are not acquired. `caption-auto` records remain readable and
searchable.

Notable flag surface:

```
add        --max-height --language --quality auto|best --asr --no-asr
           --strict-lang --allow-repetitive --parallel --cookies-from-browser
           --force --no-media|--transcript-only
transcript <url|id> --format txt|json|srt|vtt|md --timestamps --language --asr
show       <id> --format --timestamps --raw --history
list       --source --missing-transcript --missing-media --sort --limit
search     <query> --source --transcripts --limit --context --id
retry      --all --limit --max-attempts --dry-run
rm         <id...> --yes
prune      --dry-run --yes
doctor     --fix --json
update     --check --rollback --nightly --force --all --from <path>
models     list | add <name|repo> | rm | verify | default | path
           add: --as --no-default --force --revision --path
           verify: --deep
setup      --language --with-model --browser --force
```

Every command supports `--json`. Exit codes are `0` ok, `2` usage, `3` fetch or
dependency failure, `4` no transcript obtainable, `5` quality gate failed, `6`
store integrity error, `130` interrupted.

`ytx transcript <url>` fetches and prints without writing; `ytx transcript <id>`
reads the store. `ytx add --force` is the way to replace an archived transcript.

## Testing

`bun test` covers the pure logic only, with no network: caption parsing and
normalization (including rolling-window collapse), the source-aware quality
gates, path resolution and URL parsing, language detection, ladder planning,
record schema and transcript validation, config round-trips, failure
classification, queue backoff, the model catalog, and manifest validation.

Everything that touches the network or a Python process is verified by hand
against live videos; that evidence lives in the task record, not in `bun test`.
