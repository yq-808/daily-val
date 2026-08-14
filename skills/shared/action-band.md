# The action band

Shared by all three valuation methods (`dcf`, `comps`, `sotp`). The engine is
`docs/assets/action.js`; it is loaded only on report pages whose input carries an
`action` block.

A valuation answers "what is this worth". The band answers the only other
question worth writing down before a decision: **at what price would I act, and
how sure am I.** It is a note to self about one stock on one day.

## Where it renders

Two places, and the split is the point.

1. **The levels — beside the fair value, at the top of the page.** `Accumulate
   below` and `Trim above` sit inside the report's fair-value band, either side
   of the value they are a fraction of. A discount and a premium mean nothing
   without the number they are a discount and a premium *to*, and a reader who
   takes only the headline should take the whole rule with it.
2. **The reasoning — in a trailing section, after the valuation.** Confidence in
   the inputs, why the levels sit where they do, which side of them the traded
   price falls on, and what would make the band wrong.

The traded price appears only in (2). That is what keeps the band inside the
project's price rule: the levels are derived from the report's own figures, and
the price is read afterwards, once, to say where it sits.

A DCF report normally headlines with its scenario table and has no fair-value
band; the generator adds one **only** when the input carries an `action`, so the
levels have a value to stand beside. Reports without a band are unchanged.

## Input schema

Add to `skills/<method>/reference/inputs/<SYM>.json`:

```json
"action": {
  "confidence": "low",
  "buy_below": "Bear",
  "trim_above": 1.4,
  "rationale": "why these levels and not others",
  "review": "what would make this band wrong",
  "confidence_note": "optional — overrides the tier's stock wording"
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `confidence` | yes | `high`, `medium` or `low` — how well this report's inputs stand up |
| `buy_below` | no | Level spec; defaults to the tier's accumulate fraction |
| `trim_above` | no | Level spec; defaults to the tier's trim fraction |
| `rationale` | no | One sentence on why the levels sit here |
| `review` | no | The observation that would move the band |
| `confidence_note` | no | Replaces the tier's default wording |

A **level spec** is one of:

- a **fraction of this report's own fair value**, `0 < f <= 3` (`0.75` = 75% of
  fair value), or
- the **name of one of this report's scenarios** (`"Bear"`, `"Base"`, `"Bull"`),
  matched case-insensitively. `bear`/`low`/`worst` fall back to the bottom of the
  scenario spread and `bull`/`high`/`best` to the top when nothing is named that;
  `base` falls back to the likeliest case.

Anything outside that — most of all an absolute share price — is **refused by the
engine with an error**. That refusal is the whole safeguard: a level can never be
reverse-engineered from what the stock happens to cost.

## Confidence tiers

The discounts live in `action.js`, not in the input. A report declares how good
its inputs are and takes the discount that earns; it cannot award itself a
narrower one.

| Tier | Accumulate | Trim | When it applies |
|------|-----------:|-----:|-----------------|
| `high` | 85% of FV | 125% of FV | Every driver supported by filed figures; scenarios bracket a narrow range |
| `medium` | 75% of FV | 135% of FV | Main drivers defensible, but at least one judgment call moves the answer |
| `low` | 60% of FV | 150% of FV | A crux driver rests on weak evidence, or the weights do more work than the evidence |

Set the tier from the notes `drivers[]`, not from how you feel about the stock.
If a driver's verdict reads "weak evidence" or "the crux", the report is `low`.

## Rules

- **Match the tier to the notes.** A `high` band on a report whose crux driver
  reads "weak evidence" is the failure mode this design exists to prevent.
- **Prefer a scenario name to a fraction when the scenarios are wide.** If the
  probability weights are the weakest input, a fraction of the weighted value
  inherits that weakness; `"buy_below": "Bear"` does not.
- **Write `rationale` and `review`.** A band with no stated reason is a number,
  not a rule. `review` is what makes it falsifiable.
- **One report, one band.** A band is that day's idea about that stock. Never
  roll bands up across reports, never surface one on the landing page, and never
  hand-edit a published snapshot to move one — write a new dated report.
- **The prose stays dated.** A published snapshot is immutable, so the page says
  what the figures supported *on that date*. It must never read as a live
  instruction.

## Worked example — CURI, 2026-08-15

```json
"action": {
  "confidence": "low",
  "buy_below": "Bear",
  "rationale": "The crux driver reads weak evidence and the cash-licensing multiple spans 1.5x to 5.0x, which alone moves the answer four-fold; the notes call the scenario weights the weakest input in the report. So the accumulate level is the bear case itself, not a discount to a weighted value those weights produced.",
  "review": "First-half cash licensing turns up against the prior year, or barter stops growing as a share of revenue."
}
```

Fair value $2.25, scenarios $1.07 / $1.84 / $4.39. The band resolves to
**accumulate below $1.07** (the bear case) and **trim above $3.38** (150% of fair
value, the `low` tier's default, since `trim_above` was not given).

## Checking a band without a browser

`action.js` exports for Node, so a band can be resolved from the command line —
useful when the level you wrote is a scenario name and you want to see the number
it lands on:

```bash
node -e 'const A=require("./docs/assets/action.js");
const i=require("./skills/sum-of-the-parts/reference/inputs/CURI.json");
console.log(A.evaluate(i.action,[{name:"Bear",probability:.3,value:1.07},
{name:"Base",probability:.45,value:1.84},{name:"Bull",probability:.25,value:4.39}],2.25,i.market));'
```

It reads the engine's output and feeds nothing back, so unlike the valuation
engines it needs no Python parity oracle.
