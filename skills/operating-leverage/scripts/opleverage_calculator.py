#!/usr/bin/env python3
"""Operating-leverage (earnings-power bridge) valuation — the parity oracle.

This is the non-browser reference implementation of docs/assets/opleverage.js.
The two must agree; when they disagree, this file is right.

The model does not accept an earnings figure. It *builds* one, so that the
assumption doing the work is visible:

    revenue x gross margin        -> gross profit
      - opex                      -> EBIT
      + other income              -> pre-tax income
      x (1 - tax rate)            -> net income
      / diluted shares            -> EPS
      x multiple                  -> value per share

For a business whose fixed cost base is large relative to its gross profit, the
last line is enormously levered to the second: a few points of gross margin is
the whole valuation. Stating EPS directly would hide that. Here it cannot be
hidden, and the `history` block runs the company's own filed actuals through the
same bridge so an assumed margin can be read against every margin it has ever
earned.

Usage:
    python3 skills/operating-leverage/scripts/opleverage_calculator.py <input.json>
"""

import json
import sys

# --------------------------------------------------------------------------- #
# parsing / formatting
# --------------------------------------------------------------------------- #
_MULT = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}


def parse_value(value):
    """Accept 750e6, "750M", "1.15B", "0.48" -> float."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    v = str(value).strip().upper().replace(",", "")
    if not v:
        return None
    if v[-1] in _MULT:
        return float(v[:-1]) * _MULT[v[-1]]
    return float(v)


def parse_rate(value):
    """A rate given as 0.48 or as 48 (percent) -> 0.48."""
    r = parse_value(value)
    if r is None:
        return None
    return r / 100.0 if r > 1.0 else r


def money(x, decimals=None):
    """Adaptive precision, so $1.15B does not print as $1.1B."""
    if x is None:
        return "N/A"
    ax = abs(x)
    for suffix, scale in (("T", 1e12), ("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if ax >= scale:
            n = abs(x) / scale
            dp = decimals if decimals is not None else (0 if n >= 100 else (1 if n >= 10 else 2))
            s = f"{n:,.{dp}f}"
            if "." in s:
                s = s.rstrip("0").rstrip(".")
            return f"{'-$' if x < 0 else '$'}{s}{suffix}"
    return f"${x:,.0f}"


def price(x):
    return "—" if x is None else f"${x:,.2f}"


def pct(x, dp=1):
    return "—" if x is None else f"{x * 100:.{dp}f}%"


def multx(x):
    if x is None:
        return "—"
    return f"{x:.0f}×" if float(x).is_integer() else f"{x:.1f}×"


# --------------------------------------------------------------------------- #
# the bridge
# --------------------------------------------------------------------------- #
def bridge(f, shares, net_cash, mult, kind):
    """Revenue + margin + cost base -> EBIT -> EPS -> value per share.

    Returns every rung, because the rungs are the point: a reader has to be able
    to see which one the answer is resting on.
    """
    revenue = parse_value(f.get("revenue"))
    gm = parse_rate(f.get("gross_margin"))
    opex = parse_value(f.get("opex")) or 0.0
    other = parse_value(f.get("other_income")) or 0.0
    tax = parse_rate(f.get("tax_rate"))
    if tax is None:
        tax = 0.0

    if revenue is None or gm is None:
        raise ValueError("each case needs 'revenue' and 'gross_margin'")

    gross_profit = revenue * gm
    ebit = gross_profit - opex
    pretax = ebit + other
    net_income = pretax * (1.0 - tax)
    eps = net_income / shares if shares else None

    if kind == "ev_ebit":
        per_share = (ebit * mult + net_cash) / shares if shares else None
    else:  # "pe"
        per_share = eps * mult if eps is not None else None

    return {
        "revenue": revenue,
        "gross_margin": gm,
        "gross_profit": gross_profit,
        "opex": opex,
        "ebit": ebit,
        "op_margin": ebit / revenue if revenue else None,
        "other_income": other,
        "pretax": pretax,
        "tax_rate": tax,
        "net_income": net_income,
        "eps": eps,
        "multiple": mult,
        "kind": kind,
        "value": per_share,
    }


def merge(base, override):
    out = dict(base or {})
    for k, v in (override or {}).items():
        out[k] = v
    return out


def normalize_scenarios(raw):
    if not isinstance(raw, list) or not raw:
        raise ValueError("'scenarios' must be a non-empty list")
    out = []
    for i, s in enumerate(raw):
        if not isinstance(s, dict):
            raise ValueError(f"scenarios[{i}] must be an object")
        if "probability" not in s:
            raise ValueError(f"scenarios[{i}] is missing 'probability'")
        p = float(s["probability"])
        if p < 0:
            raise ValueError(f"scenarios[{i}].probability must be non-negative")
        c = json.loads(json.dumps(s))
        c["probability"] = p
        out.append(c)
    total = sum(s["probability"] for s in out)
    if total <= 0:
        raise ValueError("Scenario probability sum must be > 0")
    if total > 1.0001:
        if abs(total - 100.0) <= 0.1:
            for s in out:
                s["probability"] /= 100.0
            total = sum(s["probability"] for s in out)
        else:
            raise ValueError("Scenario probabilities must sum to 1.0 (or 100)")
    if abs(total - 1.0) > 0.001:
        raise ValueError(f"Scenario probabilities must sum to 1.0; got {total:.4f}")
    return out


def evaluate(data):
    bs = data.get("balance_sheet") or {}
    shares = parse_value(bs.get("diluted_shares"))
    net_cash = parse_value(bs.get("net_cash")) or 0.0
    top_mult = data.get("multiple") or {}
    kind = top_mult.get("kind", "pe")
    base_mult = parse_value(top_mult.get("value"))

    scenarios = []
    for i, s in enumerate(normalize_scenarios(data.get("scenarios"))):
        f = merge(data.get("fundamentals"), s.get("fundamentals"))
        sbs = merge(bs, s.get("balance_sheet"))
        s_shares = parse_value(sbs.get("diluted_shares")) or shares
        s_cash = parse_value(sbs.get("net_cash"))
        s_cash = net_cash if s_cash is None else s_cash
        m = s.get("multiple")
        m = base_mult if m is None else parse_value(m.get("value") if isinstance(m, dict) else m)
        b = bridge(f, s_shares, s_cash, m, kind)
        b["name"] = s.get("name") or f"Case {i + 1}"
        b["probability"] = s["probability"]
        b["contribution"] = b["value"] * s["probability"] if b["value"] is not None else 0.0
        b["comment"] = s.get("comment")
        scenarios.append(b)

    intrinsic = sum(s["contribution"] for s in scenarios)

    # History: the company's own filed actuals, run through the same bridge.
    history = []
    for h in data.get("history") or []:
        rev = parse_value(h.get("revenue"))
        gm = parse_rate(h.get("gross_margin"))
        opex = parse_value(h.get("opex")) or 0.0
        if rev is None or gm is None:
            continue
        gp = rev * gm
        ebit = gp - opex
        history.append({
            "period": h.get("period", ""),
            "revenue": rev, "gross_margin": gm, "gross_profit": gp,
            "opex": opex, "ebit": ebit,
            "op_margin": ebit / rev if rev else None,
            "note": h.get("note"),
        })

    return {
        "method": "Operating leverage — earnings-power bridge"
                  + (f" ({data['anchor']})" if data.get("anchor") else ""),
        "symbol": data.get("symbol"),
        "anchor": data.get("anchor"),
        "kind": kind,
        "shares": shares,
        "net_cash": net_cash,
        "scenarios": scenarios,
        "history": history,
        "intrinsic": intrinsic,
    }


def solve_case(evald, data):
    """Which case the reverse solve holds fixed."""
    name = ((data.get("market") or {}).get("solve_from") or "").lower()
    for s in evald["scenarios"]:
        if s["name"].lower() == name:
            return s
    return max(evald["scenarios"], key=lambda s: s["probability"])


def reverse(data, evald):
    """Run the bridge backwards from the traded price.

    Never touches the fair value above — this only answers "what would the
    business have to do", holding the cost base, the tax rate, the share count
    and the multiple of one named case.
    """
    market = data.get("market")
    if not market:
        return None
    p = parse_value(market.get("price"))
    if p is None:
        return None
    c = solve_case(evald, data)
    shares, mult, kind = evald["shares"], c["multiple"], evald["kind"]

    if kind == "ev_ebit":
        req_ebit = (p * shares - evald["net_cash"]) / mult
        implied_mult = ((p * shares - evald["net_cash"]) / c["ebit"]) if c["ebit"] else None
    else:
        req_ni = p * shares / mult
        req_pretax = req_ni / (1.0 - c["tax_rate"])
        req_ebit = req_pretax - c["other_income"]
        implied_mult = (p / c["eps"]) if c["eps"] else None

    req_gp = req_ebit + c["opex"]
    return {
        "price": p,
        "as_of": market.get("as_of"),
        "commentary": market.get("commentary"),
        "case": c,
        "implied_multiple": implied_mult,
        "required_ebit": req_ebit,
        "required_op_margin": req_ebit / c["revenue"] if c["revenue"] else None,
        "required_gross_profit": req_gp,
        # Two ways to get there, each holding the other variable at the case's own level.
        "required_gross_margin": req_gp / c["revenue"] if c["revenue"] else None,
        "required_revenue": req_gp / c["gross_margin"] if c["gross_margin"] else None,
    }


def sensitivity(data, evald):
    """Value per share across revenue x gross margin — the two that matter."""
    spec = data.get("sensitivity")
    if not spec:
        return None
    c = solve_case(evald, data)
    revs = [parse_value(r) for r in (spec.get("revenue") or [])]
    gms = [parse_rate(g) for g in (spec.get("gross_margin") or [])]
    if not revs or not gms:
        return None
    grid = []
    for gm in gms:
        row = []
        for rev in revs:
            b = bridge(
                {"revenue": rev, "gross_margin": gm, "opex": c["opex"],
                 "other_income": c["other_income"], "tax_rate": c["tax_rate"]},
                evald["shares"], evald["net_cash"], c["multiple"], evald["kind"])
            row.append(b["value"])
        grid.append({"gross_margin": gm, "values": row})
    return {"case": c, "revenue": revs, "rows": grid}


# --------------------------------------------------------------------------- #
# report
# --------------------------------------------------------------------------- #
def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    with open(sys.argv[1]) as fh:
        data = json.load(fh)

    e = evaluate(data)
    sym = e["symbol"] or "?"
    print(f"\n{'=' * 78}\n{sym} — {e['method']}\n{'=' * 78}")

    if e["history"]:
        print("\nWhat the company has actually done (same bridge, filed figures)")
        print(f"  {'Period':<12}{'Revenue':>11}{'GM':>8}{'Opex':>10}{'EBIT':>10}{'Op margin':>11}")
        for h in e["history"]:
            print(f"  {h['period']:<12}{money(h['revenue']):>11}{pct(h['gross_margin']):>8}"
                  f"{money(h['opex']):>10}{money(h['ebit']):>10}{pct(h['op_margin']):>11}")

    print("\nThe bridge, case by case")
    for s in e["scenarios"]:
        print(f"\n  {s['name']}  (p={s['probability']:.0%}, {multx(s['multiple'])} "
              f"{'EV/EBIT' if e['kind'] == 'ev_ebit' else 'P/E'})")
        print(f"    revenue           {money(s['revenue']):>12}")
        print(f"    x gross margin    {pct(s['gross_margin']):>12}")
        print(f"    = gross profit    {money(s['gross_profit']):>12}")
        print(f"    - opex            {money(s['opex']):>12}")
        print(f"    = EBIT            {money(s['ebit']):>12}   ({pct(s['op_margin'])} of revenue)")
        print(f"    + other income    {money(s['other_income']):>12}")
        print(f"    x (1 - {s['tax_rate']:.0%} tax)    {money(s['net_income']):>12}   net income")
        share_lbl = f"/ {money(e['shares'], 0).lstrip('$')} shares"
        print(f"    {share_lbl:<18}{price(s['eps']):>12}   EPS")
        mult_lbl = f"x {multx(s['multiple'])}"
        print(f"    {mult_lbl:<18}{price(s['value']):>12}   per share")

    print(f"\n{'-' * 78}")
    print(f"  {'Case':<10}{'Prob':>7}{'Revenue':>11}{'GM':>8}{'EBIT':>10}{'EPS':>9}{'Value':>10}{'Weighted':>11}")
    for s in e["scenarios"]:
        print(f"  {s['name']:<10}{s['probability']:>7.0%}{money(s['revenue']):>11}{pct(s['gross_margin']):>8}"
              f"{money(s['ebit']):>10}{price(s['eps']):>9}{price(s['value']):>10}{price(s['contribution']):>11}")
    print(f"{'-' * 78}")
    print(f"  {'FAIR VALUE':<10}{'':>7}{'':>11}{'':>8}{'':>10}{'':>9}{'':>10}{price(e['intrinsic']):>11}")

    sens = sensitivity(data, e)
    if sens:
        print(f"\nValue per share — revenue x gross margin (holding {sens['case']['name']} "
              f"cost base, tax and {multx(sens['case']['multiple'])})")
        head = "  " + f"{'GM \\ Rev':<10}" + "".join(f"{money(r, 2):>11}" for r in sens["revenue"])
        print(head)
        for row in sens["rows"]:
            print("  " + f"{pct(row['gross_margin']):<10}"
                  + "".join(f"{price(v):>11}" for v in row["values"]))

    rev = reverse(data, e)
    if rev:
        print(f"\n{'=' * 78}\nWhat the market price requires  (computed after the valuation, "
              f"never into it)\n{'=' * 78}")
        c = rev["case"]
        print(f"  Price {price(rev['price'])}"
              + (f" as of {rev['as_of']}" if rev["as_of"] else "")
              + f", solved against the {c['name']} case")
        print(f"  Implied multiple on {c['name']} earnings       {multx(rev['implied_multiple'])}")
        print(f"  Required EBIT at {multx(c['multiple'])}                    {money(rev['required_ebit'])}"
              f"   ({pct(rev['required_op_margin'])} of {money(c['revenue'])})")
        print(f"  ...as a gross margin, at {money(c['revenue'])} revenue   {pct(rev['required_gross_margin'])}"
              f"   (case assumes {pct(c['gross_margin'])})")
        print(f"  ...as revenue, at a {pct(c['gross_margin'])} gross margin  {money(rev['required_revenue'])}"
              f"   (case assumes {money(c['revenue'])})")
        if rev["commentary"]:
            print(f"\n  {rev['commentary']}")
    print()


if __name__ == "__main__":
    main()
