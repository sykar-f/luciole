# Files — a file explorer

Files browses a directory tree in your terminal, with a filter, a details pane and a preview
of the selected entry. The Server reads the file system, and the Client only receives paths
below the root.

It exercises these luciole features:

- each directory is a navigation, with `loading.tsx` and `not-found.tsx`
- the preview is a Server Function, cancelled when the selection moves
- images arrive as small thumbnails, drawn with kitty graphics or half blocks
- a file dropped on your terminal lands in the directory on screen

```text
 luciole › tests
 /home/ada/src/luciole/tests · 142 entries

 / filter type to narrow this directory                                                             142/142 shown · dotfiles none · by name

 ┌─ tests ───────────────────────────────────────────┐ ┌─ action.test.tsx ────────────────────────────────────────────────────────────────┐
 │≡ action-server.ts                         1.2 KB ▀│ │    1 /** @jsxImportSource @opentui/react */                                    ▀ │
 │≡ action.test.tsx                          3.7 KB  │ │    2 import { test, expect } from "bun:test";                                    │
 │≡ app-bundle.test.ts                       8.5 KB  │ │    3 import { act, useState, useEffect, type ReactNode } from "react";           │
 │≡ app-metadata.test.ts                     3.6 KB  │ │    4 import { InputRenderable } from "@opentui/core";                            │
 │≡ args-build.test.ts                       8.5 KB  │ │    5 import { testRender } from "@opentui/react/test-utils";                     │
 │≡ args.test.ts                             6.9 KB  │ │    6 import { spawn } from "node:child_process";                                 │
 │≡ auth.test.tsx                             16 KB  │ │    7 import { createInterface } from "node:readline";                            │
 │≡ binary.test.ts                            16 KB  │ │    8 import { z } from "zod";                                                    │
 │≡ build-names.test.ts                      6.0 KB  │ │    9 import { decode, encodeReply, registerModules } from "../packages/core/src  │
 │≡ build.test.ts                             24 KB  │ │   10 import { isReactNode } from "../packages/core/src/transport";               │
 │≡ cache-app.test.tsx                       8.2 KB  │ │   11 import { destroy, type TestUI } from "./helpers";                           │
 │≡ cache-build.test.ts                      5.3 KB  │ │   12 // The first line tests/action-server.ts prints.                            │
 │≡ cache-runtime.check.ts                    10 KB  │ │   13 const Started = z.object({ port: z.number().int(), pid: z.number().int() }  │
 │≡ cache-server.test.ts                     4.4 KB  │ │   14 test("milestone 1: Flight action via HTTP, local typing, refresh without r  │
 └───────────────────────────────────────────────────┘ │   15   const child = spawn(process.execPath, ["--conditions=react-server", "tes  │
                                                       │   16     stdio: ["ignore", "pipe", "inherit"],                                   │
 ┌─ details ─────────────────────────────────────────┐ │   17   });                                                                       │
 │ name      action.test.tsx                         │ │   18   const lines = createInterface({ input: child.stdout })[Symbol.asyncItera  │
 │ type      TypeScript JSX                          │ │   19   let rendered: TestUI | undefined;                                         │
 │ size      3.7 KB · 3,743 bytes                    │ │   20   try {                                                                     │
 │ modified  2026-10-04 07:28 · 8 h ago              │ │   21     const first = await lines.next();                                       │
 │ mode      -rw-r--r-- (644)                        │ │   22     if (first.done) throw new Error("The test Server printed nothing");     │
 │                                                   │ │ typescript█·█102 lines                                                           │
 └───────────────────────────────────────────────────┘ └──────────────────────────────────────────────────────────────────────────────────┘

 shift+j scroll · j down · k up · return open · backspace parent · / filter · . hidden · s sort · u back · ? keys · m menu

 ctrl+r refresh
```

## Run it

With Bun 1.4.2 or newer, run it from the release:

```sh
bunx luciole.sh example files
```

From a clone of the repository, at its root:

```sh
bun install --frozen-lockfile    # once
bun run files                    # the root is the current directory
FILES_ROOT=~/Pictures bun run files
LUCIOLE_LATENCY_MS=500 bun run files
```

`bun run files` runs `luciole dev --app examples/files`. The example needs no API key and no
network. The tree of the root appears on the left, and the selected entry on the right.

## Try it

| Key                     | Action                                                        |
| ----------------------- | ------------------------------------------------------------- |
| `j` `k` `↑` `↓`         | Move the selection. `g` and `G` jump to the ends.             |
| `PgUp` `PgDn`           | Move the selection by ten rows.                               |
| `Enter` `→` `l`         | Open a directory. On a file, show the preview full screen.    |
| `Backspace` `←` `h`     | Go to the parent, with the directory you left still selected. |
| `/`                     | Filter the directory. `Enter` keeps the filter, `Esc` clears. |
| `.`                     | Show or hide dotfiles.                                        |
| `s`                     | Sort by name, size or date modified.                          |
| `Shift+J` `Shift+K`     | Scroll the preview.                                           |
| `p`                     | Cycle the image protocol: `auto`, `kitty`, `blocks`.          |
| `m`, or a right-click   | Open the entry's menu: open, copy its name or path, sort.     |
| `u` `~`                 | Go back in the history, or to the root.                       |
| `?`                     | List every active key.                                        |
| `Ctrl+R` `Esc` `Ctrl+C` | Refresh, cancel an opening directory, quit.                   |

Then try these:

- Open a large directory with `LUCIOLE_LATENCY_MS=500`. The loading screen keeps the page's
  layout, and `Esc` cancels.
- Select a photo, press `p`, and compare the kitty and half-block renderings.
- Drag a file from your desktop onto your terminal. It appears greyed out, then lands in the
  directory on screen.

> **Warning.** A drop writes into the root without confirmation, and any Client that
> reaches the Server can drop files. Before you expose the Server, start it with
> `FILES_READ_ONLY=1`.

## How it is built

Open these files first:

| File                      | What it holds                                                                  |
| ------------------------- | ------------------------------------------------------------------------------ |
| `app/page.tsx`            | The Server Component of a directory: `?dir=` is the path below the root.       |
| `app/loading.tsx`         | The loading screen, with the same layout as the page.                          |
| `components/Explorer.tsx` | The list, on the Client: selection, filter, sort, keys, menu and drops.        |
| `components/Preview.tsx`  | The preview pane: text with line numbers, images, hex dumps.                   |
| `actions/files.ts`        | The Server Functions `preview` and `thumbnail`.                                |
| `actions/drop.ts`         | The Server Functions that receive a dropped file.                              |
| `server/fs.ts`            | The reads of the file system, and the check that a path stays inside the root. |
| `server/thumbnails.ts`    | WebP thumbnails made with `sharp`, cached in memory and on disk.               |

The Server resolves each path with `realpath` and refuses any path outside the root. This
covers `..` and symbolic links that point outside. It never reads a FIFO or a device.

A dropped file reaches the Server in one of two ways:

- **Moved:** the Client sends the file's fingerprint. When the Server sees the same file on
  its machine, it moves it.
- **Copied:** otherwise, the Client sends the bytes, 32 MiB at most, and the original stays
  in place.

A name already in the directory is refused, so no drop overwrites a file.

To test the example in a real terminal, at 500 ms of simulated latency, build it, then run
the journey:

```sh
bun packages/core/src/cli.ts build --app examples/files
bun run test:pty:files
```

## Environment variables

| Variable               | Read by | Default               | Effect                                                     |
| ---------------------- | ------- | --------------------- | ---------------------------------------------------------- |
| `FILES_ROOT`           | Server  | the current directory | The root of the explorer.                                  |
| `FILES_READ_ONLY`      | Server  | `0`                   | `1` refuses every drop. Any other value is an error.       |
| `XDG_CACHE_HOME`       | Server  | `~/.cache`            | The thumbnails go in `luciole-files/thumbnails/` below it. |
| `FILES_IMAGE_PROTOCOL` | Client  | `auto`                | The image protocol at launch: `auto`, `kitty` or `blocks`. |
| `LUCIOLE_LATENCY_MS`   | Client  | `0`                   | A simulated round trip, from [luciole's variables][env].   |

[env]: https://luciole.sh/docs/reference/environment/

## Limits

- A directory lists 5000 entries at most, all rendered at once.
- A text preview shows the first 256 KiB, or 4000 lines.
- Syntax colours cover the grammars OpenTUI ships: TypeScript, JavaScript, JSON, Markdown and
  Zig.
- Nothing purges the thumbnail cache on disk. Delete it by hand when it grows.
- `sharp` is a native dependency: the Server's machine needs its
  `@img/sharp-<os>-<arch>` package.
- A drop is the only write. Files does not rename, delete or receive a directory.
- Under tmux, OpenTUI always picks half blocks.
- Behind a multiplexer that answers the kitty query but drops images, the preview stays
  empty. Press `p`, or start with `FILES_IMAGE_PROTOCOL=blocks`.
- Keys typed in the same instant as `/` can arrive before the filter field has the focus.
