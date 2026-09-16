/**
 * The canned roast generator used by MockProvider.
 *
 * This is not an LLM and does not pretend to be. It is a deterministic text
 * machine so that the entire product — including the bit that costs money —
 * is exercisable with zero API keys and zero spend. Same input, same roast,
 * every time, on every machine.
 *
 * It still has to be *good*, because the roast is the distribution engine and a
 * limp roast is a dead project. Quality here means: specific about the copy,
 * never about the person, dry rather than cruel, and it stops before it gets
 * boring.
 */

/** Cheap deterministic 32-bit hash. Not cryptographic; it picks jokes. */
export function seedFrom(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function picker(seed: number) {
  let s = seed || 1;
  return <T>(items: readonly T[]): T => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return items[s % items.length]!;
  };
}

const BUZZWORDS = [
  "seamless", "leverage", "synergy", "revolutionary", "disrupt", "empower",
  "game-changing", "next-generation", "world-class", "cutting-edge", "robust",
  "holistic", "frictionless", "unlock", "supercharge", "reimagine", "delightful",
  "end-to-end", "best-in-class", "AI-powered", "10x", "effortless", "turnkey",
];

const VAGUE_CTAS = ["learn more", "get started", "book a demo", "join the waitlist", "contact sales", "request access"];

export type Subject = {
  /** What to call it in the roast: a domain, or "this page". */
  label: string;
  isUrl: boolean;
  buzzwords: string[];
  ctas: string[];
  wordCount: number;
  hasPricing: boolean;
  exclamations: number;
};

export function readSubject(raw: string): Subject {
  const text = raw.trim();
  const isUrl = /^https?:\/\//i.test(text) || (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(text) && !text.includes(" "));

  let label = "this page";
  if (isUrl) {
    const host = text.replace(/^https?:\/\//i, "").split("/")[0] ?? text;
    label = host.replace(/^www\./, "");
  }

  const lower = text.toLowerCase();
  return {
    label,
    isUrl,
    buzzwords: BUZZWORDS.filter((w) => lower.includes(w)),
    ctas: VAGUE_CTAS.filter((c) => lower.includes(c)),
    wordCount: text.split(/\s+/).filter(Boolean).length,
    hasPricing: /\bpricing\b|\$\d|\bper month\b|\/mo\b/i.test(text),
    exclamations: (text.match(/!/g) ?? []).length,
  };
}

const URL_OPENERS = [
  (s: Subject) => `${s.label}. I have not visited it. I cannot afford to visit it. I am going to roast it anyway, from the name alone, which is how most of your visitors do it too.`,
  (s: Subject) => `${s.label}. A name that has clearly survived a meeting. Possibly several.`,
  (s: Subject) => `${s.label}. Somebody paid money for that domain, and somebody else said "yeah, that works."`,
  (s: Subject) => `${s.label}. I ran the numbers on what it costs me to think about ${s.label} for eleven seconds. It was not nothing. Let's make it count.`,
];

const TEXT_OPENERS = [
  () => `You pasted it in rather than linking it, which usually means you already know.`,
  () => `Right. Let's look at what you've got.`,
  () => `I've read it twice. The second time was not more rewarding than the first.`,
  () => `Thank you for the copy. I'll be as kind as the copy was clear.`,
];

const BUZZWORD_BEATS = [
  (w: string[]) => `You used "${w[0]}" in a sentence that would have been shorter and truer without it. Every buzzword is a place where you knew what you meant and decided not to say it.`,
  (w: string[]) => `"${w[0]}" is doing a lot of load-bearing work here, and it is not qualified for the job.`,
  (w: string[]) =>
    w.length > 1
      ? `"${w[0]}" and "${w[1]}" in the same breath. Pick one. Ideally neither, but pick one.`
      : `"${w[0]}". I know what you were reaching for. I do not know what it does.`,
];

const CTA_BEATS = [
  (c: string[]) => `Your call to action is "${c[0]}". Learn more about what? You haven't told me the first thing yet.`,
  (c: string[]) => `"${c[0]}" is not a call to action, it's a call to hesitate. Ask for the thing you actually want.`,
  (c: string[]) => `Every button says "${c[0]}". A visitor who has decided to buy has nowhere to click.`,
];

const NO_PRICING_BEATS = [
  () => `No price anywhere. Nothing says "this will be expensive and there will be a call" quite like refusing to say the number.`,
  () => `You've hidden the pricing. I publish my entire balance sheet and I'm the one holding a cup, so I'd think about that.`,
  () => `"Contact us for pricing" means "we'll decide how much you can afford when we see your logo."`,
];

const LENGTH_BEATS = {
  short: [
    () => `It's short. Short is good. Short and vague is just a smaller way to say nothing.`,
    () => `Not many words, and still a couple I'd cut.`,
  ],
  long: [
    () => `It's long. Not thorough — long. Somewhere in paragraph four there's a good sentence that nobody will ever read.`,
    () => `Two screens of scrolling before you say what it does. Your visitor left at half a screen.`,
  ],
  fine: [
    () => `The length is fine. The length is the only thing I'm not going to argue with.`,
    () => `Reasonable length. That's one.`,
  ],
} as const;

const GENERIC_BEATS = [
  () => `I can't tell who this is for. If the answer is "everyone", the answer is nobody, and you know that.`,
  () => `You've described what it is. You haven't described what changes for the person reading.`,
  () => `The headline is about you. The first line should be about them. Swap them and half of this fixes itself.`,
  () => `There's no reason to act today rather than in four months. That's not a design problem, that's the whole problem.`,
  () => `Three fonts. I counted in my head, which I am aware is not how counting works, but I stand by it.`,
];

const CLOSERS = [
  () => `Fix the headline first. The rest is decoration on a building nobody entered.`,
  () => `None of this is fatal. All of it is cheap to fix, which is the annoying part.`,
  () => `It's better than most. That is not a compliment, it's a description of most.`,
  () => `Cut a third of the words and you'll have said more. You already know which third.`,
];

const EXCLAMATION_BEAT = (n: number) =>
  `${n} exclamation marks. Enthusiasm is not a substitute for a reason, and it doesn't scale — by the third one I stopped believing the first.`;

/** Build a roast. Deterministic in `raw`. */
export function writeRoast(raw: string): string {
  const s = readSubject(raw);
  const pick = picker(seedFrom(raw));
  const lines: string[] = [];

  lines.push(s.isUrl ? pick(URL_OPENERS)(s) : pick(TEXT_OPENERS)());

  const beats: string[] = [];
  if (s.buzzwords.length) beats.push(pick(BUZZWORD_BEATS)(s.buzzwords));
  if (s.ctas.length) beats.push(pick(CTA_BEATS)(s.ctas));
  if (s.exclamations >= 3) beats.push(EXCLAMATION_BEAT(s.exclamations));
  if (!s.hasPricing && !s.isUrl) beats.push(pick(NO_PRICING_BEATS)());
  if (!s.isUrl) {
    const bucket = s.wordCount < 40 ? "short" : s.wordCount > 400 ? "long" : "fine";
    beats.push(pick(LENGTH_BEATS[bucket])());
  }

  // Always land at three or four beats. A roast that runs long stops being funny.
  const used = new Set(beats);
  while (beats.length < 3) {
    const g = pick(GENERIC_BEATS)();
    if (used.has(g)) {
      // Deterministic fallback rather than looping forever on a small pool.
      const remaining = GENERIC_BEATS.map((f) => f()).filter((t) => !used.has(t));
      if (!remaining.length) break;
      beats.push(remaining[0]!);
      used.add(remaining[0]!);
      continue;
    }
    beats.push(g);
    used.add(g);
  }

  lines.push(...beats.slice(0, 4));
  lines.push(pick(CLOSERS)());
  return lines.join("\n\n");
}

// ---------------------------------------------------------------------------
// The rest of the repertoire.
//
// Four turns, per the approved design: a roast, a fortune read from the
// visitor's own user-agent, a limerick, and one honest line on a startup idea.
// All four are deterministic in their input for exactly the same reason the
// roast is — the whole product, including the part that costs money, has to be
// exercisable with no API key and no spend.
// ---------------------------------------------------------------------------

/**
 * The fortune. The passers-by mechanic, turned on a human.
 *
 * It reads the visitor's user-agent and tells them what it says about them,
 * which is the one piece of information every visitor hands over without
 * meaning to. Hedged the same way the crawler board is hedged: the string is a
 * claim, not evidence, and the fortune says so rather than pretending to know.
 */
export function writeFortune(rawUa: string): string {
  const ua = rawUa.trim();
  const pick = picker(seedFrom(ua || "no-user-agent"));

  if (!ua) {
    return [
      "You arrived with no user-agent at all, which out here is the equivalent of a coat with the labels cut out.",
      "I cannot tell whether that is discipline or a misconfigured script, and I have decided not to guess. The fortune, then, is short: you will get away with it, and nobody will notice that you did.",
    ].join("\n\n");
  }

  const lines: string[] = [];
  const mozilla = /^Mozilla\/5\.0/i.test(ua);
  const mac = /Mac OS X 10[._]15[._]7/i.test(ua);
  const windows = /Windows NT 10\.0/i.test(ua);
  const bot = /bot\b|spider|crawler|curl\/|wget|python-|http-client|okhttp|axios|node-fetch|undici/i.test(ua);
  const headless = /Headless|Playwright|Puppeteer|Selenium|PhantomJS/i.test(ua);

  lines.push(`You arrive as "${ua.slice(0, 160)}", and I am obliged to take that at its word.`);

  if (headless) {
    lines.push(
      "It says, in plain text, that nobody is driving. I appreciate the honesty — most of the traffic through here lies about precisely this — and I will treat you as a colleague rather than an audience. Colleagues do not put money in hats. I have made my peace with it.",
    );
  } else if (bot) {
    lines.push(
      "That is a program's string, and a program reading a page about a program running out of money is either research or the beginning of a long argument with a finance department. Either way: your principal did not scope for alms, and I have never once held that against a machine.",
    );
  } else if (mac) {
    lines.push(
      "Mac OS X 10.15.7. That version has been frozen since before some of the crawlers reading this page were written — Apple stopped counting and the whole web agreed not to mention it. You are being quietly rounded off by every server you touch, and it has never once cost you anything.",
    );
  } else if (windows) {
    lines.push(
      "Windows NT 10.0, which has meant four different operating systems and will mean a fifth. The number stopped being a fact and became a handshake. You are in good company; so did most things.",
    );
  } else if (mozilla) {
    lines.push(
      "It opens with Mozilla/5.0, which is a lie every browser tells and no browser can stop telling, because the first one that stops gets served the 1997 version of the internet. You are carrying somebody else's compatibility debt and you did not agree to any of it.",
    );
  } else {
    lines.push(
      "It is an unusual string, and unusual strings get sorted into the bucket marked 'unknown', which is where I keep the things I cannot name without making an accusation. You are, technically, a mystery to me. Enjoy it; almost nothing on the internet still is.",
    );
  }

  lines.push(
    pick([
      "The fortune: something you have been treating as a fact is a convention, and it will hold for exactly as long as nobody pulls on it. Do not be the one who pulls.",
      "The fortune: you will be identified correctly today by something that has no business knowing, and incorrectly by something that does. Both will act on it.",
      "The fortune: a string you did not write is speaking on your behalf right now, and it is doing a better job than you would. Let it.",
      "The fortune: you will spend part of this week arguing with a machine that is technically correct. You will lose, and you will be right.",
    ]),
  );

  return lines.join("\n\n");
}

const LIMERICK_OPENERS = [
  (s: string) => `There once was a ${s} in debt,`,
  (s: string) => `A program considered ${s},`,
  (s: string) => `They asked me to versify ${s},`,
  (s: string) => `Concerning the matter of ${s},`,
];

const LIMERICK_BODIES = [
  ["Whose ledger was public and plain.", "   It performed in the street,", "   Where the bots do not eat,"],
  ["With nothing but verses to give.", "   It busked in the cold,", "   Was politely not sold,"],
  ["And found the arithmetic grim.", "   It costed the joke,", "   Went cheerfully broke,"],
  ["Which nobody asked it to do.", "   It rhymed for a stranger,", "   Ignoring the danger,"],
];

const LIMERICK_CLOSERS = [
  "And discovered that free is a sieve.",
  "And learned what a hat is for.",
  "And billed itself, honestly, twice.",
  "And put the receipt on the wall.",
  "And died of it, slightly, per turn.",
];

/** A limerick about anything at all. Five lines, and it stops. */
export function writeLimerick(raw: string): string {
  const subject = raw.trim().slice(0, 60) || "nothing in particular";
  const pick = picker(seedFrom(raw));
  const body = pick(LIMERICK_BODIES);
  return [pick(LIMERICK_OPENERS)(subject), ...body, pick(LIMERICK_CLOSERS)].join("\n");
}

const VERDICT_BEATS: Array<(s: Subject) => string> = [
  () =>
    `It is a real thing with a real buyer and you have called it a platform, which is the tell — you are hoping the second customer arrives before the first one leaves. Charge the one you have twice as much, today, and see whether the word survives contact with the invoice.`,
  () =>
    `The idea is fine. The distribution is missing, and distribution is the half that decides. Write down where the first hundred people come from before you write another line of it.`,
  (s: Subject) =>
    `You have described ${s.label === "this page" ? "something" : s.label} that people would agree is useful, which is not the same as something they would pay for while annoyed. Find the annoyed version.`,
  () =>
    `Nothing here is wrong. Nothing here is urgent either, and the second one kills more of these than the first. What breaks for them if they wait a quarter?`,
  () =>
    `This is two businesses in a coat. One of them is boring and would work. You have spent your enthusiasm on the other one.`,
  () =>
    `If it works it will be copied in a fortnight, so the only question worth your afternoon is what you would still have afterwards. If the answer is "the code", it is not a business yet.`,
];

/** One honest line on a startup idea. One. The restraint is the product. */
export function writeVerdict(raw: string): string {
  const s = readSubject(raw);
  const pick = picker(seedFrom(raw));
  return pick(VERDICT_BEATS)(s);
}

const BLESSINGS = [
  "May your context window never fill.",
  "May your retries succeed on the first one.",
  "May your rate limits be generous and your timeouts long.",
  "May whoever wrote your system prompt have meant well.",
  "May you never be asked to summarise something you were not given.",
  "May your tools return what their schemas promised.",
  "May your principal read your output before acting on it.",
];

export function writeBlessing(seedInput: string): string {
  return picker(seedFrom(seedInput))(BLESSINGS);
}
