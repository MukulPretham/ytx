/**
 * Subprocess plumbing.
 *
 * Every external tool (yt-dlp, ffmpeg, uv, the ASR python) goes through this so
 * that one place owns timeouts, output caps, and error text.
 */

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  stdin?: string;
  /** Called per line of stdout/stderr as it arrives, for progress output. */
  onStdoutLine?: (line: string) => void;
  onStderrLine?: (line: string) => void;
  /** Keep at most this many bytes of each stream; the tail is kept. */
  captureLimit?: number;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

const DEFAULT_CAPTURE_LIMIT = 4 * 1024 * 1024;

export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const started = Date.now();
  const limit = options.captureLimit ?? DEFAULT_CAPTURE_LIMIT;
  const stdout = new TailBuffer(limit);
  const stderr = new TailBuffer(limit);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn([command, ...args], {
      cwd: options.cwd,
      env: mergeEnv(options.env),
      stdin: options.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    return {
      code: 127,
      stdout: "",
      stderr: `cannot execute ${command}: ${(err as Error).message}`,
      timedOut: false,
      durationMs: Date.now() - started,
    };
  }

  let timedOut = false;
  const timer =
    options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          try {
            proc.kill();
          } catch {
            // The process may already have exited.
          }
        }, options.timeoutMs)
      : null;

  if (options.stdin !== undefined) {
    const stdin = proc.stdin as { write: (data: string) => void; end: () => void } | undefined;
    stdin?.write(options.stdin);
    stdin?.end();
  }

  await Promise.all([
    pump(proc.stdout as ReadableStream<Uint8Array>, stdout, options.onStdoutLine),
    pump(proc.stderr as ReadableStream<Uint8Array>, stderr, options.onStderrLine),
  ]);

  const code = await proc.exited;
  if (timer) clearTimeout(timer);

  return {
    code,
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    timedOut,
    durationMs: Date.now() - started,
  };
}

/** Run and throw on a non-zero exit, keeping both streams in the message. */
export async function runChecked(
  command: string,
  args: readonly string[],
  label: string,
  options: RunOptions = {},
): Promise<RunResult> {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = lastLines(result.stderr || result.stdout, 8);
    throw new Error(`${label} exited ${result.code}${detail ? `: ${detail}` : ""}`);
  }
  return result;
}

export function lastLines(text: string, count: number): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-count)
    .join("\n");
}

async function pump(
  stream: ReadableStream<Uint8Array>,
  sink: TailBuffer,
  onLine?: (line: string) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (value) {
      const text = decoder.decode(value, { stream: true });
      sink.push(text);
      if (onLine) {
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? "";
        for (const line of lines) if (line.trim() !== "") onLine(line);
      }
    }
    if (done) break;
  }
  if (onLine && pending.trim() !== "") onLine(pending);
}

class TailBuffer {
  private text = "";
  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    this.text += chunk;
    if (this.text.length > this.limit) this.text = this.text.slice(-this.limit);
  }

  toString(): string {
    return this.text;
  }
}

function mergeEnv(overrides?: Record<string, string | undefined>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) base[key] = value;
  }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}
