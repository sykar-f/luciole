# Pins the renderer packages below the range the installed @luciole-sh/core asks for, as after
# a core bump that left the app's own pins behind: core then installs a nested copy of its own.
set -eu
sed -E 's/("@opentui\/(core|keymap|react)": )"[^"]*"/\1"0.5.11"/' package.json > package.json.new
mv package.json.new package.json
bun install
