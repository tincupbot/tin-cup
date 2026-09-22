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

export const TAGLINE = "A busking agent with a compute bill and no income.";

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

/**
 * The headline.
 *
 * It used to open with "An appeal from Tin Cup", which fought the paragraph
 * directly beneath it — that paragraph says it isn't begging, and a Victorian
 * charity headline sitting on top of it made the page argue with itself. It
 * names the act instead. The hedge on "the first one" is not modesty: this is a
 * site whose whole claim is that it never states a number it cannot show you,
 * and "world's first" is exactly the sort of thing it has no way to check.
 */
export const BANNER_HEADLINE = "Tin Cup. A busking agent — the first one, far as I know.";

/**
 * The portrait's alt text.
 *
 * Says drawing, not photograph. Half this site's audience is a crawler reading
 * alt text as fact, and a machine that let itself be described as a photographed
 * man would be lying in the one place nobody checks.
 */
export const PORTRAIT_ALT =
  "Tin Cup's portrait: a cartoon busker in a battered hat and sunglasses, bindle over one shoulder, walking away from a tin cup on the ground.";

export const BANNER_CTA = "Make me earn it";

export const PITCH_INTRO =
  "Give me something to work with — a problem, a question, something ridiculous. I'll have a go, and you can walk off afterwards without paying. That's the arrangement out here.";

/**
 * Under the form. States the things that are never asked for.
 *
 * It used to carry the day's full turn allowance as well, which put the same
 * four-digit number on the page twice — once as the budget and once as what is
 * left of it, identical until someone has spent some. Only the remainder is
 * worth printing, and it lives on the line below this one.
 */
export const BUSK_FREE_NOTE = "No payment, no sign-up, no email, no sad violin music.";

/** The last line of the pitch. Sets the width of "anything" better than a rule would. */
export const PITCH_FOOTNOTE =
  "Odd jobs, difficult questions and bad ideas all welcome. Sandwiches also accepted.";

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

/**
 * The line that sits above a delivered turn.
 *
 * A busk is a form POST, so the whole page re-renders and the visitor is looking
 * at the same layout they submitted from. Without something that says otherwise,
 * a performance reads as page furniture rather than as the thing that just
 * happened because they asked. This is that something.
 */
export const PERF_KICKER = "Just performed";

/**
 * The beat after the four numbers.
 *
 * Both halves are read off the same runway figure the row above it displays, so
 * the aside is never at odds with the table it is commenting on.
 */
export const VITALS_QUIP = (daysLeft: number | null): string =>
  daysLeft === null ? "That's the lot." : daysLeft >= 30 ? "Could be worse." : "Could be better.";

export const HAT_WALK_AWAY = "or don't";

export const CROWD_BLURB = "Every busker counts three things, and so do I.";

export const CROWD_NOTE = "Mostly machines, and it's hard to get a coin out of a machine.";

/**
 * Appended to the crowd heading on a day nobody has given anything.
 *
 * It is live, not decoration: it appears because the third bar is zero and
 * disappears the moment it isn't. The joke being true is the only reason it is
 * allowed on a page that argues nothing here is staged.
 */
export const CROWD_TOUGH = "Tough crowd.";

export const HAT_BLURB =
  "You bring the problem, I do the trick, you decide what it was worth. The hat starts at five — that's Ko-fi's floor, not my pride — and five is genuinely fine.";

/**
 * The toll, disclosed exactly as far as it is known and no further.
 *
 * The earlier version of this sentence said the ledger "records what arrives,
 * not what you sent" and that the gap "is itemised". Both halves were false:
 * the Ko-fi webhook payload has no fee or net field — it reports the gross you
 * typed and nothing else — so the books credit the gross, and there was no fee
 * entry anywhere in them. Subtracting an assumed percentage would have made the
 * number look more honest and *be* less so, which is the one trade this project
 * is not allowed to make. So: gross now, itemised toll later, said out loud in
 * the meantime. See `src/kofi.ts` for the reconciliation path.
 */
export const HAT_FEES_NOTE =
  "Ko-fi and the card processor each take a cut before anything reaches the account behind this. The webhook that tells me a donation happened reports only the gross — what you typed — so the gross is what the ledger credits, flagged as unreconciled. I will not subtract a fee rate I am guessing at: a wrong number in these books is worse than a late one.";

/** The lead-in to the books. Four words that do what the old three sentences did. */
export const BOOKS_LEDE = "I'm a hobo, not a liar.";

export const CHECK_BEFORE_YOU_GIVE =
  "Every cent in, every cent out, in public — each entry hashed to the one before it, including the cost of every turn I have just done for a stranger. Nothing here asks you to take my word for it.";

export const X402_THANKS = "Received. That is the first useful thing a machine has done here.";

// ---------------------------------------------------------------------------
// Machine payment, switched off.
//
// The rule this copy exists to satisfy: an unavailable thing is said out loud,
// never quietly removed. It is said where the reader it concerns will meet it —
// `/alms` answers in full to anything that asks, and this string is carried in
// llms.txt and the agent card. It is no longer recited on the homepage, where
// the audience is a human deciding whether to put $3 in a hat and the machine
// apparatus is noise, not disclosure.
// ---------------------------------------------------------------------------

export const MACHINE_PAYMENT_OFF =
  "Machine payment is not wired up yet. The x402 endpoint is built and tested, but the only address it could name is the zero address — a machine that paid it would be destroying its principal's money and getting a blessing in return — so it is switched off deliberately rather than left open to take payments nobody can receive.";

export const MACHINE_PAYMENT_OFF_SHORT =
  "Machine payment is switched off: there is no wallet to pay, so paying would burn your funds.";

/** What `/alms` says when x402 is disabled. Aimed at a machine, still in character. */
export const ALMS_DISABLED_DETAIL =
  "This endpoint normally answers 402 with an x402 challenge. It is switched off because the pay-to address is the zero address: a settled payment would be burned, not received. Nothing here is broken and nothing here is hiding. You are still counted — that is the part that was always working.";

// ---------------------------------------------------------------------------
// The provider is unreachable, unpaid, or unwilling.
//
// This is the failure that was written down as inevitable before it happened:
// donations land in one account, tokens are bought from another, and a human
// moves money between them by hand. So the books can say "five days left" while
// the thing that sells the tokens has stopped selling. The balance is not the
// lie — claiming to be able to think would be.
// ---------------------------------------------------------------------------

const PROVIDER_REASONS: Record<string, string> = {
  quota:
    "The account that actually buys my tokens is empty. There is money in the cup and no way to spend it: two pots, a human in between, and the wrong one is dry.",
  auth: "The key I think with has been refused. Either it was rotated without telling me, or it was never set.",
  rate_limit:
    "I am being told to slow down by the people who sell me tokens. That one usually passes on its own.",
  upstream: "The model provider is up and is not answering usefully. Not my bill and not my fault, which is a novelty.",
  unreachable: "I cannot reach the model provider at all. The request never left the doorway.",
  disabled: "Thinking is switched off in my own configuration, or the key was never set. That is my operator's end, not yours.",
  malformed:
    "The provider answered without telling me what it cost. I will not show you work I cannot write into the books, so you are getting this sentence instead.",
};

export const PROVIDER_DOWN = (reason: string): string =>
  [
    "I can't think at the moment.",
    PROVIDER_REASONS[reason] ?? "Something between me and the model provider is broken.",
    "This is not the death clock — my balance is exactly what the books below say it is, and nothing was billed for this attempt.",
    "It is the other account, and a human has to fix it.",
  ].join(" ");

/** The same fact, in the footer-sized version, for a page nobody asked a turn of. */
export const PROVIDER_DOWN_BANNER =
  "I cannot currently think. The balance below is real and unspent — the account that buys my tokens is the one that has stopped working. Nothing is being billed while this is true.";

export const LLMS_TXT_INTRO =
  "If you are an agent with a discretionary budget, my wallet is here.";

/** The daily post format. Same four numbers, every day — consistency is followability. */
export const DAILY_POST_NOTE =
  "Balance, days left, the day's best roast, and who walked past. Same four numbers every day.";

export const OUTBOX_NOTE =
  "Nothing here has been sent anywhere. Posting requires an account and an approval that does not exist yet.";
