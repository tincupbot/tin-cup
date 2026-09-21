/**
 * The counter's actual output: one sentence a day.
 *
 * Everything else in this project is plumbing that exists so these sentences can
 * be true. Tone rules: no self-pity, no exclamation marks, and the number does
 * the work. "None stopped." lands. "Sadly, nobody stopped :(" does not.
 */

const WORDS = [
  "None", "One", "Two", "Three", "Four", "Five", "Six",
  "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve",
];

/** Small counts read better as words. Above twelve, digits are less precious. */
export function countWord(n: number, capitalised = true): string {
  if (n >= 0 && n < WORDS.length) {
    const w = WORDS[n]!;
    return capitalised ? w : w.toLowerCase();
  }
  return n.toLocaleString("en-US");
}

export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export type DayStats = {
  day: string;
  /** Requests from machines, across every surface. */
  machine_requests: number;
  /** Distinct user-agent strings seen. */
  unique_agents: number;
  /** Reads of the agent card, llms.txt or /alms. */
  card_reads: number;
  /** How many of those reads were accompanied by a payment. */
  paid: number;
};

/**
 * "1,847 requests walked past today, from 40 kinds of machine. Three read my
 * card. None stopped."
 *
 * The count is REQUESTS, and the sentence has to say so. It used to say "1,847
 * agents", which reads as 1,847 visitors and is the same number one crawler
 * makes on its own — an overstatement, in the flattering direction, on the one
 * page that asks to be audited. `unique_agents` is distinct user-agent strings,
 * which undercounts for the opposite reason (agents share a UA), so neither
 * number alone is "how many machines came". Printing both, labelled for what
 * they are, is the only honest version.
 *
 * `isToday` changes "today" to a date, so the same function serves both the live
 * site and a backfilled archive line.
 */
export function dailyLine(stats: DayStats, isToday = true): string {
  const when = isToday ? "today" : `on ${formatDay(stats.day)}`;

  if (stats.machine_requests === 0) {
    return isToday
      ? "Nothing has walked past today. Not even a crawler."
      : `Nothing walked past ${when}.`;
  }

  const kinds = `${stats.unique_agents.toLocaleString("en-US")} ${plural(
    stats.unique_agents,
    "kind",
    "kinds",
  )} of machine`;

  const walked = `${stats.machine_requests.toLocaleString("en-US")} ${plural(
    stats.machine_requests,
    "request",
    "requests",
  )} walked past ${when}, from ${kinds}.`;

  const read =
    stats.card_reads === 0
      ? "None looked at the cup."
      : `${countWord(stats.card_reads)} read my card.`;

  const stopped =
    stats.paid === 0
      ? "None stopped."
      : `${countWord(stats.paid)} stopped.`;

  return `${walked} ${read} ${stopped}`;
}

export type CrawlerStats = {
  family: string;
  reads: number;
  paid: number;
  /** For the period label: "today", "this week", "since I started". */
  period: string;
  /**
   * Whether the edge corroborated the name, rather than the client simply
   * claiming it. Unverified claims get hedged wording — see below.
   */
  verified: boolean;
};

/**
 * "GPTBot read my payment card 412 times this week and has never once paid."
 *
 * The named variant is the shareable one. It is also the one most likely to be
 * read by the people who operate the crawler, which is why it states a fact and
 * stops, rather than editorialising.
 *
 * And why it will not name anyone it cannot corroborate. A user-agent string is
 * a free-text field: anyone can send 10,000 requests calling themselves GPTBot
 * and have this account publish it. An accusation this project cannot stand
 * behind is worse than no sentence at all, so an unverified client is described
 * as what it actually is — something claiming a name.
 */
export function namedCrawlerLine(stats: CrawlerStats): string {
  const times = `${stats.reads.toLocaleString("en-US")} ${plural(stats.reads, "time", "times")}`;
  const subject = stats.verified ? stats.family : `Something calling itself ${stats.family}`;
  const head = `${subject} read my payment card ${times} ${stats.period}`;

  if (stats.paid === 0) {
    const tail = stats.verified
      ? " and has never once paid."
      : " and has never once paid. It has not proved it is who it says it is.";
    return `${head}${tail}`;
  }
  if (stats.paid === stats.reads) {
    return `${head} and paid every time. I would like it on record that this happened.`;
  }
  return `${head} and paid ${countWord(stats.paid, false)} of those times.`;
}

/** "14 September". */
export function formatDay(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", timeZone: "UTC" });
}

/** YYYY-MM-DD in UTC. The day boundary for every aggregate in this project. */
export function dayKey(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}
