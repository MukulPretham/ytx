import { describe, expect, test } from "bun:test";
import { run } from "../src/core/exec.ts";

describe("subprocess capture", () => {
  test("keeps output larger than the default tail when given a bigger ceiling", async () => {
    const size = 5 * 1024 * 1024;
    const result = await run(
      "bun",
      ["-e", `process.stdout.write("x".repeat(${size}))`],
      { captureLimit: 8 * 1024 * 1024, timeoutMs: 30_000 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(size);
  });

  test("the default ceiling keeps the tail, not the head", async () => {
    const size = 5 * 1024 * 1024;
    const result = await run(
      "bun",
      ["-e", `process.stdout.write("x".repeat(${size}))`],
      { timeoutMs: 30_000 },
    );
    expect(result.code).toBe(0);
    // The default is 4 MB, so the 5 MB output is truncated from the front.
    expect(result.stdout.length).toBe(4 * 1024 * 1024);
    expect(result.stdout.startsWith("x")).toBe(true);
  });
});
