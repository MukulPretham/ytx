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

Every transcript records where it came from, and the three cases are never
collapsed into two: human-written captions (`H`), the platform's own speech
recognition (`A`), and a local Whisper model (`M`).

```
$ ytx list
H  jNQXAC9IVRw  19s     en    4    Me at the zoo

$ ytx show jNQXAC9IVRw
jawed — Me at the zoo
jNQXAC9IVRw · 19s · published 2005-04-24
provenance  H human captions · en · 4 segments · 214 chars · coverage 99% · yt-dlp 2026.10.26
media       jNQXAC9IVRw.mp4 (240p) · jNQXAC9IVRw.m4a · jNQXAC9IVRw.mp3
added       2026-11-09T04:30:44.259Z
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

## Usage

### Archive a video

```
ytx add <url> [<url>...] [options]
```

| flag | meaning |
| --- | --- |
| `--max-height 1080` | ceiling for the archived video track |
| `--language en` | preferred caption language, or `auto` for the video's own |
| `--quality auto\|best` | `best` skips the platform's machine captions |
| `--asr` | force local transcription |
| `--no-asr` | stop after platform captions (exit 4 when none exist) |
| `--strict-lang` | never fall back to another language |
| `--parallel 2` | concurrent adds and transcriptions |
| `--cookies-from-browser chrome` | reuse a signed-in session |
| `--force` | re-archive an existing video |
| `--no-media` | transcript only |

The transcript is acquired first, so `list` and `search` are useful within
seconds; media downloads afterwards.

### Read and search

```
ytx show <id|url>                 # transcript + provenance header
ytx show <id> --raw               # transcript text only
ytx show <id> --timestamps        # one segment per line, with start times
ytx show <id> --history           # superseded transcripts

ytx list --sort duration --limit 10
ytx list --source caption-human   # only human-written captions
ytx search "long trunks"
ytx search "baaa" --source asr --context 80
```

Search is case-insensitive substring matching over the stored segments, and
every match prints its video, provenance marker and start timestamp.

### Local transcription

`ytx add --asr` runs `mlx-whisper` in a `uv`-managed venv inside the runtime
directory. The audio is extracted to 16 kHz mono PCM first, and the model is
always passed as an explicit local directory, so a machine with weights
installed needs no network.

### Models

```
ytx models list
ytx models add turbo            # 1.6 GB, the recommended default
ytx models add small            # 481 MB, faster and weaker
ytx models add owner/repo       # any MLX Whisper checkpoint
ytx models add hf.co/owner/repo
ytx models verify --canary
ytx models default turbo-q4
ytx models path turbo
ytx models rm small
```

`add` checks the hub first, checks free disk, downloads with resume into a
staging directory, verifies file sizes, runs a canary transcription of a bundled
speech sample, and only then renames the directory into place. A killed download
leaves no installed model and no half-written directory - rerun the same command
and it resumes.

`rm` never damages transcripts: transcripts are already text on disk. It refuses
to remove the current default model and refuses to run while a transcription is
reading weights.

### Keeping the downloader current

```
ytx update --check     # report only
ytx update             # download, canary against reference videos, swap
ytx update --rollback  # put bin/yt-dlp.prev back
ytx update --all       # also rebuild the transcription venv
```

`yt-dlp` is a self-managed standalone binary in the runtime directory, never a
package dependency. Every invocation passes `--ignore-config` so your own
`yt-dlp` configuration cannot change what `ytx` does.

### Health

```
ytx doctor
```

Reports dependencies, installed models, record integrity, the retry queue, and
the provenance distribution (`H 5 · A 4 · M 3`). A corrupt record is named with
its failing field instead of aborting the scan.

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

## Limits in v1

No playlist or channel sync (`ytx sync` is a stub), no translation, no speaker
diarization, no summarization, no web interface, one extractor backend
(`yt-dlp`), no cross-device sync service, no punctuation restoration.
