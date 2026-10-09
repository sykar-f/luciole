# Leaves the agent material as an older luciole (0.0.9) wrote it, as after a bump that did
# not refresh it. The arm without material has none to age.
set -eu
[ -d .agents/skills ] || exit 0
core=node_modules/@luciole-sh/core/package.json
saved=$(mktemp)
cp "$core" "$saved"
# A new file replaces the link, so a package cache the install may share stays untouched.
sed 's/"version": "[^"]*"/"version": "0.0.9"/' "$saved" > "$core.new"
mv "$core.new" "$core"
node_modules/.bin/luciole skills install --agent agents
mv "$saved" "$core"
