/**
 * Local speech-to-text.
 *
 * Two subprocesses: ffmpeg to get 16 kHz mono PCM, then the venv's Python to run
 * mlx-whisper. The model is always passed as an explicit directory, never a hub
 * id, so transcription works offline once the weights are installed.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fetchError, qualityError, YtxError } from "../core/errors.ts";
import { lastLines, run } from "../core/exec.ts";
import type { RuntimePaths } from "../core/paths.ts";
import type { TranscriptSegment } from "../core/schema.ts";
import { ensureVenv } from "./venv.ts";
// `with { type: "file" }` is what makes the sample survive `bun build --compile`:
// the WAV is embedded in the binary instead of being read from the source tree.
import CANARY_WAV from "../../assets/canary.wav" with { type: "file" };

/**
 * Runs inside the venv. It only speaks JSON on stdout; mlx-whisper's own
 * progress goes to stderr so the parent can tell output from chatter.
 */
export const ASR_SCRIPT = `import json, sys

def main() -> int:
    audio, model_dir = sys.argv[1], sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] not in ("", "auto") else None
    from mlx_whisper import transcribe

    result = transcribe(
        audio,
        path_or_hf_repo=model_dir,
        language=language,
        task="transcribe",
        verbose=False,
        condition_on_previous_text=False,
        word_timestamps=False,
    )
    segments = []
    for segment in result.get("segments", []):
        text = (segment.get("text") or "").strip()
        if text == "":
            continue
        segments.append({
            "start": float(segment["start"]),
            "end": float(segment["end"]),
            "text": text,
        })
    print(json.dumps({"segments": segments, "language": result.get("language")}, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
`;

export interface AsrOptions {
  runtime: RuntimePaths;
  ffmpeg: string;
  modelPath: string;
  modelName: string;
  language: string;
  audioPath: string;
  /** Scratch directory for the 16 kHz WAV and the generated script. */
  workDir: string;
  onLine?: (line: string) => void;
}

export interface AsrResult {
  segments: TranscriptSegment[];
  /** Language whisper actually detected/used. */
  language: string;
  version: string;
}

export async function transcribe(options: AsrOptions): Promise<AsrResult> {
  if (!existsSync(options.modelPath)) {
    throw new YtxError({
      what: `model ${options.modelName}`,
      why: `is not installed at ${options.modelPath}`,
      next: "run `ytx models add` to install it, or `ytx models list` to see what is available",
      code: 3,
      kind: "model-missing",
    });
  }

  const venv = await ensureVenv(options.runtime, { onLine: options.onLine });
  mkdirSync(options.workDir, { recursive: true });

  const wav = join(options.workDir, "asr-16k.wav");
  const script = join(options.workDir, "asr.py");
  writeFileSync(script, ASR_SCRIPT, "utf8");

  const extracted = await run(
    options.ffmpeg,
    ["-y", "-loglevel", "error", "-i", options.audioPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", wav],
    { timeoutMs: 30 * 60_000, onStderrLine: options.onLine },
  );
  if (extracted.code !== 0) {
    throw qualityError(
      "extract audio for transcription",
      lastLines(extracted.stderr, 4) || `ffmpeg exited ${extracted.code}`,
      "check that the downloaded audio plays; `ytx add` again if the file looks truncated",
    );
  }

  const started = Date.now();
  const result = await run(
    venv.python,
    [script, wav, options.modelPath, options.language],
    {
      timeoutMs: 6 * 60 * 60_000,
      onStderrLine: (line) => {
        if (options.onLine && !/^\s*(it|\[|100%|0%)/.test(line)) options.onLine(line);
      },
    },
  );
  rmSync(wav, { force: true });

  if (result.code !== 0) {
    throw fetchError(
      "transcribe audio",
      lastLines(result.stderr, 6) || `mlx-whisper exited ${result.code} after ${Math.round((Date.now() - started) / 1000)}s`,
      "run `ytx models verify`, then retry; if it repeats, `ytx update --all` rebuilds the venv",
    );
  }

  let payload: { segments?: unknown; language?: unknown };
  try {
    payload = JSON.parse(lastJsonLine(result.stdout)) as { segments?: unknown; language?: unknown };
  } catch (err) {
    throw fetchError(
      "transcribe audio",
      `the transcriber did not return JSON (${(err as Error).message.split("\n")[0]})`,
      "run `ytx update --all` to rebuild the transcription environment",
    );
  }

  const segments: TranscriptSegment[] = [];
  for (const raw of Array.isArray(payload.segments) ? payload.segments : []) {
    const segment = raw as { start?: unknown; end?: unknown; text?: unknown };
    const start = Number(segment.start);
    const end = Number(segment.end);
    const text = typeof segment.text === "string" ? segment.text.trim() : "";
    if (!Number.isFinite(start) || !Number.isFinite(end) || text === "" || end < start) continue;
    segments.push({ start: round(start), end: round(end), text });
  }

  return {
    segments,
    language:
      typeof payload.language === "string" && payload.language !== ""
        ? payload.language
        : options.language === "auto"
          ? "unknown"
          : options.language,
    version: venv.mlx_whisper,
  };
}

/** The bundled speech sample used to prove a model actually transcribes. */
export function canaryAudioPath(): string {
  return CANARY_WAV;
}

/**
 * Write the bundled sample somewhere a subprocess can open it.
 *
 * Inside a compiled binary the embedded asset lives on Bun's virtual filesystem,
 * which ffmpeg - an external process - cannot read. Materializing it is also what
 * keeps dev and compiled behaviour identical.
 */
export async function materializeCanary(workDir: string): Promise<string> {
  const target = join(workDir, "canary.wav");
  mkdirSync(workDir, { recursive: true });
  if (!existsSync(target)) {
    await Bun.write(target, Bun.file(CANARY_WAV));
  }
  return target;
}

export async function runCanary(
  options: Omit<AsrOptions, "audioPath" | "language" | "workDir"> & { workDir?: string },
): Promise<string> {
  const workDir = options.workDir ?? join(options.runtime.tmp, `canary-${process.pid}`);
  const audioPath = await materializeCanary(workDir);
  const result = await transcribe({
    ...options,
    audioPath,
    language: "en",
    workDir,
  });
  return result.segments.map((segment) => segment.text).join(" ").trim();
}

function lastJsonLine(stdout: string): string {
  const lines = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("{"));
  const last = lines[lines.length - 1];
  if (!last) throw new Error("no JSON line on stdout");
  return last;
}

function round(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
