# Operating-Leverage (Earnings-Power Bridge) Skill

name: operating-leverage
description: Valuation that derives earnings from revenue × gross margin − a fixed cost base, then applies a multiple — for businesses where a few points of margin is the whole answer
argument-hint: [SYMBOL]

## When to use this instead of the other three

Reach for this when **the disagreement about a company is a margin, not a
multiple, not a discount rate, and not a business mix**.

The tell is a large, slow-moving operating cost base sitting under a gross
profit line that moves with the cycle. Semiconductor equipment and test,
capital equipment, specialty manufacturing, and anything with a fab or a
factory behind it: revenue swings, cost does not, and earnings therefore swing
several times harder than revenue. In that setting the honest unit of judgment
is the gross margin, and a model that *accepts* an earnings figure has skipped
the only question worth asking.

Compare with what the other three would do to such a name:

- **`dcf`** buries the margin inside an FCF margin assumption and then spends
  its precision on a discount rate and a terminal growth rate — two inputs that
  matter far less than the one it hid.
- **`comps`** takes "FY2027 EPS = $2.68" as an input. That is the answer, not an
  input. The whole argument is *how* you got to $2.68, and comps has no place to
  put it.
- **`sotp`** splits a company into businesses. Use it when the parts really are
  different businesses; do not use it when one company has one business whose
  margin is in dispute.

Use `comps` instead when the forward earnings figure is genuinely uncontroversial
and the multiple is what you are arguing about. Use this skill when it is the
other way round.

## Method

1. **Name a revenue level** for the anchor year. Not a growth rate — a level.
2. **Name a gross margin.** This is the crux; the rest is arithmetic.
3. **Name the operating cost base in dollars**, not as a percentage of revenue.
   Expressing opex as a margin quietly assumes the leverage away, which is the
   error this method exists to prevent.
4. **Let earnings fall out**, through the bridge below.
5. **Apply a multiple** — `pe` on net income, or `ev_ebit` on EBIT with a net-cash
   bridge to equity.
6. **Scenario-weight**, varying revenue, margin, cost and multiple jointly.

### The bridge

| Step | Formula |
|------|---------|
| Gross profit | revenue × gross margin |
| EBIT | gross profit − opex |
| Pre-tax | EBIT + other income |
| Net income | pre-tax × (1 − tax rate) |
| EPS | net income ÷ diluted shares |
| Value per share (`pe`) | EPS × multiple |
| Value per share (`ev_ebit`) | (EBIT × multiple + net cash) ÷ diluted shares |

`other_income` is where interest on a net-cash balance sheet belongs under `pe`.
Under `ev_ebit` the cash is bridged explicitly instead, so do not do both.

### The `history` block is not decoration

Every history row is run through the **same bridge** as the scenarios, from the
company's own filed revenue, gross margin and opex. That is what makes the
method honest: an assumed 53% gross margin has to be read directly against every
margin the company has actually earned, in the same table, in the same units.

If a scenario's margin sits outside the entire filed record, the report must say
so in the notes and the confidence tier must reflect it. Strip anything GAAP has
folded into operating income that is not operations — divestiture gains are the
common one — and say in a row `note` that you did.

## Run the calculation (parity oracle)

```bash
python3 skills/operating-leverage/scripts/opleverage_calculator.py skills/operating-leverage/reference/inputs/FORM.json
```

This is the non-browser reference implementation of `docs/assets/opleverage.js`;
the two must agree. To publish a dated report:

```bash
python3 scripts/generate_report.py FORM --date 2026-08-18
```

## Input file format

`skills/operating-leverage/reference/inputs/{SYMBOL}.json`

**Large numbers:** K/M/B/T suffixes (`"1.15B"`). **Rates:** decimals (`0.48`) or
whole percents (`48`). **Multiples:** plain numbers.

```json
{
  "symbol": "FORM",
  "method": "opleverage",
  "anchor": "FY2027",
  "history_intro": "…",  "bridge_intro": "…",  "figures_source": "…",
  "fundamentals": {
    "revenue": "1.15B", "gross_margin": 0.48, "opex": "310M",
    "other_income": "10M", "tax_rate": 0.15
  },
  "balance_sheet": { "net_cash": "334M", "diluted_shares": "80M" },
  "multiple": { "kind": "pe", "value": 26 },
  "history": [
    { "period": "FY2025", "revenue": "784.993M", "gross_margin": 0.393444,
      "opex": "251.781M", "note": "optional — what was excluded and why" }
  ],
  "scenarios": [
    { "name": "Base", "probability": 0.45,
      "fundamentals": { "revenue": "1.15B", "gross_margin": 0.48, "opex": "310M" },
      "multiple": 26, "comment": "…" }
  ],
  "sensitivity": {
    "revenue": ["950M", "1.15B", "1.35B"],
    "gross_margin": [0.40, 0.48, 0.54]
  }
}
```

Rules:
- `scenarios` is a non-empty list; each carries `probability` (sum `1.0` or `100`).
- Top-level `fundamentals` / `balance_sheet` are defaults; each scenario supplies
  partial overrides and inherits the rest. A scenario's `multiple` is a bare
  number and overrides `multiple.value`; `multiple.kind` is set once at the top.
- `sensitivity` renders value per share across revenue × gross margin, holding
  the solve case's cost base, tax rate and multiple. Include it — for this class
  of business it is more informative than the scenario table.

## Notes (evaluation) file format

`skills/operating-leverage/reference/notes/{SYMBOL}.json` — a `drivers[]` array
of `{ key, label, verdict, comment }`. Recognized keys: `revenue`,
`gross_margin`, `opex`, `other_income`, `tax_rate`, `shares`, `net_cash`,
`multiple`, `history`, `probability`.

Two are mandatory for this method:

- **`gross_margin`** — it is the crux by construction. State how many years of
  evidence sit on each side of the assumed number.
- **`probability`** — with a levered bridge the case spread is usually wide, so
  the weights carry more of the answer than in any other method. Say by how much:
  quantify what shifting weight between cases does to the fair value.

## Optional: implied expectations (`market`)

Runs the bridge **backwards** from the traded price, holding one named case's
cost base, tax rate, share count and multiple fixed, and solving for the EBIT the
price requires — then expressing that requirement two ways: as a gross margin at
the case's revenue, and as a revenue at the case's gross margin.

```json
"market": { "price": 138.87, "as_of": "2026-08-17", "solve_from": "Base", "commentary": "…" }
```

This never feeds the fair value, which is computed before the price is read, and
it renders after the valuation. It is the most useful section this method has:
"the price needs a 69.8% gross margin, or $1.67B of revenue" is a falsifiable
claim in a way that "the stock looks expensive" is not.

## Optional: the action band

Standard across all methods — see `skills/shared/action-band.md`. One caution
specific to this one: the bridge is levered, so scenario spreads of 4–6× are
normal. When the spread is that wide the weighted fair value is mostly a
statement about the weights, so prefer a **scenario name** for `buy_below` over a
fraction, and expect the `low` tier.

## Key formulas

| Formula | Description |
|---------|-------------|
| GP = revenue × gross margin | The one line that matters |
| EBIT = GP − opex | Opex in dollars, not as a margin |
| NI = (EBIT + other income) × (1 − tax) | Interest on net cash lives in other income |
| EPS = NI ÷ diluted shares | |
| Price = EPS × P/E | `kind: "pe"` |
| Price = (EBIT × mult + net cash) ÷ shares | `kind: "ev_ebit"` |
| Fair value = Σ probability × price | Probability-weighted |
| Required GP = required EBIT + opex | The reverse solve, from a traded price |

The fair value is derived without reference to any market price. Where a report
carries one, it appears only after the valuation — in the implied-expectations
section and in the action band's reasoning.
