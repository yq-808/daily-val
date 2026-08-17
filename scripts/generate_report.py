#!/usr/bin/env python3
"""Generate a dated valuation report page and refresh the site index.

Usage:
    python scripts/generate_report.py GOOGL                  # dated today
    python scripts/generate_report.py GOOGL --date 2026-07-13

This generator does **no** financial math. Each report page ships the DCF
*inputs* (the scenario JSON) embedded in the page; the valuation table and the
probability-weighted intrinsic value are computed in the browser by
docs/assets/dcf.js — a faithful port of the dcf skill's engine. The pages are
valuation-only: there is no market price anywhere.

Every report is a **static daily snapshot**: each run freezes its own copy of
the inputs (including the scenario probabilities) *and* their evaluation notes,
so a published report never changes when the shared reference JSON is later
refreshed for a new date.

Each run:
  1. reads skills/dcf/reference/inputs/<SYMBOL>.json (+ notes sidecar),
  2. writes docs/reports/<symbol>/<date>.json — the frozen data copy of record
     ({input, notes}), the report's own inspectable snapshot,
  3. writes docs/reports/<symbol>/<date>.html (inputs+notes embedded, math in JS;
     the input's "method" selects the engine — dcf, comps, sotp or opleverage),
  4. records the run (inputs + snapshot path) in docs/reports/manifest.json,
  5. rebuilds docs/index.html, which computes each report's intrinsic in JS.
"""

import argparse
import datetime as dt
import json
import sys
from html import escape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DCF_REF = ROOT / "skills" / "dcf" / "reference"
COMPS_REF = ROOT / "skills" / "relative-comps" / "reference"
SOTP_REF = ROOT / "skills" / "sum-of-the-parts" / "reference"
OPLEV_REF = ROOT / "skills" / "operating-leverage" / "reference"
# Where the generator looks up a symbol's working-draft inputs + notes. The
# input's own "method" field selects the client-side engine; the reference file
# can live under either skill's reference tree.
REF_ROOTS = [DCF_REF, COMPS_REF, SOTP_REF, OPLEV_REF]
DOCS = ROOT / "docs"
REPORTS_DIR = DOCS / "reports"
MANIFEST = REPORTS_DIR / "manifest.json"

# Per-method conventions line (shown on each page + frozen in the snapshot).
DCF_CONVENTIONS = "Mid-year discounting convention. Valuation only — no live market price is used."
COMPS_CONVENTIONS = "Peer-multiple relative valuation — fair value is the average of the per-multiple implied prices. Valuation only — no live market price is used."
# When an input carries a `market` block the page also runs the model backwards
# to explain the traded price. The fair value is still derived without it, so the
# conventions line has to say precisely that rather than claim no price is shown.
COMPS_REVERSE_CONVENTIONS = (
    "Peer-multiple relative valuation — fair value is the average of the per-multiple "
    "implied prices, computed without reference to any market price. The market price "
    "appears only in the implied-expectations sections, which run the model backwards "
    "to explain it; it is never an input to the valuation."
)
SOTP_CONVENTIONS = (
    "Sum-of-the-parts — each stream valued on its own forward figure and its own "
    "multiple, added up, then bridged to equity via net cash. Valuation only — no "
    "live market price is used."
)
SOTP_REVERSE_CONVENTIONS = (
    "Sum-of-the-parts — each stream valued on its own forward figure and its own "
    "multiple, added up and bridged to equity via net cash, computed without "
    "reference to any market price. The market price appears only in the closing "
    "section, which subtracts the other parts to read off what is left over for "
    "the one that swings; it is never an input to the valuation."
)


OPLEV_CONVENTIONS = (
    "Operating leverage — earnings are not assumed but built, from a revenue "
    "level and a gross margin less a dollar cost base, then carried at a "
    "multiple. Valuation only — no live market price is used."
)
OPLEV_REVERSE_CONVENTIONS = (
    "Operating leverage — earnings are not assumed but built, from a revenue "
    "level and a gross margin less a dollar cost base, then carried at a "
    "multiple, all computed without reference to any market price. The market "
    "price appears only in the closing section, which runs the same bridge "
    "backwards to read off the margin or the revenue it would require; it is "
    "never an input to the valuation."
)


def is_oplev(data):
    return isinstance(data, dict) and data.get("method") == "opleverage"


def is_comps(data):
    return isinstance(data, dict) and data.get("method") == "comps"


def is_sotp(data):
    return isinstance(data, dict) and data.get("method") == "sotp"


ACTION_CONVENTIONS = (
    " The accumulate/trim levels beside the fair value are derived from that "
    "value — a discount and a premium to this report's own figures — and never "
    "from a market price."
)


def conventions_for(data):
    return _base_conventions(data) + (ACTION_CONVENTIONS if data.get("action") else "")


def _base_conventions(data):
    if is_oplev(data):
        return OPLEV_REVERSE_CONVENTIONS if data.get("market") else OPLEV_CONVENTIONS
    if is_sotp(data):
        return SOTP_REVERSE_CONVENTIONS if data.get("market") else SOTP_CONVENTIONS
    if is_comps(data):
        return COMPS_REVERSE_CONVENTIONS if data.get("market") else COMPS_CONVENTIONS
    return DCF_CONVENTIONS


def action_levels(data, mount_id):
    """The two levels themselves, mounted inside the fair-value band.

    They belong beside the value, not at the foot of the page: a discount and a
    premium mean nothing without the number they are a fraction of, and a reader
    who takes only the headline should take the whole rule with it. Only the
    levels go here — the confidence, the reasoning and anything the traded price
    touches stay in the trailing section, after the valuation.
    """
    if not data.get("action"):
        return ""
    return f'\n    <div class="fv-levels" id="{mount_id}-levels"></div>'


def action_section(data, date_str, mount_id):
    """The reasoning behind the levels — rendered only when the input carries
    `action`.

    It sits last, after the valuation and after any market/expectations section,
    because it is the part a price may touch. The prose has to carry the dated
    framing: a published snapshot is immutable, so a band written today would
    otherwise still read as a live instruction a year from now.
    """
    if not data.get("action"):
        return ""
    return f"""
  <section>
    <h2>Why the band sits there</h2>
    <p class="meta">The accumulate and trim levels at the top of this page are
    set from the fair value and from how well this report's own inputs stand up
    — never from the quote. Weak inputs earn a wider discount before acting, and
    that mapping is fixed in the engine, so a report cannot award itself a level
    that happens to clear the price. This is what the figures supported on
    {date_str}; a later report with different figures gets a different band.</p>
    <div id="{mount_id}"></div>
  </section>
"""


def action_script(data):
    """Load the shared action engine only on pages that carry a band."""
    return '\n<script src="../../assets/action.js"></script>' if data.get("action") else ""


def resolve_ref(kind, symbol):
    """Find a symbol's <kind>/<SYMBOL>.json across the known reference roots."""
    for root in REF_ROOTS:
        path = root / kind / f"{symbol}.json"
        if path.exists():
            return path
    return None


# --------------------------------------------------------------------------- #
# Data loading
# --------------------------------------------------------------------------- #
def load_json(path):
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def method_for(data):
    """Human label for the model type — derivable without running the engine."""
    if is_oplev(data):
        anchor = data.get("anchor")
        return "Operating leverage — earnings-power bridge" + (f" ({anchor})" if anchor else "")
    if is_sotp(data):
        anchor = data.get("anchor")
        return "Sum of the parts" + (f" ({anchor})" if anchor else "")
    if is_comps(data):
        anchor = data.get("anchor")
        return "Relative valuation — peer multiples" + (f" ({anchor})" if anchor else "")
    if data.get("scenarios"):
        return "DCF — FCFF, probability-weighted scenarios"
    return "DCF — FCFF, single scenario"


def embed_json(data):
    """Serialize input for safe embedding inside a <script> element."""
    return json.dumps(data).replace("</", "<\\/")


# --------------------------------------------------------------------------- #
# HTML rendering — pages carry inputs only; dcf.js fills the numbers.
# --------------------------------------------------------------------------- #
def render_report(symbol, data, date_str, notes=None, snapshot_name=None):
    sym = escape(symbol)
    method = escape(method_for(data))
    notes = notes or {}
    snapshot_name = snapshot_name or f"{date_str}.json"

    drivers_section = ""
    if notes.get("drivers"):
        drivers_section = """
  <section>
    <h2>Assumptions &amp; how defensible</h2>
    <div id="dcf-drivers"></div>
  </section>
"""

    consensus_section = ""
    if data.get("consensus"):
        consensus_section = """
  <section>
    <h2>Street consensus — same engine</h2>
    <p class="meta">Analyst-consensus forecast run through the same DCF, for comparison — not part of the probability-weighted value above.</p>
    <div id="dcf-consensus"></div>
  </section>
"""

    wacc_section = ""
    if data.get("wacc_sensitivity"):
        wacc_section = """
  <section>
    <h2>Discount-rate sensitivity</h2>
    <p class="meta">Each scenario's intrinsic value at a range of uniform discount rates, holding all cash-flow assumptions fixed. Terminal value dominates, so WACC is the single biggest swing factor.</p>
    <div id="dcf-wacc"></div>
  </section>
"""

    buyback_section = ""
    if data.get("buyback"):
        buyback_section = """
  <section>
    <h2>Buyback &amp; share count</h2>
    <p class="meta">How the per-share figure moves as the share count shrinks — shown for completeness, with an important caveat below.</p>
    <div id="dcf-buyback"></div>
  </section>
"""

    act_levels = action_levels(data, "dcf-action")
    act_section = action_section(data, date_str, "dcf-action")
    # A DCF report headlines with its scenario table, so it has no fair-value
    # band — except when it carries an action block, which needs the value the
    # levels are a fraction of standing right next to them.
    fv_band = f"""
  <section class="fairvalue-band">
    <span class="fv-label">Fair value \u00b7 probability-weighted</span>
    <span class="fv-value" id="dcf-fairvalue">\u2026</span>{act_levels}
  </section>
""" if data.get("action") else ""
    act_script = action_script(data)
    notes_script = ""
    if notes:
        notes_script = f'\n<script type="application/json" id="dcf-notes">{embed_json(notes)}</script>'

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{sym} valuation — {date_str} · daily-val</title>
<link rel="stylesheet" href="../../assets/style.css">
</head>
<body>
<main class="wrap">
  <p class="crumb"><a href="../../index.html">← All reports</a></p>

  <header class="rpt-head">
    <div>
      <h1>{sym} <span class="sub">valuation</span></h1>
      <p class="meta" id="dcf-method">{method}</p>
    </div>
    <div class="date-badge">{date_str}</div>
  </header>
{fv_band}
  <section>
    <h2>Scenario breakdown</h2>
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>Scenario</th><th class="num">Prob.</th><th class="num">WACC</th>
              <th class="num">Term. g</th><th class="num">Intrinsic</th><th class="num">Weighted</th></tr>
        </thead>
        <tbody id="dcf-scenario-rows"></tbody>
        <tfoot>
          <tr><td colspan="4" class="name">Probability-weighted intrinsic value</td>
              <td colspan="2" class="num strong" id="dcf-weighted">…</td></tr>
        </tfoot>
      </table>
    </div>
    <noscript><p class="meta">This report computes its valuation in the browser;
    enable JavaScript to see the numbers.</p></noscript>
  </section>
{consensus_section}{wacc_section}{buyback_section}{drivers_section}{act_section}
  <section>
    <h2>Key inputs</h2>
    <div class="table-scroll">
      <table class="compact">
        <tbody id="dcf-key-inputs"></tbody>
      </table>
    </div>
  </section>

  <footer class="disclaimer">
    <p><strong>Not investment advice.</strong> A DCF is only as good as its
    assumptions. The valuation is computed in your browser from an embedded input
    snapshot using the <code>dcf</code> engine; it is a personal modeling
    exercise, not a recommendation to buy or sell any security.</p>
    <p class="meta">{escape(conventions_for(data))}</p>
    <p class="snapshot">This report is a frozen daily snapshot. →
    <a href="{escape(snapshot_name)}">Inputs, probabilities &amp; evaluation behind this page</a></p>
    <p class="gen">Generated {date_str} · daily-val</p>
  </footer>
</main>
<script type="application/json" id="dcf-input">{embed_json(data)}</script>{notes_script}{act_script}
<script src="../../assets/dcf.js"></script>
</body>
</html>
"""


# --------------------------------------------------------------------------- #
# HTML rendering — relative-valuation (peer multiples) page. Same contract as
# the DCF page: inputs (+ notes) are embedded; docs/assets/comps.js fills the
# numbers client-side. Valuation only — no market price.
# --------------------------------------------------------------------------- #
def render_comps_report(symbol, data, date_str, notes=None, snapshot_name=None):
    sym = escape(symbol)
    method = escape(method_for(data))
    anchor = escape(str(data.get("anchor", "")))
    notes = notes or {}
    snapshot_name = snapshot_name or f"{date_str}.json"

    fv_label = f"Fair value{f' · {anchor}' if anchor else ''}"

    # Both step intros are input-overridable so the page can name the actual
    # peer cohort and say where the forward figures come from. The defaults stay
    # generic — nothing here is specific to one stock or sector.
    peers_intro = data.get("peers_intro") or (
        "Today's forward multiples for the closest comparable companies. These "
        "set the reference range — nothing more; they are not multiplied into "
        "the price."
    )
    figures_intro = data.get("figures_intro") or (
        f"For each multiple we take {sym}'s expected {anchor} figure and apply a "
        "multiple, chosen using the peer range above as a reference."
    )

    # Sections 4 and 5 appear only when the input carries a market price. They
    # are the one place a price is allowed on a page, and they run *backwards*:
    # the price is the input and the required assumption is the output. The fair
    # value above is still computed without reference to it.
    market_section = ""
    if data.get("market"):
        market_section = f"""
  <section>
    <h2>4 · What the price is actually saying</h2>
    <p class="meta">Everything above was computed without looking at the market.
    Here we do the reverse — hold the same {anchor} figures fixed, take the traded
    price as given, and read off the multiple it implies.</p>
    <div id="cmp-market"></div>
  </section>
"""
    expect_section = ""
    if data.get("expectations"):
        expect_section = """
  <section>
    <h2>5 · Reasoning to the price</h2>
    <p class="meta">A multiple on next year's figures is not the only way to
    defend a price — you can also be paying today for a later year. So: push the
    figures out to the company's own planning horizon, discount back, and solve
    for the one thing left over — the multiple the business would still have to
    command that far out.</p>
    <div id="cmp-expect"></div>
  </section>
"""

    act_levels = action_levels(data, "cmp-action")
    act_section = action_section(data, date_str, "cmp-action")
    act_script = action_script(data)
    notes_script = ""
    if notes:
        notes_script = f'\n<script type="application/json" id="cmp-notes">{embed_json(notes)}</script>'

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{sym} valuation — {date_str} · daily-val</title>
<link rel="stylesheet" href="../../assets/style.css">
</head>
<body>
<main class="wrap">
  <p class="crumb"><a href="../../index.html">← All reports</a></p>

  <header class="rpt-head">
    <div>
      <h1>{sym} <span class="sub">valuation</span></h1>
      <p class="meta" id="cmp-method">{method}</p>
    </div>
    <div class="date-badge">{date_str}</div>
  </header>

  <section class="fairvalue-band">
    <span class="fv-label">{fv_label}</span>
    <span class="fv-value" id="cmp-fairvalue">…</span>{act_levels}
  </section>
  <noscript><p class="meta">This report computes its valuation in the browser;
  enable JavaScript to see the numbers.</p></noscript>

  <section>
    <h2>1 · What the peers trade at</h2>
    <p class="meta">{escape(peers_intro)}</p>
    <div id="cmp-peers"></div>
  </section>

  <section>
    <h2>2 · Our numbers for {sym}</h2>
    <p class="meta">{escape(figures_intro)}</p>
    <p class="meta" id="cmp-source"></p>
    <div id="cmp-inputs"></div>
  </section>

  <section>
    <h2>3 · How we get the fair value</h2>
    <p class="meta">Each multiple gives one implied share price — equity
    multiples directly, EV-based multiples after adding net cash and dividing by
    shares. The fair value is the average of those prices.</p>
    <div id="cmp-calc"></div>
  </section>
{market_section}{expect_section}{act_section}
  <section>
    <h2>Key inputs</h2>
    <div class="table-scroll">
      <table class="compact">
        <tbody id="cmp-key-inputs"></tbody>
      </table>
    </div>
  </section>

  <footer class="disclaimer">
    <p><strong>Not investment advice.</strong> A relative valuation is only as
    good as its forward figure and its peer set — the forward figure can sit at a
    cycle peak, and a wide peer range can justify almost any answer. The
    valuation is computed in your browser from
    an embedded input snapshot using the <code>comps</code> engine; it is a
    personal modeling exercise, not a recommendation to buy or sell any
    security.</p>
    <p class="meta">{escape(conventions_for(data))}</p>
    <p class="snapshot">This report is a frozen daily snapshot. →
    <a href="{escape(snapshot_name)}">Inputs &amp; evaluation behind this page</a></p>
    <p class="gen">Generated {date_str} · daily-val</p>
  </footer>
</main>
<script type="application/json" id="cmp-input">{embed_json(data)}</script>{notes_script}{act_script}
<script src="../../assets/comps.js"></script>
</body>
</html>
"""


# --------------------------------------------------------------------------- #
# HTML rendering — sum-of-the-parts page. Same contract as the other two:
# inputs (+ notes) are embedded; docs/assets/sotp.js fills the numbers
# client-side. The fair value is derived without any market price.
# --------------------------------------------------------------------------- #
def render_sotp_report(symbol, data, date_str, notes=None, snapshot_name=None):
    sym = escape(symbol)
    method = escape(method_for(data))
    anchor = escape(str(data.get("anchor", "")))
    notes = notes or {}
    snapshot_name = snapshot_name or f"{date_str}.json"

    fv_label = f"Fair value{f' \u00b7 {anchor}' if anchor else ''}"

    parts_intro = data.get("parts_intro") or (
        "The company is not one business, so it is not valued as one. Each "
        "stream below is carried on its own forward figure and its own multiple."
    )
    figures_intro = data.get("figures_intro") or (
        f"Each part's expected {anchor} figure, times the multiple we think that "
        "particular stream deserves. The pieces add to an enterprise value, which "
        "nets cash and divides by shares."
    )

    # The closing section is the one place a price may appear, and it runs
    # *backwards*: hold every other part at our own figures and read off what
    # the price leaves over for the part that actually swings the answer. The
    # fair value above is already fixed before the price is read.
    market_section = ""
    if data.get("market"):
        market_section = """
  <section>
    <h2>4 &middot; What the price leaves over</h2>
    <p class="meta">Everything above was computed without looking at the market.
    Here we do the reverse \u2014 take the traded price as given, credit every
    other part and the cash at <em>our</em> figures, and read what is left over
    for the one part that decides the answer.</p>
    <div id="sotp-market"></div>
  </section>
"""

    act_levels = action_levels(data, "sotp-action")
    act_section = action_section(data, date_str, "sotp-action")
    act_script = action_script(data)
    notes_script = ""
    if notes:
        notes_script = f'\n<script type="application/json" id="sotp-notes">{embed_json(notes)}</script>'

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{sym} valuation \u2014 {date_str} \u00b7 daily-val</title>
<link rel="stylesheet" href="../../assets/style.css">
</head>
<body>
<main class="wrap">
  <p class="crumb"><a href="../../index.html">\u2190 All reports</a></p>

  <header class="rpt-head">
    <div>
      <h1>{sym} <span class="sub">valuation</span></h1>
      <p class="meta" id="sotp-method">{method}</p>
    </div>
    <div class="date-badge">{date_str}</div>
  </header>

  <section class="fairvalue-band">
    <span class="fv-label">{fv_label}</span>
    <span class="fv-value" id="sotp-fairvalue">\u2026</span>{act_levels}
  </section>
  <noscript><p class="meta">This report computes its valuation in the browser;
  enable JavaScript to see the numbers.</p></noscript>

  <section>
    <h2>1 &middot; What the parts are</h2>
    <p class="meta">{escape(parts_intro)}</p>
    <div id="sotp-parts"></div>
  </section>

  <section>
    <h2>2 &middot; Building up the value</h2>
    <p class="meta">{escape(figures_intro)}</p>
    <p class="meta" id="sotp-source"></p>
    <div id="sotp-buildup"></div>
  </section>

  <section>
    <h2>3 &middot; The same build-up, three ways</h2>
    <p class="meta">The parts move together, so each case varies the figures and
    the multiples jointly. The fair value is the probability-weighted per-share
    value across the cases.</p>
    <div id="sotp-scenarios"></div>
  </section>
{market_section}{act_section}
  <section>
    <h2>Key inputs</h2>
    <div class="table-scroll">
      <table class="compact">
        <tbody id="sotp-key-inputs"></tbody>
      </table>
    </div>
  </section>

  <footer class="disclaimer">
    <p><strong>Not investment advice.</strong> A sum-of-the-parts is only as good
    as its split and its multiples \u2014 drawing the lines differently, or paying
    up for one stream, moves the answer a long way. The valuation is computed in
    your browser from an embedded input snapshot using the <code>sotp</code>
    engine; it is a personal modeling exercise, not a recommendation to buy or
    sell any security.</p>
    <p class="meta">{escape(conventions_for(data))}</p>
    <p class="snapshot">This report is a frozen daily snapshot. &rarr;
    <a href="{escape(snapshot_name)}">Inputs &amp; evaluation behind this page</a></p>
    <p class="gen">Generated {date_str} \u00b7 daily-val</p>
  </footer>
</main>
<script type="application/json" id="sotp-input">{embed_json(data)}</script>{notes_script}{act_script}
<script src="../../assets/sotp.js"></script>
</body>
</html>
"""


# --------------------------------------------------------------------------- #
# HTML rendering — operating-leverage report. Same contract as the others:
# inputs (+ notes) are embedded; docs/assets/opleverage.js fills the numbers
# client-side. The fair value is derived without any market price.
# --------------------------------------------------------------------------- #
def render_oplev_report(symbol, data, date_str, notes=None, snapshot_name=None):
    sym = escape(symbol)
    method = escape(method_for(data))
    anchor = escape(str(data.get("anchor", "")))
    notes = notes or {}
    snapshot_name = snapshot_name or f"{date_str}.json"

    fv_label = f"Fair value{f' \u00b7 {anchor}' if anchor else ''}"

    history_intro = data.get("history_intro") or (
        "The company's own filed figures, run through the same bridge used for "
        "the future below. An assumed margin has to be read against the margins "
        "actually earned, in the same units, in the same table."
    )
    bridge_intro = data.get("bridge_intro") or (
        "No earnings figure is assumed. Each case names a revenue level, a gross "
        "margin and a dollar cost base, and the earnings fall out of them."
    )

    history_section = ""
    if data.get("history"):
        history_section = f"""
  <section>
    <h2>1 &middot; What the business has actually earned</h2>
    <p class="meta">{escape(history_intro)}</p>
    <div id="opl-history"></div>
  </section>
"""

    sens_section = ""
    if data.get("sensitivity"):
        sens_section = """
  <section>
    <h2>4 &middot; Where the answer actually comes from</h2>
    <p class="meta">Against a largely fixed cost base, value per share is far
    more sensitive to the gross margin than to anything else in the model. This
    grid is the honest summary of the report: pick a revenue level and a margin,
    and read off what the business is worth.</p>
    <div id="opl-sensitivity"></div>
  </section>
"""

    # The one section a price may touch, and it runs *backwards*: hold the cost
    # base, the tax rate, the share count and the multiple, and solve for the
    # margin — or the revenue — the traded price is asking for. The fair value
    # above is already fixed before the price is read.
    market_section = ""
    if data.get("market"):
        market_section = """
  <section>
    <h2>5 &middot; What the price requires</h2>
    <p class="meta">Everything above was computed without looking at the market.
    Here we run the same bridge in reverse \u2014 take the traded price as given,
    hold the cost base, the tax rate, the share count and the multiple at
    <em>our</em> figures, and solve for the earnings it implies. Then express
    that requirement two ways: as a gross margin at our revenue, and as a
    revenue at our gross margin.</p>
    <div id="opl-market"></div>
  </section>
"""

    act_levels = action_levels(data, "opl-action")
    act_section = action_section(data, date_str, "opl-action")
    act_script = action_script(data)
    notes_script = ""
    if notes:
        notes_script = f'\n<script type="application/json" id="opl-notes">{embed_json(notes)}</script>'

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{sym} valuation \u2014 {date_str} \u00b7 daily-val</title>
<link rel="stylesheet" href="../../assets/style.css">
</head>
<body>
<main class="wrap">
  <p class="crumb"><a href="../../index.html">\u2190 All reports</a></p>

  <header class="rpt-head">
    <div>
      <h1>{sym} <span class="sub">valuation</span></h1>
      <p class="meta" id="opl-method">{method}</p>
    </div>
    <div class="date-badge">{date_str}</div>
  </header>

  <section class="fairvalue-band">
    <span class="fv-label">{fv_label}</span>
    <span class="fv-value" id="opl-fairvalue">\u2026</span>{act_levels}
  </section>
  <noscript><p class="meta">This report computes its valuation in the browser;
  enable JavaScript to see the numbers.</p></noscript>
{history_section}
  <section>
    <h2>2 &middot; The bridge</h2>
    <p class="meta">{escape(bridge_intro)}</p>
    <p class="meta" id="opl-source"></p>
    <div id="opl-bridge"></div>
  </section>

  <section>
    <h2>3 &middot; The cases, weighted</h2>
    <p class="meta">Revenue, margin, cost base and multiple move together, so
    each case varies them jointly. The fair value is the probability-weighted
    value per share across the cases.</p>
    <div id="opl-scenarios"></div>
  </section>
{sens_section}
  <section>
    <h2>How good are these inputs?</h2>
    <p class="meta">One read per input \u2014 what it rests on, and how hard it
    would be to argue with. The gross margin and the scenario weights are the
    two that decide this report.</p>
    <div id="opl-drivers"></div>
  </section>
{market_section}{act_section}
  <section>
    <h2>Key inputs</h2>
    <div class="table-scroll">
      <table class="compact">
        <tbody id="opl-key-inputs"></tbody>
      </table>
    </div>
  </section>

  <footer class="disclaimer">
    <p><strong>Not investment advice.</strong> An earnings-power bridge is only
    as good as the margin assumed at the top of it \u2014 with a large fixed cost
    base, a few points either way moves the answer a long way, which is exactly
    why the model shows the margin rather than an earnings figure. The valuation
    is computed in your browser from an embedded input snapshot using the
    <code>opleverage</code> engine; it is a personal modeling exercise, not a
    recommendation to buy or sell any security.</p>
    <p class="meta">{escape(conventions_for(data))}</p>
    <p class="snapshot">This report is a frozen daily snapshot. &rarr;
    <a href="{escape(snapshot_name)}">Inputs &amp; evaluation behind this page</a></p>
    <p class="gen">Generated {date_str} \u00b7 daily-val</p>
  </footer>
</main>
<script type="application/json" id="opl-input">{embed_json(data)}</script>{notes_script}{act_script}
<script src="../../assets/opleverage.js"></script>
</body>
</html>
"""


def render_index(entries):
    # The report list is NOT embedded here. The page reads it at runtime from
    # the reports/manifest.json data file and sorts it (date desc) client-side,
    # so the landing page is a static shell that never hardcodes the list.
    updated = dt.date.today().isoformat()
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>daily-val · valuation reports</title>
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
<main class="wrap">
  <header class="site-head">
    <h1>daily&#8209;val</h1>
    <p class="tagline">Dated, back-of-the-envelope intrinsic-value reports.
    One page per stock, per date — each a frozen daily snapshot. Valuation only —
    no market price.</p>
  </header>

  <div id="dcf-index"></div>
  <noscript><p class="empty">Enable JavaScript to list reports and their
  fair values.</p></noscript>

  <footer class="disclaimer">
    <p><strong>Not investment advice.</strong> These are personal modeling
    exercises, not recommendations. Last built {updated}.</p>
  </footer>
</main>
<script src="assets/comps.js"></script>
<script src="assets/sotp.js"></script>
<script src="assets/opleverage.js"></script>
<script src="assets/dcf.js"></script>
</body>
</html>
"""


STYLE = """:root {
  --bg: #ffffff;
  --panel: #f6f7f9;
  --border: #e4e7ec;
  --text: #1a1d23;
  --muted: #667085;
  --accent: #2f6feb;
  --shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.10);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --panel: #171a21; --border: #262b34; --text: #e6e8ec;
    --muted: #98a2b3; --accent: #5a8dff; --shadow: none;
  }
}
:root[data-theme="dark"] {
  --bg: #0f1115; --panel: #171a21; --border: #262b34; --text: #e6e8ec;
  --muted: #98a2b3; --accent: #5a8dff; --shadow: none;
}
:root[data-theme="light"] {
  --bg: #ffffff; --panel: #f6f7f9; --border: #e4e7ec; --text: #1a1d23;
  --muted: #667085; --accent: #2f6feb;
  --shadow: 0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.10);
}

* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 860px; margin: 0 auto; padding: 40px 20px 80px; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
h1 { font-size: 30px; margin: 0; letter-spacing: -.02em; }
h2 { font-size: 18px; margin: 36px 0 12px; letter-spacing: -.01em; }
.sub { color: var(--muted); font-weight: 500; }
.crumb { margin: 0 0 20px; font-size: 14px; }

/* Landing */
.site-head { margin-bottom: 12px; }
.tagline { color: var(--muted); max-width: 52ch; }
.report-list { margin-top: 24px; }
.report-row {
  display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 18px;
  padding: 14px 16px; margin: 8px 0; border: 1px solid var(--border);
  border-radius: 10px; background: var(--panel); color: var(--text);
  box-shadow: var(--shadow);
}
.report-row:hover { text-decoration: none; border-color: var(--accent); }
.rr-date { font-variant-numeric: tabular-nums; font-weight: 600; min-width: 96px; }
.rr-sym { font-weight: 700; letter-spacing: .02em; min-width: 52px; }
.rr-method { color: var(--muted); font-size: 13px; flex: 1 1 180px; }
.rr-metric { font-size: 14px; color: var(--muted); }
.rr-metric b { color: var(--text); font-variant-numeric: tabular-nums; }
.empty { color: var(--muted); }

/* Report header */
.rpt-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; }

/* Fair-value band (comps report headline) */
.fairvalue-band {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 12px; flex-wrap: wrap; margin: 24px 0 8px; padding: 16px 20px;
  border: 1px solid var(--border); border-radius: 12px; background: var(--panel);
  box-shadow: var(--shadow);
}
.fv-label { color: var(--muted); font-size: 14px; }
.fv-value { font-weight: 700; font-size: 34px; letter-spacing: -.02em; font-variant-numeric: tabular-nums; }

/* Action band: the accumulate/trim levels sit in the fair-value band, beside
   the value they are a fraction of. Scoped with :has() so reports without a
   band keep exactly the layout they were published with. */
.fairvalue-band:has(.fv-levels) { align-items: flex-end; row-gap: 4px; }
.fairvalue-band:has(.fv-levels) .fv-label { flex: 0 0 100%; }
.fv-levels { display: flex; gap: 12px 28px; flex-wrap: wrap; margin-left: auto; }
.fv-act { display: flex; flex-direction: column; gap: 1px; text-align: right; }
.fv-act-label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
.fv-act-value { font-weight: 700; font-size: 20px; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.fv-act-basis { color: var(--muted); font-size: 12px; }
@media (max-width: 560px) {
  .fv-levels { margin-left: 0; width: 100%; justify-content: space-between; }
  .fv-act.act-buy { text-align: left; }
}
.meta { color: var(--muted); margin: 6px 0 0; font-size: 14px; }
.date-badge {
  font-variant-numeric: tabular-nums; font-weight: 600; font-size: 14px;
  padding: 6px 12px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--panel); white-space: nowrap;
}

/* Tables */
.table-scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 15px; }
th, td { padding: 10px 12px; border-bottom: 1px solid var(--border); text-align: left; }
thead th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.muted-cell { color: var(--muted); }
.name { font-weight: 600; }
.strong { font-weight: 700; }
tfoot td { border-top: 2px solid var(--border); border-bottom: none; font-weight: 600; }
table.compact td { padding: 8px 12px; }

/* Consensus cross-check */
.consensus-head { display: flex; align-items: baseline; justify-content: space-between;
  gap: 12px; flex-wrap: wrap; margin-bottom: 12px; }
.consensus-label { color: var(--muted); font-size: 14px; }
.consensus-value { font-weight: 700; font-size: 24px; font-variant-numeric: tabular-nums; }
#dcf-consensus .read-note { display: block; margin: 12px 0 0; max-width: 72ch; }

/* verdict pill + plain-English note */
.verdict { display: inline-block; font-weight: 700; font-size: 12px;
  padding: 1px 8px; border-radius: 999px; background: var(--panel); border: 1px solid var(--border); }
.read-note { color: var(--muted); font-size: 13px; }

/* Assumptions: one table per input, three scenario rows (Bear/Base/Bull) */
.assump { padding: 18px 0; border-bottom: 1px solid var(--border); }
.assump:last-child { border-bottom: 0; }
.assump-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.assump-label { font-weight: 600; }
.assump .read-note { display: block; margin: 10px 0 0; max-width: 72ch; }
.reads { margin-top: 12px; }
.read-line { margin: 8px 0; font-size: 14px; line-height: 1.5; }
.read-key { font-weight: 600; }
.read-line .read-note { display: inline; margin: 0; }

/* Footer */
.disclaimer { margin-top: 48px; padding-top: 20px; border-top: 1px solid var(--border);
  color: var(--muted); font-size: 13px; }
.disclaimer code { background: var(--panel); padding: 1px 5px; border-radius: 4px; }
.snapshot { margin-top: 12px; }
.gen { margin-top: 8px; font-variant-numeric: tabular-nums; }

@media (max-width: 560px) {
  .rpt-head { flex-direction: column; }
}
"""


# --------------------------------------------------------------------------- #
# Manifest + orchestration
# --------------------------------------------------------------------------- #
def upsert_manifest(entry):
    entries = load_json(MANIFEST) or []
    entries = [e for e in entries if not (e["symbol"] == entry["symbol"] and e["date"] == entry["date"])]
    entries.append(entry)
    entries.sort(key=lambda e: (e["symbol"], e["date"]))
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    with open(MANIFEST, "w") as f:
        json.dump(entries, f, indent=2)
    return entries


def main():
    ap = argparse.ArgumentParser(description="Generate a dated valuation report page.")
    ap.add_argument("symbol", help="Ticker, e.g. GOOGL (must have a DCF input file)")
    ap.add_argument("--date", default=dt.date.today().isoformat(), help="YYYY-MM-DD (default: today)")
    args = ap.parse_args()

    symbol = args.symbol.upper()
    date_str = args.date

    input_path = resolve_ref("inputs", symbol)
    if input_path is None:
        roots = ", ".join(str((r / "inputs").relative_to(ROOT)) for r in REF_ROOTS)
        sys.exit(f"Error: no input file for {symbol} under any of: {roots}")
    data = load_json(input_path)

    # Optional commentary sidecar (drives the assumptions panel + the
    # scenario-probability evaluation).
    notes_path = resolve_ref("notes", symbol)
    notes = load_json(notes_path) if notes_path else None

    out_dir = REPORTS_DIR / symbol.lower()
    out_dir.mkdir(parents=True, exist_ok=True)

    # 1. Freeze this report's own data copy: inputs (incl. scenario
    #    probabilities) + their evaluation notes. This is the snapshot of
    #    record — a published report never changes when the shared reference
    #    JSON is later refreshed for a new date.
    snapshot_name = f"{date_str}.json"
    snapshot = {
        "symbol": symbol,
        "date": date_str,
        "generated": dt.datetime.now().isoformat(timespec="seconds"),
        "conventions": conventions_for(data),
        "input": data,
        "notes": notes,
    }
    snapshot_file = out_dir / snapshot_name
    snapshot_file.write_text(json.dumps(snapshot, indent=2))

    # 2. Write report page (inputs+notes embedded; math runs in the browser).
    #    The input's method selects the engine + template.
    if is_oplev(data):
        render = render_oplev_report
    elif is_sotp(data):
        render = render_sotp_report
    elif is_comps(data):
        render = render_comps_report
    else:
        render = render_report
    out_file = out_dir / f"{date_str}.html"
    out_file.write_text(render(symbol, data, date_str, notes, snapshot_name))

    # 3. Update manifest + rebuild index + refresh stylesheet.
    entry = {
        "symbol": symbol,
        "date": date_str,
        "method": method_for(data),
        "path": f"reports/{symbol.lower()}/{date_str}.html",
        "snapshot": f"reports/{symbol.lower()}/{snapshot_name}",
        "input": data,
    }
    entries = upsert_manifest(entry)
    (DOCS / "index.html").write_text(render_index(entries))
    (DOCS / "assets").mkdir(parents=True, exist_ok=True)
    (DOCS / "assets" / "style.css").write_text(STYLE)

    print(f"✓ Snapshot: {snapshot_file.relative_to(ROOT)}")
    print(f"✓ Report:   {out_file.relative_to(ROOT)}")
    print(f"✓ Index:    {(DOCS / 'index.html').relative_to(ROOT)}")
    print(f"  {symbol}  {method_for(data)}  (intrinsic computed client-side)")


if __name__ == "__main__":
    main()
