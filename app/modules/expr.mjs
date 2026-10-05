// Tuning Garage — Copyright (C) 2026 Kevin Tollison
// Free software under the GNU General Public License v3 or later, WITHOUT ANY
// WARRANTY. See LICENSE and NOTICE.md. Read DISCLAIMER.md before tuning.

// One arithmetic expression compiler, no eval. Used for XDF scaling equations
// (one variable, X) and for math channels on logs (many inputs).
//
// Supports numbers, + - * / ^, parentheses, unary minus, named variables
// (RPM, LTFT, X…) and VCM Scanner parameter references: [2301] or
// [50030.92] — parameter 50030 in unit code 92.
//
// What it refuses rather than guesses: functions (IF, ABS, …), unbalanced
// parentheses, anything left over. A refused formula says why; a formula that
// evaluates to something non-finite returns NaN — division by zero is
// undefined, never zero.

const PREC = { "+": 1, "-": 1, "*": 2, "/": 2, neg: 3, "^": 4 };
const RIGHT = new Set(["^", "neg"]);

/** compile(src) → { ok, error?, vars, refs, eval(env) } */
export function compile(src) {
  const text = String(src ?? "").trim();
  if (!text) return { ok: true, vars: [], refs: [], eval: () => NaN };
  const tokens = text.match(/\[\d+(?:\.\d+)?\]|\d*\.?\d+(?:[eE][+-]?\d+)?|[A-Za-z_][\w.]*|[()+\-*/^]|\S/g) || [];
  const out = [], ops = [], vars = new Set(), refs = [];
  let prev = null;
  for (let i = 0; i < tokens.length; i++) {
    let t = tokens[i];
    if (t.startsWith("[")) {
      const [, id, unit] = t.match(/^\[(\d+)(?:\.(\d+))?\]$/);
      refs.push({ token: t, parameterID: id, unitId: unit || null });
      out.push({ ref: t });
    } else if (/^\d|^\./.test(t)) {
      out.push(parseFloat(t));
    } else if (/^[A-Za-z_]/.test(t)) {
      if (tokens[i + 1] === "(") return refuse(`uses the function ${t}(), which is not supported yet — only + − × ÷ ^ and parentheses`);
      vars.add(t);
      out.push({ v: t });
    } else if (t === "(") {
      ops.push(t);
    } else if (t === ")") {
      while (ops.length && ops.at(-1) !== "(") out.push(ops.pop());
      if (!ops.length) return refuse("has an unmatched )");
      ops.pop();
    } else if (PREC[t] || t === "-" || t === "+") {
      const unary = (t === "-" || t === "+") && (prev === null || prev === "(" || PREC[prev]);
      if (unary && t === "+") { prev = t; continue; }
      if (unary) t = "neg";
      while (ops.length && ops.at(-1) !== "(" &&
             (RIGHT.has(t) ? PREC[ops.at(-1)] > PREC[t] : PREC[ops.at(-1)] >= PREC[t])) out.push(ops.pop());
      ops.push(t);
    } else {
      return refuse(`has a character the evaluator does not understand: “${t}”`);
    }
    prev = t;
  }
  while (ops.length) { const o = ops.pop(); if (o === "(") return refuse("has an unmatched ("); out.push(o); }

  const evaluate = env => {
    const st = [];
    for (const t of out) {
      if (typeof t === "number") st.push(t);
      // a missing input is missing, not zero (JS would treat null as 0)
      else if (t.ref || t.v) { const v = env[t.ref || t.v]; if (v == null || !Number.isFinite(v)) return NaN; st.push(v); }
      else if (t === "neg") st.push(-st.pop());
      else {
        const b = st.pop(), a = st.pop();
        st.push(t === "+" ? a + b : t === "-" ? a - b : t === "*" ? a * b
              : t === "/" ? (b === 0 ? NaN : a / b) : Math.pow(a, b));
      }
    }
    const r = st.length === 1 ? st[0] : NaN;
    return typeof r === "number" && Number.isFinite(r) ? r : NaN;
  };
  return { ok: true, vars: [...vars], refs, eval: evaluate };
}

function refuse(error) { return { ok: false, error, vars: [], refs: [], eval: () => NaN }; }
