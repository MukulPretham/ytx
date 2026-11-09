/**
 * Language detection from the caption body.
 *
 * A caption track's `Language:` header is a claim, not a fact: tracks are
 * mislabelled, and the platform serves `en-orig` for videos whose original
 * audio is Spanish. The acquisition gates therefore believe the text, not the
 * tag. This detector is deliberately compact - script detection plus function
 * words - because it only has to answer "is this really the language we asked
 * for", never "what language is this exactly".
 */

export interface LanguageGuess {
  /** Primary subtag (`en`, `hi`, `es`), or null when there is no signal. */
  language: string | null;
  /** 0..1. Below 0.2 the detector has effectively guessed. */
  confidence: number;
  /** Dominant writing system, for diagnostics. */
  script: string;
}

const SCRIPTS: { script: string; language: string; ranges: [number, number][] }[] = [
  { script: "devanagari", language: "hi", ranges: [[0x0900, 0x097f]] },
  { script: "bengali", language: "bn", ranges: [[0x0980, 0x09ff]] },
  { script: "gurmukhi", language: "pa", ranges: [[0x0a00, 0x0a7f]] },
  { script: "gujarati", language: "gu", ranges: [[0x0a80, 0x0aff]] },
  { script: "tamil", language: "ta", ranges: [[0x0b80, 0x0bff]] },
  { script: "telugu", language: "te", ranges: [[0x0c00, 0x0c7f]] },
  { script: "kannada", language: "kn", ranges: [[0x0c80, 0x0cff]] },
  { script: "malayalam", language: "ml", ranges: [[0x0d00, 0x0d7f]] },
  { script: "thai", language: "th", ranges: [[0x0e00, 0x0e7f]] },
  { script: "hebrew", language: "he", ranges: [[0x0590, 0x05ff]] },
  { script: "arabic", language: "ar", ranges: [[0x0600, 0x06ff], [0x0750, 0x077f]] },
  { script: "greek", language: "el", ranges: [[0x0370, 0x03ff]] },
  { script: "cyrillic", language: "ru", ranges: [[0x0400, 0x04ff]] },
  { script: "hiragana", language: "ja", ranges: [[0x3040, 0x309f]] },
  { script: "katakana", language: "ja", ranges: [[0x30a0, 0x30ff]] },
  { script: "hangul", language: "ko", ranges: [[0xac00, 0xd7af], [0x1100, 0x11ff]] },
  { script: "han", language: "zh", ranges: [[0x4e00, 0x9fff], [0x3400, 0x4dbf]] },
];

/** High-frequency function words. Ordering inside a set does not matter. */
const STOPWORDS: Record<string, string[]> = {
  en: "the and of to a in is it that you was for on are with as his they be at one have this from or had by not but what some we can out other were all there when up use your how said an each she which do their time if will way about many then them would write like so these her long make thing see him two has look more day could go come did my sound no most number who over know water than call first people may down side been now find".split(
    " ",
  ),
  es: "el la de que y a en un ser se no haber por con su para como estar tener le lo todo pero más hacer o poder decir este ir otro ese si me ya ver porque dar cuando él muy sin vez mucho saber qué sobre mi mismo yo también hasta año dos querer entre así primero desde grande eso ni nos llegar pasar tiempo ella sí día uno bien poco deber entonces poner cosa tanto hombre parecer nuestro tan donde ahora parte después vida quedar siempre creer hablar llevar dejar nada cada seguir menos nuevo encontrar".split(
    " ",
  ),
  fr: "le de un être et à il avoir ne je son que se qui ce dans en du elle au sur pas plus pouvoir par avec tout faire dire vous mais nous comme ou si leur y aller voir bien où sans tu alors deux vouloir venir quand grand celui notre devoir là jour prendre aussi quelque chose même encore temps homme tenir comment falloir votre savoir passer autre".split(
    " ",
  ),
  de: "der die und in den von zu das mit sich des auf für ist im dem nicht ein eine als auch es an werden aus er hat dass sie nach wird bei einer um am sind noch wie einem über einen so zum war haben nur oder aber vor zur bis mehr durch man sein wurde sei ich kann wo wieder dann unter wir soll hatte da ihren".split(
    " ",
  ),
  it: "il di che e la un a per in non una mi sono ho con si da come ma se lo ti ci questo ha le più cosa anche tutto del della molto essere fare bene quando dove perché".split(
    " ",
  ),
  pt: "de a o que e do da em um para com não uma os no se na por mais as dos como mas ao ele das à seu sua ou quando muito nos já eu também só pelo pela até isso ela entre era depois sem mesmo aos ter seus quem nas me esse eles você essa num nem suas meu às minha têm numa pelos elas".split(
    " ",
  ),
  nl: "de en van ik te dat die in een hij het niet zijn is was op aan met als voor had er maar om hem dan zou of wat mijn men dit zo door over ze zich bij ook tot je mij uit der daar haar naar heb hoe heeft hebben deze u want nog zal me zij nu ge geen omdat iets worden toch al waren veel meer doen toen moet ben zonder kan hun dus alles onder ja eens hier wie werd altijd doch wordt wezen kunnen ons".split(
    " ",
  ),
};

/** Distinguishing letters that quietly settle a Latin-script tie. */
const DIACRITICS: Record<string, RegExp> = {
  es: /[ñ¿¡]/giu,
  pt: /[ãõ]/giu,
  fr: /[çœ]/giu,
  de: /[ß]/giu,
  pl: /[łłąę]/giu,
  tr: /[ğış]/giu,
  cs: /[řěů]/giu,
  da: /[øå]/giu,
  sv: /[å]/giu,
};

const STOPWORD_SETS: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(STOPWORDS).map(([language, words]) => [language, new Set(words)]),
);

export function detectLanguage(text: string): LanguageGuess {
  const counts = new Map<string, number>();
  let letters = 0;
  let latin = 0;

  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined) continue;
    if (!isLetter(code)) continue;
    letters += 1;
    const script = scriptOf(code);
    if (script === "latin") latin += 1;
    if (script) counts.set(script, (counts.get(script) ?? 0) + 1);
  }

  if (letters === 0) return { language: null, confidence: 0, script: "none" };

  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const dominantScript = dominant?.[0] ?? "latin";
  const dominantShare = (dominant?.[1] ?? 0) / letters;

  // A non-Latin script is already decisive; only break exact ties (Han vs kana)
  // with the kana count that `scriptOf` separates.
  if (dominantScript !== "latin" && dominantShare >= 0.3) {
    const language = languageForScript(dominantScript, counts);
    return { language, confidence: Math.min(1, dominantShare), script: dominantScript };
  }

  if (latin === 0) {
    return { language: null, confidence: 0, script: dominantScript };
  }

  const words = text.toLowerCase().match(/\p{L}+/gu) ?? [];
  const scores = new Map<string, number>();
  for (const word of words) {
    for (const [language, set] of Object.entries(STOPWORD_SETS)) {
      if (set.has(word)) scores.set(language, (scores.get(language) ?? 0) + 1);
    }
  }
  for (const [language, pattern] of Object.entries(DIACRITICS)) {
    const hits = (text.match(pattern) ?? []).length;
    if (hits > 0) scores.set(language, (scores.get(language) ?? 0) + hits * 2);
  }

  const total = [...scores.values()].reduce((sum, value) => sum + value, 0);
  const best = [...scores.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!best || total < 3) {
    return { language: null, confidence: 0, script: "latin" };
  }
  const [language, score] = best;
  return {
    language,
    confidence: Math.min(1, score / total) * Math.min(1, score / 8),
    script: "latin",
  };
}

/**
 * Whether a caption body is written in `want`. Unknown detection passes: the
 * gate exists to catch confident mismatches, not to reject short clips.
 */
export function matchesLanguage(guess: LanguageGuess, want: string): boolean {
  const target = normalizeLangTag(want);
  if (target === "" || target === "auto") return true;
  if (guess.language === null) return true;
  if (guess.confidence < 0.2) return true;
  return guess.language === target;
}

/** `en-US` -> `en`, `en-orig` -> `en`, `iw` -> `he`, `zh-Hans` -> `zh`. */
export function normalizeLangTag(tag: string): string {
  const trimmed = tag.trim().toLowerCase();
  if (trimmed === "" || trimmed === "auto") return trimmed === "auto" ? "auto" : "";
  const base = trimmed.split(/[-_]/)[0] ?? "";
  return base === "iw" ? "he" : base === "in" ? "id" : base === "ji" ? "yi" : base;
}

/** True when two tags name the same language after normalization. */
export function sameLanguage(a: string, b: string): boolean {
  return normalizeLangTag(a) === normalizeLangTag(b);
}

function isLetter(code: number): boolean {
  if (code < 0x41) return false;
  return /\p{L}/u.test(String.fromCodePoint(code));
}

function scriptOf(code: number): string | null {
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return "latin";
  if ((code >= 0xc0 && code <= 0x24f) || (code >= 0x1e00 && code <= 0x1eff)) return "latin";
  for (const entry of SCRIPTS) {
    for (const [low, high] of entry.ranges) {
      if (code >= low && code <= high) return entry.script;
    }
  }
  return null;
}

function languageForScript(script: string, counts: Map<string, number>): string | null {
  // Japanese is Han plus kana; Han alone is Chinese.
  if (script === "han") {
    const kana = (counts.get("hiragana") ?? 0) + (counts.get("katakana") ?? 0);
    const han = counts.get("han") ?? 0;
    if (kana > 0 && han > 0) return "ja";
    return "zh";
  }
  if (script === "cyrillic") return "ru";
  const entry = SCRIPTS.find((candidate) => candidate.script === script);
  return entry?.language ?? null;
}
