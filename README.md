# daily-val

Dated, back-of-the-envelope **intrinsic-value reports** for stocks — one HTML
page per stock, per date, published as a static site via GitHub Pages.

Each report's fair value is computed **without reference to the market price**.
The page ships the *inputs* and computes the value in your browser, so the
numbers on the page are always a live function of the assumptions it carries.

A report may additionally carry an **implied-expectations** section, which runs
the model backwards — taking the traded price as given and solving for the
multiple or growth path you would have to believe to justify it. It sits after
the valuation and never feeds into it.

Two methods share one pipeline, selected by the input's `method` field: a
**DCF** (FCFF) for durable compounders, and a **relative comps** model
(peer/re-rating multiples — P/E, EV/EBITDA, P/B, EV/Sales, EV/FCF on a
forward metric)
for cyclicals and "new-paradigm" re-ratings where a smooth cash-flow stream is a
poor fit (e.g. MU). Both obey the same rules below.

## Every report is a frozen daily snapshot

The whole point of the name: **each report is a static, self-contained copy of
its own data on the day it was generated.** A published report never changes when
the shared reference JSON is later refreshed. Concretely, each run freezes:

- the **inputs** — base-year facts, per-scenario assumptions, and the **scenario
  probabilities**; and
- the **evaluation notes** — the plain-English "how defensible" read on every
  input, *including the read on the probabilities themselves*.

Both are written to a snapshot file, `docs/reports/<symbol>/<date>.json`
(`{ input, notes }`), and embedded into the report HTML. The reference files
under `skills/dcf/reference/` are just the mutable working drafts you edit before
generating tomorrow's report; the snapshot is the copy of record.

## Layout

```
daily-val/
├── CLAUDE.md                    # project rules (reports are static daily snapshots)
├── skills/
│   ├── dcf/                     # DCF (FCFF) valuation skill + engine
│   │   └── reference/
│   │       ├── inputs/<SYM>.json   # working-draft inputs (mutable)
│   │       └── notes/<SYM>.json    # working-draft evaluation notes (mutable)
│   ├── relative-comps/          # Peer-multiple (comps) valuation skill + engine
│   │   └── reference/{inputs,notes}/<SYM>.json  # comps working drafts (mutable)
│   └── megawatt-pe-valuation/   # Earnings × P/E model for power / AI-infra
├── scripts/
│   └── generate_report.py       # freezes a dated snapshot + page, rebuilds the index
└── docs/                        # ← GitHub Pages site root (serve from main /docs)
    ├── index.html               # landing page, lists every report by stock & date
    ├── assets/
    │   ├── style.css
    │   ├── dcf.js               # client-side DCF engine (port of the dcf skill)
    │   └── comps.js             # client-side comps engine (port of relative-comps)
    └── reports/
        ├── manifest.json        # reports + their embedded inputs + snapshot paths
        └── <symbol>/
            ├── <date>.json      # frozen data copy of record ({ input, notes })
            └── <date>.html      # the report page (inputs+notes embedded, math in JS)
```

## Generate a report

```bash
# defaults to today's date
python3 scripts/generate_report.py AAPL

# or pin the date on the page
python3 scripts/generate_report.py AAPL --date 2026-07-15
```

The generator does **no** financial math. Each run freezes the symbol's input
JSON *and* its evaluation notes into `docs/reports/<symbol>/<date>.json`, embeds
the same data into `docs/reports/<symbol>/<date>.html`, records the run in
`docs/reports/manifest.json`, and rebuilds `docs/index.html`. The valuation
tables and the probability-weighted value are computed in the browser by the
method's engine — [`docs/assets/dcf.js`](docs/assets/dcf.js) or
[`docs/assets/comps.js`](docs/assets/comps.js), faithful ports of the matching
skill's Python engine. To post a report for a new date, run the command again
with a new `--date` and commit.

The symbol must have an input file under a reference root the generator knows:
`skills/dcf/reference/inputs/<SYMBOL>.json` (GOOGL, MSFT, AAPL) or
`skills/relative-comps/reference/inputs/<SYMBOL>.json` (MU), each with an optional
`notes/<SYMBOL>.json` evaluation sidecar. The input's `method` field (`"comps"`,
or absent for DCF) selects the engine. Refreshing the underlying financials for
the DCF skill uses its own `fetch_*.py` scripts and requires an API key
(`FINNHUB_API_KEY` in a gitignored `.env`).

## Publishing with GitHub Pages

The repo is **public** and GitHub Pages serves from `main` `/docs`, so the live
site is:

**https://yq-808.github.io/daily-val/**

Pushing to `main` redeploys it automatically.

## Disclaimer

Not investment advice. These are personal modeling exercises — a DCF is only as
good as its assumptions — not recommendations to buy or sell any security.
