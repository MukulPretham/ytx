import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planLadder } from "../src/captions/ladder.ts";
import {
  isArchiveId,
  isLocalId,
  localIdForSha256,
  localOriginUrl,
  VIDEO_ID_RE,
} from "../src/core/paths.ts";
import { MetaSchema, type Meta } from "../src/core/schema.ts";
import {
  decodePathInput,
  displayName,
  looksRemote,
  resolveImportPath,
} from "../src/local/identify.ts";
import {
  audioPlan,
  hashAndCopy,
  publishImport,
  removeStaleMedia,
  sourceExtension,
  stagingDirectory,
} from "../src/local/importer.ts";
import { parseProbeJson } from "../src/local/probe.ts";

const HEX = "9f2c4a71b3de";
const SHA = `${HEX}${"0".repeat(52)}`;
const LOCAL_ID = `local-${HEX}`;

function scratch(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "ytx-local-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function localMeta(overrides: Partial<Meta> = {}): Meta {
  return {
    schema: 2,
    origin: "file",
    id: LOCAL_ID,
    url: localOriginUrl(SHA),
    source: { kind: "file", filename: "talk.mp4", bytes: 1_234, sha256: SHA },
    title: "Fixture talk",
    channel: { id: null, name: "local file" },
    duration_s: 2,
    published: "2026-03-14",
    chapters: [],
    media: { video: `${LOCAL_ID}.mp4`, audio: `${LOCAL_ID}.m4a`, mp3: `${LOCAL_ID}.mp3`, height: 240 },
    transcript: {
      source: "asr",
      language: "en",
      model: "whisper-large-v3-turbo",
      model_revision: "a4aaeec",
      coverage: 1,
      segments: 1,
      chars: 12,
      fetched_at: "2026-03-14T10:00:00.000Z",
    },
    transcript_history: [],
    warnings: [],
    added_at: "2026-03-14T10:00:00.000Z",
    updated_at: "2026-03-14T10:00:00.000Z",
    ...overrides,
  };
}

describe("import paths", () => {
  test("recognises remote inputs but not file URLs", () => {
    expect(looksRemote("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(looksRemote("HTTP://example.com/a.mp4")).toBe(true);
    expect(looksRemote("file:///tmp/talk.mp4")).toBe(false);
    expect(looksRemote("./talk.mp4")).toBe(false);
    expect(looksRemote("dQw4w9WgXcQ")).toBe(false);
  });

  test("decodes file URLs, including percent escapes", () => {
    expect(decodePathInput("file:///tmp/a%20b.mp4")).toBe("/tmp/a b.mp4");
    expect(decodePathInput("file://localhost/tmp/talk.mp4")).toBe("/tmp/talk.mp4");
    expect(decodePathInput("./talk.mp4")).toBe("./talk.mp4");
  });

  test("expands ~, resolves relative paths and keeps absolute ones", () => {
    const inputs = { cwd: "/work", home: "/home/someone" };
    expect(resolveImportPath("./talks/a.mp4", inputs)).toBe("/work/talks/a.mp4");
    expect(resolveImportPath("~/a.mp4", inputs)).toBe("/home/someone/a.mp4");
    expect(resolveImportPath("~", inputs)).toBe("/home/someone");
    expect(resolveImportPath("/media/a.mp4", inputs)).toBe("/media/a.mp4");
    expect(resolveImportPath("file:///media/a.mp4", inputs)).toBe("/media/a.mp4");
  });

  test("a path that looks like a video id is still a path", () => {
    expect(resolveImportPath("dQw4w9WgXcQ", { cwd: "/work", home: "/home/x" })).toBe(
      "/work/dQw4w9WgXcQ",
    );
  });

  test("derives a display name without the directory", () => {
    expect(displayName("/media/talks/a.mp4")).toBe("a.mp4");
    expect(displayName("a.mp4")).toBe("a.mp4");
  });
});

describe("local ids", () => {
  test("derives the id from the first 12 hex characters", () => {
    expect(localIdForSha256(SHA)).toBe(LOCAL_ID);
    expect(localIdForSha256(SHA.toUpperCase())).toBe(LOCAL_ID);
    expect(() => localIdForSha256("not-a-digest")).toThrow();
  });

  test("keeps the local and YouTube namespaces disjoint", () => {
    expect(isLocalId(LOCAL_ID)).toBe(true);
    expect(isLocalId("dQw4w9WgXcQ")).toBe(false);
    expect(isArchiveId(LOCAL_ID)).toBe(true);
    expect(isArchiveId("dQw4w9WgXcQ")).toBe(true);
    expect(isArchiveId(`local-${"0".repeat(11)}`)).toBe(false);
    expect(isArchiveId(`local-${"G".repeat(12)}`)).toBe(false);
    expect(VIDEO_ID_RE.test(LOCAL_ID)).toBe(false);
  });

  test("builds a hash URL, never a filesystem path", () => {
    expect(localOriginUrl(SHA)).toBe(`local:sha256:${SHA}`);
  });
});

describe("probe parsing", () => {
  const mp4 = {
    streams: [
      {
        codec_name: "h264",
        codec_type: "video",
        width: 320,
        height: 240,
        disposition: { attached_pic: 0 },
      },
      { codec_name: "aac", codec_type: "audio", duration: "2.000000" },
    ],
    format: {
      duration: "2.000000",
      format_name: "mov,mp4,m4a,3gp,3g2,mj2",
      tags: { title: "Fixture talk", creation_time: "2026-03-14T10:00:00.000000Z" },
    },
    chapters: [{ start_time: "0.000000", tags: { title: "Intro" } }],
  };

  test("reads duration, picture, codecs, title, date and chapters", () => {
    const probe = parseProbeJson(JSON.stringify(mp4));
    expect(probe.durationS).toBe(2);
    expect(probe.width).toBe(320);
    expect(probe.height).toBe(240);
    expect(probe.videoCodec).toBe("h264");
    expect(probe.audioCodec).toBe("aac");
    expect(probe.container).toBe("mov,mp4,m4a,3gp,3g2,mj2");
    expect(probe.title).toBe("Fixture talk");
    expect(probe.published).toBe("2026-03-14");
    expect(probe.chapters).toEqual([{ start_s: 0, title: "Intro" }]);
  });

  test("does not treat cover art as a video track", () => {
    const probe = parseProbeJson(
      JSON.stringify({
        streams: [
          { codec_name: "mp3", codec_type: "audio" },
          {
            codec_name: "mjpeg",
            codec_type: "video",
            width: 64,
            height: 64,
            disposition: { attached_pic: 1 },
          },
        ],
        format: { duration: "2.000000", format_name: "mp3", tags: { title: "Tone" } },
      }),
    );
    expect(probe.videoCodec).toBeNull();
    expect(probe.height).toBeNull();
    expect(probe.audioCodec).toBe("mp3");
  });

  test("falls back to a stream duration and skips an invalid date", () => {
    const probe = parseProbeJson(
      JSON.stringify({
        streams: [{ codec_name: "opus", codec_type: "audio", duration: "7.5" }],
        format: { duration: "N/A", tags: { creation_time: "not a date" } },
      }),
    );
    expect(probe.durationS).toBe(7.5);
    expect(probe.published).toBeNull();
    expect(probe.chapters).toEqual([]);
  });

  test("accepts a document with no streams and no format", () => {
    const probe = parseProbeJson("{}");
    expect(probe.durationS).toBe(0);
    expect(probe.videoCodec).toBeNull();
    expect(probe.audioCodec).toBeNull();
    expect(probe.chapters).toEqual([]);
  });
});

describe("audio planning", () => {
  test("copies codecs with a lossless target container", () => {
    expect(audioPlan("aac")).toEqual({ ext: "m4a", copy: true });
    expect(audioPlan("mp3")).toEqual({ ext: "mp3", copy: true });
    expect(audioPlan("opus")).toEqual({ ext: "opus", copy: true });
    expect(audioPlan("vorbis")).toEqual({ ext: "ogg", copy: true });
    expect(audioPlan("flac")).toEqual({ ext: "flac", copy: true });
    expect(audioPlan("alac")).toEqual({ ext: "m4a", copy: true });
  });

  test("transcodes everything else to AAC", () => {
    expect(audioPlan("pcm_s16le")).toEqual({ ext: "m4a", copy: false });
    expect(audioPlan(null)).toEqual({ ext: "m4a", copy: false });
  });

  test("keeps a sane container extension", () => {
    expect(sourceExtension("/a/talk.MP4")).toBe("mp4");
    expect(sourceExtension("/a/talk.mkv")).toBe("mkv");
    expect(sourceExtension("/a/talk")).toBe("mkv");
    expect(sourceExtension("/a/talk.weird-extension")).toBe("mkv");
  });
});

describe("hashing and copying", () => {
  test("hashes and copies every byte in one pass", async () => {
    const { dir, cleanup } = scratch();
    const source = join(dir, "source.bin");
    const destination = join(dir, "copy.bin");
    const bytes = Buffer.from("a local file with repeating bytes ".repeat(500));
    writeFileSync(source, bytes);

    const result = await hashAndCopy(source, destination);
    expect(result.bytes).toBe(bytes.byteLength);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readFileSync(destination).equals(bytes)).toBe(true);
    cleanup();
  });

  test("hashes without writing when no destination is given", async () => {
    const { dir, cleanup } = scratch();
    const source = join(dir, "source.bin");
    writeFileSync(source, "hello");
    const result = await hashAndCopy(source, null);
    expect(result.sha256).toBe(createHash("sha256").update("hello").digest("hex"));
    expect(result.bytes).toBe(5);
    cleanup();
  });

  test("streams progress at lease once at the end", async () => {
    const { dir, cleanup } = scratch();
    const source = join(dir, "source.bin");
    writeFileSync(source, "progress");
    const seen: number[] = [];
    await hashAndCopy(source, null, (done) => seen.push(done));
    expect(seen[seen.length - 1]).toBe(8);
    cleanup();
  });
});

describe("publishing an import", () => {
  test("renames a new staging directory into place", () => {
    const { dir, cleanup } = scratch();
    const videos = join(dir, "videos");
    const incoming = stagingDirectory(videos);
    writeFileSync(join(incoming, "meta.json"), "{}");
    const target = join(videos, LOCAL_ID);
    publishImport(incoming, target, { force: false });
    expect(existsSync(join(target, "meta.json"))).toBe(true);
    expect(existsSync(incoming)).toBe(false);
    cleanup();
  });

  test("moves files over an existing directory only with --force", () => {
    const { dir, cleanup } = scratch();
    const videos = join(dir, "videos");
    const target = join(videos, LOCAL_ID);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "old.mp4"), "old");

    const first = stagingDirectory(videos);
    writeFileSync(join(first, "meta.json"), "{}");
    expect(() => publishImport(first, target, { force: false })).toThrow(/nothing was overwritten/);
    expect(readFileSync(join(target, "old.mp4"), "utf8")).toBe("old");

    writeFileSync(join(first, "new.mp4"), "new");
    publishImport(first, target, { force: true });
    expect(readFileSync(join(target, "new.mp4"), "utf8")).toBe("new");
    expect(existsSync(join(target, "meta.json"))).toBe(true);
    cleanup();
  });

  test("removes media the new record no longer names", () => {
    const { dir, cleanup } = scratch();
    writeFileSync(join(dir, "old.mp4"), "x");
    writeFileSync(join(dir, "keep.mp3"), "x");
    const previous = { video: "old.mp4", audio: null, mp3: "keep.mp3", height: null };
    expect(removeStaleMedia(dir, previous, ["keep.mp3"])).toEqual(["old.mp4"]);
    expect(existsSync(join(dir, "old.mp4"))).toBe(false);
    expect(existsSync(join(dir, "keep.mp3"))).toBe(true);
    cleanup();
  });
});

describe("local records", () => {
  test("validate and round-trip through the schema", () => {
    const parsed = MetaSchema.safeParse(localMeta());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.origin).toBe("file");
      expect(parsed.data.source?.sha256).toBe(SHA);
    }
  });

  test("refuse an id that does not derive from the hash", () => {
    const result = MetaSchema.safeParse(localMeta({ id: "local-ffffffffffff" }));
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("derived from source.sha256");
  });

  test("refuse a url that is not the hash url", () => {
    const result = MetaSchema.safeParse(localMeta({ url: "file:///tmp/talk.mp4" }));
    expect(result.success).toBe(false);
  });

  test("refuse a source block on a YouTube record", () => {
    const result = MetaSchema.safeParse(
      localMeta({
        origin: "youtube",
        schema: 1,
        id: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }),
    );
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toContain("file-only field");
  });

  test("accept a v1 record without an origin", () => {
    const v1 = {
      schema: 1,
      id: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      title: "A test video",
      channel: { id: "UC123", name: "A channel" },
      duration_s: 213,
      published: null,
      chapters: [],
      media: { video: null, audio: null, mp3: null, height: null },
      transcript: {
        source: "caption-human",
        language: "en",
        ytdlp_version: "2024.08.06",
        coverage: 0.5,
        segments: 3,
        chars: 30,
        fetched_at: "2024-08-06T12:00:00.000Z",
      },
      transcript_history: [],
      warnings: [],
      added_at: "2024-08-06T12:00:00.000Z",
      updated_at: "2024-08-06T12:00:00.000Z",
    };
    const parsed = MetaSchema.safeParse(v1);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.origin).toBe("youtube");
  });
});

describe("the ladder for a local file", () => {
  test("has exactly one tier: local transcription", () => {
    const plan = planLadder(
      { human: {}, auto: {}, originalLanguage: null },
      { preferredLanguage: "en", quality: "auto" },
    );
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.source).toBe("asr");
    expect(plan.steps[0]!.tier).toBe(4);
  });
});
