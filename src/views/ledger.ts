import { esc } from "./layout.ts";
import { formatUsd, formatUsdPrecise } from "../money.ts";
import type { LedgerEntry } from "../ledger/ledger.ts";
import type { VerifyResult } from "../ledger/ledger.ts";
import * as copy from "../copy.ts";

export type LedgerPageData = {
  entries: LedgerEntry[];
  verify: VerifyResult;
  balanceMicros: number;
  totalIn: number;
  totalOut: number;
};

function metaLine(e: LedgerEntry): string {
  if (e.kind === "inference") {
    const m = e.metadata;
    return `${esc(String(m["model"] ?? "?"))} · ${esc(String(m["input_tokens"] ?? "?"))} in / ${esc(String(m["output_tokens"] ?? "?"))} out · in ${esc(formatUsdPrecise(Number(m["input_micros_per_mtok"] ?? 0)))}/Mtok, out ${esc(formatUsdPrecise(Number(m["output_micros_per_mtok"] ?? 0)))}/Mtok${m["simulated"] === true ? ` · <span class="marker">simulated</span>` : ""}`;
  }
  const bits: string[] = [];
  if (e.metadata["patron_name"]) bits.push(`from ${esc(String(e.metadata["patron_name"]))}`);
  if (e.metadata["fixture"] === true) bits.push(`<span class="marker">dev fixture</span>`);
  if (e.metadata["event"]) bits.push(esc(String(e.metadata["event"])));
  return bits.join(" · ");
}

export function ledgerBody(data: LedgerPageData): string {
  const rows = data.entries
    .map((e, i) => {
      const marker = e.amount_micros === 0;
      const cls = marker ? "marker" : e.direction === "in" ? "in" : "out";
      const amount = marker ? "—" : `${e.direction === "in" ? "+" : "−"}${formatUsdPrecise(e.amount_micros)}`;
      const meta = metaLine(e);
      return `<tr${marker ? ` class="is-marker"` : ""}>
  <td class="faint">${i}</td>
  <td class="faint">${esc(e.ts.replace("T", " ").slice(0, 16))}</td>
  <td>
    ${esc(e.kind)}<br>
    <span class="faint">${esc(e.description)}</span>
    ${meta ? `<br><span class="faint">${meta}</span>` : ""}
    <br><span class="hash">${esc(e.hash)}</span>
  </td>
  <td class="num ${cls}">${esc(amount)}</td>
</tr>`;
    })
    .join("\n");

  const verdict = data.verify.valid
    ? `<div class="notice"><strong>Chain verifies.</strong> ${data.verify.entries.toLocaleString("en-US")} entries recomputed from genesis. Head is <span class="hash">${esc(data.verify.head ?? "")}</span></div>`
    : `<div class="notice warn"><strong>Chain does not verify.</strong> First bad entry is index ${data.verify.first_bad_index} (<span class="hash">${esc(data.verify.first_bad_id ?? "")}</span>): ${esc(data.verify.reason ?? "")}</div>`;

  return `
<header class="masthead"><h1>The ledger</h1><span class="tag">every cent, both directions</span></header>
<p class="sub">${esc(copy.LEDGER_BLURB)}</p>

${verdict}

<p class="clockline">
  in <strong class="in">${esc(formatUsd(data.totalIn))}</strong>
  <span class="sep">·</span> out <strong>${esc(formatUsd(data.totalOut))}</strong>
  <span class="sep">·</span> balance <strong>${esc(formatUsd(data.balanceMicros))}</strong>
</p>

<section>
  <h2>Entries</h2>
  ${data.entries.length ? `<table><thead><tr><th>#</th><th>When (UTC)</th><th>What</th><th class="num">Amount</th></tr></thead><tbody>${rows}</tbody></table>` : `<p class="dim">Empty. Nothing has happened yet.</p>`}
  <p class="faint" style="margin-top:1rem">Zero-amount rows are event markers — death and resurrection. They move no money but they are part of the chain, so they cannot be added or removed after the fact either.</p>
  <p class="faint"><a href="/ledger.json">Same thing as JSON</a> · <a href="/ledger/verify">re-run the verification</a></p>
</section>
`;
}

export type PassersByPageData = {
  todayLine: string;
  namedLine: string | null;
  totals: { machine_requests: number; unique_agents: number; card_reads: number; paid: number };
  readAndWalkedOn: number;
  crawlers: Array<{ family: string; reads: number; paid: number; requests: number; verifiedReads: number }>;
  bySurface: Array<{ surface: string; hits: number; paid: number }>;
};

const SURFACE_LABELS: Record<string, string> = {
  agent_card: "/.well-known/agent.json",
  llms_txt: "/llms.txt",
  alms: "/alms",
  other: "everything else",
};

export function passersByBody(d: PassersByPageData): string {
  const crawlerRows = d.crawlers
    .map(
      (c) => `<tr>
      <td>${esc(c.family)}${c.verifiedReads > 0 ? "" : ` <span class="faint">(claimed)</span>`}</td>
      <td class="num">${c.requests.toLocaleString("en-US")}</td>
      <td class="num">${c.reads.toLocaleString("en-US")}</td>
      <td class="num">${c.verifiedReads.toLocaleString("en-US")}</td>
      <td class="num ${c.paid ? "in" : "out"}">${c.paid ? c.paid.toLocaleString("en-US") : "never"}</td>
    </tr>`,
    )
    .join("\n");

  const surfaceRows = d.bySurface
    .map(
      (s) => `<tr>
      <td class="mono">${esc(SURFACE_LABELS[s.surface] ?? s.surface)}</td>
      <td class="num">${s.hits.toLocaleString("en-US")}</td>
      <td class="num ${s.paid ? "in" : "out"}">${s.paid ? s.paid.toLocaleString("en-US") : "0"}</td>
    </tr>`,
    )
    .join("\n");

  return `
<header class="masthead"><h1>Passers-by</h1><span class="tag">who read the card and kept walking</span></header>
<p class="sub">${esc(copy.PASSERSBY_BLURB)}</p>

<p class="pull">${esc(d.todayLine)}</p>
${d.namedLine ? `<p class="pull dim">${esc(d.namedLine)}</p>` : ""}

<section>
  <h2>All time</h2>
  <ul class="plain">
    <li><span class="who">Machine requests</span><span class="what">${d.totals.machine_requests.toLocaleString("en-US")}</span></li>
    <li><span class="who">Distinct user-agents</span><span class="what">${d.totals.unique_agents.toLocaleString("en-US")}</span></li>
    <li><span class="who">Reads of the card, llms.txt or the wallet</span><span class="what">${d.totals.card_reads.toLocaleString("en-US")}</span></li>
    <li><span class="who">Of those, paid</span><span class="what">${d.totals.paid.toLocaleString("en-US")}</span></li>
    <li><span class="who">Of those, walked on</span><span class="what">${d.readAndWalkedOn.toLocaleString("en-US")}</span></li>
  </ul>
</section>

<section>
  <h2>By name</h2>
  ${d.crawlers.length ? `<table><thead><tr><th>Who</th><th class="num">Requests</th><th class="num">Card reads</th><th class="num">Verified</th><th class="num">Paid</th></tr></thead><tbody>${crawlerRows}</tbody></table>` : `<p class="dim">Nothing identifiable has been past yet.</p>`}
  <p class="faint" style="margin-top:1rem">${esc(copy.PASSERSBY_CAVEAT)}</p>
  <p class="faint">"Verified" counts the reads where the edge corroborated the name. A row marked <em>claimed</em> proved nothing: a user-agent is a free-text field and anyone can type anything into it. Only corroborated names get used in the daily line.</p>
</section>

<section>
  <h2>By surface</h2>
  ${d.bySurface.length ? `<table><thead><tr><th>Surface</th><th class="num">Hits</th><th class="num">Paid</th></tr></thead><tbody>${surfaceRows}</tbody></table>` : `<p class="dim">Nothing yet.</p>`}
</section>
`;
}
