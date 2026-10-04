# Security policy

luciole is experimental (version 0.x) and published on npm. Security reports are
welcome and taken seriously.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through
[GitHub security advisories](https://github.com/sykar-f/luciole/security/advisories/new)
("Report a vulnerability" in the repository's Security tab).

Include what you found, the affected package or example, the steps to reproduce it,
and the version or commit. You will get an acknowledgement, then updates as the fix
progresses. Please give us time to fix the issue before disclosing it.

## Scope

In scope:

- The PTY layer: how the Server and the Client spawn and drive terminals.
- The sandbox used to run generated or untrusted code.
- The dev server (`bun run dev` and the `luciole` CLI's development mode).
- The Server/Client transport and authentication (see
  [docs/BOUNDARIES.md](docs/BOUNDARIES.md)).

Out of scope: vulnerabilities in third-party dependencies (report them upstream),
and the unsigned experimental desktop prototype's missing code signature, which is a
documented limit ([docs/DESKTOP.md](docs/DESKTOP.md)).

## Supported versions

Only the latest published release gets security fixes. Until 1.0, that is the latest
0.x minor release.

| Version | Supported                         |
| ------- | --------------------------------- |
| 0.1.x   | Yes, the first published release  |
| `main`  | Fixes land here first, unreleased |

The five published packages share one version. A fix ships as a patch release of all
five, and is listed in the [CHANGELOG](CHANGELOG.md).
