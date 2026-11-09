import { describe, expect, test } from "bun:test";
import { renderTranscript, TRANSCRIPT_FORMATS } from "../src/commands/render.ts";
import { parseTranscriptFormat } from "../src/commands/library.ts";
import type { TranscriptSegment } from "../src/core/schema.ts";

const SEGMENTS: TranscriptSegment[] = [
  { start: 0, end: 1.5, text: "Hello there." },
  { start: 61.25, end: 63, text: "General Kenobi." },
];

describe("renderTranscript", () => {
  test("txt is one paragraph per segment", () => {
    expect(renderTranscript(SEGMENTS, "txt")).toBe("Hello there.\n\nGeneral Kenobi.\n");
  });

  test("txt timestamps use a clock prefix", () => {
    expect(renderTranscript(SEGMENTS, "txt", { timestamps: true })).toBe(
      "[00:00] Hello there.\n\n[01:01] General Kenobi.\n",
    );
  });

  test("md timestamps are bold and do not change the text", () => {
    expect(renderTranscript(SEGMENTS, "md", { timestamps: true })).toBe(
      "**00:00** Hello there.\n\n**01:01** General Kenobi.\n",
    );
  });

  test("json is the stored segment array", () => {
    expect(JSON.parse(renderTranscript(SEGMENTS, "json"))).toEqual(SEGMENTS);
  });

  test("srt uses comma decimals and numbered cues", () => {
    const srt = renderTranscript(SEGMENTS, "srt");
    expect(srt).toContain("1\n00:00:00,000 --> 00:00:01,500\nHello there.");
    expect(srt).toContain("2\n00:01:01,250 --> 00:01:03,000\nGeneral Kenobi.");
  });

  test("vtt starts with WEBVTT and uses dot decimals", () => {
    const vtt = renderTranscript(SEGMENTS, "vtt");
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt).toContain("00:01:01.250 --> 00:01:03.000");
  });

  test("every advertised format renders", () => {
    for (const format of TRANSCRIPT_FORMATS) {
      expect(renderTranscript(SEGMENTS, format).length).toBeGreaterThan(0);
    }
  });
});

describe("parseTranscriptFormat", () => {
  test("defaults to txt", () => {
    expect(parseTranscriptFormat(undefined)).toBe("txt");
  });

  test("accepts every advertised format", () => {
    for (const format of TRANSCRIPT_FORMATS) {
      expect(parseTranscriptFormat(format)).toBe(format);
    }
  });

  test("rejects an unknown format with the list of choices", () => {
    try {
      parseTranscriptFormat("docx");
      throw new Error("expected a throw");
    } catch (err) {
      const error = err as { message: string; next: string };
      expect(error.message).toContain("is not a transcript format");
      expect(error.next).toContain("txt, json, srt, vtt, md");
    }
  });
});
