/*
 * daily-val — client-side sum-of-the-parts valuation engine.
 *
 * A sibling to docs/assets/dcf.js and docs/assets/comps.js, for businesses that
 * are not one business. Each revenue stream is valued on its own forward figure
 * and its own multiple; the pieces are added, adjusted for non-operating items,
 * bridged to equity via net cash and divided by shares.
 *
 * The structure exists to refuse an average. A declining subscription line and
 * a fast-growing licensing line do not deserve the same multiple, and a
 * non-cash revenue stream can be carried at the zero it is worth — a single
 * blended multiple would hide precisely the judgment the reader needs to see.
 *
 * The static pages ship the *inputs* only; this script turns them into the
 * valuation. The fair value is computed without reference to any market price.
 *
 * The report reads as a walkthrough:
 *   1. what the parts are,
 *   2. the build-up — each part's figure x multiple, then the bridge to equity,
 *   3. the same build-up under bear / base / bull, probability-weighted,
 *   4. optionally, what the traded price implies for the one part that swings.
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
  // Firm-level figures, adaptive precision: $195B, $13.8B, $5.25B, -$2.5B.
  function bigMoney(x) {
    if (x === null || x === undefined || isNaN(x)) return "N/A";
    var ax = Math.abs(x);
    var units = [["T", 1e12], ["B", 1e9], ["M", 1e6], ["K", 1e3]];
    for (var i = 0; i < units.length; i++) {
      if (ax >= units[i][1]) {
        var n = x / units[i][1];
        var dp = Math.abs(n) >= 100 ? 0 : (Math.abs(n) >= 10 ? 1 : 2);
        var s = Math.abs(n).toFixed(dp).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
        return (n < 0 ? "-$" : "$") + s + units[i][0];
      }
    }
    return (x < 0 ? "-$" : "$") + Math.abs(x).toFixed(0);
  }

  // Per-share values. These pages can run from cents to hundreds of dollars, so
  // keep cents below $100 and drop them above it.
  function price(x) {
    if (x === null || x === undefined || isNaN(x)) return "—";
    return Math.abs(x) < 100
      ? "$" + x.toFixed(2)
      : "$" + Math.round(x).toLocaleString("en-US");
  }

  function multx(x) {
    if (x === null || x === undefined || isNaN(x)) return "—";
    return (x % 1 === 0 ? x.toFixed(0) : x.toFixed(1)) + "×";
  }

  function shareCount(x) {
    if (x === null || x === undefined || isNaN(x)) return "—";
    return x < 1e9 ? Math.round(x / 1e6) + "M" : (x / 1e9).toFixed(2) + "B";
  }

  function pct(x) {
    return (x === null || x === undefined || isNaN(x)) ? "—" : (x * 100).toFixed(0) + "%";
  }

  // A part's multiple is labelled by what its figure *is*. Display only — the
  // arithmetic is always figure x multiple.
  var BASIS_LABELS = {
    revenue: "EV/Sales",
    ebitda: "EV/EBITDA",
    ebit: "EV/EBIT",
    gross_profit: "EV/Gross profit",
    fcf: "EV/FCF",
    book: "P/B",
  };

  function basisLabel(part) {
    return part.multiple_label || BASIS_LABELS[part.basis] || "Multiple";
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

  function mergeBalanceSheet(data, scenario) {
    var out = JSON.parse(JSON.stringify(data.balance_sheet || {}));
    var over = scenario.balance_sheet;
    if (over && typeof over === "object") {
      for (var k in over) { if (over.hasOwnProperty(k)) out[k] = over[k]; }
    }
    return out;
  }

  // One scenario: part EVs → adjustments → net cash → equity → per share.
  function evaluateScenario(data, scenario) {
    var defs = data.parts || [];
    var overrides = scenario.parts || {};
    var bs = mergeBalanceSheet(data, scenario);
    var netCash = parseValue(bs.net_cash) || 0;
    var shares = parseValue(bs.diluted_shares);

    var parts = defs.map(function (d) {
      var over = overrides[d.key] || {};
      var amount = parseValue(over.amount !== undefined ? over.amount : d.amount);
      var m = over.multiple !== undefined ? over.multiple : d.multiple;
      var multiple = (m === null || m === undefined) ? null : Number(m);
      return {
        key: d.key,
        name: d.name || d.key,
        basis: d.basis || null,
        basisLabel: basisLabel(d),
        comparable: d.comparable || null,
        amount: amount,
        multiple: multiple,
        ev: (amount === null || multiple === null || isNaN(amount)) ? null : amount * multiple,
        note: over.note || d.note || null,
      };
    });
    var partsEv = parts.reduce(function (s, p) { return s + (p.ev || 0); }, 0);

    var adjOver = scenario.adjustments || {};
    var adjustments = (data.adjustments || []).map(function (a) {
      var amount = parseValue(adjOver[a.key] !== undefined ? adjOver[a.key] : a.amount);
      return { key: a.key, name: a.name || a.key, amount: amount, comment: a.comment || null };
    });
    var adjTotal = adjustments.reduce(function (s, a) { return s + (a.amount || 0); }, 0);

    var enterpriseValue = partsEv + adjTotal;
    var equity = enterpriseValue + netCash;

    return {
      name: scenario.name || "Scenario",
      probability: scenario.probability,
      parts: parts,
      partsEv: partsEv,
      adjustments: adjustments,
      adjustmentsTotal: adjTotal,
      enterpriseValue: enterpriseValue,
      netCash: netCash,
      shares: shares,
      equity: equity,
      perShare: shares ? equity / shares : null,
      comment: scenario.comment || null,
    };
  }

  /**
   * Normalize a sotp input into { method, scenarios[], intrinsic }. The
   * headline intrinsic is the probability-weighted per-share value.
   */
  function evaluate(data) {
    var scen = normalizeScenarios(data.scenarios);
    var results = scen.map(function (s) {
      var r = evaluateScenario(data, s);
      r.contribution = (r.perShare || 0) * r.probability;
      return r;
    });
    var intrinsic = results.reduce(function (s, r) { return s + r.contribution; }, 0);
    var vals = results.map(function (r) { return r.perShare; })
      .filter(function (x) { return x !== null && !isNaN(x); });
    return {
      method: "Sum of the parts" + (data.anchor ? " (" + data.anchor + ")" : ""),
      symbol: data.symbol || null,
      anchor: data.anchor || null,
      scenarios: results,
      intrinsic: intrinsic,
      low: vals.length ? Math.min.apply(null, vals) : null,
      high: vals.length ? Math.max.apply(null, vals) : null,
    };
  }

  // The walkthrough is built from the likeliest case.
  function primaryScenario(evald) {
    return evald.scenarios.slice().sort(function (a, b) { return b.probability - a.probability; })[0];
  }

  // ------------------------------------------------------- reverse: the price
  // Takes the traded price as *given* and solves for the one part it is really
  // buying: credit every other part, the adjustments and net cash at our own
  // figures, and read the residual. None of this feeds the fair value, which is
  // computed above without reference to the price.
  function reverse(data, evald) {
    var mkt = data.market;
    if (!mkt || !(Number(mkt.price) > 0) || !mkt.solve_for) return null;
    var s = primaryScenario(evald);
    if (!s.shares) return null;
    var target = null;
    s.parts.forEach(function (p) { if (p.key === mkt.solve_for) target = p; });
    if (!target) return null;

    var px = Number(mkt.price);
    var marketCap = px * s.shares;
    var impliedEv = marketCap - s.netCash - s.adjustmentsTotal;
    var others = s.parts.reduce(function (acc, p) {
      return acc + ((p.ev !== null && p.key !== target.key) ? p.ev : 0);
    }, 0);
    var residual = impliedEv - others;

    var impliedMultiple = target.amount ? residual / target.amount : null;
    var impliedAmount = target.multiple ? residual / target.multiple : null;
    return {
      price: px, asOf: mkt.as_of || null, commentary: mkt.commentary || null,
      marketCap: marketCap, impliedEv: impliedEv, part: target,
      othersEv: others, residual: residual,
      impliedMultiple: impliedMultiple, impliedAmount: impliedAmount,
      multipleRatio: (impliedMultiple && target.multiple) ? impliedMultiple / target.multiple : null,
      amountRatio: (impliedAmount && target.amount) ? impliedAmount / target.amount : null,
      fairValue: evald.intrinsic,
      gap: evald.intrinsic ? px / evald.intrinsic : null,
    };
  }

  // ------------------------------------------------------------- DOM helpers
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

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

  // One "how defensible" line per input: label, an optional verdict pill, and
  // the plain-English read.
  function notesList(lines) {
    var box = el("div", "reads");
    lines.forEach(function (l) {
      if (!l.comment) return;
      var p = el("p", "read-line");
      if (l.label) p.appendChild(el("span", "read-key", l.label));
      if (l.verdict) {
        p.appendChild(document.createTextNode(" "));
        p.appendChild(el("span", "verdict", l.verdict));
      }
      p.appendChild(el("span", "read-note", (l.label ? " — " : "") + l.comment));
      box.appendChild(p);
    });
    return box;
  }

  // Step 1 — what the parts are, and what each is being compared against.
  function renderParts(evald) {
    var mount = document.getElementById("sotp-parts");
    if (!mount) return;
    mount.innerHTML = "";
    var s = primaryScenario(evald);
    var rows = s.parts.map(function (p) {
      return [p.name,
        { text: p.basisLabel, cls: "num muted-cell" },
        { text: p.comparable || "—", cls: "num muted-cell" }];
    });
    mount.appendChild(tableFrom(["Part", "Valued on", "Compared against"], rows));
    var withNotes = s.parts.filter(function (p) { return p.note; })
      .map(function (p) { return { label: p.name, comment: p.note }; });
    if (withNotes.length) mount.appendChild(notesList(withNotes));
  }

  // Step 2 — the build-up: each part's figure x multiple, then the bridge.
  function renderBuildup(evald, notes) {
    var mount = document.getElementById("sotp-buildup");
    if (!mount) return;
    mount.innerHTML = "";
    var s = primaryScenario(evald);
    var label = evald.anchor || "Forward";

    var rows = s.parts.map(function (p) {
      return [p.name,
        { text: bigMoney(p.amount), cls: "num" },
        { text: multx(p.multiple), cls: "num strong" },
        { text: bigMoney(p.ev), cls: "num" }];
    });
    rows.push([{ text: "Parts, added up", cls: "name strong" }, "", "",
               { text: bigMoney(s.partsEv), cls: "num strong" }]);
    s.adjustments.forEach(function (a) {
      rows.push([{ text: a.name, cls: "name muted-cell" }, "", "",
                 { text: bigMoney(a.amount), cls: "num" }]);
    });
    if (s.adjustments.length) {
      rows.push([{ text: "Enterprise value", cls: "name strong" }, "", "",
                 { text: bigMoney(s.enterpriseValue), cls: "num strong" }]);
    }
    rows.push([{ text: "Net cash (cash − debt)", cls: "name muted-cell" }, "", "",
               { text: bigMoney(s.netCash), cls: "num" }]);
    rows.push([{ text: "Equity value", cls: "name strong" }, "", "",
               { text: bigMoney(s.equity), cls: "num strong" }]);
    rows.push([{ text: "÷ diluted shares", cls: "name muted-cell" }, "", "",
               { text: shareCount(s.shares), cls: "num" }]);
    rows.push([{ text: "Value per share · " + s.name, cls: "name strong" }, "", "",
               { text: price(s.perShare), cls: "num strong" }]);

    mount.appendChild(tableFrom(["Part", label + " figure", "Multiple", "Value"], rows));

    if (notes && Array.isArray(notes.drivers) && notes.drivers.length) {
      mount.appendChild(notesList(notes.drivers.map(function (d) {
        return { label: d.label, verdict: d.verdict, comment: d.comment };
      })));
    }
  }

  // Step 3 — the same build-up under each case, probability-weighted.
  function renderScenarios(evald) {
    var mount = document.getElementById("sotp-scenarios");
    if (!mount) return;
    mount.innerHTML = "";
    var keys = primaryScenario(evald).parts.map(function (p) { return p.key; });
    var names = {};
    primaryScenario(evald).parts.forEach(function (p) { names[p.key] = p.name; });

    var headers = ["Scenario", "Prob."].concat(keys.map(function (k) { return names[k]; }))
      .concat(["Per share", "Weighted"]);
    var rows = evald.scenarios.map(function (r) {
      var byKey = {};
      r.parts.forEach(function (p) { byKey[p.key] = p; });
      return [r.name, { text: pct(r.probability), cls: "num" }].concat(
        keys.map(function (k) {
          var p = byKey[k];
          return { text: p ? bigMoney(p.amount) + " × " + multx(p.multiple) : "—", cls: "num muted-cell" };
        })
      ).concat([
        { text: price(r.perShare), cls: "num" },
        { text: price(r.contribution), cls: "num muted-cell" },
      ]);
    });
    rows.push([{ text: "Probability-weighted fair value", cls: "name strong" },
               { text: "", cls: "num" }].concat(
      keys.map(function () { return { text: "", cls: "num" }; })
    ).concat([
      { text: price(evald.low) + " – " + price(evald.high), cls: "num muted-cell" },
      { text: price(evald.intrinsic), cls: "num strong" },
    ]));
    mount.appendChild(tableFrom(headers, rows));

    var comments = evald.scenarios.filter(function (r) { return r.comment; })
      .map(function (r) { return { label: r.name, comment: r.comment }; });
    if (comments.length) mount.appendChild(notesList(comments));
  }

  // Step 4 — the price as given: what is left over for the swing part.
  function renderMarket(rev) {
    var mount = document.getElementById("sotp-market");
    if (!mount || !rev) return;
    mount.innerHTML = "";

    var band = el("div", "fairvalue-band");
    band.appendChild(el("span", "fv-label", "Market price" + (rev.asOf ? " · " + rev.asOf : "")));
    band.appendChild(el("span", "fv-value", price(rev.price)));
    mount.appendChild(band);

    var rows = [
      ["Market capitalisation", { text: bigMoney(rev.marketCap), cls: "num" }],
      [{ text: "Less net cash and adjustments", cls: "name muted-cell" },
       { text: bigMoney(-(rev.marketCap - rev.impliedEv)), cls: "num" }],
      [{ text: "Enterprise value the price implies", cls: "name strong" },
       { text: bigMoney(rev.impliedEv), cls: "num strong" }],
      [{ text: "Less the other parts, at our own figures", cls: "name muted-cell" },
       { text: bigMoney(-rev.othersEv), cls: "num" }],
      [{ text: "Left over for " + rev.part.name, cls: "name strong" },
       { text: bigMoney(rev.residual), cls: "num strong" }],
    ];
    mount.appendChild(tableFrom(["The price, taken apart", "Value"], rows));

    var rows2 = [
      [rev.part.basisLabel + " on our figure",
       { text: multx(rev.part.multiple), cls: "num" },
       { text: multx(rev.impliedMultiple), cls: "num strong" },
       { text: rev.multipleRatio ? rev.multipleRatio.toFixed(1) + "×" : "—", cls: "num muted-cell" }],
      ["Figure needed at our multiple",
       { text: bigMoney(rev.part.amount), cls: "num" },
       { text: bigMoney(rev.impliedAmount), cls: "num strong" },
       { text: rev.amountRatio ? rev.amountRatio.toFixed(1) + "×" : "—", cls: "num muted-cell" }],
      [{ text: "Per share", cls: "name strong" },
       { text: price(rev.fairValue), cls: "num" },
       { text: price(rev.price), cls: "num strong" },
       { text: rev.gap ? rev.gap.toFixed(2) + "×" : "—", cls: "num muted-cell" }],
    ];
    mount.appendChild(tableFrom(["Two ways to read the residual", "Ours", "The price's", "Ratio"], rows2));

    if (rev.commentary) {
      var note = el("p", "read-note", rev.commentary);
      note.style.display = "block";
      note.style.marginTop = "12px";
      mount.appendChild(note);
    }
  }

  function renderKeyInputs(data, evald) {
    var kbody = document.getElementById("sotp-key-inputs");
    if (!kbody) return;
    kbody.innerHTML = "";
    var s = primaryScenario(evald);
    var rows = [];
    if (data.anchor) rows.push(["Forward year", data.anchor]);
    rows.push(["Parts valued", String(s.parts.length)]);
    rows.push(["Net cash (cash − debt)", bigMoney(s.netCash)]);
    rows.push(["Diluted shares", shareCount(s.shares)]);
    rows.push(["Scenario range", price(evald.low) + " – " + price(evald.high)]);
    rows.forEach(function (r) {
      var tr = document.createElement("tr");
      tr.appendChild(el("td", null, r[0]));
      tr.appendChild(el("td", "num", r[1]));
      kbody.appendChild(tr);
    });
  }

  function renderReport(data, notes) {
    notes = notes || {};
    var evald = evaluate(data);
    var methodEl = document.getElementById("sotp-method");
    if (methodEl) methodEl.textContent = evald.method;
    var fvEl = document.getElementById("sotp-fairvalue");
    if (fvEl) fvEl.textContent = price(evald.intrinsic);
    var srcEl = document.getElementById("sotp-source");
    if (srcEl && data.fundamentals_source) srcEl.textContent = data.fundamentals_source;
    renderParts(evald);
    renderBuildup(evald, notes);
    renderScenarios(evald);
    renderMarket(reverse(data, evald));
    renderKeyInputs(data, evald);
    return evald;
  }

  // ------------------------------------------------------------------ public
  var SOTP = {
    parseValue: parseValue, bigMoney: bigMoney, price: price, multx: multx,
    shareCount: shareCount, pct: pct, basisLabel: basisLabel,
    evaluate: evaluate, evaluateScenario: evaluateScenario,
    primaryScenario: primaryScenario, reverse: reverse, renderReport: renderReport,
  };

  function readJson(id) {
    var node = document.getElementById(id);
    if (!node) return null;
    try { return JSON.parse(node.textContent); } catch (e) { return null; }
  }

  function boot() {
    var input = readJson("sotp-input");
    if (!input) return;
    try {
      renderReport(input, readJson("sotp-notes"));
    } catch (err) {
      var box = document.getElementById("sotp-fairvalue");
      if (box) box.textContent = "error";
      if (global.console) console.error("SOTP report render failed:", err);
    }
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = SOTP; // Node (validation harness)
  } else {
    global.SOTP = SOTP;
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof window !== "undefined" ? window : this);
