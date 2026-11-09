import { describe, expect, test } from "bun:test";
import { classifyFailure, shouldRetry } from "../src/ytdlp/classify.ts";
import { nextAttemptAt, QueueEntrySchema, scheduleEntry, type QueueEntry } from "../src/core/queue.ts";
import { CATALOG, findCatalogEntry, modelDirName, parseRepoInput } from "../src/models/catalog.ts";
import { ManifestSchema, configuredModel, effectiveDefault } from "../src/models/manager.ts";
import { suggestMlxRepo } from "../src/models/hub.ts";

describe("classifyFailure", () => {
  test("recognizes a bot check and refuses to retry it", () => {
    const result = classifyFailure("ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser", 1);
    expect(result.class).toBe("bot-check");
    expect(shouldRetry(result)).toBe(false);
    expect(result.next).toContain("cookies-from-browser");
  });

  test("recognizes an out-of-date downloader", () => {
    const result = classifyFailure("WARNING: nsig extraction failed: Some formats may be missing", 1);
    expect(result.class).toBe("needs-update");
    expect(result.next).toContain("ytx update");
  });

  test("recognizes gone and private videos", () => {
    expect(classifyFailure("ERROR: [youtube] x: Private video. Sign in if you've been granted access", 1).class).toBe(
      "gone-or-private",
    );
    expect(classifyFailure("ERROR: [youtube] x: Video unavailable", 1).class).toBe("gone-or-private");
  });

  test("recognizes an unavailable format", () => {
    const result = classifyFailure("ERROR: [youtube] x: Requested format is not available", 1);
    expect(result.class).toBe("format-unavailable");
    expect(shouldRetry(result)).toBe(true);
  });

  test("treats rate limits and network errors as transient", () => {
    expect(classifyFailure("ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests", 1).class).toBe(
      "transient",
    );
    expect(classifyFailure("ERROR: Unable to download webpage: <urlopen error timed out>", 1).class).toBe("transient");
    expect(classifyFailure("ERROR: HTTP Error 503: Service Unavailable", 1).class).toBe("transient");
  });

  test("prefers bot-check over the 429 it arrives with", () => {
    const stderr = "ERROR: HTTP Error 429: Too Many Requests\nERROR: Sign in to confirm you're not a bot";
    expect(classifyFailure(stderr, 1).class).toBe("bot-check");
  });

  test("does not guess gone-or-private from a bare 404", () => {
    // "Video unavailable" is specific; a plain HTTP 404 is transient.
    expect(classifyFailure("ERROR: HTTP Error 404: Not Found", 1).class).toBe("transient");
  });

  test("falls back to transient for an unrecognized non-zero exit", () => {
    const result = classifyFailure("something entirely unexpected", 1);
    expect(result.class).toBe("transient");
    expect(result.evidence).toContain("something entirely unexpected");
  });

  test("reports none for a successful run", () => {
    expect(classifyFailure("", 0).class).toBe("none");
  });

  test("quotes the deciding line as evidence", () => {
    const stderr = "WARNING: first line\nERROR: [youtube] x: Private video\nWARNING: trailing";
    expect(classifyFailure(stderr, 1).evidence).toContain("Private video");
  });
});

describe("queue backoff", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");

  test("grows but is capped at one hour", () => {
    const first = nextAttemptAt(0, now, () => 0.5).getTime() - now.getTime();
    const later = nextAttemptAt(6, now, () => 0.5).getTime() - now.getTime();
    const capped = nextAttemptAt(20, now, () => 0.5).getTime() - now.getTime();
    expect(first).toBe(60_000);
    expect(later).toBeGreaterThan(first);
    expect(capped).toBe(3_600_000);
  });

  test("jitters within ±25 percent", () => {
    const low = nextAttemptAt(1, now, () => 0).getTime() - now.getTime();
    const high = nextAttemptAt(1, now, () => 1).getTime() - now.getTime();
    expect(low).toBe(90_000);
    expect(high).toBe(150_000);
  });

  test("scheduleEntry keeps the class and bumps the attempt count", () => {
    const entry: QueueEntry = {
      id: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      failure_class: "transient",
      attempts: 2,
      next_attempt_at: now.toISOString(),
      added_at: now.toISOString(),
      last_error: "boom",
      stage: "add",
    };
    const next = scheduleEntry(entry, 3, "still boom", now, () => 0.5);
    expect(next.attempts).toBe(3);
    expect(next.last_error).toBe("still boom");
    expect(next.failure_class).toBe("transient");
  });

  test("validates queue entries including the stage", () => {
    expect(
      QueueEntrySchema.safeParse({
        id: "dQw4w9WgXcQ",
        url: "u",
        failure_class: "transient",
        attempts: 0,
        next_attempt_at: now.toISOString(),
        added_at: now.toISOString(),
        last_error: "",
        stage: "media",
      }).success,
    ).toBe(true);
    expect(QueueEntrySchema.safeParse({ id: "x" }).success).toBe(false);
  });
});

describe("catalog", () => {
  test("resolves names case-insensitively and by repo", () => {
    expect(findCatalogEntry("TURBO")?.name).toBe("turbo");
    expect(findCatalogEntry("mlx-community/whisper-large-v3-turbo")?.name).toBe("turbo");
    expect(findCatalogEntry("nope")).toBeUndefined();
  });

  test("every entry carries a pinned revision and a size", () => {
    for (const entry of CATALOG) {
      expect(entry.revision).toMatch(/^[0-9a-f]{40}$/);
      expect(entry.repo).toContain("/");
      expect(entry.size_mb).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(10);
    }
    expect(CATALOG.filter((entry) => entry.default)).toHaveLength(1);
  });

  test("accepts repo shorthand and full URLs", () => {
    expect(parseRepoInput("mlx-community/whisper-tiny")).toBe("mlx-community/whisper-tiny");
    expect(parseRepoInput("hf.co/mlx-community/whisper-tiny")).toBe("mlx-community/whisper-tiny");
    expect(parseRepoInput("https://huggingface.co/mlx-community/whisper-tiny/tree/main")).toBe(
      "mlx-community/whisper-tiny",
    );
    expect(parseRepoInput("mlx-community/whisper-tiny/")).toBe("mlx-community/whisper-tiny");
    expect(parseRepoInput("not-a-repo")).toBeNull();
    expect(parseRepoInput("")).toBeNull();
  });

  test("names a model directory safely", () => {
    expect(modelDirName("turbo")).toBe("turbo");
    expect(modelDirName("mlx-community/whisper-tiny")).toBe("mlx-community--whisper-tiny");
    expect(modelDirName("https://huggingface.co/a/b")).toBe("a--b");
  });

  test("suggests the MLX equivalent of a PyTorch checkpoint", () => {
    expect(suggestMlxRepo("openai/whisper-large-v3")).toBe("mlx-community/whisper-large-v3-mlx");
    expect(suggestMlxRepo("openai/whisper-tiny")).toBe("mlx-community/whisper-tiny-mlx");
  });
});

describe("configured model resolution", () => {
  test("an explicit default wins over config", () => {
    expect(configuredModel("tiny", "turbo")).toBe("tiny");
  });

  test("config names the model when no default is stored", () => {
    expect(configuredModel(null, "turbo-q4")).toBe("turbo-q4");
    expect(configuredModel("", "small")).toBe("small");
  });

  test("none means ASR is not configured", () => {
    expect(configuredModel(null, "none")).toBe("none");
    expect(configuredModel("none", "none")).toBe("none");
    expect(effectiveDefault(null)).toBe("none");
  });
});

describe("model manifest", () => {
  test("accepts a fully described manifest", () => {
    const manifest = {
      schema: 1,
      name: "turbo",
      repo: "mlx-community/whisper-large-v3-turbo",
      revision: "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb",
      catalog: true,
      files: [{ name: "config.json", size: 268 }],
      total_bytes: 1614000000,
      installed_at: "2026-01-01T00:00:00.000Z",
      canary: { passed: true, text: "hello", at: "2026-01-01T00:00:00.000Z" },
    };
    expect(ManifestSchema.safeParse(manifest).success).toBe(true);
  });

  test("rejects a manifest with no revision", () => {
    expect(
      ManifestSchema.safeParse({
        schema: 1,
        name: "x",
        repo: "a/b",
        catalog: false,
        files: [],
        total_bytes: 0,
        installed_at: "2026-01-01T00:00:00.000Z",
        canary: null,
      }).success,
    ).toBe(false);
  });
});
