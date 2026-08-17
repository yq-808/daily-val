/*
 * daily-val — client-side DCF engine.
 *
 * A faithful port of skills/dcf/scripts/dcf_calculator.py (FCFF methodology),
 * using the mid-year discounting convention (cash flows arrive mid-year on
 * average).
 *
 * The static pages ship the *inputs* only; this script turns them into the
 * final valuation. Valuation only — no live market price.
 */
(function (global) {
  "use strict";

  // ----------------------------------------------------------------- parsing
  function parseValue(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      var v = value.trim().toUpperCase();
      var mult = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
      var suffix = v.slice(-1);
      if (mult[suffix] !== undefined) {
        return parseFloat(v.slice(0, -1)) * mult[suffix];
      }
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
      if (ax >= units[i][1]) {
        return "$" + (x / units[i][1]).toFixed(decimals) + units[i][0];
      }
    }
    return "$" + x.toFixed(0);
  }

  function pct(x) {
    if (x === null || x === undefined || isNaN(x)) return "N/A";
    return (x * 100).toFixed(2) + "%";
  }

  function price(x) {
    if (x === null || x === undefined || isNaN(x)) return "—";
    return "$" + x.toFixed(2);
  }

  // -------------------------------------------------------------------- WACC
  function calculateWacc(waccInputs, taxRate) {
    var rf = waccInputs.risk_free_rate;
    var erp = waccInputs.equity_risk_premium;
    var beta = waccInputs.beta;
    var rd = waccInputs.cost_of_debt;
    var wd = waccInputs.debt_weight;
    var we = waccInputs.equity_weight;
    var re = rf + beta * erp; // CAPM cost of equity
    var wacc = we * re + wd * rd * (1 - taxRate);
    return { wacc: wacc, costOfEquity: re };
  }

  // --------------------------------------------------------------- core DCF
  // Mid-year convention: a cash flow booked "in year n" is received, on
  // average, half-way through it, so it is discounted at (n - 0.5) rather than
  // n. For a Gordon-growth terminal value the continuing value is likewise
  // discounted at (N - 0.5). Net effect ~ +(1+WACC)^0.5, about +4%.
  function calculateDcf(data, waccOverride) {
    var by = data.base_year;
    var a = data.assumptions;

    var baseRevenue = parseValue(by.revenue);
    var daPercent = by.da_percent;
    var nwcPercent = by.nwc_percent;

    var taxRate = a.tax_rate;
    var growthRates = a.growth_rates;
    var ebitMargins = a.ebit_margins;
    var capexPercent = a.capex_percent;
    if (capexPercent === undefined || capexPercent === null) {
      capexPercent = by.capex_percent; // legacy fallback
    }

    var terminalGrowth = data.terminal.growth_rate;

    var bs = data.balance_sheet;
    var cash = parseValue(bs.cash);
    var debt = parseValue(bs.debt);
    var shares = parseValue(bs.diluted_shares);

    var w = calculateWacc(data.wacc_inputs, taxRate);
    var wacc = (waccOverride !== undefined && waccOverride !== null) ? waccOverride : w.wacc;

    var years = growthRates.length;
    var fcffs = [];
    var discountFactors = [];
    var pvFcffs = [];

    var prevRevenue = baseRevenue;
    var prevNwc = baseRevenue * nwcPercent;

    for (var i = 0; i < years; i++) {
      var revenue = prevRevenue * (1 + growthRates[i]);
      var ebit = revenue * ebitMargins[i];
      var nopat = ebit * (1 - taxRate);
      var da = revenue * daPercent;
      var capexRate = Array.isArray(capexPercent) ? capexPercent[i] : capexPercent;
      var capex = revenue * capexRate;
      var nwc = revenue * nwcPercent;
      var deltaNwc = nwc - prevNwc;
      var fcff = nopat + da - capex - deltaNwc;
      var df = 1 / Math.pow(1 + wacc, i + 0.5); // mid-year convention

      fcffs.push(fcff);
      discountFactors.push(df);
      pvFcffs.push(fcff * df);

      prevRevenue = revenue;
      prevNwc = nwc;
    }

    var terminalFcff = fcffs[years - 1] * (1 + terminalGrowth);
    var terminalValue = terminalFcff / (wacc - terminalGrowth);
    // Gordon-growth terminal value discounted at the final mid-year factor.
    var pvTerminal = terminalValue * discountFactors[years - 1];

    var sumPvFcff = pvFcffs.reduce(function (s, v) { return s + v; }, 0);
    var enterpriseValue = sumPvFcff + pvTerminal;
    var equityValue = enterpriseValue + cash - debt;
    var intrinsicPrice = equityValue / shares;

    return {
      years: years,
      wacc: wacc,
      costOfEquity: w.costOfEquity,
      terminalValue: terminalValue,
      pvTerminal: pvTerminal,
      sumPvFcff: sumPvFcff,
      enterpriseValue: enterpriseValue,
      equityValue: equityValue,
      intrinsicPrice: intrinsicPrice,
      cash: cash,
      debt: debt,
      shares: shares,
      terminalGrowth: terminalGrowth
    };
  }

  // --------------------------------------------------------------- scenarios
  function normalizeScenarios(rawScenarios) {
    if (!Array.isArray(rawScenarios) || rawScenarios.length === 0) {
      throw new Error("'scenarios' must be a non-empty list");
    }
    var scenarios = rawScenarios.map(function (s, idx) {
      if (typeof s !== "object" || s === null) {
        throw new Error("scenarios[" + idx + "] must be an object");
      }
      if (!("probability" in s)) {
        throw new Error("scenarios[" + idx + "] is missing 'probability'");
      }
      var p = Number(s.probability);
      if (isNaN(p)) throw new Error("scenarios[" + idx + "].probability must be a number");
      if (p < 0) throw new Error("scenarios[" + idx + "].probability cannot be negative");
      var copy = JSON.parse(JSON.stringify(s));
      copy.probability = p;
      return copy;
    });

    var total = scenarios.reduce(function (s, x) { return s + x.probability; }, 0);
    if (total <= 0) throw new Error("Scenario probability sum must be > 0");

    // Accept either decimal probabilities (sum 1.0) or percentages (sum 100).
    if (total > 1.0001) {
      if (Math.abs(total - 100.0) <= 0.1) {
        scenarios.forEach(function (s) { s.probability /= 100.0; });
        total = scenarios.reduce(function (s, x) { return s + x.probability; }, 0);
      } else {
        throw new Error("Scenario probabilities must sum to 1.0 (or 100)");
      }
    }
    if (Math.abs(total - 1.0) > 0.001) {
      throw new Error("Scenario probabilities must sum to 1.0; got " + total.toFixed(4));
    }
    return scenarios;
  }

  function buildScenarioData(baseData, scenario) {
    var scenarioData = JSON.parse(JSON.stringify(baseData));
    delete scenarioData.scenarios;
    ["base_year", "assumptions", "wacc_inputs", "terminal", "balance_sheet"].forEach(function (key) {
      if (key in scenario) {
        var base = scenarioData[key];
        var override = scenario[key];
        if (base && typeof base === "object" && !Array.isArray(base) &&
            override && typeof override === "object" && !Array.isArray(override)) {
          var merged = JSON.parse(JSON.stringify(base));
          for (var k in override) { if (override.hasOwnProperty(k)) merged[k] = override[k]; }
          scenarioData[key] = merged;
        } else {
          scenarioData[key] = override;
        }
      }
    });
    return scenarioData;
  }

  function calculateProbabilityWeighted(data) {
    var scenarios = normalizeScenarios(data.scenarios);
    var results = scenarios.map(function (scenario, idx) {
      var name = scenario.name || "Scenario " + (idx + 1);
      var scenarioData = buildScenarioData(data, scenario);
      var result = calculateDcf(scenarioData);
      return {
        name: name,
        probability: scenario.probability,
        input: scenarioData, // merged inputs, so callers can show assumptions
        results: result,
        contribution: result.intrinsicPrice * scenario.probability
      };
    });
    var weighted = results.reduce(function (s, r) { return s + r.contribution; }, 0);
    return { scenarioResults: results, weightedPrice: weighted };
  }

  /**
   * Normalize any input doc into { method, scenarios[], intrinsic }.
   * Each scenario carries `raw` = the merged inputs behind it.
   */
  function evaluate(data) {
    var scenarios, intrinsic, method;
    if (data.scenarios) {
      var pw = calculateProbabilityWeighted(data);
      scenarios = pw.scenarioResults.map(function (item) {
        return {
          name: item.name,
          probability: item.probability,
          wacc: item.results.wacc,
          terminalGrowth: item.results.terminalGrowth,
          intrinsicPrice: item.results.intrinsicPrice,
          contribution: item.contribution,
          raw: item.input
        };
      });
      intrinsic = pw.weightedPrice;
      method = "DCF — FCFF, probability-weighted scenarios (mid-year)";
    } else {
      var r = calculateDcf(data);
      scenarios = [{
        name: "Base",
        probability: 1.0,
        wacc: r.wacc,
        terminalGrowth: r.terminalGrowth,
        intrinsicPrice: r.intrinsicPrice,
        contribution: r.intrinsicPrice,
        raw: data
      }];
      intrinsic = r.intrinsicPrice;
      method = "DCF — FCFF, single scenario (mid-year)";
    }
    return { method: method, scenarios: scenarios, intrinsic: intrinsic };
  }

  // ---------------------------------------------------- driver value getters
  // Map an assumption key -> value(s) pulled from a merged scenario. `get`
  // may return a scalar string or an array (one entry per forecast year).
  var DRIVERS = {
    growth: { label: "Revenue growth (% / yr)", get: function (r) { return r.assumptions.growth_rates.map(pct); } },
    margin: { label: "EBIT margin (%)", get: function (r) { return r.assumptions.ebit_margins.map(pct); } },
    capex: {
      label: "Capex (% of revenue)",
      get: function (r) {
        var c = (r.assumptions.capex_percent != null) ? r.assumptions.capex_percent : r.base_year.capex_percent;
        return Array.isArray(c) ? c.map(pct) : [pct(c)];
      }
    },
    da: { label: "D&A (% of revenue)", short: "D&A", get: function (r) { return pct(r.base_year.da_percent); } },
    nwc: { label: "Net working capital (% of revenue)", short: "NWC", get: function (r) { return pct(r.base_year.nwc_percent); } },
    netcash: {
      label: "Net cash (cash + securities − debt)", short: "Net cash",
      get: function (r) { var bs = r.balance_sheet || {}; return money(parseValue(bs.cash) - parseValue(bs.debt)); }
    },
    tax: { label: "Tax rate", short: "Tax", get: function (r) { return pct(r.assumptions.tax_rate); } },
    rf: { label: "Risk-free rate", short: "Rf", get: function (r) { return pct(r.wacc_inputs.risk_free_rate); } },
    erp: { label: "Equity risk premium", short: "ERP", get: function (r) { return pct(r.wacc_inputs.equity_risk_premium); } },
    beta: { label: "Beta", short: "Beta", get: function (r) { return r.wacc_inputs.beta.toFixed(2); } },
    wacc: { label: "WACC (derived)", short: "WACC", get: function (r, s) { return pct(s.wacc); } },
    terminal_g: { label: "Terminal growth", short: "Term. g", get: function (r, s) { return pct(s.terminalGrowth); } },
    probability: { label: "Scenario probability", short: "Prob.", get: function (r, s) { return pct(s.probability); } }
  };

  // ------------------------------------------------------------- DOM helpers
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function renderScenarioTable(scenarios, intrinsic) {
    var tbody = document.getElementById("dcf-scenario-rows");
    if (tbody) {
      tbody.innerHTML = "";
      scenarios.forEach(function (s) {
        var tr = document.createElement("tr");
        tr.appendChild(el("td", "name", s.name));
        tr.appendChild(el("td", "num", pct(s.probability)));
        tr.appendChild(el("td", "num", pct(s.wacc)));
        tr.appendChild(el("td", "num", pct(s.terminalGrowth)));
        tr.appendChild(el("td", "num strong", price(s.intrinsicPrice)));
        tr.appendChild(el("td", "num", price(s.contribution)));
        tbody.appendChild(tr);
      });
    }
    var weightedEl = document.getElementById("dcf-weighted");
    if (weightedEl) weightedEl.textContent = price(intrinsic);
    // Present only on reports that carry an action band, which need the fair
    // value standing beside the levels derived from it.
    var fvEl = document.getElementById("dcf-fairvalue");
    if (fvEl) fvEl.textContent = price(intrinsic);
  }

  function renderKeyInputs(data) {
    var kbody = document.getElementById("dcf-key-inputs");
    if (!kbody) return;
    kbody.innerHTML = "";
    var bs = data.balance_sheet || {};
    var rows = [];
    var baseRev = data.base_year && data.base_year.revenue;
    if (baseRev) rows.push(["Base-year revenue", money(parseValue(baseRev))]);
    if (bs.cash !== undefined) rows.push(["Cash", money(parseValue(bs.cash))]);
    if (bs.debt !== undefined) rows.push(["Debt", money(parseValue(bs.debt))]);
    if (bs.diluted_shares !== undefined) {
      rows.push(["Diluted shares", (parseValue(bs.diluted_shares) / 1e9).toFixed(3) + "B"]);
    }
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      tr.appendChild(el("td", null, r[0]));
      tr.appendChild(el("td", "num", r[1]));
      kbody.appendChild(tr);
    });
  }

  function scenarioTable(scenarios, headerCells, rowValsFor) {
    var scroll = el("div", "table-scroll");
    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    htr.appendChild(el("th", null, "Scenario"));
    headerCells.forEach(function (h) { htr.appendChild(el("th", "num", h)); });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = document.createElement("tbody");
    scenarios.forEach(function (s) {
      var tr = document.createElement("tr");
      tr.appendChild(el("td", "name", s.name));
      rowValsFor(s).forEach(function (v) { tr.appendChild(el("td", "num", v)); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    scroll.appendChild(table);
    return scroll;
  }

  // Assumptions as tables — one row per scenario (Bear / Base / Bull). Each
  // list input (growth, margins, capex) gets its own table with the full
  // Y1–Yn series across the columns; the scalar inputs share one table. Each
  // carries a plain-English "how defensible" read.
  function renderDrivers(driverNotes, scenarios) {
    var mount = document.getElementById("dcf-drivers");
    if (!mount || !Array.isArray(driverNotes) || driverNotes.length === 0) return;
    mount.innerHTML = "";

    var enriched = driverNotes.map(function (dn) {
      var def = DRIVERS[dn.key];
      if (!def) return null;
      var vals = scenarios.map(function (s) {
        try { return def.get(s.raw, s); } catch (e) { return "—"; }
      });
      return { dn: dn, def: def, vals: vals, isList: Array.isArray(vals[0]) };
    }).filter(Boolean);

    // One table per list-valued input: 3 scenario rows × Y1..Yn columns.
    enriched.filter(function (e) { return e.isList; }).forEach(function (e) {
      var block = el("div", "assump");
      var head = el("div", "assump-head");
      head.appendChild(el("span", "assump-label", e.dn.label || e.def.label));
      if (e.dn.verdict) head.appendChild(el("span", "verdict", e.dn.verdict));
      block.appendChild(head);

      var n = e.vals[0].length;
      var years = [];
      for (var y = 0; y < n; y++) years.push("Y" + (y + 1));
      var byScenario = {};
      scenarios.forEach(function (s, si) { byScenario[s.name] = e.vals[si]; });
      block.appendChild(scenarioTable(scenarios, years, function (s) { return byScenario[s.name]; }));

      if (e.dn.comment) block.appendChild(el("p", "read-note", e.dn.comment));
      mount.appendChild(block);
    });

    // Scalar inputs share one table: 3 scenario rows × one column per input.
    var scalars = enriched.filter(function (e) { return !e.isList; });
    if (scalars.length) {
      var block = el("div", "assump");
      var head = el("div", "assump-head");
      head.appendChild(el("span", "assump-label", "Cost of capital & other inputs"));
      block.appendChild(head);

      var headers = scalars.map(function (e) { return e.def.short || e.dn.label || e.def.label; });
      var byScenario = {};
      scenarios.forEach(function (s, si) {
        byScenario[s.name] = scalars.map(function (e) { return e.vals[si]; });
      });
      block.appendChild(scenarioTable(scenarios, headers, function (s) { return byScenario[s.name]; }));

      // Per-input reads beneath the table.
      var reads = scalars.filter(function (e) { return e.dn.verdict || e.dn.comment; });
      if (reads.length) {
        var list = el("div", "reads");
        reads.forEach(function (e) {
          var p = el("p", "read-line");
          p.appendChild(el("span", "read-key", e.dn.label || e.def.label));
          if (e.dn.verdict) { p.appendChild(document.createTextNode(" ")); p.appendChild(el("span", "verdict", e.dn.verdict)); }
          if (e.dn.comment) p.appendChild(el("span", "read-note", " " + e.dn.comment));
          list.appendChild(p);
        });
        block.appendChild(list);
      }
      mount.appendChild(block);
    }
  }

  // Optional "Street consensus" cross-check: run the analyst-consensus path
  // through the same FCFF engine (as a single, non-weighted scenario merged
  // onto the base) and show its intrinsic next to our probability-weighted
  // value. Rendered only when the input carries a `consensus` block.
  function renderConsensus(data, weightedIntrinsic) {
    var mount = document.getElementById("dcf-consensus");
    if (!mount || !data.consensus) return;
    mount.innerHTML = "";
    var c = data.consensus;
    var cData = buildScenarioData(data, c);
    var r = calculateDcf(cData);

    var head = el("div", "consensus-head");
    head.appendChild(el("span", "consensus-label", c.label || "Consensus"));
    head.appendChild(el("span", "consensus-value", price(r.intrinsicPrice)));
    mount.appendChild(head);

    var rev = parseValue(cData.base_year.revenue);
    var g = cData.assumptions.growth_rates || [];
    var revs = [];
    for (var i = 0; i < 3 && i < g.length; i++) { rev = rev * (1 + g[i]); revs.push(money(rev)); }
    var m = cData.assumptions.ebit_margins || [];
    var rows = [
      ["Consensus revenue (Y1 / Y2 / Y3)", revs.join(" / ")],
      ["Operating margin (Y1 → Y" + m.length + ")", m.length ? pct(m[0]) + " → " + pct(m[m.length - 1]) : "—"],
      ["Discount rate (WACC)", pct(r.wacc)],
      ["Terminal growth", pct(cData.terminal.growth_rate)],
      ["Consensus DCF intrinsic", price(r.intrinsicPrice)]
    ];
    if (weightedIntrinsic != null) rows.push(["Our probability-weighted value", price(weightedIntrinsic)]);

    var scroll = el("div", "table-scroll");
    var table = document.createElement("table");
    table.className = "compact";
    var tb = document.createElement("tbody");
    rows.forEach(function (rw) {
      var tr = document.createElement("tr");
      tr.appendChild(el("td", null, rw[0]));
      tr.appendChild(el("td", "num", rw[1]));
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    scroll.appendChild(table);
    mount.appendChild(scroll);

    if (c.note) mount.appendChild(el("p", "read-note", c.note));
    if (c.source) mount.appendChild(el("p", "meta", "Source: " + c.source));
  }

  // Discount-rate sensitivity: recompute every scenario's intrinsic (and the
  // probability-weighted value) across a range of uniform WACCs, holding all
  // cash-flow assumptions fixed. Rendered only when the input carries a
  // `wacc_sensitivity` block. Uses the waccOverride arg on calculateDcf.
  function renderWaccSensitivity(data) {
    var mount = document.getElementById("dcf-wacc");
    if (!mount || !data.wacc_sensitivity || !data.scenarios) return;
    mount.innerHTML = "";
    var cfg = data.wacc_sensitivity;
    var rates = cfg.rates || [0.07, 0.075, 0.08, 0.085, 0.09, 0.095];
    var scen = normalizeScenarios(data.scenarios);
    var merged = scen.map(function (s) { return { s: s, data: buildScenarioData(data, s) }; });

    var scroll = el("div", "table-scroll");
    var table = document.createElement("table");
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    htr.appendChild(el("th", null, "Discount rate"));
    scen.forEach(function (s) { htr.appendChild(el("th", "num", s.name)); });
    htr.appendChild(el("th", "num", "Weighted"));
    thead.appendChild(htr);
    table.appendChild(thead);
    var tb = document.createElement("tbody");
    rates.forEach(function (rate) {
      var tr = document.createElement("tr");
      tr.appendChild(el("td", "name", pct(rate)));
      var w = 0;
      merged.forEach(function (m) {
        var r = calculateDcf(m.data, rate);
        tr.appendChild(el("td", "num", price(r.intrinsicPrice)));
        w += r.intrinsicPrice * m.s.probability;
      });
      tr.appendChild(el("td", "num strong", price(w)));
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    scroll.appendChild(table);
    mount.appendChild(scroll);
    if (cfg.note) mount.appendChild(el("p", "read-note", cfg.note));
  }

  // Buyback / share-count view: shows how the per-share figure moves as Apple
  // retires ~N%/yr of its shares. IMPORTANT: an FCFF DCF already prices the
  // cash spent on buybacks, so shrinking the denominator is only genuinely
  // accretive when repurchases happen below intrinsic — see the note. Rendered
  // only when the input carries a `buyback` block.
  function renderBuyback(data, weightedIntrinsic) {
    var mount = document.getElementById("dcf-buyback");
    if (!mount || !data.buyback) return;
    mount.innerHTML = "";
    var b = data.buyback;
    var rate = b.annual_reduction || 0;
    var shares0 = parseValue((data.balance_sheet || {}).diluted_shares);
    var horizons = b.horizons || [5, 10];

    var scroll = el("div", "table-scroll");
    var table = document.createElement("table");
    table.className = "compact";
    var thead = document.createElement("thead");
    var htr = document.createElement("tr");
    htr.appendChild(el("th", null, "Horizon"));
    htr.appendChild(el("th", "num", "Diluted shares"));
    htr.appendChild(el("th", "num", "Buyback-adj. weighted"));
    thead.appendChild(htr);
    table.appendChild(thead);
    var tb = document.createElement("tbody");
    var tr0 = document.createElement("tr");
    tr0.appendChild(el("td", "name", "Today"));
    tr0.appendChild(el("td", "num", (shares0 / 1e9).toFixed(2) + "B"));
    tr0.appendChild(el("td", "num strong", price(weightedIntrinsic)));
    tb.appendChild(tr0);
    horizons.forEach(function (yr) {
      var f = Math.pow(1 - rate, yr);
      var tr = document.createElement("tr");
      tr.appendChild(el("td", "name", "+" + yr + " yr"));
      tr.appendChild(el("td", "num", (shares0 * f / 1e9).toFixed(2) + "B"));
      tr.appendChild(el("td", "num strong", price(weightedIntrinsic / f)));
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    scroll.appendChild(table);
    mount.appendChild(scroll);
    if (b.note) mount.appendChild(el("p", "read-note", b.note));
    if (b.source) mount.appendChild(el("p", "meta", "Source: " + b.source));
  }

  // The action band — a decision rule read off the values above, never off a
  // price. Delegated to action.js, which is loaded alongside this engine on a
  // report page and absent on the landing page.
  function renderAction(data, evald) {
    if (!global.ACTION || !data.action) return null;
    var cases = evald.scenarios.map(function (s) {
      return { name: s.name, probability: s.probability, value: s.intrinsicPrice };
    });
    return global.ACTION.mount("dcf-action", data.action, cases, evald.intrinsic, data.market, price);
  }

  function renderReport(data, notes) {
    notes = notes || {};
    var evald = evaluate(data);

    var methodEl = document.getElementById("dcf-method");
    if (methodEl) methodEl.textContent = evald.method;
    var intrinsicEl = document.getElementById("dcf-intrinsic");
    if (intrinsicEl) intrinsicEl.textContent = price(evald.intrinsic);

    renderScenarioTable(evald.scenarios, evald.intrinsic);
    renderConsensus(data, evald.intrinsic);
    renderWaccSensitivity(data);
    renderBuyback(data, evald.intrinsic);
    renderDrivers(notes.drivers, evald.scenarios);
    renderAction(data, evald);
    renderKeyInputs(data);
    return evald;
  }

  // Headline number for a manifest entry, dispatched by method. Reports carrying
  // an input.method are valued by the sibling engine of that name — COMPS, SOTP
  // or OPLEV, all loaded alongside this script on the landing page; everything
  // else is a DCF.
  function intrinsicOf(input) {
    var m = input && input.method;
    if (m === "comps" && global.COMPS) return global.COMPS.evaluate(input).intrinsic;
    if (m === "sotp" && global.SOTP) return global.SOTP.evaluate(input).intrinsic;
    if (m === "opleverage" && global.OPLEV) return global.OPLEV.evaluate(input).intrinsic;
    return evaluate(input).intrinsic;
  }

  // Each engine headlines its value the way its own report page does. Comps
  // values run four digits, so they print whole dollars; a sum-of-the-parts can
  // come out at a few dollars a share, where the cents carry real information;
  // DCF per-share values keep cents.
  function formatIntrinsic(input, v) {
    var m = input && input.method;
    if (m === "comps") return "$" + Math.round(v);
    if (m === "sotp" && global.SOTP) return global.SOTP.price(v);
    if (m === "opleverage" && global.OPLEV) return global.OPLEV.price(v);
    return price(v);
  }

  // Flat list of every report, newest first (date desc; symbol asc for ties).
  // The list is read from the reports/manifest.json data file at runtime — it
  // is not hardcoded into the page.
  function renderIndex(entries) {
    var mount = document.getElementById("dcf-index");
    if (!mount) return;

    mount.innerHTML = "";
    if (!entries || entries.length === 0) {
      mount.appendChild(el("p", "empty", "No reports yet."));
      return;
    }

    var sorted = entries.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? 1 : -1; // date desc
      return a.symbol < b.symbol ? -1 : (a.symbol > b.symbol ? 1 : 0); // symbol asc
    });

    var list = el("div", "report-list");
    sorted.forEach(function (e) {
      var a = document.createElement("a");
      a.className = "report-row";
      a.href = e.path;
      a.appendChild(el("span", "rr-date", e.date));
      a.appendChild(el("span", "rr-sym", e.symbol));
      a.appendChild(el("span", "rr-method", e.method || ""));
      var metric = el("span", "rr-metric", "fair value ");
      var b = el("b");
      try {
        b.textContent = formatIntrinsic(e.input, intrinsicOf(e.input));
      } catch (err) { b.textContent = "—"; }
      metric.appendChild(b);
      a.appendChild(metric);
      list.appendChild(a);
    });
    mount.appendChild(list);
  }

  // ------------------------------------------------------------------ public
  var DCF = {
    parseValue: parseValue,
    money: money,
    pct: pct,
    price: price,
    calculateWacc: calculateWacc,
    calculateDcf: calculateDcf,
    calculateProbabilityWeighted: calculateProbabilityWeighted,
    evaluate: evaluate,
    renderReport: renderReport,
    renderIndex: renderIndex
  };

  function readJson(id) {
    var node = document.getElementById(id);
    if (!node) return null;
    try { return JSON.parse(node.textContent); } catch (e) { return null; }
  }

  // Load the report list from its data file. Relative to the landing page, the
  // manifest lives at reports/manifest.json. Falls back to XHR where fetch is
  // unavailable; an embedded #dcf-manifest (legacy) is honored if present.
  function loadManifest(cb) {
    var embedded = readJson("dcf-manifest");
    if (embedded) { cb(embedded, null); return; }
    var url = "reports/manifest.json";
    if (typeof fetch === "function") {
      fetch(url, { cache: "no-cache" })
        .then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.json(); })
        .then(function (data) { cb(data, null); })
        .catch(function (err) { cb(null, err); });
      return;
    }
    try {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", url, true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) return;
        if (xhr.status === 200 || xhr.status === 0) {
          try { cb(JSON.parse(xhr.responseText), null); } catch (e) { cb(null, e); }
        } else { cb(null, new Error("HTTP " + xhr.status)); }
      };
      xhr.send();
    } catch (err) { cb(null, err); }
  }

  function boot() {
    var input = readJson("dcf-input");
    if (input) {
      try {
        renderReport(input, readJson("dcf-notes"));
      } catch (err) {
        var box = document.getElementById("dcf-intrinsic");
        if (box) box.textContent = "error";
        if (global.console) console.error("DCF report render failed:", err);
      }
    }
    var indexMount = document.getElementById("dcf-index");
    if (indexMount) {
      loadManifest(function (entries, err) {
        if (err) {
          indexMount.appendChild(el("p", "empty", "Could not load the report list."));
          if (global.console) console.error("Manifest load failed:", err);
          return;
        }
        try { renderIndex(entries); }
        catch (e) { if (global.console) console.error("DCF index render failed:", e); }
      });
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = DCF; // Node (validation harness)
  } else {
    global.DCF = DCF;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof window !== "undefined" ? window : this);
