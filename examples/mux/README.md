# mux: a local multiplexer

mux puts local programs side by side, each in its own pane on a pseudo-terminal. It is a small tmux built with `<Terminal>` from `@luciole-sh/core/client`. A pane can also hold another luciole app, shown inline with `<Embed>`.

The programs run with your rights and without isolation. This is the `process` mode of [docs/EMBEDDING.md](../../docs/EMBEDDING.md).

## How do you run it?

You need Bun and the programs of the panes installed, such as `$SHELL`, `vim` or `htop`.

```sh
bunx luciole.sh example mux
```

From a clone of the repository, run this from its root:

```sh
bun install --frozen-lockfile
bun run mux
```

`bun run mux` is `luciole dev --app examples/mux`. No API key and no network are needed.

It opens your `$SHELL` and, when `vim` is installed, `vim`. To choose the programs, pass a JSON list of commands:

```sh
MUX_PANES='[["htop"],["vim","README.md"]]' bun run mux
```

## What can you try?

Ctrl+O is the only key mux keeps. Press it, then one of these keys:

| Keys              | Action                         |
| ----------------- | ------------------------------ |
| `Ctrl+O` then `o` | go to the next pane            |
| `Ctrl+O` then `c` | open a new shell               |
| `Ctrl+O` then `v` | open vim, when it is installed |
| `Ctrl+O` then `x` | close the active pane          |
| `Ctrl+O` then `q` | quit                           |
| click             | give the keys to that pane     |

Every other key goes to the active pane, Ctrl+C included. A pane closes when its program exits, and mux quits when the last pane closes.

### Put a luciole app in a pane

Build the app, start its Server, then list it in `MUX_APPS`. This example uses `mdreader`:

```sh
bun packages/core/src/cli.ts build --app examples/mdreader
bun --conditions=react-server examples/mdreader/.luciole/server/index.js &
MUX_APPS='[{"name":"docs","bundle":"examples/mdreader/.luciole/app","url":"http://127.0.0.1:3000"}]' bun run mux
```

The Server of `mdreader` listens on port 3000 unless `PORT` says otherwise. The app pane takes the same keys: Ctrl+O moves between panes, and Ctrl+C inside the app closes its pane.

## How is it built?

Open these first:

- `components/Mux.tsx`: the panes, the Ctrl+O keys and the `MUX_PANES` and `MUX_APPS` parsing.
- `app/layout.tsx`: mounts `<Mux>` as the root layout, so the panes stay alive whatever the page shows.
- `app/page.tsx`: the help line, rendered by the Server.

## Which environment variables does it read?

| Variable    | Default             | Effect                                                                                                  |
| ----------- | ------------------- | ------------------------------------------------------------------------------------------------------- |
| `MUX_PANES` | `$SHELL`, and `vim` | JSON list of commands, one per pane. Each command is a list of strings.                                 |
| `MUX_APPS`  | none                | JSON list of luciole apps. Each has a `name`, the built `bundle` directory and the `url` of its Server. |
| `SHELL`     | `/bin/sh`           | Program of the first pane and of each new shell.                                                        |

## What are its limits?

- Panes have no isolation. A pane's program can do whatever you can.
- An app pane runs inside the multiplexer's process, so it has full trust.
- An app pane needs its Server already running. mux does not start it.
- `MUX_PANES` and `MUX_APPS` must be valid JSON of the shape above. An invalid value throws at startup and does not fall back to the defaults.

## How do you test it?

```sh
bun run test:pty:mux
```

It runs a shell and vim side by side, sends Ctrl+C to the shell, uses the prefix, closes a pane, resizes the window and checks that no program stays behind. Then it runs `mdreader` inline beside a shell.
