# DCF Valuation Skill

name: dcf
description: DCF (Discounted Cash Flow) valuation model for stocks using FCFF methodology
argument-hint: [SYMBOL]

## Instructions

When invoked with `/dcf [SYMBOL]`:

### 1. Check Local Data Freshness

**Check all existing data files and their timestamps:**

```bash
# Check what data exists
ls -la .claude/skills/dcf/reference/inputs/{SYMBOL}.json 2>/dev/null
ls -la .claude/skills/dcf/reference/quotes/{SYMBOL}_quote.json 2>/dev/null
ls -la .claude/skills/dcf/reference/news/{SYMBOL}_news_7d.json 2>/dev/null
ls -la .claude/skills/dcf/reference/sec_filings/{SYMBOL}/{SYMBOL}_filings_index.json 2>/dev/null
```

**Data Freshness Rules:**

| Data Type | File Location | Freshness Threshold | Update When |
|-----------|---------------|---------------------|-------------|
| **Inputs** | `reference/inputs/{SYMBOL}.json` | Manual only | User requests or missing |
| **Quotes** | `reference/quotes/{SYMBOL}_quote.json` | 1 day | File missing or > 1 day old |
| **News** | `reference/news/{SYMBOL}_news_7d.json` | 1 day | File missing or > 1 day old |
| **SEC Filings** | `reference/sec_filings/{SYMBOL}/` | 6 months | Folder missing or latest filing > 6 months old |

**Auto-update without asking if:**
- Quotes are > 1 day old → run `python .claude/skills/dcf/scripts/fetch_quotes.py {SYMBOL}`
- News is > 1 day old → run `python .claude/skills/dcf/scripts/fetch_news.py {SYMBOL}`
- SEC filings missing or > 6 months → run `python .claude/skills/dcf/scripts/fetch_sec_filings.py {SYMBOL} --form 10-K --limit 2`

### 2. Handle Missing Inputs

If `reference/inputs/{SYMBOL}.json` does NOT exist, ask user to choose:
- **Option A**: Auto-fetch from Finnhub (requires `FINNHUB_API_KEY`)
- **Option B**: Create blank template for manual input

For Option A:
```bash
python .claude/skills/dcf/scripts/fetch_inputs.py {SYMBOL}
```

For Option B, create template with all fields set to `null` and ask user to fill in.

### 3. Run DCF Calculation

```bash
python .claude/skills/dcf/scripts/dcf_calculator.py .claude/skills/dcf/reference/inputs/{SYMBOL}.json
```

**Display the COMPLETE output**.

- **Single-scenario mode** (no `scenarios` in JSON):
  - Standard DCF report with WACC, forecast table, terminal value, valuation bridge, sensitivity analysis.
- **Multi-scenario mode** (`scenarios` exists in JSON):
  - First print probability-weighted summary table:
    - scenario name
    - probability
    - scenario WACC
    - scenario terminal growth
    - scenario intrinsic price
    - weighted contribution
  - Then print full detailed report for each scenario.

### 4. Display Supporting Data

**IMPORTANT: Always display ALL available supporting data for context.**

#### 4.1 Current Market Quote

Read and display the quote with interpretation:

```bash
cat .claude/skills/dcf/reference/quotes/{SYMBOL}_quote.json
```

Show:
- Current price (`c`)
- Change (`d`) and % change (`dp`)
- Day high/low (`h`/`l`)
- Previous close (`pc`)
- Calculate **Valuation Gap**:
  - Single-scenario: `(Market Price - DCF Price) / DCF Price × 100%`
  - Multi-scenario: `(Market Price - ProbabilityWeightedPrice) / ProbabilityWeightedPrice × 100%`

#### 4.2 Recent News (Last 7 Days)

```bash
cat .claude/skills/dcf/reference/news/{SYMBOL}_news_7d.json
```

**When interpreting news, highlight items related to:**
- Earnings reports
- Product launches (AI, Cloud)
- Regulatory issues (antitrust)
- Major partnerships or acquisitions

#### 4.3 SEC Filings

```bash
cat .claude/skills/dcf/reference/sec_filings/{SYMBOL}/{SYMBOL}_filings_index.json
```

Show:
- Filing type (10-K, 10-Q)
- Filed date
- Reporting period
- Direct link to HTML report

**Note**: Check if the most recent 10-K aligns with the DCF base year assumptions.

### 5. Comprehensive Interpretation

Provide detailed analysis covering:

#### Valuation Assessment
- **Market Price vs DCF**:
  - Single-scenario: premium/discount vs single intrinsic value
  - Multi-scenario: premium/discount vs probability-weighted intrinsic value
- **Implied Growth Rate**: What terminal growth would justify current price?
- **Sensitivity**: Show which assumption changes would close the gap

#### Context from Supporting Data
- **Recent News Impact**: Any material events affecting valuation?
- **Financial Health**: Cash position, debt levels from balance sheet
- **Filing Insights**: Recent 10-K trends (revenue growth, margin changes)

#### Investment Perspective
- **Bull Case**: Scenarios where market price is justified
- **Bear Case**: Risks not captured in DCF model
- **Assumption Review**: Are growth rates, margins, WACC reasonable given recent news?

## Fetch Commands Reference

```bash
# Update quotes (if > 1 day old)
python .claude/skills/dcf/scripts/fetch_quotes.py {SYMBOL}

# Update news (if > 1 day old)
python .claude/skills/dcf/scripts/fetch_news.py {SYMBOL}

# Update SEC filings (if > 6 months old)
python .claude/skills/dcf/scripts/fetch_sec_filings.py {SYMBOL} --form 10-K --limit 2
```

## Input File Format

**Large numbers:** Use suffixes K/M/B/T (e.g., `"350B"` = $350 billion)
**Percentages:** Use decimals (e.g., `0.28` = 28%)
**Capex:** `capex_percent` can be a single number or a list matching `growth_rates` length.

### Mode A: Single Scenario (legacy compatible)

Example:
```json
{
  "symbol": "GOOGL",
  "base_year": {"revenue": "350B", "ebit_margin": 0.28, ...},
  "assumptions": {"tax_rate": 0.21, "growth_rates": [0.12, 0.10, ...], ...},
  "wacc_inputs": {"risk_free_rate": 0.045, "beta": 1.05, ...},
  "terminal": {"growth_rate": 0.025},
  "balance_sheet": {"cash": "120B", "debt": "15B", "diluted_shares": "12.5B"}
}
```

### Mode B: Probability-Weighted Multi-Scenario

Use one JSON file with top-level defaults plus `scenarios`.

Rules:
- `scenarios` must be a non-empty list
- each scenario must include `probability`
- probabilities can sum to `1.0` or `100`
- each scenario can provide **partial overrides** for:
  - `base_year`
  - `assumptions`
  - `wacc_inputs`
  - `terminal`
  - `balance_sheet`
- missing fields in scenario are inherited from top-level defaults

Example:
```json
{
  "symbol": "GOOGL",
  "base_year": {"revenue": "350B", "ebit_margin": 0.32, "da_percent": 0.05, "capex_percent": 0.15, "nwc_percent": 0.15},
  "assumptions": {"tax_rate": 0.21, "growth_rates": [0.11, 0.10, 0.09, 0.08, 0.07, 0.06, 0.05, 0.04, 0.03, 0.03], "ebit_margins": [0.32, 0.322, 0.324, 0.326, 0.328, 0.33, 0.333, 0.336, 0.338, 0.34]},
  "wacc_inputs": {"risk_free_rate": 0.041, "equity_risk_premium": 0.042, "beta": 1.10, "cost_of_debt": 0.048, "debt_weight": 0.03, "equity_weight": 0.97},
  "terminal": {"growth_rate": 0.03},
  "balance_sheet": {"cash": "195.53B", "debt": "46.547B", "diluted_shares": "12.097B"},
  "scenarios": [
    {"name": "Bear", "probability": 0.25, "terminal": {"growth_rate": 0.025}, "wacc_inputs": {"beta": 1.15}},
    {"name": "Base", "probability": 0.50},
    {"name": "Bull", "probability": 0.25, "terminal": {"growth_rate": 0.035}, "wacc_inputs": {"beta": 1.00}}
  ]
}
```

## Data File Formats

### Quotes File (`reference/quotes/{SYMBOL}_quote.json`)

```json
{
  "symbol": "GOOGL",
  "fetched_at": "2026-01-31T08:18:11.118337",
  "quote": {
    "c": 338,           // Current price
    "d": -0.25,         // Change
    "dp": -0.0739,      // Percent change
    "h": 340,           // Day high
    "l": 332.285,       // Day low
    "o": 340,           // Open price
    "pc": 338.25,       // Previous close
    "t": 1769806800     // Timestamp (Unix epoch)
  }
}
```

### News File (`reference/news/{SYMBOL}_news_7d.json`)

```json
{
  "symbol": "GOOGL",
  "fetched_at": "2026-01-31T08:18:15.289717",
  "days": 7,
  "count": 248,
  "news": [           // Note: uses "news" not "articles"
    {
      "category": "company",
      "datetime": 1769815571,        // Unix timestamp
      "headline": "Google defeats bid...",
      "id": 138311291,
      "image": "https://...",
      "related": "GOOGL",
      "source": "Yahoo",
      "summary": "Full article summary...",
      "url": "https://..."
    }
  ]
}
```

### SEC Filings File (`reference/sec_filings/{SYMBOL}/{SYMBOL}_filings_index.json`)

```json
{
  "symbol": "GOOGL",
  "fetched_at": "2026-01-31T08:08:27.328079",
  "count": 2,
  "filings": [
    {
      "accessNumber": "0001652044-25-000014",
      "symbol": "GOOGL",
      "cik": "1652044",
      "form": "10-K",
      "filedDate": "2025-02-05 00:00:00",
      "acceptedDate": "2025-02-04 20:41:40",
      "reportUrl": "https://www.sec.gov/Archives/...",
      "filingUrl": "https://www.sec.gov/Archives/..."
    }
  ]
}
```

## Publish a dated report

The calculator above is the parity oracle for `docs/assets/dcf.js`; the two must
agree. To freeze a dated report page from the current reference JSON:

```bash
python3 scripts/generate_report.py {SYMBOL} --date {YYYY-MM-DD}
```

This writes `docs/reports/{symbol}/{date}.html` and its snapshot `.json`, updates
the manifest and rebuilds the landing page. Editing the reference input prepares
the *next* date's report; it never alters an already-published one.

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

A DCF report headlines with its scenario table and normally has no fair-value
band. The generator adds one **only** when the input carries an `action`, so the
levels have the probability-weighted value to stand beside; reports without a
band keep the markup they were published with.

Full spec — fallback keywords, the tier table, a worked example, and how to
resolve a band from the command line: `skills/shared/action-band.md`.

## Key Formulas

| Formula | Description |
|---------|-------------|
| FCFF = NOPAT + D&A - Capex - ΔNWC | Free Cash Flow to Firm |
| WACC = We × Re + Wd × Rd × (1 - T) | Weighted Average Cost of Capital |
| Re = Rf + β × ERP | Cost of Equity (CAPM) |
| TV = FCFF_n × (1 + g) / (WACC - g) | Terminal Value (Gordon Growth) |
| PV = FCFF_n / (1 + WACC)^(n − 0.5) | Discount to present (mid-year convention) |
| PV(TV) = TV / (1 + WACC)^(N − 0.5) | Terminal value discounted at final mid-year factor |
| Intrinsic Price = (EV + Cash - Debt) / Shares | Price per Share |

**Mid-year convention:** cash flows are assumed to arrive half-way through each
year (the realistic average), so year *n* is discounted at *n − 0.5* rather than
*n*. This lifts value by ≈ (1 + WACC)^0.5 (~4% at an 8% WACC) versus year-end
discounting, and matches standard banking/Damodaran practice.
