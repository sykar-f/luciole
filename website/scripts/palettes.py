#!/usr/bin/env python3
"""Write src/styles/palettes.css, the colour presets of the site, and check them.

Each preset gives its base colours (page, text, Client, Server, fault, and the guide's
wire and build tones); the rest is derived here and checked: every text colour must read
at 4.5:1 or more on the page and on raised panels, and Client and Server must differ in
luminance by 1.5x or more, on the page and on the screens, so they part without hue too.
The script refuses to write a palette that fails, and prints the ratios.

  python3 website/scripts/palettes.py           # write and print the table
  python3 website/scripts/palettes.py --check   # print only, exit 1 on a failure

Standard library only.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSS = ROOT / "src/styles/palettes.css"
NAMES = ROOT / "src/lib/palettes.json"

TEXT = 4.5
APART = 1.5

# Base colours; `light` pages keep dark screens, set in `screens`.
PRESETS = {
    "phosphor": {
        "about": "Phosphor: P1 green and P3 amber on warm black, the D1 direction.",
        "night": "#0b0a07", "paper": "#e8e1cf", "client": "#33ff99", "server": "#ffa000",
        "fault": "#ff4d3d", "wire": "#a9b8ff", "build": "#c9a8ff",
    },
    "amber-mono": {
        "about": "Amber mono: an IBM 3278 or Wyse tube, all amber, the Client the brightest.",
        "night": "#0d0800", "paper": "#ffcc80", "client": "#ffe7b8", "server": "#ff9d00",
        "fault": "#ff5f3a", "wire": "#e8b7ff", "build": "#ffb3c7",
    },
    "green-mono": {
        "about": "Green mono: a VT100 P1 tube, green on green, the Client the brightest.",
        "night": "#040a05", "paper": "#a8f0b8", "client": "#d8ffe2", "server": "#22d860",
        "fault": "#ff6b5a", "wire": "#9fd4ff", "build": "#d9b8ff",
    },
    "paper-white": {
        "about": "Paper white: a VT220 P4 white tube, ice-blue Client, orange Server.",
        "night": "#0a0c0f", "paper": "#e6edf5", "client": "#a6e4ff", "server": "#f08a2c",
        "fault": "#ff5c5c", "wire": "#b4b8ff", "build": "#e0a8ff",
    },
    "tektronix": {
        "about": "Tektronix: a storage tube, mint Client, a brighter yellow-green Server.",
        "night": "#06100c", "paper": "#c6f0dc", "client": "#2fd49a", "server": "#f4ff7a",
        "fault": "#ff6a5a", "wire": "#9fc8ff", "build": "#d8b4ff",
    },
    "nostromo": {
        "about": "Nostromo: Alien's MU-TH-UR consoles, pale green Client, red Server, yellow faults.",
        "night": "#0a0605", "paper": "#e9ddd0", "client": "#9cf2c8", "server": "#ff5a36",
        "fault": "#ffd23f", "wire": "#a8c0ff", "build": "#d2a8ff",
    },
    "plasma": {
        "about": "Plasma: an orange gas-plasma panel (GRiD Compass), pale Client, deep orange Server.",
        "night": "#120500", "paper": "#ff9a4d", "client": "#ffd0a1", "server": "#ff5a1f",
        "fault": "#ffe14d", "wire": "#c9b0ff", "build": "#ff9ecf",
    },
    "greenbar": {
        "about": "Greenbar: listing paper, light, faint green bands; the terminal screens stay dark.",
        "night": "#f1efe6", "paper": "#1a1a17", "client": "#054a2d", "server": "#9a5400",
        "fault": "#b3261e", "wire": "#3342b8", "build": "#7a2fb5", "light": True,
        "screens": {
            "screen": "#0b0c0a", "screen-fg": "#e8e6dc", "screen-client": "#5cf5a5",
            "screen-server": "#f09a2a", "screen-fault": "#ff6b5a",
        },
    },
}

# Phosphor keeps the values the D1 direction was drawn and approved with.
PHOSPHOR = {
    "rule": "#2a2618", "rule-strong": "#3d3726", "night-raised": "#14120c",
    "night-deep": "#070604", "panel": "#070604", "code-bg": "#070604", "screen": "#070604",
    "screen-fg": "#e8e1cf", "screen-rule": "#2a2618", "prose": "#d8d1be", "mist": "#a39c88",
    "dim": "#8a8472", "code-function": "#f4eedf", "code-comment": "#8a8472",
    "code-keyword": "#c7b8e8", "code-type": "#a9c4d6", "code-string": "#cfc39a",
    "code-number": "#e6a6a0", "code-attr": "#c2b9a3", "code-punct": "#9b9480",
}

ORDER = [
    "night", "night-raised", "night-deep", "rule", "rule-strong", "paper", "prose", "mist",
    "dim", "client", "server", "fault", "wire", "build", "panel", "code-bg", "code-function",
    "code-comment", "code-keyword", "code-type", "code-string", "code-number", "code-attr",
    "code-punct", "screen", "screen-fg", "screen-rule", "screen-client", "screen-server",
    "screen-fault",
]


def rgb(color):
    return [int(color[i : i + 2], 16) for i in (1, 3, 5)]


def hexa(channels):
    return "#" + "".join(f"{max(0, min(255, round(c))):02x}" for c in channels)


def mix(a, b, t):
    """`a` moved `t` of the way to `b`."""
    return hexa([x + (y - x) * t for x, y in zip(rgb(a), rgb(b))])


def luminance(color):
    linear = [c / 255 for c in rgb(color)]
    linear = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in linear]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def ratio(a, b):
    high, low = sorted((luminance(a), luminance(b)), reverse=True)
    return (high + 0.05) / (low + 0.05)


def towards(text, page, target):
    """The text colour moved towards the page as far as `target` contrast allows."""
    found = text
    for step in range(101):
        color = mix(text, page, step / 100)
        if ratio(color, page) >= target:
            found = color
    return found


def derive(preset):
    night, paper, light = preset["night"], preset["paper"], preset.get("light", False)
    t = {k: preset[k] for k in ("night", "paper", "client", "server", "fault", "wire", "build")}
    t["prose"] = towards(paper, night, 11)
    t["mist"] = towards(paper, night, 7)
    t["dim"] = towards(paper, night, 5.3)
    t["rule"] = mix(night, paper, 0.16 if light else 0.13)
    t["rule-strong"] = mix(night, paper, 0.3 if light else 0.22)
    t["night-raised"] = mix(night, paper, 0.05)
    t["night-deep"] = mix(night, "#ffffff" if light else "#000000", 0.35)
    t["panel"] = mix(night, "#ffffff", 0.55) if light else t["night-deep"]
    t["code-bg"] = t["panel"]
    t["screen"] = mix(night, "#000000", 0.4)
    t["screen-fg"] = paper
    t["screen-client"], t["screen-server"], t["screen-fault"] = (
        preset["client"], preset["server"], preset["fault"],
    )
    t.update(preset.get("screens", {}))
    t["screen-rule"] = mix(t["screen"], t["screen-fg"], 0.14)
    # Syntax: the text, leaning towards the guide's tones.
    t["code-function"] = paper
    t["code-comment"] = t["dim"]
    t["code-keyword"] = mix(paper, preset["build"], 0.6)
    t["code-type"] = mix(paper, preset["wire"], 0.6)
    t["code-string"] = mix(paper, t["mist"], 0.45)
    t["code-number"] = mix(paper, preset["fault"], 0.4)
    t["code-attr"] = t["prose"]
    t["code-punct"] = t["mist"]
    return t


def measure(t):
    page, raised, screen = t["night"], t["night-raised"], t["screen"]
    texts = ["paper", "prose", "mist", "dim", "client", "server", "fault", "wire", "build"]
    codes = [k for k in t if k.startswith("code-") and k != "code-bg"]
    return {
        **{k: ratio(t[k], page) for k in texts},
        "dim/raised": ratio(t["dim"], raised),
        "code min": min(ratio(t[k], t["code-bg"]) for k in codes),
        "screen fg": ratio(t["screen-fg"], screen),
        "scr client": ratio(t["screen-client"], screen),
        "scr server": ratio(t["screen-server"], screen),
        "C/S apart": ratio(t["client"], t["server"]),
        "scr C/S": ratio(t["screen-client"], t["screen-server"]),
    }


def failures(measured):
    return [
        k for k, v in measured.items() if v < (APART if k in ("C/S apart", "scr C/S") else TEXT)
    ]


def css(name, preset, t):
    selector = ':root,\n:root[data-palette="phosphor"]' if name == "phosphor" else f':root[data-palette="{name}"]'
    light = preset.get("light", False)
    lines = [f"/* {preset['about']} */", selector + " {", f"  color-scheme: {'light' if light else 'dark'};", ""]
    lines += [f"  --{k}: {t[k]};" for k in ORDER]
    lines += [
        "",
        "  /* The screens' glass and afterglow: a written cell starts hot, cools warm, then goes. */",
        "  --afterglow: var(--screen-client);",
        "  --afterglow-hot: 30%;",
        "  --afterglow-warm: 14%;",
        "  --glow-blur: 6px;",
        f"  --scanline: rgb(0 0 0 / {0.2 if name in ('plasma', 'amber-mono') else 0.16});",
        "  --vignette: rgb(0 0 0 / 0.45);",
    ]
    if light:
        lines += [
            "  /* Listing paper: pale green bands, two lines of print each. */",
            "  --page-texture: repeating-linear-gradient(to bottom, transparent 0 3.2em,"
            " color-mix(in srgb, var(--client) 5%, transparent) 3.2em 6.4em);",
        ]
    else:
        lines.append("  --page-texture: none;")
    return "\n".join(lines + ["}", ""])


HEADER = """/* The palettes: every colour of the site, and nothing else. Written by
   scripts/palettes.py, which checks them: edit the presets there, not here.
   A preset sets these tokens on the root; styles/global.css derives the soft tints.
   Phosphor is the default. The screens (--screen*) keep their own colours: in the light
   preset they stay dark, as terminals do. */
"""


def main():
    check = "--check" in sys.argv
    tokens = {}
    for name, preset in PRESETS.items():
        t = derive(preset)
        if name == "phosphor":
            t.update(PHOSPHOR)
        tokens[name] = t
    measured = {name: measure(t) for name, t in tokens.items()}
    columns = list(next(iter(measured.values())))
    print(f"{'':12}" + "".join(f"{c:>11}" for c in columns))
    failed = False
    for name, m in measured.items():
        bad = failures(m)
        failed = failed or bool(bad)
        print(f"{name:12}" + "".join(f"{m[c]:>10.2f}{'!' if c in bad else ' '}" for c in columns))
    if failed:
        sys.exit("A palette fails its contrast checks (!): nothing written.")
    if check:
        return
    CSS.write_text(HEADER + "\n" + "\n".join(css(n, PRESETS[n], tokens[n]) for n in PRESETS))
    NAMES.write_text(json.dumps(list(PRESETS)) + "\n")


if __name__ == "__main__":
    main()
