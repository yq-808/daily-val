#!/usr/bin/env python3
"""Sum-of-the-parts calculator — parity oracle for docs/assets/sotp.js.

Each revenue stream (or asset) is valued on its *own* forward figure and its
*own* multiple, the pieces are added into an enterprise value, adjusted for
non-operating items, bridged to equity via net cash and divided by shares.
Probability-weighted across scenarios.

The point of the structure is that it refuses to average away a difference: a
declining subscription line and a fast-growing licensing line do not deserve the
same multiple, and a non-cash revenue stream can be shown at the zero it is
worth. A single blended multiple hides exactly the judgment the reader needs.

This is the non-browser reference implementation of docs/assets/sotp.js; the two
must agree.

Usage:
    python3 sotp_calculator.py <input_json_file>
"""

import json
import sys
from pathlib import Path

# Display label for a part's multiple, derived from what the figure *is*. Used
# for presentation only — the arithmetic is always amount x multiple.
BASIS_LABELS = {
    "revenue": "EV/Sales",
    "ebitda": "EV/EBITDA",
    "ebit": "EV/EBIT",
    "gross_profit": "EV/Gross profit",
    "fcf": "EV/FCF",
    "book": "P/B",
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


def basis_label(part):
    if part.get("multiple_label"):
        return part["multiple_label"]
    return BASIS_LABELS.get(part.get("basis"), "Multiple")


def normalize_probabilities(scenarios):
    total = sum(float(s["probability"]) for s in scenarios)
    if total <= 0:
        raise ValueError("Scenario probability sum must be > 0")
    if abs(total - 100.0) <= 0.1:
        for s in scenarios:
            s["probability"] = float(s["probability"]) / 100.0
        total = sum(s["probability"] for s in scenarios)
    if abs(total - 1.0) > 0.001:
        raise ValueError(f"Scenario probabilities must sum to 1.0 (or 100); got {total}")


def merge_balance_sheet(data, scenario):
    out = dict(data.get("balance_sheet") or {})
    over = scenario.get("balance_sheet")
    if isinstance(over, dict):
        out.update(over)
    return out


def evaluate_scenario(data, scenario):
    """One scenario: part EVs -> adjustments -> net cash -> equity -> per share."""
    defs = data.get("parts") or []
    overrides = scenario.get("parts") or {}
    bs = merge_balance_sheet(data, scenario)
    net_cash = parse_value(bs.get("net_cash")) or 0.0
    shares = parse_value(bs.get("diluted_shares"))

    parts = []
    for d in defs:
        key = d["key"]
        over = overrides.get(key) or {}
        amount = parse_value(over.get("amount", d.get("amount")))
        multiple = over.get("multiple", d.get("multiple"))
        multiple = None if multiple is None else float(multiple)
        ev = None if amount is None or multiple is None else amount * multiple
        parts.append({
            "key": key,
            "name": d.get("name", key),
            "basis": d.get("basis"),
            "basis_label": basis_label(d),
            "comparable": d.get("comparable"),
            "amount": amount,
            "multiple": multiple,
            "ev": ev,
            "note": over.get("note") or d.get("note"),
        })

    parts_ev = sum(p["ev"] for p in parts if p["ev"] is not None)

    adj_over = scenario.get("adjustments") or {}
    adjustments = []
    for a in data.get("adjustments") or []:
        key = a["key"]
        amount = parse_value(adj_over.get(key, a.get("amount")))
        adjustments.append({
            "key": key,
            "name": a.get("name", key),
            "amount": amount,
            "comment": a.get("comment"),
        })
    adj_total = sum(a["amount"] for a in adjustments if a["amount"] is not None)

    enterprise_value = parts_ev + adj_total
    equity = enterprise_value + net_cash
    per_share = equity / shares if shares else None

    return {
        "name": scenario.get("name", "Scenario"),
        "probability": scenario["probability"],
        "parts": parts,
        "parts_ev": parts_ev,
        "adjustments": adjustments,
        "adjustments_total": adj_total,
        "enterprise_value": enterprise_value,
        "net_cash": net_cash,
        "shares": shares,
        "equity": equity,
        "per_share": per_share,
        "comment": scenario.get("comment"),
    }


def evaluate(data):
    scenarios = json.loads(json.dumps(data["scenarios"]))
    if not isinstance(scenarios, list) or not scenarios:
        raise ValueError("'scenarios' must be a non-empty list")
    normalize_probabilities(scenarios)

    results = []
    for s in scenarios:
        r = evaluate_scenario(data, s)
        r["contribution"] = (r["per_share"] or 0.0) * r["probability"]
        results.append(r)

    intrinsic = sum(r["contribution"] for r in results)
    values = [r["per_share"] for r in results if r["per_share"] is not None]
    anchor = data.get("anchor")
    return {
        "method": "Sum of the parts" + (f" ({anchor})" if anchor else ""),
        "symbol": data.get("symbol"),
        "anchor": anchor,
        "scenarios": results,
        "intrinsic": intrinsic,
        "low": min(values) if values else None,
        "high": max(values) if values else None,
    }


def primary_scenario(evald):
    """The case the walkthrough is built from — the likeliest one."""
    return sorted(evald["scenarios"], key=lambda r: -r["probability"])[0]


def reverse(data, evald):
    """Take the traded price as given and solve for the part it is really buying.

    Credits every *other* part, the adjustments and net cash at our own base-case
    figures, and reads the residual as what the market is paying for the swing
    part. Never feeds the fair value, which is already fixed above.
    """
    mkt = data.get("market") or {}
    price = mkt.get("price")
    solve_key = mkt.get("solve_for")
    if not price or not solve_key:
        return None
    s = primary_scenario(evald)
    if not s["shares"]:
        return None
    price = float(price)
    target = next((p for p in s["parts"] if p["key"] == solve_key), None)
    if target is None:
        return None

    market_cap = price * s["shares"]
    implied_ev = market_cap - s["net_cash"] - s["adjustments_total"]
    others = sum(p["ev"] for p in s["parts"] if p["ev"] is not None and p["key"] != solve_key)
    residual = implied_ev - others
    implied_multiple = residual / target["amount"] if target["amount"] else None
    implied_amount = residual / target["multiple"] if target["multiple"] else None

    return {
        "price": price,
        "as_of": mkt.get("as_of"),
        "implied_ev": implied_ev,
        "commentary": mkt.get("commentary"),
        "market_cap": market_cap,
        "part": target,
        "others_ev": others,
        "residual": residual,
        "implied_multiple": implied_multiple,
        "implied_amount": implied_amount,
        "multiple_ratio": (implied_multiple / target["multiple"]) if implied_multiple and target["multiple"] else None,
        "amount_ratio": (implied_amount / target["amount"]) if implied_amount and target["amount"] else None,
        "fair_value": evald["intrinsic"],
        "gap": price / evald["intrinsic"] if evald["intrinsic"] else None,
    }


# --------------------------------------------------------------------------- #
# Printing
# --------------------------------------------------------------------------- #
def big(x):
    if x is None:
        return "N/A"
    ax = abs(x)
    for suffix, size in (("T", 1e12), ("B", 1e9), ("M", 1e6), ("K", 1e3)):
        if ax >= size:
            n = x / size
            dp = 0 if abs(n) >= 100 else (1 if abs(n) >= 10 else 2)
            s = f"{abs(n):.{dp}f}".rstrip("0").rstrip(".") if dp else f"{abs(n):.0f}"
            return ("-$" if n < 0 else "$") + s + suffix
    return f"${x:,.0f}"


def multx(x):
    if x is None:
        return "—"
    return (f"{x:.0f}" if x % 1 == 0 else f"{x:.1f}") + "×"


def per_share_str(x):
    return "—" if x is None else f"${x:,.2f}"


def print_report(data, evald):
    sym = evald["symbol"] or "?"
    print("=" * 72)
    print(f"{sym} — {evald['method']}")
    print("=" * 72)

    for r in evald["scenarios"]:
        print(f"\n--- {r['name']}  (p={r['probability']:.0%}) " + "-" * 30)
        print(f"{'Part':<38}{'Figure':>12}{'Mult':>8}{'EV':>12}")
        for p in r["parts"]:
            print(f"  {p['name']:<36}{big(p['amount']):>12}{multx(p['multiple']):>8}{big(p['ev']):>12}")
        print(f"  {'Parts, total':<36}{'':>12}{'':>8}{big(r['parts_ev']):>12}")
        for a in r["adjustments"]:
            print(f"  {a['name']:<36}{'':>12}{'':>8}{big(a['amount']):>12}")
        print(f"  {'Enterprise value':<36}{'':>12}{'':>8}{big(r['enterprise_value']):>12}")
        print(f"  {'Net cash':<36}{'':>12}{'':>8}{big(r['net_cash']):>12}")
        print(f"  {'Equity value':<36}{'':>12}{'':>8}{big(r['equity']):>12}")
        print(f"  {'Diluted shares':<36}{'':>12}{'':>8}{big(r['shares']):>12}")
        print(f"  {'Value per share':<36}{'':>12}{'':>8}{per_share_str(r['per_share']):>12}")

    print("\n" + "=" * 72)
    print(f"{'Scenario':<24}{'Prob':>8}{'Per share':>14}{'Weighted':>14}")
    for r in evald["scenarios"]:
        print(f"{r['name']:<24}{r['probability']:>7.0%}{per_share_str(r['per_share']):>14}{per_share_str(r['contribution']):>14}")
    print("-" * 72)
    print(f"{'Probability-weighted fair value':<46}{per_share_str(evald['intrinsic']):>14}")
    print(f"{'Range across scenarios':<46}{per_share_str(evald['low']) + ' – ' + per_share_str(evald['high']):>14}")

    rev = reverse(data, evald)
    if rev:
        print("\n" + "=" * 72)
        print(f"What the price implies  (price {per_share_str(rev['price'])}"
              + (f", {rev['as_of']}" if rev["as_of"] else "") + ")")
        print("=" * 72)
        print(f"  Market capitalisation                 {big(rev['market_cap']):>12}")
        print(f"  Implied enterprise value              {big(rev['implied_ev']):>12}")
        print(f"  Less the other parts, at our figures  {big(-rev['others_ev']):>12}")
        print(f"  Residual for {rev['part']['name']:<25}{big(rev['residual']):>12}")
        print(f"    implied multiple                    {multx(rev['implied_multiple']):>12}   (ours {multx(rev['part']['multiple'])})")
        print(f"    or, at our multiple, a figure of    {big(rev['implied_amount']):>12}   (ours {big(rev['part']['amount'])})")
        if rev["gap"]:
            print(f"  Price / fair value                    {rev['gap']:>11.2f}×")
    print()


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    data = json.loads(Path(sys.argv[1]).read_text())
    print_report(data, evaluate(data))


if __name__ == "__main__":
    main()
