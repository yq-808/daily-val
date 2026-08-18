#!/usr/bin/env python3
"""Fixed-cost breakeven valuation — the parity oracle.

This is the non-browser reference implementation of docs/assets/breakeven.js.
The two must agree; when they disagree, this file is right.

The model refuses to accept a gross margin. It *derives* one, because for the
businesses this method exists for the gross margin is not an assumption at all
— it is what arithmetic does to a revenue level when the cost of revenue is a
capacity cost that sits still:

    revenue R
      - cost of revenue   = fixed_cost_of_revenue + R x variable_ratio
      = gross profit                      -> and therefore the gross margin
      - opex (dollars)    = EBIT
      + D&A               = EBITDA
    breakeven revenue     = (fixed cost of revenue + opex) / (1 - variable_ratio)

Above the breakeven line the business is worth a multiple of what it earns;
below it, it is worth a multiple of what it sells, because there is nothing to
capitalise. So each case is carried at whichever of the two is *higher* — the
revenue multiple is a franchise floor, and the earnings multiple takes over once
the business clears its own cost base. Both are shown for every case, so the
switch is visible rather than chosen.

Usage:
    python3 skills/breakeven/scripts/breakeven_calculator.py <input.json>
"""

import json
import sys

# --------------------------------------------------------------------------- #
# parsing / formatting
# --------------------------------------------------------------------------- #
_MULT = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}


def parse_value(value):
    """Accept 24e6, "24M", "1.15B", "0.15" -> float."""
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
    """A rate given as 0.15 or as 15 (percent) -> 0.15."""
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
            n = ax / scale
            dp = decimals if decimals is not None else (0 if n >= 100 else (1 if n >= 10 else 2))
            s = f"{n:,.{dp}f}"
            if "." in s:
                s = s.rstrip("0").rstrip(".")
            return f"{'-$' if x < 0 else '$'}{s}{suffix}"
    return f"${x:,.0f}"


def price(x):
    return "-" if x is None else f"${x:.2f}"


def pct(x, dp=1):
    return "-" if x is None else f"{x * 100:.{dp}f}%"


def multx(x):
    if x is None:
        return "-"
    return (f"{x:.0f}" if x % 1 == 0 else f"{x:.1f}") + "x"


# --------------------------------------------------------------------------- #
# the cost base
# --------------------------------------------------------------------------- #
def cost_base(cb):
    """Normalize a cost-base block into plain floats."""
    v = parse_rate(cb.get("variable_ratio"))
    if v is None:
        v = 0.0
    fixed_cor = parse_value(cb.get("fixed_cost_of_revenue"))
    opex = parse_value(cb.get("opex"))
    if fixed_cor is None or opex is None:
        raise ValueError("cost_base needs 'fixed_cost_of_revenue' and 'opex'")
    if not 0.0 <= v < 1.0:
        raise ValueError("variable_ratio must be in [0, 1)")
    return {
        "variable_ratio": v,
        "fixed_cost_of_revenue": fixed_cor,
        "opex": opex,
        "dna": parse_value(cb.get("dna")) or 0.0,
        "other_income": parse_value(cb.get("other_income")) or 0.0,
    }


def breakevens(cb):
    """The three revenue levels that matter, from a cost base alone.

    No revenue assumption goes into these — they are a property of the cost
    structure, which is exactly why this method leads with them.
    """
    absorb = 1.0 - cb["variable_ratio"]
    fixed = cb["fixed_cost_of_revenue"] + cb["opex"]
    return {
        "gross_profit": cb["fixed_cost_of_revenue"] / absorb,
        "ebitda": (fixed - cb["dna"]) / absorb,
        "ebit": fixed / absorb,
    }


# --------------------------------------------------------------------------- #
# the bridge
# --------------------------------------------------------------------------- #
_EARNINGS_KINDS = ("ev_ebitda", "ev_ebit")
_FLOOR_KINDS = ("ev_sales", "ev_gross_profit")


def bridge(revenue, cb, shares, net_cash, mult_earnings, kind_earnings,
           mult_floor, kind_floor):
    """A revenue level and a cost base -> margins, breakevens, value per share."""
    if revenue is None:
        raise ValueError("each case needs a 'revenue' level")
    v = cb["variable_ratio"]
    variable = revenue * v
    cor = cb["fixed_cost_of_revenue"] + variable
    gross_profit = revenue - cor
    ebit = gross_profit - cb["opex"]
    ebitda = ebit + cb["dna"]
    be = breakevens(cb)

    earnings_metric = ebitda if kind_earnings == "ev_ebitda" else ebit
    ev_earnings = earnings_metric * mult_earnings if mult_earnings is not None else None
    floor_metric = revenue if kind_floor == "ev_sales" else gross_profit
    ev_floor = floor_metric * mult_floor if mult_floor is not None else None

    candidates = [c for c in (ev_earnings, ev_floor) if c is not None]
    ev = max(candidates) if candidates else None
    basis = "earnings" if (ev is not None and ev_earnings is not None
                           and ev == ev_earnings and (ev_floor is None or ev_earnings >= ev_floor)) else "floor"

    equity = None if ev is None else ev + net_cash
    value = None if (equity is None or not shares) else equity / shares

    return {
        "revenue": revenue,
        "variable_cost": variable,
        "cost_of_revenue": cor,
        "gross_profit": gross_profit,
        "gross_margin": gross_profit / revenue if revenue else None,
        "opex": cb["opex"],
        "ebit": ebit,
        "ebit_margin": ebit / revenue if revenue else None,
        "dna": cb["dna"],
        "ebitda": ebitda,
        "ebitda_margin": ebitda / revenue if revenue else None,
        "other_income": cb["other_income"],
        "breakeven": be,
        "headroom_ebit": revenue - be["ebit"],
        "headroom_ebitda": revenue - be["ebitda"],
        "earnings_metric": earnings_metric,
        "mult_earnings": mult_earnings,
        "kind_earnings": kind_earnings,
        "ev_earnings": ev_earnings,
        "floor_metric": floor_metric,
        "mult_floor": mult_floor,
        "kind_floor": kind_floor,
        "ev_floor": ev_floor,
        "ev": ev,
        "basis": basis,
        "net_cash": net_cash,
        "equity": equity,
        "shares": shares,
        "value": value,
        "cost_base": cb,
    }


def merge(base, over):
    out = dict(base or {})
    out.update(over or {})
    return out


# --------------------------------------------------------------------------- #
# scenarios
# --------------------------------------------------------------------------- #
def normalize_scenarios(raw):
    if not isinstance(raw, list) or not raw:
        raise ValueError("'scenarios' must be a non-empty list")
    scenarios = []
    for idx, s in enumerate(raw):
        if not isinstance(s, dict):
            raise ValueError(f"scenarios[{idx}] must be an object")
        if "probability" not in s:
            raise ValueError(f"scenarios[{idx}] is missing 'probability'")
        p = float(s["probability"])
        if p < 0:
            raise ValueError(f"scenarios[{idx}].probability must be non-negative")
        copy = json.loads(json.dumps(s))
        copy["probability"] = p
        scenarios.append(copy)
    total = sum(s["probability"] for s in scenarios)
    if total <= 0:
        raise ValueError("Scenario probability sum must be > 0")
    if total > 1.0001:
        if abs(total - 100.0) <= 0.1:
            for s in scenarios:
                s["probability"] /= 100.0
            total = sum(s["probability"] for s in scenarios)
        else:
            raise ValueError("Scenario probabilities must sum to 1.0 (or 100)")
    if abs(total - 1.0) > 0.001:
        raise ValueError(f"Scenario probabilities must sum to 1.0; got {total:.4f}")
    return scenarios


def _mult_pair(spec, default_earnings, default_floor):
    """A scenario's multiples: {"earnings": 14, "floor": 3.5}, or bare numbers."""
    if spec is None:
        return default_earnings, default_floor
    if isinstance(spec, (int, float, str)):
        return parse_value(spec), default_floor
    e = spec.get("earnings")
    f = spec.get("floor")
    e = default_earnings if e is None else parse_value(e if not isinstance(e, dict) else e.get("value"))
    f = default_floor if f is None else parse_value(f if not isinstance(f, dict) else f.get("value"))
    return e, f


def evaluate(data):
    """Normalize a breakeven input into {scenarios[], history[], intrinsic}."""
    bs = data.get("balance_sheet") or {}
    shares = parse_value(bs.get("diluted_shares"))
    # The count the traded price actually applies to *today*. The valuation uses
    # the forward `diluted_shares` (a case can raise it to fund itself); the
    # reverse solve must not, or it would credit the market with dilution that
    # has not happened yet.
    shares_today = parse_value(bs.get("shares_outstanding"))
    net_cash = parse_value(bs.get("net_cash")) or 0.0
    base_cb = cost_base(data.get("cost_base") or {})

    mspec = data.get("multiple") or {}
    e_spec = mspec.get("earnings") or {}
    f_spec = mspec.get("floor") or {}
    kind_earnings = e_spec.get("kind", "ev_ebitda")
    kind_floor = f_spec.get("kind", "ev_sales")
    if kind_earnings not in _EARNINGS_KINDS:
        raise ValueError(f"multiple.earnings.kind must be one of {_EARNINGS_KINDS}")
    if kind_floor not in _FLOOR_KINDS:
        raise ValueError(f"multiple.floor.kind must be one of {_FLOOR_KINDS}")
    base_e = parse_value(e_spec.get("value"))
    base_f = parse_value(f_spec.get("value"))

    scenarios = []
    for i, s in enumerate(normalize_scenarios(data.get("scenarios"))):
        cb = cost_base(merge(data.get("cost_base"), s.get("cost_base")))
        s_shares = parse_value(s.get("shares"))
        if s_shares is None:
            s_shares = shares
        s_cash = parse_value(s.get("net_cash"))
        if s_cash is None:
            s_cash = net_cash
        me, mf = _mult_pair(s.get("multiple"), base_e, base_f)
        b = bridge(parse_value(s.get("revenue")), cb, s_shares, s_cash,
                   me, kind_earnings, mf, kind_floor)
        b["name"] = s.get("name") or f"Case {i + 1}"
        b["probability"] = s["probability"]
        b["contribution"] = 0.0 if b["value"] is None else b["value"] * s["probability"]
        b["comment"] = s.get("comment")
        scenarios.append(b)

    intrinsic = sum(s["contribution"] for s in scenarios)

    # The filed record. Nothing is assumed here: each period carries its own
    # realized cost of revenue and opex in dollars, and its breakeven revenue is
    # simply that cost base. The point of the table is that the cost base barely
    # moves while revenue swings, so the gross margin is a consequence.
    history = []
    for h in data.get("history") or []:
        rev = parse_value(h.get("revenue"))
        cor = parse_value(h.get("cost_of_revenue"))
        opex = parse_value(h.get("opex"))
        if rev is None or cor is None or opex is None:
            continue
        dna = parse_value(h.get("dna")) or 0.0
        gp = rev - cor
        ebit = gp - opex
        history.append({
            "period": h.get("period", ""),
            "revenue": rev, "cost_of_revenue": cor, "gross_profit": gp,
            "gross_margin": gp / rev if rev else None,
            "opex": opex, "cost_base": cor + opex,
            "ebit": ebit, "dna": dna, "ebitda": ebit + dna,
            "breakeven_ebit": cor + opex,
            "breakeven_ebitda": cor + opex - dna,
            "note": h.get("note"),
        })

    return {
        "method": "Fixed-cost breakeven" + (f" ({data['anchor']})" if data.get("anchor") else ""),
        "symbol": data.get("symbol"),
        "anchor": data.get("anchor"),
        "kind_earnings": kind_earnings,
        "kind_floor": kind_floor,
        "shares": shares,
        "shares_today": shares_today if shares_today is not None else shares,
        "net_cash": net_cash,
        "cost_base": base_cb,
        "breakeven": breakevens(base_cb),
        "scenarios": scenarios,
        "history": history,
        "intrinsic": intrinsic,
    }


def solve_case(evald, data):
    want = str((data.get("market") or {}).get("solve_from") or "").lower()
    for s in evald["scenarios"]:
        if s["name"].lower() == want:
            return s
    return max(evald["scenarios"], key=lambda s: s["probability"])


def reverse(data, evald):
    """Run the model backwards from the traded price.

    Never touches the fair value above. It holds one case's cost base, share
    count and multiples fixed and asks what revenue the price is demanding —
    by each of the two routes, and then by the easier of them.
    """
    market = data.get("market")
    if not market:
        return None
    p = parse_value(market.get("price"))
    if p is None:
        return None
    c = solve_case(evald, data)
    shares = evald["shares_today"]
    ev_mkt = p * shares - evald["net_cash"]
    cb = c["cost_base"]
    absorb = 1.0 - cb["variable_ratio"]

    # Route 1 — pay for it as a revenue franchise.
    req_floor = None
    if c["mult_floor"]:
        target = ev_mkt / c["mult_floor"]
        req_floor = target if c["kind_floor"] == "ev_sales" else \
            (target + cb["fixed_cost_of_revenue"]) / absorb

    # Route 2 — pay for it as an earnings stream.
    req_earn = None
    if c["mult_earnings"]:
        target = ev_mkt / c["mult_earnings"]
        fixed = cb["fixed_cost_of_revenue"] + cb["opex"]
        if c["kind_earnings"] == "ev_ebitda":
            fixed -= cb["dna"]
        req_earn = (target + fixed) / absorb

    candidates = [r for r in (req_floor, req_earn) if r is not None]
    return {
        "price": p,
        "as_of": market.get("as_of"),
        "commentary": market.get("commentary"),
        "case": c,
        "shares_today": shares,
        "market_cap": p * shares,
        "market_ev": ev_mkt,
        "implied_ev_sales": ev_mkt / c["revenue"] if c["revenue"] else None,
        "implied_ev_earnings": ev_mkt / c["earnings_metric"] if c["earnings_metric"] else None,
        "required_revenue_floor": req_floor,
        "required_revenue_earnings": req_earn,
        "required_revenue": min(candidates) if candidates else None,
        "required_earnings": ev_mkt / c["mult_earnings"] if c["mult_earnings"] else None,
    }


def sensitivity(data, evald):
    """Value per share across revenue x earnings multiple.

    The floor makes the low-revenue rows flat: below the breakeven line the
    earnings multiple has nothing to bite on, so paying more for earnings buys
    nothing. That flat region is the picture of the method, not an artifact.
    """
    spec = data.get("sensitivity")
    if not spec:
        return None
    revs = [r for r in (parse_value(x) for x in spec.get("revenue", [])) if r is not None]
    mults = [m for m in (parse_value(x) for x in spec.get("earnings_multiple", [])) if m is not None]
    if not revs or not mults:
        return None
    c = solve_case(evald, data)
    rows = []
    for rev in revs:
        cells = []
        for m in mults:
            b = bridge(rev, c["cost_base"], c["shares"], c["net_cash"],
                       m, c["kind_earnings"], c["mult_floor"], c["kind_floor"])
            cells.append({"value": b["value"], "basis": b["basis"]})
        rows.append({"revenue": rev, "cells": cells})
    return {"case": c, "earnings_multiple": mults, "rows": rows}


# --------------------------------------------------------------------------- #
# report
# --------------------------------------------------------------------------- #
def _rule(char="-", n=78):
    return char * n


def print_report(data, evald):
    sym = evald["symbol"] or "?"
    print(f"\n{_rule('=')}")
    print(f"  {sym} - {evald['method']}")
    print(_rule("="))

    cb = evald["cost_base"]
    be = evald["breakeven"]
    print("\nCOST BASE (anchor)")
    print(f"  Variable share of revenue      {pct(cb['variable_ratio'])}")
    print(f"  Fixed cost of revenue          {money(cb['fixed_cost_of_revenue'])}")
    print(f"  Operating expense              {money(cb['opex'])}")
    print(f"  of which D&A (non-cash)        {money(cb['dna'])}")
    print("\nBREAKEVEN REVENUE - a property of the cost base, no revenue assumed")
    print(f"  Gross profit turns positive    {money(be['gross_profit'])}")
    print(f"  EBITDA turns positive          {money(be['ebitda'])}")
    print(f"  EBIT turns positive            {money(be['ebit'])}")

    if evald["history"]:
        print(f"\n{_rule()}\nFILED RECORD - the cost base in dollars, against revenue")
        print(f"  {'Period':<12}{'Revenue':>10}{'Cost base':>11}{'Gross m':>9}{'EBIT':>10}{'EBITDA':>10}{'vs BE':>10}")
        for h in evald["history"]:
            print(f"  {h['period']:<12}{money(h['revenue']):>10}{money(h['cost_base']):>11}"
                  f"{pct(h['gross_margin']):>9}{money(h['ebit']):>10}{money(h['ebitda']):>10}"
                  f"{money(h['revenue'] - h['breakeven_ebit']):>10}")
        for h in evald["history"]:
            if h["note"]:
                print(f"    {h['period']}: {h['note']}")

    print(f"\n{_rule()}\nTHE CASES")
    for s in evald["scenarios"]:
        print(f"\n  {s['name']}  (p={pct(s['probability'], 0)})")
        print(f"    Revenue                      {money(s['revenue'])}")
        print(f"    - cost of revenue            {money(s['cost_of_revenue'])}")
        print(f"    = gross profit               {money(s['gross_profit'])}   ({pct(s['gross_margin'])} - derived, not assumed)")
        print(f"    - opex                       {money(s['opex'])}")
        print(f"    = EBIT                       {money(s['ebit'])}   ({pct(s['ebit_margin'])})")
        print(f"    + D&A                        {money(s['dna'])}")
        print(f"    = EBITDA                     {money(s['ebitda'])}   ({pct(s['ebitda_margin'])})")
        print(f"    Revenue vs EBIT breakeven    {money(s['headroom_ebit'])}"
              f"   (breakeven {money(s['breakeven']['ebit'])})")
        print(f"    Revenue vs EBITDA breakeven  {money(s['headroom_ebitda'])}"
              f"   (breakeven {money(s['breakeven']['ebitda'])})")
        e_lab = "EV/EBITDA" if s["kind_earnings"] == "ev_ebitda" else "EV/EBIT"
        f_lab = "EV/sales" if s["kind_floor"] == "ev_sales" else "EV/gross profit"
        mark_e = " <-- binds" if s["basis"] == "earnings" else ""
        mark_f = " <-- binds" if s["basis"] == "floor" else ""
        print(f"    EV on {e_lab:<10} {multx(s['mult_earnings']):>6}       {money(s['ev_earnings']):>10}{mark_e}")
        print(f"    EV on {f_lab:<10} {multx(s['mult_floor']):>6}       {money(s['ev_floor']):>10}{mark_f}")
        print(f"    + net cash                   {money(s['net_cash'])}")
        print(f"    / shares                     {money(s['shares'])}")
        print(f"    = VALUE PER SHARE            {price(s['value'])}")
        if s["comment"]:
            print(f"    note: {s['comment']}")

    print(f"\n{_rule()}")
    print(f"  {'Case':<10}{'Prob':>7}{'Revenue':>10}{'Gross m':>9}{'EBITDA':>10}{'Basis':>10}{'Value':>10}{'Weighted':>10}")
    for s in evald["scenarios"]:
        print(f"  {s['name']:<10}{pct(s['probability'], 0):>7}{money(s['revenue']):>10}"
              f"{pct(s['gross_margin']):>9}{money(s['ebitda']):>10}{s['basis']:>10}"
              f"{price(s['value']):>10}{price(s['contribution']):>10}")
    print(_rule())
    print(f"  {'FAIR VALUE (probability-weighted)':<56}{price(evald['intrinsic']):>22}")
    print(_rule("="))

    sens = sensitivity(data, evald)
    if sens:
        print(f"\nSENSITIVITY - value per share, revenue x {'EV/EBITDA' if evald['kind_earnings'] == 'ev_ebitda' else 'EV/EBIT'}")
        print(f"  (holding the {sens['case']['name']} case's cost base, share count and floor multiple;")
        print("   * marks a cell where the revenue floor binds and the earnings multiple does nothing)")
        head = f"  {'Revenue':<10}" + "".join(f"{multx(m):>10}" for m in sens["earnings_multiple"])
        print(head)
        for row in sens["rows"]:
            cells = "".join(
                f"{price(c['value']) + ('*' if c['basis'] == 'floor' else ''):>10}"
                for c in row["cells"])
            print(f"  {money(row['revenue']):<10}{cells}")

    rev = reverse(data, evald)
    if rev:
        c = rev["case"]
        print(f"\n{_rule()}\nWHAT THE PRICE REQUIRES (computed after, and never into, the value above)")
        print(f"  Traded price{(' (' + rev['as_of'] + ')') if rev['as_of'] else ''}          {price(rev['price'])}")
        print(f"  x shares outstanding today         {money(rev['shares_today'])} -> {money(rev['market_cap'])} equity")
        print(f"  Implied enterprise value           {money(rev['market_ev'])}")
        print(f"  ...on {c['name']} revenue{'':<12}     {multx(rev['implied_ev_sales'])} EV/sales"
              f"   (this report uses {multx(c['mult_floor'])})")
        print(f"  ...on {c['name']} EBITDA{'':<13}     {multx(rev['implied_ev_earnings'])} EV/EBITDA"
              f"  (this report uses {multx(c['mult_earnings'])})")
        print(f"  Revenue the price needs, as a franchise   {money(rev['required_revenue_floor'])}")
        print(f"  Revenue the price needs, as earnings      {money(rev['required_revenue_earnings'])}")
        print(f"  ...the easier of the two                  {money(rev['required_revenue'])}"
              f"   ({c['name']} case: {money(c['revenue'])})")
        if rev["commentary"]:
            print(f"\n  {rev['commentary']}")

    print("\nThe fair value above is derived without reference to any market price.\n")


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    with open(sys.argv[1]) as f:
        data = json.load(f)
    print_report(data, evaluate(data))


if __name__ == "__main__":
    main()
