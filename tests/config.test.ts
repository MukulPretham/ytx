import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema, defaultConfig, loadConfig, saveConfig } from "../src/core/config.ts";
import { resolveLibraryPaths } from "../src/core/paths.ts";

function library(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "ytx-config-"));
  mkdirSync(root, { recursive: true });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("defaultConfig", () => {
  test("is valid on its own", () => {
    expect(ConfigSchema.safeParse(defaultConfig()).success).toBe(true);
  });

  test("defaults are the documented ones", () => {
    const config = defaultConfig();
    expect(config.language).toBe("en");
    expect(config.max_height).toBe(1080);
    expect(config.quality).toBe("auto");
    expect(config.asr_model).toBe("none");
    expect(config.parallel).toBe(1);
    expect(config.browser).toBe("");
    expect(config.export_dir).toBe("");
    expect(config.ytdlp).toBe("auto");
    expect(config.ytdlp_channel).toBe("stable");
    expect(config.canary_urls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("loadConfig", () => {
  test("returns defaults when config.toml is absent", () => {
    const lib = library();
    const { paths } = resolveLibraryPaths({ env: {}, cwd: lib.root, home: lib.root, store: lib.root });
    expect(loadConfig(paths)).toEqual(defaultConfig());
    lib.cleanup();
  });

  test("reads a written config back unchanged", () => {
    const lib = library();
    const { paths } = resolveLibraryPaths({ env: {}, cwd: lib.root, home: lib.root, store: lib.root });
    const config = {
      ...defaultConfig(),
      language: "hi",
      max_height: 720,
      browser: "chrome",
      export_dir: "~/Exports",
    };
    saveConfig(paths, config);
    expect(loadConfig(paths)).toEqual(config);
    lib.cleanup();
  });

  test("a config written before export_dir existed still loads", () => {
    const lib = library();
    const { paths } = resolveLibraryPaths({ env: {}, cwd: lib.root, home: lib.root, store: lib.root });
    const legacy = defaultConfig() as Record<string, unknown>;
    delete legacy.export_dir;
    writeFileSync(
      paths.config,
      [
        "schema = 1",
        'language = "en"',
        "max_height = 1080",
        'quality = "auto"',
        'asr_model = "none"',
        'ytdlp = "auto"',
        "parallel = 1",
        'browser = ""',
        'ytdlp_channel = "stable"',
        'canary_urls = [ "https://www.youtube.com/watch?v=jNQXAC9IVRw" ]',
        "",
      ].join("\n"),
    );
    expect(loadConfig(paths).export_dir).toBe("");
    lib.cleanup();
  });

  test("refuses invalid TOML with an integrity error", () => {
    const lib = library();
    const { paths } = resolveLibraryPaths({ env: {}, cwd: lib.root, home: lib.root, store: lib.root });
    writeFileSync(paths.config, "this is = = not toml\n");
    expect(() => loadConfig(paths)).toThrow(/not valid TOML/);
    lib.cleanup();
  });

  test("refuses a config that fails validation", () => {
    const lib = library();
    const { paths } = resolveLibraryPaths({ env: {}, cwd: lib.root, home: lib.root, store: lib.root });
    writeFileSync(paths.config, 'schema = 1\nlanguage = "en"\nmax_height = -5\n');
    expect(() => loadConfig(paths)).toThrow(/failed validation: max_height/);
    lib.cleanup();
  });

  test("names the fix in the error", () => {
    const lib = library();
    const { paths } = resolveLibraryPaths({ env: {}, cwd: lib.root, home: lib.root, store: lib.root });
    writeFileSync(paths.config, "schema = 1\n");
    try {
      loadConfig(paths);
      throw new Error("expected a throw");
    } catch (err) {
      const error = err as { next: string };
      expect(error.next).toContain("ytx setup");
    }
    lib.cleanup();
  });
});

describe("saveConfig", () => {
  test("round-trips through TOML and keeps canary URLs", () => {
    const lib = library();
    const { paths } = resolveLibraryPaths({ env: {}, cwd: lib.root, home: lib.root, store: lib.root });
    const config = { ...defaultConfig(), canary_urls: ["https://www.youtube.com/watch?v=jNQXAC9IVRw"] };
    saveConfig(paths, config);
    const text = readFileSync(paths.config, "utf8");
    expect(text).toContain("canary_urls");
    expect(loadConfig(paths).canary_urls).toEqual(config.canary_urls);
    lib.cleanup();
  });

  test("refuses to write an invalid config", () => {
    const lib = library();
    const { paths } = resolveLibraryPaths({ env: {}, cwd: lib.root, home: lib.root, store: lib.root });
    expect(() => saveConfig(paths, { ...defaultConfig(), parallel: 0 })).toThrow(/refusing to write/);
    lib.cleanup();
  });

  test("creates the library directory when missing", () => {
    const lib = library();
    const root = join(lib.root, "nested", "library");
    const { paths } = resolveLibraryPaths({ env: {}, cwd: lib.root, home: lib.root, store: root });
    saveConfig(paths, defaultConfig());
    expect(readFileSync(paths.config, "utf8")).toContain("language");
    lib.cleanup();
  });
});
