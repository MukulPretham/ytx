/**
 * The acquisition ladder.
 *
 * First tier that passes the gates wins. The ladder is pure: it returns an
 * ordered plan of attempts from tracks the downloader reported, and the caller
 * fetches and gates them in that order. Tier 4 is transcription, which needs
 * audio rather than a track.
 */

import { normalizeLangTag } from "./lang.ts";

export type CaptionSource = "caption-human" | "caption-auto";

export interface CaptionFormat {
  ext: string;
  url: string;
  name?: string | null;
  /**
   * True when the URL carries `tlang`, i.e. the platform is offering a machine
   * translation of the ASR track rather than the ASR output itself.
   */
  translated?: boolean;
}

export type TrackMap = Record<string, CaptionFormat[]>;

export interface Availability {
  human: TrackMap;
  auto: TrackMap;
  /** yt-dlp's `language`, e.g. "en". Used when the preference is "auto". */
  originalLanguage: string | null;
}

export type Quality = "auto" | "best";

export interface LadderOptions {
  /** Preferred language, or "auto" for the video's original language. */
  preferredLanguage: string;
  quality: Quality;
  /** `--asr`: skip captions entirely. */
  forceAsr?: boolean;
  /** `--no-asr`: stop after tier 3. */
  noAsr?: boolean;
  /** `--strict-lang`: never fall back to another language. */
  strictLang?: boolean;
}

export type Tier = 1 | 2 | 3 | 4;

export interface LadderStep {
  tier: Tier;
  source: CaptionSource | "asr";
  /** Language that will be recorded if this step wins. */
  language: string;
  /** Key into the availability map; null for ASR. */
  trackKey: string | null;
  /** Human-readable reason, used in `--json` output and `doctor`. */
  reason: string;
}

export interface LadderPlan {
  steps: LadderStep[];
  /** Why a tier was skipped, so `--json` can explain a surprising outcome. */
  skipped: { tier: Tier; reason: string }[];
}

export function resolvePreferredLanguage(
  preferred: string,
  availability: Availability,
): string {
  if (preferred !== "auto") return normalizeLangTag(preferred);
  const original = availability.originalLanguage ? normalizeLangTag(availability.originalLanguage) : "";
  return original !== "" ? original : "en";
}

export function planLadder(
  availability: Availability,
  options: LadderOptions,
): LadderPlan {
  const preferred = resolvePreferredLanguage(options.preferredLanguage, availability);
  const steps: LadderStep[] = [];
  const skipped: { tier: Tier; reason: string }[] = [];
  const seen = new Set<string>();

  const push = (step: LadderStep, key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    steps.push(step);
  };

  if (options.forceAsr) {
    skipped.push({ tier: 1, reason: "--asr forced tier 4" });
    skipped.push({ tier: 2, reason: "--asr forced tier 4" });
    skipped.push({ tier: 3, reason: "--asr forced tier 4" });
    push(
      {
        tier: 4,
        source: "asr",
        language: preferred,
        trackKey: null,
        reason: "--asr: transcribe the audio locally",
      },
      "asr",
    );
    return { steps, skipped };
  }

  // Tier 1 - human captions in the preferred language.
  const humanPreferred = tracksFor(availability.human, preferred);
  if (humanPreferred.length === 0) {
    skipped.push({ tier: 1, reason: `no human caption track in ${preferred}` });
  }
  for (const key of humanPreferred) {
    push(
      {
        tier: 1,
        source: "caption-human",
        language: normalizeLangTag(key),
        trackKey: key,
        reason: `human captions in ${preferred}`,
      },
      `human:${key}`,
    );
  }

  // Tier 2 - human captions in another language.
  if (options.strictLang) {
    skipped.push({ tier: 2, reason: "--strict-lang forbids another language" });
  } else {
    const others = otherHumanLanguages(availability.human, preferred, availability.originalLanguage);
    if (others.length === 0) {
      skipped.push({ tier: 2, reason: "no human captions in any other language" });
    }
    for (const key of others) {
      push(
        {
          tier: 2,
          source: "caption-human",
          language: normalizeLangTag(key),
          trackKey: key,
          reason: `human captions in ${normalizeLangTag(key)} (preferred ${preferred} unavailable)`,
        },
        `human:${key}`,
      );
    }
  }

  // Tier 3 is deliberately absent in this build. Platform machine captions
  // were unreliable (YouTube answered HTTP 429 for the timedtext track, and
  // the translated `tlang` variants were blocked outright), and the captain's
  // instruction is: use human captions, otherwise transcribe locally. The
  // `caption-auto` provenance remains in the schema so libraries archived
  // before this change stay readable and searchable.
  skipped.push({
    tier: 3,
    reason:
      "platform machine captions are not acquired in this build; human captions or local transcription only",
  });

  // Tier 4 - local transcription.
  if (options.noAsr) {
    skipped.push({ tier: 4, reason: "--no-asr stops after human captions" });
  } else {
    push(
      {
        tier: 4,
        source: "asr",
        language: preferred,
        trackKey: null,
        reason: "no caption track passed the gates; transcribe the audio locally",
      },
      "asr",
    );
  }

  return { steps, skipped };
}

/**
 * Track keys in `map` whose language is `language`, best first: an exact tag
 * beats a regional variant, and a track with WebVTT available beats one without.
 */
export function tracksFor(map: TrackMap, language: string): string[] {
  const wanted = normalizeLangTag(language);
  const candidates = Object.keys(map).filter((key) => normalizeLangTag(key) === wanted);
  return orderTrackKeys(candidates);
}

/**
 * Track keys whose language matches and which include at least one URL that is
 * the platform's own ASR output, not a `tlang` translation of it.
 */
export function untranslatedTracksFor(map: TrackMap, language: string): string[] {
  const wanted = normalizeLangTag(language);
  const candidates = Object.keys(map).filter((key) => {
    if (normalizeLangTag(key) !== wanted) return false;
    const formats = map[key] ?? [];
    return formats.some((format) => !format.translated);
  });
  return orderTrackKeys(candidates);
}

export function otherHumanLanguages(
  human: TrackMap,
  preferred: string,
  originalLanguage: string | null,
): string[] {
  const preferredBase = normalizeLangTag(preferred);
  const original = originalLanguage ? normalizeLangTag(originalLanguage) : "";
  const keys = Object.keys(human).filter((key) => normalizeLangTag(key) !== preferredBase);

  // The video's own language is the most faithful fallback; then English, then
  // whatever else the platform offers, in a stable order.
  const rank = (key: string): number => {
    const base = normalizeLangTag(key);
    if (base === original && base !== "") return 0;
    if (base === "en") return 1;
    return 2;
  };
  return keys.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Exact tags beat regional variants; `-orig` beats other variants. */
function orderTrackKeys(keys: string[]): string[] {
  const score = (key: string): number => {
    if (normalizeLangTag(key) === key) return 0; // exact `en` before `en-US`
    if (/-orig$/i.test(key)) return 1;
    return 2;
  };
  return [...keys].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
}
