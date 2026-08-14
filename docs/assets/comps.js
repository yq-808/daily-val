/*
 * daily-val — client-side relative-valuation (peer multiples) engine.
 *
 * A sibling to docs/assets/dcf.js, for businesses where a forward-metric ×
 * peer-multiple story is the honest model and a smooth FCFF DCF is not —
 * cyclicals, and high-multiple names whose GAAP earnings are too distorted to
 * discount. It anchors a forward metric (EPS, EBITDA, revenue, free cash flow,
 * book value), applies a peer/re-rating multiple (P/E, EV/EBITDA, P/B,
 * EV/Sales, EV/FCF), bridges EV→equity via net cash where needed, and averages
 * across multiples.
 *
 * The static pages ship the *inputs* only; this script turns them into the
 * final valuation. Valuation only — no live market price.
 *
 * The report reads as a simple three-step walkthrough:
 *   1. what the peers trade at,
 *   2. our forward figure × chosen multiple for this stock,
 *   3. each multiple's implied price, averaged into the fair value.
 */
(function (global) {
  "use strict";

  // ----------------------------------------------------------------- parsing
  function parseValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      var v = value.trim().toUpperCase().replace(/,/g, "");
      var mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
      var suffix = v.slice(-1);
      if (mult[suffix] !== undefined) return parseFloat(v.slice(0, -1)) * mult[suffix];
      return parseFloat(v);
    }
    return null;
  }

  // -------------------------------------------------------------- formatting
  function money(x, decimals) {
    if (x === null || x === undefined || isNaN(x)) return "N/A";
    if (decimals === undefined) decimals = 2;
    var ax = Math.abs(x);
    var units = [["T", 1e12], ["B", 1e9], ["M", 1e6], ["K", 1e3]];
    for (var i = 0; i < units.length; i++) {
      if (ax >= units[i][1]) return "$" + (x / units[i][1]).toFixed(decimals) + units[i][0];
    }
    return "$" + x.toFixed(0);
  }

  function price(x) {
    if (x === null || x === undefined || isNaN(x)) return "—";
    return "$" + Math.round(x).toLocaleString("en-US");
  }

  // Adaptive precision for firm-level figures, so a $5.25B free-cash-flow line
  // does not print as "$5B": more decimals the smaller the mantissa, with
  // trailing zeros trimmed ($195B, $13.8B, $5.25B).
  function bigMoney(x) {
    if (x === null || x === undefined || isNaN(x)) return "N/A";
    var ax = Math.abs(x);
    var units = [["T", 1e12], ["B", 1e9], ["M", 1e6], ["K", 1e3]];
    for (var i = 0; i < units.length; i++) {
      if (ax >= units[i][1]) {
        var n = x / units[i][1];
        var dp = Math.abs(n) >= 100 ? 0 : (Math.abs(n) >= 10 ? 1 : 2);
        // Trim trailing zeros only *after* a decimal point — a bare "150" must
        // not become "15".
        var s = Math.abs(n).toFixed(dp).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
        // Sign outside the currency symbol, so net debt reads "-$2.5B".
        return (n < 0 ? "-$" : "$") + s + units[i][0];
      }
    }
    return "$" + x.toFixed(0);
  }

  // Per-share figures: cents matter for a $4.05 EPS but not for a $115 one.
  function perShare(x) {
    if (x === null || x === undefined || isNaN(x)) return "—";
    return Math.abs(x) < 100 ? "$" + x.toFixed(2) : "$" + Math.round(x).toLocaleString("en-US");
  }

  function multx(x) {
    if (x === null || x === undefined || isNaN(x)) return "—";
    return (x % 1 === 0 ? x.toFixed(0) : x.toFixed(1)) + "×";
  }

  function shareCount(x) {
    if (x === null || x === undefined || isNaN(x)) return "—";
    return x < 1e9 ? Math.round(x / 1e6) + "M" : (x / 1e9).toFixed(2) + "B";
  }

  // ----------------------------------------------------------- multiples map
  // Each multiple maps a forward figure + a chosen multiple to an implied share
  // price. Two kinds: "equity" applies to a per-share figure (price directly);
  // "ev" applies to a firm-level figure → enterprise value, bridged to equity
  // via net cash, then divided by shares.
  var MULTIPLES = {
    pe:        { label: "P/E",       kind: "equity", metric: "eps",     metricLabel: "EPS",                fmt: perShare },
    ev_ebitda: { label: "EV/EBITDA", kind: "ev",     metric: "ebitda",  metricLabel: "EBITDA",             fmt: bigMoney },
    pb:        { label: "P/B",       kind: "equity", metric: "bvps",    metricLabel: "Book value / share", fmt: perShare },
    ev_sales:  { label: "EV/Sales",  kind: "ev",     metric: "revenue", metricLabel: "Revenue",            fmt: bigMoney },
    ev_fcf:    { label: "EV/FCF",    kind: "ev",     metric: "fcf",     metricLabel: "Free cash flow",     fmt: bigMoney },
  };

  function metricValue(key, fundamentals) {
    var def = MULTIPLES[key];
    return def ? parseValue((fundamentals || {})[def.metric]) : null;
  }

  function impliedPrice(key, scenario, ctx) {
    var def = MULTIPLES[key];
    if (!def) return null;
    var m = scenario.multiples ? scenario.multiples[key] : null;
    if (m === null || m === undefined) return null;
    var base = metricValue(key, scenario.fundamentals);
    if (base === null || isNaN(base)) return null;
    if (def.kind === "equity") return base * m;
    var equity = base * m + ctx.netCash; // EV + net cash
    return ctx.shares ? equity / ctx.shares : null;
  }

  // Plain-English calculation for one multiple, e.g. "$115 × 10" or
  // "$150B × 8, + $25B net cash, ÷ 1.13B shares".
  function calcString(key, scenario, ctx) {
    var def = MULTIPLES[key];
    var m = scenario.multiples[key];
    var base = metricValue(key, scenario.fundamentals);
    if (def.kind === "equity") return def.fmt(base) + " × " + multx(m);
    return bigMoney(base) + " × " + multx(m) + ", + " + bigMoney(ctx.netCash) +
      " net cash, ÷ " + shareCount(ctx.shares) + " shares";
  }

  function mean(xs) {
    var v = xs.filter(function (x) { return x !== null && !isNaN(x); });
    return v.length ? v.reduce(function (s, x) { return s + x; }, 0) / v.length : null;
  }

  // --------------------------------------------------------------- scenarios
  function normalizeScenarios(raw) {
    if (!Array.isArray(raw) || raw.length === 0) throw new Error("'scenarios' must be a non-empty list");
    var scenarios = raw.map(function (s, idx) {
      if (typeof s !== "object" || s === null) throw new Error("scenarios[" + idx + "] must be an object");
      if (!("probability" in s)) throw new Error("scenarios[" + idx + "] is missing 'probability'");
      var p = Number(s.probability);
      if (isNaN(p) || p < 0) throw new Error("scenarios[" + idx + "].probability must be a non-negative number");
      var copy = JSON.parse(JSON.stringify(s));
      copy.probability = p;
      return copy;
    });
    var total = scenarios.reduce(function (s, x) { return s + x.probability; }, 0);
    if (total <= 0) throw new Error("Scenario probability sum must be > 0");
    if (total > 1.0001) {
      if (Math.abs(total - 100.0) <= 0.1) {
        scenarios.forEach(function (s) { s.probability /= 100.0; });
        total = scenarios.reduce(function (s, x) { return s + x.probability; }, 0);
      } else {
        throw new Error("Scenario probabilities must sum to 1.0 (or 100)");
      }
    }
    if (Math.abs(total - 1.0) > 0.001) throw new Error("Scenario probabilities must sum to 1.0; got " + total.toFixed(4));
    return scenarios;
  }

  // Merge top-level defaults (fundamentals / multiples / balance_sheet) with a
  // scenario's overrides.
  function mergeScenario(baseData, scenario) {
    var merged = JSON.parse(JSON.stringify(scenario));
    ["fundamentals", "multiples", "balance_sheet"].forEach(function (key) {
      var base = baseData[key], over = scenario[key];
      if (base && typeof base === "object" && !Array.isArray(base)) {
        var out = JSON.parse(JSON.stringify(base));
        if (over && typeof over === "object" && !Array.isArray(over)) {
          for (var k in over) { if (over.hasOwnProperty(k)) out[k] = over[k]; }
        }
        merged[key] = out;
      } else if (over !== undefined) {
        merged[key] = over;
      }
    });
    return merged;
  }

  /**
   * Normalize a comps input into { method, anchor, multiples, scenarios[],
   * intrinsic }. Each scenario carries its implied price per multiple, the
   * average (fair value), and `raw` = the merged inputs behind it. The headline
   * intrinsic is the probability-weighted average (a single case → its average).
   */
  function evaluate(data) {
    var keys = data.multiples || Object.keys(MULTIPLES);
    var scen = normalizeScenarios(data.scenarios);
    var results = scen.map(function (s, idx) {
      var raw = mergeScenario(data, s);
      var bs = raw.balance_sheet || {};
      var ctx = { netCash: parseValue(bs.net_cash) || 0, shares: parseValue(bs.diluted_shares) };
      var implied = {};
      keys.forEach(function (k) { implied[k] = impliedPrice(k, raw, ctx); });
      var vals = keys.map(function (k) { return implied[k]; }).filter(function (x) { return x !== null && !isNaN(x); });
      var avg = mean(keys.map(function (k) { return implied[k]; }));
      return {
        name: s.name || "Scenario " + (idx + 1),
        probability: s.probability,
        ctx: ctx,
        implied: implied,
        average: avg,
        low: vals.length ? Math.min.apply(null, vals) : null,
        high: vals.length ? Math.max.apply(null, vals) : null,
        contribution: avg * s.probability,
        raw: raw,
      };
    });
    var intrinsic = results.reduce(function (s, r) { return s + r.contribution; }, 0);
    return {
      method: "Relative valuation — peer multiples" + (data.anchor ? " (" + data.anchor + ")" : ""),
      symbol: data.symbol || null,
      anchor: data.anchor || null,
      multiples: keys,
      scenarios: results,
      intrinsic: intrinsic,
      peers: data.peers || [],
    };
  }

  // ------------------------------------------------ implied expectations
  // Everything below takes the market price as *given* and solves backwards.
  // None of it feeds the fair value above — that is still computed without
  // reference to the price. This exists only to answer "what would you have to
  // believe for today's price to be right?".

  function pct(x) {
    return (x === null || x === undefined || isNaN(x)) ? "—" : (x * 100).toFixed(0) + "%";
  }

  // (a) The multiple the price implies on the very same anchor-year figures.
  // Equity multiples compare against the price directly; EV multiples against
  // market cap less net cash.
  function reverse(data, evald) {
    var mkt = data.market;
    if (!mkt || !(Number(mkt.price) > 0)) return null;
    var s = primaryScenario(evald);
    if (!s.ctx.shares) return null;
    var price = Number(mkt.price);
    var marketCap = price * s.ctx.shares;
    var ev = marketCap - s.ctx.netCash;

    var rows = evald.multiples.map(function (k) {
      var def = MULTIPLES[k];
      var base = metricValue(k, s.raw.fundamentals);
      var ours = s.raw.multiples[k];
      var implied = (base === null || isNaN(base) || !base) ? null
        : (def.kind === "equity" ? price / base : ev / base);
      return {
        key: k, label: def.label, ours: ours, implied: implied,
        ratio: (implied !== null && ours) ? implied / ours : null,
      };
    });
    return {
      price: price, asOf: mkt.as_of || null, commentary: mkt.commentary || null,
      marketCap: marketCap, ev: ev, rows: rows,
      fairValue: evald.intrinsic,
      gap: evald.intrinsic ? price / evald.intrinsic : null,
    };
  }

  // (b) Walk the anchor-year revenue out to a later horizon on a growth +
  // margin path, then solve for the only number left over: the multiple the
  // business would still have to command at that horizon for today's price to
  // be right. Also shows what each path is worth today at *our* multiple.
  function expectations(data, evald, rev) {
    var x = data.expectations;
    if (!x || !rev || !Array.isArray(x.paths) || !x.paths.length) return null;
    var s = primaryScenario(evald);
    var revenue0 = metricValue("ev_sales", s.raw.fundamentals);
    var fcf0 = metricValue("ev_fcf", s.raw.fundamentals);
    if (!revenue0) return null;

    var r = Number(x.discount_rate) || 0;
    var years = Number(x.years_to_horizon) || 0;
    var comp = Number(x.compound_years);
    if (isNaN(comp)) comp = years;
    var bs = x.balance_sheet || {};
    var netCashH = parseValue(bs.net_cash);
    if (netCashH === null || isNaN(netCashH)) netCashH = s.ctx.netCash;
    var sharesH = parseValue(bs.diluted_shares) || s.ctx.shares;
    var discount = Math.pow(1 + r, years);
    var ourMultiple = s.raw.multiples.ev_fcf || null;

    var paths = x.paths.map(function (p) {
      var g = Number(p.revenue_cagr) || 0;
      var m = Number(p.fcf_margin) || 0;
      var revenueH = revenue0 * Math.pow(1 + g, comp);
      var fcfH = revenueH * m;
      // Equity value the price demands at the horizon, then back out the multiple.
      var demandedEquity = rev.price * discount * sharesH;
      var required = fcfH ? (demandedEquity - netCashH) / fcfH : null;
      var worthToday = (ourMultiple && fcfH)
        ? ((fcfH * ourMultiple + netCashH) / sharesH) / discount : null;
      return {
        name: p.name, comment: p.comment || null, cagr: g, margin: m,
        revenue: revenueH, fcf: fcfH, required: required, worthToday: worthToday,
        forecastFactor: fcf0 ? fcfH / fcf0 : null,
        multipleFactor: (required && ourMultiple) ? required / ourMultiple : null,
      };
    });
    return {
      horizon: x.horizon || null, years: years, compoundYears: comp,
      discountRate: r, discount: discount, ourMultiple: ourMultiple,
      commentary: x.commentary || null, netCash: netCashH, shares: sharesH,
      paths: paths,
    };
  }

  function peerAnchor(peers, key) {
    var vals = (peers || []).map(function (p) { return p[key]; })
      .filter(function (x) { return x !== null && x !== undefined && !isNaN(x); });
    if (!vals.length) return "—";
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    return lo === hi ? multx(lo) : lo.toFixed(1) + "–" + multx(hi);
  }

  // ------------------------------------------------------------- DOM helpers
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // rows: array of arrays; each cell is a string or { text, cls }.
  function tableFrom(headers, rows) {
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
    scroll.appendChild(table);
    return scroll;
  }

  // The report is built from the single (base) case. If several scenarios are
  // present, the highest-probability one drives this simple view.
  function primaryScenario(evald) {
    return evald.scenarios.slice().sort(function (a, b) { return b.probability - a.probability; })[0];
  }

  // Step 1 — what the peers trade at.
  function renderPeers(evald) {
    var mount = document.getElementById("cmp-peers");
    if (!mount) return;
    mount.innerHTML = "";
    var keys = evald.multiples;
    var headers = ["Peer"].concat(keys.map(function (k) { return MULTIPLES[k] ? MULTIPLES[k].label : k; }));
    var rows = (evald.peers || []).map(function (p) {
      return [p.name].concat(keys.map(function (k) { return multx(p[k]); }));
    });
    rows.push([{ text: "Peer range", cls: "name muted-cell" }].concat(
      keys.map(function (k) { return { text: peerAnchor(evald.peers, k), cls: "num muted-cell" }; })));
    mount.appendChild(tableFrom(headers, rows));
  }

  // Step 2 — our forward figure × chosen multiple, with the peer range beside it.
  function renderInputs(evald, notes) {
    var mount = document.getElementById("cmp-inputs");
    if (!mount) return;
    mount.innerHTML = "";
    var s = primaryScenario(evald);
    var headers = ["Multiple", (evald.symbol ? evald.symbol + "'s" : "The") + " FY figure",
                   "Our multiple", "Peer range"];
    var rows = evald.multiples.map(function (k) {
      var def = MULTIPLES[k];
      var mv = metricValue(k, s.raw.fundamentals);
      return [
        def.label,
        { text: def.metricLabel + " " + def.fmt(mv), cls: "num" },
        { text: multx(s.raw.multiples[k]), cls: "num strong" },
        { text: peerAnchor(evald.peers, k), cls: "num muted-cell" },
      ];
    });
    mount.appendChild(tableFrom(headers, rows));

    if (notes && Array.isArray(notes.drivers) && notes.drivers.length) {
      var list = el("div", "reads");
      notes.drivers.forEach(function (d) {
        var p = el("p", "read-line");
        if (d.label) p.appendChild(el("span", "read-key", d.label));
        if (d.comment) p.appendChild(el("span", "read-note", (d.label ? " — " : "") + d.comment));
        list.appendChild(p);
      });
      mount.appendChild(list);
    }
  }

  // Step 3 — each multiple's implied price, averaged into the fair value.
  function renderCalc(evald) {
    var mount = document.getElementById("cmp-calc");
    if (!mount) return;
    mount.innerHTML = "";
    var s = primaryScenario(evald);
    var headers = ["Multiple", "Calculation", "Implied price"];
    var rows = evald.multiples.map(function (k) {
      return [MULTIPLES[k].label, { text: calcString(k, s.raw, s.ctx), cls: "num muted-cell" }, { text: price(s.implied[k]), cls: "num" }];
    });
    rows.push([
      { text: "Fair value", cls: "name strong" },
      { text: "average of the " + evald.multiples.length + " prices", cls: "num muted-cell" },
      { text: price(s.average), cls: "num strong" },
    ]);
    mount.appendChild(tableFrom(headers, rows));
  }

  // Step 4 — take the price as given and read off the multiple it implies.
  function renderMarket(rev) {
    var mount = document.getElementById("cmp-market");
    if (!mount || !rev) return;
    mount.innerHTML = "";

    var band = el("div", "fairvalue-band");
    band.appendChild(el("span", "fv-label",
      "Market price" + (rev.asOf ? " · " + rev.asOf : "")));
    band.appendChild(el("span", "fv-value", price(rev.price)));
    mount.appendChild(band);

    var rows = rev.rows.map(function (r) {
      return [r.label,
        { text: multx(r.ours), cls: "num" },
        { text: multx(r.implied), cls: "num strong" },
        { text: r.ratio ? r.ratio.toFixed(2) + "×" : "—", cls: "num muted-cell" }];
    });
    rows.push([
      { text: "Per share", cls: "name strong" },
      { text: price(rev.fairValue), cls: "num" },
      { text: price(rev.price), cls: "num strong" },
      { text: rev.gap ? rev.gap.toFixed(2) + "×" : "—", cls: "num muted-cell" },
    ]);
    mount.appendChild(tableFrom(
      ["", "Our multiple", "Implied by the price", "Ratio"], rows));

    if (rev.commentary) {
      var note = el("p", "read-note", rev.commentary);
      note.style.display = "block";
      note.style.marginTop = "12px";
      mount.appendChild(note);
    }
  }

  // Step 5 — the only honest way to "reach" the price: push the figures out to
  // a later horizon and solve for the multiple still required there.
  function renderExpectations(exp, rev) {
    var mount = document.getElementById("cmp-expect");
    if (!mount || !exp || !rev) return;
    mount.innerHTML = "";
    var H = exp.horizon || "horizon";

    var rows = exp.paths.map(function (p) {
      return [p.name,
        { text: pct(p.cagr) + " / " + pct(p.margin), cls: "num muted-cell" },
        { text: bigMoney(p.revenue), cls: "num" },
        { text: bigMoney(p.fcf), cls: "num" },
        { text: price(p.worthToday), cls: "num" },
        { text: multx(p.required), cls: "num strong" }];
    });
    mount.appendChild(tableFrom(
      ["Path to " + H, "Growth / margin", H + " revenue", H + " FCF",
       "Worth today at " + multx(exp.ourMultiple), "Multiple needed for " + price(rev.price)],
      rows));

    // The multiplicative bridge, spelled out on the middle path.
    var mid = exp.paths[Math.floor(exp.paths.length / 2)];
    if (mid && mid.forecastFactor && mid.multipleFactor) {
      var bridge = el("div", "reads");
      var line = el("p", "read-line");
      line.appendChild(el("span", "read-key", "Why the gap is multiplicative"));
      line.appendChild(el("span", "read-note", " — on the \u201c" + mid.name +
        "\u201d path the price is " + rev.gap.toFixed(2) + "× our fair value, and that " +
        "factors cleanly: cash flow grows " + mid.forecastFactor.toFixed(2) +
        "× by " + H + ", which is worth " + exp.discount.toFixed(2) +
        "× less after discounting " + exp.years + " years at " + pct(exp.discountRate) +
        ", leaving a " + mid.multipleFactor.toFixed(2) +
        "× re-rating — from " + multx(exp.ourMultiple) + " to " + multx(mid.required) +
        " — to make up the rest. Forecast and multiple multiply; neither alone gets there."));
      bridge.appendChild(line);
      exp.paths.forEach(function (p) {
        if (!p.comment) return;
        var l = el("p", "read-line");
        l.appendChild(el("span", "read-key", p.name));
        l.appendChild(el("span", "read-note", " — " + p.comment));
        bridge.appendChild(l);
      });
      mount.appendChild(bridge);
    }

    if (exp.commentary) {
      var note = el("p", "read-note", exp.commentary);
      note.style.display = "block";
      note.style.marginTop = "12px";
      mount.appendChild(note);
    }
  }

  function renderKeyInputs(data, evald) {
    var kbody = document.getElementById("cmp-key-inputs");
    if (!kbody) return;
    kbody.innerHTML = "";
    var bs = data.balance_sheet || {};
    var rows = [];
    if (data.anchor) rows.push(["Forward year", data.anchor]);
    if (data.peer_group) rows.push(["Peer group", data.peer_group]);
    if (bs.net_cash !== undefined) rows.push(["Net cash (cash − debt)", money(parseValue(bs.net_cash))]);
    if (bs.diluted_shares !== undefined) rows.push(["Diluted shares", shareCount(parseValue(bs.diluted_shares))]);
    rows.push(["Multiples used", evald.multiples.map(function (k) { return MULTIPLES[k] ? MULTIPLES[k].label : k; }).join(", ")]);
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      tr.appendChild(el("td", null, r[0]));
      tr.appendChild(el("td", "num", r[1]));
      kbody.appendChild(tr);
    });
  }

  // The action band — a decision rule read off the values above, never off the
  // price. Delegated to action.js.
  //
  // A multi-scenario comps report spreads across its scenarios like the other
  // engines. A single-case report has no scenario spread, so the honest range
  // is the one its own multiples already disagree over: each multiple's implied
  // price becomes a case, and the band straddles that instead.
  function renderAction(data, evald) {
    if (!global.ACTION || !data.action) return null;
    var cases;
    if (evald.scenarios.length > 1) {
      cases = evald.scenarios.map(function (s) {
        return { name: s.name, probability: s.probability, value: s.average };
      });
    } else {
      var only = evald.scenarios[0];
      cases = evald.multiples.map(function (k) {
        var m = MULTIPLES[k];
        return { name: m ? m.label : k, probability: 0, value: only.implied[k] };
      }).filter(function (c) { return c.value !== null && !isNaN(c.value); });
    }
    return global.ACTION.mount("cmp-action", data.action, cases, evald.intrinsic, data.market, price);
  }

  function renderReport(data, notes) {
    notes = notes || {};
    var evald = evaluate(data);
    var methodEl = document.getElementById("cmp-method");
    if (methodEl) methodEl.textContent = evald.method;
    var fvEl = document.getElementById("cmp-fairvalue");
    if (fvEl) fvEl.textContent = price(evald.intrinsic);
    var srcEl = document.getElementById("cmp-source");
    if (srcEl && data.fundamentals_source) srcEl.textContent = data.fundamentals_source;
    renderPeers(evald);
    renderInputs(evald, notes);
    renderCalc(evald);
    var rev = reverse(data, evald);
    renderMarket(rev);
    renderExpectations(expectations(data, evald, rev), rev);
    renderAction(data, evald);
    renderKeyInputs(data, evald);
    return evald;
  }

  // ------------------------------------------------------------------ public
  var COMPS = {
    parseValue: parseValue, money: money, price: price, multx: multx,
    bigMoney: bigMoney, perShare: perShare, shareCount: shareCount,
    calcString: calcString, metricValue: metricValue, MULTIPLES: MULTIPLES,
    impliedPrice: impliedPrice, evaluate: evaluate, renderReport: renderReport,
    reverse: reverse, expectations: expectations, pct: pct,
  };

  function readJson(id) {
    var node = document.getElementById(id);
    if (!node) return null;
    try { return JSON.parse(node.textContent); } catch (e) { return null; }
  }

  function boot() {
    var input = readJson("cmp-input");
    if (!input) return;
    try {
      renderReport(input, readJson("cmp-notes"));
    } catch (err) {
      var box = document.getElementById("cmp-fairvalue");
      if (box) box.textContent = "error";
      if (global.console) console.error("Comps report render failed:", err);
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = COMPS; // Node (validation harness)
  } else {
    global.COMPS = COMPS;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof window !== "undefined" ? window : this);
