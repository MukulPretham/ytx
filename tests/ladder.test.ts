import { describe, expect, test } from "bun:test";
import {
  otherHumanLanguages,
  planLadder,
  resolvePreferredLanguage,
  tracksFor,
  type Availability,
} from "../src/captions/ladder.ts";

function availability(overrides: Partial<Availability> = {}): Availability {
  return {
    human: {
      en: [{ ext: "vtt", url: "https://example/en.vtt" }],
      es: [{ ext: "vtt", url: "https://example/es.vtt" }],
    },
    auto: {
      en: [{ ext: "vtt", url: "https://example/en-auto.vtt" }],
      de: [{ ext: "vtt", url: "https://example/de-auto.vtt" }],
    },
    originalLanguage: "en",
    ...overrides,
  };
}

describe("resolvePreferredLanguage", () => {
  test("keeps an explicit preference", () => {
    expect(resolvePreferredLanguage("fr", availability())).toBe("fr");
  });

  test("resolves auto to the video's original language", () => {
    expect(resolvePreferredLanguage("auto", availability({ originalLanguage: "es" }))).toBe("es");
    expect(resolvePreferredLanguage("auto", availability({ originalLanguage: null }))).toBe("en");
  });

  test("normalizes regional tags", () => {
    expect(resolvePreferredLanguage("en-GB", availability())).toBe("en");
  });
});

describe("planLadder", () => {
  test("tries human captions first, then machine, then ASR", () => {
    const plan = planLadder(availability(), { preferredLanguage: "en", quality: "auto" });
    expect(plan.steps.map((step) => [step.tier, step.source])).toEqual([
      [1, "caption-human"],
      [2, "caption-human"],
      [3, "caption-auto"],
      [4, "asr"],
    ]);
  });

  test("skips machine captions under quality=best", () => {
    const plan = planLadder(availability(), { preferredLanguage: "en", quality: "best" });
    expect(plan.steps.map((step) => step.tier)).toEqual([1, 2, 4]);
    expect(plan.skipped.some((entry) => entry.tier === 3)).toBe(true);
  });

  test("--asr skips every caption tier", () => {
    const plan = planLadder(availability(), { preferredLanguage: "en", quality: "auto", forceAsr: true });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]!.tier).toBe(4);
    expect(plan.steps[0]!.source).toBe("asr");
  });

  test("--no-asr stops after platform captions", () => {
    const plan = planLadder(availability(), { preferredLanguage: "en", quality: "auto", noAsr: true });
    expect(plan.steps.map((step) => step.tier)).toEqual([1, 2, 3]);
    expect(plan.steps.every((step) => step.source !== "asr")).toBe(true);
  });

  test("--strict-lang removes the other-language tier", () => {
    const plan = planLadder(availability(), {
      preferredLanguage: "en",
      quality: "auto",
      strictLang: true,
    });
    expect(plan.steps.map((step) => step.tier)).toEqual([1, 3, 4]);
    expect(plan.skipped.some((entry) => entry.tier === 2)).toBe(true);
  });

  test("records the actual language when it falls back", () => {
    const plan = planLadder(
      availability({ human: { es: [{ ext: "vtt", url: "https://example/es.vtt" }] }, auto: {} }),
      { preferredLanguage: "fr", quality: "auto" },
    );
    const fallback = plan.steps.find((step) => step.tier === 2);
    expect(fallback?.language).toBe("es");
    expect(fallback?.reason).toContain("preferred fr unavailable");
  });

  test("still plans ASR when no tracks exist at all", () => {
    const plan = planLadder(
      { human: {}, auto: {}, originalLanguage: null },
      { preferredLanguage: "en", quality: "auto" },
    );
    expect(plan.steps.map((step) => step.tier)).toEqual([4]);
    expect(plan.skipped.map((entry) => entry.tier)).toEqual([1, 2, 3]);
  });

  test("never attempts the same track twice", () => {
    const plan = planLadder(
      { human: { en: [{ ext: "vtt", url: "u" }] }, auto: { en: [{ ext: "vtt", url: "u" }] }, originalLanguage: "en" },
      { preferredLanguage: "en", quality: "auto" },
    );
    const keys = plan.steps.map((step) => `${step.source}:${step.trackKey}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("auto preference follows the video's original language", () => {
    const plan = planLadder(availability({ originalLanguage: "es" }), {
      preferredLanguage: "auto",
      quality: "auto",
    });
    expect(plan.steps[0]!.trackKey).toBe("es");
    expect(plan.steps[0]!.tier).toBe(1);
  });
});

describe("tracksFor", () => {
  test("finds regional variants of the wanted language", () => {
    expect(tracksFor({ "en-US": [{ ext: "vtt", url: "u" }], "en-orig": [{ ext: "vtt", url: "u" }] }, "en")).toEqual([
      "en-orig",
      "en-US",
    ]);
  });

  test("returns nothing when the language is absent", () => {
    expect(tracksFor({ es: [{ ext: "vtt", url: "u" }] }, "en")).toEqual([]);
  });
});

describe("otherHumanLanguages", () => {
  test("prefers the video's original language, then English, then the rest", () => {
    const human = {
      fr: [{ ext: "vtt", url: "u" }],
      en: [{ ext: "vtt", url: "u" }],
      es: [{ ext: "vtt", url: "u" }],
      de: [{ ext: "vtt", url: "u" }],
    };
    expect(otherHumanLanguages(human, "it", "es")).toEqual(["es", "en", "de", "fr"]);
  });

  test("excludes the preferred language", () => {
    expect(otherHumanLanguages({ en: [], es: [] }, "en", "en")).toEqual(["es"]);
  });
});
