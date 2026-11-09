# ytx

Archive a YouTube video, an audio copy of it, and its full transcript into a
self-contained local library you can read, search, and quote later.

```
$ ytx add https://www.youtube.com/watch?v=jNQXAC9IVRw
fetching metadata for jNQXAC9IVRw…
  tier 1 · human captions (en)
✓ jNQXAC9IVRw transcript archived (caption-human, 4 segments)
downloading media for jNQXAC9IVRw (max 1080p)…
✓ media archived: jNQXAC9IVRw.mp4 (240p) · jNQXAC9IVRw.m4a · jNQXAC9IVRw.mp3
```

What lands on disk:

```
~/.ytx/library/videos/jNQXAC9IVRw/
  meta.json              the record: channel, duration, chapters, provenance
  jNQXAC9IVRw.mp4        the video
  jNQXAC9IVRw.m4a        the original audio track, exactly as downloaded
  jNQXAC9IVRw.mp3        generated from the original
  caption.en.vtt         the raw platform track, immutable
  transcript.json        [{ start, end, text }, ...]
  transcript.txt         the same text, readable
```

Every transcript records where it came from: human-written captions (`H`),
the platform's own speech recognition (`A`, legacy records only in this build),
and a local Whisper model (`M`). The three values are never collapsed into two.

```
$ ytx list
H  jNQXAC9IVRw  19s     en    4    Me at the zoo

$ ytx show jNQXAC9IVRw
jawed — Me at the zoo
jNQXAC9IVRw · 19s · published 2005-04-24
provenance  H human captions · en · 4 segments · 214 chars · coverage 99% · yt-dlp 2026.10.26 (managed)
media       jNQXAC9IVRw.mp4 (240p) · jNQXAC9IVRw.m4a · jNQXAC9IVRw.mp3
added       2026-11-09T05:55:42.520Z
chapters
  00:00  Intro
  00:05  The cool thing
  00:17  End

All right, so here we are, in front of the elephants
the cool thing about these guys is that they have really...
really really long trunks and that's cool (baaaaaaaaaaahhh!!)
and that's pretty much all there is to say
```

## Install

`ytx` is a single Bun binary. It installs its own dependencies, so the machine
only needs `bun` to run it:

```
bun install
bun run src/main.ts setup      # interactive wizard
# or, for a scripted machine:
bun run src/main.ts setup --yes
```

Build a standalone binary with:

```
bun build --compile src/main.ts --outfile dist/ytx
codesign --sign - dist/ytx        # macOS only: unsigned binaries are killed
```

The bundled speech sample used by `ytx models add`'s canary is embedded in the
binary with `import ... with { type: "file" }`.

### Setup installs no weights by default

`setup` (and the wizard) starts with `asr_model = "none"`: a fresh install is
captions-only until you ask for a model. Ask with any of:

```
ytx setup --with-model turbo      # 1.6 GB, best quality per gigabyte
ytx setup                         # answer the wizard's model question
ytx models add turbo              # install later
```

If a command reaches a point where it needs local transcription and no model is
configured, it prints the catalog with sizes and exits `2` instead of
downloading anything implicitly.

## Usage

### Archive a video

```
ytx add <url> [<url>...] [options]
```

| flag | meaning |
| --- | --- |
| `--max-height 1080` | ceiling for the archived video track |
| `--language en` | preferred caption language, or `auto` for the video's own |
| `--quality auto\|best` | accepted for compatibility; platform machine captions are not acquired |
| `--asr` | force local transcription |
| `--no-asr` | stop after human captions (exit 4 when none exist) |
| `--strict-lang` | never fall back to another language |
| `--allow-repetitive` | bypass the repetition gate for any source |
| `--parallel 2` | concurrent adds and transcriptions |
| `--cookies-from-browser chrome` | reuse a signed-in session |
| `--force` | re-archive an existing video |
| `--transcript-only` | transcript only; `--no-media` is the same thing |

The transcript is acquired first, so `list` and `search` are useful within
seconds; media downloads afterwards. Nothing is created in the library until a
transcript exists: a failed `add` leaves the store exactly as it was, and
`prune` cleans up any empty or meta-less directory an older build left behind.

```bash
# captions only, no media
ytx add https://www.youtube.com/watch?v=jNQXAC9IVRw --transcript-only

# force local Whisper even though captions exist
ytx add https://www.youtube.com/watch?v=jNQXAC9IVRw --asr
```

### Read and search

```
ytx show <id|url>                  # transcript + provenance header
ytx show <id> --raw                # transcript text only
ytx show <id> --format srt         # txt | json | srt | vtt | md
ytx show <id> --timestamps         # prefix each segment with its start time
ytx show <id> --history            # superseded transcripts

ytx transcript <id>                # read the store, print the transcript
ytx transcript <url>               # fetch and print without writing anything
ytx transcript <url> --format json --timestamps

ytx list --sort duration --limit 10
ytx list --source caption-human    # only human-written captions
ytx list --missing-transcript      # records with no usable transcript
ytx list --missing-media           # records whose media is absent or incomplete

ytx search "long trunks"
ytx search "never gonna"           # matches titles, channels and transcripts
ytx search "baaa" --transcripts    # transcript text only
ytx search "baaa" --source asr --context 80
```

Search is case-insensitive substring matching. Each hit says where it matched
(`title`, `channel`, or `transcript`); transcript hits carry a start timestamp
and title/channel hits do not.

```
$ ytx search "never gonna"
H dQw4w9WgXcQ title       Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)
H dQw4w9WgXcQ transcript 00:40  ♪ Gotta make you understand ♪ ♪ Never gonna give you up ♪ …
```

### Local transcription

`ytx add --asr` runs `mlx-whisper` in a `uv`-managed venv inside the runtime
directory. The audio is extracted to 16 kHz mono PCM first, and the model is
always passed as an explicit local directory, so a machine with weights
installed needs no network.

### Models

```
ytx models list
ytx models add turbo             # 1.6 GB, best quality per gigabyte
ytx models add turbo-q4          # 464 MB, quantized
ytx models add small             # 481 MB, faster and weaker
ytx models add large-v3          # 3.1 GB, most accurate and slowest
ytx models add owner/repo        # any MLX Whisper checkpoint
ytx models add hf.co/owner/repo
ytx models add owner/repo --revision <sha>
ytx models add --path ./local-model --as mine
ytx models verify --deep         # verify files and run the canary
ytx models default turbo-q4
ytx models path turbo
ytx models rm small
```

`add` checks the hub first, checks free disk, downloads with resume into a
staging directory, verifies file sizes, runs a canary transcription of a bundled
speech sample, and only then renames the directory into place. A killed download
leaves no installed model and no half-written directory - rerun the same command
and it resumes.

A custom repo is validated before downloading. The hub answers `401` both for a
repo that does not exist and for a private/gated one, so the message says both
and points at `hf.co/models?search=whisper` and `huggingface-cli login` rather
than pretending it knows which it is. A PyTorch checkpoint gets the MLX
equivalent named.

`rm` never damages transcripts: transcripts are already text on disk. It refuses
to remove the current default model and refuses to run while a transcription is
reading weights.

### Keeping the downloader current

```
ytx update --check         # report only, including the resolved source
ytx update                 # download, canary against reference videos, swap
ytx update --rollback      # put bin/yt-dlp.prev back
ytx update --all           # also rebuild the transcription venv
ytx update --from ./yt-dlp # adopt a binary you already have
```

`yt-dlp` is a self-managed standalone binary in the runtime directory, never a
package dependency. Every invocation passes `--ignore-config` so your own
`yt-dlp` configuration cannot change what `ytx` does, and every read parses `-J`
JSON rather than human-readable output.

`config.toml` decides which binary is used:

| `ytdlp` | behaviour |
| --- | --- |
| `auto` (default) | prefer `bin/yt-dlp`; fall back to a `yt-dlp` on `PATH` when the managed one is missing or its download fails |
| `managed` | only `bin/yt-dlp`; never fall back |
| `system` | only a `yt-dlp` on `PATH`; never download |

The fallback exists because a GitHub outage must not make the tool unusable on a
machine that already has a working `yt-dlp`. `doctor` prints the resolved source
and version, and every caption record stores `ytdlp_source` (`managed` or
`system`) next to `ytdlp_version`.

### Health

```
ytx doctor
ytx doctor --fix           # safe repairs: missing dirs, regenerable text, stale locks
```

Reports dependencies, installed models, record integrity, the retry queue, and
the provenance distribution (`H 5 · A 4 · M 3`). A corrupt record is named with
its failing field instead of aborting the scan; `--json` still produces one
document and exits `6`.

### Retry queue

```
ytx retry --dry-run            # show what is queued
ytx retry                      # drain due entries
ytx retry --all                # ignore the backoff
ytx retry --max-attempts 5     # drop entries that already failed five times
```

Transient upstream failures are queued with their class and next attempt time;
permanent ones (gone, private, bot check) are never queued.

### Exit codes

| code | meaning |
| --- | --- |
| 0 | ok |
| 2 | usage |
| 3 | fetch or dependency failure |
| 4 | no transcript obtainable |
| 5 | quality gate failed |
| 6 | store integrity error |
| 130 | interrupted (Ctrl-C) |

Every command accepts `--json`; every error names what failed, why, and the one
next action. Stack traces appear only with `--debug`.

## Where things go

| path | contents |
| --- | --- |
| `~/.ytx/library/` | the library: `config.toml`, `queue.jsonl`, `videos/` |
| `$XDG_DATA_HOME/ytx` (or `~/Library/Application Support/ytx`, `~/.local/share/ytx`) | runtime: `bin/yt-dlp`, `venv/`, `models/`, `state.json`, `logs/` |

Override the library with `--store <path>` or `YTX_HOME`. A `.ytx` directory in
the working directory shadows the default, so a project directory can own its
own library. Override model weights with `YTX_MODELS_DIR`.

The library is pure data and can be copied between machines; the runtime is
machine-local and is rebuilt by `ytx setup`.

## Development

```
bun test              # pure logic only: no network
bunx tsc --noEmit     # type check
```

See [`docs/architecture.md`](docs/architecture.md) for the directory split, the
provenance model, the acquisition ladder, and why each dependency exists.

## Caption sources in this build

`ytx` acquires **human captions** when the platform has them (preferred language
first, then another language), and otherwise **transcribes locally** with
Whisper. Platform machine captions are not acquired: YouTube's `timedtext`
endpoint rate-limited them with HTTP 429 (the translated `tlang` variants were
blocked outright), and a deterministic human-or-model pipeline is more useful
than a source that intermittently fails.

Consequences:

- `--quality auto` and `--quality best` behave the same; the flag is kept for
  compatibility.
- `--no-asr` on a video with no human captions exits `4`.
- The `caption-auto` provenance (`A`) remains in the schema and in `list`,
  `search --source caption-auto` and `doctor`, so a library archived before
  this change stays readable. New adds never produce it.

## Limits in v1

No playlist or channel sync (`ytx sync` exits `2` and says it is not implemented
in v1), no translation, no speaker diarization, no summarization, no web
interface, one extractor backend (`yt-dlp`), no cross-device sync service, no
punctuation restoration.

Two deliberate consequences of the rules are worth knowing:

- Human captions that repeat a chorus are accepted with a recorded warning;
  `--allow-repetitive` silences the repetition check.
- `setup` installs no model unless asked, so `ytx add` on a video with no human
  captions exits `2` and names the catalog instead of downloading weights.
