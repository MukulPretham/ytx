/**
 * Turning an `ytx import` argument into an absolute path.
 *
 * Deliberately free of filesystem calls: existence and file type are checked by
 * the command, so the interesting parsing rules stay unit testable. `import`
 * has one target kind (a path), so there is no precedence puzzle with URLs —
 * only an explicit refusal, because pointing a local-file command at a URL is a
 * mistake worth naming.
 */

import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ImportPathInputs {
  cwd: string;
  home: string;
}

const URL_SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//i;

/** True for `http(s)://…` and every other network-style scheme. */
export function looksRemote(input: string): boolean {
  const raw = input.trim();
  return URL_SCHEME_RE.test(raw) && !/^file:/i.test(raw);
}

/**
 * `file:///tmp/talk.mp4` and `file://localhost/tmp/talk.mp4` are paths;
 * everything else is passed through unchanged.
 */
export function decodePathInput(input: string): string {
  const raw = input.trim();
  if (!/^file:/i.test(raw)) return raw;
  return fileURLToPath(new URL(raw));
}

/** Expand `~`, decode `file://`, and resolve against the working directory. */
export function resolveImportPath(input: string, inputs: ImportPathInputs): string {
  let raw = decodePathInput(input);
  if (raw === "~") raw = inputs.home;
  else if (raw.startsWith("~/")) raw = join(inputs.home, raw.slice(2));
  return isAbsolute(raw) ? resolve(raw) : resolve(inputs.cwd, raw);
}

/** The filename shown in the record and on screen; never a directory. */
export function displayName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
