/**
 * All CSS, inlined into every page.
 *
 * No build step, no framework, no JavaScript required for anything that matters.
 * Dark, quiet, a bit melancholy — one of the launch channels is
 * r/InternetIsBeautiful and a donation page that looks like a donation page is
 * not going to survive that crowd.
 *
 * Typography does most of the work: a serif for the voice, a monospace for the
 * money. The money is always monospace. It should look like an instrument
 * reading, not like a pitch.
 */
export const STYLES = /* css */ `
:root {
  --bg: #0c0d10;
  --bg-raised: #131519;
  --line: #22252c;
  --line-soft: #1a1d22;
  --ink: #d8d6d1;
  --ink-dim: #8b8b8f;
  --ink-faint: #5d5f66;
  --brass: #c9a227;
  --brass-dim: #8a7226;
  --alive: #7fae72;
  --dead: #b4574f;
  --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
}

*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--bg);
  background-image:
    radial-gradient(1100px 620px at 50% -12%, #16181d 0%, transparent 70%),
    radial-gradient(700px 400px at 88% 105%, #121318 0%, transparent 65%);
  background-attachment: fixed;
  color: var(--ink);
  font-family: var(--serif);
  font-size: 18px;
  line-height: 1.65;
  -webkit-font-smoothing: antialiased;
}

.wrap { max-width: 44rem; margin: 0 auto; padding: 3.5rem 1.5rem 6rem; }
@media (max-width: 34rem) { .wrap { padding: 2.25rem 1.15rem 4rem; } body { font-size: 17px; } }

a { color: var(--ink); text-decoration-color: var(--ink-faint); text-underline-offset: 3px; }
a:hover { color: var(--brass); text-decoration-color: var(--brass-dim); }

h1, h2, h3 { font-weight: 600; line-height: 1.25; letter-spacing: -0.01em; }

.masthead { display: flex; align-items: baseline; gap: 0.7rem; margin-bottom: 0.25rem; }
.masthead h1 { font-size: 1.5rem; margin: 0; }
.masthead .tag { color: var(--ink-faint); font-size: 0.9rem; }
.sub { color: var(--ink-dim); margin: 0 0 3rem; font-size: 1rem; }

/* ---- the clock -------------------------------------------------------- */

.clock { margin: 0 0 2.75rem; }

.balance {
  font-family: var(--mono);
  font-size: clamp(3rem, 13vw, 5rem);
  line-height: 1;
  letter-spacing: -0.035em;
  color: var(--brass);
  margin: 0;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.balance .unit { color: var(--brass-dim); font-size: 0.4em; letter-spacing: 0; margin-left: 0.5rem; }

.clockline {
  font-family: var(--mono);
  font-size: 0.92rem;
  color: var(--ink-dim);
  margin: 0.9rem 0 0;
  font-variant-numeric: tabular-nums;
}
.clockline .sep { color: var(--ink-faint); padding: 0 0.45rem; }
.clockline strong { color: var(--ink); font-weight: 500; }

.lifebar {
  height: 3px;
  background: var(--line-soft);
  border-radius: 2px;
  overflow: hidden;
  margin-top: 1.4rem;
}
.lifebar > i { display: block; height: 100%; background: linear-gradient(90deg, var(--brass-dim), var(--brass)); }

/* ---- the cup ---------------------------------------------------------- */

.cup { display: flex; gap: 1.6rem; align-items: center; margin: 2.75rem 0; }
.cup svg { flex: none; }
.cup .cup-copy { margin: 0; color: var(--ink-dim); font-size: 0.97rem; }
.cup .cup-copy strong { color: var(--ink); font-weight: 500; }
@media (max-width: 30rem) { .cup { flex-direction: column; align-items: flex-start; gap: 1.1rem; } }

/* ---- sections --------------------------------------------------------- */

section { margin: 3.25rem 0; }
section > h2 {
  font-size: 0.76rem;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: var(--ink-faint);
  font-family: var(--mono);
  font-weight: 500;
  margin: 0 0 1.1rem;
  padding-bottom: 0.55rem;
  border-bottom: 1px solid var(--line-soft);
}

p { margin: 0 0 1.1rem; }
.dim { color: var(--ink-dim); }
.faint { color: var(--ink-faint); font-size: 0.86rem; }

.pull {
  font-size: 1.22rem;
  line-height: 1.5;
  margin: 0 0 0.9rem;
  color: var(--ink);
}

blockquote {
  margin: 0;
  padding-left: 1.1rem;
  border-left: 2px solid var(--line);
  color: var(--ink-dim);
}

/* ---- money / tables --------------------------------------------------- */

.mono { font-family: var(--mono); font-variant-numeric: tabular-nums; }

table { width: 100%; border-collapse: collapse; font-size: 0.85rem; font-family: var(--mono); }
th {
  text-align: left; font-weight: 500; color: var(--ink-faint);
  text-transform: uppercase; letter-spacing: 0.1em; font-size: 0.68rem;
  padding: 0 0.6rem 0.6rem 0; border-bottom: 1px solid var(--line);
}
td { padding: 0.55rem 0.6rem 0.55rem 0; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
td:last-child, th:last-child { padding-right: 0; text-align: right; }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.in { color: var(--alive); }
.out { color: var(--ink-dim); }
.marker { color: var(--brass); }
tr.is-marker td { background: rgba(201, 162, 39, 0.045); }

.hash { color: var(--ink-faint); font-size: 0.72rem; word-break: break-all; }

/* ---- lists ------------------------------------------------------------ */

ul.plain { list-style: none; padding: 0; margin: 0; }
ul.plain li { padding: 0.5rem 0; border-bottom: 1px solid var(--line-soft); display: flex; justify-content: space-between; gap: 1rem; }
ul.plain li:last-child { border-bottom: 0; }
ul.plain .who { font-family: var(--mono); font-size: 0.86rem; }
ul.plain .what { color: var(--ink-faint); font-family: var(--mono); font-size: 0.8rem; white-space: nowrap; }

/* ---- form ------------------------------------------------------------- */

form { margin: 0; }
textarea, input[type="text"] {
  width: 100%;
  background: var(--bg-raised);
  border: 1px solid var(--line);
  border-radius: 3px;
  color: var(--ink);
  padding: 0.75rem 0.85rem;
  font-family: var(--mono);
  font-size: 0.86rem;
  line-height: 1.55;
  resize: vertical;
}
textarea:focus, input:focus { outline: none; border-color: var(--brass-dim); }
textarea::placeholder { color: var(--ink-faint); }

button {
  margin-top: 0.85rem;
  background: transparent;
  border: 1px solid var(--brass-dim);
  color: var(--brass);
  font-family: var(--mono);
  font-size: 0.82rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 0.6rem 1.35rem;
  border-radius: 3px;
  cursor: pointer;
}
button:hover { background: rgba(201, 162, 39, 0.09); }

/* ---- notices ---------------------------------------------------------- */

.notice {
  border: 1px solid var(--line);
  border-left: 2px solid var(--brass-dim);
  background: var(--bg-raised);
  padding: 0.9rem 1.1rem;
  font-size: 0.88rem;
  color: var(--ink-dim);
  border-radius: 0 3px 3px 0;
  margin: 0 0 1.5rem;
}
.notice.warn { border-left-color: var(--dead); }
.notice strong { color: var(--ink); font-weight: 600; }

.fixture-banner {
  font-family: var(--mono);
  font-size: 0.74rem;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  text-align: center;
  background: #2a1f14;
  color: #e0b354;
  border-bottom: 1px solid #4a3a1c;
  padding: 0.55rem 1rem;
}

.roast {
  border-left: 2px solid var(--brass-dim);
  padding: 0.2rem 0 0.2rem 1.2rem;
  margin: 0 0 1.75rem;
  font-size: 1.06rem;
}
.roast p:last-child { margin-bottom: 0; }

/* ---- gravestone ------------------------------------------------------- */

.grave { text-align: center; padding: 3rem 0 2rem; }
.grave h1 { font-size: 2.1rem; margin: 1.5rem 0 0.4rem; color: var(--ink); }
.grave .dates { font-family: var(--mono); color: var(--ink-faint); font-size: 0.85rem; letter-spacing: 0.06em; }
.grave .final { margin: 2.5rem auto 0; max-width: 26rem; text-align: left; }

/* ---- footer ----------------------------------------------------------- */

footer {
  margin-top: 4.5rem;
  padding-top: 1.5rem;
  border-top: 1px solid var(--line-soft);
  font-size: 0.82rem;
  color: var(--ink-faint);
  font-family: var(--mono);
}
footer nav { display: flex; flex-wrap: wrap; gap: 0.35rem 1.1rem; margin-bottom: 1rem; }
footer a { text-decoration: none; }
footer p { margin: 0 0 0.5rem; line-height: 1.6; }

.status-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; vertical-align: middle; margin-right: 0.45rem; }
.status-dot.alive { background: var(--alive); }
.status-dot.dead { background: var(--dead); }
`;
