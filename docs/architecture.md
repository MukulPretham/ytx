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
  videos/<id>/              # an 11-char YouTube id, or local-<12 hex> from a file's SHA-256
    meta.json
    <videoId>.mp4           # muxed video with audio
    <videoId>.m4a           # the original audio track, kept as-is
    <videoId>.mp3           # generated from the original
    caption.<lang>.vtt      # raw platform track, immutable
    transcript.json
    transcript.txt
```

Imports also stage under `videos/.incoming-*` while they run. The leading dot
keeps them out of every listing, and `prune` sweeps one left by a killed process.

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

The first tier that passes the gates wins. A local import has no caption tiers at
all: tier 4 is the whole ladder, and `--no-asr` does not exist on `ytx import`.

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

An import stages in `videos/.incoming-*`, inside the library so the publish is a
rename on one filesystem rather than a second copy across devices. The
transcript is written into that staging directory and `meta.json` is moved last,
so the record never points at files that are not there yet. A killed import
leaves only a dot directory, invisible to `list`, which `prune` removes.

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

## Local files

`ytx import <path>` brings an existing file into the same record shape. It is a
separate command so neither command has to guess what its argument is.

- **Identity is content, not a path.** `id = "local-" + sha256(bytes)[0..12]`.
  The hash is computed while the file is copied, so a multi-gigabyte file is
  read once. Re-importing the same bytes resolves to the same directory and
  reports `already archived`; `--force` re-transcribes it and appends to
  `transcript_history`.
- **The source is copied, never referenced.** The library stays pure data: an
  absolute path never enters `meta.json`. The original filename survives as a
  basename in `source.filename`, and `url` is `local:sha256:<full digest>`.
- **No yt-dlp and no queue.** Import fails with a usage, fetch or transcript
  error; it never writes `queue.jsonl`, whose retry contract is URL-shaped.
- **Only `asr` provenance.** Embedded and sidecar subtitle tracks are ignored in
  this build; importing them would require deciding whether a file of unknown
  origin counts as human or machine captions.
- **Media mapping.** The video stream is kept byte-for-byte in the source
  container. The audio is remuxed to `.m4a`/`.mp3`/`.opus`/`.ogg`/`.flac` when
  the codec fits a lossless container and transcoded to AAC otherwise. An
  audio-only input is its own audio track, so nothing is extracted. An mp3
  source needs no generated mp3. A file with no audio stream exits `4` before
  anything is written.
- **Prerequisites.** `ffmpeg`, `ffprobe`, an installed model and a working venv,
  all checked before the first byte is copied. `ffprobe` is the authority on
  streams, duration, chapters and tags; the extension is not consulted.

A local record carries `schema: 2` and `origin: "file"` with a `source` block.
The schema ties the id to the hash and the url to the hash, so a hand-edited id
is refused. YouTube records keep `schema: 1` and validate unchanged; `origin`
defaults to `"youtube"` on read.

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
| `@clack/prompts` | setup and the first `ytx format` need real prompts with defaults and a cancel path. It is the only interactive dependency; `src/prompts.ts` owns the export-folder question shared by both. |
| `zod` | `meta.json`, `config.toml`, `state.json`, `queue.jsonl`, and `transcript.json` all have contracts. Hand-written guards drift; one schema per record is also the error message ("duration_s: Expected number"). |
| `smol-toml` | config is read and written as TOML, so a human can edit it. |
| Bun `util.parseArgs` | flag parsing is not worth a framework: the surface is small and hierarchy-free. |
| yt-dlp (binary, not a package) | it needs to move faster than any distro, and `ytx update` must be able to replace it. A package-manager copy would be invisible to this tool's own update and rollback path. |
| ffmpeg (PATH or static) | muxing, mp3 generation, and 16 kHz PCM extraction. Preferring the PATH copy means the runtime does not carry a 70 MB duplicate unless the machine has none. |
| uv + mlx-whisper (Python) | local transcription. Python stays in a subprocess with an explicit local model directory; the TypeScript process never imports Python, so a broken venv cannot take the CLI down and installed weights need no network. |
| WebVTT/SRT parsing (in-repo) | the parsing is small, the platform's quirks are specific, and it is the code that must be unit tested. |

## Command surface

`init`, `setup`, `update`, `doctor`, `add`, `import`, `format`, `transcript`,
`show`, `list`, `search`, `retry`, `rm`, `prune`, `models`, and `sync` (which
exits `2` and says it is not implemented in v1).

`--quality` is accepted but no longer changes the plan: platform machine
captions are not acquired. `caption-auto` records remain readable and
searchable.

Notable flag surface:

```
add        --max-height --language --quality auto|best --asr --no-asr
           --strict-lang --allow-repetitive --parallel --cookies-from-browser
           --force --no-media|--transcript-only
import     --language --title --allow-repetitive --parallel --force
           --no-media|--transcript-only
format     <id|url> [txt|md|srt|vtt|json|all] --timestamps --dir <path>
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

`ytx format` is the only command that writes outside the library. The folder is
`export_dir` from `config.toml`; a relative value is resolved against the
library root, and `--dir` overrides it per run. An empty key means "not asked
yet": an interactive run prompts (suggesting `~/Desktop/ytx-transcripts`),
creates the folder, saves the answer, and continues with the same export; a
non-interactive run exits `2` rather than picking a folder. `ytx setup` asks the
same question and `setup --export-dir` answers it for scripts. Each record
exports into `<root>/<title> (<id>)/`, with files named `<title> (<id>).<ext>`, so
two records with the same title cannot mix.

## Testing

`bun test` covers the pure logic only, with no network: caption parsing and
normalization (including rolling-window collapse), the source-aware quality
gates, path resolution and URL parsing, language detection, ladder planning,
record schema and transcript validation, config round-trips, failure
classification, queue backoff, the model catalog, and manifest validation. Local
imports add path resolution, ffprobe JSON parsing, the audio-container mapping,
hashing/copying, staging publish, and the local-record schema rules. Export adds
the folder-name rules, export-dir resolution and the home-relative config form.

Everything that touches the network or a Python process is verified by hand
against live videos; that evidence lives in the task record, not in `bun test`.
