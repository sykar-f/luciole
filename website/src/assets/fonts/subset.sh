#!/usr/bin/env bash
# Rebuilds jetbrains-mono-symbols.woff2: the arrows, maths, box, block and symbol glyphs of
# JetBrains Mono, which the Fontsource subsets (latin, latin-ext, ...) leave out. The variable
# font keeps its weight axis, so it matches the 100-800 face the site declares for the family.
# Needs uv (fonttools and brotli are fetched on the fly, pinned). Run it from anywhere:
#   bash website/src/assets/fonts/subset.sh
# The last line it prints is the unicodeRange of the local variant in astro.config.mjs (the
# SYMBOLS_RANGE constant). Inputs and tools are pinned, so a rerun gives the committed bytes.
set -euo pipefail

VERSION=2.304
SHA256=6f6376c6ed2960ea8a963cd7387ec9d76e3f629125bc33d1fdcd7eb7012f7bbf
RANGES="U+2190-21FF,U+2200-23FF,U+2500-259F,U+25A0-25FF,U+2600-26FF,U+2700-27BF"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "$tmp/jb.zip" \
  "https://github.com/JetBrains/JetBrainsMono/releases/download/v$VERSION/JetBrainsMono-$VERSION.zip"
echo "$SHA256  $tmp/jb.zip" | shasum -a 256 -c - >/dev/null
unzip -q "$tmp/jb.zip" -d "$tmp/jb"

uvx --from fonttools==4.66.1 --with brotli==1.2.0 python - \
  "$tmp/jb/fonts/variable/JetBrainsMono[wght].ttf" "$here/jetbrains-mono-symbols.woff2" "$RANGES" <<'PY'
import sys
from fontTools import subset
from fontTools.ttLib import TTFont

src, dst, ranges = sys.argv[1:]
wanted = set()
for part in ranges.replace("U+", "").split(","):
    lo, _, hi = part.partition("-")
    wanted.update(range(int(lo, 16), int(hi or lo, 16) + 1))

opts = subset.Options(layout_features=[], notdef_outline=True, flavor="woff2")
font = TTFont(src, recalcTimestamp=False)  # keeps head.modified: the same bytes every run
sub = subset.Subsetter(opts)
sub.populate(unicodes=wanted)
sub.subset(font)
# A kept glyph drags along the other code points that share it (U+27DC shares the glyph of
# U+22B8): drop them, so the file draws exactly what was asked and the range below is true.
for table in font["cmap"].tables:
    table.cmap = {c: g for c, g in table.cmap.items() if c in wanted}
font.flavor = "woff2"
font.save(dst)

# The unicode-range for astro.config.mjs: exactly the code points the file draws, so a page that
# only holds glyphs the font lacks (a star, say) does not fetch it for nothing; the four the
# latin subset already carries (up and down arrows, minus, division slash) are left to it.
latin = {0x2191, 0x2193, 0x2212, 0x2215}
cps = sorted(c for c in TTFont(dst).getBestCmap() if c > 0x7F and c not in latin)
runs, start = [], cps[0]
for prev, cur in zip(cps, cps[1:] + [None]):
    if cur != prev + 1:
        runs.append(f"U+{start:X}" if start == prev else f"U+{start:X}-{prev:X}")
        start = cur
print("unicodeRange:", ", ".join(runs))
PY
cp "$tmp/jb/OFL.txt" "$here/OFL.txt"
