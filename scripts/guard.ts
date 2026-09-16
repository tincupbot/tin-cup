/**
 * The rules a general-purpose linter cannot know about.
 *
 * ESLint checks that the TypeScript is sane. This checks that the *project* is
 * still the project: that nothing deploys, nothing posts, no key is committed,
 * the site still ships zero JavaScript, and the ledger still has exactly one
 * write path. Every rule here exists because breaking it would be quiet.
 *
 * Run: npm run guard   (and as part of npm run lint, and in CI)
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url).href), "..");

type Finding = { file: string; rule: string; detail: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git" || name === ".wrangler") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(ROOT);
const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => relative(ROOT, f);
const findings: Finding[] = [];
const fail = (file: string, rule: string, detail: string) => findings.push({ file: rel(file), rule, detail });

const srcTs = files.filter((f) => f.includes(`${ROOT}/src/`) && f.endsWith(".ts"));
const viewTs = srcTs.filter((f) => f.includes("/views/"));

// --- 1. Nothing deploys, nothing posts. ------------------------------------
//
// The two hard constraints on this repo. A deploy needs a Cloudflare account
// and Ben's approval; a post needs an X account that does not exist.
{
  const pkg = JSON.parse(read(join(ROOT, "package.json"))) as { scripts?: Record<string, string> };
  for (const [name, script] of Object.entries(pkg.scripts ?? {})) {
    if (/wrangler\s+(deploy|publish)/.test(script)) {
      fail(join(ROOT, "package.json"), "no-deploy", `script "${name}" runs a deploy`);
    }
  }
  for (const f of srcTs) {
    const body = read(f);
    if (/api\.twitter\.com|api\.x\.com|\bpostTweet\b|nodemailer|sendgrid/i.test(body)) {
      fail(f, "no-posting", "reaches an outbound posting or mail API");
    }
  }
}

// --- 2. No credentials on disk. --------------------------------------------
{
  const SECRET_SHAPES: Array<[RegExp, string]> = [
    [/sk-ant-[A-Za-z0-9_-]{10,}/, "an Anthropic key"],
    [/\bsk-[A-Za-z0-9]{32,}/, "an OpenAI key"],
    [/\bghp_[A-Za-z0-9]{20,}/, "a GitHub token"],
    [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  ];
  const committed = files.filter(
    (f) => !f.includes("/.git/") && !f.endsWith("guard.ts") && !f.includes("package-lock.json"),
  );
  for (const f of committed) {
    let body: string;
    try {
      body = read(f);
    } catch {
      continue; // binary, or unreadable. Nothing to check.
    }
    for (const [shape, what] of SECRET_SHAPES) {
      if (shape.test(body)) fail(f, "no-secrets", `looks like ${what}`);
    }
  }
  const gitignore = read(join(ROOT, ".gitignore"));
  if (!gitignore.includes(".dev.vars")) {
    fail(join(ROOT, ".gitignore"), "no-secrets", ".dev.vars is not ignored");
  }
}

// --- 3. The site ships no client-side JavaScript. --------------------------
//
// This is what makes `default-src 'none'` affordable. One script tag and the
// CSP has to be loosened, and then it is loosened forever.
{
  for (const f of viewTs) {
    const body = read(f);
    if (/<script\b/i.test(body)) fail(f, "no-client-js", "renders a <script> tag");
    if (/\son[a-z]+\s*=\s*["'`]/i.test(body)) fail(f, "no-client-js", "renders an inline event handler");
    if (/javascript:/i.test(body)) fail(f, "no-client-js", "renders a javascript: URL");
  }
  const csp = read(join(ROOT, "src/index.ts"));
  if (!csp.includes("default-src 'none'")) {
    fail(join(ROOT, "src/index.ts"), "no-client-js", "the CSP no longer starts from default-src 'none'");
  }
}

// --- 4. Interpolation in a view goes through esc(). -------------------------
//
// The one injection surface this project has, and model output goes through it.
{
  const SAFE = /^\s*(esc\(|paragraphs\(|cupSvg\(|graveSvg\(|opts\.body|opts\.banner|opts\.aboveFold|STYLES|FAVICON|CSP)/;
  // Interpolations that are structural rather than content: numbers we computed,
  // class names we chose, and calls whose own bodies are checked by this rule.
  const STRUCTURAL = /^\s*[\w.]*(pct|rows|urls|items|tiers|body|block|html|Block|Line|svg|Svg|SPAN)[\w.]*[\s(]/;
  for (const f of viewTs) {
    const body = read(f);
    const lines = body.split("\n");
    lines.forEach((line, i) => {
      const matches = line.matchAll(/\$\{([^}]*)/g);
      for (const m of matches) {
        const expr = m[1] ?? "";
        if (SAFE.test(expr) || STRUCTURAL.test(expr)) continue;
        // Ternaries and template fragments whose branches are themselves checked
        // on their own lines.
        if (expr.includes("esc(") || expr.trim() === "" || /^\s*\w+\s*\?\s*`/.test(expr)) continue;
        if (/^\s*(true|false|\d|-|\.)/.test(expr)) continue;
        fail(f, "escape-everything", `line ${i + 1}: \${${expr.trim().slice(0, 60)}} is not wrapped in esc()`);
      }
    });
  }
}

// --- 5. One write path to the ledger. --------------------------------------
{
  for (const f of srcTs) {
    if (f.endsWith("src/ledger/ledger.ts")) continue;
    const body = read(f);
    if (/INSERT\s+INTO\s+ledger/i.test(body)) {
      fail(f, "one-write-path", "writes to the ledger directly instead of via append()");
    }
    if (/(UPDATE|DELETE)\s+(FROM\s+)?ledger\b/i.test(body)) {
      fail(f, "append-only", "tries to mutate the ledger");
    }
  }
}

// --- 6. Live LLM calls stay off in committed config. ------------------------
{
  const toml = read(join(ROOT, "wrangler.toml"));
  if (/LLM_LIVE_CALLS_ENABLED\s*=\s*"true"/.test(toml)) {
    fail(join(ROOT, "wrangler.toml"), "no-spend", "LLM_LIVE_CALLS_ENABLED is true in committed config");
  }
  if (!/LLM_PROVIDER\s*=\s*"mock"/.test(toml)) {
    fail(join(ROOT, "wrangler.toml"), "no-spend", "LLM_PROVIDER is not mock in committed config");
  }
  const zero = "0x0000000000000000000000000000000000000000";
  if (!toml.includes(zero)) {
    fail(join(ROOT, "wrangler.toml"), "no-wallet", "X402_PAY_TO is no longer the zero address");
  }
}

// --- Report -----------------------------------------------------------------

if (findings.length === 0) {
  console.log("guard: ok — 6 rules, no findings");
} else {
  for (const f of findings) console.error(`guard: ${f.file}: [${f.rule}] ${f.detail}`);
  console.error(`\nguard: ${findings.length} finding${findings.length === 1 ? "" : "s"}`);
  process.exitCode = 1;
}
