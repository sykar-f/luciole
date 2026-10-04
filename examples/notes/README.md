# Notes: a personal notebook

Notes lists your notes on the left and opens one on the right, in a Markdown editor. You can search, rename, copy and delete with an Undo.

The notes live in SQLite on the Server, and the Client sees only what Server Functions return. The same example runs as a desktop app and as a web demo. Its `package.json` holds the app's name, identifier and icon.

It exercises:

- Server Components and Server Functions
- cached reads that a save invalidates
- unsaved text restored after a restart
- a save whose outcome the Client can look up again

## How do you run it?

```sh
bunx luciole.sh example notes
```

From a clone of the repository, run this from its root:

```sh
bun install --frozen-lockfile
bun run dev
```

`bun run dev` is `luciole dev --app examples/notes`. No API key and no network are needed. The first start creates `notes.sqlite` in the current directory and fills it with sample notes.

## What can you try?

| Key or click | Effect                                                                    |
| ------------ | ------------------------------------------------------------------------- |
| `↑` `↓`      | move to the previous or next note, while the list or the search has focus |
| Enter        | open the selected note, then edit the open note                           |
| Ctrl+E       | start or stop editing                                                     |
| Ctrl+S       | save, or retry after a failure                                            |
| Esc          | stop editing, close a menu                                                |
| Ctrl+N       | create a note                                                             |
| Ctrl+F       | search                                                                    |
| Ctrl+L       | show or fold the list                                                     |
| Ctrl+R       | refresh                                                                   |
| Right click  | open a note's menu: open, rename, copy as Markdown, delete                |
| Ctrl+C       | quit                                                                      |

Delete a note, then click Undo in the message that appears. Set `NOTES_AUTOSAVE_MS=0`, type, and the status line shows "● Unsaved" until you press Ctrl+S. Set `NOTES_DELAY_MS=5000` and the status line says "Still saving…" after 3 seconds, while you keep typing.

## How is it built?

Open these first:

- `app/layout.tsx`: the window, with the list on the left and the shortcuts above.
- `app/notes/[id]/page.tsx`: the Server page of one note. It reads the note and hands it to the editor.
- `components/NoteEditor.tsx`: the editor, with autosave and the restored unsaved text.
- `components/draft.ts`: the unsaved text of each note, and what happens when a save fails or conflicts.
- `actions/notes.ts`: the Server Functions that save, create, rename, delete and restore.
- `server/repository.ts`: the SQLite code, run only by the Server.

## Which environment variables does it read?

| Variable             | Default        | Effect                                                                 |
| -------------------- | -------------- | ---------------------------------------------------------------------- |
| `NOTES_DB`           | `notes.sqlite` | SQLite file of the notes, relative to the current directory.           |
| `LUCIOLE_USER`       | `local`        | Owner of the notes. Each user sees only their own.                     |
| `NOTES_AUTOSAVE_MS`  | `1000`         | Delay between the last keystroke and the save. `0` turns autosave off. |
| `NOTES_DELAY_MS`     | `0`            | Delay added to `saveNote` only, to watch a slow save.                  |
| `LUCIOLE_LATENCY_MS` | `0`            | Simulated round trip added to every request.                           |

## What are its limits?

- A note holds at most 20,000 characters.
- The notes have a title and a body. There are no folders and no tags.
- Only one user is signed in at a time, set by `LUCIOLE_USER`.
- Copy as Markdown needs a terminal that supports OSC 52 clipboard writes, or a host that grants the clipboard.

## How do you test it?

```sh
bun run test:web
```

It drives a headless browser. It needs Google Chrome (`CHROME=` sets another path) and the web runtime, built with Zig 0.16.0 (`ZIG=` sets the path).
