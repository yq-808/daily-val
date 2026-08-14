/*!
 * action.js — the action band.
 *
 * The valuation answers "what is this worth". This answers the only other
 * question worth writing down before a decision: "at what price would I act,
 * and how sure am I". It is a decision rule, not a forecast — and it is built
 * so that it cannot be quietly fitted to the quote:
 *
 *   1. Every level is a fraction of the report's own fair value, or one of its
 *      own scenario values. An absolute price is rejected outright, so a level
 *      can never be reverse-engineered from what the stock happens to cost.
 *   2. The fraction comes from the confidence table below, which lives in this
 *      file rather than in the input. A report declares how good its inputs
 *      are; the discount that earns follows from it.
 *   3. Nothing here feeds the valuation. It runs after it, off its output.
 *
 * The band is a property of the day it was frozen, not a standing instruction:
 * it says what this set of figures supported on this date. A later report with
 * different figures gets a different band.
 */
(function (global) {
  "use strict";

  // How much of the model's own value you give up before acting, by how well
  // the inputs behind it stand up. A report with a crux driver reading "weak
  // evidence" has not earned a thin discount, and cannot award itself one.
  var CONFIDENCE = {
    high: {
      label: "High",
      accumulate: 0.85,
      trim: 1.25,
      note: "Every driver is supported by filed figures; the scenarios bracket a narrow range."
    },
    medium: {
      label: "Medium",
      accumulate: 0.75,
      trim: 1.35,
      note: "The main drivers are defensible, but at least one is a judgment call that moves the answer."
    },
    low: {
      label: "Low",
      accumulate: 0.60,
      trim: 1.50,
      note: "A crux driver rests on weak evidence, or the scenario weights are doing more work than the evidence is."
    }
  };

  // Scenario keywords resolve against the report's own cases. "bear"/"bull"
  // fall back to the ends of the scenario spread when nothing is named that.
  var LOW_WORDS = { bear: 1, low: 1, worst: 1 };
  var HIGH_WORDS = { bull: 1, high: 1, best: 1 };

  function isNum(x) { return typeof x === "number" && isFinite(x); }

  /** Build the value spread a band is resolved against. */
  function spread(cases, intrinsic) {
    var vals = (cases || [])
      .map(function (c) { return c.value; })
      .filter(function (v) { return isNum(v); });
    var byName = {};
    (cases || []).forEach(function (c) {
      if (c && c.name && isNum(c.value)) byName[String(c.name).toLowerCase()] = c.value;
    });
    var likeliest = null, bestP = -1;
    (cases || []).forEach(function (c) {
      if (isNum(c.value) && (c.probability || 0) > bestP) { bestP = c.probability || 0; likeliest = c.value; }
    });
    return {
      intrinsic: intrinsic,
      low: vals.length ? Math.min.apply(null, vals) : null,
      high: vals.length ? Math.max.apply(null, vals) : null,
      likeliest: likeliest,
      byName: byName
    };
  }

  /**
   * Resolve one level. `spec` is a fraction of fair value (0 < f <= 3) or one
   * of the report's scenario names. Anything that looks like an absolute share
   * price is refused — that is the whole safeguard.
   */
  function resolveLevel(spec, sp, fallbackFraction, what) {
    if (spec === undefined || spec === null) spec = fallbackFraction;

    if (isNum(spec)) {
      if (spec <= 0 || spec > 3) {
        throw new Error(
          "action." + what + " must be a fraction of fair value (0–3), not an absolute price — got " + spec
        );
      }
      if (!isNum(sp.intrinsic)) return null;
      return { value: sp.intrinsic * spec, basis: Math.round(spec * 100) + "% of fair value" };
    }

    if (typeof spec === "string") {
      var key = spec.toLowerCase().trim();
      if (key in sp.byName) return { value: sp.byName[key], basis: "the " + spec + " case" };
      if (key === "base" && isNum(sp.likeliest)) return { value: sp.likeliest, basis: "the likeliest case" };
      if (LOW_WORDS[key] && isNum(sp.low)) return { value: sp.low, basis: "the bottom of the range" };
      if (HIGH_WORDS[key] && isNum(sp.high)) return { value: sp.high, basis: "the top of the range" };
      throw new Error("action." + what + ": no scenario named '" + spec + "' in this report");
    }

    throw new Error("action." + what + " must be a fraction or a scenario name");
  }

  /**
   * Turn an `action` input block into a resolved band.
   * Returns null when the report carries no action block.
   */
  function evaluate(action, cases, intrinsic, market) {
    if (!action || typeof action !== "object") return null;

    var conf = String(action.confidence || "medium").toLowerCase();
    var tier = CONFIDENCE[conf];
    if (!tier) throw new Error("action.confidence must be high, medium or low — got '" + action.confidence + "'");

    var sp = spread(cases, intrinsic);
    var accumulate = resolveLevel(action.buy_below, sp, tier.accumulate, "buy_below");
    var trim = resolveLevel(action.trim_above, sp, tier.trim, "trim_above");

    // The traded price, where the report carries one, is read only to say
    // which side of the band it sits on. It has already been excluded from
    // everything above.
    var status = null;
    var px = market && Number(market.price);
    if (isNum(px) && px > 0 && accumulate && trim) {
      status = {
        price: px,
        asOf: (market && market.as_of) || null,
        where: px <= accumulate.value ? "accumulate" : (px >= trim.value ? "trim" : "hold")
      };
    }

    return {
      confidence: conf,
      confidenceLabel: tier.label,
      confidenceNote: action.confidence_note || tier.note,
      accumulate: accumulate,
      trim: trim,
      intrinsic: sp.intrinsic,
      low: sp.low,
      high: sp.high,
      rationale: action.rationale || null,
      review: action.review || null,
      status: status
    };
  }


  // ------------------------------------------------------------- DOM helpers
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  var WHERE_TEXT = {
    accumulate: "at or below the accumulate level",
    hold: "between the two levels — the band says do nothing",
    trim: "at or above the trim level"
  };

  /**
   * The two levels, rendered into the fair-value band at the top of the page,
   * beside the value they are derived from. They belong there: the discount and
   * the premium are meaningless without the number they are a fraction of, and
   * a reader who takes only the headline should take the whole rule with it.
   *
   * Only the levels go up here. The confidence, the reasoning and — crucially —
   * anything the traded price touches stay in the trailing section, after the
   * valuation.
   */
  function renderLevels(mountId, band, fmt) {
    var mount = document.getElementById(mountId);
    if (!mount || !band) return band;
    mount.innerHTML = "";
    [
      ["Accumulate below", band.accumulate, "act-buy"],
      ["Trim above", band.trim, "act-trim"]
    ].forEach(function (row) {
      if (!row[1] || !isNum(row[1].value)) return;
      var cell = el("div", "fv-act " + row[2]);
      cell.appendChild(el("span", "fv-act-label", row[0]));
      cell.appendChild(el("span", "fv-act-value", fmt(row[1].value)));
      cell.appendChild(el("span", "fv-act-basis", row[1].basis));
      mount.appendChild(cell);
    });
    return band;
  }

  /**
   * The reasoning behind the levels: how good the inputs are, why the levels
   * sit where they do, which side of them the price falls on, and what would
   * make the band wrong. This is the part that reads *after* the valuation.
   */
  function renderDetail(mountId, band, fmt) {
    var mount = document.getElementById(mountId);
    if (!mount || !band) return band;
    mount.innerHTML = "";

    var conf = el("p", "read-line");
    conf.appendChild(el("span", "read-key", "Confidence in these inputs"));
    conf.appendChild(document.createTextNode(" "));
    conf.appendChild(el("span", "verdict", band.confidenceLabel));
    conf.appendChild(el("span", "read-note", " — " + band.confidenceNote));
    mount.appendChild(conf);

    if (band.rationale) {
      var why = el("p", "read-line");
      why.appendChild(el("span", "read-key", "Why here"));
      why.appendChild(el("span", "read-note", " — " + band.rationale));
      mount.appendChild(why);
    }

    if (band.status) {
      var st = el("p", "read-line");
      st.appendChild(el("span", "read-key",
        "Where the price sits" + (band.status.asOf ? " · " + band.status.asOf : "")));
      st.appendChild(el("span", "read-note",
        " — " + fmt(band.status.price) + " is " + WHERE_TEXT[band.status.where] + "."));
      mount.appendChild(st);
    }

    if (band.review) {
      var rv = el("p", "read-line");
      rv.appendChild(el("span", "read-key", "Revisit when"));
      rv.appendChild(el("span", "read-note", " — " + band.review));
      mount.appendChild(rv);
    }
    return band;
  }

  /**
   * Evaluate once, render in both places; engines use this.
   *
   * `prefix` is the trailing section's mount id (e.g. "sotp-action"); the
   * levels mount is `prefix + "-levels"`, which the page template places inside
   * the fair-value band. A page that carries only one of the two still works.
   */
  function mount(prefix, action, cases, intrinsic, market, fmt) {
    var band = evaluate(action, cases, intrinsic, market);
    if (!band) return null;
    renderLevels(prefix + "-levels", band, fmt);
    renderDetail(prefix, band, fmt);
    return band;
  }

  var ACTION = {
    CONFIDENCE: CONFIDENCE,
    spread: spread,
    evaluate: evaluate,
    renderLevels: renderLevels,
    renderDetail: renderDetail,
    mount: mount
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = ACTION; // Node (validation harness)
  } else {
    global.ACTION = ACTION;
  }
})(typeof window !== "undefined" ? window : this);
