// TeX to Unicode for math in a line of text, where a picture one row high would be
// unreadable: only what Unicode spells exactly (Greek letters, operators, digits and a few
// letters raised or lowered). Anything else (a fraction, a matrix, a command it does not
// know) gives null: the TeX is then shown as written, which reads better than a guess.

const SYMBOLS: Readonly<Record<string, string>> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  leq: "≤",
  le: "≤",
  geq: "≥",
  ge: "≥",
  neq: "≠",
  ne: "≠",
  approx: "≈",
  equiv: "≡",
  sim: "∼",
  pm: "±",
  mp: "∓",
  times: "×",
  cdot: "·",
  div: "÷",
  infty: "∞",
  sum: "∑",
  prod: "∏",
  int: "∫",
  partial: "∂",
  nabla: "∇",
  forall: "∀",
  exists: "∃",
  in: "∈",
  notin: "∉",
  subset: "⊂",
  subseteq: "⊆",
  cup: "∪",
  cap: "∩",
  emptyset: "∅",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  iff: "⟺",
  mapsto: "↦",
  ldots: "…",
  cdots: "⋯",
  circ: "∘",
  degree: "°",
  neg: "¬",
  land: "∧",
  lor: "∨",
  hbar: "ℏ",
  ell: "ℓ",
};

const SUPERSCRIPT: Readonly<Record<string, string>> = {
  "0": "⁰",
  "1": "¹",
  "2": "²",
  "3": "³",
  "4": "⁴",
  "5": "⁵",
  "6": "⁶",
  "7": "⁷",
  "8": "⁸",
  "9": "⁹",
  "+": "⁺",
  "-": "⁻",
  "=": "⁼",
  "(": "⁽",
  ")": "⁾",
  a: "ᵃ",
  b: "ᵇ",
  c: "ᶜ",
  d: "ᵈ",
  e: "ᵉ",
  f: "ᶠ",
  g: "ᵍ",
  h: "ʰ",
  i: "ⁱ",
  j: "ʲ",
  k: "ᵏ",
  l: "ˡ",
  m: "ᵐ",
  n: "ⁿ",
  o: "ᵒ",
  p: "ᵖ",
  r: "ʳ",
  s: "ˢ",
  t: "ᵗ",
  u: "ᵘ",
  v: "ᵛ",
  w: "ʷ",
  x: "ˣ",
  y: "ʸ",
  z: "ᶻ",
  T: "ᵀ",
};
const SUBSCRIPT: Readonly<Record<string, string>> = {
  "0": "₀",
  "1": "₁",
  "2": "₂",
  "3": "₃",
  "4": "₄",
  "5": "₅",
  "6": "₆",
  "7": "₇",
  "8": "₈",
  "9": "₉",
  "+": "₊",
  "-": "₋",
  "=": "₌",
  "(": "₍",
  ")": "₎",
  a: "ₐ",
  e: "ₑ",
  h: "ₕ",
  i: "ᵢ",
  j: "ⱼ",
  k: "ₖ",
  l: "ₗ",
  m: "ₘ",
  n: "ₙ",
  o: "ₒ",
  p: "ₚ",
  r: "ᵣ",
  s: "ₛ",
  t: "ₜ",
  u: "ᵤ",
  v: "ᵥ",
  x: "ₓ",
};

/** `tex` spelled in Unicode, or null when that would not be exact. */
export function texToUnicode(tex: string): string | null {
  let out = "";
  let at = 0;
  // A group `{…}` or a single character after `^` or `_`, as plain text to shift.
  const operand = () => {
    if (tex[at] === "{") {
      const end = tex.indexOf("}", at);
      if (end < 0 || tex.slice(at + 1, end).includes("{")) return null;
      const inner = texToUnicode(tex.slice(at + 1, end));
      at = end + 1;
      return inner;
    }
    if (tex[at] === "\\") {
      const name = /^\\([A-Za-z]+)/.exec(tex.slice(at))?.[1];
      const symbol = name === undefined ? undefined : SYMBOLS[name];
      if (name === undefined || symbol === undefined) return null;
      at += name.length + 1;
      return symbol;
    }
    const char = tex[at];
    at++;
    return char ?? null;
  };
  while (at < tex.length) {
    const char = tex[at] ?? "";
    if (char === "\\") {
      const rest = tex.slice(at);
      const name = /^\\([A-Za-z]+)/.exec(rest)?.[1];
      if (name === undefined) {
        // `\,` `\;` `\ ` are spaces; `\{` `\}` `\%` themselves.
        const next = rest[1] ?? "";
        if (",;: ".includes(next)) out += " ";
        else if ("{}%$#&_".includes(next)) out += next;
        else return null;
        at += 2;
        continue;
      }
      if (name === "sqrt") {
        at += name.length + 1;
        const inner = operand();
        if (inner === null) return null;
        out += inner.length > 1 ? `√(${inner})` : `√${inner}`;
        continue;
      }
      const symbol = SYMBOLS[name];
      if (symbol === undefined) return null;
      out += symbol;
      at += name.length + 1;
      // A space that only ends a command's name (`\pi r`) is not text; others are kept,
      // as the writer spaced the formula.
      if (tex[at] === " " && /[A-Za-z]/.test(tex[at + 1] ?? "")) at++;
      continue;
    }
    if (char === "^" || char === "_") {
      at++;
      const inner = operand();
      if (inner === null) return null;
      const table = char === "^" ? SUPERSCRIPT : SUBSCRIPT;
      const shifted = Array.from(inner, (c) => table[c]);
      if (!shifted.every((c) => c !== undefined)) return null;
      out += shifted.join("");
      continue;
    }
    if (char === "{" || char === "}") return null;
    out += char;
    at++;
  }
  return out;
}
