# Plan: `ytx import` — local media into the library

Status: **implemented.** This note is the design record; `docs/architecture.md`
owns the current contract. Two details changed while building it and are noted
below: the copy happens before transcription, and a bare 11-character argument is
treated as a path rather than a remote id.

## Goal

Add a new top-level command that archives a local media file with the same record
shape `ytx add` produces: a durable `videos/<id>/` directory with `meta.json`, the
original media, an audio track, an mp3, `transcript.json` and `transcript.txt`.

The motivating case is a video yt-dlp cannot fetch (deleted, region-locked,
already on disk) or an offline machine. It is deliberately a **separate command**:

- `ytx add` stays URL-only: its behaviour, preflight and queue handling are not
  touched. The one edit is the `next:` line of its "not a YouTube video URL"
  error, which gains "for a local file use `ytx import <path>`". So a typo in
  either direction gets the right command instead of a wrong one.

Non-goals for the first cut: importing a directory or playlist of files, sidecar
or embedded subtitle tracks, transcoding the video down to a height ceiling, and
referencing a file in place instead of copying it.

## What the user gets

```
$ ytx import ~/Movies/talk.mp4
local file · talk.mp4 · 42:10 · 1920x1080 · 1.4 GB
hashing and copying… done
  tier 4 · transcribing locally
✓ local-9f2c4a71b3de transcript archived (asr, 612 segments)
✓ media archived: local-9f2c4a71b3de.mp4 (1080p) · local-9f2c4a71b3de.m4a · local-9f2c4a71b3de.mp3
```

```
$ ytx list
M  local-9f2c4a71b3de  42m 10s  en  612  A talk about archives
```

```
videos/local-9f2c4a71b3de/
  meta.json
  local-9f2c4a71b3de.mp4     the source file, byte-for-byte
  local-9f2c4a71b3de.m4a     audio extracted from it
  local-9f2c4a71b3de.mp3     generated from the extracted audio
  transcript.json
  transcript.txt
```

There is no `caption.<lang>.vtt`: a local file has no platform track. The only
provenance an import can produce is `asr`.

## Decisions (need sign-off before coding)

| # | decision | recommendation |
| --- | --- | --- |
| D1 | Command name | `ytx import <path>...`. Reads as "bring this file into the library", leaves `add` untouched, and leaves room for `import --move` later. `ingest` is the alternate if `import` feels too generic. |
| D2 | How a local file is identified | `local-` + first 12 hex chars of the SHA-256 of the file's bytes. Deterministic, rename-proof, no collision with YouTube ids, and re-importing the same bytes is a no-op. |
| D3 | Copy, move, or reference the source | **Copy** into the library. `--move` and `--link` come later; referencing an absolute path would break "the library is pure data". |
| D4 | Sidecar `.srt`/`.vtt`, embedded subtitle streams | Not imported in v1. Detected and reported once: "found talk.srt; sidecar captions are not imported yet". Provenance for a sidecar is unknown (human or machine), and the three-value invariant must not be guessed. |
| D5 | Record schema | Bump `RECORD_SCHEMA` to `2`, add `origin: "youtube" \| "file"` (default `"youtube"` so v1 records still validate) and an optional `source` block. Old records keep `schema: 1`. |
| D6 | `ffprobe` | Becomes a hard dependency for import (duration, streams, title, chapters, height). `ytx setup` already downloads it and ignores failure; make that a reported, required step. |

If D2 is rejected, the fallback is `local-<slug>-<hash6>`, which reads better but
changes the id when a file is renamed, so the same bytes can be archived twice.

## Identity and record

### id

```
sha256(file bytes) = 9f2c4a71b3de…            (64 hex)
id                 = local-9f2c4a71b3de        (18 chars)
```

- Every YouTube id is still exactly 11 characters; `local-` is a disjoint
  namespace, so no command ever sends a local id to yt-dlp.
- The hash is computed while the file is copied (one pass), not by a separate
  read.
- Two copies of the same bytes in different directories resolve to the same id.
  The second import reports `already archived` and names the existing directory.

### `meta.json`

New fields, additive for YouTube records:

```jsonc
{
  "schema": 2,
  "origin": "file",
  "id": "local-9f2c4a71b3de",
  "url": "local:sha256:9f2c4a71b3de…",      // full 64-hex digest
  "source": {
    "kind": "file",
    "filename": "talk.mp4",                  // basename only, never a path
    "bytes": 1434210816,
    "sha256": "9f2c4a71b3de…"
  },
  "title": "A talk about archives",          // format tag, else file stem
  "channel": { "id": null, "name": "local file" },
  "duration_s": 2530,
  "published": "2026-03-14",                 // only from a creation_time tag
  "media": { "video": "local-9f2c4a71b3de.mp4", "audio": "…m4a", "mp3": "…mp3", "height": 1080 },
  "transcript": { "source": "asr", "language": "en", "model": "…", "model_revision": "…", … }
}
```

Rules enforced in `MetaSchema.superRefine`:

- `origin: "file"` requires `schema: 2`, an id matching `^local-[0-9a-f]{12}$`, a
  `source` block, and `url === "local:sha256:" + source.sha256`.
- `source.sha256` must start with the id's 12 hex characters, so a hand-edited
  id is refused.
- `origin: "youtube"` keeps the existing 11-character id and http(s) url and
  rejects `source`.
- `meta.url` stays an origin, not a filesystem path. No absolute path ever enters
  the library; `source.filename` is a basename, and `prune`/`doctor` never try to
  re-read the original.

`ytx doctor`'s "re-add with `ytx add --force <url>`" advice becomes origin-aware:
for file records it says the source path is not stored and points at
`ytx import <path> --force` instead.

### Provenance

Only `asr`, always. Tier 4 is the entire ladder for a local file:
`planLadder({ human: {}, auto: {}, originalLanguage: null })` already returns
exactly one step, so `captions/ladder.ts` needs no change.

`import` has no `--no-asr` flag at all: there is no other tier to fall back to,
so offering the flag would only create a guaranteed failure. (Internally the
acquisition options pass `noAsr: false`.)

## The command

```
ytx import <path>... [options]
```

| flag | meaning |
| --- | --- |
| `--language <code>` | Whisper language hint (default: `config.language`) |
| `--title <text>` | override the title; only valid with exactly one path |
| `--allow-repetitive` | silence the repetition warning |
| `--force` | re-import the same id, appending the old transcript to history |
| `--transcript-only` / `--no-media` | hash and transcribe only; copy no media |
| `--parallel <n>` | concurrent imports (default: `config.parallel`) |

Global flags (`--json`, `--store`, `--debug`, `--yes`, `--non-interactive`) work
as everywhere else. There is deliberately no `--max-height`, no `--quality`, no
`--cookies-from-browser` and no `--asr` on this command: they describe an
acquisition decision that a local file does not have. `add`'s flags are not
mirrored.

### Paths, not URLs

`import` has one target kind, so classification is trivial:

1. `~` is expanded; `file://…` is percent-decoded to a path.
2. A path must exist and be a regular file. A directory → exit `2` "pass the
   files, not the directory" (`./talks/*.mp4` is the shell's job for now).
3. A URL (`http://`, `https://`, …) → exit `2` "import takes a local file; use
   `ytx add <url>`". A bare 11-character argument is treated as a path; if no
   such file exists, the error points at `ytx show <id>` / `ytx add <url>`, so a
   file that happens to be named like a video id still imports.
4. No extension allow-list: ffprobe is the authority on whether the file is
   media, and a wrong extension is not an error.

Multiple paths are allowed and share one worker pool, like `add`. If one succeeds
and another fails, the successes stay and the command exits with the first
failure — the same policy as `add`.

### Preflight, before anything is written

Checked in this order, all before `ensureLibrary` creates a store skeleton:

1. every path exists, is a regular file, and is readable;
2. `ffprobe` and `ffmpeg` are available (`ytx setup`);
3. a model is configured (`asr_model != "none"`) and installed;
4. the mlx-whisper venv is usable.

yt-dlp is never consulted. A machine with no yt-dlp at all can import. The model
check runs before the first byte is copied, so `asr_model = "none"` costs nothing
but the catalog message and exit `2`.

### Output and `--json`

Human output mirrors `add` (`local file · …`, a `tier 4` note, a final `✓` per
file). `--json` emits:

```json
{ "imported": ["local-9f2c4a71b3de"], "failed": [] }
```

with `failed[]` carrying `error.toJSON()` exactly as `add` does.

### What does not change

- `ytx add`, its preflight and its queue behaviour — untouched, apart from the
  one-line `next:` hint described above.
- `ytx retry` — `import` never enqueues; a failed import is re-run by hand.
- `ytx sync`, `ytx setup` prompts, `ytx models` — untouched.

One small exception, required for local records to be usable at all:

- `show` / `rm` / `transcript` must accept a `local-…` id. `requireTarget` and
  `cmdTranscript`'s "looks like a URL" test currently hard-code the 11-character
  YouTube shape; they switch to a shared `isArchiveId()`.

`ytx transcript <path>` preview is **not** part of this command. Import is the
local entry point; a path in `transcript` is a follow-up.

### Blast radius on existing commands

Explicitly unchanged: the `add` flow (fetch → ladder → gates → media), the three
provenance values, exit codes, `--json` shapes on existing commands, config keys,
library path resolution, `setup`/`update`/`models`/`sync`, and the on-disk layout
of every existing record.

Shared code that does change, with its worst case:

| change | effect on URL workflows |
| --- | --- |
| `isArchiveId()` in `requireTarget`/`cmdTranscript` | accepts `local-…` in addition to 11-char ids; existing ids behave identically |
| one `next:` line in `add`'s URL error | wording only |
| `doctor` gains an ffprobe row and origin-aware re-add advice | one more check line; URL advice identical |
| `prune` also removes `videos/.incoming-*` / `.trash-*` | none today; those names did not exist before |
| `probeHeight` uses the resolved ffprobe | may report a height where the sibling-only lookup found none |
| `findExistingAudio` also accepts `flac`/`wav` | only matters if such a file is already sitting in a video directory |
| `MetaSchema` gains optional `origin`/`source`, id union | v1 records still validate; `origin` reads as `"youtube"` |

Nothing else in the URL path is edited. If any of these should stay untouched,
the alternative is duplicating the id routing and ffprobe lookup in `import`,
which is worse for exactly the reason the project keeps one owner per rule.

## Pipeline

```
 resolve paths, probe each (ffprobe -show_format -show_streams -show_chapters)
       │  duration, height, audio codec, title, chapters, creation_time, bytes
       ▼
  videos/.incoming-<rand>/
       │  copy + sha256 in one pass  [hash only with --transcript-only]
       │  audio-only: the copy is the audio track; nothing is extracted
       │  video: extract audio → <id>.<audio ext>  (copy when the codec fits, else AAC .m4a)
       ▼
  id known → already archived?  →  acquireTranscript(availability: empty)
       │  tier 4 only; existing gates, normalization, model checks unchanged
       ▼
  mp3 (skipped for an mp3 source), transcript.json/txt, meta.json into staging
       │
       ▼
  publish: one rename for a new record, meta.json last for --force
```

Why this order:

- **The id is known before ASR.** Copying and hashing share one read, so a
  re-import of the same bytes is rejected in seconds instead of after an hour of
  transcription. The already-archived check runs before the model is loaded.
- **The transcript still comes first.** Nothing appears in `videos/<id>/` until a
  transcript exists, so the "no partial store" rule holds for imports too. A
  failure after the copy leaves only a dot directory, removed by the command's
  cleanup or by `prune`.
- **The staging directory is inside the library**, not in the runtime tmp: a
  multi-gigabyte rename across filesystems would fail (EXDEV) or double the copy.
  It is a dot directory, so `listVideoIds` already ignores it; `prune` gains an
  explicit `.incoming-*` / `.trash-*` sweep.
- **Two reads of the source, never three**: copy+hash, then audio extraction.
  Audio-only inputs need no extraction at all. With `--transcript-only`, one read
  for the hash and one for extraction.

### Media mapping

| source stream | what lands in the library |
| --- | --- |
| video (any codec the container holds) | `media.video = <id>.<ext>` — copied, never re-encoded; `height` from ffprobe |
| AAC audio | `<id>.m4a`, stream-copied |
| mp3 / opus / vorbis / flac / alac audio | kept in its natural container (`.mp3`, `.opus`, `.ogg`, `.flac`), stream-copied; an mp3 source needs no generated mp3, so `media.mp3` is null and `media.audio` is the mp3 |
| anything else | transcoded to AAC `<id>.m4a` (the original file keeps the untouched bytes) |
| no video stream (audio-only input) | no extraction at all: the copied source *is* `media.audio` (`<id>.<ext>`, original bytes), `media.video = null`, `height = null`, mp3 generated from it |
| no audio stream | exit `4` before anything is written: nothing to transcribe |

`media.audio` is not required to end in `.m4a`; the schema already accepts any
relative filename. `findExistingAudio` gains `flac` and `wav` so a re-used local
audio file is recognised.

### Title, channel, chapters

- Title: `format_tags.title`, else the file stem; `--title` wins when given.
- Channel: `{ id: null, name: "local file" }`. `show` already prints
  `${channel.name} — ${title}`, which reads as "local file — A talk about archives".
- Published: `format_tags.creation_time` when it parses as a date, else `null`.
- Chapters: ffprobe chapters mapped to `{ start_s, title }`; none otherwise.

## File map

| file | change |
| --- | --- |
| `src/main.ts` | `import` in `COMMAND_OPTIONS`, dispatch to `cmdImport` |
| `src/commands/import.ts` | **new** — `cmdImport`, preflight, worker pool, output |
| `src/local/identify.ts` | **new** — `resolveLocalTarget(input, cwd)`, `localIdForSha256`, `isLocalId` |
| `src/local/probe.ts` | **new** — `probeMedia(ffprobe, path)` and a pure `parseProbeJson` |
| `src/local/importer.ts` | **new** — hash-and-copy, audio extraction mapping, mp3, finalize/swap |
| `src/core/schema.ts` | `origin`, `source`, id union, cross-field refinements, `RECORD_SCHEMA = 2` |
| `src/core/paths.ts` | `LOCAL_ID_RE`, `isArchiveId`, `RuntimePaths.ffprobe` |
| `src/commands/context.ts` | `context.ffprobe`, `requireFfprobe` |
| `src/commands/library.ts` | `requireTarget` and `cmdTranscript` use `isArchiveId`; the `add` usage error gains a `ytx import` hint; no other change |
| `src/commands/system.ts` | doctor ffprobe row, origin-aware repair advice |
| `src/ytdlp/run.ts` | `probeHeight` uses the resolved ffprobe instead of `join(ffmpeg, "..", "ffprobe")` |
| `src/core/record.ts` | staging helpers for `prune` |
| `src/help.ts` | `HELP` command list and a `COMMAND_HELP.import` entry |
| `README.md`, `docs/architecture.md`, `AGENTS.md` | the command, the new invariant, the remaining gaps |
| `tests/{import,probe,id}.test.ts`; `tests/record.test.ts`, `tests/paths.test.ts` | see below |

Rough size: ~500 lines of source, ~250 lines of tests, ~150 lines of docs.

## Failure and exit codes

| situation | exit | message shape |
| --- | --- | --- |
| path does not exist / is a directory / is a URL | 2 | what: `import ./talk.mp4`; why; next: check the path or use `ytx add` |
| file exists but ffprobe cannot read it | 3 | why: ffprobe's first error line; next: check the file with `ffprobe` |
| ffmpeg/ffprobe missing | 3 | next: `ytx setup` |
| `asr_model = "none"` | 2 | catalog + `ytx models add <name>` (before any bytes are copied) |
| no audio stream | 4 | "nothing to transcribe"; next: re-mux with an audio track |
| ASR returns no segments | 4 | "no speech was recognized"; next: `--language`, or check the audio |
| source unreadable mid-copy (permissions, disk full) | 3 | incoming directory removed; store unchanged |
| id already archived | 2 | `ytx show <id>`, or `--force` to re-import |
| interrupted (Ctrl-C) | 130 | `.incoming-*` remains, invisible to `list`, removed by `prune` |

Nothing is ever written to `queue.jsonl` by `import`, so the queue's
"retry a URL" contract stays intact.

## Tests (pure, no network, no ffmpeg)

- `resolveImportPath`: `~`, `file://` + percent-decoding, relative and absolute
  paths, and a file whose name looks like a video id (which stays a path).
  `looksRemote` separates URLs from paths without touching the filesystem.
- `localIdForSha256`: format, determinism, disjointness from YouTube ids;
  `isArchiveId` accepts both shapes and rejects `local-` with the wrong length.
- `parseProbeJson`: a captured ffprobe document → duration, height, video/audio
  codec, title, chapters, creation time; a video-only file; an audio-only file.
- audio mapping table: each codec → expected extension / transcode decision.
- schema: local record round-trips; `url`/id/hash mismatch is refused; absolute
  `media` paths still refused; a v1 YouTube record still validates untouched.
- ladder: empty availability → one tier-4 step.
- routing: `isArchiveId("local-…")` is true; `ytx transcript <local-id>` reads the
  store; command dispatch rejects an unknown command without touching `import`.
- queue: no code path in `cmdImport` calls `enqueue` (assert by construction in
  review; the queue module itself is unchanged).

## Live verification (the AGENTS.md matrix, extended)

1. Regression: a URL with human captions still archives `caption-human` via `add`.
2. `import ./talk.mp4` with `asr_model = none` → exit 2, `videos/` unchanged.
3. Same file with a model → `asr` record, coverage ≥ 0.9, three media files.
4. Re-import the same bytes from another directory → exit 2, same id; `--force`
   → same id, history grows, `added_at` preserved.
5. `--transcript-only` → transcript present, `media.* = null`.
6. `.mkv` with Opus → `.mkv` kept, audio `.opus`, mp3 generated.
7. Audio-only `.mp3` → `media.video = null`, `height = null`, `media.audio` is
   the original bytes.
8. `.mp4` with no audio stream → exit 4, no `videos/local-*`.
9. Silent audio → exit 4, no `videos/local-*`.
10. Ctrl-C during the copy → only `.incoming-*`; `list` unaffected; `prune`
    removes it; the store is otherwise byte-identical.
11. `import https://www.youtube.com/watch?v=…` → exit 2 pointing at `ytx add`;
    `add ./talk.mp4` → exit 2 whose `next:` line names `ytx import`.
12. `doctor` after an import → no false media failures, re-add advice is
    origin-aware.
13. Two concurrent imports of the same file → one wins, the other says
    already-archived.
14. `--store` on a different filesystem from `$TMPDIR` → still no EXDEV
    (staging lives in the library).

## Phases

1. **Foundations** — schema, ids, path resolution, ffprobe plumbing, probe parser,
   tests. No user-visible change; `bun test` and `tsc --noEmit` clean.
2. **The command** — `main.ts` wiring, `cmdImport`, staging, copy+hash, audio
   extraction, `--force`, `--transcript-only`, help entry. Feature is usable.
3. **Surfaces** — `isArchiveId` routing in `show`/`rm`/`transcript`, doctor,
   prune, setup/ffprobe.
4. **Docs + live matrix** — README, architecture, AGENTS.md; run the matrix above
   and keep the terminal captures with the task record.

Each phase must leave `bun test` and `bunx tsc --noEmit` clean.

## Follow-ups deliberately left out

- `import --move` (delete the source after a verified copy) and `--link`
  (hardlink).
- Sidecar `.srt`/`.vtt` import, with an explicit provenance decision.
- Embedded subtitle extraction from mkv/mp4.
- Several files or a directory as one command (`ytx import ./talks/*.mp4` is the
  shell's job for now).
- `ytx transcript <path>` preview, and `show`/`search` by path.
- `ytx verify` to re-hash a local record and report bit rot
  (`source.sha256` makes this cheap).
- Archiving a local video with **no** transcript (a silent screen recording).
  Today the record requires a transcript; allowing `--no-transcript` would need
  a nullable `meta.transcript` and would break the "transcript first" invariant.
- A machine-local source map in the runtime directory, so `doctor` can offer a
  working re-import command without storing paths in the library.
