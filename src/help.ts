/**
 * Help text. One owner for the command surface: `ytx --help` lists commands,
 * `ytx <command> --help` explains that command's flags and exit codes.
 */

export const HELP = `ytx — archive YouTube videos with their transcripts

usage: ytx <command> [options]

commands
  init         create a library (config.toml, videos/)
  setup        install dependencies and run the first-run wizard
  update       refresh yt-dlp (canaried), or roll back
  doctor       check dependencies, records, models and provenance
  add          archive one or more videos
  transcript   re-acquire a transcript for an archived video
  show         print a transcript with its provenance header
  list         list archived videos (H human / A legacy machine / M local)
  search       search archived transcripts
  retry        drain queue.jsonl
  rm           delete archived videos
  prune        remove unfinished downloads and orphan directories
  models       list | add | rm | verify | default | path
  sync         not implemented in v1

global options
  --json                machine-readable output on stdout
  --debug               include stack traces
  --store <path>        library location (default: ~/.ytx/library)
  --yes                 accept confirmations
  --non-interactive     never prompt
  -h, --help            this text, or a command's help
  -V, --version         version

exit codes
  0 ok · 2 usage · 3 fetch or dependency · 4 no transcript
  5 quality gate failed · 6 store integrity · 130 interrupted

environment
  YTX_HOME              library location (after --store)
  YTX_MODELS_DIR        model weights location
  XDG_DATA_HOME         runtime directory root (binaries, venv, models)
`;

export const COMMAND_HELP: Record<string, string> = {
  init: `ytx init [path]

Create a library: config.toml with defaults, videos/, and an empty queue.
Idempotent; existing files are left alone.
`,
  setup: `ytx setup [options]

Bootstrap this machine. With a terminal it runs the wizard (library, language,
model, browser, confirm); otherwise it takes the defaults. Every step is
idempotent and resumable.

  --language <code>     preferred caption language (or "auto")
  --with-model <name>   catalog name or owner/repo; omit it to install no weights
  --browser <name>      cookies source for bot-check resilience, or "skip"
  --force               reinstall components that already exist

The default model is "none": setup never downloads weights unless you ask with
--with-model, answer the wizard's model question, or run \`ytx models add\`.
\`--model\` is accepted as an alias for --with-model.
`,
  update: `ytx update [options]

Download yt-dlp to a temporary path, canary it against the reference videos in
config.toml, and only then promote it. The previous binary is kept.

  --check       report installed vs latest and the resolved source, change nothing
  --nightly     follow the nightly channel
  --force       skip the canary
  --all         also rebuild the transcription venv
  --rollback    swap bin/yt-dlp.prev back in
  --from <path> adopt this binary into the runtime directory (verify, canary, promote)

With \`ytdlp = "auto"\` in config.toml, a failed download falls back to a
yt-dlp found on PATH. \`ytdlp = "managed"\` never falls back; \`ytdlp = "system"\`
never downloads.
`,
  doctor: `ytx doctor [options]

Report dependencies, models, records, queue and the provenance distribution.
Broken records are named individually instead of aborting the scan.

  --fix    repair safe, non-destructive problems (missing directories,
           regenerable transcript.txt files, stale locks, empty directories)
`,
  add: `ytx add <url> [<url>...] [options]

Archive video, audio and transcript. The transcript is acquired first so
\`list\` and \`search\` are useful immediately; media downloads afterwards.

  --max-height <n>             video height ceiling (default 1080)
  --language <code>            preferred caption language (or "auto")
  --quality auto|best          accepted for compatibility; platform machine captions are not acquired
  --asr                        force local transcription
  --no-asr                     stop after human captions (exit 4 if none)
  --strict-lang                never fall back to another language
  --allow-repetitive           bypass the repetition gate for any source
  --parallel <n>               concurrent transcriptions
  --cookies-from-browser <b>   chrome, safari, firefox, edge, brave
  --force                      re-archive an existing video
  --no-media                   transcript only (alias: --transcript-only)
  --transcript-only            transcript only; preferred spelling
`,
  transcript: `ytx transcript <id|url> [options]

With a URL, fetch and print a transcript without writing anything. With an
archived 11-character id, read the store and print it.

  --format txt|json|srt|vtt|md   output format (default txt)
  --timestamps                   prefix each segment with its start time
  --language <code>              preferred caption language (URL mode)
  --asr                          force local transcription (URL mode)
  --no-asr                       stop after human captions
  --strict-lang                  never fall back to another language
  --allow-repetitive             bypass the repetition gate
`,
  show: `ytx show <id|url> [options]

Print a transcript with a provenance header.

  --raw          transcript only (no header)
  --format <f>   txt | json | srt | vtt | md (default txt)
  --timestamps   prefix each segment with its start time
  --history      list superseded transcripts
`,
  list: `ytx list [options]

  --source <provenance>   caption-human | caption-auto | asr
  --sort <order>          recent | oldest | title | duration
  --limit <n>             show at most n rows
  --missing-transcript    only records with no usable transcript
  --missing-media         only records whose media is absent or incomplete
`,
  search: `ytx search <query> [options]

Searches titles, channel names and transcript text; each hit is labelled with
where it matched.

  --source <provenance>   caption-human | caption-auto | asr
  --transcripts           transcript text only
  --limit <n>             stop after n matches (default 20)
  --context <chars>       snippet width around a match (default 60)
  --id <id>               restrict to specific videos (repeatable)
`,
  retry: `ytx retry [options]

Retry queued work (transient failures and pending media downloads).

  --all                 ignore next_attempt_at
  --limit n             retry at most n entries (default 50)
  --max-attempts n      drop entries that have already failed n times
  --dry-run             list what would be retried, change nothing
`,
  rm: `ytx rm <id>... [options]

Delete archived videos from the library. Confirms unless --yes is passed.
Prints the bytes reclaimed.
`,
  prune: `ytx prune [options]

Remove unfinished model downloads, runtime scratch files, empty directories,
and video directories with no meta.json.

  --dry-run    list what would go
`,
  models: `ytx models <subcommand>

  list                installed models, sizes, default
  add <name|repo>     install (download → verify → canary → atomic rename)
  rm <name>           remove weights (transcripts are unaffected)
  verify [name...]    check files and sizes; --deep or --canary also transcribes
  default [name]      show or set the default model
  path [name]         print the models root or a model directory

  add options: --as <name>  --no-default  --force  --revision <sha>  --path <dir>
  verify options: --deep
`,
  sync: `ytx sync <url>

Playlist and channel sync is not implemented in v1. Archive videos individually
with \`ytx add\`.
`,
};
