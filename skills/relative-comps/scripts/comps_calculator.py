#!/usr/bin/env python3
"""Relative-valuation (peer multiples) calculator — parity oracle for comps.js.

A forward metric (EPS, EBITDA, revenue, book value) times a peer / re-rating
multiple (P/E, EV/EBITDA, P/B, EV/Sales), EV bridged to equity via net cash,
cross-checked across multiples and probability-weighted across scenarios. This
is the non-browser reference implementation of docs/assets/comps.js; the two must
agree.

Usage:
    python comps_calculator.py <input_json_file>
"""

import json
import sys
from pathlib import Path

# Multiple registry: kind "equity" applies to a per-share metric (price
# directly); kind "ev" applies to a firm-level metric (→ EV → equity via net
# cash → per share).
MULTIPLES = {
    "pe":        {"label": "P/E",       "kind": "equity", "metric": "eps"},
    "ev_ebitda": {"label": "EV/EBITDA", "kind": "ev",     "metric": "ebitda"},
    "pb":        {"label": "P/B",       "kind": "equity", "metric": "bvps"},
    "ev_sales":  {"label": "EV/Sales",  "kind": "ev",     "metric": "revenue"},
    "ev_fcf":    {"label": "EV/FCF",    "kind": "ev",     "metric": "fcf"},
}


def parse_value(value):
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    raw = str(value).strip().upper().replace(",", "")
    mult = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}
    if raw and raw[-1] in mult:
        return float(raw[:-1]) * mult[raw[-1]]
    return float(raw)


def merge_scenario(data, scenario):
    merged = json.loads(json.dumps(scenario))
    for key in ("fundamentals", "multiples", "balance_sheet"):
        base = data.get(key)
        over = scenario.get(key)
        if isinstance(base, dict):
            out = dict(base)
            if isinstance(over, dict):
                out.update(over)
            merged[key] = out
        elif over is not None:
            merged[key] = over
    return merged


def implied_price(key, scenario, net_cash, shares):
    defn = MULTIPLES.get(key)
    m = (scenario.get("multiples") or {}).get(key)
    if defn is None or m is None:
        return None
    base = parse_value((scenario.get("fundamentals") or {}).get(defn["metric"]))
    if base is None:
        return None
    if defn["kind"] == "equity":
        return base * m
    ev = base * m
    return (ev + net_cash) / shares if shares else None


def normalize_probabilities(scenarios):
    total = sum(float(s["probability"]) for s in scenarios)
    if abs(total - 100.0) <= 0.1:
        for s in scenarios:
            s["probability"] = float(s["probability"]) / 100.0
        total = sum(s["probability"] for s in scenarios)
    if abs(total - 1.0) > 0.001:
        raise ValueError(f"Scenario probabilities must sum to 1.0 (or 100); got {total}")


def evaluate(data):
    keys = data.get("multiples") or list(MULTIPLES)
    core_keys = data.get("core_multiples") or keys
    scenarios = json.loads(json.dumps(data["scenarios"]))
    normalize_probabilities(scenarios)

    results = []
    for s in scenarios:
        raw = merge_scenario(data, s)
        bs = raw.get("balance_sheet") or {}
        net_cash = parse_value(bs.get("net_cash")) or 0.0
        shares = parse_value(bs.get("diluted_shares"))
        implied = {k: implied_price(k, raw, net_cash, shares) for k in keys}
        allv = [implied[k] for k in keys if implied[k] is not None]
        corev = [implied[k] for k in core_keys if implied.get(k) is not None]
        blended = sum(allv) / len(allv) if allv else None
        core = sum(corev) / len(corev) if corev else None
        results.append({
            "name": s.get("name", "Scenario"),
            "probability": s["probability"],
            "fundamentals": raw.get("fundamentals"),
            "multiples": raw.get("multiples"),
            "net_cash": net_cash,
            "shares": shares,
            "implied": implied,
            "blended": blended,
            "core": core,
            "low": min(allv) if allv else None,
            "high": max(allv) if allv else None,
            "contribution": (blended or 0) * s["probability"],
        })

    intrinsic = sum(r["contribution"] for r in results)
    core_weighted = sum((r["core"] or 0) * r["probability"] for r in results)
    return {"keys": keys, "scenarios": results, "intrinsic": intrinsic,
            "core_weighted": core_weighted, "peers": data.get("peers", [])}


def reverse(data, e):
    """Take the market price as given and solve for the multiple it implies.

    Nothing here feeds the fair value — it exists to explain the price.
    """
    mkt = data.get("market") or {}
    price = mkt.get("price")
    if not price:
        return None
    s = e["scenarios"][0]
    shares, net_cash = s["shares"], s["net_cash"]
    if not shares:
        return None
    market_cap = price * shares
    ev = market_cap - net_cash
    rows = []
    for k in e["keys"]:
        defn = MULTIPLES[k]
        base = parse_value((s["fundamentals"] or {}).get(defn["metric"]))
        ours = (s["multiples"] or {}).get(k)
        implied = None if not base else (price / base if defn["kind"] == "equity" else ev / base)
        rows.append({"label": defn["label"], "ours": ours, "implied": implied,
                     "ratio": (implied / ours) if (implied and ours) else None})
    return {"price": price, "as_of": mkt.get("as_of"), "market_cap": market_cap, "ev": ev,
            "rows": rows, "gap": price / e["intrinsic"] if e["intrinsic"] else None}


def expectations(data, e, rev):
    """Walk revenue to a later horizon and solve for the multiple still needed."""
    x = data.get("expectations")
    if not x or not rev or not x.get("paths"):
        return None
    s = e["scenarios"][0]
    f = s["fundamentals"] or {}
    revenue0 = parse_value(f.get("revenue"))
    fcf0 = parse_value(f.get("fcf"))
    if not revenue0:
        return None
    r = float(x.get("discount_rate") or 0)
    years = float(x.get("years_to_horizon") or 0)
    comp = float(x.get("compound_years", years))
    bs = x.get("balance_sheet") or {}
    net_cash = parse_value(bs.get("net_cash"))
    net_cash = s["net_cash"] if net_cash is None else net_cash
    shares = parse_value(bs.get("diluted_shares")) or s["shares"]
    discount = (1 + r) ** years
    our_mult = (s["multiples"] or {}).get("ev_fcf")

    paths = []
    for p in x["paths"]:
        g, m = float(p.get("revenue_cagr") or 0), float(p.get("fcf_margin") or 0)
        rev_h = revenue0 * (1 + g) ** comp
        fcf_h = rev_h * m
        demanded = rev["price"] * discount * shares
        required = (demanded - net_cash) / fcf_h if fcf_h else None
        worth = ((fcf_h * our_mult + net_cash) / shares) / discount if (our_mult and fcf_h) else None
        paths.append({"name": p.get("name", "Path"), "cagr": g, "margin": m,
                      "revenue": rev_h, "fcf": fcf_h, "required": required, "worth": worth,
                      "forecast_factor": fcf_h / fcf0 if fcf0 else None,
                      "multiple_factor": required / our_mult if (required and our_mult) else None})
    return {"horizon": x.get("horizon"), "years": years, "discount": discount,
            "discount_rate": r, "our_multiple": our_mult, "paths": paths}


def money(x):
    if x is None:
        return "N/A"
    ax = abs(x)
    for suf, div in (("T", 1e12), ("B", 1e9), ("M", 1e6)):
        if ax >= div:
            return f"${x / div:.0f}{suf}"
    return f"${x:.0f}"


def peer_anchor(peers, key):
    vals = [p[key] for p in peers if p.get(key) is not None]
    if not vals:
        return "—"
    lo, hi = min(vals), max(vals)
    return f"{lo:.1f}×" if lo == hi else f"{lo:.1f}–{hi:.1f}×"


def main():
    if len(sys.argv) < 2:
        print("Usage: python comps_calculator.py <input_json_file>")
        sys.exit(1)
    path = Path(sys.argv[1])
    if not path.exists():
        print(f"Error: input file not found: {path}")
        sys.exit(1)

    data = json.loads(path.read_text())
    e = evaluate(data)
    keys = e["keys"]
    scen = e["scenarios"]
    anchor = data.get("anchor", "")

    print(f"RELATIVE VALUATION — PEER MULTIPLES  ·  {data.get('symbol', '?')}  ·  {anchor}")
    print(f"Peer group: {data.get('peer_group', '—')}\n")

    # Implied price by multiple × scenario.
    print("Implied price by multiple")
    head = f"{'Multiple':<12}{'Peer anchor':>14}" + "".join(f"{s['name']:>10}" for s in scen)
    print(head)
    for k in keys:
        row = f"{MULTIPLES[k]['label']:<12}{peer_anchor(e['peers'], k):>14}"
        row += "".join(f"${s['implied'][k]:>8.0f}" if s['implied'][k] is not None else f"{'—':>9}" for s in scen)
        print(row)
    core_label = " + ".join(MULTIPLES[k]["label"] for k in (data.get("core_multiples") or keys))
    print(f"{'Blended':<12}{'':>14}" + "".join(f"${s['blended']:>8.0f}" for s in scen))
    print(f"{'Core':<12}{'':>14}" + "".join(f"${s['core']:>8.0f}" for s in scen))

    # Scenario summary.
    print("\nScenario summary")
    print(f"{'Scenario':<10}{'Prob':>7}{'Blended':>10}{'Core':>9}{'Range':>16}{'Weighted':>11}")
    for s in scen:
        rng = f"${s['low']:.0f}-${s['high']:.0f}"
        print(f"{s['name']:<10}{s['probability'] * 100:>6.0f}%${s['blended']:>8.0f}${s['core']:>7.0f}{rng:>16}${s['contribution']:>9.0f}")

    print(f"\nProbability-weighted fair value (blended) : ${e['intrinsic']:.0f}")
    print(f"Core cross-check ({core_label}) : ${e['core_weighted']:.0f}")
    # Implied-expectations block: only when the input carries a market price.
    # The fair value above never sees it.
    rev = reverse(data, e)
    if rev:
        print(f"\n--- What the price implies (price ${rev['price']:.2f}"
              f"{', ' + rev['as_of'] if rev['as_of'] else ''}) ---")
        print(f"Market cap {money(rev['market_cap'])}  ·  EV {money(rev['ev'])}"
              f"  ·  price / fair value {rev['gap']:.2f}x")
        print(f"{'Multiple':<12}{'Ours':>9}{'Implied':>10}{'Ratio':>9}")
        for r in rev["rows"]:
            print(f"{r['label']:<12}{r['ours']:>8.1f}x{r['implied']:>9.1f}x{r['ratio']:>8.2f}x")

        x = expectations(data, e, rev)
        if x:
            print(f"\n--- Reasoning to the price via {x['horizon']} "
                  f"({x['discount_rate']:.0%} discount over {x['years']:.0f}y) ---")
            print(f"{'Path':<28}{'Growth/margin':>15}{'Revenue':>10}{'FCF':>9}"
                  f"{'Worth now':>11}{'Needs':>9}")
            for pa in x["paths"]:
                print(f"{pa['name']:<28}{pa['cagr']:>7.0%} /{pa['margin']:>6.0%}"
                      f"{money(pa['revenue']):>10}{money(pa['fcf']):>9}"
                      f"${pa['worth']:>10.0f}{pa['required']:>8.1f}x")
            mid = x["paths"][len(x["paths"]) // 2]
            print(f"\nBridge on '{mid['name']}': forecast {mid['forecast_factor']:.2f}x"
                  f" / discount {x['discount']:.2f}x"
                  f" x re-rating {mid['multiple_factor']:.2f}x"
                  f" = {mid['forecast_factor'] / x['discount'] * mid['multiple_factor']:.2f}x"
                  f"  (actual gap {rev['gap']:.2f}x)")

    print("\nFair value above is computed without reference to any market price.")


if __name__ == "__main__":
    main()
