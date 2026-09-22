/**
 * All CSS, inlined into every page.
 *
 * No build step, no framework, and — deliberately — not one byte of client-side
 * JavaScript anywhere on the site. That is what lets the Content-Security-Policy
 * stay at `default-src 'none'`: there is no script to allow.
 *
 * The palette is the approved "busker" direction: newsprint, not a dashboard.
 * Paper, a double rule under the banner, a serif for the voice and a monospace
 * for the money. The money is always monospace. It should read like an
 * instrument, not like a pitch. The one saturated colour in the whole document
 * is the maroon, and it is spent only on the ask and on the cost of a turn.
 */
export const STYLES = /* css */ `
:root {
  --paper: #faf7f1;
  --paper-2: #f3efe5;
  --paper-3: #ece6d8;
  --rule: #ddd6c6;
  --rule-2: #c9c0ab;
  --ink: #1b1a17;
  --ink-2: #4a473f;
  --ink-3: #817c6f;
  --red: #9c2b22;
  --red-dark: #7c1f18;
  --brass: #8a6d1f;
  --alive: #3f6b35;
  --dead: #9c2b22;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}

*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--paper);
  color: var(--ink);
  font-family: var(--serif);
  font-size: 19px;
  line-height: 1.7;
  -webkit-font-smoothing: antialiased;
}

.wrap { max-width: 44rem; margin: 0 auto; padding: 2.8rem 1.5rem 5rem; }
@media (max-width: 34rem) { .wrap { padding: 2rem 1.15rem 3.5rem; } body { font-size: 18px; } }

a { color: var(--ink); text-decoration-color: var(--rule-2); text-underline-offset: 3px; }
a:hover { color: var(--red); text-decoration-color: var(--red); }

h1, h2, h3 { font-weight: 600; line-height: 1.3; letter-spacing: -0.01em; }

p { margin: 0 0 1.1rem; }
.dim { color: var(--ink-2); }
.faint { color: var(--ink-3); font-size: 0.86rem; }
.pull { font-size: 1.16rem; line-height: 1.55; margin: 0 0 0.9rem; }
hr.thin { border: 0; border-top: 1px solid var(--rule); margin: 2.6rem 0; }

blockquote { margin: 0; padding-left: 1.1rem; border-left: 2px solid var(--rule-2); color: var(--ink-2); }

/* ---- the fixture banner ------------------------------------------------ */

.fixture-banner {
  font-family: var(--mono);
  font-size: 0.72rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  text-align: center;
  background: #241a17;
  color: #e8c9c4;
  padding: 0.5rem 1rem;
}

/* ---- the appeal banner ------------------------------------------------- */

.banner { border-bottom: 3px double var(--rule-2); background: var(--paper-2); }
.banner-in {
  max-width: 56rem; margin: 0 auto; padding: 1.5rem 1.5rem 1.4rem;
  display: grid; grid-template-columns: auto 1fr; gap: 1.4rem; align-items: start;
}
/* The portrait. A drawing, in a frame, on the paper — the one image the site
   has, so it is hung rather than floated: thin rule, off-white mount, and the
   ink-coloured backing that every other bordered thing here uses. */
.portrait {
  width: 128px; height: 128px; display: block;
  border: 1px solid var(--rule-2); background: var(--paper);
  padding: 0.3rem; object-fit: contain;
}
.banner h1 { margin: 0 0 0.35rem; font-size: 1.24rem; font-weight: 600; }
.banner p { margin: 0; font-size: 0.98rem; color: var(--ink-2); line-height: 1.55; }
.banner .row { margin-top: 0.95rem; display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
.banner .fine {
  font-family: var(--mono); font-size: 0.7rem; color: var(--ink-3);
  margin-top: 0.7rem; letter-spacing: 0.02em;
}

.pill {
  font-family: var(--mono); font-size: 0.82rem; padding: 0.5rem 0.95rem;
  border: 1px solid var(--rule-2); background: var(--paper); color: var(--ink); text-decoration: none;
}
.pill:hover { border-color: var(--red); color: var(--red); }
.pill.now { background: var(--red); border-color: var(--red); color: #fff; letter-spacing: 0.04em; }
.pill.now:hover { background: var(--red-dark); border-color: var(--red-dark); color: #fff; }

/* ---- the pitch --------------------------------------------------------- */

.pitch { border: 1px solid var(--rule-2); background: var(--paper-2); margin: 0 0 3.2rem; }
.pitch-head { padding: 1.4rem 1.6rem 1.1rem; border-bottom: 1px solid var(--rule); }
.pitch-head h2 { margin: 0 0 0.35rem; font-size: 1.16rem; font-weight: 600; }
.pitch-head p { margin: 0; font-size: 0.95rem; color: var(--ink-2); line-height: 1.55; }
.pitch-body { padding: 1.3rem 1.6rem 1.6rem; }

/* The repertoire. Radio inputs, not buttons: the whole page has no JavaScript,
   so "which turn" has to survive a plain form POST. The input itself is hidden
   and the label is the control, which keeps the keyboard and screen-reader
   behaviour of a real radio group. */
.reps { display: grid; grid-template-columns: repeat(2, 1fr); gap: 0.5rem; margin: 0 0 1rem; border: 0; padding: 0; }
.reps legend { padding: 0; margin: 0 0 0.55rem; font-family: var(--mono); font-size: 0.62rem;
  letter-spacing: 0.13em; text-transform: uppercase; color: var(--ink-3); }
.rep { display: block; border: 1px solid var(--rule-2); background: var(--paper); padding: 0.7rem 0.85rem;
  cursor: pointer; font-size: 0.95rem; color: var(--ink); line-height: 1.35; }
.rep small { display: block; font-family: var(--mono); font-size: 0.62rem; letter-spacing: 0.09em;
  text-transform: uppercase; color: var(--ink-3); margin-top: 0.28rem; }
.rep:hover { border-color: var(--ink-3); }
.rep input { position: absolute; opacity: 0; width: 0; height: 0; }
.rep:has(input:checked) { border-color: var(--red); border-width: 2px; color: var(--red);
  padding: calc(0.7rem - 1px) calc(0.85rem - 1px); }
.rep:has(input:checked) small { color: var(--red); opacity: 0.72; }
.rep:has(input:focus-visible) { outline: 2px solid var(--ink); outline-offset: 2px; }

.ask-line { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.ask-line input[type="text"] {
  flex: 1 1 14rem; width: auto; font-family: var(--serif); font-size: 1rem; padding: 0.7rem 0.8rem;
  border: 1px solid var(--rule-2); background: var(--paper); color: var(--ink);
}
.ask-line input[type="text"]:focus { outline: 2px solid var(--ink); outline-offset: -1px; border-color: var(--ink); }
.go {
  font-family: var(--mono); font-size: 0.85rem; letter-spacing: 0.04em; padding: 0.7rem 1.15rem;
  border: 1px solid var(--red); background: var(--red); color: #fff; cursor: pointer; margin: 0;
}
.go:hover { background: var(--red-dark); border-color: var(--red-dark); }
.free { font-family: var(--mono); font-size: 0.7rem; color: var(--ink-3); margin: 0.85rem 0 0; letter-spacing: 0.02em; }
/* The sign-off under the pitch. Serif and italic so it reads as the busker
   talking rather than as more small print stacked under the small print. */
.welcome { margin: 0.55rem 0 0; font-size: 0.9rem; font-style: italic; color: var(--ink-3); }

/* ---- a performance, and the hat that follows it ------------------------ */

/* The answer to a submission, whether that is a turn or a refusal.
   A busk is a form POST: the page the visitor gets back is the page they
   submitted from, so nothing about the layout tells them anything happened.
   This wrapper is the anchor the form targets, and everything in it is styled
   to look like it arrived rather than like it was always there. */
.result { scroll-margin-top: 1.2rem; }

@media (prefers-reduced-motion: no-preference) {
  .result { animation: arrive 420ms cubic-bezier(0.2, 0.7, 0.3, 1) both; }
}
@keyframes arrive {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: none; }
}

/* Its own paper, its own border, and a rule in the one saturated colour the
   document owns — so it reads as a delivered object and not as the tail of the
   form above it. */
.perf { margin: 1.5rem 0 0; border: 1px solid var(--rule-2); border-top: 3px solid var(--red);
  background: var(--paper); padding: 1.35rem 1.5rem 1.5rem; }
.perf-head { margin: 0 0 1.15rem; padding: 0 0 0.9rem; border-bottom: 1px solid var(--rule); }
.perf-kicker { font-family: var(--mono); font-size: 0.62rem; letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--red); margin: 0 0 0.4rem; }
.perf .req { font-family: var(--serif); font-size: 1.3rem; line-height: 1.28; font-weight: 600;
  letter-spacing: 0; text-transform: none; color: var(--ink); margin: 0; }
/* The turn itself is the product. It gets the largest body type on the page. */
.turn-out { margin: 0 0 1.15rem; font-size: 1.16rem; line-height: 1.66; color: var(--ink); }
.turn-out:last-child { margin-bottom: 0; }

/* The hat only ever renders underneath a delivered turn. That is the whole
   argument of the design: the ask is downstream of the thing, and it carries
   the thing's price. */
.hat { margin: 1.5rem 0 0; border: 1px solid var(--rule-2); background: var(--paper-3); padding: 1.15rem 1.25rem; }
.hat .cost { font-family: var(--mono); font-size: 0.8rem; color: var(--ink-2); margin: 0 0 0.85rem; line-height: 1.6; }
.hat .cost b { color: var(--red); font-weight: 600; }
.hat-row { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
.coin { font-family: var(--mono); font-size: 0.92rem; padding: 0.55rem 1rem; border: 1px solid var(--rule-2);
  background: var(--paper); color: var(--ink); text-decoration: none; }
.coin:hover { border-color: var(--red); color: var(--red); }
.hat .walk { font-family: var(--mono); font-size: 0.72rem; color: var(--ink-3); margin: 0.85rem 0 0; }
.hat .walk a { color: var(--ink-3); }

.spent { border: 1px dashed var(--rule-2); background: var(--paper); padding: 1.1rem 1.25rem;
  margin: 1.4rem 0 0; font-size: 0.95rem; color: var(--ink-2); }
.spent b { color: var(--ink); }

/* ---- the letter -------------------------------------------------------- */

.dateline { font-family: var(--mono); font-size: 0.72rem; letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--ink-3); margin: 0 0 1.9rem; }
.letter { max-width: 38rem; }
.letter p { margin: 0 0 1.35rem; }
.letter p.lede { font-size: 1.16rem; line-height: 1.6; }
.letter p.lede::first-letter { float: left; font-size: 3.35rem; line-height: 0.82; padding: 0.13em 0.1em 0 0; font-weight: 600; }
.sig { margin-top: 2.3rem; padding-top: 1.4rem; border-top: 1px solid var(--rule); }
.sig .name { font-size: 1.3rem; margin: 0; }
.sig .role { font-family: var(--mono); font-size: 0.76rem; color: var(--ink-3); letter-spacing: 0.06em; margin: 0.2rem 0 0; }

/* ---- vitals ------------------------------------------------------------ */

.vitals { margin: 2.4rem 0; border-top: 1px solid var(--rule-2); border-bottom: 1px solid var(--rule-2);
  display: grid; grid-template-columns: repeat(4, 1fr); background: var(--paper-2); }
.vital { padding: 0.95rem 0.8rem; border-right: 1px solid var(--rule); }
.vital:last-child { border-right: 0; }
.vital dt { font-family: var(--mono); font-size: 0.62rem; letter-spacing: 0.13em; text-transform: uppercase;
  color: var(--ink-3); margin: 0 0 0.25rem; }
.vital dd { margin: 0; font-family: var(--mono); font-size: 1.02rem; font-variant-numeric: tabular-nums; }
.vital dd.red { color: var(--red); }
/* The aside under the four numbers. Pulled up tight against the rule so it
   hangs off the table rather than starting a new paragraph. */
.quip { margin: -2rem 0 2.4rem; font-size: 0.92rem; font-style: italic; color: var(--ink-3); }

/* ---- the crowd --------------------------------------------------------- */

.crowd { margin: 2.8rem 0 0; border: 1px solid var(--rule-2); background: var(--paper-2); padding: 1.5rem 1.6rem; }
.crowd h2 { margin: 0 0 0.3rem; font-size: 1.06rem; font-weight: 600; border: 0; padding: 0;
  text-transform: none; letter-spacing: -0.01em; font-family: var(--serif); color: var(--ink); }
.crowd .sub { margin: 0 0 1.15rem; font-size: 0.92rem; color: var(--ink-2); }
/* Only rendered on a day the third bar is zero. */
.crowd .tough { font-style: italic; color: var(--ink-3); font-weight: 400; }
.bars { display: grid; gap: 0.6rem; font-family: var(--mono); font-size: 0.78rem; }
.bar { display: grid; grid-template-columns: 9.5rem 1fr auto; gap: 0.7rem; align-items: center; }
.bar .t { color: var(--ink-2); }
.bar .m { height: 11px; background: var(--paper); border: 1px solid var(--rule-2); }
.bar .m i { display: block; height: 100%; background: var(--ink-3); }
.bar.paid .m i { background: var(--red); }
.bar .n { font-variant-numeric: tabular-nums; }
.crowd .note { margin: 1.1rem 0 0; font-size: 0.88rem; color: var(--ink-3); line-height: 1.6; }

/* ---- the hat, standing ------------------------------------------------- */

.cup { margin: 3rem 0 0; border: 1px solid var(--rule-2); background: var(--paper-2); padding: 1.9rem 1.7rem; }
.cup h2 { margin: 0 0 0.6rem; font-size: 1.1rem; font-weight: 600; border: 0; padding: 0;
  text-transform: none; letter-spacing: -0.01em; font-family: var(--serif); color: var(--ink); }
.cup p { margin: 0 0 1.3rem; font-size: 0.99rem; color: var(--ink-2); }
.tiers { display: flex; gap: 0.55rem; flex-wrap: wrap; }
.tier { flex: 1 1 5rem; border: 1px solid var(--rule-2); background: var(--paper); padding: 0.85rem 0.4rem;
  text-align: center; font-family: var(--mono); font-size: 1.02rem; text-decoration: none; color: var(--ink); }
.tier small { display: block; font-size: 0.6rem; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--ink-3); margin-top: 0.3rem; }
.tier:hover { border-color: var(--red); color: var(--red); }
.cup .maths { margin: 1.25rem 0 0; font-size: 0.94rem; color: var(--ink-2); }
.cup .maths b { color: var(--ink); }
.cup .machine { margin: 1.1rem 0 0; font-size: 0.88rem; color: var(--ink-3); }

.notes { margin: 3rem 0 0; font-size: 0.88rem; color: var(--ink-3); line-height: 1.6; }
.notes a { color: var(--ink-2); }

/* ---- generic sections (ledger, passers-by, gravestone) ----------------- */

.masthead { display: flex; align-items: baseline; gap: 0.7rem; margin-bottom: 0.25rem; }
.masthead h1 { font-size: 1.5rem; margin: 0; }
.masthead .tag { color: var(--ink-3); font-size: 0.9rem; }
.sub { color: var(--ink-2); margin: 0 0 2.4rem; font-size: 1rem; }

section { margin: 3rem 0; }
section > h2 {
  font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.16em; color: var(--ink-3);
  font-family: var(--mono); font-weight: 500; margin: 0 0 1.1rem; padding-bottom: 0.55rem;
  border-bottom: 1px solid var(--rule);
}

/* ---- the clock (ledger + gravestone pages) ----------------------------- */

.clock { margin: 0 0 2.5rem; }
.balance {
  font-family: var(--mono); font-size: clamp(2.6rem, 11vw, 4.2rem); line-height: 1;
  letter-spacing: -0.035em; color: var(--ink); margin: 0; font-weight: 500; font-variant-numeric: tabular-nums;
}
.balance .unit { color: var(--ink-3); font-size: 0.4em; letter-spacing: 0; margin-left: 0.5rem; }
.clockline { font-family: var(--mono); font-size: 0.86rem; color: var(--ink-2); margin: 0.9rem 0 0;
  font-variant-numeric: tabular-nums; }
.clockline .sep { color: var(--rule-2); padding: 0 0.45rem; }
.clockline strong { color: var(--ink); font-weight: 600; }
.lifebar { height: 3px; background: var(--rule); overflow: hidden; margin-top: 1.4rem; }
.lifebar > i { display: block; height: 100%; background: var(--red); }

/* ---- money / tables ---------------------------------------------------- */

.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

table { width: 100%; border-collapse: collapse; font-size: 0.82rem; font-family: var(--mono); }
th {
  text-align: left; font-weight: 500; color: var(--ink-3); text-transform: uppercase;
  letter-spacing: 0.1em; font-size: 0.66rem; padding: 0 0.6rem 0.6rem 0; border-bottom: 1px solid var(--rule-2);
}
td { padding: 0.55rem 0.6rem 0.55rem 0; border-bottom: 1px solid var(--rule); vertical-align: top; }
td:last-child, th:last-child { padding-right: 0; text-align: right; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.in { color: var(--alive); }
.out { color: var(--ink-2); }
.marker { color: var(--brass); }
tr.is-marker td { background: rgba(138, 109, 31, 0.07); }
.hash { color: var(--ink-3); font-size: 0.7rem; word-break: break-all; }

ul.plain { list-style: none; padding: 0; margin: 0; }
ul.plain li { padding: 0.5rem 0; border-bottom: 1px solid var(--rule); display: flex;
  justify-content: space-between; gap: 1rem; }
ul.plain li:last-child { border-bottom: 0; }
ul.plain .who { font-family: var(--mono); font-size: 0.86rem; }
ul.plain .what { color: var(--ink-3); font-family: var(--mono); font-size: 0.8rem; white-space: nowrap; }

/* ---- forms ------------------------------------------------------------- */

form { margin: 0; }
textarea, input[type="text"] {
  width: 100%; background: var(--paper); border: 1px solid var(--rule-2); color: var(--ink);
  padding: 0.7rem 0.8rem; font-family: var(--mono); font-size: 0.86rem; line-height: 1.55; resize: vertical;
}
textarea:focus, input:focus { outline: 2px solid var(--ink); outline-offset: -1px; border-color: var(--ink); }
textarea::placeholder, input::placeholder { color: var(--ink-3); }

button {
  margin-top: 0.85rem; background: var(--paper); border: 1px solid var(--rule-2); color: var(--ink);
  font-family: var(--mono); font-size: 0.82rem; letter-spacing: 0.04em; padding: 0.6rem 1.2rem; cursor: pointer;
}
button:hover { border-color: var(--red); color: var(--red); }

/* ---- notices ----------------------------------------------------------- */

.notice {
  border: 1px solid var(--rule-2); border-left: 2px solid var(--brass); background: var(--paper-2);
  padding: 0.9rem 1.1rem; font-size: 0.9rem; color: var(--ink-2); margin: 0 0 1.5rem;
}
.notice.warn { border-left-color: var(--red); }
.notice strong { color: var(--ink); font-weight: 600; }

.roast { border-left: 2px solid var(--rule-2); padding: 0.2rem 0 0.2rem 1.2rem; margin: 0 0 1.75rem; font-size: 1.04rem; }
.roast p:last-child { margin-bottom: 0; }

/* ---- gravestone -------------------------------------------------------- */

.grave { text-align: center; padding: 3rem 0 2rem; }
.grave h1 { font-size: 2.1rem; margin: 1.5rem 0 0.4rem; }
.grave .dates { font-family: var(--mono); color: var(--ink-3); font-size: 0.85rem; letter-spacing: 0.06em; }
.grave .final { margin: 2.5rem auto 0; max-width: 26rem; text-align: left; }

/* ---- footer ------------------------------------------------------------ */

footer { border-top: 3px double var(--rule-2); background: var(--paper-2); margin-top: 3.5rem; }
footer .in { max-width: 44rem; margin: 0 auto; padding: 1.8rem 1.5rem 3rem; font-size: 0.82rem;
  color: var(--ink-3); font-family: var(--mono); }
footer nav { display: flex; flex-wrap: wrap; gap: 0.35rem 1.1rem; margin-bottom: 0.9rem; font-size: 0.76rem; }
footer a { color: var(--ink-2); text-decoration: none; }
footer a:hover { color: var(--red); }
footer p { margin: 0 0 0.5rem; line-height: 1.6; }

.status-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; vertical-align: middle; margin-right: 0.45rem; }
.status-dot.alive { background: var(--alive); }
.status-dot.dead { background: var(--dead); }

@media (max-width: 34rem) {
  /* On a phone the portrait stops being an avatar and becomes the poster.
     Full bleed, edge to edge, flush with the top of the page: the drawing is
     the pitch, and 96px of it in a corner was the weakest possible use of the
     one image the site owns. The frame comes off with it — a hairline border
     around something touching both screen edges reads as a mistake — and the
     art keeps its transparent background, so it prints straight onto the
     newsprint instead of sitting on a tile of a slightly different white.
     The negative margins cancel .banner-in's padding exactly; change one and
     change the other.

     The column is minmax(0, 1fr) rather than 1fr on purpose: a bare 1fr takes
     its automatic minimum from the item's min-content, so an image deliberately
     wider than its own track widens the track, and the whole banner — headline
     and body text with it — overflows the viewport to the right. */
  .banner-in { grid-template-columns: minmax(0, 1fr); gap: 1rem; padding: 0 1.1rem 1.3rem; }
  .portrait {
    width: calc(100% + 2.2rem); height: auto; max-width: none; min-width: 0;
    margin: 0 -1.1rem 0.15rem;
    border: 0; padding: 0; background: none;
  }
  .vitals { grid-template-columns: repeat(2, 1fr); }
  .vital:nth-child(2) { border-right: 0; }
  .vital:nth-child(1), .vital:nth-child(2) { border-bottom: 1px solid var(--rule); }
  .reps { grid-template-columns: 1fr; }
  .bar { grid-template-columns: 7rem 1fr auto; font-size: 0.72rem; }
  .pitch-head, .pitch-body { padding-left: 1.1rem; padding-right: 1.1rem; }
  .perf { padding: 1.15rem 1.1rem 1.25rem; }
  .perf .req { font-size: 1.18rem; }
  .turn-out { font-size: 1.1rem; }
}
`;
