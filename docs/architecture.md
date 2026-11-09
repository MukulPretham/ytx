# ytx architecture

Four contracts decide almost everything else here: the directory split, the
provenance model, the acquisition ladder, and the rule that records are
validated on every read and write. This note is the single owner of each.

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

The distinction that matters is `caption-human` versus `caption-auto`. Machine
captions are a model's output that happens to live on the platform; local Whisper
is a model's output that lives here. Recording both as "machine" would make the
most useful distinction in the library unanswerable: did a human write this, or
did a model guess at it?

Provenance surfaces everywhere: `list` prints `H`/`A`/`M`, `show` prints a
provenance header that `--raw` suppresses, `search --source caption-human`
filters, `doctor` prints the distribution, and `meta.json` stores it.

Alongside the source, `meta.json` records what makes the transcript reproducible:

- caption sources: `ytdlp_version`
- ASR: `model` and `model_revision` (a pinned hub commit)

The field that does not apply is absent, never `null`.

**Raw caption files are immutable; derived transcripts are replaceable.**
Re-running ASR never deletes a stored caption track, and every rewrite appends
the superseded transcript entry to `transcript_history`. Switching a video from
human captions to ASR therefore loses nothing: the `.vtt` stays, and the old
transcript record stays in history.

## Acquisition ladder

The first tier that passes the gates wins.

1. human captions in the preferred language
2. human captions in another language (the actual language is recorded)
3. the platform's machine captions in the preferred language
4. local transcription from the audio

`--quality best` skips tier 3, `--asr` forces tier 4, `--no-asr` stops after tier
3 (exit 4 when nothing passes), `--strict-lang` turns the preference into a hard
filter and removes tier 2.

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
| repetition | ≤ 25% duplicate lines |

A rejected track records its reason, and the ladder falls through. The
repetition gate measures duplicates *after* rolling windows are collapsed, so a
legitimate rolling track is not punished for the platform's cue format.

Note one honest consequence, observed while validating this build: a music
video whose human captions repeat a chorus line can exceed 25% duplicate lines
and be rejected at tier 1, which then sends it to tier 2 or 4. That is the
specified rule behaving as specified. `--strict-lang` keeps such a video in its
own language by refusing tier 2.

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
`search`, `retry`, `rm`, `prune`, `models`, and `sync` (a stub in v1).

Every command supports `--json`. Exit codes are `0` ok, `2` usage, `3` fetch or
dependency failure, `4` no transcript obtainable, `5` quality gate failed, `6`
store integrity error, `130` interrupted.

## Testing

`bun test` covers the pure logic only, with no network: caption parsing and
normalization (including rolling-window collapse), the quality gates, path
resolution and URL parsing, language detection, ladder planning, record schema
and transcript validation, config round-trips, failure classification, queue
backoff, the model catalog, and manifest validation.

Everything that touches the network or a Python process is verified by hand
against live videos; that evidence lives in the task record, not in `bun test`.
