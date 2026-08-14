# daily-val — project rules

A static site of dated, valuation-only reports: one HTML page per stock, per
date, published via GitHub Pages from `main` `/docs`.

## Three valuation methods, one pipeline

Each report's input carries a **method**; the generator and the shared landing
page dispatch on it. Same snapshot rules, same "generator does no math", and in
all three the fair value is derived without reference to any market price.

- **DCF** (default, no `method` field) — FCFF, port in `docs/assets/dcf.js`,
  inputs under `skills/dcf/reference/`. For durable compounders.
- **Relative comps** (`"method": "comps"`) — peer/re-rating multiples (P/E,
  EV/EBITDA, P/B, EV/Sales, EV/FCF) on a forward metric, port in
  `docs/assets/comps.js`, inputs under `skills/relative-comps/reference/`. For
  cyclicals / "new-paradigm" re-ratings where a smooth FCFF stream is a poor fit
  (e.g. MU), and for high-multiple names whose GAAP earnings are too distorted by
  stock comp and acquisition amortization to discount (e.g. PANW) — there, anchor
  on `ev_fcf` and never let a GAAP earnings figure into the model.
- **Sum of the parts** (`"method": "sotp"`) — each stream on its own forward
  figure and its own multiple, added up, adjusted for non-operating items and
  bridged to equity via net cash. Port in `docs/assets/sotp.js`, inputs under
  `skills/sum-of-the-parts/reference/`. For companies that are not one business,
  where a blended multiple would average away the whole question (e.g. CURI: a
  shrinking subscription line, a growing cash-licensing line, and a quarter of
  revenue that is non-cash barter). Only split along lines the filings actually
  disclose — an invented allocation is worse than an honest single multiple — and
  do not subtract corporate overhead on top of peer multiples that already carry
  it.

The generator resolves `<SYM>.json` from any reference root; the input's
`method` selects the engine, the page template, and the conventions line.

## Core principle: reports are static daily snapshots

**Every generated report is a frozen, self-contained copy of its own data on the
day it was generated.** It is never recomputed from live data, and it must not
change when the shared reference JSON is later updated.

- The frozen copy of record for each report is `docs/reports/<symbol>/<date>.json`
  = `{ symbol, date, generated, conventions, input, notes }`. It carries the full
  inputs (including `scenarios[].probability`) **and** the evaluation notes
  (including the read on the probabilities). The same data is embedded in the
  report HTML so the page is self-contained.
- `skills/<method>/reference/inputs/<SYM>.json` and `.../notes/<SYM>.json`
  (`<method>` = `dcf`, `relative-comps` or `sum-of-the-parts`) are **mutable
  working drafts**. Edit them to prepare the *next* date's report, then run the
  generator to freeze a new snapshot. Editing them does not — and must not —
  retroactively alter already-published reports.

### Do / Don't
- **Do** produce a new report by editing the reference JSON and running
  `python3 scripts/generate_report.py <SYM> --date <YYYY-MM-DD>`.
- **Don't** hand-edit files under `docs/reports/<symbol>/` to change a past
  report's numbers. A published snapshot is immutable.
- **Exception:** a one-off, content-neutral migration across all reports (e.g. a
  site-wide rebrand or a template change that leaves every intrinsic value
  identical) may regenerate existing dates. Anything that would change a past
  report's *valuation* is not allowed.

## Conventions
- The generator does **no** financial math; all valuation runs client-side in
  the method's engine — `docs/assets/dcf.js` (port of
  `skills/dcf/scripts/dcf_calculator.py`, mid-year discounting),
  `docs/assets/comps.js` (port of
  `skills/relative-comps/scripts/comps_calculator.py`, peer multiples), or
  `docs/assets/sotp.js` (port of
  `skills/sum-of-the-parts/scripts/sotp_calculator.py`, per-part multiples). The
  landing page loads all three and headlines each report with its own engine.
- Pages are **valuation only** in the sense that matters: the fair value is
  always computed *without reference to the market price*. No upside/%-to-target,
  and no sell-side price targets, ever — those anchor a valuation to a number
  that is not evidence. Peer *multiples* and forward fundamentals are inputs, not
  a market price.
- **The one exception — implied expectations.** A report may carry a `market`
  block (`price`, `as_of`) and an `expectations` block, which render as clearly
  separated trailing sections that run the model *backwards*: the price is the
  input and the required assumption is the output ("what would you have to
  believe?"). This is allowed because it cannot contaminate the valuation —
  the fair value is already fixed before the price is read. The rules are:
  the price must never feed the fair value; the sections must come *after* the
  valuation, never above it; the conventions line must say the price was not an
  input; and the page must not turn the comparison into a recommendation. A
  `sotp` report does the same thing with `market.solve_for`: it credits every
  *other* part at our own figures and reads off what the price leaves over for
  the one part that swings the answer.
- Each input's evaluation lives in the notes `drivers[]` array; the `probability`
  driver is a first-class input and every probability-weighted report should
  carry an honest read on how good its scenario weights are.
