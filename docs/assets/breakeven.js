/*!
 * breakeven.js — fixed-cost breakeven engine.
 *
 * A faithful browser port of
 *   skills/breakeven/scripts/breakeven_calculator.py,
 * which stays the parity oracle. The report page ships only its *inputs*; every
 * number on it is computed here, in the reader's browser, from those inputs.
 *
 * The model refuses to accept a gross margin. It derives one, because for the
 * businesses this method exists for the gross margin is not an assumption — it
 * is what arithmetic does to a revenue level when the cost of revenue is a
 * capacity cost that sits still:
 *
 *     revenue
 *       − cost of revenue  = fixed block + revenue × variable ratio
 *       = gross profit     → and therefore the gross margin
 *       − opex (dollars)   = EBIT
 *       + D&A              = EBITDA
 *     breakeven revenue    = (fixed cost of revenue + opex) ÷ (1 − variable ratio)
 *
 * Above the breakeven line a business is worth a multiple of what it earns;
 * below it, a multiple of what it sells, because there is nothing to
 * capitalize. Each case is carried at whichever of the two is higher — the
 * revenue multiple is a franchise floor and the earnings multiple takes over
 * once the business clears its own cost base. Both are shown for every case,
 * so the switch is visible rather than chosen.
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

  // A rate written as 0.15 or as 15 both mean 15%.
  function parseRate(value) {
    var r = parseValue(value);
    if (r === null || isNaN(r)) return null;
    return r > 1.0 ? r / 100.0 : r;
  }

  // -------------------------------------------------------------- formatting
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

  // --------------------------------------------------------------- cost base
  var EARNINGS_KINDS = ["ev_ebitda", "ev_ebit"];
  var FLOOR_KINDS = ["ev_sales", "ev_gross_profit"];

  function costBase(cb) {
    cb = cb || {};
    var v = parseRate(cb.variable_ratio);
    if (v === null || isNaN(v)) v = 0;
    var fixedCor = parseValue(cb.fixed_cost_of_revenue);
    var opex = parseValue(cb.opex);
    if (fixedCor === null || opex === null) {
      throw new Error("cost_base needs 'fixed_cost_of_revenue' and 'opex'");
    }
    if (!(v >= 0 && v < 1)) throw new Error("variable_ratio must be in [0, 1)");
    return {
      variable_ratio: v,
      fixed_cost_of_revenue: fixedCor,
      opex: opex,
      dna: parseValue(cb.dna) || 0,
      other_income: parseValue(cb.other_income) || 0
    };
  }

  /** The three revenue levels that matter — a property of the cost base alone. */
  function breakevens(cb) {
    var absorb = 1 - cb.variable_ratio;
    var fixed = cb.fixed_cost_of_revenue + cb.opex;
    return {
      gross_profit: cb.fixed_cost_of_revenue / absorb,
      ebitda: (fixed - cb.dna) / absorb,
      ebit: fixed / absorb
    };
  }

  // ------------------------------------------------------------------ bridge
  function bridge(revenue, cb, shares, netCash, multEarnings, kindEarnings,
                  multFloor, kindFloor) {
    if (revenue === null || revenue === undefined || isNaN(revenue)) {
      throw new Error("each case needs a 'revenue' level");
    }
    var v = cb.variable_ratio;
    var variable = revenue * v;
    var cor = cb.fixed_cost_of_revenue + variable;
    var grossProfit = revenue - cor;
    var ebit = grossProfit - cb.opex;
    var ebitda = ebit + cb.dna;
    var be = breakevens(cb);

    var earningsMetric = kindEarnings === "ev_ebitda" ? ebitda : ebit;
    var evEarnings = (multEarnings === null || multEarnings === undefined)
      ? null : earningsMetric * multEarnings;
    var floorMetric = kindFloor === "ev_sales" ? revenue : grossProfit;
    var evFloor = (multFloor === null || multFloor === undefined)
      ? null : floorMetric * multFloor;

    var ev = null;
    if (evEarnings !== null && evFloor !== null) ev = Math.max(evEarnings, evFloor);
    else if (evEarnings !== null) ev = evEarnings;
    else if (evFloor !== null) ev = evFloor;

    var basis = (ev !== null && evEarnings !== null && ev === evEarnings
      && (evFloor === null || evEarnings >= evFloor)) ? "earnings" : "floor";

    var equity = ev === null ? null : ev + netCash;
    var value = (equity === null || !shares) ? null : equity / shares;

    return {
      revenue: revenue,
      variable_cost: variable,
      cost_of_revenue: cor,
      gross_profit: grossProfit,
      gross_margin: revenue ? grossProfit / revenue : null,
      opex: cb.opex,
      ebit: ebit,
      ebit_margin: revenue ? ebit / revenue : null,
      dna: cb.dna,
      ebitda: ebitda,
      ebitda_margin: revenue ? ebitda / revenue : null,
      other_income: cb.other_income,
      breakeven: be,
      headroom_ebit: revenue - be.ebit,
      headroom_ebitda: revenue - be.ebitda,
      earnings_metric: earningsMetric,
      mult_earnings: multEarnings,
      kind_earnings: kindEarnings,
      ev_earnings: evEarnings,
      floor_metric: floorMetric,
      mult_floor: multFloor,
      kind_floor: kindFloor,
      ev_floor: evFloor,
      ev: ev,
      basis: basis,
      net_cash: netCash,
      equity: equity,
      shares: shares,
      value: value,
      cost_base: cb
    };
  }

  function merge(base, over) {
    var out = {}, k;
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

  function multPair(spec, defaultEarnings, defaultFloor) {
    if (spec === null || spec === undefined) return [defaultEarnings, defaultFloor];
    if (typeof spec !== "object") return [parseValue(spec), defaultFloor];
    var e = spec.earnings, f = spec.floor;
    e = (e === null || e === undefined) ? defaultEarnings
      : parseValue(typeof e === "object" ? e.value : e);
    f = (f === null || f === undefined) ? defaultFloor
      : parseValue(typeof f === "object" ? f.value : f);
    return [e, f];
  }

  function evaluate(data) {
    var bs = data.balance_sheet || {};
    var shares = parseValue(bs.diluted_shares);
    // The count the traded price applies to *today*. The valuation uses the
    // forward `diluted_shares` (a case may raise it to fund itself); the reverse
    // solve must not, or it would credit the market with dilution not yet done.
    var sharesToday = parseValue(bs.shares_outstanding);
    var netCash = parseValue(bs.net_cash) || 0;
    var baseCb = costBase(data.cost_base);

    var mspec = data.multiple || {};
    var eSpec = mspec.earnings || {};
    var fSpec = mspec.floor || {};
    var kindEarnings = eSpec.kind || "ev_ebitda";
    var kindFloor = fSpec.kind || "ev_sales";
    if (EARNINGS_KINDS.indexOf(kindEarnings) < 0) {
      throw new Error("multiple.earnings.kind must be one of " + EARNINGS_KINDS.join(", "));
    }
    if (FLOOR_KINDS.indexOf(kindFloor) < 0) {
      throw new Error("multiple.floor.kind must be one of " + FLOOR_KINDS.join(", "));
    }
    var baseE = parseValue(eSpec.value);
    var baseF = parseValue(fSpec.value);

    var scenarios = normalizeScenarios(data.scenarios).map(function (s, i) {
      var cb = costBase(merge(data.cost_base, s.cost_base));
      var sShares = parseValue(s.shares);
      if (sShares === null || isNaN(sShares)) sShares = shares;
      var sCash = parseValue(s.net_cash);
      if (sCash === null || isNaN(sCash)) sCash = netCash;
      var pair = multPair(s.multiple, baseE, baseF);
      var b = bridge(parseValue(s.revenue), cb, sShares, sCash,
                     pair[0], kindEarnings, pair[1], kindFloor);
      b.name = s.name || "Case " + (i + 1);
      b.probability = s.probability;
      b.contribution = b.value === null ? 0 : b.value * s.probability;
      b.comment = s.comment || null;
      return b;
    });

    var intrinsic = scenarios.reduce(function (a, s) { return a + s.contribution; }, 0);

    // The filed record. Nothing is assumed: each period carries its own realized
    // cost of revenue and opex in dollars, and its breakeven revenue is simply
    // that cost base. The point of the table is that the cost base barely moves
    // while revenue swings, so the gross margin is a consequence, not a choice.
    var history = (data.history || []).map(function (h) {
      var rev = parseValue(h.revenue);
      var cor = parseValue(h.cost_of_revenue);
      var opex = parseValue(h.opex);
      if (rev === null || cor === null || opex === null) return null;
      var dna = parseValue(h.dna) || 0;
      var gp = rev - cor;
      var ebit = gp - opex;
      return {
        period: h.period || "", revenue: rev, cost_of_revenue: cor, gross_profit: gp,
        gross_margin: rev ? gp / rev : null, opex: opex, cost_base: cor + opex,
        ebit: ebit, dna: dna, ebitda: ebit + dna,
        breakeven_ebit: cor + opex, breakeven_ebitda: cor + opex - dna,
        note: h.note || null
      };
    }).filter(function (h) { return h !== null; });

    return {
      method: "Fixed-cost breakeven" + (data.anchor ? " (" + data.anchor + ")" : ""),
      symbol: data.symbol || null,
      anchor: data.anchor || null,
      kind_earnings: kindEarnings,
      kind_floor: kindFloor,
      shares: shares,
      shares_today: (sharesToday === null || isNaN(sharesToday)) ? shares : sharesToday,
      netCash: netCash,
      cost_base: baseCb,
      breakeven: breakevens(baseCb),
      scenarios: scenarios,
      history: history,
      intrinsic: intrinsic
    };
  }

  function solveCase(evald, data) {
    var want = String(((data.market || {}).solve_from) || "").toLowerCase();
    for (var i = 0; i < evald.scenarios.length; i++) {
      if (evald.scenarios[i].name.toLowerCase() === want) return evald.scenarios[i];
    }
    return evald.scenarios.slice().sort(function (a, b) { return b.probability - a.probability; })[0];
  }

  /**
   * Run the model backwards from the traded price. Never touches the fair value
   * above — it holds one case's cost base and multiples fixed and asks what
   * revenue the price is demanding, by each of the two routes.
   */
  function reverse(data, evald) {
    var market = data.market;
    if (!market) return null;
    var p = parseValue(market.price);
    if (p === null || isNaN(p)) return null;
    var c = solveCase(evald, data);
    var shares = evald.shares_today;
    var evMkt = p * shares - evald.netCash;
    var cb = c.cost_base;
    var absorb = 1 - cb.variable_ratio;

    var reqFloor = null;
    if (c.mult_floor) {
      var tf = evMkt / c.mult_floor;
      reqFloor = c.kind_floor === "ev_sales" ? tf : (tf + cb.fixed_cost_of_revenue) / absorb;
    }
    var reqEarn = null;
    if (c.mult_earnings) {
      var te = evMkt / c.mult_earnings;
      var fixed = cb.fixed_cost_of_revenue + cb.opex;
      if (c.kind_earnings === "ev_ebitda") fixed -= cb.dna;
      reqEarn = (te + fixed) / absorb;
    }
    var cands = [reqFloor, reqEarn].filter(function (r) { return r !== null; });

    return {
      price: p, as_of: market.as_of || null, commentary: market.commentary || null,
      case: c, shares_today: shares, market_cap: p * shares, market_ev: evMkt,
      implied_ev_sales: c.revenue ? evMkt / c.revenue : null,
      implied_ev_earnings: c.earnings_metric ? evMkt / c.earnings_metric : null,
      required_revenue_floor: reqFloor,
      required_revenue_earnings: reqEarn,
      required_revenue: cands.length ? Math.min.apply(null, cands) : null,
      required_earnings: c.mult_earnings ? evMkt / c.mult_earnings : null
    };
  }

  /**
   * Value per share across revenue × earnings multiple. The floor makes the
   * low-revenue rows flat: below the breakeven line the earnings multiple has
   * nothing to bite on, so paying more for earnings buys nothing. That flat
   * region is the picture of the method, not an artifact of it.
   */
  function sensitivity(data, evald) {
    var spec = data.sensitivity;
    if (!spec) return null;
    var revs = (spec.revenue || []).map(parseValue).filter(function (r) { return r !== null && !isNaN(r); });
    var mults = (spec.earnings_multiple || []).map(parseValue).filter(function (m) { return m !== null && !isNaN(m); });
    if (!revs.length || !mults.length) return null;
    var c = solveCase(evald, data);
    var rows = revs.map(function (rev) {
      return {
        revenue: rev,
        cells: mults.map(function (m) {
          var b = bridge(rev, c.cost_base, c.shares, c.net_cash,
                         m, c.kind_earnings, c.mult_floor, c.kind_floor);
          return { value: b.value, basis: b.basis };
        })
      };
    });
    return { case: c, earnings_multiple: mults, rows: rows };
  }

  // ------------------------------------------------------------------ render
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

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

  function commentList(items, keyOf, textOf) {
    var list = el("div", "reads");
    items.forEach(function (x) {
      var p = el("p", "read-line");
      p.appendChild(el("span", "read-key", keyOf(x)));
      p.appendChild(el("span", "read-note", " — " + textOf(x)));
      list.appendChild(p);
    });
    return list;
  }

  // Step 1 — where the line sits. No revenue assumption reaches this table.
  function renderBreakeven(evald) {
    var mount = document.getElementById("bev-breakeven");
    if (!mount) return;
    mount.innerHTML = "";
    var cb = evald.cost_base, be = evald.breakeven;
    var rows = [
      ["Fixed cost of revenue", { text: money(cb.fixed_cost_of_revenue), cls: "num" },
        { text: "capacity, not goods", cls: "num muted-cell" }],
      ["+ Operating expense", { text: money(cb.opex), cls: "num" },
        { text: "dollars, never a % of revenue", cls: "num muted-cell" }],
      ["= Cost base to absorb", { text: money(cb.fixed_cost_of_revenue + cb.opex), cls: "num strong" },
        { text: "", cls: "num" }],
      ["   of which D&A (non-cash)", { text: money(cb.dna), cls: "num muted-cell" },
        { text: "the gap between the two breakevens", cls: "num muted-cell" }],
      ["Variable share of revenue", { text: pct(cb.variable_ratio), cls: "num muted-cell" },
        { text: "everything else is fixed", cls: "num muted-cell" }]
    ];
    var foot = ["Revenue that covers it", { text: money(be.ebit), cls: "num strong" },
      { text: "EBITDA breakeven " + money(be.ebitda), cls: "num" }];
    mount.appendChild(tableFrom(["The cost base", "Amount", ""], rows, foot));
  }

  // Step 2 — the filed record: the cost base in dollars, against revenue.
  function renderHistory(evald) {
    var mount = document.getElementById("bev-history");
    if (!mount || !evald.history.length) return;
    mount.innerHTML = "";

    var gms = evald.history.map(function (h) { return h.gross_margin; });
    var lo = Math.min.apply(null, gms), hi = Math.max.apply(null, gms);

    var rows = evald.history.map(function (h) {
      var gap = h.revenue - h.breakeven_ebit;
      var extreme = h.gross_margin === hi || h.gross_margin === lo;
      return [
        h.period,
        { text: money(h.revenue), cls: "num" },
        { text: money(h.cost_base), cls: "num" },
        { text: pct(h.gross_margin), cls: extreme ? "num strong" : "num" },
        { text: money(gap), cls: "num strong" },
        { text: money(h.ebitda), cls: "num muted-cell" }
      ];
    });
    mount.appendChild(tableFrom(
      ["Period", "Revenue", "Cost base", "Gross margin", "Revenue − cost base", "EBITDA"], rows));

    var notes = evald.history.filter(function (h) { return h.note; });
    if (notes.length) {
      mount.appendChild(commentList(notes,
        function (h) { return h.period; }, function (h) { return h.note; }));
    }
  }

  // Step 3 — the bridge, one column per case, one row per rung.
  function renderBridge(evald) {
    var mount = document.getElementById("bev-bridge");
    if (!mount) return;
    mount.innerHTML = "";
    var S = evald.scenarios;
    var eLab = evald.kind_earnings === "ev_ebitda" ? "EV/EBITDA" : "EV/EBIT";
    var fLab = evald.kind_floor === "ev_sales" ? "EV/sales" : "EV/gross profit";

    function line(label, fn, cls) {
      return [label].concat(S.map(function (s) {
        return { text: fn(s), cls: cls ? "num " + cls : "num" };
      }));
    }

    var rows = [
      line("Revenue", function (s) { return money(s.revenue); }, "strong"),
      line("− Cost of revenue", function (s) { return money(s.cost_of_revenue); }, "muted-cell"),
      line("= Gross profit", function (s) { return money(s.gross_profit); }),
      line("   gross margin (derived)", function (s) { return pct(s.gross_margin); }, "strong"),
      line("− Operating expense", function (s) { return money(s.opex); }, "muted-cell"),
      line("= EBIT", function (s) { return money(s.ebit); }),
      line("+ D&A", function (s) { return money(s.dna); }, "muted-cell"),
      line("= EBITDA", function (s) { return money(s.ebitda); }, "strong"),
      line("Revenue vs breakeven", function (s) { return money(s.headroom_ebit); }, "muted-cell"),
      line("EV on " + eLab, function (s) {
        return money(s.ev_earnings) + " @ " + multx(s.mult_earnings) +
          (s.basis === "earnings" ? "  ◀" : "");
      }, s0(S, "earnings")),
      line("EV on " + fLab, function (s) {
        return money(s.ev_floor) + " @ " + multx(s.mult_floor) +
          (s.basis === "floor" ? "  ◀" : "");
      }, s0(S, "floor")),
      line("+ Net cash", function (s) { return money(s.net_cash); }, "muted-cell"),
      line("÷ Diluted shares", function (s) { return shareCount(s.shares); }, "muted-cell")
    ];
    var foot = ["Value per share"].concat(S.map(function (s) {
      return { text: price(s.value), cls: "num strong" };
    }));
    mount.appendChild(tableFrom([""].concat(S.map(function (s) { return s.name; })), rows, foot));
    mount.appendChild(el("p", "meta",
      "◀ marks the basis that binds — the higher of the two, case by case. " +
      "No gross margin is an input anywhere above; every one of them is the " +
      "revenue level meeting the cost base."));
  }

  // A row of EV cells is never uniformly "the one that binds", so this returns
  // no class; the ◀ marker carries it per cell instead.
  function s0() { return null; }

  // Step 4 — the cases, their weights, and the weighted value.
  function renderScenarios(evald) {
    var mount = document.getElementById("bev-scenarios");
    if (!mount) return;
    mount.innerHTML = "";
    var rows = evald.scenarios.map(function (s) {
      return [
        s.name,
        { text: pct(s.probability, 0), cls: "num" },
        { text: money(s.revenue), cls: "num" },
        { text: pct(s.gross_margin), cls: "num" },
        { text: money(s.ebitda), cls: "num" },
        { text: s.basis === "earnings" ? "earnings" : "revenue floor", cls: "num muted-cell" },
        { text: price(s.value), cls: "num strong" },
        { text: price(s.contribution), cls: "num" }
      ];
    });
    mount.appendChild(tableFrom(
      ["Case", "Prob", "Revenue", "Gross margin", "EBITDA", "Valued on", "Value", "Weighted"],
      rows,
      ["Fair value", "", "", "", "", "", "", { text: price(evald.intrinsic), cls: "num strong" }]));

    var withComment = evald.scenarios.filter(function (s) { return s.comment; });
    if (withComment.length) {
      mount.appendChild(commentList(withComment,
        function (s) { return s.name; }, function (s) { return s.comment; }));
    }
  }

  // Step 5 — the grid, with the floor-bound region visible as a flat plateau.
  function renderSensitivity(sens, evald) {
    var mount = document.getElementById("bev-sensitivity");
    if (!mount || !sens) return;
    mount.innerHTML = "";
    var eLab = evald.kind_earnings === "ev_ebitda" ? "EV/EBITDA" : "EV/EBIT";
    var headers = ["Revenue ↓ / " + eLab + " →"].concat(
      sens.earnings_multiple.map(function (m) { return multx(m); }));
    var rows = sens.rows.map(function (row) {
      return [{ text: money(row.revenue), cls: "name strong" }].concat(
        row.cells.map(function (c) {
          return { text: price(c.value), cls: c.basis === "floor" ? "num muted-cell" : "num" };
        }));
    });
    mount.appendChild(tableFrom(headers, rows));
    mount.appendChild(el("p", "meta",
      "Greyed cells are where the revenue floor binds and the earnings multiple " +
      "buys nothing — below the breakeven line there is no earnings stream to pay " +
      "a multiple of, so the whole row is flat. Holding the " + sens.case.name +
      " case's cost base, " + shareCount(sens.case.shares) + " shares and " +
      multx(sens.case.mult_floor) + " floor. Fair value above is " +
      price(evald.intrinsic) + "."));
  }

  // The one section a price may touch, and it runs backwards.
  function renderMarket(rev) {
    var mount = document.getElementById("bev-market");
    if (!mount || !rev) return;
    mount.innerHTML = "";
    var c = rev.case;
    var eLab = c.kind_earnings === "ev_ebitda" ? "EV/EBITDA" : "EV/EBIT";
    var fLab = c.kind_floor === "ev_sales" ? "EV/sales" : "EV/gross profit";

    var rows = [
      ["Traded price" + (rev.as_of ? " (" + rev.as_of + ")" : ""),
        { text: price(rev.price), cls: "num strong" },
        { text: "× " + shareCount(rev.shares_today) + " shares = " + money(rev.market_cap), cls: "num muted-cell" }],
      ["Implied enterprise value",
        { text: money(rev.market_ev), cls: "num strong" },
        { text: "after " + money(c.net_cash) + " net cash", cls: "num muted-cell" }],
      ["Implied " + fLab + " on " + c.name + " revenue",
        { text: multx(rev.implied_ev_sales), cls: "num" },
        { text: "this report uses " + multx(c.mult_floor), cls: "num muted-cell" }],
      ["Implied " + eLab + " on " + c.name + " EBITDA",
        { text: multx(rev.implied_ev_earnings), cls: "num" },
        { text: "this report uses " + multx(c.mult_earnings), cls: "num muted-cell" }],
      ["Revenue the price needs — as a franchise, at " + multx(c.mult_floor),
        { text: money(rev.required_revenue_floor), cls: "num" },
        { text: c.name + " case: " + money(c.revenue), cls: "num muted-cell" }],
      ["Revenue the price needs — as earnings, at " + multx(c.mult_earnings),
        { text: money(rev.required_revenue_earnings), cls: "num" },
        { text: c.name + " case: " + money(c.revenue), cls: "num muted-cell" }],
      ["…the easier of the two routes",
        { text: money(rev.required_revenue), cls: "num strong" },
        { text: "breakeven is " + money(c.breakeven.ebit), cls: "num muted-cell" }]
    ];
    mount.appendChild(tableFrom(["What the price requires", "Required", "For comparison"], rows));
    if (rev.commentary) {
      var p = el("p", "read-line");
      p.appendChild(el("span", "read-note", rev.commentary));
      mount.appendChild(p);
    }
  }

  function renderDrivers(notes) {
    var mount = document.getElementById("bev-drivers");
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
    var body = document.getElementById("bev-key-inputs");
    if (!body) return;
    body.innerHTML = "";
    var bs = data.balance_sheet || {};
    var cb = evald.cost_base;
    var rows = [];
    if (data.anchor) rows.push(["Anchor year", data.anchor]);
    rows.push(["Valued on", (evald.kind_earnings === "ev_ebitda" ? "EV/EBITDA" : "EV/EBIT") +
      ", floored at " + (evald.kind_floor === "ev_sales" ? "EV/sales" : "EV/gross profit")]);
    rows.push(["Fixed cost of revenue", money(cb.fixed_cost_of_revenue)]);
    rows.push(["Operating expense", money(cb.opex)]);
    rows.push(["Variable share of revenue", pct(cb.variable_ratio)]);
    rows.push(["EBIT breakeven revenue", money(evald.breakeven.ebit)]);
    rows.push(["EBITDA breakeven revenue", money(evald.breakeven.ebitda)]);
    if (bs.net_cash !== undefined) rows.push(["Net cash (cash − debt)", money(parseValue(bs.net_cash))]);
    if (bs.shares_outstanding !== undefined) {
      rows.push(["Shares outstanding today", shareCount(parseValue(bs.shares_outstanding))]);
    }
    if (bs.diluted_shares !== undefined) {
      rows.push(["Diluted shares at anchor", shareCount(parseValue(bs.diluted_shares))]);
    }
    if (evald.history.length) {
      var gms = evald.history.map(function (h) { return h.gross_margin; });
      rows.push(["Gross margin, filed range",
        pct(Math.min.apply(null, gms)) + " – " + pct(Math.max.apply(null, gms))]);
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

  function renderAction(data, evald) {
    if (!global.ACTION || !data.action) return null;
    var cases = evald.scenarios.map(function (s) {
      return { name: s.name, probability: s.probability, value: s.value };
    });
    return global.ACTION.mount("bev-action", data.action, cases, evald.intrinsic, data.market, price);
  }

  function renderReport(data, notes) {
    notes = notes || {};
    var evald = evaluate(data);
    var methodEl = document.getElementById("bev-method");
    if (methodEl) methodEl.textContent = evald.method;
    var fvEl = document.getElementById("bev-fairvalue");
    if (fvEl) fvEl.textContent = price(evald.intrinsic);
    var srcEl = document.getElementById("bev-source");
    if (srcEl && data.figures_source) srcEl.textContent = data.figures_source;
    renderBreakeven(evald);
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
  var BEV = {
    parseValue: parseValue, parseRate: parseRate, money: money, price: price,
    pct: pct, multx: multx, shareCount: shareCount,
    costBase: costBase, breakevens: breakevens, bridge: bridge,
    evaluate: evaluate, reverse: reverse, sensitivity: sensitivity,
    renderReport: renderReport
  };

  function readJson(id) {
    var node = document.getElementById(id);
    if (!node) return null;
    try { return JSON.parse(node.textContent); } catch (e) { return null; }
  }

  function boot() {
    var input = readJson("bev-input");
    if (!input) return;
    try {
      renderReport(input, readJson("bev-notes"));
    } catch (err) {
      var box = document.getElementById("bev-fairvalue");
      if (box) box.textContent = "error";
      if (global.console) console.error("Breakeven report render failed:", err);
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = BEV; // Node (parity harness)
  } else {
    global.BEV = BEV;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof window !== "undefined" ? window : this);
