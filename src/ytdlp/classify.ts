/**
 * yt-dlp failure classification.
 *
 * Exit codes are useless here: yt-dlp returns 1 for "the video is gone", "you
 * are rate limited", and "this binary is too old" alike. The class is read from
 * stderr, and each class has exactly one response.
 */

import type { FailureClass } from "../core/errors.ts";

export interface Classified {
  class: FailureClass;
  /** The stderr line that decided the class, for logs and `--json`. */
  evidence: string;
  /** The single next action for the user. */
  next: string;
  /** Whether the video is worth trying again later. */
  retryable: boolean;
}

interface Rule {
  class: FailureClass;
  patterns: RegExp[];
  next: string;
  retryable: boolean;
}

/**
 * Order matters. A bot check frequently arrives alongside a 429, and "video
 * unavailable" text appears inside many otherwise-transient pages, so the
 * specific classes are tested before the loose ones.
 */
const RULES: Rule[] = [
  {
    class: "bot-check",
    patterns: [
      /sign in to confirm (you'?re|your) not a bot/i,
      /confirm you'?re not a bot/i,
      /this content isn'?t available, try again later/i,
      /please sign in/i,
      /use --cookies-from-browser/i,
      /login required/i,
    ],
    next: "retry with a signed-in browser: `ytx add --cookies-from-browser chrome <url>` (or set it during `ytx setup`)",
    retryable: false,
  },
  {
    class: "gone-or-private",
    patterns: [
      /private video/i,
      /video unavailable/i,
      /this video is unavailable/i,
      /this video has been removed/i,
      /video has been removed by the uploader/i,
      /account associated with this video has been terminated/i,
      /removed for violating/i,
      /no longer available/i,
      /members[- ]only/i,
      /this video is only available to music premium/i,
    ],
    next: "the video is gone or private; nothing to archive",
    retryable: false,
  },
  {
    class: "needs-update",
    patterns: [
      /nsig extraction failed/i,
      /unable to extract (?:any )?(?:video )?player/i,
      /unable to extract (?:yt )?player response/i,
      /signature extraction failed/i,
      /your yt-?dlp is out of date/i,
      /unsupported url/i,
      /no such option/i,
      /unrecognized arguments/i,
    ],
    next: "run `ytx update` to refresh the downloader, then retry",
    retryable: false,
  },
  {
    class: "format-unavailable",
    patterns: [
      /requested format is not available/i,
      /no video formats found/i,
      /requested format not available/i,
      /format not available/i,
      /only images are available/i,
    ],
    next: "retry with another player client, then degrade to audio-only",
    retryable: true,
  },
  {
    class: "transient",
    patterns: [
      /http error 5\d\d/i,
      /http error 429/i,
      /too many requests/i,
      /timed out/i,
      /timeout/i,
      /temporary failure/i,
      /connection reset/i,
      /connection aborted/i,
      /connection refused/i,
      /remote end closed/i,
      /incompleteread/i,
      /network is unreachable/i,
      /getaddrinfo failed/i,
      /unable to download webpage/i,
      /giving up after/i,
      /content too short/i,
    ],
    next: "retrying later; `ytx retry` drains the queue",
    retryable: true,
  },
];

export const FAILURE_NEXT: Record<FailureClass, string> = {
  "bot-check": "retry with a signed-in browser",
  "needs-update": "run `ytx update`",
  "format-unavailable": "retry with another client, then audio-only",
  transient: "retry later",
  "gone-or-private": "there is nothing to archive",
  none: "check the command output", 
};

export function classifyFailure(stderr: string, exitCode: number): Classified {
  const text = stderr ?? "";
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text);
      if (match) {
        return {
          class: rule.class,
          evidence: evidenceLine(text, match.index),
          next: rule.next,
          retryable: rule.retryable,
        };
      }
    }
  }
  // A non-zero exit with nothing recognizable is treated as transient: the
  // commonest cause is a network hiccup, and retrying costs one request.
  if (exitCode !== 0) {
    return {
      class: "transient",
      evidence: evidenceLine(text, -1) || `exit code ${exitCode} with no recognized message`,
      next: FAILURE_NEXT.transient,
      retryable: true,
    };
  }
  return { class: "none", evidence: "", next: FAILURE_NEXT.none, retryable: false };
}

export function shouldRetry(classified: Classified): boolean {
  return classified.retryable;
}

function evidenceLine(text: string, index: number): string {
  const lines = text.split("\n");
  if (index < 0) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = (lines[i] ?? "").trim();
      if (line !== "") return line;
    }
    return "";
  }
  // Find the line containing the match offset.
  let offset = 0;
  for (const line of lines) {
    if (index >= offset && index <= offset + line.length) return line.trim();
    offset += line.length + 1;
  }
  return "";
}
