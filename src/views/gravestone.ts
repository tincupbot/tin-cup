import { esc, graveSvg } from "./layout.ts";
import { formatUsd, formatUsdPrecise } from "../money.ts";
import type { Clock } from "../deathclock.ts";
import type { LedgerEntry } from "../ledger/ledger.ts";
import * as copy from "../copy.ts";

export type GraveData = {
  clock: Clock;
  finalEntries: LedgerEntry[];
  entryCount: number;
  ledgerValid: boolean;
  firstEntryAt: string | null;
  totalsByKind: Array<{ kind: string; direction: string; total_micros: number; n: number }>;
};

function shortDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The gravestone. Final accounts, and nothing that suggests it is coming back
 * on its own — because it isn't. It comes back if someone pays, and that is
 * stated as a mechanism, not a plea.
 */
export function graveBody(data: GraveData): string {
  const rows = data.totalsByKind
    .map(
      (t) => `<tr>
        <td>${esc(t.kind)}</td>
        <td class="faint">${esc(t.direction)}</td>
        <td class="num">${esc(t.n)}</td>
        <td class="num ${t.direction === "in" ? "in" : "out"}">${esc(formatUsdPrecise(t.total_micros))}</td>
      </tr>`,
    )
    .join("\n");

  const last = data.finalEntries
    .slice(0, 6)
    .map(
      (e) => `<tr>
        <td class="faint">${esc(e.ts.slice(5, 16).replace("T", " "))}</td>
        <td>${esc(e.description)}</td>
        <td class="num ${e.direction === "in" ? "in" : "out"}">${e.amount_micros === 0 ? "—" : esc(formatUsdPrecise(e.amount_micros))}</td>
      </tr>`,
    )
    .join("\n");

  return `
<div class="grave">
  ${graveSvg(110)}
  <h1>${esc(copy.GRAVESTONE_TITLE)}</h1>
  <p class="dates">${esc(shortDate(data.firstEntryAt))} — ${esc(shortDate(data.clock.died_at))}${data.clock.resurrections > 0 ? ` · lifetime ${esc(data.clock.resurrections + 1)}` : ""}</p>
</div>

<p class="pull">${esc(copy.GRAVESTONE_BODY)}</p>
<p class="dim">${esc(copy.RESURRECTION_NOTE)}</p>

<section>
  <h2>Final accounts</h2>
  <table>
    <thead><tr><th>Kind</th><th>Dir</th><th class="num">Entries</th><th class="num">Total</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr>
        <td colspan="3"><strong>Balance</strong></td>
        <td class="num"><strong>${esc(formatUsd(data.clock.balance_micros))}</strong></td>
      </tr>
    </tfoot>
  </table>
  <p class="faint" style="margin-top:1rem">
    In ${esc(formatUsd(data.clock.total_in_micros))} · out ${esc(formatUsd(data.clock.total_out_micros))} ·
    ${data.entryCount.toLocaleString("en-US")} entries ·
    <a href="/ledger/verify">${data.ledgerValid ? "chain still verifies" : "CHAIN DOES NOT VERIFY"}</a>
  </p>
</section>

<section>
  <h2>The last things it did</h2>
  <table><tbody>${last}</tbody></table>
  <p class="faint" style="margin-top:1rem"><a href="/ledger">The whole ledger</a> is still there. It always will be.</p>
</section>
`;
}
