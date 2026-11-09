import { describe, expect, test } from "bun:test";
import { formatTimestamp, headerValue, parseCaptions, parseTimestamp, toVtt } from "../src/captions/vtt.ts";

const VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.080 --> 00:00:02.149 align:start position:0%
 
hello<00:00:00.719><c> everyone</c>

00:00:02.159 --> 00:00:04.990 align:start position:0%
hello everyone
welcome<00:00:02.879><c> back</c>

NOTE this is a comment

00:00:05.000 --> 00:00:07.500
third<00:00:05.500><c> cue</c>
`;

const SRT = `1
00:00:01,000 --> 00:00:02,500
First line
second line

2
00:00:03,000 --> 00:00:04,000
Another line
`;

describe("parseTimestamp", () => {
  test("accepts hours, minutes and milliseconds", () => {
    expect(parseTimestamp("01:02:03.456")).toBeCloseTo(3723.456, 3);
  });

  test("accepts hourless WebVTT timestamps", () => {
    expect(parseTimestamp("02:03.500")).toBeCloseTo(123.5, 3);
  });

  test("accepts SRT comma decimals", () => {
    expect(parseTimestamp("00:00:01,250")).toBeCloseTo(1.25, 3);
  });

  test("pads short millisecond fields", () => {
    expect(parseTimestamp("00:00:01.5")).toBeCloseTo(1.5, 3);
  });

  test("rejects nonsense", () => {
    expect(parseTimestamp("not a time")).toBeNull();
    expect(parseTimestamp("00:99:00.000")).toBeNull();
  });
});

describe("parseCaptions", () => {
  test("parses WebVTT cues with settings and inline tags", () => {
    const parsed = parseCaptions(VTT);
    expect(parsed.format).toBe("vtt");
    expect(parsed.cues).toHaveLength(3);
    expect(parsed.cues[0]!.start).toBeCloseTo(0.08, 3);
    expect(parsed.cues[0]!.end).toBeCloseTo(2.149, 3);
    expect(parsed.cues[0]!.settings).toContain("align:start");
    expect(parsed.cues[0]!.lines.join(" ")).toContain("hello<00:00:00.719>");
    expect(parsed.cues[1]!.lines).toEqual(["hello everyone", "welcome<00:00:02.879><c> back</c>"]);
  });

  test("reads header metadata", () => {
    const parsed = parseCaptions(VTT);
    expect(headerValue(parsed, "Language")).toBe("en");
    expect(headerValue(parsed, "Kind")).toBe("captions");
    expect(headerValue(parsed, "Missing")).toBeNull();
  });

  test("skips NOTE blocks instead of treating them as cues", () => {
    const parsed = parseCaptions(VTT);
    expect(parsed.cues.map((cue) => cue.start)).toEqual([0.08, 2.159, 5]);
  });

  test("parses SRT including numeric identifiers and multi-line cues", () => {
    const parsed = parseCaptions(SRT);
    expect(parsed.format).toBe("srt");
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[0]!.lines).toEqual(["First line", "second line"]);
    expect(parsed.cues[1]!.start).toBeCloseTo(3, 3);
  });

  test("drops cues whose end precedes their start", () => {
    const parsed = parseCaptions(`WEBVTT\n\n00:00:05.000 --> 00:00:01.000\nbad\n`);
    expect(parsed.cues).toHaveLength(0);
  });
});

describe("toVtt", () => {
  test("round-trips through the parser", () => {
    const parsed = parseCaptions(SRT);
    const rendered = toVtt(parsed.cues);
    const reparsed = parseCaptions(rendered);
    expect(reparsed.format).toBe("vtt");
    expect(reparsed.cues.map((cue) => cue.lines)).toEqual(parsed.cues.map((cue) => cue.lines));
  });

  test("formats timestamps with zero padding", () => {
    expect(formatTimestamp(0)).toBe("00:00:00.000");
    expect(formatTimestamp(3723.456)).toBe("01:02:03.456");
    expect(formatTimestamp(1.25, ",")).toBe("00:00:01,250");
  });
});
