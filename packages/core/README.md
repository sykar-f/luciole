# @luciole-sh/core

The luciole framework: React Server Components rendered in your terminal, with the same
components available on the web.

This package publishes TypeScript sources and relies on Bun APIs (`Bun.Terminal`,
`Bun.serve`, `Bun.build`, `bun:sqlite`…): it runs on **Bun only**.

## Requirements

- [Bun](https://bun.sh) 1.4.2 or later
- `react` and `react-dom` 19.3 or later, installed by your application (they are peer
  dependencies, so that the framework and your components share one copy)

## Usage

```sh
luciole init my-app    # scaffold a starter application in ./my-app
luciole dev --app my-app   # run it with live reload
luciole build --app my-app # produce a build (see `luciole build --compile` for a binary)
```

`luciole init` runs [`@luciole-sh/create`](https://www.npmjs.com/package/@luciole-sh/create) at
this package's version, which writes the starter (the Notes example, with its tooling configured);
`bunx @luciole-sh/create my-app` does the same without installing the framework first.

`luciole` and `luciolex` are the two executables this package installs.

See the [root README](../../README.md) for the project overview, and
[luciole.sh](https://luciole.sh) for the website.

## License

[MIT](./LICENSE)
