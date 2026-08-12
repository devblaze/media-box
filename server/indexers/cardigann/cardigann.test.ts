import { describe, expect, it } from "vitest";
import { evalTemplate, TemplateError, toJsRegExp, validateTemplate } from "./template";
import { applyFilters, applyFiltersLenient, htmlDecode, parseIntSafe, parseSize } from "./filters";
import {
  resolveMappings,
  torznabCategoriesFor,
  torznabCategoryId,
  trackerCategoriesFor,
} from "./categories";
import { analyzeDefinition, configDefaults, parseDefinition, searchPaths } from "./definition";
import { toCatalogEntry } from "./catalog";
import { buildContext, parseSearchHtml } from "./search";
import { parseFuzzyDate, parseWithLayout } from "./dates";

/** Offline unit tests — no network, inline fixtures only. */

describe("template evaluator", () => {
  const ctx = {
    ".Keywords": "the wire s01e05",
    ".Categories": ["205", "208"],
    ".Config.sort": "seeders",
    ".Config.disablesort": "",
    ".Config.uploader": "",
    ".True": "True",
    ".False": "",
    ".Result.title_optional": "",
    ".Result.title_default": "Fallback Title",
  };

  it("substitutes plain variables", () => {
    expect(evalTemplate("search/{{ .Keywords }}/1/", ctx)).toBe("search/the wire s01e05/1/");
    expect(evalTemplate("{{ .Config.sort }}", ctx)).toBe("seeders");
  });

  it("returns literal text untouched when there is no action", () => {
    expect(evalTemplate("/latest100", ctx)).toBe("/latest100");
  });

  it("resolves unknown variables to the empty string", () => {
    expect(evalTemplate("[{{ .Config.nope }}]", ctx)).toBe("[]");
  });

  it("handles if/else", () => {
    const tpl = "{{ if .Keywords }}search/{{ .Keywords }}{{ else }}latest{{ end }}";
    expect(evalTemplate(tpl, ctx)).toBe("search/the wire s01e05");
    expect(evalTemplate(tpl, { ...ctx, ".Keywords": "" })).toBe("latest");
  });

  it("handles else-if chains", () => {
    const tpl = "{{ if .A }}a{{ else if .B }}b{{ else }}c{{ end }}";
    expect(evalTemplate(tpl, { ".A": "x" })).toBe("a");
    expect(evalTemplate(tpl, { ".B": "y" })).toBe("b");
    expect(evalTemplate(tpl, {})).toBe("c");
  });

  it("handles nested ifs", () => {
    const tpl = "{{ if .A }}[{{ if .B }}both{{ else }}onlyA{{ end }}]{{ else }}none{{ end }}";
    expect(evalTemplate(tpl, { ".A": "1", ".B": "1" })).toBe("[both]");
    expect(evalTemplate(tpl, { ".A": "1" })).toBe("[onlyA]");
    expect(evalTemplate(tpl, {})).toBe("none");
  });

  it("supports and/or/eq/ne/not", () => {
    expect(evalTemplate("{{ if and .Keywords .Config.sort }}y{{ else }}n{{ end }}", ctx)).toBe("y");
    expect(evalTemplate("{{ if and .Keywords .Config.uploader }}y{{ else }}n{{ end }}", ctx)).toBe("n");
    expect(evalTemplate("{{ if or .Config.uploader .Config.sort }}y{{ else }}n{{ end }}", ctx)).toBe("y");
    expect(evalTemplate("{{ if eq .Config.disablesort .False }}y{{ else }}n{{ end }}", ctx)).toBe("y");
    expect(evalTemplate("{{ if ne .Config.sort .False }}y{{ else }}n{{ end }}", ctx)).toBe("y");
    expect(evalTemplate("{{ if not .Config.uploader }}y{{ else }}n{{ end }}", ctx)).toBe("y");
  });

  it("supports parenthesized sub-expressions like 1337x uses", () => {
    const tpl = "{{ if and (.Keywords) (eq .Config.disablesort .False) }}sort-{{ else }}{{ end }}";
    expect(evalTemplate(tpl, ctx)).toBe("sort-");
    expect(evalTemplate(tpl, { ...ctx, ".Config.disablesort": "True" })).toBe("");
  });

  it("picks the first truthy value with or, Go-style", () => {
    const tpl = "{{ or .Result.title_optional .Result.title_default }}";
    expect(evalTemplate(tpl, ctx)).toBe("Fallback Title");
  });

  it("ranges over .Categories", () => {
    expect(evalTemplate("{{ range .Categories }}&c[]={{ . }}{{ end }}", ctx)).toBe("&c[]=205&c[]=208");
  });

  it("joins arrays", () => {
    expect(evalTemplate('{{ join .Categories "," }}', ctx)).toBe("205,208");
    // A bare array reference stringifies with commas too.
    expect(evalTemplate("{{ .Categories }}", ctx)).toBe("205,208");
  });

  it("applies re_replace inside templates", () => {
    expect(evalTemplate('{{ re_replace .Keywords "s01e05" "" }}', ctx)).toBe("the wire ");
  });

  it("escapes substituted values but not literal text", () => {
    const out = evalTemplate("search/{{ .Keywords }}/1/", ctx, { escape: encodeURIComponent });
    expect(out).toBe("search/the%20wire%20s01e05/1/");
  });

  it("tolerates the stray closing paren in the real 1337x definition", () => {
    const tpl = "{{ if and (.Keywords) (eq .Config.disablesort .False)) }}x{{ else }}y{{ end }}";
    expect(evalTemplate(tpl, ctx)).toBe("x");
  });

  it("rejects constructs the engine does not implement", () => {
    expect(() => validateTemplate("{{ with .Foo }}x{{ end }}")).toThrow(TemplateError);
    expect(() => validateTemplate("{{ printf \"%d\" .X }}")).toThrow(TemplateError);
    expect(() => validateTemplate("{{ if .A }}unterminated")).toThrow(TemplateError);
  });

  it("hoists Go inline regex flags into JS RegExp flags", () => {
    expect(toJsRegExp("(?i)web\\sdl").flags).toContain("i");
    expect(toJsRegExp("(?i)WEB\\sDL", "g").test("web dl")).toBe(true);
  });
});

describe("filter chain", () => {
  const ctx = { ".Config.site": "https://example.org" };

  it("runs regexp and returns the first capture group", () => {
    const out = applyFilters(
      "/the-wire-s01e05-torrent-12345.html",
      [{ name: "regexp", args: "/(.+?)-torrent-\\d+\\.html" }],
      ctx
    );
    expect(out).toBe("the-wire-s01e05");
  });

  it("returns the whole match when the regexp has no capture group", () => {
    expect(applyFilters("abc123def", [{ name: "regexp", args: "\\d+" }], ctx)).toBe("123");
  });

  it("throws when a regexp does not match", () => {
    expect(() => applyFilters("nope", [{ name: "regexp", args: "\\d+" }], ctx)).toThrow();
  });

  it("chains filters in order, as limetorrents does for titles", () => {
    const out = applyFilters(
      "/the-wire-s01e05-torrent-12345.html",
      [
        { name: "regexp", args: "/(.+?)-torrent-\\d+\\.html" },
        { name: "re_replace", args: ["-", " "] },
      ],
      ctx
    );
    expect(out).toBe("the wire s01e05");
  });

  it("supports replace/prepend/append/trim/tolower/toupper", () => {
    expect(applyFilters("a-b-c", [{ name: "replace", args: ["-", "+"] }], ctx)).toBe("a+b+c");
    expect(applyFilters("x", [{ name: "prepend", args: "pre-" }], ctx)).toBe("pre-x");
    expect(applyFilters("x", [{ name: "append", args: "-post" }], ctx)).toBe("x-post");
    expect(applyFilters("  pad  ", [{ name: "trim" }], ctx)).toBe("pad");
    expect(applyFilters("///x///", [{ name: "trim", args: "/" }], ctx)).toBe("x");
    expect(applyFilters("MiXeD", [{ name: "tolower" }], ctx)).toBe("mixed");
    expect(applyFilters("MiXeD", [{ name: "toupper" }], ctx)).toBe("MIXED");
  });

  it("splits by separator and index, including negative indexes", () => {
    expect(applyFilters("/torrent/12345/the-wire/", [{ name: "split", args: ["/", 3] }], ctx)).toBe("the-wire");
    expect(applyFilters("a|b|c", [{ name: "split", args: ["|", -1] }], ctx)).toBe("c");
  });

  it("extracts querystring params", () => {
    expect(applyFilters("/dl.php?id=987&x=1", [{ name: "querystring", args: "id" }], ctx)).toBe("987");
  });

  it("urldecodes and htmldecodes", () => {
    expect(applyFilters("The%20Wire+S01", [{ name: "urldecode" }], ctx)).toBe("The Wire S01");
    expect(applyFilters("Tom &amp; Jerry &#8211; S01", [{ name: "htmldecode" }], ctx)).toBe(
      "Tom & Jerry – S01"
    );
    expect(htmlDecode("&lt;b&gt;&quot;x&quot;&lt;/b&gt;")).toBe('<b>"x"</b>');
  });

  it("template-evaluates filter arguments", () => {
    expect(applyFilters("/x", [{ name: "prepend", args: "{{ .Config.site }}" }], ctx)).toBe(
      "https://example.org/x"
    );
  });

  it("swallows failures in lenient mode (keywordsfilters)", () => {
    // The season tag strip from limetorrents; an unknown filter is ignored.
    const out = applyFiltersLenient(
      "the wire S01",
      [
        { name: "re_replace", args: ["S[0-9]{2}([^E]|$)", ""] },
        { name: "totally_unknown_filter" },
      ],
      ctx
    );
    expect(out).toBe("the wire ");
  });

  it("parses dates with dateparse/fuzzytime without throwing", () => {
    const iso = applyFilters("2023-04-18 10:30:00", [{ name: "dateparse", args: "yyyy-MM-dd HH:mm:ss" }], ctx);
    expect(iso).toBe("2023-04-18T10:30:00.000Z");
    const ago = applyFilters("3 days ago", [{ name: "fuzzytime" }], ctx);
    expect(Number.isNaN(Date.parse(ago))).toBe(false);
    // Unparseable values degrade to the raw string rather than exploding.
    expect(applyFilters("???", [{ name: "dateparse", args: "yyyy-MM-dd" }], ctx)).toBe("???");
  });
});

describe("size + count parsing", () => {
  it("parses human sizes into bytes with 1024 multiples", () => {
    expect(parseSize("1.2 GB")).toBe(Math.round(1.2 * 1024 ** 3));
    expect(parseSize("700 MB")).toBe(700 * 1024 ** 2);
    expect(parseSize("700MiB")).toBe(700 * 1024 ** 2);
    expect(parseSize("1,024 KB")).toBe(1024 * 1024);
    expect(parseSize("512")).toBe(512);
    expect(parseSize("4.5 TB")).toBe(Math.round(4.5 * 1024 ** 4));
    expect(parseSize(" 1.5 GB ")).toBe(Math.round(1.5 * 1024 ** 3));
  });

  it("returns 0 for junk sizes rather than NaN", () => {
    expect(parseSize("n/a")).toBe(0);
    expect(parseSize("")).toBe(0);
  });

  it("parses seeder/leecher counts", () => {
    expect(parseIntSafe("1,234")).toBe(1234);
    expect(parseIntSafe("5.2k")).toBe(5200);
    expect(parseIntSafe("0")).toBe(0);
    expect(parseIntSafe("--")).toBe(null);
  });
});

describe("category mapping", () => {
  const caps = {
    categorymappings: [
      { id: 41, cat: "TV/HD", desc: "TV/HD" },
      { id: 5, cat: "TV", desc: "TV/DVD" },
      { id: 42, cat: "Movies/HD", desc: "Movies/HD" },
      { id: 28, cat: "TV/Anime", desc: "Anime" },
      { id: 99, cat: "Bogus/Nonexistent", desc: "unknown" },
    ],
    modes: { search: ["q"], "tv-search": ["q", "season", "ep"] },
  };

  it("maps Torznab category names to ids case-insensitively", () => {
    expect(torznabCategoryId("TV/HD")).toBe(5040);
    expect(torznabCategoryId("movies/hd")).toBe(2040);
    expect(torznabCategoryId("Not/AThing")).toBe(null);
  });

  it("drops mappings with unknown Torznab names", () => {
    const mappings = resolveMappings(caps);
    expect(mappings).toHaveLength(4);
    expect(mappings.map((m) => m.torznabId).sort()).toEqual([2040, 5000, 5040, 5070]);
  });

  it("expands a parent query category to every child tracker category", () => {
    const mappings = resolveMappings(caps);
    // 5000 (TV) selects TV, TV/HD and TV/Anime tracker ids but not Movies.
    expect(trackerCategoriesFor(mappings, [5000]).sort()).toEqual(["28", "41", "5"]);
    expect(trackerCategoriesFor(mappings, [2040])).toEqual(["42"]);
    expect(trackerCategoriesFor(mappings, [])).toEqual([]);
  });

  it("maps a scraped tracker category back to Torznab ids", () => {
    const mappings = resolveMappings(caps);
    expect(torznabCategoriesFor(mappings, "41")).toEqual([5040]);
    expect(torznabCategoriesFor(mappings, "99")).toEqual([]);
  });

  it("supports the legacy flat categories dict", () => {
    const mappings = resolveMappings({ categories: { "TV shows": "TV", Movies: "Movies" } });
    expect(mappings).toEqual([
      { trackerId: "TV shows", torznabId: 5000 },
      { trackerId: "Movies", torznabId: 2000 },
    ]);
  });
});

describe("date layouts", () => {
  it("parses C# style layouts", () => {
    expect(parseWithLayout("18-04-2023", "dd-MM-yyyy")?.toISOString()).toBe("2023-04-18T00:00:00.000Z");
    expect(parseWithLayout("Apr. 18 11", "MMM. d yy")?.toISOString()).toBe("2011-04-18T00:00:00.000Z");
  });

  it("parses Go reference layouts", () => {
    expect(parseWithLayout("2023-04-18", "2006-01-02")?.toISOString()).toBe("2023-04-18T00:00:00.000Z");
    expect(parseWithLayout("2023-04-18 21:30", "2006-01-02 15:04")?.toISOString()).toBe(
      "2023-04-18T21:30:00.000Z"
    );
  });

  it("returns null when the value does not fit the layout", () => {
    expect(parseWithLayout("gibberish", "yyyy-MM-dd")).toBe(null);
  });

  it("parses relative times", () => {
    const now = Date.now();
    const threeDays = parseFuzzyDate("3 days ago");
    expect(threeDays).not.toBe(null);
    expect(Math.abs((threeDays as Date).getTime() - (now - 3 * 86_400_000))).toBeLessThan(5000);
    expect(parseFuzzyDate("now")).not.toBe(null);
    expect(parseFuzzyDate("yesterday")).not.toBe(null);
    expect(parseFuzzyDate("")).toBe(null);
  });
});

/** A minimal but realistic public definition, modeled on limetorrents. */
const PUBLIC_DEF = `---
id: fixturetracker
name: FixtureTracker
description: "A fixture public tracker"
language: en-US
type: public
encoding: UTF-8
links:
  - https://fixture.example/
caps:
  categorymappings:
    - {id: "TV shows", cat: TV, desc: "TV shows"}
    - {id: Movies, cat: Movies, desc: Movies}
  modes:
    search: [q]
    tv-search: [q, season, ep]
    movie-search: [q]
settings:
  - name: sort
    type: select
    label: Sort
    default: date
    options:
      date: created
      seeds: seeders
  - name: freeleech
    type: checkbox
    label: Freeleech only
    default: false
  - name: info_blurb
    type: info
    label: About
    default: this is UI prose, not config
search:
  paths:
    - path: "{{ if .Keywords }}search/{{ .Keywords }}/{{ .Config.sort }}/1/{{ else }}latest{{ end }}"
  rows:
    selector: table.results > tbody > tr
  fields:
    title:
      selector: a.name
    details:
      selector: a.name
      attribute: href
    download:
      selector: a.dl
      attribute: href
    size:
      selector: td.size
    seeders:
      selector: td.seeds
    leechers:
      selector: td.leech
    category:
      selector: td.cat
`;

describe("definition parsing + analysis", () => {
  it("parses a public definition and marks it supported", () => {
    const def = parseDefinition(PUBLIC_DEF);
    expect(def.id).toBe("fixturetracker");
    expect(searchPaths(def)).toHaveLength(1);
    const analyzed = analyzeDefinition(def);
    expect(analyzed.unsupportedReason).toBeUndefined();
    expect(analyzed.supported).toBe(true);
  });

  it("derives config defaults, skipping info fields and normalizing checkboxes", () => {
    const config = configDefaults(parseDefinition(PUBLIC_DEF));
    expect(config).toEqual({ sort: "date", freeleech: "" });
  });

  it("builds a catalog entry with deduped, sorted Torznab categories", () => {
    const entry = toCatalogEntry(parseDefinition(PUBLIC_DEF));
    expect(entry.id).toBe("fixturetracker");
    expect(entry.supported).toBe(true);
    expect(entry.categories).toEqual([2000, 5000]);
    expect(entry.supportsTv).toBe(true);
    expect(entry.supportsMovies).toBe(true);
    expect(entry.links).toEqual(["https://fixture.example/"]);
  });

  it("rejects private definitions", () => {
    const def = parseDefinition(PUBLIC_DEF.replace("type: public", "type: private"));
    const analyzed = analyzeDefinition(def);
    expect(analyzed.supported).toBe(false);
    expect(analyzed.unsupportedReason).toMatch(/public/i);
  });

  it("rejects definitions with a login block", () => {
    const def = parseDefinition(`${PUBLIC_DEF}\nlogin:\n  path: /login\n  method: form\n`);
    const analyzed = analyzeDefinition(def);
    expect(analyzed.supported).toBe(false);
    expect(analyzed.unsupportedReason).toMatch(/login/i);
  });

  it("rejects POST searches and non-HTML responses", () => {
    const post = parseDefinition(PUBLIC_DEF.replace('    - path: "', '    - method: post\n      path: "'));
    expect(analyzeDefinition(post).unsupportedReason).toMatch(/POST/);
    const json = parseDefinition(
      PUBLIC_DEF.replace('    - path: "', '    - response:\n        type: json\n      path: "')
    );
    expect(analyzeDefinition(json).unsupportedReason).toMatch(/JSON/);
  });

  it("rejects definitions using a filter the engine lacks", () => {
    const def = parseDefinition(
      PUBLIC_DEF.replace(
        "    size:\n      selector: td.size",
        "    size:\n      selector: td.size\n      filters:\n        - name: hexdump"
      )
    );
    const analyzed = analyzeDefinition(def);
    expect(analyzed.supported).toBe(false);
    expect(analyzed.unsupportedReason).toMatch(/hexdump/);
  });

  it("rejects definitions whose templates we cannot evaluate", () => {
    const def = parseDefinition(
      PUBLIC_DEF.replace('path: "{{ if .Keywords }}', 'path: "{{ with .Keywords }}')
    );
    expect(analyzeDefinition(def).supported).toBe(false);
  });

  it("rejects definitions with no rows selector", () => {
    const def = parseDefinition(PUBLIC_DEF.replace("    selector: table.results > tbody > tr", "    after: 1"));
    expect(analyzeDefinition(def).unsupportedReason).toMatch(/rows/i);
  });
});

/**
 * The whole scrape path (rows → fields → filters → URL resolution → category
 * mapping) against an inline HTML fixture. This is the closest we can get to
 * an end-to-end test without reaching a real tracker.
 */
describe("scraping a results page", () => {
  const def = parseDefinition(PUBLIC_DEF);
  const ctx = buildContext(def, "the wire", [], { t: "search" });
  const pageUrl = "https://fixture.example/search/the%20wire/date/1/";

  const HTML = `
    <html><body>
    <table class="results"><tbody>
      <tr>
        <td><a class="name" href="/torrent/111/the-wire-s01e05">The Wire S01E05 1080p WEB-DL</a></td>
        <td class="cat">TV shows</td>
        <td class="size">1.2 GB</td>
        <td class="seeds">1,234</td>
        <td class="leech">56</td>
        <td><a class="dl" href="magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&dn=x">get</a></td>
      </tr>
      <tr>
        <td><a class="name" href="/torrent/222/some-movie">Some Movie 2019 2160p</a></td>
        <td class="cat">Movies</td>
        <td class="size">7.5 GB</td>
        <td class="seeds">9</td>
        <td class="leech">0</td>
        <td><a class="dl" href="/download/222.torrent">get</a></td>
      </tr>
      <tr><td colspan="6">advertisement — no fields here</td></tr>
    </tbody></table>
    </body></html>`;

  const items = parseSearchHtml(def, HTML, pageUrl, ctx);

  it("skips rows that do not yield the required fields", () => {
    // The ad row has no a.name, so the mandatory title selector fails.
    expect(items).toHaveLength(2);
  });

  it("extracts titles", () => {
    expect(items[0].title).toBe("The Wire S01E05 1080p WEB-DL");
    expect(items[1].title).toBe("Some Movie 2019 2160p");
  });

  it("parses sizes into bytes and counts into numbers", () => {
    expect(items[0].size).toBe(Math.round(1.2 * 1024 ** 3));
    expect(items[0].seeders).toBe(1234);
    expect(items[0].leechers).toBe(56);
    expect(items[1].size).toBe(Math.round(7.5 * 1024 ** 3));
  });

  it("resolves relative links against the page URL and keeps magnets intact", () => {
    expect(items[0].link).toBe(
      "magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&dn=x"
    );
    expect(items[0].magnetUrl).toBe(items[0].link);
    expect(items[1].link).toBe("https://fixture.example/download/222.torrent");
    expect(items[1].magnetUrl).toBeUndefined();
  });

  it("resolves details links and uses them as the guid", () => {
    expect(items[0].guid).toBe("https://fixture.example/torrent/111/the-wire-s01e05");
  });

  it("maps tracker categories to Torznab ids", () => {
    expect(items[0].categories).toEqual([5000]);
    expect(items[1].categories).toEqual([2000]);
  });
});
