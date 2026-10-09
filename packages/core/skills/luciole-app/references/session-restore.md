# Session restore

The full rules: `node_modules/@luciole-sh/core/docs/concepts/session-restore.md`.

The Client keeps, per history entry, the text of **named** fields, and gives it back after a
crash (`kill -9`), a rebuild or going back. Keep typed text this way rather than writing a
file or a store of your own.

```tsx
"use client";
import { useState } from "react";
import { Input, useRestoredFields } from "@luciole-sh/core/client";

/** One line of text, kept across a crash until it is sent. */
export function Composer({ send }: { send: (text: string) => Promise<string> }) {
  const [text, setText] = useState("");
  const fields = useRestoredFields("composer");
  const submit = async () => {
    await fields.submit(() => send(text));
    setText("");
  };
  return (
    <box flexDirection="column">
      <Input name="composer/text" value={text} onInput={setText} focused width={40} />
      <text onMouseDown={() => void submit()}>Send</text>
    </box>
  );
}
```

- `name="group/field"` makes a field restorable; leave a password or a PIN unnamed, since the
  text is written to disk unencrypted.
- `<Input>` (one line) reports each keystroke, and the restored text once on mount, through
  `onInput`. `<Textarea>` does it through `onChange`. Keep the field's value in state fed by
  that prop, or the restored text never reaches the screen.
- `useRestoredFields("group").submit(action)` forgets the group's text before the request
  leaves, and keeps it again when the call did not run (`not-sent`, `rejected`) or when
  `{ failed: (result) => … }` says the Server refused it. Without `submit`, sent text comes
  back after a crash.
- `clear()` forgets the group's text on demand.
- A field of your own (an editor) uses `useRestoredField(name, value, onChange)`.
- `useRestoredFocus(names)` and `<ScrollBox name>` keep the focus and the scroll position.
- `setToken` to another account forgets the field text.

## Optional form libraries

When integrating TanStack Form, read
`node_modules/@luciole-sh/core/docs/reference/upstream-libraries.md`, section "TanStack Form",
and `node_modules/@luciole-sh/core/docs/concepts/session-restore.md`, section "Use a form library".
Form is optional. Use its hooks with luciole's named fields and string callbacks; submit
through `useBindings` and validate the submitted values again on the Server.
