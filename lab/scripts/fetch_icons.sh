#!/usr/bin/env bash
# Fetch labeled SVG icons from permissively-licensed open icon libraries.
# Each icon's filename is its label (plan §5.3). Variant info is preserved in
# the directory layout / filename and recovered later by build_provenance.py.
#
# Strategy: `npm pack` each package (versioned tarball, no dep resolution),
# extract, and copy only the icon SVG subtree into lab/data/raw/<lib>/.
# Idempotent: re-running refreshes a library in place.
#
# Usage:  bash lab/scripts/fetch_icons.sh [lib ...]
#         (no args = fetch all libraries listed in LIBS below)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RAW="$ROOT/lab/data/raw"
LIC="$ROOT/lab/data/licenses"
STAGING="$ROOT/lab/data/.staging"
VERSIONS="$ROOT/lab/data/SOURCES.tsv"

mkdir -p "$RAW" "$LIC" "$STAGING"

# Library spec: name | npm-package | license-id | source-url | svg-subpaths (space-sep, relative to package/)
# The first existing subpath(s) are copied preserving their internal structure.
read -r -d '' LIBS <<'SPEC' || true
lucide|lucide-static|ISC|https://github.com/lucide-icons/lucide|icons
tabler|@tabler/icons|MIT|https://github.com/tabler/tabler-icons|icons
heroicons|heroicons|MIT|https://github.com/tailwindlabs/heroicons|24/outline 24/solid 20/solid 16/solid optimized
bootstrap|bootstrap-icons|MIT|https://github.com/twbs/icons|icons
feather|feather-icons|MIT|https://github.com/feathericons/feather|dist/icons
phosphor|@phosphor-icons/core|MIT|https://github.com/phosphor-icons/core|assets
remix|remixicon|Apache-2.0|https://github.com/Remix-Design/RemixIcon|icons
iconoir|iconoir|MIT|https://github.com/iconoir-icons/iconoir|icons
material-symbols|@material-symbols/svg-400|Apache-2.0|https://github.com/marella/material-symbols|outlined rounded sharp
SPEC

# Optionally restrict to libs passed as args.
WANT=("$@")
want() { [ ${#WANT[@]} -eq 0 ] && return 0; for w in "${WANT[@]}"; do [ "$w" = "$1" ] && return 0; done; return 1; }

# header for SOURCES.tsv (rewritten fresh only when fetching all)
if [ ${#WANT[@]} -eq 0 ]; then printf "library\tnpm_package\tversion\tlicense\tsource_url\tsvg_count\n" > "$VERSIONS"; fi

while IFS='|' read -r name pkg license url subpaths; do
  [ -z "${name:-}" ] && continue
  want "$name" || continue
  echo "=== $name  ($pkg) ==="

  pkgstage="$STAGING/$name"
  rm -rf "$pkgstage"; mkdir -p "$pkgstage"

  # npm pack prints the tarball filename on stdout (last line).
  tgz="$(cd "$pkgstage" && npm pack "$pkg" --silent 2>/dev/null | tail -1)"
  if [ -z "$tgz" ] || [ ! -f "$pkgstage/$tgz" ]; then
    echo "  !! npm pack failed for $pkg — skipping"; continue
  fi
  tar xzf "$pkgstage/$tgz" -C "$pkgstage"   # extracts to $pkgstage/package/
  base="$pkgstage/package"

  version="$(jq -r '.version' "$base/package.json" 2>/dev/null || echo unknown)"

  dest="$RAW/$name"
  rm -rf "$dest"; mkdir -p "$dest"

  copied=0
  for sp in $subpaths; do
    src="$base/$sp"
    if [ -d "$src" ]; then
      # copy preserving the subpath as the variant directory name
      mkdir -p "$dest/$sp"
      # only .svg files, drop any non-icon svgs by living under the icon subtree
      (cd "$src" && find . -name '*.svg' -type f -print0 | while IFS= read -r -d '' f; do
        mkdir -p "$dest/$sp/$(dirname "$f")"
        cp "$src/$f" "$dest/$sp/$f"
      done)
      copied=1
    fi
  done
  if [ "$copied" -eq 0 ]; then
    echo "  ?? none of [$subpaths] found; copying ALL *.svg under package/"
    (cd "$base" && find . -name '*.svg' -type f -print0 | while IFS= read -r -d '' f; do
      mkdir -p "$dest/$(dirname "$f")"; cp "$base/$f" "$dest/$f"
    done)
  fi

  # license capture
  licfile="$(cd "$base" && ls LICENSE* License* license* COPYING* 2>/dev/null | head -1 || true)"
  if [ -n "$licfile" ]; then cp "$base/$licfile" "$LIC/$name.LICENSE.txt"; fi

  cnt="$(find "$dest" -name '*.svg' -type f | wc -l | tr -d ' ')"
  echo "  v$version  license=$license  svgs=$cnt"
  printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$name" "$pkg" "$version" "$license" "$url" "$cnt" >> "$VERSIONS"
done <<< "$LIBS"

echo "=== done. raw total: $(find "$RAW" -name '*.svg' -type f | wc -l | tr -d ' ') svgs ==="
