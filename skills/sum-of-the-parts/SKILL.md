# Sum-of-the-Parts Valuation Skill

name: sum-of-the-parts
description: Value a company one stream at a time — each part on its own forward figure and its own multiple, added up and bridged to equity via net cash
argument-hint: [SYMBOL]

## When to use this instead of the DCF or comps skills

Reach for this when the company is not one business, and a single multiple would
average away the judgment the reader actually needs:

1. **Streams with different economics under one ticker** — a declining
   subscription line beside a fast-growing licensing line. One blended EV/Sales
   implicitly claims both deserve the same multiple, which is the one thing you
   know is false.
2. **Revenue that is not all worth the same** — most sharply, revenue that is not
   cash. CuriosityStream books content-for-content barter swaps as licensing
   revenue: roughly a quarter of its revenue, near-100% gross margin, and no cash
   ever changes hands. A parts model can carry that at the zero it is worth and
   *show* the reader it did. A blended multiple cannot.
3. **A business whose reported profit carries no information but whose split is
   disclosed** — where you cannot discount an earnings stream (comps case 2) and
   cannot pick one peer multiple either, but the 10-Q does tell you how revenue
   divides.

Do **not** use it when the parts are not separately disclosed — an allocation you
invented is not evidence, and a two-part model built on a guessed split is worse
than an honest single multiple. If the business really is one business, the
`comps` skill is the better tool; if it has a durable forecastable cash-flow
stream, use `dcf`.

## Method

1. **Split the business** along the lines the filings actually disclose. Name each
   part and say what it is being compared against.
2. **Anchor a forward figure per part** (a target fiscal year, e.g. FY2027) —
   usually revenue, because a parts model is normally reached for when segment
   profit is not disclosed.
3. **Choose a multiple per part**, on its own merits. A part may be carried at
   zero; that is a result, not a gap.
4. **Add the parts**, apply flat `adjustments` for non-operating assets and
   debt-like items, add net cash, divide by diluted shares.
5. **Scenario-weight** bear / base / bull, varying figures *and* multiples
   jointly, then probability-weight into a single fair value.

### The trap: do not double-count overhead

Peer EV/Sales multiples already embed a normal corporate cost base — the peers
have head offices too. If you value each part at a peer multiple *and* then
subtract capitalised corporate overhead, you have charged for it twice. Either
choose part multiples that already reflect the company's cost structure (and say
so in the notes), or value parts on a profit figure after allocating costs. The
`adjustments` list is for non-operating items — investments, leases,
underfunded obligations — not for running costs.

## Run the calculation (parity oracle)

```bash
python3 skills/sum-of-the-parts/scripts/sotp_calculator.py skills/sum-of-the-parts/reference/inputs/{SYMBOL}.json
```

This is the non-browser reference implementation of `docs/assets/sotp.js`; the
two must agree. To publish a dated report:

```bash
python3 scripts/generate_report.py {SYMBOL} --date {YYYY-MM-DD}
```

## Input file format

`skills/sum-of-the-parts/reference/inputs/{SYMBOL}.json`

**Large numbers:** K/M/B/T suffixes (`"27M"`). **Multiples:** plain numbers
(`2.5` = 2.5×). `net_cash` and any `adjustments` amount may be negative.

Three optional strings control the page prose — `parts_intro` (step 1),
`figures_intro` (step 2) and `fundamentals_source` (where the forward figures
come from). Set them whenever the generic defaults would be vague.

```json
{
  "symbol": "CURI",
  "method": "sotp",
  "anchor": "FY2027",
  "balance_sheet": { "net_cash": "10.9M", "diluted_shares": "61.5M" },
  "parts": [
    { "key": "licensing_cash", "name": "Content & data licensing — cash",
      "basis": "revenue", "comparable": "Content libraries 2–3×",
      "note": "what this part is" }
  ],
  "adjustments": [
    { "key": "leases", "name": "Operating lease liabilities (debt-like)",
      "amount": "-3.7M", "comment": "…" }
  ],
  "scenarios": [
    { "name": "Base", "probability": 0.45, "comment": "…",
      "parts": { "licensing_cash": { "amount": "27M", "multiple": 2.5 } } }
  ]
}
```

Rules:
- `parts` is the ordered list of definitions; each needs a unique `key`.
- `scenarios` is non-empty and each carries `probability` (sum `1.0` or `100`).
- A scenario's `parts` map supplies `{ amount, multiple }` per key, overriding
  any top-level default on the definition; `adjustments` is a flat
  `{ key: amount }` override map.
- `basis` (`revenue`, `ebitda`, `ebit`, `gross_profit`, `fcf`, `book`) only picks
  the display label for the multiple — the arithmetic is always amount ×
  multiple. `multiple_label` overrides it.

## Notes (evaluation) file format

`skills/sum-of-the-parts/reference/notes/{SYMBOL}.json` — a `drivers[]` array of
`{ key, label, verdict, comment }`, one per input. The `verdict` renders as a
pill beside the label, so it should be a short honest grade ("weak evidence",
"the crux", "poor"), not a rating.

A parts model must carry two drivers beyond the per-part reads:

- **`probability`** — as in every method here, an honest read on the weights.
  Parts models tend to produce very wide scenario ranges, so say plainly how much
  of the answer the weights are doing.
- **A read on how much the multiples are constraining anything.** If the peer
  range for the swing part spans four-fold, say so and frame the fair value as a
  function of the chosen multiple rather than pretending to a point estimate.

## Optional: what the price leaves over

A `market` block lets the report run backwards. It never feeds the fair value,
which is computed before the price is read, and it renders as a trailing section.

```json
"market": { "price": 3.99, "as_of": "2026-08-13",
            "solve_for": "licensing_cash", "commentary": "…" }
```

`solve_for` names the part that swings the answer. The engine takes the traded
price, credits every *other* part, the adjustments and net cash at your own
figures, and reads the residual two ways: the multiple the price implies on your
forward figure, and the forward figure the price implies at your multiple. This
is the natural reverse for a parts model — it does not ask "is the whole company
cheap", it asks "what is the market paying for the one piece nobody can size".

## Optional: the action band

An `action` block turns the fair value into a decision rule — accumulate below X,
trim above Y. The two levels render **beside the fair value at the top of the
page**, either side of the number they are a fraction of. The reasoning behind
them — and the only mention of the traded price — renders in a trailing section
after the valuation.

```json
"action": {
  "confidence": "low",
  "buy_below": "Bear",
  "trim_above": 1.4,
  "rationale": "why these levels and not others",
  "review": "what would make this band wrong"
}
```

- `confidence` (`high` / `medium` / `low`) is the only required field. The
  discounts it maps to — 85/125, 75/135, 60/150 percent of fair value — live in
  `docs/assets/action.js`, not in the input. A report declares how good its
  inputs are and takes the discount that earns; it cannot award itself a
  narrower one.
- `buy_below` and `trim_above` are each either a **fraction of this report's own
  fair value** (0–3) or the **name of one of its scenarios**. An absolute share
  price is refused with an error — that refusal is the safeguard.
- Set the tier from the notes `drivers[]`, not from a feeling about the stock.
  If a driver's verdict reads "weak evidence" or "the crux", the report is
  `low` — and prefer a scenario name to a fraction there, since a fraction of a
  probability-weighted value inherits the weakness of the weights.
- Always write `rationale` and `review`. A band with no stated reason is a
  number, not a rule, and `review` is what makes it falsifiable.

Full spec — fallback keywords, the tier table, a worked example, and how to
resolve a band from the command line: `skills/shared/action-band.md`.

## Key formulas

| Formula | Description |
|---------|-------------|
| EV_part = figure × multiple | One part's contribution to enterprise value |
| EV = Σ EV_part + Σ adjustments | Parts plus non-operating items |
| Equity = EV + net cash | EV → equity bridge (net cash = cash − debt) |
| Per share = Equity / diluted shares | The scenario's value |
| Fair value = Σ probability × per share | Probability-weighted fair value |
| Residual = (price × shares) − net cash − adjustments − Σ EV_other | What the price leaves for the swing part |

The fair value is always derived without reference to a market price.
