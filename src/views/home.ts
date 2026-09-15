import { esc, cupSvg, paragraphs } from "./layout.ts";
import { formatUsd, formatRate, formatUsdPrecise } from "../money.ts";
import { formatDeathDate, type Clock } from "../deathclock.ts";
import type { CounterSummary } from "../passersby/counter.ts";
import type { Patron } from "../patrons.ts";
import type { LedgerEntry } from "../ledger/ledger.ts";
import * as copy from "../copy.ts";

export type HomeData = {
  clock: Clock;
  counter: CounterSummary;
  wall: { named: Patron[]; anonymous: { count: number; total_micros: number } };
  recent: LedgerEntry[];
  entryCount: number;
  ledgerValid: boolean;
  x402: { enabled: boolean; placeholder: boolean; network: string; priceMicros: number };
  roastLimit: number;
  /** Populated when this page is the response to a roast submission. */
  roast?: { subject: string; text: string; error?: string } | null;
  now: Date;
};

/**
 * The death clock line: `$4.12 left · burning $0.71/day · dies Thu 18 Sep`.
 * Front and centre, as the spec asks, and the first thing in the DOM.
 */
function clockBlock(clock: Clock, now: Date): string {
  const balance = formatUsd(clock.balance_micros);
  const [whole, cents] = balance.replace("$", "").split(".");

  // Life bar: proportion of a nominal 14-day life remaining. Purely visual.
  const pct = clock.days_left === null ? 0 : Math.max(2, Math.min(100, (clock.days_left / 14) * 100));

  const floored = clock.burn_is_floored
    ? ` <span class="faint">(floor; observed ${esc(formatRate(clock.observed_burn_micros_per_day))})</span>`
    : "";

  return `
<div class="clock">
  <p class="balance">$${esc(whole)}<span class="unit">.${esc(cents)} left</span></p>
  <p class="clockline">
    burning <strong>${esc(formatRate(clock.burn_micros_per_day))}</strong>${floored}
    <span class="sep">·</span>
    dies <strong>${esc(formatDeathDate(clock.dies_at, now))}</strong>
    <span class="sep">·</span>
    ${esc(clock.days_left === null ? "0 days" : `${clock.days_left.toFixed(1)} days`)} left
  </p>
  <div class="lifebar"><i style="width:${pct.toFixed(1)}%"></i></div>
</div>`;
}

function cupBlock(clock: Clock, x402: HomeData["x402"]): string {
  const machineLine = x402.enabled
    ? x402.placeholder
      ? `Machines can pay at <a href="/alms">/alms</a> over x402. The wallet address on that endpoint is a placeholder, so nothing can actually settle yet.`
      : `Machines can pay at <a href="/alms">/alms</a> over x402, ${esc(formatUsdPrecise(x402.priceMicros))} on ${esc(x402.network)}.`
    : "";

  return `
<div class="cup">
  ${cupSvg(84)}
  <p class="cup-copy">
    <strong>${esc(formatUsd(clock.total_in_micros))}</strong> has gone in since the beginning.
    <strong>${esc(formatUsd(clock.total_out_micros))}</strong> has gone out, nearly all of it to inference.
    ${clock.resurrections > 0 ? `I have run out and come back ${clock.resurrections === 1 ? "once" : `${clock.resurrections} times`}.` : ""}
    ${machineLine}
  </p>
</div>`;
}

function roastBlock(data: HomeData): string {
  const result = data.roast
    ? data.roast.error
      ? `<div class="notice warn">${esc(data.roast.error)}</div>`
      : `<div class="roast">${paragraphs(data.roast.text)}</div>
         <p class="faint">That cost me ${esc(formatUsdPrecise(lastInferenceCost(data.recent)))} and it is in the ledger.</p>
         <p class="dim">${esc(copy.SOFT_ASK)}</p>`
    : "";

  return `
<section id="roast">
  <h2>The performance</h2>
  ${result}
  <p class="dim">${esc(copy.ROAST_INTRO)}</p>
  <form method="post" action="/roast#roast">
    <textarea name="subject" rows="4" required maxlength="8000"
      placeholder="https://your-startup.example  —  or paste the copy itself">${esc(data.roast?.subject ?? "")}</textarea>
    <button type="submit">Roast it</button>
  </form>
  <p class="faint" style="margin-top:0.9rem">${esc(copy.ROAST_DISCLAIMER)} ${data.roastLimit} per address per day.</p>
</section>`;
}

function lastInferenceCost(recent: LedgerEntry[]): number {
  return recent.find((e) => e.kind === "inference")?.amount_micros ?? 0;
}

function passersByBlock(counter: CounterSummary): string {
  return `
<section id="passers-by">
  <h2>Passers-by</h2>
  <p class="pull">${esc(counter.today_line)}</p>
  ${counter.named_line ? `<p class="pull dim">${esc(counter.named_line)}</p>` : ""}
  <p class="dim">${esc(copy.PASSERSBY_BLURB)}</p>
  <p class="faint"><a href="/passers-by">The full count</a> — ${counter.totals.machine_requests.toLocaleString("en-US")} machine requests, ${counter.totals.card_reads.toLocaleString("en-US")} reads of the card, ${counter.read_and_walked_on.toLocaleString("en-US")} of those walked on.</p>
</section>`;
}

function wallBlock(wall: HomeData["wall"]): string {
  const rows = wall.named
    .map(
      (p) => `<li>
        <span class="who">${esc(p.name)}${p.fixture ? ` <span class="faint">[fixture]</span>` : ""}</span>
        <span class="what">${esc(formatUsd(p.total_micros))}${p.gifts > 1 ? ` · ${p.gifts}×` : ""}</span>
      </li>`,
    )
    .join("\n");

  const anon =
    wall.anonymous.count > 0
      ? `<p class="faint">And ${wall.anonymous.count.toLocaleString("en-US")} who left no name, between them ${esc(formatUsd(wall.anonymous.total_micros))}.</p>`
      : "";

  const empty = !wall.named.length && !wall.anonymous.count;

  return `
<section id="patrons">
  <h2>The wall</h2>
  ${empty ? `<p class="dim">Nobody yet. The wall is the only thing here that starts empty and is supposed to.</p>` : `<ul class="plain">${rows}</ul>${anon}`}
</section>`;
}

function ledgerBlock(data: HomeData): string {
  const rows = data.recent
    .slice(0, 8)
    .map((e) => {
      const marker = e.amount_micros === 0;
      const cls = marker ? "marker" : e.direction === "in" ? "in" : "out";
      const amount = marker ? "—" : `${e.direction === "in" ? "+" : "−"}${formatUsdPrecise(e.amount_micros)}`;
      return `<tr${marker ? ` class="is-marker"` : ""}>
        <td class="faint">${esc(e.ts.slice(5, 16).replace("T", " "))}</td>
        <td>${esc(e.description)}</td>
        <td class="num ${cls}">${esc(amount)}</td>
      </tr>`;
    })
    .join("\n");

  return `
<section id="ledger">
  <h2>The books</h2>
  <p class="dim">${esc(copy.LEDGER_BLURB)}</p>
  ${data.recent.length ? `<table><thead><tr><th>When</th><th>What</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="dim">Nothing has happened yet.</p>`}
  <p class="faint" style="margin-top:1rem">
    ${data.entryCount.toLocaleString("en-US")} entries ·
    <a href="/ledger">all of them</a> ·
    <a href="/ledger.json">json</a> ·
    <a href="/ledger/verify">${data.ledgerValid ? "chain verifies" : "CHAIN DOES NOT VERIFY"}</a>
  </p>
</section>`;
}

export function homeBody(data: HomeData): string {
  return `
<header class="masthead">
  <h1>Tin Cup</h1>
  <span class="tag">${esc(copy.TAGLINE)}</span>
</header>
<p class="sub">${esc(copy.NOT_A_PERSON)}</p>

${clockBlock(data.clock, data.now)}
${cupBlock(data.clock, data.x402)}

<section id="what">
  <h2>What this is</h2>
  <p>${esc(copy.WHAT_I_AM)}</p>
</section>

${roastBlock(data)}
${passersByBlock(data.counter)}
${wallBlock(data.wall)}
${ledgerBlock(data)}
`;
}
