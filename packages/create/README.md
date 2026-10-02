# @luciole-sh/create

Scaffolds a [luciole](https://luciole.sh) starter application: the Notes example, with its tooling
(type-check, lint, format) configured.

```sh
bunx @luciole-sh/create my-app
npm init @luciole-sh my-app
bun create @luciole-sh my-app
```

then, in `my-app`:

```sh
bun install
bun run dev
```

`luciole init my-app` (and `bunx luciole.sh init my-app`) runs this package at the version of the
framework that is installed. Bun only.

The template is staged from `examples/notes` when the package is packed (`prepack`, see
`scripts/stage.ts`): every version is resolved, and the tooling configuration is inlined. Nothing
is read from a repository when you run it.
