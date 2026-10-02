// HTML character references in Markdown text (`&amp;`, `&#35;`, `&eacute;`): the editor
// shows the character, and writes a literal `&` that would read as one escaped. marked
// leaves them undecoded (its HTML output lets the browser decode them).

const HEX = 16;

// Latin-1 letters, in code point order from U+00C0 (`×` and `÷` included, where they sit).
const LATIN1_FROM = 0xc0;
const LATIN1 = (
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave " +
  "Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute " +
  "Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave " +
  "eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml " +
  "divide oslash ugrave uacute ucirc uuml yacute thorn yuml"
).split(" ");
// Latin-1 signs, in code point order from U+00A0.
const SIGNS_FROM = 0xa0;
const SIGNS = (
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg " +
  "plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest"
).split(" ");
/** A character from its code point in hexadecimal: invisible ones stay readable here. */
function character(hex: string) {
  return String.fromCodePoint(parseInt(hex, HEX));
}
const OTHERS: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  ndash: "–",
  mdash: "—",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  dagger: "†",
  Dagger: "‡",
  bull: "•",
  hellip: "…",
  permil: "‰",
  prime: "′",
  lsaquo: "‹",
  rsaquo: "›",
  euro: "€",
  trade: "™",
  larr: "←",
  uarr: "↑",
  rarr: "→",
  darr: "↓",
  harr: "↔",
  minus: "−",
  le: "≤",
  ge: "≥",
  ne: "≠",
  infin: "∞",
  hearts: "♥",
  check: "✓",
  zwj: character("200d"),
  zwnj: character("200c"),
  ensp: character("2002"),
  emsp: character("2003"),
  thinsp: character("2009"),
  OElig: "Œ",
  oelig: "œ",
};

const NAMED = new Map<string, string>([
  ...LATIN1.map((name, i): [string, string] => [name, String.fromCodePoint(LATIN1_FROM + i)]),
  ...SIGNS.map((name, i): [string, string] => [name, String.fromCodePoint(SIGNS_FROM + i)]),
  ...Object.entries(OTHERS),
]);

const REFERENCE = /&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([a-zA-Z][a-zA-Z0-9]{1,31}));/g;
const MAX_CODE_POINT = 0x10ffff;
const REPLACEMENT = character("fffd");
const FIRST_PRINTABLE = 0x20;

/** Where `text` holds references: each as its character, or null for an unknown name. */
export function splitReferences(text: string): { text: string; known: boolean }[] {
  const parts: { text: string; known: boolean }[] = [];
  let at = 0;
  for (const match of text.matchAll(REFERENCE)) {
    const index = match.index;
    if (index > at) parts.push({ text: text.slice(at, index), known: true });
    const [whole, hex, decimal, name] = match;
    const code =
      hex !== undefined ? parseInt(hex, HEX) : decimal !== undefined ? Number(decimal) : NaN;
    // A control character (a tab, a line feed written `&#10;`) would change the text's
    // layout once decoded: it stays a reference.
    if (!Number.isNaN(code) && code > 0 && code < FIRST_PRINTABLE)
      parts.push({ text: whole, known: false });
    else if (!Number.isNaN(code))
      parts.push({
        text: code === 0 || code > MAX_CODE_POINT ? REPLACEMENT : String.fromCodePoint(code),
        known: true,
      });
    else {
      const char = name === undefined ? undefined : NAMED.get(name);
      parts.push(char === undefined ? { text: whole, known: false } : { text: char, known: true });
    }
    at = index + whole.length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), known: true });
  return parts;
}

/** A `&` that would read as the start of a reference. */
export const REFERENCE_START =
  /&(?=#[xX][0-9a-fA-F]{1,6};|#[0-9]{1,7};|[a-zA-Z][a-zA-Z0-9]{1,31};)/g;
