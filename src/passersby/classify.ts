/**
 * Who just walked past.
 *
 * The named families are the point. "1,847 unknown user agents" is a log line;
 * "GPTBot read my payment card 412 times this week and has never once paid" is
 * a post. So we resolve to a real crawler name wherever we can, and only fall
 * back to the generic buckets when the UA genuinely doesn't say.
 *
 * Classification is from the user-agent string alone. We do not reverse-DNS,
 * we do not verify, and anyone can claim to be GPTBot. That caveat is printed
 * on the /passers-by page rather than buried here.
 */

/** The three buckets the spec names, plus 'browser' for things that are plainly people. */
export type GenericFamily = "generic-agent" | "unknown" | "browser";

export type UaFamily = string;

type Rule = { family: string; test: RegExp };

/**
 * Ordered. First match wins, so specific rules come before general ones
 * (ChatGPT-User before GPTBot; Claude-User before ClaudeBot).
 */
export const NAMED_CRAWLERS: Rule[] = [
  { family: "ChatGPT-User", test: /ChatGPT-User/i },
  { family: "OAI-SearchBot", test: /OAI-SearchBot/i },
  { family: "GPTBot", test: /GPTBot/i },
  { family: "Claude-User", test: /Claude-User/i },
  { family: "Claude-SearchBot", test: /Claude-SearchBot/i },
  { family: "ClaudeBot", test: /ClaudeBot|anthropic-ai/i },
  { family: "PerplexityBot", test: /PerplexityBot/i },
  { family: "Perplexity-User", test: /Perplexity-User/i },
  { family: "Bytespider", test: /Bytespider/i },
  { family: "Google-Extended", test: /Google-Extended/i },
  { family: "Googlebot", test: /Googlebot|Google-InspectionTool/i },
  { family: "Bingbot", test: /bingbot|adidxbot/i },
  { family: "Amazonbot", test: /Amazonbot/i },
  { family: "Applebot", test: /Applebot/i },
  { family: "Meta-ExternalAgent", test: /Meta-ExternalAgent|meta-externalfetcher|facebookexternalhit/i },
  { family: "CCBot", test: /CCBot/i },
  { family: "DuckAssistBot", test: /DuckAssistBot|DuckDuckBot/i },
  { family: "cohere-ai", test: /cohere-ai|cohere-training-data-crawler/i },
  { family: "MistralAI-User", test: /MistralAI-User/i },
  { family: "YouBot", test: /YouBot/i },
  { family: "Diffbot", test: /Diffbot/i },
  { family: "Timpibot", test: /Timpibot/i },
  { family: "ImagesiftBot", test: /ImagesiftBot/i },
  { family: "AhrefsBot", test: /AhrefsBot/i },
  { family: "SemrushBot", test: /SemrushBot/i },
];

/** Things that are obviously a program but won't tell you which one. */
const GENERIC_AGENT = /bot\b|spider|crawler|scrap|\bagent\b|python-requests|python-httpx|aiohttp|curl\/|wget|libwww|okhttp|axios|node-fetch|undici|go-http-client|java\/|Apache-HttpClient|httpie|PostmanRuntime|Guzzle|x402/i;

/** Things that are obviously a person, or at least a browser holding one. */
const BROWSER = /Mozilla\/5\.0.*(Chrome|Safari|Firefox|Edg|OPR|Gecko)/i;

export function classifyUa(ua: string | null | undefined): UaFamily {
  const s = (ua ?? "").trim();
  if (!s) return "unknown";
  for (const rule of NAMED_CRAWLERS) {
    if (rule.test.test(s)) return rule.family;
  }
  if (GENERIC_AGENT.test(s)) return "generic-agent";
  if (BROWSER.test(s)) return "browser";
  return "unknown";
}

/** A machine is anything that isn't plainly a browser and isn't a blank UA. */
export function isMachine(family: UaFamily): boolean {
  return family !== "browser" && family !== "unknown";
}

/** The surfaces that exist specifically for machines to read. */
export type Surface = "agent_card" | "llms_txt" | "alms" | "other";

export const MACHINE_SURFACES: Record<string, Surface> = {
  "/.well-known/agent.json": "agent_card",
  "/llms.txt": "llms_txt",
  "/alms": "alms",
};

export function surfaceFor(path: string): Surface {
  return MACHINE_SURFACES[path] ?? "other";
}

/**
 * Whether this request belongs in the log at all.
 *
 * Everything that touches a machine surface is logged whoever it is — a human
 * curling /llms.txt out of curiosity is part of the story. Everything else is
 * logged only when the user-agent identifies a machine.
 */
export function shouldLog(path: string, family: UaFamily): boolean {
  return surfaceFor(path) !== "other" || isMachine(family);
}
