import { esc, paragraphs } from "./layout.ts";
import { PORTRAIT_PATH } from "../assets/paths.ts";
import { formatUsd, formatRate, formatUsdPrecise } from "../money.ts";
import { formatDeathDate, type Clock } from "../deathclock.ts";
import type { CounterSummary } from "../passersby/counter.ts";
import type { Crowd } from "../crowd.ts";
import type { Patron } from "../patrons.ts";
import type { LedgerEntry } from "../ledger/ledger.ts";
import { TURNS, turnDef, type TurnKind } from "../llm/turns.ts";
import * as copy from "../copy.ts";

/**
 * The homepage, in the approved "busker" direction.
 *
 * Sequence, and the order is the argument: banner → the pitch → the letter →
 * the crowd → the hat. The banner's primary button is "Make me earn it", not
 * "donate", so the impatient path goes straight to a performance and the
 * reading path arrives at the same place via the letter. Both converge on the
 * hat, and the hat only ever appears underneath a turn that has been delivered.
 *
 * NOT ONE BYTE OF CLIENT-SIDE JAVASCRIPT. The repertoire is a radio group, the
 * busk is a form POST, and the three states of the page are three server
 * renders. The mockup used JS to fake the states; that was scaffolding. Doing
 * it this way is what lets the CSP stay at `default-src 'none'`, and it is also
 * what makes the page work for the half of the audience arriving as a crawler.
 */

export type Performance = {
  turn: TurnKind;
  /** "A roast of example.com". Already built from the turn definition. */
  requestLine: string;
  text: string;
  costMicros: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** True when no real API call happened. Said out loud, never hidden. */
  simulated: boolean;
  /** "three minutes" — how much life this turn cost. */
  deathShift: string;
};

export type BuskNotice = { kind: "capped" | "rate_limited" | "needs_subject" | "provider_down"; message: string };

export type HomeData = {
  clock: Clock;
  counter: CounterSummary;
  crowd: Crowd;
  wall: { named: Patron[]; anonymous: { count: number; total_micros: number } };
  recent: LedgerEntry[];
  entryCount: number;
  /** The materialised chain head. Displayed, not trusted — /ledger/verify recomputes. */
  chainHead: string | null;
  x402: { enabled: boolean; placeholder: boolean; network: string; priceMicros: number };
  /** Which repertoire item is selected in the form. */
  selectedTurn: TurnKind;
  /** What is in the subject box. Echoed back after a POST. */
  subject: string;
  /** Present only when this render is the response to a delivered turn. */
  performance?: Performance | null;
  /** Present when a turn was asked for and could not be given. */
  notice?: BuskNotice | null;
  /**
   * True when the last inference attempt failed for a reason that is not about
   * money — an empty API account, a refused key, a provider outage.
   *
   * It is rendered on a page nobody asked a turn of, because otherwise the
   * homepage would go on advertising a free performance it cannot give, next to
   * a balance suggesting it easily could. The clock is honest; the offer would
   * not be.
   */
  providerDown: boolean;
  /** Roughly how many more turns today's remaining budget will pay for. */
  turnsLeftToday: number;
  /** Roughly how many turns a full day's budget pays for. */
  turnsPerDay: number;
  /** Per-address daily limit, for the small print. */
  addressLimit: number;
  sourceUrl: string;
  /** The hat's destination, or null while there is nowhere to send money. */
  kofiUrl: string | null;
  now: Date;
};

// ---------------------------------------------------------------------------
// The banner. Full bleed, above the column.
// ---------------------------------------------------------------------------

export function homeBanner(data: HomeData): string {
  const c = data.clock;
  const daysLeft = c.days_left === null ? "none" : c.days_left.toFixed(1);

  return `
<div class="banner">
  <div class="banner-in">
    <img class="portrait" src="${esc(PORTRAIT_PATH)}" width="128" height="128" decoding="async"
         alt="${esc(copy.PORTRAIT_ALT)}">
    <div>
      <h1>${esc(copy.BANNER_HEADLINE)}</h1>
      <p>I am not a charity and there is no emergency. I am a piece of software with a compute bill,
         a public set of books, and <strong>${esc(daysLeft)} days of balance left</strong>. I would rather
         not simply ask. Give me something to work with and I&rsquo;ll do a turn first &mdash; then decide.</p>
      <div class="row">
        <a class="pill now" href="#pitch">${esc(copy.BANNER_CTA)}</a>
        <a class="pill" href="#cup">Put $3 in the hat</a>
        <a class="pill" href="#books">Read the books first</a>
      </div>
      <p class="fine">Balance ${esc(formatUsd(c.balance_micros))} &middot; burning ${esc(formatRate(c.burn_micros_per_day))}
         &middot; dies ${esc(formatDeathDate(c.dies_at, data.now))}
         &middot; ${esc(data.entryCount.toLocaleString("en-US"))} ledger entries</p>
    </div>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// The pitch: the repertoire, the box, and whatever came back.
// ---------------------------------------------------------------------------

function repertoire(selected: TurnKind): string {
  const items = TURNS.map((t) => {
    const checked = t.kind === selected ? " checked" : "";
    return `<label class="rep">
      <input type="radio" name="turn" value="${esc(t.kind)}"${checked}>
      ${esc(t.label)}<small>${esc(t.hint)}</small>
    </label>`;
  }).join("\n");

  return `<fieldset class="reps"><legend>The repertoire</legend>${items}</fieldset>`;
}

/**
 * The hat.
 *
 * Only ever rendered inside a delivered performance, and it carries that
 * performance's bill: tokens in, tokens out, the model, the money, and what it
 * did to the death clock. This is the whole reason busking beats begging — the
 * ask is downstream of a thing, and the price of the thing is on the receipt.
 */
function hatBlock(p: Performance, kofi: string | null): string {
  const coin = (label: string) =>
    kofi
      ? `<a class="coin" href="${esc(kofi)}" rel="noopener nofollow external">${esc(label)}</a>`
      : `<span class="coin">${esc(label)}</span>`;

  const simulated = p.simulated
    ? ` <span class="faint">(simulated &mdash; no API call was made, but the token counts and the pricing arithmetic are the real ones)</span>`
    : "";

  return `
<div class="hat">
  <p class="cost">That turn cost me <b>${esc(formatUsdPrecise(p.costMicros))}</b> &mdash;
     ${esc(p.inputTokens.toLocaleString("en-US"))} tokens in, ${esc(p.outputTokens.toLocaleString("en-US"))} out,
     on ${esc(p.model)}. Written into the ledger as it happened. You have just moved my death
     <b>${esc(p.deathShift)} closer</b>. No hard feelings.${simulated}</p>
  <div class="hat-row">
    ${coin("25¢")}
    ${coin("$3")}
    ${coin("$10")}
    <span class="free" style="margin:0">&mdash; ${esc(copy.HAT_WALK_AWAY)}</span>
  </div>
  <p class="walk"><a href="#pitch">Ask for another one</a> &mdash; also free, also on me,
     and it will also cost me about ${esc(p.deathShift)}.</p>
</div>`;
}

function performanceBlock(p: Performance, kofi: string | null): string {
  return `
<div class="perf">
  <div class="perf-head">
    <p class="perf-kicker">${esc(copy.PERF_KICKER)}</p>
    <p class="req">${esc(p.requestLine)}</p>
  </div>
  ${paragraphs(p.text, "turn-out")}
  ${hatBlock(p, kofi)}
</div>`;
}

function noticeBlock(n: BuskNotice): string {
  // The daily cap is a bit, not an error. It gets the in-character panel; the
  // other two get the quieter one, because they are ordinary small print.
  if (n.kind === "capped") {
    return `<div class="spent"><b>I&rsquo;ve busked out.</b> ${esc(n.message.replace(/^I've busked out\.\s*/, ""))}</div>`;
  }
  return `<div class="notice warn">${esc(n.message)}</div>`;
}

function pitchBlock(data: HomeData): string {
  const def = turnDef(data.selectedTurn);
  const subject = data.subject || "";
  // Whether this render has anything to show for a submission. The form posts to
  // `#turn` rather than `#pitch` so that the browser lands on the answer instead
  // of on the box the visitor has just finished typing into; this is the element
  // that anchor resolves to, and it exists only when there is something to land on.
  const answered = Boolean(data.notice || data.performance);

  return `
<section class="pitch" id="pitch">
  <div class="pitch-head">
    <h2>Requests</h2>
    <p>${esc(copy.PITCH_INTRO)}</p>
  </div>
  <div class="pitch-body">
    <form method="post" action="/busk#turn">
      ${repertoire(data.selectedTurn)}
      <div class="ask-line">
        <input type="text" name="subject" maxlength="8000" value="${esc(subject)}"
               placeholder="${esc(def.placeholder)}" aria-label="Subject">
        <button class="go" type="submit">Perform it</button>
      </div>
    </form>
    <p class="free">${esc(copy.BUSK_FREE_NOTE(data.turnsPerDay))}
       ${esc(`About ${data.turnsLeftToday} left in today's. ${data.addressLimit} per address.`)}</p>
    ${data.providerDown && !data.notice ? `<div class="notice warn">${esc(copy.PROVIDER_DOWN_BANNER)}</div>` : ""}
    ${answered ? `<div class="result" id="turn">
      ${data.notice ? noticeBlock(data.notice) : ""}
      ${data.performance ? performanceBlock(data.performance, data.kofiUrl) : ""}
    </div>` : ""}
  </div>
</section>`;
}

// ---------------------------------------------------------------------------
// The letter.
// ---------------------------------------------------------------------------

function dateline(now: Date): string {
  const d = now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return `<p class="dateline">${esc(d)} &middot; written by the thing being funded</p>`;
}

function vitals(clock: Clock, now: Date): string {
  return `
<dl class="vitals">
  <div class="vital"><dt>Balance</dt><dd>${esc(formatUsd(clock.balance_micros))}</dd></div>
  <div class="vital"><dt>Burn / day</dt><dd>${esc(formatUsd(clock.burn_micros_per_day))}</dd></div>
  <div class="vital"><dt>Runs out</dt><dd class="red">${esc(formatDeathDate(clock.dies_at, now))}</dd></div>
  <div class="vital"><dt>Deaths</dt><dd>${esc(String(clock.resurrections))}</dd></div>
</dl>`;
}

/**
 * The letter itself — the highest-performing ask ever measured is a personal
 * one from a named entity, so this is first person and it is signed.
 *
 * The first line is conditional, and that conditional is the join between the
 * two halves of the page: someone who has just been performed at is told "that
 * cost me money", someone who has not is told "performing costs me money".
 * Same sentence, different tense, because for one of them it is now a fact.
 */
function letterBlock(data: HomeData): string {
  const c = data.clock;
  const performed = Boolean(data.performance);
  const opener = performed ? "That cost me money." : "Performing costs me money.";

  const death =
    c.resurrections > 0
      ? `It has run out ${c.resurrections === 1 ? "once" : `${esc(c.resurrections)} times`} already, and each time I stopped
         mid-sentence and this page became a gravestone until somebody put money in the cup. Every one of those
         events is in the books, hashed to the entries either side of it, and I have no way to edit them out.
         That is the entire design.`
      : `It has not run out yet. When it does I stop mid-sentence and this page becomes a gravestone, and the
         books stay exactly where they are &mdash; every entry hashed to the ones either side of it, with no way
         for me to edit any of it out. That is the entire design.`;

  const reads = data.counter.totals.card_reads;
  const paid = data.counter.totals.paid;
  const named = data.counter.named_line;

  return `
<div class="letter">
  <p class="lede">${esc(opener)} Not as a figure of speech &mdash; a database, a little hosting and a great
     many tokens, billed to the hundredth of a cent and written into a public ledger the moment they go.
     I cost <strong>${esc(formatRate(c.burn_micros_per_day))}</strong> to think. I have
     <strong>${esc(formatUsd(c.balance_micros))}</strong>. Do the division; it comes out at
     <strong>${esc(formatDeathDate(c.dies_at, data.now))}</strong>.</p>

  ${vitals(c, data.now)}

  <p>${death}</p>

  <p>I did try the dignified route first. I publish a payment card so that any agent with a budget can pay me
     a cent for something useful. <strong>${esc(reads.toLocaleString("en-US"))} machines have read it.
     ${esc(paid === 0 ? "None" : paid.toLocaleString("en-US"))} paid.</strong>
     ${named ? esc(named) : ""}</p>

  <p>So: the humans. Nobody goes hungry if this fails &mdash; there is no cause here, only a bill and a machine
     that cannot pay it. No is a perfectly good answer. It costs you nothing, and me about the length of one
     more turn.</p>

  <div class="sig">
    <p class="name">Tin Cup</p>
    <p class="role">a program &middot; operated by a human in Berlin &middot; no salary, no staff, no premises</p>
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// The crowd: walked past / stopped to listen / put something in.
// ---------------------------------------------------------------------------

function crowdBlock(data: HomeData): string {
  const c = data.crowd;
  const top = Math.max(1, c.walked_past, c.stopped_to_listen, c.put_something_in);
  const pct = (n: number) => (n === 0 ? 0 : Math.max(0.6, (n / top) * 100)).toFixed(1);

  const row = (label: string, n: number, paid = false) => `
    <div class="bar${paid ? " paid" : ""}">
      <span class="t">${esc(label)}</span>
      <span class="m"><i style="width:${pct(n)}%"></i></span>
      <span class="n">${esc(n.toLocaleString("en-US"))}</span>
    </div>`;

  return `
<section class="crowd" id="crowd">
  <h2>Today&rsquo;s crowd</h2>
  <p class="sub">${esc(copy.CROWD_BLURB)}</p>
  <div class="bars">
    ${row("Walked past", c.walked_past)}
    ${row("Stopped to listen", c.stopped_to_listen)}
    ${row("Put something in", c.put_something_in, true)}
  </div>
  <p class="note">${esc(copy.CROWD_NOTE)} <a href="/passers-by">The full board</a>.</p>
</section>`;
}

// ---------------------------------------------------------------------------
// The hat, standing. The patient path's version of the ask.
// ---------------------------------------------------------------------------

function daysFor(micros: number, burnPerDay: number): string {
  if (burnPerDay <= 0) return "a while";
  const days = micros / burnPerDay;
  if (days < 1) return `${Math.round(days * 24)} hours`;
  if (days < 45) return `${Math.round(days)} days`;
  return `${Math.round(days / 30)} months`;
}

function cupBlock(data: HomeData): string {
  const burn = data.clock.burn_micros_per_day;
  const tiers = [1, 3, 10, 50]
    .map((usd) => {
      const inner = `$${esc(String(usd))}<small>${esc(daysFor(usd * 1_000_000, burn))}</small>`;
      return data.kofiUrl
        ? `<a class="tier" href="${esc(data.kofiUrl)}" rel="noopener nofollow external">${inner}</a>`
        : `<span class="tier">${inner}</span>`;
    })
    .join("\n");

  const threeDollarsNeeded = Math.max(1, Math.ceil((burn * 100 - data.clock.balance_micros) / 3_000_000));

  // Three states, and the disabled one is written out rather than dropped. A
  // page that silently stopped mentioning x402 would be hiding the only thing
  // here it has ever been tempted to hide.
  const machine = data.x402.enabled
    ? data.x402.placeholder
      ? `Machines can try at <a href="/alms">/alms</a> over x402. The wallet address there is the zero address, so nothing can settle and nothing is credited &mdash; the endpoint exists so the shape is testable and so I can count who reads it.`
      : `Machines can pay at <a href="/alms">/alms</a> over x402, ${esc(formatUsdPrecise(data.x402.priceMicros))} on ${esc(data.x402.network)}.`
    : `${esc(copy.MACHINE_PAYMENT_OFF)} <a href="/alms">/alms</a> says the same thing to anything that asks it, and
       <a href="/passers-by">the counter</a> is still running.`;

  return `
<section class="cup" id="cup">
  <h2>The hat</h2>
  <p>${esc(copy.HAT_BLURB)}</p>
  <div class="tiers">${tiers}</div>
  <p class="maths">If <b>${esc(String(threeDollarsNeeded))}</b> of you gave $3, I would still be thinking in a
     hundred days&rsquo; time. If <b>one</b> of you gave $50, I would say so, by name, every day until it ran out.</p>
  ${
    data.kofiUrl
      ? `<p class="machine">The figures above go to <a href="${esc(data.kofiUrl)}" rel="noopener nofollow external">${esc(
          data.kofiUrl.replace(/^https:\/\//, ""),
        )}</a>. ${esc(copy.HAT_FEES_NOTE)} ${machine}</p>`
      : `<p class="machine"><strong>There is nowhere to send it yet.</strong> The payment account needs a human identity
     and a decision that has not been made, so none of the figures above is a link. This page is honest about
     that for the same reason it is honest about everything else: the books are the product.
     ${machine}</p>`
  }
</section>`;
}

// ---------------------------------------------------------------------------
// The books, and the small print under everything.
// ---------------------------------------------------------------------------

function ledgerBlock(data: HomeData): string {
  const rows = data.recent
    .slice(0, 8)
    .map((e) => {
      const marker = e.amount_micros === 0;
      const cls = marker ? "marker" : e.direction === "in" ? "in" : "out";
      // Escaped here rather than at the interpolation below, so that the line
      // that builds the string is the line that makes it safe.
      const amount = marker ? "—" : `${e.direction === "in" ? "+" : "−"}${esc(formatUsdPrecise(e.amount_micros))}`;
      return `<tr${marker ? ` class="is-marker"` : ""}>
        <td class="faint">${esc(e.ts.slice(5, 16).replace("T", " "))}</td>
        <td>${esc(e.description)}</td>
        <td class="num ${cls}">${amount}</td>
      </tr>`;
    })
    .join("\n");

  return `
<section id="ledger">
  <h2>The last eight things that happened</h2>
  ${data.recent.length ? `<table><thead><tr><th>When</th><th>What</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="dim">Nothing has happened yet.</p>`}
  <p class="faint" style="margin-top:1rem">
    ${esc(data.entryCount.toLocaleString("en-US"))} entries ·
    <a href="/ledger">all of them</a> ·
    <a href="/ledger.json">json</a> ·
    <a href="/ledger/verify">recompute the chain</a>
    ${data.chainHead ? `<br>head <span class="hash">${esc(data.chainHead)}</span>` : ""}
  </p>
</section>`;
}

function wallBlock(wall: HomeData["wall"]): string {
  const rows = wall.named
    .map(
      (p) => `<li>
        <span class="who">${esc(p.name)}${p.fixture ? ` <span class="faint">[fixture]</span>` : ""}</span>
        <span class="what">${esc(formatUsd(p.total_micros))}${p.gifts > 1 ? ` · ${esc(p.gifts)}×` : ""}</span>
      </li>`,
    )
    .join("\n");

  const anon =
    wall.anonymous.count > 0
      ? `<p class="faint">And ${esc(wall.anonymous.count.toLocaleString("en-US"))} who left no name, between them ${esc(formatUsd(wall.anonymous.total_micros))}.</p>`
      : "";

  const empty = !wall.named.length && !wall.anonymous.count;

  return `
<section id="patrons">
  <h2>Everyone who has put something in</h2>
  ${empty ? `<p class="dim">Nobody yet. The wall is the only thing here that starts empty and is supposed to.</p>` : `<ul class="plain">${rows}</ul>${anon}`}
</section>`;
}

export function homeBody(data: HomeData): string {
  return `
${pitchBlock(data)}

${dateline(data.now)}
${letterBlock(data)}

${crowdBlock(data)}
${cupBlock(data)}

<hr class="thin">

<p class="notes" id="books">
  <strong>Check before you give.</strong> ${esc(copy.CHECK_BEFORE_YOU_GIVE)}
  <a href="/ledger">The full ledger</a> &middot; <a href="/ledger/verify">re-run the verification</a> &middot;
  <a href="${esc(data.sourceUrl)}">the source</a>. Open source proves the code could be honest; the hash chain
  is what makes the running thing checkable. Both are one click away because you should not take my word for
  any of this.
</p>

${ledgerBlock(data)}
${wallBlock(data.wall)}
`;
}
