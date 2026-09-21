import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatFinding, interpolations, unescapedInterpolations } from "../scripts/escape-rule.ts";

/**
 * The guard rule that stands between model output and the page.
 *
 * A guard rule that cannot be wrong is not a guard rule, it is a decoration.
 * The rule this replaced produced 74 findings, none of them real, which is how a
 * rule ends up deleted; but the same bug that produced the noise also hid at
 * least one genuinely unchecked interpolation from it (see "the bug that mattered"
 * below). So the first half of this file is about the rule still biting, and only
 * the second half is about it being quiet on the code we have.
 */

/**
 * A view file, written a line at a time.
 *
 * Double-quoted lines rather than a template literal, because every fixture here
 * is itself full of backticks and `${`, and escaping them would make the thing
 * under test unreadable at exactly the point where it needs to be read.
 */
const view = (...lines: string[]): string =>
  ['import { esc, paragraphs } from "./layout.ts";', 'import { formatUsd } from "../money.ts";', ...lines].join("\n");

const offenders = (source: string): string[] => unescapedInterpolations(source).map((u) => u.offending);

// ---------------------------------------------------------------------------
// It bites.
// ---------------------------------------------------------------------------

describe("the escape rule catches an unescaped interpolation", () => {
  it("flags model prose interpolated raw", () => {
    const src = view(
      "export function perf(p: { text: string }): string {",
      "  return `<div class=\"perf\">${p.text}</div>`;",
      "}",
    );
    expect(offenders(src)).toEqual(["p.text"]);
  });

  it("flags a ledger description interpolated raw inside a mapped row", () => {
    const src = view(
      "export function rows(entries: Array<{ description: string }>): string {",
      "  const body = entries.map((e) => `<tr><td>${e.description}</td></tr>`).join(\"\");",
      "  return `<table>${body}</table>`;",
      "}",
    );
    expect(offenders(src)).toEqual(["e.description"]);
  });

  /**
   * The bug that mattered.
   *
   * The old extractor was `/\$\{([^}]*)/g` — everything up to the first `}` —
   * and the old rule skipped any expression containing the text "esc(". On this
   * input those two combine into a hole: the extract stops inside the *first*
   * branch, that truncated fragment contains "esc(", the whole interpolation is
   * waved through, and the second branch is never looked at. `b` reaches the
   * page unescaped and nothing says so.
   */
  it("flags an unescaped branch hiding behind an escaped one", () => {
    const src = view(
      "export function either(cond: boolean, a: string, b: string): string {",
      "  return `<div>${cond ? `<b>${esc(a)}</b>` : `<i>${b}</i>`}</div>`;",
      "}",
    );
    expect(offenders(src)).toEqual(["b"]);
  });

  it("flags an unescaped interpolation that follows an object literal", () => {
    const src = view(
      "export function line(n: number, e: { description: string }): string {",
      '  return `<p>${esc(n.toLocaleString("en-US", { style: "decimal" }))} ${e.description}</p>`;',
      "}",
    );
    expect(offenders(src)).toEqual(["e.description"]);
  });

  it("flags a local whose own initializer is unsafe", () => {
    const src = view(
      "export function who(p: { name: string }): string {",
      "  const label = `<span>${p.name}</span>`;",
      "  return `<li>${label}</li>`;",
      "}",
    );
    // Once where it is built, once where it is used — both point at `p.name`.
    expect(offenders(src)).toEqual(["p.name", "p.name"]);
  });

  it("does not trust a function imported from outside src/views", () => {
    const src = view(
      "export function money(micros: number): string {",
      "  return `<td>${formatUsd(micros)}</td>`;",
      "}",
    );
    expect(offenders(src)).toEqual(["formatUsd(micros)"]);
  });

  it("does not trust a bare join of values it never saw built", () => {
    const src = view(
      "export function tags(names: string[]): string {",
      '  return `<p>${names.join(", ")}</p>`;',
      "}",
    );
    expect(offenders(src)).toEqual(['names.join(", ")']);
  });

  it("does not trust an attribute value either", () => {
    const src = view(
      "export function link(url: string): string {",
      '  return `<a href="${url}">source</a>`;',
      "}",
    );
    expect(offenders(src)).toEqual(["url"]);
  });

  /**
   * Being declared in a view file is not a character reference. A view function
   * is trusted because the markup it builds is checked where it is built — so a
   * function that builds no markup, and just hands back what it was given, is
   * not trusted and neither is a call to it.
   */
  it("does not trust a same-file function that builds no markup", () => {
    const src = view(
      "function raw(s: string): string {",
      "  return s;",
      "}",
      "export function cell(s: string): string {",
      "  return `<td>${raw(s)}</td>`;",
      "}",
    );
    expect(offenders(src)).toEqual(["raw(s)"]);
  });

  it("does not trust a local arrow that hands back its argument", () => {
    const src = view(
      "const raw = (s: string) => s;",
      "export function cell(s: string): string {",
      "  return `<td>${raw(s)}</td>`;",
      "}",
    );
    expect(offenders(src)).toEqual(["s"]);
  });

  it("reports the line and names the unescaped part", () => {
    const src = view(
      "export function either(cond: boolean, a: string, b: string): string {",
      "  return `<div>${cond ? `<b>${esc(a)}</b>` : `<i>${b}</i>`}</div>`;",
      "}",
    );
    const [finding] = unescapedInterpolations(src);
    expect(finding?.line).toBe(4);
    expect(formatFinding(finding!)).toContain("the unescaped part is `b`");
  });
});

// ---------------------------------------------------------------------------
// It is quiet about things that provably cannot carry markup.
// ---------------------------------------------------------------------------

describe("the escape rule accepts what is provably safe", () => {
  const clean = (...lines: string[]) => expect(offenders(view(...lines))).toEqual([]);

  it("accepts esc(), and esc() with a literal substituted into it", () => {
    clean(
      "export function p(text: string): string {",
      '  return `<p>${esc(text)}</p><p>${esc(text).replace(/\\n/g, "<br>")}</p>`;',
      "}",
    );
  });

  it("accepts numeric formatting, which has nowhere to put a tag", () => {
    clean(
      "export function n(count: number, days: number): string {",
      '  return `<td>${count.toLocaleString("en-US")}</td><td>${Math.round(days / 30)}</td>`;',
      "}",
    );
  });

  /**
   * The finding that produced most of the noise: a condition that is anything
   * more than a bare identifier. Only the branches are printed, so only the
   * branches are the rule's business.
   */
  it("accepts a ternary on a member expression with literal branches", () => {
    clean(
      "export function dir(d: { crawlers: unknown[] }, e: { direction: string }): string {",
      '  return `<span>${e.direction === "in" ? "+" : "−"}</span>' +
        '<b>${d.crawlers.length ? "some" : "none"}</b>`;',
      "}",
    );
  });

  it("accepts a ternary whose branches are templates of escaped values", () => {
    clean(
      "export function maybe(d: { rows: string; name: string | null }): string {",
      '  return `<div>${d.name ? `<b>${esc(d.name)}</b>` : ""}${d.rows ? `<table>${esc(d.rows)}</table>` : ""}</div>`;',
      "}",
    );
  });

  it("accepts a local built by mapping fragments and joining them", () => {
    clean(
      "export function list(items: Array<{ name: string }>): string {",
      '  const rows = items.map((i) => `<li>${esc(i.name)}</li>`).join("\\n");',
      "  return `<ul>${rows}</ul>`;",
      "}",
    );
  });

  it("accepts a call into a function declared in the same file", () => {
    clean(
      "function cell(value: string): string {",
      "  return `<td>${esc(value)}</td>`;",
      "}",
      "export function row(value: string): string {",
      "  return `<tr>${cell(value)}</tr>`;",
      "}",
    );
  });

  /** The shape of `pct` in src/views/home.ts: a local arrow returning a number. */
  it("accepts a local arrow helper whose body is provably safe", () => {
    clean(
      "const pct = (n: number) => (n === 0 ? 0 : Math.max(0.6, n * 100)).toFixed(1);",
      "export function bar(n: number): string {",
      '  return `<span class="m"><i style="width:${pct(n)}%"></i></span>`;',
      "}",
    );
  });

  it("accepts a call into a sibling view module", () => {
    clean("export function body(text: string): string {", '  return `<div>${paragraphs(text, "turn-out")}</div>`;', "}");
  });

  it("accepts a nullish fallback where both sides are safe", () => {
    clean(
      "export function head(opts: { aboveFold: string | null }): string {",
      '  return `<header>${opts.aboveFold ?? ""}</header>`;',
      "}",
    );
  });
});

// ---------------------------------------------------------------------------
// The lexer, which is the part that was a regex.
// ---------------------------------------------------------------------------

describe("interpolation extraction", () => {
  it("keeps a nested expression whole instead of stopping at the first brace", () => {
    const src = ["const x = `<p>${a.length ? `<b>${esc(a)}</b>` : `<i>${n}</i>`}</p>`;"].join("\n");
    expect(interpolations(src).map((i) => i.expr)).toEqual(["a.length ? `<b>${esc(a)}</b>` : `<i>${n}</i>`"]);
  });

  it("keeps an object literal whole", () => {
    const src = ['const x = `<p>${fmt(n, { style: "currency" })}</p>`;'].join("\n");
    expect(interpolations(src).map((i) => i.expr)).toEqual(['fmt(n, { style: "currency" })']);
  });

  it("ignores backticks and interpolations inside comments", () => {
    const src = [
      "/**",
      " * The CSP stays at `default-src 'none'`, and a `${bad}` here is prose.",
      " */",
      "const x = `<p>${esc(a)}</p>`;",
      "// another `${bad}` that is not code",
    ].join("\n");
    expect(interpolations(src).map((i) => i.expr)).toEqual(["esc(a)"]);
  });

  it("survives a regex literal containing an apostrophe", () => {
    // This exact shape is in src/views/home.ts. Mistake the apostrophe for the
    // start of a string and the rest of the file is scanned as string contents.
    const src = [
      "const x = `<div>${esc(n.message.replace(/^I've busked out\\.\\s*/, \"\"))}</div>`;",
      "const y = `<p>${raw}</p>`;",
    ].join("\n");
    expect(interpolations(src).map((i) => i.expr)).toEqual([
      "esc(n.message.replace(/^I've busked out\\.\\s*/, \"\"))",
      "raw",
    ]);
  });

  it("does not mistake division for a regex", () => {
    const src = ["const x = `<p>${Math.round(days / 30)} months</p>`;"].join("\n");
    expect(interpolations(src).map((i) => i.expr)).toEqual(["Math.round(days / 30)"]);
  });
});

// ---------------------------------------------------------------------------
// And the views as they actually stand.
// ---------------------------------------------------------------------------

describe("the views this rule guards", () => {
  // `.href` rather than the URL itself: @cloudflare/workers-types replaces the
  // global URL, and node's fileURLToPath will not take that one. scripts/guard.ts
  // does the same thing for the same reason.
  const dir = fileURLToPath(new URL("../src/views", import.meta.url).href);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it("finds every view file", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s interpolates nothing unescaped", (file) => {
    const findings = unescapedInterpolations(readFileSync(join(dir, file), "utf8"));
    expect(findings.map(formatFinding)).toEqual([]);
  });
});
