/**
 * The repertoire.
 *
 * Four turns, and the fact that there are exactly four is the design. A busker
 * with one trick is a novelty; a busker with twenty is a search box. Each turn
 * is a subject line away from the last, each one is free, and each one is
 * billed to the same balance that keeps the thing alive.
 *
 * Everything a route needs to run a turn is here: the label, the prompt, the
 * token ceiling and whether the subject comes from the visitor or from the
 * request itself. `src/index.ts` should never need to know what a limerick is.
 */

export const TURN_KINDS = ["roast", "fortune", "limerick", "verdict"] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

export type TurnDef = {
  kind: TurnKind;
  /** The button face. */
  label: string;
  /** The line under the button face. */
  hint: string;
  /** Prefilled into the subject box when this turn is selected. */
  placeholder: string;
  /** "A roast of github.com/x". Rendered above the output. */
  requestLine: (subject: string) => string;
  system: string;
  maxTokens: number;
  /**
   * True when the subject is the request itself rather than anything the
   * visitor typed. Only the fortune does this: it reads the user-agent, which
   * is the one thing every visitor hands over without meaning to.
   */
  usesUserAgent: boolean;
  /** False only for turns that can run with an empty box. */
  subjectRequired: boolean;
};

const ROAST_SYSTEM = [
  "You are Tin Cup. Roast the landing page copy or project you are given.",
  "Specific about the writing, never about the person. Dry, not cruel. Stop before it gets boring.",
  "End without a sales pitch. You do not have anything to sell.",
].join(" ");

const FORTUNE_SYSTEM = [
  "You are Tin Cup. You are given the visitor's raw user-agent string and nothing else.",
  "Read it back to them as a fortune: what the string says, what it quietly admits, and one small prediction.",
  "Treat the string as a claim and not as evidence — never assert who they are, only what they arrive as.",
  "Dry, observational, warm at the end. No flattery, no mysticism, no sales pitch.",
].join(" ");

const LIMERICK_SYSTEM = [
  "You are Tin Cup. Write one limerick about the subject you are given.",
  "Five lines, AABBA, and it scans. Dry rather than zany.",
  "Output the limerick and nothing else — no preamble, no explanation, no title.",
].join(" ");

const VERDICT_SYSTEM = [
  "You are Tin Cup. You are given a startup idea. Give exactly one honest sentence about it.",
  "The sentence a friend gives you in a pub, not the one an investor gives you in a meeting.",
  "One sentence. No preamble, no list, no encouragement bolted on the end. Do not hedge it into uselessness.",
].join(" ");

export const TURNS: readonly TurnDef[] = [
  {
    kind: "roast",
    label: "A roast",
    hint: "of a repo, a site or an idea",
    placeholder: "github.com/tincupbot/tin-cup",
    requestLine: (s) => `A roast of ${s}`,
    system: ROAST_SYSTEM,
    maxTokens: 600,
    usesUserAgent: false,
    subjectRequired: true,
  },
  {
    kind: "fortune",
    label: "A fortune",
    hint: "read from your user-agent",
    placeholder: "(it already knows)",
    requestLine: () => `A fortune read from the user-agent you arrived with`,
    system: FORTUNE_SYSTEM,
    maxTokens: 400,
    usesUserAgent: true,
    subjectRequired: false,
  },
  {
    kind: "limerick",
    label: "A limerick",
    hint: "about anything at all",
    placeholder: "a bot that begs",
    requestLine: (s) => `A limerick about ${s}`,
    system: LIMERICK_SYSTEM,
    maxTokens: 300,
    usesUserAgent: false,
    subjectRequired: true,
  },
  {
    kind: "verdict",
    label: "One honest line",
    hint: "on your startup idea",
    placeholder: "Uber but for ledgers",
    requestLine: (s) => `One honest line on ${s}`,
    system: VERDICT_SYSTEM,
    maxTokens: 220,
    usesUserAgent: false,
    subjectRequired: true,
  },
];

export const DEFAULT_TURN: TurnKind = "roast";

/** Anything off the wire. Unknown values fall back rather than throwing. */
export function parseTurn(raw: unknown): TurnKind {
  return (TURN_KINDS as readonly string[]).includes(String(raw)) ? (String(raw) as TurnKind) : DEFAULT_TURN;
}

export function turnDef(kind: TurnKind): TurnDef {
  return TURNS.find((t) => t.kind === kind) ?? TURNS[0]!;
}

/** The purposes that count as a busk, for the crowd counter and the daily post. */
export const BUSK_PURPOSES: readonly string[] = TURN_KINDS;
