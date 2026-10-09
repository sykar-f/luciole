---
name: luciole-ship
description: Ships a luciole app — compiled binaries, macOS signing and notarization, a hosted Server, the web target and npm packages with luciole pack.
disable-model-invocation: true
---

# Ship a luciole app

Every shipping artefact comes from `luciole build` (run from the app's directory, or with
`--app <dir>`), never from `bun build --compile` or a hand-made bundle: only luciole's build
embeds the build ID, the Server entry, OpenTUI's native library and the identity that
`--version`, `luciole install` and the Server's build check read.

The installed version's docs are the reference. Read the page for the case at hand:

- a binary for someone, a target, an update or a rollback:
  `node_modules/@luciole-sh/core/docs/guides/ship-a-binary.md`
- a Server that Clients on other machines join over HTTPS:
  `node_modules/@luciole-sh/core/docs/guides/host-a-server.md`
- every `luciole build` option, signing, `--on`, npm packages:
  `node_modules/@luciole-sh/core/docs/reference/build-and-distribution.md`
- a browser (`--web`, `--web-local`): "Open an app in a browser" in
  `node_modules/@luciole-sh/core/docs/guides/opening-an-app.md`

## Pick the build from who receives it

| Who receives it                                       | Build                                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| users who join a Server you host                      | `luciole build --compile --client-only` (no Server code inside)                           |
| someone who runs the whole app on a machine of theirs | `luciole build --compile` (Client and Server, business code readable)                     |
| the machine that hosts the Server                     | `luciole build --compile --target <its target>`, run as `<name> serve --http 127.0.0.1:N` |
| `luciole install <npm name>` users                    | `luciole build --compile --name <app>` per target, then `luciole pack`                    |
| a browser tab                                         | `luciole build --web` (served by your Server) or `--web-local` (static site)              |

Pass `--name <app>`: the default name is the directory's, and it names the binary, the
`serve` command in a unit and the installed app.

## Put the binary where the next build cannot remove it

`--compile` writes `.luciole/bin/<os>-<arch>/<name>` (`--client-only`:
`.luciole/client/<name>-<os>-<arch>`). The next `luciole build` without `--compile`, which
`bun run verify` and `luciole dev` run, deletes it once the sources changed. Write the
deliverable outside `.luciole/` directly:

```sh
luciole build --compile --client-only --name notes --outfile dist/notes
```

Copy `native/` with the binary when the build writes one beside it (apps with native Server
packages such as sharp); it must stay next to the binary.

## Another platform needs its native packages

A `--target` other than this machine's fails without `--native-dir`, `--client-only`
included, because `bun install` installed only this machine's OpenTUI library. Install the
target's packages from the app's lockfile in a directory of their own first, once per target
system:

```sh
native=$(mktemp -d) && cp package.json bun.lock "$native/"
(cd "$native" && bun install --frozen-lockfile --os=linux --cpu=x64)
bunx luciole build --compile --client-only --name notes --target bun-linux-x64 \
  --native-dir "$native" --outfile dist/notes-linux-x64
```

In a shell script, call `bunx luciole`: `luciole` is on the `PATH` only inside `bun run`.
When that `bun install` fails in your own sandbox (`EPERM` on its tempdir, no network), the
script is not at fault: keep it, and give the user the command to run it.

`uname -sm` on the receiving machine picks the target: `Linux x86_64` → `bun-linux-x64`,
`Linux aarch64` → `bun-linux-arm64`, add `-musl` on Alpine, `Darwin arm64` →
`bun-darwin-arm64`, `Darwin x86_64` → `bun-darwin-x64`.

## Host a Server

The Server's machine runs the full binary's own Server; it needs neither Bun nor the sources.
The unit's essentials (the guide has the whole unit, the release layout and the update):

```ini
[Service]
User=notes
WorkingDirectory=/var/lib/notes
EnvironmentFile=/etc/notes/env
ExecStart=/opt/notes/current/notes serve --http 127.0.0.1:3000
Restart=on-failure
```

- `/etc/notes/env` holds `LUCIOLE_TOKEN=…` (or the app has `server/auth.ts`). Behind a proxy
  the Server sees loopback only, so without a token anyone who reaches the proxy is the user.
- A TLS proxy in front: Caddy's `reverse_proxy 127.0.0.1:3000`. Another proxy must stream
  responses unbuffered, keep quiet responses open, and forward `Authorization` and
  `x-luciole-build`.
- App options go after `--`: `notes serve --http 127.0.0.1:3000 -- --mode read`.
- Clients join with `LUCIOLE_TOKEN=<token> ./notes-darwin-arm64 --url https://notes.example.com`.
  The Client also reads `LUCIOLE_URL`, then `~/.config/luciole/<name>.json` (`{ "url": … }`):
  hand over the binary itself, not a launcher script that wraps it.
- A Server answers `409 Incompatible build` to a Client of another build: build the Server and
  every Client from the same commit, and switch them together on update and rollback.

## Publish to npm

```sh
bunx luciole build --compile --name notes                   # this machine's target
bunx luciole build --compile --name notes --target bun-linux-x64 --native-dir "$native"
bunx luciole pack --package @ada/notes --version 1.2.0 .luciole/bin/*/notes
```

Pass every platform's binary to **one** `luciole pack`: each call rewrites the main package
`npm/<scope>__<name>/` with only the binaries it was given. It also writes
`npm/<scope>__<name>-<os>-<arch>/` per platform, and prints the `npm publish` order, platforms
first. The binaries must come from one build: build them all before the next source change.
Users then run `luciole install @ada/notes` and `luciole update notes`.

## The web target

`--web` and `--web-local` need the network, `git` and Zig 0.16.0 on the first build of a
framework version (`luciole web-runtime` prepares it). A `--web` Server serves the page only
to the origin in `LUCIOLE_WEB_ORIGIN`. `--web-local` is a static site whose Server code cannot
spawn processes or write files: such an app keeps `--web`.

## Steps that are the user's

You prepare and print these; the user runs them. Never invent an identity, a profile, a token
or a host, and never run them yourself:

- macOS signing and notarization (from macOS, for macOS targets):
  `xcrun notarytool store-credentials <profile> --apple-id … --team-id … --password …` once,
  then `luciole build --compile --sign "Developer ID Application: <Name> (<TEAMID>)" --notarize <profile>`.
  `--sign -` signs ad hoc, which needs nothing from the user, to test the signature locally.
- `npm publish <dir>` for each directory `luciole pack` printed, in its order.
- Everything on the Server's machine: copying the release (`rsync -a .luciole/bin/linux-x64/ host:/opt/notes/releases/1.2.0/`),
  creating the user and the token file (`echo "LUCIOLE_TOKEN=$(openssl rand -hex 32)" > /etc/notes/env`),
  `systemctl enable --now notes`, the DNS name, `systemctl reload caddy`.
- `notes --on <host>`, which opens an ssh connection.

## Gotchas

- Hand users who connect to your Server a `--client-only` binary: the full binary holds the
  Server bundle, business code and SQL included, readable by whoever gets the file.
- `--client-only --version` opens the app instead of printing an identity: only the full
  binary prints `{"name","buildId","target","identity"}`. Check a full binary with
  `./notes --version`.
- `--name`, `--target`, `--outfile`, `--sign` and the other binary options are refused
  without `--compile`.
- `--compile` embeds the official Bun of the target, downloaded once into
  `$XDG_CACHE_HOME/luciole/runtime/`; offline without that cache it fails.
  `luciole runtime --target <t>` fills it ahead of time. `--runtime host` works only for this machine's target,
  and `--portable` makes a non-portable Bun (Nix, Homebrew) an error.
- A binary downloaded through a browser is blocked by Gatekeeper until signed with a
  Developer ID and notarized; one copied with `scp` or `curl` runs with the ad hoc signature.
- `.luciole/client` and `.luciole/server` are not a delivery format: ship a binary, or the
  app's source for `luciole git+…`.
