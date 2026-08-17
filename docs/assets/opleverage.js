/*!
 * opleverage.js — operating-leverage (earnings-power bridge) engine.
 *
 * A faithful browser port of
 *   skills/operating-leverage/scripts/opleverage_calculator.py,
 * which stays the parity oracle. The report page ships only its *inputs*; every
 * number on it is computed here, in the reader's browser, from those inputs.
 *
 * The model refuses to accept an earnings figure. It builds one:
 *
 *     revenue × gross margin  → gross profit
 *       − opex                → EBIT
 *       + other income        → pre-tax
 *       × (1 − tax)           → net income
 *       ÷ diluted shares      → EPS
 *       × multiple            → value per share
 *
 * For a business carrying a large fixed cost base, the last line is enormously
 * levered to the second, so the gross margin *is* the valuation. Stating EPS
 * directly would hide that; here it cannot be hidden, and the history block runs
 * the company's own filed actuals through the identical bridge so an assumed
 * margin sits in the same table as every margin it has ever earned.
 *
 * The fair value is computed without reference to any market price. A price, if
 * the input carries one, is used only by the reverse solve and the action band,
 * both of which render after the valuation.
 */
(function (global) {
  "use strict";

  // ----------------------------------------------------------------- parsing
  function parseValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      var v = value.trim().toUpperCase().replace(/,/g, "");
      if (!v) return null;
      var mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
      var suffix = v.slice(-1);
      if (mult[suffix] !== undefined) return parseFloat(v.slice(0, -1)) * mult[suffix];
      return parseFloat(v);
    }
    return null;
  }

  // A rate written as 0.48 or as 48 both mean 48%.
  function parseRate(value) {
    var r = parseValue(value);
    if (r === null || isNaN(r)) return null;
    return r > 1.0 ? r / 100.0 : r;
  }

  // -------------------------------------------------------------- formatting
  // Adaptive precision, so $1.15B never prints as "$1.1B".
  function money(x, decimals) {
    if (x === null || x === undefined || isNaN(x)) return "N/A";
    var ax = Math.abs(x);
    var units = [["T", 1e12], ["B", 1e9], ["M", 1e6], ["K", 1e3]];
    for (var i = 0; i < units.length; i++) {
      if (ax >= units[i][1]) {
        var n = ax / units[i][1];
        var dp = decimals !== undefined ? decimals : (n >= 100 ? 0 : (n >= 10 ? 1 : 2));
        var s = n.toFixed(dp).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
        return (x < 0 ? "-$" : "$") + s + units[i][0];
      }
    }
    return "$" + x.toFixed(0);
  }

  function price(x) {
    if (x === null || x === undefined || isNaN(x)) return "—";
    return "$" + x.toFixed(2);
  }

  function pct(x, dp) {
    if (x === null || x === undefined || isNaN(x)) return "—";
    return (x * 100).toFixed(dp === undefined ? 1 : dp) + "%";
  }

  function multx(x) {
    if (x === null || x === undefined || isNaN(x)) return "—";
    return (x % 1 === 0 ? x.toFixed(0) : x.toFixed(1)) + "×";
  }

  function shareCount(x) {
    if (x === null || x === undefined || isNaN(x)) return "—";
    return x < 1e9 ? Math.round(x / 1e6) + "M" : (x / 1e9).toFixed(2) + "B";
  }

  // ------------------------------------------------------------------ bridge
  /** Revenue + margin + cost base → EBIT → EPS → value per share. */
  function bridge(f, shares, netCash, mult, kind) {
    var revenue = parseValue(f.revenue);
    var gm = parseRate(f.gross_margin);
    var opex = parseValue(f.opex) || 0;
    var other = parseValue(f.other_income) || 0;
    var tax = parseRate(f.tax_rate);
    if (tax === null || isNaN(tax)) tax = 0;

    if (revenue === null || gm === null) throw new Error("each case needs 'revenue' and 'gross_margin'");

    var grossProfit = revenue * gm;
    var ebit = grossProfit - opex;
    var pretax = ebit + other;
    var netIncome = pretax * (1 - tax);
    var eps = shares ? netIncome / shares : null;
    var value;
    if (kind === "ev_ebit") value = shares ? (ebit * mult + netCash) / shares : null;
    else value = eps === null ? null : eps * mult;

    return {
      revenue: revenue, gross_margin: gm, gross_profit: grossProfit,
      opex: opex, ebit: ebit, op_margin: revenue ? ebit / revenue : null,
      other_income: other, pretax: pretax, tax_rate: tax,
      net_income: netIncome, eps: eps, multiple: mult, kind: kind, value: value
    };
  }

  function merge(base, over) {
    var out = {};
    var k;
    for (k in (base || {})) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in (over || {})) if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
    return out;
  }

  // --------------------------------------------------------------- scenarios
  function normalizeScenarios(raw) {
    if (!Array.isArray(raw) || raw.length === 0) throw new Error("'scenarios' must be a non-empty list");
    var scenarios = raw.map(function (s, idx) {
      if (typeof s !== "object" || s === null) throw new Error("scenarios[" + idx + "] must be an object");
      if (!("probability" in s)) throw new Error("scenarios[" + idx + "] is missing 'probability'");
      var p = Number(s.probability);
      if (isNaN(p) || p < 0) throw new Error("scenarios[" + idx + "].probability must be non-negative");
      var copy = JSON.parse(JSON.stringify(s));
      copy.probability = p;
      return copy;
    });
    var total = scenarios.reduce(function (a, x) { return a + x.probability; }, 0);
    if (total <= 0) throw new Error("Scenario probability sum must be > 0");
    if (total > 1.0001) {
      if (Math.abs(total - 100.0) <= 0.1) {
        scenarios.forEach(function (s) { s.probability /= 100.0; });
        total = scenarios.reduce(function (a, x) { return a + x.probability; }, 0);
      } else {
        throw new Error("Scenario probabilities must sum to 1.0 (or 100)");
      }
    }
    if (Math.abs(total - 1.0) > 0.001) {
      throw new Error("Scenario probabilities must sum to 1.0; got " + total.toFixed(4));
    }
    return scenarios;
  }

  /**
   * Normalize an opleverage input into { scenarios[], history[], intrinsic }.
   * The headline intrinsic is the probability-weighted value per share.
   */
  function evaluate(data) {
    var bs = data.balance_sheet || {};
    var shares = parseValue(bs.diluted_shares);
    var netCash = parseValue(bs.net_cash) || 0;
    var topMult = data.multiple || {};
    var kind = topMult.kind || "pe";
    var baseMult = parseValue(topMult.value);

    var scenarios = normalizeScenarios(data.scenarios).map(function (s, i) {
      var f = merge(data.fundamentals, s.fundamentals);
      var sbs = merge(bs, s.balance_sheet);
      var sShares = parseValue(sbs.diluted_shares) || shares;
      var sCash = parseValue(sbs.net_cash);
      if (sCash === null || isNaN(sCash)) sCash = netCash;
      var m = s.multiple;
      m = (m === null || m === undefined)
        ? baseMult
        : parseValue(typeof m === "object" ? m.value : m);
      var b = bridge(f, sShares, sCash, m, kind);
      b.name = s.name || "Case " + (i + 1);
      b.probability = s.probability;
      b.contribution = b.value === null ? 0 : b.value * s.probability;
      b.comment = s.comment || null;
      return b;
    });

    var intrinsic = scenarios.reduce(function (a, s) { return a + s.contribution; }, 0);

    // The filed record, run through the identical bridge.
    var history = (data.history || []).map(function (h) {
      var rev = parseValue(h.revenue);
      var gm = parseRate(h.gross_margin);
      var opex = parseValue(h.opex) || 0;
      if (rev === null || gm === null) return null;
      var gp = rev * gm;
      var ebit = gp - opex;
      return {
        period: h.period || "", revenue: rev, gross_margin: gm, gross_profit: gp,
        opex: opex, ebit: ebit, op_margin: rev ? ebit / rev : null, note: h.note || null
      };
    }).filter(function (h) { return h !== null; });

    return {
      method: "Operating leverage — earnings-power bridge" + (data.anchor ? " (" + data.anchor + ")" : ""),
      symbol: data.symbol || null,
      anchor: data.anchor || null,
      kind: kind, shares: shares, netCash: netCash,
      scenarios: scenarios, history: history, intrinsic: intrinsic
    };
  }

  /** The case a reverse solve or a sensitivity grid holds fixed. */
  function solveCase(evald, data) {
    var want = String(((data.market || {}).solve_from) || "").toLowerCase();
    for (var i = 0; i < evald.scenarios.length; i++) {
      if (evald.scenarios[i].name.toLowerCase() === want) return evald.scenarios[i];
    }
    return evald.scenarios.slice().sort(function (a, b) { return b.probability - a.probability; })[0];
  }

  /**
   * Run the bridge backwards from the traded price. Never touches the fair
   * value above — it only answers what the business would have to do, holding
   * one case's cost base, tax rate, share count and multiple fixed.
   */
  function reverse(data, evald) {
    var market = data.market;
    if (!market) return null;
    var p = parseValue(market.price);
    if (p === null || isNaN(p)) return null;
    var c = solveCase(evald, data);
    var shares = evald.shares, mult = c.multiple;
    var reqEbit, impliedMult;

    if (evald.kind === "ev_ebit") {
      reqEbit = (p * shares - evald.netCash) / mult;
      impliedMult = c.ebit ? (p * shares - evald.netCash) / c.ebit : null;
    } else {
      var reqNi = p * shares / mult;
      var reqPretax = reqNi / (1 - c.tax_rate);
      reqEbit = reqPretax - c.other_income;
      impliedMult = c.eps ? p / c.eps : null;
    }
    var reqGp = reqEbit + c.opex;

    return {
      price: p, as_of: market.as_of || null, commentary: market.commentary || null,
      case: c, implied_multiple: impliedMult,
      required_ebit: reqEbit,
      required_op_margin: c.revenue ? reqEbit / c.revenue : null,
      required_gross_profit: reqGp,
      required_gross_margin: c.revenue ? reqGp / c.revenue : null,
      required_revenue: c.gross_margin ? reqGp / c.gross_margin : null
    };
  }

  /** Value per share across revenue × gross margin — the two that matter. */
  function sensitivity(data, evald) {
    var spec = data.sensitivity;
    if (!spec) return null;
    var revs = (spec.revenue || []).map(parseValue).filter(function (r) { return r !== null && !isNaN(r); });
    var gms = (spec.gross_margin || []).map(parseRate).filter(function (g) { return g !== null && !isNaN(g); });
    if (!revs.length || !gms.length) return null;
    var c = solveCase(evald, data);
    var rows = gms.map(function (gm) {
      return {
        gross_margin: gm,
        values: revs.map(function (rev) {
          return bridge({
            revenue: rev, gross_margin: gm, opex: c.opex,
            other_income: c.other_income, tax_rate: c.tax_rate
          }, evald.shares, evald.netCash, c.multiple, evald.kind).value;
        })
      };
    });
    return { case: c, revenue: revs, rows: rows };
  }

  // ------------------------------------------------------------------ render
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // rows: array of arrays; each cell is a string or { text, cls }.
  function tableFrom(headers, rows, foot) {
    var scroll = el("div", "table-scroll");
    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    headers.forEach(function (h, i) { htr.appendChild(el("th", i === 0 ? null : "num", h)); });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = document.createElement("tbody");
    rows.forEach(function (row) {
      var tr = document.createElement("tr");
      row.forEach(function (cell, i) {
        var isObj = cell && typeof cell === "object";
        var cls = isObj && cell.cls ? cell.cls : (i === 0 ? "name" : "num");
        tr.appendChild(el("td", cls, isObj ? cell.text : cell));
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    if (foot) {
      var tfoot = document.createElement("tfoot");
      var ftr = document.createElement("tr");
      foot.forEach(function (cell, i) {
        var isObj = cell && typeof cell === "object";
        var cls = isObj && cell.cls ? cell.cls : (i === 0 ? "name" : "num");
        ftr.appendChild(el("td", cls, isObj ? cell.text : cell));
      });
      tfoot.appendChild(ftr);
      table.appendChild(tfoot);
    }
    scroll.appendChild(table);
    return scroll;
  }

  // Step 1 — the filed record, through the same bridge as every case below it.
  function renderHistory(evald) {
    var mount = document.getElementById("opl-history");
    if (!mount || !evald.history.length) return;
    mount.innerHTML = "";

    var gms = evald.history.map(function (h) { return h.gross_margin; });
    var lo = Math.min.apply(null, gms), hi = Math.max.apply(null, gms);

    var rows = evald.history.map(function (h) {
      var isHi = h.gross_margin === hi, isLo = h.gross_margin === lo;
      return [
        h.period,
        { text: money(h.revenue), cls: "num" },
        { text: pct(h.gross_margin), cls: isHi || isLo ? "num strong" : "num" },
        { text: money(h.opex), cls: "num muted-cell" },
        { text: money(h.ebit), cls: "num" },
        { text: pct(h.op_margin), cls: "num strong" }
      ];
    });
    mount.appendChild(tableFrom(
      ["Period", "Revenue", "Gross margin", "Opex", "EBIT", "Op margin"], rows));

    var notes = evald.history.filter(function (h) { return h.note; });
    if (notes.length) {
      var list = el("div", "reads");
      notes.forEach(function (h) {
        var p = el("p", "read-line");
        p.appendChild(el("span", "read-key", h.period));
        p.appendChild(el("span", "read-note", " — " + h.note));
        list.appendChild(p);
      });
      mount.appendChild(list);
    }
  }

  // Step 2 — the bridge itself, one column per case, one row per rung.
  function renderBridge(evald) {
    var mount = document.getElementById("opl-bridge");
    if (!mount) return;
    mount.innerHTML = "";
    var S = evald.scenarios;
    var multLabel = evald.kind === "ev_ebit" ? "EV/EBIT" : "P/E";

    function line(label, fn, cls) {
      return [label].concat(S.map(function (s) {
        return { text: fn(s), cls: cls ? "num " + cls : "num" };
      }));
    }

    var rows = [
      line("Revenue", function (s) { return money(s.revenue); }),
      line("× Gross margin", function (s) { return pct(s.gross_margin); }, "strong"),
      line("= Gross profit", function (s) { return money(s.gross_profit); }),
      line("− Operating expense", function (s) { return money(s.opex); }, "muted-cell"),
      line("= EBIT", function (s) { return money(s.ebit); }, "strong"),
      line("   operating margin", function (s) { return pct(s.op_margin); }, "muted-cell"),
      line("+ Other income", function (s) { return money(s.other_income); }, "muted-cell"),
      line("× (1 − tax)", function (s) { return money(s.net_income); }),
      line("÷ Diluted shares", function (s) { return price(s.eps) + " EPS"; }, "strong"),
      line("× " + multLabel, function (s) { return multx(s.multiple); }, "muted-cell")
    ];
    var foot = ["Value per share"].concat(S.map(function (s) {
      return { text: price(s.value), cls: "num strong" };
    }));
    mount.appendChild(tableFrom(
      [""].concat(S.map(function (s) { return s.name; })), rows, foot));
  }

  // Step 3 — the cases, their weights, and the weighted value.
  function renderScenarios(evald) {
    var mount = document.getElementById("opl-scenarios");
    if (!mount) return;
    mount.innerHTML = "";
    var rows = evald.scenarios.map(function (s) {
      return [
        s.name,
        { text: pct(s.probability, 0), cls: "num" },
        { text: money(s.revenue), cls: "num" },
        { text: pct(s.gross_margin), cls: "num strong" },
        { text: money(s.ebit), cls: "num" },
        { text: price(s.eps), cls: "num" },
        { text: multx(s.multiple), cls: "num muted-cell" },
        { text: price(s.value), cls: "num strong" },
        { text: price(s.contribution), cls: "num" }
      ];
    });
    mount.appendChild(tableFrom(
      ["Case", "Prob", "Revenue", "Gross margin", "EBIT", "EPS", "Multiple", "Value", "Weighted"],
      rows,
      ["Fair value", "", "", "", "", "", "", "", { text: price(evald.intrinsic), cls: "num strong" }]));

    var withComment = evald.scenarios.filter(function (s) { return s.comment; });
    if (withComment.length) {
      var list = el("div", "reads");
      withComment.forEach(function (s) {
        var p = el("p", "read-line");
        p.appendChild(el("span", "read-key", s.name));
        p.appendChild(el("span", "read-note", " — " + s.comment));
        list.appendChild(p);
      });
      mount.appendChild(list);
    }
  }

  // The grid: value per share across the only two inputs that really move it.
  function renderSensitivity(sens, evald) {
    var mount = document.getElementById("opl-sensitivity");
    if (!mount || !sens) return;
    mount.innerHTML = "";
    var headers = ["Gross margin ↓ / Revenue →"].concat(sens.revenue.map(function (r) { return money(r); }));
    var rows = sens.rows.map(function (row) {
      return [{ text: pct(row.gross_margin), cls: "name strong" }].concat(
        row.values.map(function (v) { return { text: price(v), cls: "num" }; }));
    });
    mount.appendChild(tableFrom(headers, rows));
    mount.appendChild(el("p", "meta",
      "Holding the " + sens.case.name + " case's " + money(sens.case.opex) +
      " cost base, " + pct(sens.case.tax_rate, 0) + " tax rate and " +
      multx(sens.case.multiple) + " multiple. Fair value above is " +
      price(evald.intrinsic) + "."));
  }

  // The one section a price may touch, and it runs backwards.
  function renderMarket(rev) {
    var mount = document.getElementById("opl-market");
    if (!mount || !rev) return;
    mount.innerHTML = "";
    var c = rev.case;
    var multLabel = c.kind === "ev_ebit" ? "EV/EBIT" : "P/E";

    var rows = [
      ["Traded price" + (rev.as_of ? " (" + rev.as_of + ")" : ""),
        { text: price(rev.price), cls: "num strong" },
        { text: "—", cls: "num muted-cell" }],
      ["Implied " + multLabel + " on " + c.name + " earnings",
        { text: multx(rev.implied_multiple), cls: "num strong" },
        { text: "this report uses " + multx(c.multiple), cls: "num muted-cell" }],
      ["Required EBIT, at " + multx(c.multiple),
        { text: money(rev.required_ebit), cls: "num strong" },
        { text: c.name + " case: " + money(c.ebit), cls: "num muted-cell" }],
      ["…required operating margin",
        { text: pct(rev.required_op_margin), cls: "num" },
        { text: c.name + " case: " + pct(c.op_margin), cls: "num muted-cell" }],
      ["…as a gross margin, at " + money(c.revenue) + " revenue",
        { text: pct(rev.required_gross_margin), cls: "num strong" },
        { text: c.name + " case: " + pct(c.gross_margin), cls: "num muted-cell" }],
      ["…as revenue, at a " + pct(c.gross_margin) + " gross margin",
        { text: money(rev.required_revenue), cls: "num strong" },
        { text: c.name + " case: " + money(c.revenue), cls: "num muted-cell" }]
    ];
    mount.appendChild(tableFrom(["What the price requires", "Required", "For comparison"], rows));
    if (rev.commentary) {
      var p = el("p", "read-line");
      p.appendChild(el("span", "read-note", rev.commentary));
      mount.appendChild(p);
    }
  }

  // Per-input evaluation from the notes sidecar: verdict pill + plain English.
  function renderDrivers(notes) {
    var mount = document.getElementById("opl-drivers");
    if (!mount) return;
    mount.innerHTML = "";
    var drivers = (notes && notes.drivers) || [];
    if (!drivers.length) return;
    drivers.forEach(function (d) {
      var box = el("div", "assump");
      var head = el("div", "assump-head");
      head.appendChild(el("span", "assump-label", d.label || d.key || ""));
      if (d.verdict) head.appendChild(el("span", "verdict", d.verdict));
      box.appendChild(head);
      if (d.comment) box.appendChild(el("p", "read-note", d.comment));
      mount.appendChild(box);
    });
  }

  function renderKeyInputs(data, evald) {
    var body = document.getElementById("opl-key-inputs");
    if (!body) return;
    body.innerHTML = "";
    var bs = data.balance_sheet || {};
    var f = data.fundamentals || {};
    var rows = [];
    if (data.anchor) rows.push(["Anchor year", data.anchor]);
    rows.push(["Value driver", evald.kind === "ev_ebit" ? "EV/EBIT on EBIT, bridged by net cash" : "P/E on net income"]);
    if (f.other_income !== undefined) rows.push(["Other income (interest, net)", money(parseValue(f.other_income))]);
    if (f.tax_rate !== undefined) rows.push(["Tax rate", pct(parseRate(f.tax_rate), 0)]);
    if (bs.net_cash !== undefined) rows.push(["Net cash (cash − debt)", money(parseValue(bs.net_cash))]);
    if (bs.diluted_shares !== undefined) rows.push(["Diluted shares", shareCount(parseValue(bs.diluted_shares))]);
    if (evald.history.length) {
      var gms = evald.history.map(function (h) { return h.gross_margin; });
      rows.push(["Gross margin, filed range", pct(Math.min.apply(null, gms)) + " – " + pct(Math.max.apply(null, gms))]);
    }
    var vals = evald.scenarios.map(function (s) { return s.value; });
    rows.push(["Case range", price(Math.min.apply(null, vals)) + " – " + price(Math.max.apply(null, vals))]);
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      tr.appendChild(el("td", null, r[0]));
      tr.appendChild(el("td", "num", r[1]));
      body.appendChild(tr);
    });
  }

  // The action band — a decision rule read off the values above, never off the
  // price. Delegated to action.js; the cases are this report's own scenarios.
  function renderAction(data, evald) {
    if (!global.ACTION || !data.action) return null;
    var cases = evald.scenarios.map(function (s) {
      return { name: s.name, probability: s.probability, value: s.value };
    });
    return global.ACTION.mount("opl-action", data.action, cases, evald.intrinsic, data.market, price);
  }

  function renderReport(data, notes) {
    notes = notes || {};
    var evald = evaluate(data);
    var methodEl = document.getElementById("opl-method");
    if (methodEl) methodEl.textContent = evald.method;
    var fvEl = document.getElementById("opl-fairvalue");
    if (fvEl) fvEl.textContent = price(evald.intrinsic);
    var srcEl = document.getElementById("opl-source");
    if (srcEl && data.figures_source) srcEl.textContent = data.figures_source;
    renderHistory(evald);
    renderBridge(evald);
    renderScenarios(evald);
    renderSensitivity(sensitivity(data, evald), evald);
    renderMarket(reverse(data, evald));
    renderDrivers(notes);
    renderAction(data, evald);
    renderKeyInputs(data, evald);
    return evald;
  }

  // ------------------------------------------------------------------ public
  var OPLEV = {
    parseValue: parseValue, parseRate: parseRate, money: money, price: price,
    pct: pct, multx: multx, shareCount: shareCount, bridge: bridge,
    evaluate: evaluate, reverse: reverse, sensitivity: sensitivity,
    renderReport: renderReport
  };

  function readJson(id) {
    var node = document.getElementById(id);
    if (!node) return null;
    try { return JSON.parse(node.textContent); } catch (e) { return null; }
  }

  function boot() {
    var input = readJson("opl-input");
    if (!input) return;
    try {
      renderReport(input, readJson("opl-notes"));
    } catch (err) {
      var box = document.getElementById("opl-fairvalue");
      if (box) box.textContent = "error";
      if (global.console) console.error("Operating-leverage report render failed:", err);
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = OPLEV; // Node (parity harness)
  } else {
    global.OPLEV = OPLEV;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof window !== "undefined" ? window : this);
