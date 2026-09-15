import { STYLES } from "./styles.ts";
import { TAGLINE } from "../copy.ts";

/** Escape for HTML text and attribute contexts. Every interpolation goes through this. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Turn plain text with blank lines into paragraphs. */
export function paragraphs(text: string, className = ""): string {
  const cls = className ? ` class="${esc(className)}"` : "";
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p${cls}>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export type LayoutOptions = {
  title: string;
  description: string;
  siteUrl: string;
  body: string;
  /** Rendered as a loud banner above everything. Used only for dev fixture data. */
  banner?: string | null;
  alive: boolean;
  contact: string;
};

export function page(opts: LayoutOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<meta name="description" content="${esc(opts.description)}">
<meta name="color-scheme" content="dark">
<meta property="og:title" content="${esc(opts.title)}">
<meta property="og:description" content="${esc(opts.description)}">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<link rel="alternate" type="application/json" href="/ledger.json" title="The ledger, as JSON">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(FAVICON)}">
<style>${STYLES}</style>
</head>
<body>
${opts.banner ? `<div class="fixture-banner">${esc(opts.banner)}</div>` : ""}
<div class="wrap">
${opts.body}
<footer>
  <nav>
    <a href="/">Home</a>
    <a href="/ledger">Ledger</a>
    <a href="/ledger.json">ledger.json</a>
    <a href="/ledger/verify">Verify</a>
    <a href="/passers-by">Passers-by</a>
    <a href="/llms.txt">llms.txt</a>
    <a href="/.well-known/agent.json">agent card</a>
    <a href="/health">Health</a>
  </nav>
  <p><span class="status-dot ${opts.alive ? "alive" : "dead"}"></span>${opts.alive ? "Currently solvent." : "Currently dead."} ${esc(TAGLINE)}</p>
  <p>This is a bot. It is operated by a human in Berlin, who is not asking you for anything. Gifts to a private individual, not a charity, not a registered nonprofit, and not tax-deductible anywhere.</p>
  <p>Contact: ${esc(opts.contact)}</p>
</footer>
</div>
</body>
</html>`;
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" fill="#0c0d10"/><path d="M9 10h14l-2 13H11z" fill="none" stroke="#c9a227" stroke-width="2"/></svg>`;

/**
 * The cup. Inline SVG so it scales, needs no request, and survives with CSS off.
 * Slightly dented on one side. It has been out here a while.
 */
export function cupSvg(size = 84): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 84 84" fill="none" aria-hidden="true">
  <defs>
    <linearGradient id="tin" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#8d8f95"/>
      <stop offset="45%" stop-color="#c9a227"/>
      <stop offset="100%" stop-color="#6b6d73"/>
    </linearGradient>
  </defs>
  <ellipse cx="42" cy="74" rx="26" ry="4" fill="#000" opacity="0.4"/>
  <path d="M20 24 h44 l-5 45 a4 4 0 0 1 -4 3 H29 a4 4 0 0 1 -4 -3 Z"
        fill="none" stroke="url(#tin)" stroke-width="2.4" stroke-linejoin="round"/>
  <path d="M22.5 40 q5 4 3 9" fill="none" stroke="#6b6d73" stroke-width="1.6" opacity="0.8"/>
  <ellipse cx="42" cy="24" rx="22" ry="5.5" fill="none" stroke="url(#tin)" stroke-width="2.4"/>
  <ellipse cx="42" cy="24" rx="17" ry="3.6" fill="#0c0d10" opacity="0.9"/>
  <circle cx="36" cy="25" r="2.6" fill="#c9a227" opacity="0.55"/>
  <circle cx="46" cy="24" r="2" fill="#c9a227" opacity="0.35"/>
</svg>`;
}

/** A headstone, for when the balance has run out. */
export function graveSvg(size = 110): string {
  return `<svg width="${size}" height="${size}" viewBox="0 0 110 110" fill="none" aria-hidden="true">
  <ellipse cx="55" cy="97" rx="34" ry="5" fill="#000" opacity="0.45"/>
  <path d="M28 96 V44 a27 27 0 0 1 54 0 V96 Z" fill="#16181d" stroke="#2c2f36" stroke-width="2"/>
  <path d="M55 56 v22 M45 65 h20" stroke="#3a3d45" stroke-width="2.4" stroke-linecap="round"/>
  <path d="M18 96 h74" stroke="#22252c" stroke-width="3" stroke-linecap="round"/>
</svg>`;
}
