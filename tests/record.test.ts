import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLibraryPaths, videoDir, type LibraryPaths } from "../src/core/paths.ts";
import {
  META_FILE,
  listVideoIds,
  parseTranscriptText,
  readAllMeta,
  readMeta,
  readTranscript,
  renderTranscriptText,
  tryReadMeta,
  writeMeta,
  writeTranscript,
} from "../src/core/record.ts";
import {
  PROVENANCE_MARKERS,
  TranscriptSchema,
  coverageOf,
  type Meta,
} from "../src/core/schema.ts";

const ID = "dQw4w9WgXcQ";

function library(): { paths: LibraryPaths; root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "ytx-record-"));
  const { paths } = resolveLibraryPaths({ env: {}, cwd: root, home: root, store: root });
  mkdirSync(join(paths.videos, ID), { recursive: true });
  return { paths, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function sample(overrides: Partial<Meta> = {}): Meta {
  return {
    schema: 1,
    id: ID,
    url: `https://www.youtube.com/watch?v=${ID}`,
    title: "A test video",
    channel: { id: "UC123", name: "A channel" },
    duration_s: 213,
    published: "2009-10-25",
    chapters: [{ start_s: 0, title: "Intro" }],
    media: { video: `${ID}.mp4`, audio: `${ID}.m4a`, mp3: `${ID}.mp3`, height: 1080 },
    transcript: {
      source: "caption-human",
      language: "en",
      ytdlp_version: "2024.08.06",
      ytdlp_source: "managed",
      coverage: 0.98,
      segments: 812,
      chars: 24103,
      fetched_at: "2024-08-06T12:00:00.000Z",
    },
    transcript_history: [],
    warnings: [],
    added_at: "2024-08-06T12:00:00.000Z",
    updated_at: "2024-08-06T12:00:00.000Z",
    ...overrides,
  };
}

describe("meta record", () => {
  test("round-trips through disk", () => {
    const lib = library();
    writeMeta(lib.paths, sample());
    expect(readMeta(lib.paths, ID)).toEqual(sample());
    lib.cleanup();
  });

  test("writes relative media paths only", () => {
    const lib = library();
    writeMeta(lib.paths, sample());
    const raw = JSON.parse(readFileSync(join(videoDir(lib.paths, ID), META_FILE), "utf8"));
    for (const value of Object.values(raw.media)) {
      if (typeof value === "string") expect(value.startsWith("/")).toBe(false);
    }
    lib.cleanup();
  });

  test("refuses to write an absolute media path", () => {
    const lib = library();
    expect(() =>
      writeMeta(lib.paths, sample({ media: { video: "/abs.mp4", audio: null, mp3: null, height: 720 } })),
    ).toThrow(/relative to the video directory/);
    lib.cleanup();
  });

  test("refuses to write a path that escapes the video directory", () => {
    const lib = library();
    expect(() =>
      writeMeta(lib.paths, sample({ media: { video: "../evil.mp4", audio: null, mp3: null, height: null } })),
    ).toThrow(/must not escape/);
    lib.cleanup();
  });

  test("refuses a caption record that carries an asr model", () => {
    const lib = library();
    expect(() =>
      writeMeta(
        lib.paths,
        sample({
          transcript: {
            ...sample().transcript,
            model: "whisper-large-v3-turbo",
            model_revision: "abc",
          },
        }),
      ),
    ).toThrow(/asr-only field/);
    lib.cleanup();
  });

  test("requires a model and revision for asr provenance", () => {
    const lib = library();
    expect(() =>
      writeMeta(
        lib.paths,
        sample({
          transcript: {
            source: "asr",
            language: "en",
            coverage: 1,
            segments: 3,
            chars: 30,
            fetched_at: "2024-08-06T12:00:00.000Z",
          },
        }),
      ),
    ).toThrow(/required for asr/);
    lib.cleanup();
  });

  test("accepts a pre-A7 caption record without ytdlp_source", () => {
    const lib = library();
    const legacy = sample();
    delete (legacy.transcript as { ytdlp_source?: string }).ytdlp_source;
    writeMeta(lib.paths, legacy);
    expect(readMeta(lib.paths, ID).transcript.ytdlp_version).toBe("2024.08.06");
    lib.cleanup();
  });

  test("rejects ytdlp_source on an asr record", () => {
    const lib = library();
    expect(() =>
      writeMeta(
        lib.paths,
        sample({
          transcript: {
            source: "asr",
            language: "en",
            model: "whisper-large-v3-turbo",
            model_revision: "abc123",
            ytdlp_source: "managed",
            coverage: 1,
            segments: 3,
            chars: 30,
            fetched_at: "2024-08-06T12:00:00.000Z",
          },
        }),
      ),
    ).toThrow(/caption-only field/);
    lib.cleanup();
  });

  test("requires the yt-dlp version for caption provenance", () => {
    const lib = library();
    expect(() =>
      writeMeta(
        lib.paths,
        sample({
          transcript: {
            source: "caption-auto",
            language: "en",
            coverage: 1,
            segments: 3,
            chars: 30,
            fetched_at: "2024-08-06T12:00:00.000Z",
          },
        }),
      ),
    ).toThrow(/required for caption sources/);
    lib.cleanup();
  });

  test("accepts a fully specified asr record", () => {
    const lib = library();
    const meta = sample({
      transcript: {
        source: "asr",
        language: "en",
        model: "whisper-large-v3-turbo",
        model_revision: "abc123",
        coverage: 0.97,
        segments: 42,
        chars: 900,
        fetched_at: "2024-08-06T12:00:00.000Z",
      },
    });
    writeMeta(lib.paths, meta);
    expect(readMeta(lib.paths, ID).transcript.source).toBe("asr");
    lib.cleanup();
  });

  test("validates transcript history entries", () => {
    const lib = library();
    const meta = sample({
      transcript_history: [
        {
          source: "caption-auto",
          language: "en",
          ytdlp_version: "2024.08.06",
          coverage: 0.5,
          segments: 10,
          chars: 100,
          fetched_at: "2024-08-01T00:00:00.000Z",
          superseded_at: "2024-08-06T12:00:00.000Z",
        },
      ],
    });
    writeMeta(lib.paths, meta);
    expect(readMeta(lib.paths, ID).transcript_history).toHaveLength(1);
    lib.cleanup();
  });

  test("rejects a non-YouTube id", () => {
    const lib = library();
    expect(() => writeMeta(lib.paths, sample({ id: "nope" }))).toThrow(/not a YouTube video id/);
    lib.cleanup();
  });
});

describe("reading broken records", () => {
  test("names invalid JSON instead of throwing during a scan", () => {
    const lib = library();
    writeFileSync(join(videoDir(lib.paths, ID), META_FILE), "{ not json");
    const result = tryReadMeta(lib.paths, ID);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.why).toContain("not valid JSON");
      expect(result.error.next).toContain("restore");
    }
    const scan = readAllMeta(lib.paths);
    expect(scan.records).toHaveLength(0);
    expect(scan.broken).toHaveLength(1);
    expect(scan.broken[0]!.id).toBe(ID);
    lib.cleanup();
  });

  test("names the failing field for a schema violation", () => {
    const lib = library();
    const broken = { ...sample(), duration_s: "long" };
    writeFileSync(join(videoDir(lib.paths, ID), META_FILE), JSON.stringify(broken));
    const result = tryReadMeta(lib.paths, ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.why).toContain("duration_s");
    lib.cleanup();
  });

  test("names a missing record", () => {
    const lib = library();
    const result = tryReadMeta(lib.paths, "aaaaaaaaaaa");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.why).toBe("meta.json is missing");
    lib.cleanup();
  });

  test("throws from readMeta for callers that want it", () => {
    const lib = library();
    expect(() => readMeta(lib.paths, ID)).toThrow(/meta.json is missing/);
    lib.cleanup();
  });

  test("lists video directories in sorted order", () => {
    const lib = library();
    for (const id of ["bbbbbbbbbbb", "aaaaaaaaaaa"]) {
      mkdirSync(join(lib.paths.videos, id), { recursive: true });
    }
    expect(listVideoIds(lib.paths)).toEqual(["aaaaaaaaaaa", "bbbbbbbbbbb", ID]);
    lib.cleanup();
  });

  test("tolerates a missing videos directory", () => {
    const lib = library();
    rmSync(lib.paths.videos, { recursive: true, force: true });
    expect(listVideoIds(lib.paths)).toEqual([]);
    lib.cleanup();
  });
});

describe("transcripts", () => {
  const segments = [
    { start: 0, end: 1.5, text: "Hello there." },
    { start: 1.5, end: 3, text: "General Kenobi." },
  ];

  test("writes both JSON and plain text", () => {
    const lib = library();
    writeTranscript(lib.paths, ID, segments);
    expect(readTranscript(lib.paths, ID)).toEqual(segments);
    const text = readFileSync(join(videoDir(lib.paths, ID), "transcript.txt"), "utf8");
    expect(text).toBe("Hello there.\n\nGeneral Kenobi.\n");
    lib.cleanup();
  });

  test("renders one paragraph per segment", () => {
    expect(renderTranscriptText(segments)).toBe("Hello there.\n\nGeneral Kenobi.\n");
  });

  test("refuses segments whose end precedes their start", () => {
    const lib = library();
    expect(() => writeTranscript(lib.paths, ID, [{ start: 5, end: 1, text: "backwards" }])).toThrow(
      /end must be >= start/,
    );
    lib.cleanup();
  });

  test("names a corrupt transcript file", () => {
    const lib = library();
    writeFileSync(join(videoDir(lib.paths, ID), "transcript.json"), "[{bad");
    expect(() => readTranscript(lib.paths, ID)).toThrow(/not valid JSON/);
    lib.cleanup();
  });

  test("validates parsed transcript text", () => {
    expect(() => parseTranscriptText(JSON.stringify([{ start: -1, end: 1, text: "x" }]), "test")).toThrow(
      /start/,
    );
    expect(TranscriptSchema.safeParse(segments).success).toBe(true);
  });
});

describe("schema helpers", () => {
  test("marks each provenance distinctly", () => {
    expect(PROVENANCE_MARKERS).toEqual({ "caption-human": "H", "caption-auto": "A", asr: "M" });
  });

  test("computes coverage from the last cue end", () => {
    expect(coverageOf([{ start: 0, end: 95, text: "x" }], 100)).toBeCloseTo(0.95, 5);
    expect(coverageOf([], 100)).toBe(0);
    expect(coverageOf([{ start: 0, end: 95, text: "x" }], 0)).toBe(0);
  });
});
