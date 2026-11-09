/**
 * Terminal output. Two modes matter: human (aligned, colored when a TTY) and
 * `--json` (one machine-readable object on stdout, everything else on stderr).
 */

import { YtxError } from "./errors.ts";

const ESC = "\u001b[";

export interface UiOptions {
  json?: boolean;
  debug?: boolean;
  /** Force color off; also set by NO_COLOR or a non-TTY. */
  color?: boolean;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}

export class Ui {
  readonly json: boolean;
  readonly debug: boolean;
  readonly color: boolean;
  private readonly out: NodeJS.WriteStream;
  private readonly err: NodeJS.WriteStream;
  private progressWidth = 0;

  constructor(options: UiOptions = {}) {
    this.json = options.json ?? false;
    this.debug = options.debug ?? false;
    this.out = options.stdout ?? process.stdout;
    this.err = options.stderr ?? process.stderr;
    const env = process.env;
    const colorEnv = env.NO_COLOR === undefined && env.TERM !== "dumb";
    this.color = options.color ?? (colorEnv && Boolean(this.out.isTTY) && !this.json);
  }

  /** Primary human output: results the user asked for. */
  line(text = ""): void {
    if (this.json) return;
    this.out.write(`${text}\n`);
  }

  /** Progress and diagnostics: always stderr, never mixed into JSON stdout. */
  note(text: string): void {
    if (this.json) return;
    this.err.write(`${text}\n`);
  }

  ok(text: string): void {
    this.line(`${this.paint("32", "✓")} ${text}`);
  }

  warn(text: string): void {
    this.note(`${this.paint("33", "!")} ${text}`);
  }

  fail(text: string): void {
    this.note(`${this.paint("31", "✗")} ${text}`);
  }

  heading(text: string): void {
    this.line(this.paint("1", text));
  }

  dim(text: string): string {
    return this.paint("2", text);
  }

  bold(text: string): string {
    return this.paint("1", text);
  }

  cyan(text: string): string {
    return this.paint("36", text);
  }

  printError(error: YtxError): void {
    this.err.write(`${this.paint("31", "ytx:")} ${this.bold(error.what)} — ${error.why}\n`);
    this.err.write(`  ${this.paint("33", "next:")} ${error.next}\n`);
    if (this.debug && error.cause instanceof Error && error.cause.stack) {
      this.err.write(`${error.cause.stack}\n`);
    }
  }

  /**
   * Single-line progress for downloads. On a TTY it overwrites itself; on a
   * pipe it stays silent, so logs and `--json` output are not flooded.
   */
  progress(label: string, fraction: number | null): void {
    if (this.json || !this.err.isTTY) return;
    const percent = fraction === null ? "" : ` ${Math.max(0, Math.min(100, Math.round(fraction * 100)))}%`;
    const text = `${label}${percent}`;
    const padded = text.padEnd(this.progressWidth, " ");
    this.progressWidth = text.length;
    this.err.write(`\r${padded}`);
  }

  progressDone(): void {
    if (!this.err.isTTY || this.progressWidth === 0) return;
    this.err.write(`\r${" ".repeat(this.progressWidth)}\r`);
    this.progressWidth = 0;
  }

  /** Emit the command's machine-readable result. */
  emit(payload: unknown): void {
    if (!this.json) return;
    this.out.write(`${JSON.stringify(payload, jsonReplacer, 2)}\n`);
  }

  private paint(code: string, text: string): string {
    if (!this.color) return text;
    return `${ESC}${code}m${text}${ESC}0m`;
  }
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Left/right pad a row of columns to fixed widths, for `list` and `doctor`. */
export function columns(rows: string[][], gap = 2): string[] {
  if (rows.length === 0) return [];
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, displayWidth(cell));
    });
  }
  return rows.map((row) =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : padEnd(cell, widths[index] ?? 0)))
      .join(" ".repeat(gap))
      .trimEnd(),
  );
}

function displayWidth(text: string): number {
  // Strip ANSI sequences before measuring.
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

function padEnd(text: string, width: number): string {
  const missing = width - displayWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

/** `2h 05m` style durations, used by list and show. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m${String(secs).padStart(2, "0")}s`;
  if (minutes > 0) return `${minutes}m${String(secs).padStart(2, "0")}s`;
  return `${secs}s`;
}

/** `3m 12s ago` style relative times, used by list and models. */
export function formatAge(iso: string, now = new Date()): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "unknown";
  const delta = Math.max(0, Math.floor((now.getTime() - then) / 1000));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86_400)}d ago`;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
