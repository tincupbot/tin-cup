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
import { formatFinding, unescapedInterpolations } from "./escape-rule.ts";

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
// The rule itself lives in scripts/escape-rule.ts, because it is the only rule
// here complicated enough to be worth a test of its own — see
// test/escape-rule.test.ts, which proves it still bites.
{
  for (const f of viewTs) {
    for (const finding of unescapedInterpolations(read(f))) {
      fail(f, "escape-everything", formatFinding(finding));
    }
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

// --- 6. Local dev spends nothing; production spends only what was approved. --
//
// This rule used to read wrangler.toml as one blob: no "true" anywhere, mock
// somewhere. That stopped working the moment a `[env.production]` block existed
// with live calls switched on, and the lazy fix — deleting the rule — would
// have removed the only thing standing between a typo and a local dev server
// billing a real card. So it is per-section now.
//
// The distinction it protects: `wrangler dev`, the tests and anything a
// contributor runs read [vars] and must stay free. Only the environment nobody
// enters by accident is allowed to cost money.
{
  const TOML = join(ROOT, "wrangler.toml");
  const toml = read(TOML);
  const zero = "0x0000000000000000000000000000000000000000";

  /** The body of one TOML table: everything up to the next `[` at line start. */
  const section = (header: string): string | null => {
    const lines = toml.split("\n");
    const start = lines.findIndex((l) => l.trim() === header);
    if (start === -1) return null;
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((l) => /^\s*\[/.test(l));
    return (end === -1 ? rest : rest.slice(0, end)).join("\n");
  };
  const has = (body: string, key: string, value: string) =>
    new RegExp(`^\\s*${key}\\s*=\\s*"${value}"`, "m").test(body);

  const local = section("[vars]");
  const prod = section("[env.production.vars]");

  if (local === null) fail(TOML, "no-spend", "the [vars] block is gone");
  else {
    if (has(local, "LLM_LIVE_CALLS_ENABLED", "true")) {
      fail(TOML, "no-spend", "LLM_LIVE_CALLS_ENABLED is true in [vars] — local dev would bill a real key");
    }
    if (!has(local, "LLM_PROVIDER", "mock")) {
      fail(TOML, "no-spend", "LLM_PROVIDER in [vars] is not mock");
    }
    if (!local.includes(zero)) {
      fail(TOML, "no-wallet", "X402_PAY_TO in [vars] is no longer the zero address");
    }
  }

  if (prod === null) fail(TOML, "prod-config", "there is no [env.production.vars] block");
  else {
    // No wallet exists, so production must not advertise a payable endpoint.
    // Together these two say: either there is a real address, or the endpoint
    // is off. What is forbidden is a live challenge naming 0x0, which asks
    // strangers' agents to burn money.
    const payToIsZero = !/^\s*X402_PAY_TO\s*=/m.test(prod) || prod.includes(zero);
    if (payToIsZero && !has(prod, "X402_ENABLED", "false")) {
      fail(TOML, "no-wallet", "production has x402 enabled while X402_PAY_TO is the zero address");
    }
    if (!payToIsZero) {
      fail(TOML, "no-wallet", "production sets a non-zero X402_PAY_TO — a real wallet is a Ben decision");
    }
    // The dry run acknowledges verified donations and writes nothing. It is a
    // deploy-time flag for proving the webhook wiring, and committing it would
    // mean real money arriving, returning 200, and vanishing.
    if (/^\s*KOFI_DRY_RUN\s*=\s*"true"/m.test(prod)) {
      fail(TOML, "prod-config", "KOFI_DRY_RUN is committed as true — donations would be acknowledged and dropped");
    }
    // A contact that bounces is worse than none: it looks like a way to reach
    // a human and is not.
    if (/example\.invalid/.test(prod)) {
      fail(TOML, "prod-config", "production OPERATOR_CONTACT is still a placeholder address");
    }
    if (!/^\s*SITE_URL\s*=/m.test(prod)) {
      fail(TOML, "prod-config", "production has no SITE_URL — the x402 resource and every agent-facing URL come from it");
    }
    // Non-inheritable keys: a var missing here is not inherited from [vars],
    // it is simply absent, and src/env.ts quietly substitutes a default. The
    // expensive ones are the spend caps.
    for (const key of ["DAILY_SPEND_CAP_MICROS", "MAX_CALL_COST_MICROS", "KOFI_HANDLE", "LLM_PROVIDER"]) {
      if (!new RegExp(`^\\s*${key}\\s*=`, "m").test(prod)) {
        fail(TOML, "prod-config", `production is missing ${key}; vars are not inherited from [vars]`);
      }
    }
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
