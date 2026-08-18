# Fixed-Cost Breakeven Skill

name: breakeven
description: Valuation for a business whose cost of revenue is capacity, not goods — the gross margin is derived from a revenue level meeting a dollar cost base, and each case is valued on earnings or on a revenue floor depending on which side of breakeven it lands
argument-hint: [SYMBOL]

## When to use this instead of the other four

Reach for this when **the gross margin is not an assumption the company gets to
make** — when it is simply what arithmetic does to a revenue level that meets a
cost base sitting still.

The tell is mechanical and you should test for it before choosing this method:
plot the filed quarterly cost of revenue against the filed quarterly revenue. If
revenue swings by a factor of two or more while cost of revenue stays inside a
narrow band — and a regression of one on the other returns an R-squared near
zero — then the cost of revenue is a *capacity* cost, not a *unit* cost. It is
engineering headcount booked to projects, amortization of capitalized IP and
mask sets, a minimum fab commitment. It was decided a year ago and it does not
know what shipped this quarter.

For such a company the reported gross margin is a residual. QuickLogic's ran
from −23.3% to +76.9% across eleven quarters without a single decision being
taken about pricing or mix. Anyone who *inputs* a gross margin to value it has
input the answer.

Compare with what the other four would do:

- **`opleverage`** is the near miss, and the distinction matters. It also carries
  opex in dollars and it also exists to stop leverage being assumed away — but
  its crux input is the gross margin, taken as given at the top of the bridge.
  Use it when the margin is genuinely a judgment (a fab's yield curve, a pricing
  decision) and the argument is about which number to pick. Use **this** skill
  when the margin is not a judgment at all but a consequence, and the argument is
  about the revenue level that produces it. A second tell: `opleverage` ends at a
  P/E, so it needs positive earnings in every case. This method does not.
- **`dcf`** needs a stream to discount. A company that has covered its own costs
  in one year out of ten has no stream, and a terminal value would be the entire
  answer.
- **`comps`** takes a forward metric as an input. Here the forward metric is
  exactly what is in dispute, and comps has nowhere to put the cost base.
- **`sotp`** splits a company into businesses. Use it when the parts really are
  different businesses; not when one business is simply below its own breakeven.

## Method

1. **Name the cost base in dollars** — a fixed block of cost of revenue, an opex
   figure, and the D&A inside them. Never as a percentage of revenue.
2. **Name the genuinely variable share of revenue**, if there is one. It is
   usually small and usually not statistically identified; say so in the notes
   and prefer the value that produces the *lower* valuation.
3. **Read off the breakeven revenue.** No revenue forecast has been made yet —
   this number is a property of the cost structure alone, and it is the report's
   most durable output.
4. **Name a revenue level per case.** This is the crux; everything else is
   arithmetic.
5. **Let the margins fall out** through the bridge below.
6. **Value each case twice** — on its earnings and on a revenue floor — and
   carry the higher. Above the line a business is worth a multiple of what it
   earns; below it, a multiple of what it sells, because there is nothing to
   capitalize.
7. **Scenario-weight**, varying revenue, cost base, share count and multiples
   jointly.

### The bridge

| Step | Formula |
|------|---------|
| Cost of revenue | fixed block + revenue × variable ratio |
| Gross profit | revenue − cost of revenue |
| **Gross margin** | **gross profit ÷ revenue — an output, never an input** |
| EBIT | gross profit − opex |
| EBITDA | EBIT + D&A |
| Breakeven revenue (EBIT) | (fixed cost of revenue + opex) ÷ (1 − variable ratio) |
| Breakeven revenue (EBITDA) | (fixed cost of revenue + opex − D&A) ÷ (1 − variable ratio) |
| Breakeven revenue (gross profit) | fixed cost of revenue ÷ (1 − variable ratio) |
| EV on earnings | EBITDA × multiple (`ev_ebitda`) or EBIT × multiple (`ev_ebit`) |
| EV on the floor | revenue × multiple (`ev_sales`) or gross profit × multiple (`ev_gross_profit`) |
| Enterprise value | **max** of the two |
| Value per share | (EV + net cash) ÷ diluted shares |

### Why `max`, and why it is not fitting

The floor is not a fudge and it is not optimism. It is the claim that a
franchise — an IP book, a qualified process position, a customer base — is worth
something to an acquirer independent of this year's P&L, and that claim is what
a revenue multiple has always meant. The earnings multiple takes over when the
business earns more than that.

What keeps it honest is that the switch is **mechanical, not chosen**: it falls
out of the sign and size of the case's own EBITDA. The report renders *both*
enterprise values for every case and marks which one binds, so a reader can see
the basis change happen. What you must not do is set the floor multiple per case
to whatever makes the answer come out — the floor is the weakest input in this
method by construction, and the notes have to say so and quantify it.

### The `history` block is not decoration

Every history row carries that period's **filed** revenue, cost of revenue and
opex in dollars — no split is assumed, because none is needed. Its breakeven
column is simply cost of revenue plus opex, so `revenue − breakeven` reconciles
exactly to reported operating income in every row. That reconciliation is the
proof that the method is describing the company rather than a model of it.

The table's job is to show the cost base barely moving while revenue swings, and
to put an assumed forward margin next to every margin actually earned.

## Run the calculation (parity oracle)

```bash
python3 skills/breakeven/scripts/breakeven_calculator.py skills/breakeven/reference/inputs/QUIK.json
```

This is the non-browser reference implementation of `docs/assets/breakeven.js`;
the two must agree. To publish a dated report:

```bash
python3 scripts/generate_report.py QUIK --date 2026-08-18
```

## Input file format

`skills/breakeven/reference/inputs/{SYMBOL}.json`

**Large numbers:** K/M/B/T suffixes (`"9.5M"`). **Rates:** decimals (`0.15`) or
whole percents (`15`). **Multiples:** plain numbers.

```json
{
  "symbol": "QUIK",
  "method": "breakeven",
  "anchor": "FY2027",
  "history_intro": "…",  "bridge_intro": "…",  "figures_source": "…",
  "cost_base": {
    "variable_ratio": 0.15, "fixed_cost_of_revenue": "9.5M",
    "opex": "17.5M", "dna": "6.8M", "other_income": "-0.4M"
  },
  "balance_sheet": {
    "net_cash": "10.907M", "diluted_shares": "20M", "shares_outstanding": "18.316M"
  },
  "multiple": {
    "earnings": { "kind": "ev_ebitda", "value": 18 },
    "floor":    { "kind": "ev_sales",  "value": 4.5 }
  },
  "history": [
    { "period": "FY2025", "revenue": "13.774M", "cost_of_revenue": "10.740M",
      "opex": "14.953M", "dna": "5.372M", "note": "optional" }
  ],
  "scenarios": [
    { "name": "Base", "probability": 0.45, "revenue": "32M", "shares": "20M",
      "cost_base": { "opex": "17.5M" },
      "multiple": { "earnings": 18, "floor": 4.5 }, "comment": "…" }
  ],
  "sensitivity": {
    "revenue": ["21M", "24M", "28M", "32M", "36M", "42M"],
    "earnings_multiple": [10, 14, 18, 22, 26]
  }
}
```

Rules:
- `scenarios` is a non-empty list; each carries `probability` (sum `1.0` or `100`)
  and a `revenue` level.
- Top-level `cost_base` and `balance_sheet` are defaults; each scenario supplies
  partial overrides and inherits the rest.
- `multiple.earnings.kind` ∈ `ev_ebitda`, `ev_ebit`; `multiple.floor.kind` ∈
  `ev_sales`, `ev_gross_profit`. Both kinds are set once at the top; a scenario
  overrides only the **values**, via `{"earnings": 14, "floor": 3.5}`.
- **`shares` is a per-case input, not a constant.** This is the one place the
  method departs from the other four, and deliberately: a company sitting below
  its own breakeven funds the gap by issuing stock, so the share count you divide
  by is a function of how badly the case goes. A model that holds it fixed across
  a bear case has hidden the cost of the losses. Set it from the filed issuance
  record and defend it in the notes.
- **`shares_outstanding` is today's actual count** and is used *only* by the
  reverse solve, which must not credit the market with dilution that has not
  happened yet. The valuation always uses the forward `diluted_shares`.
- `sensitivity` renders value per share across revenue × the earnings multiple.
  Include it: the floor-bound cells render greyed and flat, which draws the
  breakeven structure directly.

## Notes (evaluation) file format

`skills/breakeven/reference/notes/{SYMBOL}.json` — a `drivers[]` array of
`{ key, label, verdict, comment }`. Recognized keys: `cost_structure`,
`cost_base`, `revenue`, `dna`, `multiple`, `shares`, `net_cash`, `history`,
`probability`.

Three are mandatory for this method:

- **`cost_structure`** — the fixed/variable split is the claim that makes this
  the right method. Quote the actual dispersion: the revenue range, the cost of
  revenue range, and the regression R-squared. Then state what the variable ratio
  is worth: re-run with it at zero and report the fair value both ways.
- **`multiple`** — the floor decides every case that sits below breakeven, and
  it is a judgment against a peer set, not a measurement. Name the peers and
  their multiples, state the discount, and quantify what moving the floor does.
- **`probability`** — a case spread of 3–4× is normal here, so the weights carry
  more of the answer than any single figure. Quantify what shifting ten points
  between cases does.

## Optional: implied expectations (`market`)

Runs the model **backwards** from the traded price, holding one named case's
cost base, share count and multiples fixed, and solving for the revenue the
price requires — by each of the two routes, and then by the easier of them.

```json
"market": { "price": 12.63, "as_of": "2026-08-17", "solve_from": "Base", "commentary": "…" }
```

This never feeds the fair value, which is computed before the price is read, and
it renders after the valuation. "The price is asking for $38M of FY2027 revenue,
against $24M guided this year" is a falsifiable claim in a way that "the stock
looks expensive" is not.

## Optional: the action band

Standard across all methods — see `skills/shared/action-band.md`. Two cautions
specific to this one. The case spread is usually wide, so prefer a **scenario
name** for `buy_below` over a fraction. And a report whose base case is
floor-bound is a report whose answer rests on a peer multiple rather than on the
company's own earnings — that is a `low` confidence tier, whatever the cost-side
evidence looks like.

## Key formulas

| Formula | Description |
|---------|-------------|
| CoR = fixed + revenue × v | Cost of revenue is capacity, not goods |
| GP = revenue − CoR | Gross margin falls out of this, and is never input |
| EBIT = GP − opex | Opex in dollars, never as a margin |
| EBITDA = EBIT + D&A | The relevant line when D&A exceeds capex |
| BE = (fixed + opex) ÷ (1 − v) | Breakeven revenue — no forecast involved |
| EV = max(earnings × m₁, floor × m₂) | Which side of the line decides the basis |
| Value = (EV + net cash) ÷ shares | Shares vary by case; they fund the losses |
| Fair value = Σ probability × value | Probability-weighted |

The fair value is derived without reference to any market price. Where a report
carries one, it appears only after the valuation — in the implied-expectations
section and in the action band's reasoning.
