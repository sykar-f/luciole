# Contributing to luciole

Thanks for your interest. luciole is experimental: APIs change without notice, so
please open an issue to discuss a larger change before writing it.

## Setup

You need [Bun](https://bun.sh) 1.4.2 (the version pinned in `package.json`).

```sh
git clone https://github.com/sykar-f/luciole.git
cd luciole
bun install --frozen-lockfile
```

The website (`website/`) has its own dependencies:

```sh
(cd website && bun install --frozen-lockfile)
```

Run an example from the monorepo root, for instance `bun run forge`. The
[README](README.md) lists them all.

## Checks

Before opening a pull request, run:

```sh
bun run verify    # types, lint, format, tests and build
```

It chains `bun run check`, `bun run lint`, `bun run format:check`, `bun test` and
`bun run build`. While iterating, run only the tests your change affects with
`bun run test <paths>`. Format with `bun run format`.

## Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <subject>

<body>
```

- Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `revert`.
- Subject: 50 characters ideally, 72 at most.
- The body, wrapped at 72, explains why, not what. A fix states the symptom, the
  root cause and why the fix works. A feature states the need.
- Keep each commit atomic: features, fixes and refactors go in separate commits.

## Security

To report a vulnerability, follow [SECURITY.md](SECURITY.md) instead of opening an
issue.
