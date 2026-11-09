/**
 * Error taxonomy for ytx.
 *
 * Every user-facing failure carries three things: what failed, why, and the one
 * next action. Nothing in this file depends on the terminal, so the same error
 * renders as text or as JSON.
 */

export const EXIT = {
  ok: 0,
  usage: 2,
  fetch: 3,
  noTranscript: 4,
  quality: 5,
  integrity: 6,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** yt-dlp failure classes. `none` means "not a yt-dlp failure". */
export const FAILURE_CLASSES = [
  "bot-check",
  "needs-update",
  "format-unavailable",
  "transient",
  "gone-or-private",
  "none",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface YtxErrorOptions {
  /** What failed, phrased as the component: "captions for dQw4w9WgXcQ". */
  what: string;
  /** Why it failed, in one sentence. */
  why: string;
  /** The single next action the user can take. */
  next: string;
  /** Process exit code; one of EXIT. */
  code: number;
  /** yt-dlp failure class when this came from a downloader invocation. */
  failureClass?: FailureClass;
  /** Machine-readable tag for `--json` consumers. */
  kind?: string;
  cause?: unknown;
}

export class YtxError extends Error {
  readonly what: string;
  readonly why: string;
  readonly next: string;
  readonly code: number;
  readonly failureClass: FailureClass;
  readonly kind: string;
  override readonly cause?: unknown;

  constructor(opts: YtxErrorOptions) {
    super(`${opts.what}: ${opts.why}`);
    this.name = "YtxError";
    this.what = opts.what;
    this.why = opts.why;
    this.next = opts.next;
    this.code = opts.code;
    this.failureClass = opts.failureClass ?? "none";
    this.kind = opts.kind ?? "error";
    this.cause = opts.cause;
  }

  toJSON(): Record<string, unknown> {
    const out: Record<string, unknown> = {
      kind: this.kind,
      what: this.what,
      why: this.why,
      next: this.next,
      exit: this.code,
    };
    if (this.failureClass !== "none") out.failure_class = this.failureClass;
    return out;
  }
}

export function usageError(what: string, why: string, next: string): YtxError {
  return new YtxError({ what, why, next, code: EXIT.usage, kind: "usage" });
}

export function integrityError(what: string, why: string, next: string): YtxError {
  return new YtxError({ what, why, next, code: EXIT.integrity, kind: "integrity" });
}

export function fetchError(
  what: string,
  why: string,
  next: string,
  failureClass: FailureClass = "none",
): YtxError {
  return new YtxError({ what, why, next, code: EXIT.fetch, failureClass, kind: "fetch" });
}

export function noTranscriptError(what: string, why: string, next: string): YtxError {
  return new YtxError({ what, why, next, code: EXIT.noTranscript, kind: "no-transcript" });
}

export function qualityError(what: string, why: string, next: string): YtxError {
  return new YtxError({ what, why, next, code: EXIT.quality, kind: "quality" });
}

/** Turn any thrown value into a YtxError, keeping unexpected ones traceable. */
export function asYtxError(err: unknown, what: string, next: string): YtxError {
  if (err instanceof YtxError) return err;
  const reason = err instanceof Error ? err.message : String(err);
  return new YtxError({
    what,
    why: reason,
    next,
    code: EXIT.fetch,
    kind: "unexpected",
    cause: err,
  });
}
