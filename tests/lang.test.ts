import { describe, expect, test } from "bun:test";
import { detectLanguage, matchesLanguage, normalizeLangTag, sameLanguage } from "../src/captions/lang.ts";

const ENGLISH =
  "The quick brown fox jumps over the lazy dog and then it was that you could see the whole thing from here because there was nothing in the way at all.";

const SPANISH =
  "El rápido zorro marrón salta sobre el perro perezoso y luego fue que se podía ver todo desde aquí porque no había nada en el camino.";

const FRENCH =
  "Le renard brun rapide saute par-dessus le chien paresseux et puis il était que vous pouviez voir tout d'ici parce qu'il n'y avait rien sur le chemin.";

const GERMAN =
  "Der schnelle braune Fuchs springt über den faulen Hund und dann war es so dass man das Ganze von hier aus sehen konnte weil nichts im Weg war.";

const PORTUGUESE =
  "A rápida raposa marrom salta sobre o cão preguiçoso e então foi que você podia ver tudo daqui porque não havia nada no caminho.";

const HINDI = "यह एक छोटा वाक्य है जो हिंदी में लिखा गया है और इसमें कुछ शब्द हैं।";
const JAPANESE = "これは日本語で書かれた短い文です。ひらがなとカタカナが含まれています。";
const RUSSIAN = "Это короткое предложение написано на русском языке и содержит несколько слов.";

describe("detectLanguage", () => {
  test("detects Latin-script languages from function words", () => {
    expect(detectLanguage(ENGLISH).language).toBe("en");
    expect(detectLanguage(SPANISH).language).toBe("es");
    expect(detectLanguage(FRENCH).language).toBe("fr");
    expect(detectLanguage(GERMAN).language).toBe("de");
    expect(detectLanguage(PORTUGUESE).language).toBe("pt");
  });

  test("detects scripts directly", () => {
    expect(detectLanguage(HINDI).language).toBe("hi");
    expect(detectLanguage(HINDI).script).toBe("devanagari");
    expect(detectLanguage(JAPANESE).language).toBe("ja");
    expect(detectLanguage(RUSSIAN).language).toBe("ru");
  });

  test("reports no signal for text without letters", () => {
    const guess = detectLanguage("1234 --- 5678");
    expect(guess.language).toBeNull();
    expect(guess.confidence).toBe(0);
  });

  test("returns low confidence for a single ambiguous word", () => {
    const guess = detectLanguage("hello");
    expect(guess.confidence).toBeLessThan(0.5);
  });

  test("uses distinguishing diacritics to break a tie", () => {
    expect(detectLanguage("año niño señor mañana").language).toBe("es");
    expect(detectLanguage("aß grüß straße").language).toBe("de");
  });
});

describe("matchesLanguage", () => {
  test("accepts a confident match", () => {
    expect(matchesLanguage(detectLanguage(ENGLISH), "en")).toBe(true);
  });

  test("rejects a confident mismatch", () => {
    expect(matchesLanguage(detectLanguage(SPANISH), "en")).toBe(false);
  });

  test("passes when the detector has no signal", () => {
    expect(matchesLanguage({ language: null, confidence: 0, script: "none" }, "en")).toBe(true);
  });

  test("passes when detection is too weak to judge", () => {
    expect(matchesLanguage({ language: "es", confidence: 0.05, script: "latin" }, "en")).toBe(true);
  });

  test("auto accepts anything", () => {
    expect(matchesLanguage(detectLanguage(SPANISH), "auto")).toBe(true);
  });
});

describe("normalizeLangTag", () => {
  test("reduces regions and legacy codes", () => {
    expect(normalizeLangTag("en-US")).toBe("en");
    expect(normalizeLangTag("en-orig")).toBe("en");
    expect(normalizeLangTag("zh-Hans")).toBe("zh");
    expect(normalizeLangTag("iw")).toBe("he");
    expect(normalizeLangTag("in")).toBe("id");
  });

  test("keeps auto as a sentinel and empties junk", () => {
    expect(normalizeLangTag("AUTO")).toBe("auto");
    expect(normalizeLangTag("  ")).toBe("");
  });

  test("sameLanguage compares primary subtags", () => {
    expect(sameLanguage("en-GB", "en")).toBe(true);
    expect(sameLanguage("en", "es")).toBe(false);
  });
});
