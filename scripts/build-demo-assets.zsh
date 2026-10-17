#!/usr/bin/env zsh
# Build the Static Assets directory of the showcase (deploy/demo.jsonc).
#
# Usage:
#   zsh scripts/build-demo-assets.zsh <out-dir> ['<collection>=<file pattern>' ...]
# Example (quote the pattern; it is expanded here):
#   zsh scripts/build-demo-assets.zsh build/demo 'ueno=~/git/minecraft/hongo-campus-iiif/*ueno*.glb'
#
# - Each image in demo/images.json is downloaded and cut into IIIF Image API 3
#   level 0 tiles (vips dzsave), with one 1024 px "full" size, into
#   <out-dir>/<collection>/image/<id>/ together with its meta.json.
# - <collection>=<file pattern> copies the matching files into <out-dir>/<collection>/.
# Needs vips and jq. <out-dir> is emptied first.
set -euo pipefail

if (( $# < 1 )); then
  sed -n '2,13p' "$0"; exit 2
fi
out=${1:a}; shift
cd "${0:A:h}/.."
command -v vips >/dev/null || { print -u2 "vips not found (brew install vips)"; exit 1; }

rm -rf "$out"; mkdir -p "$out"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

n=$(jq length demo/images.json)
for (( i = 0; i < n; i++ )); do
  c=$(jq -r ".[$i].collection" demo/images.json)
  id=$(jq -r ".[$i].id" demo/images.json)
  src=$(jq -r ".[$i].source" demo/images.json)
  dir="$out/$c/image"
  mkdir -p "$dir"
  print "image $c/$id <- $src"
  curl -sfL -o "$tmp/src.jpg" "$src"
  # The id is a placeholder: the Worker rewrites it for the host it runs on.
  vips dzsave "$tmp/src.jpg" "$dir/$id" --layout iiif3 --tile-size 512 --id "https://placeholder.invalid/image/$c"
  vips thumbnail "$tmp/src.jpg" "$tmp/full.jpg" 1024
  w=$(vipsheader -f width "$tmp/full.jpg"); h=$(vipsheader -f height "$tmp/full.jpg")
  mkdir -p "$dir/$id/full/$w,$h/0"
  mv "$tmp/full.jpg" "$dir/$id/full/$w,$h/0/default.jpg"
  jq --argjson w "$w" --argjson h "$h" '.sizes = ((.sizes // []) + [{width: $w, height: $h}] | unique_by(.width))' \
    "$dir/$id/info.json" > "$tmp/info.json"
  mv "$tmp/info.json" "$dir/$id/info.json"
  jq ".[$i].meta" demo/images.json > "$dir/$id/meta.json"
  rm "$tmp/src.jpg"
done

for pair in "$@"; do
  c=${pair%%=*} pattern=${pair#*=}
  files=( ${~pattern}(N.) )
  (( ${#files} > 0 )) || { print -u2 "no files match: $pattern"; exit 1; }
  mkdir -p "$out/$c"
  cp "${files[@]}" "$out/$c/"
  print "files $c <- ${#files} files (${files:t})"
done

print "\n$(find "$out" -type f | wc -l | tr -d ' ') files, $(du -sh "$out" | cut -f1) in $out"
