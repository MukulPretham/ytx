/**
 * The model catalog.
 *
 * Names are stable; repos, revisions and sizes are pinned so `ytx models add
 * turbo` is reproducible. Anything outside this list is accepted by explicit
 * repo, with a warning that it is untested.
 */

export interface CatalogEntry {
  name: string;
  repo: string;
  /** Pinned commit revision on the hub. */
  revision: string;
  /** Approximate download size in megabytes, for the disk pre-check. */
  size_mb: number;
  /** One line: what you trade for the size. */
  note: string;
  default?: boolean;
}

export const CATALOG: CatalogEntry[] = [
  {
    name: "turbo",
    repo: "mlx-community/whisper-large-v3-turbo",
    revision: "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb",
    size_mb: 1614,
    note: "best quality per gigabyte; the default",
    default: true,
  },
  {
    name: "turbo-q4",
    repo: "mlx-community/whisper-large-v3-turbo-q4",
    revision: "660c343bbf4e52ac257f0b7d952e5388e6f93bef",
    size_mb: 464,
    note: "quantized turbo; ~3x smaller, slightly less accurate",
  },
  {
    name: "small",
    repo: "mlx-community/whisper-small-mlx",
    revision: "45f3915923c7a79a5a5b5a7d909d39aeb0e5630e",
    size_mb: 481,
    note: "fast and light; noticeably weaker on accents and noise",
  },
  {
    name: "large-v3",
    repo: "mlx-community/whisper-large-v3-mlx",
    revision: "49e6aa286ad60c14352c404340ded53710378a11",
    size_mb: 3084,
    note: "most accurate and slowest; ~2x the disk of turbo",
  },
];

export const DEFAULT_MODEL_NAME = "turbo";

export function findCatalogEntry(name: string): CatalogEntry | undefined {
  const lowered = name.trim().toLowerCase();
  return CATALOG.find((entry) => entry.name === lowered || entry.repo.toLowerCase() === lowered);
}

export function catalogEntryForRepo(repo: string): CatalogEntry | undefined {
  const lowered = repo.trim().toLowerCase();
  return CATALOG.find((entry) => entry.repo.toLowerCase() === lowered);
}

/** A filesystem-safe, human-readable directory name for a model. */
export function modelDirName(name: string): string {
  return name
    .trim()
    .replace(/^https?:\/\/huggingface\.co\//i, "")
    .replace(/^hf\.co\//i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "--")
    .replace(/^--+|-+$/g, "");
}

/** Accept `owner/repo`, `hf.co/owner/repo`, and a full hub URL. */
export function parseRepoInput(input: string): string | null {
  let value = input.trim();
  if (value === "") return null;
  value = value.replace(/^https?:\/\//i, "");
  value = value.replace(/^(www\.)?huggingface\.co\//i, "");
  value = value.replace(/^hf\.co\//i, "");
  value = value.replace(/\/+$/, "");
  if (value.includes("/tree/")) value = value.split("/tree/")[0] ?? value;
  if (value.includes("/resolve/")) value = value.split("/resolve/")[0] ?? value;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) return null;
  return value;
}
