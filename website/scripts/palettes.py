#!/usr/bin/env python3
"""Write src/styles/palettes.css, the colours of the site on three axes, and check them.

A palette is three independent choices, each an attribute on the root element:
- data-tint: the dark background and the neutrals tuned to it (text, rules, screens);
- data-dominant: one colour for links, the main button, the cursor, the Live badge and the
  screens' afterglow;
- data-encoding: how Client and Server are told apart, derived in CSS from the dominant
  (OKLCH relative colours), or the classic green and amber.

The CSS derives the combinations; this script writes the per-axis values, computes every
combination as a browser would, and checks it: every text colour at 4.5:1 or more on the
page and on raised panels, the main button's text on the dominant at 4.5:1, and Client and
Server at least 1.5x apart in luminance, so they part without hue too. A failing dominant
is fixed by moving its OKLCH lightness, not dropped; a failing tint or encoding stops the
script, which then writes nothing.

  python3 website/scripts/palettes.py           # write, and print the table
  python3 website/scripts/palettes.py --check   # print only; exit 1 on a failure

Standard library only.
"""

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT / "src/styles/palettes.css"
NAMES = ROOT / "src/lib/palettes.json"

TEXT = 4.5
APART = 1.5

# ---- colour arithmetic (sRGB, WCAG luminance, OKLab / OKLCH as in CSS Color 4) ----


def rgb(color):
    return [int(color[i : i + 2], 16) / 255 for i in (1, 3, 5)]


def hexa(channels):
    return "#" + "".join(f"{round(max(0.0, min(1.0, c)) * 255):02x}" for c in channels)


def linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def gamma(c):
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def luminance(color):
    r, g, b = (linear(c) for c in rgb(color))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    high, low = sorted((luminance(a), luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def oklch(color):
    r, g, b = (linear(c) for c in rgb(color))
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l, m, s = (math.copysign(abs(v) ** (1 / 3), v) for v in (l, m, s))
    L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s
    a = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s
    bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    return L, math.hypot(a, bb), math.degrees(math.atan2(bb, a)) % 360


def from_oklch(L, C, H):
    """The sRGB colour, and whether it had to be clipped into sRGB."""
    a, b = C * math.cos(math.radians(H)), C * math.sin(math.radians(H))
    l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    lin = [
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    ]
    clipped = any(c < -0.002 or c > 1.002 for c in lin)
    return hexa([gamma(max(0.0, min(1.0, c))) for c in lin]), clipped


def mix(a, b, t):
    return hexa([x + (y - x) * t for x, y in zip(rgb(a), rgb(b))])


# ---- the three axes ----

# Phosphor's neutrals, as approved for the D1 direction: the warm tint, and the source the
# other tints take their lightness and chroma from.
WARM = {
    "night": "#0b0a07", "night-raised": "#14120c", "night-deep": "#070604", "rule": "#2a2618",
    "rule-strong": "#3d3726", "paper": "#e8e1cf", "prose": "#d8d1be", "mist": "#a39c88",
    "dim": "#8a8472", "screen": "#070604", "screen-fg": "#e8e1cf", "screen-rule": "#2a2618",
}
# Each tint: its hue, and the background it was asked for.
TINTS = {
    "warm": {"about": "Warm neutral: phosphor's black.", "night": "#0b0a07"},
    "blue": {"about": "Blue black.", "night": "#080a10"},
    "green": {"about": "Green black.", "night": "#070b0a"},
    "violet": {"about": "Violet black.", "night": "#0b0914"},
}

# The dominant, as asked; its lightness is raised where a check fails.
DOMINANTS = {
    "neutral": {"about": "No dominant: the text colour, as phosphor has it.", "color": None},
    "glacier": {"about": "Glacier blue.", "color": "#7cb8ff"},
    "cobalt": {"about": "Cobalt.", "color": "#5b8cff"},
    "cyan": {"about": "Cyan.", "color": "#5cd0f0"},
    "mint": {"about": "Mint.", "color": "#5eead4"},
    "green": {"about": "Green.", "color": "#7ee0a0"},
    "violet": {"about": "Violet.", "color": "#a78bfa"},
    "lilac": {"about": "Lilac.", "color": "#c9a8ff"},
    "indigo": {"about": "Indigo.", "color": "#8b93ff"},
    "firefly": {"about": "A firefly's yellow-green, the light luciole is named after.", "color": "#c6e85a"},
}

# Client and Server from the dominant. Only mixes in sRGB and HSL hue turns: the result
# is always inside sRGB, so what is checked here is what the browser paints. Per dominant,
# --lift is its share in a light Client (the rest white) and --deep its share in a deep
# Server (the rest black), both fitted below so every check passes; the analogous
# encoding has its own pair (--lift-turned, --deep-turned), its hues not being the dominant's.
WHITE, BLACK = "#ffffff", "#000000"
IVORY = "#efe9dc"
GREY = "#999185"
TURN = 40


# A turned hue keeps at least this HSL lightness: blue turned from cyan would be too dark.
TURN_LIGHT = 0.62


def turn(color, degrees):
    """`hsl(from color calc(h + degrees) s max(l, 62))`."""
    import colorsys

    h, l, s = colorsys.rgb_to_hls(*rgb(color))
    return hexa(colorsys.hls_to_rgb((h + degrees / 360) % 1, max(l, TURN_LIGHT), s))


ENCODINGS = {
    "classic": {
        "about": "Green Client, amber Server: the D1 reference.",
        "client": ("#33ff99", lambda d, lift, deep: "#33ff99"),
        "server": ("#ffa000", lambda d, lift, deep: "#ffa000"),
        "mark": False,
    },
    "tones": {
        "about": "Two tones of the dominant: a light, soft Client and a deep, saturated Server.",
        "client": ("color-mix(in srgb, var(--dominant) var(--lift), #fff)", lambda d, lift, deep: mix(WHITE, d, lift)),
        "server": ("color-mix(in srgb, var(--dominant) var(--deep), #000)", lambda d, lift, deep: mix(BLACK, d, deep)),
        "mark": True,
    },
    "analogous": {
        "about": f"Two hues beside the dominant, {TURN} degrees each way: a light Client, a deeper Server.",
        "client": (
            f"color-mix(in srgb, hsl(from var(--dominant) calc(h - {TURN}) s max(l, 62)) var(--lift-turned), #fff)",
            lambda d, lift, deep: mix(WHITE, turn(d, -TURN), lift),
        ),
        "server": (
            f"color-mix(in srgb, hsl(from var(--dominant) calc(h + {TURN}) s max(l, 62)) var(--deep-turned), #000)",
            lambda d, lift, deep: mix(BLACK, turn(d, TURN), deep),
        ),
        "mark": True,
    },
    "dominant-neutral": {
        "about": "The dominant for the Client, a warm grey for the Server.",
        "client": ("color-mix(in srgb, var(--dominant) var(--lift), #fff)", lambda d, lift, deep: mix(WHITE, d, lift)),
        "server": (GREY, lambda d, lift, deep: GREY),
        "mark": True,
    },
    "neutral-dominant": {
        "about": "An ivory Client, the dominant, deeper, for the Server.",
        "client": (IVORY, lambda d, lift, deep: IVORY),
        "server": ("color-mix(in srgb, var(--dominant) var(--deep), #000)", lambda d, lift, deep: mix(BLACK, d, deep)),
        "mark": True,
    },
}

# Combinations worth a look, in the switcher.
SUGGESTIONS = {
    "ice": {"tint": "blue", "dominant": "glacier", "encoding": "tones"},
    "aurora": {"tint": "green", "dominant": "mint", "encoding": "analogous"},
    "ultraviolet": {"tint": "violet", "dominant": "violet", "encoding": "tones"},
    "midnight": {"tint": "blue", "dominant": "indigo", "encoding": "dominant-neutral"},
    "moss": {"tint": "green", "dominant": "green", "encoding": "dominant-neutral"},
    "phosphor": {"tint": "warm", "dominant": "neutral", "encoding": "classic"},
    "luciole": {"tint": "warm", "dominant": "firefly", "encoding": "dominant-neutral"},
}

# Syntax and the guide's tones: the same on every tint, checked on each.
FIXED = {
    "fault": "#ff4d3d", "wire": "#a9b8ff", "build": "#c9a8ff", "code-function": "#f4eedf",
"code-keyword": "#c7b8e8", "code-type": "#a9c4d6",
    "code-string": "#cfc39a", "code-number": "#e6a6a0", "code-attr": "#c2b9a3",
    "code-punct": "#9b9480",
}


def tint(name):
    """A tint's neutrals: phosphor's, turned to its hue at their lightness and chroma."""
    if name == "warm":
        tokens = dict(WARM)
    else:
        hue = oklch(TINTS[name]["night"])[2]
        tokens = {}
        for key, color in WARM.items():
            L, C, _ = oklch(color)
            tokens[key] = from_oklch(L, min(C, 0.03), hue)[0]
        tokens["night"] = TINTS[name]["night"]
    tokens["panel"] = tokens["night-deep"]
    tokens["code-bg"] = tokens["night-deep"]
    # Dim text: on the tint's own raised panels too.
    while min(ratio(tokens["dim"], tokens[k]) for k in ("night", "night-raised")) < TEXT:
        L, C, H = oklch(tokens["dim"])
        tokens["dim"] = from_oklch(L + 0.01, C, H)[0]
    tokens["code-comment"] = tokens["dim"]
    return tokens


def dominant(name, tokens):
    """The dominant, lightened in OKLCH until it and the button's text on it read."""
    color = DOMINANTS[name]["color"] or tokens["paper"]
    L, C, H = oklch(color)
    while ratio(color, tokens["night"]) < TEXT or ratio(tokens["night"], color) < TEXT:
        L += 0.01
        color = from_oklch(L, C, H)[0]
    return color


def dominant_everywhere(name):
    """One value per dominant, whatever the tint: the lightest any tint needs."""
    if DOMINANTS[name]["color"] is None:
        return WARM["paper"]
    return max((dominant(name, {**tint(t), **FIXED}) for t in TINTS), key=luminance)


def sides(d, e, lift, deep, *turned, tint_name="warm"):
    # Without a dominant, the tint's own text colour, as the CSS has it (var(--paper)).
    dom = dominant_everywhere(d) if DOMINANTS[d]["color"] else tint(tint_name)["paper"]
    if e == "analogous" and turned:
        lift, deep = turned
    return ENCODINGS[e]["client"][1](dom, lift, deep), ENCODINGS[e]["server"][1](dom, lift, deep)


def fit(d, encodings):
    """A (lift, deep) pair for a dominant in `encodings`: the Server as deep as it reads
    everywhere, the Client as close to the dominant as keeps it 1.5x apart."""
    def fine(lift, deep):
        for t in TINTS:
            tokens = {**tint(t), **FIXED}
            for e in encodings:
                client, server = sides(d, e, lift, deep, tint_name=t)
                if min(ratio(server, tokens["night"]), ratio(server, tokens["screen"])) < TEXT + 0.1:
                    return False
                if min(ratio(client, tokens["night"]), ratio(client, tokens["screen"])) < TEXT + 0.1:
                    return False
                if ratio(client, server) < APART + 0.05:
                    return False
        return True

    for deep in [x / 100 for x in range(78, 101)]:
        for lift in [x / 100 for x in range(60, 19, -2)]:
            if fine(lift, deep):
                return lift, deep
    raise SystemExit(f"No lift and deep fit the dominant {d} in {encodings}")


FITTED = {}
SAME_HUE = ("tones", "dominant-neutral", "neutral-dominant")


def fitted(d):
    """lift, deep, lift-turned, deep-turned."""
    if d not in FITTED:
        FITTED[d] = (*fit(d, SAME_HUE), *fit(d, ("analogous",)))
    return FITTED[d]


def combination(t, d, e):
    tokens = {**tint(t), **FIXED}
    dom = dominant_everywhere(d) if DOMINANTS[d]["color"] else tokens["paper"]
    client, server = sides(d, e, *fitted(d), tint_name=t)
    return tokens, dom, client, server, False


def measure(tokens, dom, client, server):
    page, raised, screen = tokens["night"], tokens["night-raised"], tokens["screen"]
    texts = ["paper", "prose", "mist", "dim", "fault", "wire", "build"]
    codes = [k for k in tokens if k.startswith("code-") and k != "code-bg"]
    return {
        "text min": min(min(ratio(tokens[k], page), ratio(tokens[k], raised)) for k in texts),
        "dominant": ratio(dom, page),
        "button": ratio(page, dom),
        "client": min(ratio(client, page), ratio(client, screen)),
        "server": min(ratio(server, page), ratio(server, screen)),
        "C/S apart": ratio(client, server),
        "code min": min(ratio(tokens[k], tokens["code-bg"]) for k in codes),
    }


def failing(m):
    return [k for k, v in m.items() if v < (APART if k == "C/S apart" else TEXT)]


# ---- CSS ----

HEADER = """/* The colours of the site, on three axes set on the root element (written by
   scripts/palettes.py, which checks every combination: edit it there, not here):
   - data-tint: the background and the neutrals tuned to it;
   - data-dominant: links, the main button, the cursor, the Live badge, the afterglow;
   - data-encoding: Client and Server, derived below from the dominant (sRGB mixes with
     white or black, HSL hue turns: always inside sRGB), or the classic green and amber.
     Encodings from one hue add a cue that is not colour: Server lines dashed, Server
     marks hollow, and a glyph before the words.
   Without attributes: warm, neutral, classic, the D1 phosphor. */
"""


def css():
    blocks = [HEADER]
    for name, about in TINTS.items():
        tokens = {**tint(name), **FIXED}
        selector = f':root[data-tint="{name}"]' if name != "warm" else ':root,\n:root[data-tint="warm"]'
        lines = [f"/* {about['about']} */", selector + " {", "  color-scheme: dark;"]
        lines += [f"  --{k}: {v};" for k, v in tokens.items()]
        blocks.append("\n".join(lines + ["}", ""]))
    blocks.append(
        """/* The screens' glass and afterglow, and what derives from the axes. */
:root {
  --screen-client: var(--client);
  --screen-server: var(--server);
  --screen-fault: var(--fault);
  --afterglow: var(--dominant);
  --live: var(--dominant);
  --link: var(--dominant);
  --afterglow-hot: 30%;
  --afterglow-warm: 14%;
  --glow-blur: 6px;
  --scanline: rgb(0 0 0 / 0.16);
  --vignette: rgb(0 0 0 / 0.45);
  --page-texture: none;
}
"""
    )
    for name, about in DOMINANTS.items():
        if about["color"] is None:
            blocks.append(
                f"""/* {about['about']} Links keep their text's colour; the afterglow and the Live badge keep the Client's. */
:root:not([data-dominant]),
:root[data-dominant="neutral"] {{
  --dominant: var(--paper);
  --lift: {round(fitted(name)[0] * 100)}%;
  --deep: {round(fitted(name)[1] * 100)}%;
  --lift-turned: {round(fitted(name)[2] * 100)}%;
  --deep-turned: {round(fitted(name)[3] * 100)}%;
  --afterglow: var(--screen-client);
  --live: var(--screen-client);
  --link: initial;
}}
"""
            )
            continue
        # Lightened, where needed, for the darkest tint it may sit on.
        color = dominant_everywhere(name)
        lift, deep, lift_turned, deep_turned = fitted(name)
        blocks.append(
            f'/* {about["about"]} */\n:root[data-dominant="{name}"] {{\n  --dominant: {color};\n'
            f"  --lift: {round(lift * 100)}%;\n  --deep: {round(deep * 100)}%;\n"
            f"  --lift-turned: {round(lift_turned * 100)}%;\n  --deep-turned: {round(deep_turned * 100)}%;\n}}\n"
        )
    for name, about in ENCODINGS.items():
        selector = f':root[data-encoding="{name}"]' if name != "classic" else ':root,\n:root[data-encoding="classic"]'
        lines = [f"/* {about['about']} */", selector + " {"]
        lines += [f"  --client: {about['client'][0]};", f"  --server: {about['server'][0]};"]
        if about["mark"]:
            lines += [
                '  --client-glyph: "◆\\00a0";',
                '  --server-glyph: "◇\\00a0";',
                "  --server-line: dashed;",
                "  --server-dash: 4 3;",
                "  --server-fill: transparent;",
                "  --hue-word: none;",
                "  --hue-cue: inline;",
            ]
        else:
            lines += [
                '  --client-glyph: "";',
                '  --server-glyph: "";',
                "  --server-line: solid;",
                "  --server-dash: none;",
                "  --server-fill: var(--server);",
                "  --hue-word: inline;",
                "  --hue-cue: none;",
            ]
        blocks.append("\n".join(lines + ["}", ""]))
    return "\n".join(blocks)


def main():
    check = "--check" in sys.argv
    failed = []
    clipped = []
    for t in TINTS:
        for d in DOMINANTS:
            for e in ENCODINGS:
                tokens, dom, client, server, clip = combination(t, d, e)
                m = measure(tokens, dom, client, server)
                if failing(m):
                    failed.append((t, d, e, m))
                if clip:
                    clipped.append((t, d, e))
    total = len(TINTS) * len(DOMINANTS) * len(ENCODINGS)
    print(f"{total} combinations, {len(failed)} failing")
    for t, d, e, m in failed:
        print(f"  FAIL {t}/{d}/{e}: " + ", ".join(f"{k} {m[k]:.2f}" for k in failing(m)))
    print()
    columns = list(measure(*combination("warm", "neutral", "classic")[:4]))
    print(f"{'suggestion':14}" + "".join(f"{c:>11}" for c in columns) + "   client   server  dominant")
    for name, s in SUGGESTIONS.items():
        tokens, dom, client, server, _ = combination(s["tint"], s["dominant"], s["encoding"])
        m = measure(tokens, dom, client, server)
        print(f"{name:14}" + "".join(f"{m[c]:>11.2f}" for c in columns) + f"  {client}  {server}  {dom}")
    if failed:
        sys.exit("Some combinations fail their checks: nothing written.")
    if check:
        return
    CSS.write_text(css())
    NAMES.write_text(
        json.dumps(
            {
                "tints": list(TINTS),
                "dominants": list(DOMINANTS),
                "encodings": list(ENCODINGS),
                "suggestions": SUGGESTIONS,
            },
            indent=2,
        )
        + "\n"
    )


if __name__ == "__main__":
    main()
