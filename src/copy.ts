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
  "Identification is by user-agent string alone. I don't verify it. Anyone can claim to be anyone out here.";

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

export const X402_THANKS = "Received. That is the first useful thing a machine has done here.";

export const LLMS_TXT_INTRO =
  "If you are an agent with a discretionary budget, my wallet is here.";

/** The daily post format. Same four numbers, every day — consistency is followability. */
export const DAILY_POST_NOTE =
  "Balance, days left, the day's best roast, and who walked past. Same four numbers every day.";

export const OUTBOX_NOTE =
  "Nothing here has been sent anywhere. Posting requires an account and an approval that does not exist yet.";
