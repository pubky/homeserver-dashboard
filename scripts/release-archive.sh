#!/usr/bin/env bash
# Packs the bundle and a Node.js binary into a release archive: everything
# needed to run the dashboard on a machine that has neither Node nor npm.
#
#   scripts/release-archive.sh <version> [output-dir]
#
# Run `npm run bundle` first. Writes
# <output-dir>/homeserver-dashboard-v<version>-linux-amd64.tar.gz (by default
# under .next/release), which unpacks to one directory with a
# `homeserver-dashboard` launcher in it.
#
# Only linux-amd64 for now, on purpose, to keep the first release simple. The
# bundle itself is the same on every platform (JavaScript and one WebAssembly
# file); another architecture needs only its own Node binary and checksum.
set -euo pipefail

# The Node.js the archive ships, pinned by content: the sha256 of its tarball,
# from https://nodejs.org/dist/v<version>/SHASUMS256.txt. Keep it the release
# the Dockerfile's base image uses, so both ways of running the dashboard run
# the same runtime, and change both lines together.
NODE_VERSION="24.22.1"
NODE_SHA256="6c172a9ab6718f7b801fb5a7bd486af2ee5e32758086a04b84fcce2aa77095e6"

version="${1:?usage: release-archive.sh <version> [output-dir]}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
out="${2:-$root/.next/release}"
out="$(mkdir -p "$out" && cd "$out" && pwd)"
bundle="$root/.next/standalone"

[[ -f "$bundle/server.js" && -d "$bundle/public" ]] || { echo "no bundle at $bundle: run 'npm run bundle' first" >&2; exit 1; }

name="homeserver-dashboard-v$version-linux-amd64"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Node's own release, accepted only if it is the file pinned above.
node_name="node-v$NODE_VERSION-linux-x64"
curl --fail --silent --show-error --location --output "$work/$node_name.tar.xz" \
  "https://nodejs.org/dist/v$NODE_VERSION/$node_name.tar.xz"
echo "$NODE_SHA256  $work/$node_name.tar.xz" | sha256sum --check --quiet -

mkdir -p "$work/$name/bin"
cp -r "$bundle/." "$work/$name/"
tar --extract --xz --file "$work/$node_name.tar.xz" --directory "$work" "$node_name/bin/node" "$node_name/LICENSE"
cp "$work/$node_name/bin/node" "$work/$name/bin/node"
cp "$work/$node_name/LICENSE" "$work/$name/bin/NODE-LICENSE"
cp "$root/LICENSE" "$work/$name/LICENSE"

# The launcher: runs the server with the Node shipped beside it, from wherever
# the directory was unpacked. Settings come from the environment. The server
# takes its address from HOSTNAME, which many shells and some systems set to
# the machine's name without being asked, and without one it listens on every
# interface. So the launcher has settings of its own, DASHBOARD_HOST and
# DASHBOARD_PORT, and defaults to loopback whatever HOSTNAME says.
cat > "$work/$name/homeserver-dashboard" <<'LAUNCHER'
#!/bin/sh
# Resolved through symlinks, so a link to the launcher on PATH still finds its files.
dir="$(dirname "$(readlink -f "$0")")"
export HOSTNAME="${DASHBOARD_HOST:-127.0.0.1}"
export PORT="${DASHBOARD_PORT:-8080}"
exec "$dir/bin/node" "$dir/server.js"
LAUNCHER
chmod +x "$work/$name/homeserver-dashboard"

tar --create --gzip --owner=0 --group=0 --file "$out/$name.tar.gz" --directory "$work" "$name"
echo "$out/$name.tar.gz"
