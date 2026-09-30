#!/bin/sh
# smoke.sh <binary> <server-url> — runs the binary from an empty directory with no
# node_modules above it and no Bun on PATH, inside a PTY, then prints the screen text.
set -eu
bin=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
timeout=$(command -v timeout)
run=$(mktemp -d /private/tmp/luciole-compile.XXXXXX)
cp "$bin" "$run/client"
cd "$run"
# 3 s: first frame; Enter opens the selected note; 3 s later Ctrl+C.
(sleep 3; printf '\r'; sleep 3; printf '\003') |
  env -i HOME="$run" TERM=xterm-256color PATH=/usr/bin:/bin \
  "$timeout" 15 /usr/bin/script -q "$run/screen.raw" ./client --url "$2" >/dev/null 2>&1 || echo "exit=$?"
perl -pe 's/\e\[[0-9;?<>=]*[ -\/]*[@-~]//g; s/\e[\]P_][^\a\e]*(\a|\e\\)//g; s/\e[=>()][0-9A-Za-z]?//g' \
  "$run/screen.raw" | tr -s ' \r' ' ' > "$run/screen.txt"
echo "dir=$run"
cat "$run/screen.txt"
echo
