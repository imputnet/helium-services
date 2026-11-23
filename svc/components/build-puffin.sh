#!/usr/bin/env bash
set -euo pipefail
: "${OUT:?}"
VERSION=${VERSION:-$(curl -fsSL https://raw.githubusercontent.com/imputnet/helium/main/chromium_version.txt)}
mkdir -p "$OUT"
OUT=$(cd "$OUT" && pwd)
TARBALLS_URL=${TARBALLS_URL:-https://tarballs.imput.net}
TARBALLS_REPOSITORY=${TARBALLS_REPOSITORY:-imputnet/chromium-tarballs}

work=$(mktemp -d "${TMPDIR:-/tmp}/puffin-build.XXXXXX")
trap 'rm -rf -- "$work"' EXIT

curl -fsSL -o "$work/SHA256SUMS" \
  "https://github.com/$TARBALLS_REPOSITORY/releases/download/chromium-$VERSION/SHA256SUMS"
for layer in base linux-x64; do
  name="chromium-$VERSION-$layer.tar.zst"
  expected=$(awk -v name="$name" '$2 == name { print $1 }' "$work/SHA256SUMS")
  [ -n "$expected" ] || { echo "$name is not in SHA256SUMS" >&2; exit 1; }
  mkfifo "$work/hash"
  sha256sum < "$work/hash" > "$work/$layer.sha256" &
  curl -fsSL "$TARBALLS_URL/chromium-$VERSION/$name" | tee "$work/hash" | zstd -dc -T0 | tar -x -C "$work"
  wait $!
  rm "$work/hash"
  actual=$(cut -d' ' -f1 "$work/$layer.sha256")
  [ "$actual" = "$expected" ] || { echo "$name: sha256 $actual, expected $expected" >&2; exit 1; }
done

src="$work/chromium-$VERSION"
cd "$src"
{
  cat .gn
  echo 'root = "//third_party/puffin:puffin"'
  echo 'root_patterns = [ "//third_party/puffin:puffin" ]'
} > .gn.puffin
mkdir -p out/puffin
cat > out/puffin/args.gn <<'ARGS'
is_debug = false
is_component_build = false
symbol_level = 0
use_remoteexec = false
treat_warnings_as_errors = false
ARGS
buildtools/linux64/gn gen out/puffin --dotfile=.gn.puffin
third_party/ninja/ninja -C out/puffin puffin

printf 'puffin check, before' > "$work/a.raw"
printf 'puffin check, after!' > "$work/b.raw"
out/puffin/puffin -puffdiff "$work/a.raw" "$work/b.raw" "$work/patch.puff"
out/puffin/puffin -puffpatch "$work/a.raw" "$work/check.raw" "$work/patch.puff"
cmp "$work/b.raw" "$work/check.raw"

cp out/puffin/puffin "$OUT/puffin"
echo "built $OUT/puffin from Chromium $VERSION"
