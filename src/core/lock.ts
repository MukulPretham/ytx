/**
 * Advisory file locks under `<runtime>/locks`.
 *
 * Used for the two things that must not overlap: mutating the model directory
 * while a transcription is reading its weights, and two runs downloading the
 * same model at once. Locks carry the owning pid so a crash cannot wedge them.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { YtxError } from "./errors.ts";

export interface LockHandle {
  path: string;
  release: () => void;
}

export interface LockInfo {
  pid: number;
  owner: string;
  acquired_at: string;
}

export function lockPath(locksDir: string, name: string): string {
  return join(locksDir, `${name}.lock`);
}

export function readLock(path: string): LockInfo | null {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Partial<LockInfo>;
    if (typeof data.pid !== "number") return null;
    return {
      pid: data.pid,
      owner: data.owner ?? "unknown",
      acquired_at: data.acquired_at ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * `kill(pid, 0)` is the portable liveness probe: ESRCH means the process is
 * gone, EPERM means it exists but belongs to someone else.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireLock(
  locksDir: string,
  name: string,
  owner: string,
  options: { waitMs?: number; pollMs?: number } = {},
): LockHandle {
  const path = lockPath(locksDir, name);
  const waitMs = options.waitMs ?? 0;
  const pollMs = options.pollMs ?? 200;
  const deadline = Date.now() + waitMs;
  mkdirSync(locksDir, { recursive: true });

  for (;;) {
    const info: LockInfo = { pid: process.pid, owner, acquired_at: new Date().toISOString() };
    try {
      // `wx` is the atomic part: exactly one writer wins the creation.
      writeFileSync(path, JSON.stringify(info) + "\n", { encoding: "utf8", flag: "wx" });
      let released = false;
      return {
        path,
        release: () => {
          if (released) return;
          released = true;
          const held = readLock(path);
          if (held && held.pid === process.pid) rmSync(path, { force: true });
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new YtxError({
          what: `lock ${name}`,
          why: `cannot be created (${(err as NodeJS.ErrnoException).code ?? "unknown error"})`,
          next: `check permissions on ${locksDir}`,
          code: 6,
          kind: "integrity",
          cause: err,
        });
      }
    }

    const held = readLock(path);
    if (held && !isProcessAlive(held.pid)) {
      // The owner died without releasing. Reclaim rather than fail forever.
      rmSync(path, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      const who = held ? `pid ${held.pid} (${held.owner})` : "another process";
      throw new YtxError({
        what: `lock ${name}`,
        why: `held by ${who}`,
        next: `wait for it to finish, or remove ${path} if you are sure it is stale`,
        code: 3,
        kind: "locked",
      });
    }
    sleepSync(pollMs);
  }
}

export function isLocked(locksDir: string, name: string): LockInfo | null {
  const info = readLock(lockPath(locksDir, name));
  if (info && isProcessAlive(info.pid)) return info;
  return null;
}

/**
 * Node has no synchronous sleep; `Atomics.wait` on a private buffer is the
 * cheapest portable one and keeps `acquireLock` synchronous for callers.
 */
function sleepSync(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}
