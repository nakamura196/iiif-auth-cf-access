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
#   With "degraded": <px>, a greyscale copy at most <px> wide or high is cut too,
#   as <id>-degraded (served publicly to collections with substituteLabel).
# - Each model in demo/models.json is downloaded into <out-dir>/<collection>/model/<id>/model.glb
#   with its meta.json; with "degraded": <url>, that file (e.g. a lighter point cloud)
#   becomes <id>-degraded/model.glb (served publicly to collections with substituteLabel).
# - <collection>=<file pattern> copies the matching files into <out-dir>/<collection>/.
# Needs vips and jq. <out-dir> is emptied first.
set -euo pipefail

if (( $# < 1 )); then
  sed -n '2,18p' "$0"; exit 2
fi
out=${1:a}; shift
cd "${0:A:h}/.."
command -v vips >/dev/null || { print -u2 "vips not found (brew install vips)"; exit 1; }

rm -rf "$out"; mkdir -p "$out"
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT

# cut_image <source jpeg> <collection> <id> <full size>: tiles plus one "full" size.
cut_image() {
  local src=$1 c=$2 id=$3 size=$4 dir="$out/$2/image" w h
  mkdir -p "$dir"
  # The id is a placeholder: the Worker rewrites it for the host it runs on.
  vips dzsave "$src" "$dir/$id" --layout iiif3 --tile-size 512 --id "https://placeholder.invalid/image/$c"
  vips thumbnail "$src" "$tmp/full.jpg" "$size"
  w=$(vipsheader -f width "$tmp/full.jpg"); h=$(vipsheader -f height "$tmp/full.jpg")
  mkdir -p "$dir/$id/full/$w,$h/0"
  mv "$tmp/full.jpg" "$dir/$id/full/$w,$h/0/default.jpg"
  jq --argjson w "$w" --argjson h "$h" '.sizes = ((.sizes // []) + [{width: $w, height: $h}] | unique_by(.width))' \
    "$dir/$id/info.json" > "$tmp/info.json"
  mv "$tmp/info.json" "$dir/$id/info.json"
}

n=$(jq length demo/images.json)
for (( i = 0; i < n; i++ )); do
  c=$(jq -r ".[$i].collection" demo/images.json)
  id=$(jq -r ".[$i].id" demo/images.json)
  src=$(jq -r ".[$i].source" demo/images.json)
  degraded=$(jq -r ".[$i].degraded // empty" demo/images.json)
  print "image $c/$id <- $src"
  curl -sfL -o "$tmp/src.jpg" "$src"
  cut_image "$tmp/src.jpg" "$c" "$id" 1024
  jq ".[$i].meta" demo/images.json > "$out/$c/image/$id/meta.json"
  if [[ -n $degraded ]]; then
    print "image $c/$id-degraded (greyscale, $degraded px)"
    vips thumbnail "$tmp/src.jpg" "$tmp/small.v" "$degraded"
    vips colourspace "$tmp/small.v" "$tmp/gray.jpg" b-w
    cut_image "$tmp/gray.jpg" "$c" "$id-degraded" "$degraded"
    rm "$tmp/small.v" "$tmp/gray.jpg"
  fi
  rm "$tmp/src.jpg"
done

n=$(jq length demo/models.json)
for (( i = 0; i < n; i++ )); do
  c=$(jq -r ".[$i].collection" demo/models.json)
  id=$(jq -r ".[$i].id" demo/models.json)
  src=$(jq -r ".[$i].source" demo/models.json)
  degraded=$(jq -r ".[$i].degraded // empty" demo/models.json)
  print "model $c/$id <- $src"
  mkdir -p "$out/$c/model/$id"
  curl -sfL -o "$out/$c/model/$id/model.glb" "$src"
  jq ".[$i].meta" demo/models.json > "$out/$c/model/$id/meta.json"
  if [[ -n $degraded ]]; then
    print "model $c/$id-degraded <- $degraded"
    mkdir -p "$out/$c/model/$id-degraded"
    curl -sfL -o "$out/$c/model/$id-degraded/model.glb" "$degraded"
  fi
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
