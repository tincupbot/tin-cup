/**
 * Guard rule 4, lifted out of scripts/guard.ts so that a test can point at it.
 *
 * The rule: every `${...}` that reaches the page from src/views/*.ts is either
 * escaped, or is one of a small number of things that provably cannot carry
 * markup. This is the only injection surface the project has, and model output
 * goes through it, so the rule is not allowed to be approximately right.
 *
 * It was approximately right, in two ways that both hid work rather than doing
 * it. The extractor was `/\$\{([^}]*)/g`, which stops at the first `}`: every
 * nested template and every object literal came out truncated mid-expression,
 * and the part that got cut off was never checked at all. And the exemption for
 * ternaries was `/^\s*\w+\s*\?\s*`/`, a bare identifier and nothing else, so an
 * ordinary `d.crawlers.length ? ... : ...` was reported as a finding. Between
 * them that produced 74 findings, every one of them noise, which is the state a
 * rule has to be in before someone deletes it.
 *
 * So: a lexer instead of a regex, and safety decided by walking the expression
 * rather than by matching its first few characters.
 */

export type Unescaped = {
  /** 1-based line of the `${` that opens the interpolation. */
  line: number;
  /** The whole interpolated expression, as written. */
  expr: string;
  /** The part of it this rule could not prove safe. Often the whole thing. */
  offending: string;
};

// ---------------------------------------------------------------------------
// The lexer.
// ---------------------------------------------------------------------------

/**
 * True when the `/` at `i` opens a regex literal rather than dividing.
 *
 * Needed because src/views/home.ts strips a prefix with a regex literal
 * containing an apostrophe ("I've"), which would otherwise open a string
 * literal that never closes and take the rest of the file with it.
 */
function startsRegex(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j]!)) j--;
  if (j < 0) return true;
  const c = text[j]!;
  // A regex can only follow an operator or a keyword, never a value. (Written
  // with a string rather than a character class because `)` inside one is
  // exactly the sort of thing that trips a parser, including Node's.)
  const ENDS_A_VALUE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_$)]";
  if (!ENDS_A_VALUE.includes(c)) return true;
  // `return /x/`, `typeof /x/` — a keyword before the slash means regex.
  const word = /[\w$]+$/.exec(text.slice(0, j + 1))?.[0] ?? "";
  return ["return", "typeof", "case", "in", "of", "new", "delete", "void", "instanceof", "yield", "await"].includes(
    word,
  );
}

function skipQuoted(text: string, i: number, quote: string): number {
  let j = i + 1;
  while (j < text.length) {
    const c = text[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    if (c === "\n") return j; // Unterminated. Stop rather than swallow the file.
    j++;
  }
  return text.length;
}

function skipRegex(text: string, i: number): number {
  let j = i + 1;
  let inClass = false;
  while (j < text.length) {
    const c = text[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "\n") return j;
    else if (c === "/" && !inClass) {
      j++;
      while (j < text.length && /[a-z]/.test(text[j]!)) j++;
      return j;
    }
    j++;
  }
  return text.length;
}

/**
 * For every character: is it code — not inside a string, a regex, a comment or
 * the literal text of a template — at bracket depth zero?
 *
 * Every splitter below is a scan over this. Brackets, braces and template
 * literals all count as depth, so a `?` inside `f(a ? b : c)` is not top level
 * and a `:` inside `{ a: 1 }` is not either.
 */
function topLevel(text: string): boolean[] {
  const out = new Array<boolean>(text.length).fill(false);
  const stack: string[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (stack[stack.length - 1] === "`") {
      // Inside the text of a template literal. Nothing here is code.
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        stack.pop();
        out[i] = stack.length === 0;
        i++;
        continue;
      }
      if (ch === "$" && text[i + 1] === "{") {
        stack.push("{");
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "/" && startsRegex(text, i)) {
      i = skipRegex(text, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(text, i, ch);
      continue;
    }
    if (ch === "`") {
      out[i] = stack.length === 0;
      stack.push("`");
      i++;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      out[i] = stack.length === 0;
      stack.push(ch);
      i++;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      stack.pop();
      out[i] = stack.length === 0;
      i++;
      continue;
    }
    out[i] = stack.length === 0;
    i++;
  }
  return out;
}

type Interpolation = { expr: string; index: number };

/**
 * Every outermost `${...}` inside a template literal in `text`, with its
 * expression intact however deeply the braces nest.
 *
 * Outermost only: an interpolation inside another interpolation's template is
 * reached by recursion in `unsafePart`, because whether it needs checking at all
 * depends on what the expression around it does with it.
 */
export function interpolations(text: string): Interpolation[] {
  const out: Interpolation[] = [];
  const stack: string[] = [];
  const starts: number[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (stack[stack.length - 1] === "`") {
      if (ch === "\\") {
        i += 2;
        continue;
      }
      if (ch === "`") {
        stack.pop();
        i++;
        continue;
      }
      if (ch === "$" && text[i + 1] === "{") {
        stack.push("${");
        starts.push(i + 2);
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const nl = text.indexOf("\n", i);
      i = nl === -1 ? text.length : nl;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === "/" && startsRegex(text, i)) {
      i = skipRegex(text, i);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = skipQuoted(text, i, ch);
      continue;
    }
    if (ch === "`") {
      stack.push("`");
      i++;
      continue;
    }
    if (ch === "{") {
      stack.push("{");
      i++;
      continue;
    }
    if (ch === "}") {
      const closed = stack.pop();
      i++;
      if (closed === "${") {
        const start = starts.pop()!;
        if (!stack.includes("${")) out.push({ expr: text.slice(start, i - 1), index: start });
      }
      continue;
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Expression shapes.
// ---------------------------------------------------------------------------

function stripParens(text: string): string {
  let e = text.trim();
  while (e.startsWith("(")) {
    const top = topLevel(e);
    let close = -1;
    for (let i = 1; i < e.length; i++) {
      if (top[i] && e[i] === ")") {
        close = i;
        break;
      }
    }
    if (close !== e.length - 1) break;
    e = e.slice(1, -1).trim();
  }
  return e;
}

/** `"a"` / `'a'` and nothing else. */
function isStringLiteral(e: string): boolean {
  const q = e[0];
  if (q !== '"' && q !== "'") return false;
  return skipQuoted(e, 0, q) === e.length;
}

/** A single template literal spanning the whole expression. */
function isTemplateLiteral(e: string): boolean {
  if (e[0] !== "`" || e.length < 2) return false;
  const top = topLevel(e);
  for (let i = 1; i < e.length; i++) {
    if (top[i] && e[i] === "`") return i === e.length - 1;
  }
  return false;
}

/** `name(...)` spanning the whole expression — returns `name`. */
function wholeCall(e: string): string | null {
  const m = /^([A-Za-z_$][\w$]*)\s*\(/.exec(e);
  if (!m) return null;
  const open = e.indexOf("(", m[1]!.length);
  const top = topLevel(e);
  for (let i = open + 1; i < e.length; i++) {
    if (top[i] && e[i] === ")") return i === e.length - 1 ? m[1]! : null;
  }
  return null;
}

/** The top-level `?` of a conditional, or -1. Skips `?.` and `??`. */
function ternaryQuestion(e: string, top: boolean[]): number {
  for (let i = 0; i < e.length; i++) {
    if (!top[i] || e[i] !== "?") continue;
    if (e[i + 1] === "?" || e[i + 1] === "." || e[i - 1] === "?") continue;
    return i;
  }
  return -1;
}

function splitTernary(e: string): { whenTrue: string; whenFalse: string } | null {
  const top = topLevel(e);
  const q = ternaryQuestion(e, top);
  if (q === -1) return null;
  let nested = 0;
  for (let i = q + 1; i < e.length; i++) {
    if (!top[i]) continue;
    if (e[i] === "?" && e[i + 1] !== "?" && e[i + 1] !== "." && e[i - 1] !== "?") nested++;
    else if (e[i] === ":") {
      if (nested === 0) return { whenTrue: e.slice(q + 1, i), whenFalse: e.slice(i + 1) };
      nested--;
    }
  }
  return null;
}

/** Operands of a top-level `??` or `||` — either one can reach the page. */
function splitAlternatives(e: string): string[] | null {
  const top = topLevel(e);
  const parts: string[] = [];
  let last = 0;
  for (let i = 0; i < e.length - 1; i++) {
    if (!top[i]) continue;
    const pair = e.slice(i, i + 2);
    if (pair === "??" || pair === "||") {
      parts.push(e.slice(last, i));
      last = i + 2;
      i++;
    }
  }
  if (!parts.length) return null;
  parts.push(e.slice(last));
  return parts;
}

/**
 * `X.replace(A, B)` / `X.replaceAll(A, B)` spanning the whole expression —
 * returns the receiver `X` and the replacement `B`.
 *
 * `A` is not returned because a pattern cannot end up in the output; only the
 * thing being searched and the thing being substituted in can.
 */
function splitReplace(e: string): { receiver: string; inserted: string } | null {
  if (!e.endsWith(")")) return null;
  const top = topLevel(e);
  if (!top[e.length - 1]) return null;

  // Walk back from the closing paren to the `(` it matches.
  let open = -1;
  let unclosed = 0;
  for (let i = e.length - 2; i >= 0; i--) {
    if (!top[i]) continue;
    if (e[i] === ")") unclosed++;
    else if (e[i] === "(") {
      if (unclosed === 0) {
        open = i;
        break;
      }
      unclosed--;
    }
  }
  if (open === -1) return null;

  const head = e.slice(0, open);
  const m = /\.(?:replace|replaceAll)\s*$/.exec(head);
  if (!m) return null;

  const args = e.slice(open + 1, e.length - 1);
  const argTop = topLevel(args);
  let comma = -1;
  for (let i = args.length - 1; i >= 0; i--) {
    if (argTop[i] && args[i] === ",") {
      comma = i;
      break;
    }
  }
  if (comma === -1) return null;

  return { receiver: head.slice(0, m.index), inserted: args.slice(comma + 1) };
}

/**
 * Arithmetic and formatting that cannot produce a `<`.
 *
 * `Math.round(x)` and `Number(x)` are numbers. `x.toLocaleString(...)` and
 * `x.toFixed(n)` are the string form of a number: digits, a sign, and the
 * locale's separators. None of them has anywhere to put markup, which is why
 * the codebase interpolates them directly and why doing so is not a finding.
 */
const NUMERIC_TAIL = /\.(?:toLocaleString|toFixed)\s*\([^()]*\)$/;
const NUMERIC_HEAD = /^(?:Math\.(?:round|floor|ceil|abs|max|min|trunc)|Number)\s*\(/;

function isNumeric(e: string): boolean {
  if (/^-?\d[\d_]*(?:\.\d+)?$/.test(e)) return true;
  if (NUMERIC_TAIL.test(e)) return true;
  if (NUMERIC_HEAD.test(e)) {
    const top = topLevel(e);
    const open = e.indexOf("(");
    for (let i = open + 1; i < e.length; i++) {
      if (top[i] && e[i] === ")") return i === e.length - 1;
    }
  }
  return false;
}

/**
 * `xs.map((x) => `<li>…</li>`).join("\n")`.
 *
 * Safe because the fragments being joined are template literals in this same
 * file, and this rule already checked their interpolations where they were
 * written. The `.map(` and the backtick are both required: `xs.join(", ")` on
 * plain values is not this, and is still a finding.
 */
function isMapJoin(e: string): boolean {
  if (!/\.map\s*\(/.test(e) || !e.includes("`")) return false;
  return /\.join\s*\(\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$]*`)\s*\)$/.test(e);
}

// ---------------------------------------------------------------------------
// What a view file says about itself.
// ---------------------------------------------------------------------------

/**
 * The raw-markup slots. Each one holds a fragment that some other view function
 * built, and this rule checked it where it was built.
 */
const SAFE_SLOT = /^(?:opts\.body|opts\.aboveFold|STYLES)$/;

type ViewContext = {
  /**
   * Functions whose output may be interpolated raw.
   *
   * `esc` and `paragraphs` because they are the escaping primitives themselves.
   * Anything imported from a sibling module in src/views, because this rule
   * reads that file too. And functions declared here whose body actually builds
   * markup — a template literal, which this rule then checks line by line.
   *
   * That last condition is the one doing work. A view function that returned
   * what it was handed (`function raw(s) { return s; }`) builds no template, so
   * nothing about it has ever been checked, so it is not in here and
   * `${raw(userInput)}` is still a finding. A function from outside src/views —
   * `formatUsdPrecise` from ../money.ts, say — is not in here either.
   */
  trusted: Set<string>;
  /** Every `const`/`let` in the file, by name, with each initializer. */
  locals: Map<string, string[]>;
};

/**
 * Functions declared in this file with a `function` keyword, keeping only the
 * ones whose body contains a template literal.
 */
function declaredFunctions(source: string): string[] {
  const top = topLevel(source);
  const names: string[] = [];
  for (const m of source.matchAll(/^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) {
    let open = -1;
    for (let i = m.index; i < source.length; i++) {
      if (top[i] && source[i] === "{") {
        open = i;
        break;
      }
    }
    if (open === -1) continue;
    // `top` marks only depth-zero characters, so the next one of these is the
    // brace that closes this body and not a brace from inside it.
    for (let i = open + 1; i < source.length; i++) {
      if (top[i] && source[i] === "}") {
        if (source.slice(open, i).includes("`")) names.push(m[1]!);
        break;
      }
    }
  }
  return names;
}

/** Named imports from a sibling module — i.e. from elsewhere in src/views. */
function siblingImports(source: string): string[] {
  const names: string[] = [];
  for (const m of source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["'](\.\/[^"']+)["']/g)) {
    if (/^import\s+type\s/.test(m[0])) continue;
    for (const raw of m[1]!.split(",")) {
      const part = raw.trim();
      if (!part || part.startsWith("type ")) continue;
      names.push((part.split(/\s+as\s+/).pop() ?? part).trim());
    }
  }
  return names;
}

/**
 * Every `const x = …` / `let x = …`, with the initializer text.
 *
 * A local is how most of this file's markup is actually built: a row is mapped
 * and joined on one line and interpolated on another, and the line that builds
 * it is the line this rule checks. So when an interpolation is a bare name,
 * look up what was assigned to it and check that instead. If a name is declared
 * more than once, every initializer has to be safe.
 */
function locals(source: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of source.matchAll(/(?:^|[\s;{(])(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*/g)) {
    const name = m[1]!;
    const start = m.index + m[0].length;
    const rest = source.slice(start);
    const top = topLevel(rest);
    let end = rest.length;
    for (let i = 0; i < rest.length; i++) {
      if (top[i] && (rest[i] === ";" || rest[i] === ",")) {
        end = i;
        break;
      }
    }
    const list = out.get(name) ?? [];
    list.push(rest.slice(0, end));
    out.set(name, list);
  }
  return out;
}

/**
 * The body of `const f = (args) => body`, or null if the initializer is not an
 * expression-bodied arrow function.
 *
 * The small helpers a view builds rows with — `coin`, `row`, `pct` — are all of
 * this shape, and checking the body is how a call to one of them is judged.
 * A block-bodied arrow returns null and its caller stays a finding.
 */
function arrowBody(initializer: string): string | null {
  const top = topLevel(initializer);
  for (let i = 0; i < initializer.length - 1; i++) {
    if (top[i] && initializer[i] === "=" && initializer[i + 1] === ">") {
      const body = initializer.slice(i + 2).trim();
      return body.startsWith("{") ? null : body;
    }
  }
  return null;
}

function context(source: string): ViewContext {
  return {
    // `esc` and `paragraphs` are named rather than derived: they are what
    // escaping *is* here, and neither of them builds a template literal.
    trusted: new Set(["esc", "paragraphs", ...declaredFunctions(source), ...siblingImports(source)]),
    locals: locals(source),
  };
}

// ---------------------------------------------------------------------------
// The check.
// ---------------------------------------------------------------------------

/**
 * The part of `expr` that could reach the page as markup, or null if none can.
 *
 * Only the parts that are *emitted* are checked: the condition of a ternary is
 * never printed, so `d.crawlers.length ? table : empty` is judged on `table` and
 * `empty` and not on `d.crawlers.length`. That one omission is most of the 74
 * findings this rule used to produce.
 */
function unsafePart(expr: string, ctx: ViewContext, depth: number, seen: Set<string>): string | null {
  const e = stripParens(expr);
  if (e === "") return null;
  if (depth > 12) return e;

  if (/^(?:true|false|null|undefined)$/.test(e)) return null;
  if (isStringLiteral(e)) return null;
  if (isNumeric(e)) return null;
  if (SAFE_SLOT.test(e)) return null;

  if (isTemplateLiteral(e)) {
    for (const inner of interpolations(e)) {
      const bad = unsafePart(inner.expr, ctx, depth + 1, seen);
      if (bad) return bad;
    }
    return null;
  }

  const ternary = splitTernary(e);
  if (ternary) {
    return (
      unsafePart(ternary.whenTrue, ctx, depth + 1, seen) ?? unsafePart(ternary.whenFalse, ctx, depth + 1, seen)
    );
  }

  const alternatives = splitAlternatives(e);
  if (alternatives) {
    for (const part of alternatives) {
      const bad = unsafePart(part, ctx, depth + 1, seen);
      if (bad) return bad;
    }
    return null;
  }

  const callee = wholeCall(e);
  if (callee && ctx.trusted.has(callee)) return null;
  // A call to a local arrow helper is judged on what that arrow returns.
  if (callee && !seen.has(callee)) {
    const bodies = (ctx.locals.get(callee) ?? []).map(arrowBody);
    if (bodies.length && bodies.every((b) => b !== null)) {
      const next = new Set(seen).add(callee);
      for (const body of bodies) {
        const bad = unsafePart(body!, ctx, depth + 1, next);
        if (bad) return bad;
      }
      return null;
    }
  }

  // `esc(p).replace(/\n/g, "<br>")` — substituting a literal into escaped text.
  const replace = splitReplace(e);
  if (replace) {
    return (
      unsafePart(replace.receiver, ctx, depth + 1, seen) ?? unsafePart(replace.inserted, ctx, depth + 1, seen)
    );
  }

  if (isMapJoin(e)) return null;

  if (/^[A-Za-z_$][\w$]*$/.test(e) && !seen.has(e)) {
    const inits = ctx.locals.get(e);
    if (inits?.length) {
      const next = new Set(seen).add(e);
      for (const init of inits) {
        const bad = unsafePart(init, ctx, depth + 1, next);
        if (bad) return bad;
      }
      return null;
    }
  }

  return e;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source[i] === "\n") line++;
  return line;
}

/**
 * Every interpolation in one view file that this rule cannot prove is escaped.
 */
export function unescapedInterpolations(source: string): Unescaped[] {
  const ctx = context(source);
  const out: Unescaped[] = [];
  for (const { expr, index } of interpolations(source)) {
    const offending = unsafePart(expr, ctx, 0, new Set());
    if (offending === null) continue;
    out.push({ line: lineOf(source, index), expr: expr.trim(), offending: offending.trim() });
  }
  return out;
}

/** One finding, as a line of guard output. */
export function formatFinding(u: Unescaped): string {
  const short = (s: string) => (s.length > 70 ? `${s.slice(0, 67)}...` : s);
  const where = u.offending === u.expr ? "" : ` — the unescaped part is \`${short(u.offending)}\``;
  return `line ${u.line}: \${${short(u.expr)}} reaches the page unescaped${where}`;
}
