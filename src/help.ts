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
  list         list archived videos (H human / A machine / M local)
  search       search archived transcripts
  retry        drain queue.jsonl
  rm           delete archived videos
  prune        remove unfinished downloads and orphan directories
  models       list | add | rm | verify | default | path
  sync         playlist and channel sync (stub in v1)

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
  --model <name>        catalog name, owner/repo, or "none"
  --browser <name>      cookies source for bot-check resilience, or "skip"
  --force               reinstall components that already exist
`,
  update: `ytx update [options]

Download yt-dlp to a temporary path, canary it against the reference videos in
config.toml, and only then promote it. The previous binary is kept.

  --check       report installed vs latest, change nothing
  --nightly     follow the nightly channel
  --force       skip the canary
  --all         also rebuild the transcription venv
  --rollback    swap bin/yt-dlp.prev back in
`,
  doctor: `ytx doctor

Report dependencies, models, records, queue and the provenance distribution.
Broken records are named individually instead of aborting the scan.
`,
  add: `ytx add <url> [<url>...] [options]

Archive video, audio and transcript. The transcript is acquired first so
\`list\` and \`search\` are useful immediately; media downloads afterwards.

  --max-height <n>             video height ceiling (default 1080)
  --language <code>            preferred caption language (or "auto")
  --quality auto|best          "best" skips platform machine captions
  --asr                        force local transcription
  --no-asr                     stop after platform captions (exit 4 if none)
  --strict-lang                never fall back to another language
  --parallel <n>               concurrent transcriptions
  --cookies-from-browser <b>   chrome, safari, firefox, edge, brave
  --force                      re-archive an existing video
  --no-media                   transcript only
`,
  transcript: `ytx transcript <id|url> [options]

Re-acquire the transcript for an archived video. The superseded transcript is
appended to transcript_history; raw caption tracks are never deleted.

  --quality auto|best   --asr   --no-asr   --strict-lang   --language <code>
`,
  show: `ytx show <id|url> [options]

Print a transcript with a provenance header.

  --raw          transcript text only (no header)
  --timestamps   prefix each segment with its start time
  --history      list superseded transcripts
`,
  list: `ytx list [options]

  --source <provenance>   caption-human | caption-auto | asr
  --sort <order>          recent | oldest | title | duration
  --limit <n>             show at most n rows
`,
  search: `ytx search <query> [options]

  --source <provenance>   caption-human | caption-auto | asr
  --limit <n>             stop after n matches (default 20)
  --context <chars>       snippet width around a match (default 60)
  --id <id>               restrict to specific videos (repeatable)
`,
  retry: `ytx retry [options]

Retry queued work (transient failures and pending media downloads).

  --all      ignore next_attempt_at
  --limit n  retry at most n entries (default 50)
`,
  rm: `ytx rm <id>... [options]

Delete archived videos from the library. Confirms unless --yes is passed.
`,
  prune: `ytx prune [options]

Remove unfinished model downloads, runtime scratch files, and video directories
with no meta.json.

  --dry-run    list what would go
`,
  models: `ytx models <subcommand>

  list                installed models, sizes, default
  add <name|repo>     install (download → verify → canary → atomic rename)
  rm <name>           remove weights (transcripts are unaffected)
  verify [name...]    check files and sizes; --canary also transcribes
  default [name]      show or set the default model
  path [name]         print the models root or a model directory

  add options: --as <name>  --no-default
`,
  sync: `ytx sync <url>

Playlist and channel sync is a stub in v1. Archive videos individually with
\`ytx add\`.
`,
};
