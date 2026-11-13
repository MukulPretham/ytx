import { describe, expect, test } from "bun:test";
import { archiveIdFromInput, defaultExportDir, resolveExportDir, toConfigPath } from "../src/core/paths.ts";
import { exportBaseName, exportFileName } from "../src/commands/render.ts";

const HOME = "/Users/someone";
const LIBRARY = "/data/ytx-library";

describe("resolveExportDir", () => {
  test("empty means not configured yet", () => {
    expect(resolveExportDir({ configValue: "", libraryRoot: LIBRARY, home: HOME })).toBeNull();
  });

  test("the suggested folder lives on the Desktop", () => {
    expect(defaultExportDir(HOME)).toBe("/Users/someone/Desktop/ytx-transcripts");
  });

  test("expands ~ and ~/…", () => {
    expect(resolveExportDir({ configValue: "~", libraryRoot: LIBRARY, home: HOME })).toBe(HOME);
    expect(resolveExportDir({ configValue: "~/Exports", libraryRoot: LIBRARY, home: HOME })).toBe(
      "/Users/someone/Exports",
    );
  });

  test("a relative value stays inside the library", () => {
    expect(resolveExportDir({ configValue: "exports", libraryRoot: LIBRARY, home: HOME })).toBe(
      "/data/ytx-library/exports",
    );
  });

  test("an absolute value is kept as is", () => {
    expect(
      resolveExportDir({ configValue: "/Volumes/Archive/txt", libraryRoot: LIBRARY, home: HOME }),
    ).toBe("/Volumes/Archive/txt");
  });
});

describe("toConfigPath", () => {
  test("stores a home-relative path when possible", () => {
    expect(toConfigPath("/Users/someone/Desktop/ytx-transcripts", HOME)).toBe(
      "~/Desktop/ytx-transcripts",
    );
    expect(toConfigPath(HOME, HOME)).toBe("~");
  });

  test("keeps an outside path absolute", () => {
    expect(toConfigPath("/Volumes/Archive/txt", HOME)).toBe("/Volumes/Archive/txt");
  });
});

describe("exportFileName", () => {
  test("names the file after the title and keeps the id unique", () => {
    expect(exportFileName("001 Prompt LLMs Reliably", "local-ab81e4966c95", "md")).toBe(
      "001 Prompt LLMs Reliably (local-ab81e4966c95).md",
    );
  });

  test("the per-video folder and its files share one base name", () => {
    const base = exportBaseName("001 Prompt LLMs Reliably", "local-ab81e4966c95");
    expect(base).toBe("001 Prompt LLMs Reliably (local-ab81e4966c95)");
    expect(exportFileName("001 Prompt LLMs Reliably", "local-ab81e4966c95", "srt")).toBe(
      `${base}.srt`,
    );
  });

  test("removes characters macOS and shells dislike", () => {
    expect(exportFileName('a/b:c*d?e"f<g>h|i', "dQw4w9WgXcQ", "txt")).toBe(
      "a b c d e f g h i (dQw4w9WgXcQ).txt",
    );
  });

  test("falls back to the id when the title has no usable characters", () => {
    expect(exportFileName("///", "dQw4w9WgXcQ", "srt")).toBe("dQw4w9WgXcQ.srt");
  });

  test("clips an overlong title", () => {
    const name = exportFileName("x".repeat(300), "dQw4w9WgXcQ", "txt");
    expect(name.length).toBeLessThanOrEqual(100 + " (dQw4w9WgXcQ).txt".length);
    expect(name.endsWith(" (dQw4w9WgXcQ).txt")).toBe(true);
  });
});

describe("archiveIdFromInput", () => {
  test("accepts both id shapes and every URL shape", () => {
    expect(archiveIdFromInput("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(archiveIdFromInput("local-ab81e4966c95")).toBe("local-ab81e4966c95");
    expect(archiveIdFromInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(archiveIdFromInput("https://youtu.be/dQw4w9WgXcQ?si=x")).toBe("dQw4w9WgXcQ");
    expect(archiveIdFromInput("  local-ab81e4966c95  ")).toBe("local-ab81e4966c95");
  });

  test("rejects anything that is not an archived id or URL", () => {
    expect(archiveIdFromInput("./talk.mp4")).toBeNull();
    expect(archiveIdFromInput("https://vimeo.com/123")).toBeNull();
    expect(archiveIdFromInput("local-zzzzzzzzzzzz")).toBeNull();
    // 11 characters is the YouTube namespace even when it starts with "local-".
    expect(archiveIdFromInput("local-short")).toBe("local-short");
  });
});
