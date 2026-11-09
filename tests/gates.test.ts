import { describe, expect, test } from "bun:test";
import {
  COVERAGE_MIN,
  DENSITY_MIN_CHARS_PER_MINUTE,
  REPETITION_MAX,
  describeFailures,
  evaluateGates,
  type GateInput,
} from "../src/captions/gates.ts";
import { detectLanguage } from "../src/captions/lang.ts";
import type { Cue } from "../src/captions/normalize.ts";

const BODY =
  "The quick brown fox jumps over the lazy dog and then it was that you could see the whole thing from here because there was nothing in the way at all.";

function input(overrides: Partial<GateInput> = {}): GateInput {
  const cues: Cue[] = [
    { start: 0, end: 10, text: BODY },
    { start: 10, end: 20, text: BODY },
    { start: 20, end: 30, text: BODY },
  ];
  return {
    cues,
    durationS: 30,
    trackLanguage: "en",
    wantLanguage: "en",
    detected: detectLanguage(BODY),
    duplicateLineRatio: 0,
    ...overrides,
  };
}

describe("evaluateGates", () => {
  test("passes a complete, dense, unique, on-language track", () => {
    const result = evaluateGates(input());
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.metrics.coverage).toBeCloseTo(1, 5);
    expect(result.metrics.detected_language).toBe("en");
  });

  test("rejects a track that stops early", () => {
    const result = evaluateGates(input({ durationS: 60 }));
    expect(result.pass).toBe(false);
    expect(result.failures.map((failure) => failure.gate)).toEqual(["coverage"]);
    expect(result.failures[0]!.detail).toContain("50.0%");
  });

  test("accepts coverage exactly at the threshold", () => {
    const cues: Cue[] = [{ start: 0, end: 90, text: BODY }];
    const result = evaluateGates(input({ cues, durationS: 100 }));
    expect(result.metrics.coverage).toBeCloseTo(COVERAGE_MIN, 5);
    expect(result.pass).toBe(true);
  });

  test("rejects a track whose body is in another language", () => {
    const spanish = detectLanguage(
      "El rápido zorro marrón salta sobre el perro perezoso y luego fue que se podía ver todo desde aquí.",
    );
    const result = evaluateGates(input({ detected: spanish, trackLanguage: "en" }));
    expect(result.pass).toBe(false);
    expect(result.failures[0]!.gate).toBe("language");
    expect(result.failures[0]!.detail).toContain('tagged "en" reads as es');
  });

  test("rejects a track with too little text for its runtime", () => {
    const cues: Cue[] = [{ start: 0, end: 30, text: "hi" }];
    const result = evaluateGates(input({ cues }));
    expect(result.pass).toBe(false);
    expect(result.failures.map((failure) => failure.gate)).toContain("density");
    expect(result.metrics.chars_per_minute).toBeLessThan(DENSITY_MIN_CHARS_PER_MINUTE);
  });

  test("rejects a track dominated by repeated lines", () => {
    const result = evaluateGates(input({ duplicateLineRatio: REPETITION_MAX + 0.01 }));
    expect(result.pass).toBe(false);
    expect(result.failures.map((failure) => failure.gate)).toEqual(["repetition"]);
  });

  test("accepts repetition exactly at the threshold", () => {
    expect(evaluateGates(input({ duplicateLineRatio: REPETITION_MAX })).pass).toBe(true);
  });

  test("reports every failing gate at once", () => {
    const cues: Cue[] = [{ start: 0, end: 5, text: "hi" }];
    const result = evaluateGates(
      input({
        cues,
        durationS: 100,
        duplicateLineRatio: 0.9,
        detected: { language: "es", confidence: 0.9, script: "latin" },
      }),
    );
    expect(result.failures.map((failure) => failure.gate)).toEqual([
      "coverage",
      "language",
      "density",
      "repetition",
    ]);
  });

  test("rejects a track with no cues", () => {
    const result = evaluateGates(input({ cues: [] }));
    expect(result.pass).toBe(false);
    expect(result.failures[0]!.detail).toBe("no cues survived normalization");
  });

  test("auto language never fails the language gate", () => {
    const spanish = detectLanguage("El rápido zorro marrón salta sobre el perro perezoso.");
    expect(evaluateGates(input({ detected: spanish, wantLanguage: "auto" })).pass).toBe(true);
  });

  test("clamps coverage to 1 when cues run past the reported duration", () => {
    const cues: Cue[] = [{ start: 0, end: 120, text: BODY }];
    expect(evaluateGates(input({ cues, durationS: 100 })).metrics.coverage).toBe(1);
  });
});

describe("describeFailures", () => {
  test("renders one clause per gate", () => {
    const result = evaluateGates(input({ durationS: 100, duplicateLineRatio: 0.9 }));
    const text = describeFailures(result.failures);
    expect(text).toContain("coverage:");
    expect(text).toContain("repetition:");
  });
});
