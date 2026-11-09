import { describe, expect, test } from "bun:test";
import {
  cleanLine,
  collapseRolling,
  endsWithTerminalPunctuation,
  isRollingTrack,
  normalizeTrack,
  overlapLength,
  segmentCues,
  type Cue,
} from "../src/captions/normalize.ts";
import { parseCaptions, type RawCue } from "../src/captions/vtt.ts";

/** Build a raw cue from plain text, the shape `add` receives before cleanup. */
function raw(start: number, end: number, ...lines: string[]): RawCue {
  return { index: 0, start, end, settings: "", lines };
}

const ROLLING = parseCaptions(`WEBVTT
Kind: captions
Language: en

00:00:00.080 --> 00:00:02.149 align:start position:0%
 
hello<00:00:00.719><c> everyone</c><00:00:01.200><c> and</c>

00:00:02.149 --> 00:00:02.159 align:start position:0%
hello everyone and
 

00:00:02.159 --> 00:00:05.000 align:start position:0%
hello everyone and
welcome<00:00:02.879><c> back</c><00:00:03.360><c> to</c><00:00:03.840><c> the</c>

00:00:05.000 --> 00:00:05.010 align:start position:0%
welcome back to the
 

00:00:05.010 --> 00:00:07.800 align:start position:0%
welcome back to the
channel<00:00:05.500><c> today</c>
`);

const HUMAN = parseCaptions(`WEBVTT

00:00:01.000 --> 00:00:03.000 align:start position:0%
The quick brown fox.

00:00:03.000 --> 00:00:05.000 align:start position:0%
It jumps over the lazy dog.
`);

describe("cleanLine", () => {
  test("strips inline <c> tags and inline timestamps", () => {
    expect(cleanLine("hello<00:00:00.719><c> everyone</c>")).toBe("hello everyone");
    expect(cleanLine("<c.colorE5E5E5>colored</c>")).toBe("colored");
  });

  test("strips voice and formatting tags", () => {
    expect(cleanLine("<v Speaker One>hi there</v>")).toBe("hi there");
    expect(cleanLine("<i>italic</i> and <b>bold</b>")).toBe("italic and bold");
  });

  test("decodes entities and collapses whitespace", () => {
    expect(cleanLine("a &amp; b&nbsp;&nbsp;c")).toBe("a & b c");
    expect(cleanLine("&#39;quoted&#39;")).toBe("'quoted'");
    expect(cleanLine("  spaced   out  ")).toBe("spaced out");
  });

  test("drops zero-width marks", () => {
    expect(cleanLine("\u200bhello\u200f")).toBe("hello");
  });

  test("keeps a literal comparison that is not a tag", () => {
    expect(cleanLine("a < b")).toBe("a < b");
  });
});

describe("isRollingTrack", () => {
  test("detects the platform's rolling-window shape", () => {
    const cues: Cue[] = [
      { start: 0, end: 1, text: "a b c" },
      { start: 1, end: 1.01, text: "a b c" },
      { start: 1.01, end: 2, text: "a b c d" },
      { start: 2, end: 2.01, text: "a b c d" },
      { start: 2.01, end: 3, text: "a b c d e" },
    ];
    expect(isRollingTrack(cues)).toBe(true);
  });

  test("leaves human captions alone", () => {
    const cues: Cue[] = [
      { start: 0, end: 1, text: "The quick brown fox" },
      { start: 1, end: 2, text: "jumps over the lazy dog" },
      { start: 2, end: 3, text: "and lands in the mud" },
    ];
    expect(isRollingTrack(cues)).toBe(false);
  });

  test("does not classify a two-cue track", () => {
    expect(
      isRollingTrack([
        { start: 0, end: 1, text: "hello there" },
        { start: 1, end: 2, text: "hello there friend" },
      ]),
    ).toBe(false);
  });
});

describe("overlapLength", () => {
  test("finds the longest suffix/prefix match", () => {
    expect(overlapLength(["a", "b", "c"], ["b", "c", "d"])).toBe(2);
    expect(overlapLength(["a", "b"], ["x", "y"])).toBe(0);
    expect(overlapLength(["a", "b"], ["a", "b", "c"])).toBe(2);
  });
});

describe("normalizeTrack", () => {
  test("collapses rolling cues to each cue's new words", () => {
    const normalized = normalizeTrack(ROLLING.cues);
    expect(normalized.rolling).toBe(true);
    expect(normalized.cues.map((cue) => cue.text)).toEqual([
      "hello everyone and",
      "welcome back to the",
      "channel today",
    ]);
  });

  test("keeps the first cue's own timestamps", () => {
    const normalized = normalizeTrack(ROLLING.cues);
    expect(normalized.cues[0]!.start).toBeCloseTo(0.08, 3);
    expect(normalized.cues[1]!.start).toBeCloseTo(2.159, 3);
    expect(normalized.cues[2]!.end).toBeCloseTo(7.8, 3);
  });

  test("leaves human captions untouched and reports no repetition", () => {
    const normalized = normalizeTrack(HUMAN.cues);
    expect(normalized.rolling).toBe(false);
    expect(normalized.cues.map((cue) => cue.text)).toEqual([
      "The quick brown fox.",
      "It jumps over the lazy dog.",
    ]);
    expect(normalized.duplicate_line_ratio).toBe(0);
  });

  test("drops an exactly repeated human cue", () => {
    const cues = [raw(0, 1, "same thing"), raw(1, 2, "same thing"), raw(2, 3, "different thing")];
    expect(normalizeTrack(cues).cues.map((cue) => cue.text)).toEqual(["same thing", "different thing"]);
  });

  test("counts duplicate lines for the repetition gate", () => {
    const cues = [raw(0, 1, "la la la"), raw(1, 2, "la la la"), raw(2, 3, "something else")];
    expect(normalizeTrack(cues).duplicate_line_ratio).toBeCloseTo(1 / 3, 5);
  });

  test("collapses CJK rolling cues without inserting spaces", () => {
    const cues: Cue[] = [
      { start: 0, end: 1, text: "こんにちは" },
      { start: 1, end: 2, text: "こんにちは世界" },
      { start: 2, end: 3, text: "こんにちは世界です" },
    ];
    expect(collapseRolling(cues).map((cue) => cue.text)).toEqual(["こんにちは", "世界", "です"]);
  });
});

describe("segmentCues", () => {
  test("joins cues until terminal punctuation", () => {
    const cues: Cue[] = [
      { start: 0, end: 1, text: "Hello" },
      { start: 1, end: 2, text: "there." },
      { start: 2, end: 3, text: "Next" },
      { start: 3, end: 4, text: "sentence!" },
    ];
    expect(segmentCues(cues)).toEqual([
      { start: 0, end: 2, text: "Hello there." },
      { start: 2, end: 4, text: "Next sentence!" },
    ]);
  });

  test("breaks across a pause longer than 0.8s", () => {
    const cues: Cue[] = [
      { start: 0, end: 1, text: "first part" },
      { start: 2.5, end: 3, text: "second part" },
    ];
    expect(segmentCues(cues).map((segment) => segment.text)).toEqual(["first part", "second part"]);
  });

  test("does not break across a short pause", () => {
    const cues: Cue[] = [
      { start: 0, end: 1, text: "first part" },
      { start: 1.7, end: 2, text: "same sentence" },
    ];
    expect(segmentCues(cues)).toHaveLength(1);
  });

  test("breaks at roughly 200 characters", () => {
    const cues: Cue[] = [];
    for (let i = 0; i < 10; i += 1) {
      cues.push({ start: i, end: i + 1, text: "x".repeat(50) });
    }
    const segments = segmentCues(cues);
    expect(segments.length).toBeGreaterThan(1);
    for (const segment of segments) expect(segment.text.length).toBeLessThan(260);
  });

  test("takes start from the first absorbed cue and end from the last", () => {
    const cues: Cue[] = [
      { start: 1.5, end: 2.25, text: "one" },
      { start: 2.25, end: 4.75, text: "two" },
    ];
    expect(segmentCues(cues)[0]).toEqual({ start: 1.5, end: 4.75, text: "one two" });
  });

  test("skips empty cues and returns nothing for an empty track", () => {
    expect(segmentCues([])).toEqual([]);
    expect(segmentCues([{ start: 0, end: 1, text: "   " }])).toEqual([]);
  });
});

describe("endsWithTerminalPunctuation", () => {
  test("recognizes sentence terminals including quotes and CJK", () => {
    expect(endsWithTerminalPunctuation("done.")).toBe(true);
    expect(endsWithTerminalPunctuation('he said "go!"')).toBe(true);
    expect(endsWithTerminalPunctuation("終わり。")).toBe(true);
    expect(endsWithTerminalPunctuation("continues")).toBe(false);
  });
});
