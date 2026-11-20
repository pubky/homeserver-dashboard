#!/usr/bin/env bash
# Unpacks a release archive and runs it the way the README says to, with an
# empty environment and the Node.js it ships: the launcher must bring the
# server up on loopback by itself, and the server must answer the API, a page
# and that page's scripts. Needs port 8080 free.
#
#   scripts/smoke-test-archive.sh <archive.tar.gz>
set -euo pipefail

archive="$(realpath "${1:?usage: smoke-test-archive.sh <archive.tar.gz>}")"
work="$(mktemp -d)"
server=""
trap '[[ -n "$server" ]] && kill "$server" 2>/dev/null; rm -rf "$work"' EXIT

tar --extract --gzip --file "$archive" --directory "$work"
dir="$work/$(basename "$archive" .tar.gz)"

# The one native-style dependency: a WebAssembly module Node loads at runtime,
# which only a built copy can lose (see CLAUDE.md, "The image").
(cd "$dir" && ./bin/node --eval 'require("@synonymdev/pkarr")')

# The launcher's defaults are what is being tested, so it gets no address of
# its own, and a HOSTNAME like the one shells set, which it must not follow.
port=8080
listeners() { ss --listening --tcp --numeric --no-header "sport = :$port"; }
[[ -z "$(listeners)" ]] || { echo "port $port is already in use; stop what listens there first" >&2; exit 1; }
env --ignore-environment HOSTNAME=0.0.0.0 "$dir/homeserver-dashboard" &
server=$!
url="http://127.0.0.1:$port"
for _ in $(seq 1 30); do
  curl --silent --fail --output /dev/null "$url/api/health" && break
  sleep 1
done
curl --silent --fail --output /dev/null "$url/api/health"
# On loopback and nowhere else.
[[ "$(listeners | awk '{print $4}')" == "127.0.0.1:$port" ]] || { echo "not listening on loopback only:" >&2; listeners >&2; exit 1; }
curl --silent --fail --output "$work/page.html" "$url/dashboard"
script="$(grep --only-matching '/_next/static/[^"]*\.js' "$work/page.html" | sed --quiet 1p)"
[[ -n "$script" ]]
curl --silent --fail --output /dev/null "$url$script"
echo "ok: $(basename "$archive") serves $url"
