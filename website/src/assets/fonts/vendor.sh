#!/usr/bin/env bash
# Refetches the Fontsource files the site serves (ibm-plex-mono/, ibm-plex-sans/,
# jetbrains-mono/), so `astro build` never asks a CDN for a font. astro.config.mjs reads them
# through its `vendoredFonts` provider, which names the files <subset>-<weight>-<style>.woff2
# (`wght` for a variable axis). Needs npm. Run it from anywhere:
#   bash website/src/assets/fonts/vendor.sh
# Versions are pinned, so a rerun gives the committed bytes. To add a weight, a style or a
# subset, add it here and in the family's block of astro.config.mjs.
set -euo pipefail

VERSION=5.3.0
SUBSETS="latin latin-ext"

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# vendor <npm package> <font id> <dir> <weight-style files...>
vendor() {
  local pkg="$1" id="$2" dir="$3"
  shift 3
  mkdir -p "$tmp/$dir" "$here/$dir"
  (cd "$tmp/$dir" && npm pack "$pkg@$VERSION" --silent >/dev/null && tar xzf ./*.tgz)
  for subset in $SUBSETS; do
    for face in "$@"; do
      cp "$tmp/$dir/package/files/$id-$subset-$face.woff2" "$here/$dir/$subset-$face.woff2"
    done
  done
  cp "$tmp/$dir/package/LICENSE" "$here/$dir/OFL.txt"
}

vendor @fontsource/ibm-plex-mono ibm-plex-mono ibm-plex-mono 400-normal 500-normal 600-normal 700-normal
vendor @fontsource/ibm-plex-sans ibm-plex-sans ibm-plex-sans 400-normal 400-italic 600-normal 600-italic
vendor @fontsource-variable/jetbrains-mono jetbrains-mono jetbrains-mono wght-normal
