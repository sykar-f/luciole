#!/usr/bin/env bash
# Rebuilds jetbrains-mono-symbols.woff2: the arrows, maths, box, block and symbol glyphs of
# JetBrains Mono, which the Fontsource subsets (latin, latin-ext, ...) leave out. The variable
# font keeps its weight axis, so it matches the 100-800 face the site declares for the family.
# Needs uv (fonttools and brotli are fetched on the fly). Run it from anywhere:
#   bash website/src/assets/fonts/subset.sh
# The last line it prints is the unicodeRange of the local variant in astro.config.mjs.
set -euo pipefail

VERSION=2.304
RANGES="U+2190-21FF,U+2200-23FF,U+2500-259F,U+25A0-25FF,U+2600-26FF,U+2700-27BF"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

curl -fsSL -o "$tmp/jb.zip" \
  "https://github.com/JetBrains/JetBrainsMono/releases/download/v$VERSION/JetBrainsMono-$VERSION.zip"
unzip -q "$tmp/jb.zip" -d "$tmp/jb"

uvx --from fonttools --with brotli pyftsubset "$tmp/jb/fonts/variable/JetBrainsMono[wght].ttf" \
  --unicodes="$RANGES" --flavor=woff2 --layout-features= --notdef-outline \
  --output-file="$here/jetbrains-mono-symbols.woff2"
cp "$tmp/jb/OFL.txt" "$here/OFL.txt"

# The unicode-range to paste into astro.config.mjs: exactly the code points the file draws, so a
# page that only holds glyphs the font lacks (a star, say) does not fetch it for nothing; the four
# the latin subset already carries (up and down arrows, minus, division slash) are left to it.
uvx --from fonttools --with brotli python - "$here/jetbrains-mono-symbols.woff2" <<'PY'
import sys
from fontTools.ttLib import TTFont

latin = {0x2191, 0x2193, 0x2212, 0x2215}
cps = sorted(c for c in TTFont(sys.argv[1]).getBestCmap() if c > 0x7F and c not in latin)
runs, start = [], cps[0]
for prev, cur in zip(cps, cps[1:] + [None]):
    if cur != prev + 1:
        runs.append(f"U+{start:X}" if start == prev else f"U+{start:X}-{prev:X}")
        start = cur
print("unicodeRange:", ", ".join(runs))
PY
