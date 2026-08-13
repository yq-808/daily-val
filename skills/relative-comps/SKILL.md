# Relative Valuation (Peer Multiples) Skill

name: relative-comps
description: Relative valuation via peer/re-rating multiples (P/E, EV/EBITDA, P/B, EV/Sales, EV/FCF) — for cyclical or "new-paradigm" businesses where a smooth FCFF DCF is a poor fit
argument-hint: [SYMBOL]

## When to use this instead of the DCF skill

Two situations call for comps:

1. **Cyclical, commodity, or early-supercycle** businesses where value is a
   forward-earnings × peer-multiple story rather than a smooth mid-cycle
   free-cash-flow stream — memory (MU), commodities, deep cyclicals, or a name
   being re-rated into a "new paradigm" (e.g. an AI-infrastructure beneficiary)
   where the honest comparison set is *today's* peer multiples, not the stock's
   own history.
2. **High-multiple names whose reported earnings carry no information** — heavy
   stock comp and acquisition amortization can put GAAP net income near zero or
   negative while cash generation is large (PANW: FY2027 consensus free cash flow
   ~3.4× GAAP net income). A headline P/E above 100× is a symptom of the
   accounting, not of the price. Anchor on `ev_fcf` and `ev_sales`, and never let
   a GAAP earnings figure into the model.

Note that case 2 is *not* an argument against discounting cash flows as such — if
the business has a durable, forecastable FCF stream, the `dcf` skill remains the
better tool and a high GAAP P/E is no reason to avoid it. Reach for comps when
the multiple itself is the honest unit of judgment, and say so in the notes.

## Method (what pros do)

1. **Anchor a forward metric** (a target fiscal year, e.g. FY2027): EPS, EBITDA,
   revenue, and book value per share.
2. **Apply a peer / re-rating multiple** per metric:
   - `pe`  → price = EPS × P/E                                (equity multiple)
   - `pb`  → price = BVPS × P/B                               (equity multiple)
   - `ev_ebitda` → EV = EBITDA × mult; price = (EV + net cash) / shares
   - `ev_sales`  → EV = Revenue × mult; price = (EV + net cash) / shares
   - `ev_fcf`    → EV = FCF × mult; price = (EV + net cash) / shares
3. **Cross-check across multiples** — take the equal-weight blend and a "core"
   subset (the multiples that anchor best), and show the min–max range.
4. **Scenario-weight** bear / base / bull, jointly varying the metric *and* the
   multiple, then probability-weight for a single fair value.

The multiples are peer-anchored and stable; the forward **metric** is usually the
real swing factor, so the notes must carry an honest read on consensus dispersion.

## Run the calculation (parity oracle)

```bash
python3 skills/relative-comps/scripts/comps_calculator.py skills/relative-comps/reference/inputs/{SYMBOL}.json
```

This is the non-browser reference implementation of `docs/assets/comps.js`; the
two must agree. To publish a dated report, run the site generator, which embeds
the inputs and computes the numbers client-side in `comps.js`:

```bash
python3 scripts/generate_report.py {SYMBOL} --date {YYYY-MM-DD}
```

The generator resolves inputs from `skills/relative-comps/reference/inputs/` (and
notes from `.../notes/`) when the input's `"method"` is `"comps"`.

## Input file format

`skills/relative-comps/reference/inputs/{SYMBOL}.json`

**Large numbers:** K/M/B/T suffixes (e.g. `"150B"`). **Multiples:** plain numbers
(`8` = 8×). `net_cash` may be negative (net debt). Per-share metrics (`eps`,
`bvps`) are in dollars; firm-level metrics (`ebitda`, `revenue`, `fcf`) use
suffixes.

Two optional strings control the page's step-1 and step-2 intro prose —
`peers_intro` (name the actual cohort and how the peer multiples were derived)
and `figures_intro` (say where the forward figures come from). Both fall back to
generic wording, so set them whenever the defaults would be vague or wrong.

```json
{
  "symbol": "MU",
  "method": "comps",
  "anchor": "FY2027",
  "peer_group": "Legacy memory (SK Hynix, Samsung)",
  "peers": [
    { "name": "SK Hynix", "pe": 5.4, "ev_ebitda": 7.7, "pb": 3.5, "ev_sales": 6.1 },
    { "name": "Samsung",  "pe": 4.9, "ev_ebitda": 8.6, "pb": 2.0, "ev_sales": 4.0 }
  ],
  "balance_sheet": { "net_cash": "25B", "diluted_shares": "1.13B" },
  "multiples": ["pe", "ev_ebitda", "pb", "ev_sales"],
  "core_multiples": ["pe", "ev_ebitda"],
  "scenarios": [
    {
      "name": "Base", "probability": 0.45,
      "fundamentals": { "eps": 115, "ebitda": "150B", "revenue": "195B", "bvps": 160 },
      "multiples": { "pe": 10, "ev_ebitda": 8, "pb": 4, "ev_sales": 5 }
    }
  ]
}
```

Rules:
- `scenarios` is a non-empty list; each carries `probability` (sum `1.0` or `100`).
- Top-level `fundamentals` / `multiples` / `balance_sheet` act as defaults; each
  scenario provides partial overrides and inherits the rest.
- `multiples` lists which multiples to compute and their display order.
  `core_multiples` is the subset used for the "core" cross-check (defaults to all).
- Only multiples present in a scenario's `multiples` map are computed.

## Notes (evaluation) file format

`skills/relative-comps/reference/notes/{SYMBOL}.json` — a `drivers[]` array of
`{ key, label, verdict, comment }`, one per input, each a plain-English "how
defensible" read. Recognized keys: `eps`, `ebitda`, `revenue`, `bvps`, `fcf`,
`mult_pe`, `mult_ev_ebitda`, `mult_pb`, `mult_ev_sales`, `mult_ev_fcf`,
`net_cash`, `shares`, `probability`. The `probability` read is a first-class
input — every probability-weighted report should carry an honest read on its
scenario weights, and a single-case report should say plainly that it has no
dispersion and give the sensitivities numerically instead.

Because peer multiples in some sectors span a four- or five-fold range, a comps
report should also carry a driver saying **how much the peer set actually
constrains the answer**. If the honest answer is "very little", say so and frame
the fair value as a function of the chosen multiple.

## Optional: implied expectations (explaining the market price)

Two optional blocks let a report run *backwards* — taking the traded price as
given and solving for what you would have to believe. They never feed the fair
value, which is computed before the price is read, and they render as trailing
sections after the valuation.

```json
"market": { "price": 394.16, "as_of": "2026-08-13", "commentary": "…" },
"expectations": {
  "horizon": "FY2030",
  "years_to_horizon": 4,      // discounting periods from today to the horizon
  "compound_years": 3,        // compounding periods from the anchor year
  "discount_rate": 0.08,
  "balance_sheet": { "net_cash": "15B", "diluted_shares": "850M" },
  "paths": [
    { "name": "Company plan", "revenue_cagr": 0.20, "fcf_margin": 0.40,
      "comment": "…" }
  ]
}
```

`market` yields the multiple the price implies on the *same* anchor-year figures.
`expectations` compounds anchor revenue to the horizon, applies an FCF margin,
and solves for the multiple the business would still need there to justify the
price — plus what each path is worth today at *your* multiple.

**Why this is worth doing.** Price and value differ by a ratio that factors
almost exactly into two independent pieces, because price ≈ metric × multiple ÷
shares:

    price / fair value  ≈  (forecast factor)  ×  (multiple factor)  ÷  (1+r)^years

So "the market believes a bigger forecast" and "the market pays a higher
multiple" are separable, multiplicative explanations, and the table shows which
one is actually doing the work. Usually it is the multiple — a forecast has to
roughly double to move the price as much as a doubling of the multiple, and
forward figures for a contracted, recurring-revenue business rarely can.

## Key formulas

| Formula | Description |
|---------|-------------|
| price = EPS × P/E | Equity multiple (earnings) |
| price = BVPS × P/B | Equity multiple (book value) |
| EV = EBITDA × (EV/EBITDA) | Enterprise value from operating cash proxy |
| EV = Revenue × (EV/Sales) | Enterprise value from sales |
| EV = FCF × (EV/FCF) | Enterprise value from free cash flow |
| Equity = EV + Net cash | EV → equity bridge (net cash = cash − debt) |
| Price = Equity / Diluted shares | Per-share value for EV multiples |
| Blended = mean(all multiples) | Cross-check headline per scenario |
| Fair value = Σ probability × Blended | Probability-weighted fair value |

Valuation only — the page never shows a live market price.
