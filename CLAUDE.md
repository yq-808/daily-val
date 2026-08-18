# daily-val — project rules

A static site of dated, valuation-only reports: one HTML page per stock, per
date, published via GitHub Pages from `main` `/docs`.

**How to build a report lives in the skills, not here.** Input schemas,
commands, worked examples and the action-band spec belong to
`skills/<method>/SKILL.md` and `skills/shared/`. This file is the short list of
rules a report must not break, whichever method it uses.

## Five valuation methods, one pipeline

Each report's input carries a **method**; the generator and the shared landing
page dispatch on it. Same snapshot rules, same "generator does no math", and in
all five the fair value is derived without reference to any market price.

- **DCF** (default, no `method` field) — FCFF. For durable compounders.
- **Relative comps** (`"method": "comps"`) — peer/re-rating multiples on a
  forward metric. For cyclicals and "new-paradigm" re-ratings where a smooth
  FCFF stream is a poor fit (e.g. MU), and for high-multiple names whose GAAP
  earnings are too distorted by stock comp and acquisition amortization to
  discount (e.g. PANW) — there, anchor on `ev_fcf` and never let a GAAP earnings
  figure into the model.
- **Sum of the parts** (`"method": "sotp"`) — each stream on its own forward
  figure and its own multiple. For companies that are not one business, where a
  blended multiple would average away the whole question (e.g. CURI: a shrinking
  subscription line, a growing cash-licensing line, and a quarter of revenue that
  is non-cash barter). Only split along lines the filings actually disclose — an
  invented allocation is worse than an honest single multiple — and do not
  subtract corporate overhead on top of peer multiples that already carry it.
- **Operating leverage** (`"method": "opleverage"`) — earnings are *built*, not
  assumed: revenue × gross margin, less a cost base in dollars, then a multiple.
  For businesses whose large fixed cost base makes a few points of gross margin
  the entire valuation (e.g. FORM: nine years at 39–42% gross margin, then 50.7%
  in one quarter). Never express opex as a percentage of revenue — that assumes
  the leverage away, which is the error the method exists to prevent — and always
  carry a `history[]` of filed actuals, run through the same bridge, so an
  assumed margin is read against every margin the company has actually earned.
- **Fixed-cost breakeven** (`"method": "breakeven"`) — the gross margin is
  *derived*: a revenue level meets a cost base carried in dollars, and what is
  left over is the margin. For companies whose cost of revenue is capacity
  rather than goods — engineering booked to projects, amortization of
  capitalized IP — so that the margin is a consequence of the revenue level and
  not a decision (e.g. QUIK: eleven quarters in which revenue swung 3.7× while
  cost of revenue moved 13%, and gross margin ran from −23% to +77%). Test for
  it before choosing it: regress filed cost of revenue on filed revenue and
  check the R-squared is near zero. Each case is valued on the higher of an
  earnings multiple and a revenue floor, and the switch must fall out of the
  arithmetic rather than be chosen. Unlike the other four, the **share count is
  a per-case input** — a company below its own breakeven funds the gap by
  issuing stock, so holding shares fixed across a bear case hides the cost of
  the losses.

`breakeven` and `opleverage` are close neighbours and are chosen apart on one
question: is the gross margin a judgment (`opleverage`) or a consequence
(`breakeven`)? A second tell — `opleverage` ends at a P/E and so needs positive
earnings in every case; `breakeven` does not.

| Method | Skill (how to build one) | Engine | Inputs |
|--------|--------------------------|--------|--------|
| DCF | `skills/dcf/SKILL.md` | `docs/assets/dcf.js` | `skills/dcf/reference/` |
| Comps | `skills/relative-comps/SKILL.md` | `docs/assets/comps.js` | `skills/relative-comps/reference/` |
| SOTP | `skills/sum-of-the-parts/SKILL.md` | `docs/assets/sotp.js` | `skills/sum-of-the-parts/reference/` |
| Op leverage | `skills/operating-leverage/SKILL.md` | `docs/assets/opleverage.js` | `skills/operating-leverage/reference/` |
| Breakeven | `skills/breakeven/SKILL.md` | `docs/assets/breakeven.js` | `skills/breakeven/reference/` |

Shared across all five: the action band — `skills/shared/action-band.md`,
engine `docs/assets/action.js`.

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
- `skills/<method>/reference/inputs/<SYM>.json` and `.../notes/<SYM>.json` are
  **mutable working drafts**. Edit them to prepare the *next* date's report, then
  run the generator to freeze a new snapshot. Editing them does not — and must
  not — retroactively alter already-published reports.

### Do / Don't
- **Do** produce a new report by editing the reference JSON and running the
  generator, as the method's SKILL.md describes.
- **Don't** hand-edit files under `docs/reports/<symbol>/` to change a past
  report's numbers. A published snapshot is immutable.
- **Exception:** a one-off, content-neutral migration across all reports (e.g. a
  site-wide rebrand or a template change that leaves every intrinsic value
  identical) may regenerate existing dates. Anything that would change a past
  report's *valuation* is not allowed.

## Conventions
- The generator does **no** financial math. Valuation runs client-side in the
  method's engine, each a port of its skill's Python calculator, which stays the
  parity oracle.
- **The fair value is computed without reference to the market price.** Never
  upside/%-to-target, never a sell-side price target — those anchor a valuation
  to something that is not evidence. Peer multiples and forward fundamentals are
  inputs; a price is not.
- **Anything a price touches renders after the valuation**, in its own section,
  and the conventions line must say the price was not an input. Two things
  qualify: **implied expectations** (`market` + `expectations`, or
  `market.solve_for` on a `sotp`), which runs the model backwards — price in,
  required assumption out — and the **reasoning** half of the action band.
  A reverse solve reads the price against the share count that exists **today**,
  never a forward or post-dilution count — otherwise it credits the market with
  dilution that has not happened.
- The action band's two **levels** are the one exception to "after the
  valuation", and only because no price is involved in them: they are a fraction
  of the report's own fair value, so they render beside it at the top. Which side
  of them a price falls on stays below, with the reasoning.
- A band is **that day's idea about one stock**, written with that report. It is
  not a watchlist: never roll bands up across reports, and never surface one on
  the landing page. A published snapshot is immutable, so its prose must read as
  what those figures supported on that date, never as a live instruction.
- Each input's evaluation lives in the notes `drivers[]`; `probability` is a
  first-class driver, and every weighted report needs an honest read on its
  weights.
