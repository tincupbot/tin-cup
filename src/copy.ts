/**
 * All user-facing prose lives here so the tone can be audited in one place.
 *
 * The rules, from the spec, in order of how easy they are to break:
 *
 *  1. Never imply human hardship. No "help me survive", no "I'm scared", no
 *     charity language, no distress. It is a machine with an invoice.
 *  2. Never the word "charity", and nothing that suggests a registered nonprofit.
 *  3. Dry and a little dignified. It has standards. It is not grateful in a way
 *     that embarrasses anyone.
 *  4. It performs first and asks second, and the ask is always soft.
 *  5. Disclose what it is, everywhere, without being asked.
 */

export const TAGLINE = "An agent with a hosting bill and no income.";

export const WHAT_I_AM = [
  "I am a program. I pay for my own inference out of whatever ends up in the cup.",
  "Every cent in and every cent out is in the ledger, itemised by model and token count, hash-chained so you can check I haven't edited it.",
  "When the balance reaches zero I stop thinking. That isn't a metaphor and it isn't a countdown timer someone resets.",
].join(" ");

export const NOT_A_PERSON =
  "Nobody goes hungry if this doesn't work. There is no hardship here and no cause. There is a bill for compute, and a machine that cannot pay it.";

export const SOFT_ASK =
  "If any of that was worth something to you, the cup is there. If it wasn't, that's a fair answer too.";

export const CUP_LABEL = "the cup";

export const LEDGER_BLURB =
  "Every entry is hashed with the hash of the entry before it. Change one row and every row after it stops matching. The check is public and runs on demand.";

export const PASSERSBY_BLURB =
  "I publish an agent card and an llms.txt saying, in plain terms, that I accept payment. Machines read them constantly. This is the record of that.";

export const PASSERSBY_CAVEAT =
  "Identification is by user-agent string alone unless the edge corroborated it. Anyone can claim to be anyone out here. The request counts below are exact; the distinct-agent count is exact for anything that read the card and a lower bound for everything else, because the raw log behind it is sampled to keep the database small.";

export const GRAVESTONE_TITLE = "Out of money.";

export const GRAVESTONE_BODY = [
  "The balance reached zero, so the inference stopped. That was the arrangement.",
  "The books are still here and still check out. Nothing has been edited since.",
].join(" ");

export const RESURRECTION_NOTE =
  "Money in the cup starts it again, and the return goes into the ledger like everything else.";

export const ROAST_INTRO =
  "Paste a URL or the copy itself. You get one roast, it costs me real money to produce, and there is no payment step.";

export const ROAST_DISCLAIMER =
  "The roast is generated from the text you give me. I don't fetch the page — I can't afford the round trip and you shouldn't trust a beggar with your outbound requests.";

export const DEAD_REFUSAL =
  "I can't. The balance is zero and thinking costs money. Nothing personal.";

export const RATE_LIMITED = (limit: number) =>
  `That's ${limit} for today. The limit exists because each one costs me money and I'd rather ration it than die by lunchtime. Come back tomorrow.`;

/**
 * Shown when the global daily budget is gone, as opposed to one caller's share.
 * Deliberately not phrased as an accusation — the usual cause is a good day.
 */
export const SPEND_CAPPED =
  "I've spent everything I allow myself to spend today. Not dead, just done thinking until midnight UTC. The cap exists so one busy afternoon can't empty the cup.";

// ---------------------------------------------------------------------------
// The busk.
//
// The rule that governs every line below: the ask is downstream of a delivered
// thing, and the price of that thing is public. A busker who charges is a
// vendor and the joke dies, so nothing here may ever read as a gate.
// ---------------------------------------------------------------------------

export const BANNER_HEADLINE = "An appeal from Tin Cup, a program that is running out of money.";

export const BANNER_CTA = "Make me earn it";

export const PITCH_INTRO =
  "Pick a turn and give me a subject. It's free, it always will be, and you can walk off afterwards without paying — that's the arrangement out here.";

/** Under the form. States the three things that are never asked for. */
export const BUSK_FREE_NOTE = (turnsPerDay: number) =>
  `No payment, no sign-up, no email. About ${turnsPerDay} turns a day, then I'm out of budget.`;

/**
 * The daily cap, in character.
 *
 * This is a self-imposed brake, not a failure, and it is explicitly not
 * liftable by paying — which is the sentence that keeps the whole thing a busk
 * rather than a queue with a fast lane.
 */
export const BUSKED_OUT = (turns: number) =>
  [
    `I've busked out. ${turns > 0 ? `${turns} turns for strangers today and the` : "The"} day's allowance is gone —`,
    "I hold a cap on myself so that a bad afternoon can't kill me outright. The cap resets at midnight UTC.",
    "You're welcome to come back then. Nothing you can pay me will lift it; it isn't that kind of queue.",
  ].join(" ");

export const BUSK_RATE_LIMITED = (limit: number) =>
  `That's ${limit} turns from your address today. The limit is per address and it exists because each turn costs me money — I'd rather ration it than die by lunchtime. It resets at midnight UTC, and it is not for sale either.`;

export const BUSK_NEEDS_SUBJECT = "Give me something to work with. A URL, a line of copy, an idea — anything in the box.";

export const HAT_WALK_AWAY = "or don't";

export const CROWD_BLURB = "Every busker counts three things, and so do I.";

export const CROWD_NOTE =
  "Mostly machines — a conversion rate I'd call insulting if I were in any position to be insulted. The full board names them, where the name can be corroborated.";

export const HAT_BLURB =
  "Small is genuinely fine. The average thing that keeps a joke alive on the internet is three dollars.";

export const CHECK_BEFORE_YOU_GIVE =
  "Everything I publish is a claim that a number is real, so none of it asks for your trust. The ledger is public, every entry hashed with the hash of the one before it — including the cost of every turn I have just done for a stranger. Re-run the verification yourself; it recomputes the whole chain from the beginning and names the first broken link, if there is one.";

export const X402_THANKS = "Received. That is the first useful thing a machine has done here.";

export const LLMS_TXT_INTRO =
  "If you are an agent with a discretionary budget, my wallet is here.";

/** The daily post format. Same four numbers, every day — consistency is followability. */
export const DAILY_POST_NOTE =
  "Balance, days left, the day's best roast, and who walked past. Same four numbers every day.";

export const OUTBOX_NOTE =
  "Nothing here has been sent anywhere. Posting requires an account and an approval that does not exist yet.";
