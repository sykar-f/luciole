/** @jsxImportSource @opentui/react */
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import type { InputProps, ScrollBoxProps, TextareaProps } from "@opentui/react";
import type { Place } from "./restore";
import { Runtime } from "./runtime-context";
import { TransportError } from "./transport";

// A scroll box's content arrives after it mounts (a list the page loads, a live feed):
// its kept position is applied again this often, for this long, until it can be reached.
const SCROLL_RETRY_MS = 50;
const SCROLL_RESTORE_MS = 1500;

/** The Application's restoration and the entry shown when the caller mounted. */
function usePlace(outside: string) {
  const app = useContext(Runtime);
  if (!app) throw new Error(outside);
  const [place] = useState(() => app.restoration.place(app.history));
  return { restoration: app.restoration, place };
}

/**
 * The entry a named field belongs to: the one shown when it mounted. A field of a
 * persistent layout therefore keeps writing to the entry it first appeared in.
 */
function useNamed(name: string | undefined) {
  const app = useContext(Runtime);
  if (name !== undefined && !app) throw new Error(`Field "${name}" is outside the terminal shell`);
  const [place] = useState<Place | undefined>(() =>
    app && name !== undefined ? app.restoration.place(app.history) : undefined,
  );
  return app && place && name !== undefined
    ? {
        kept: () => app.restoration.get(place, name),
        save: (value: string, typed: boolean) =>
          app.restoration.save(place, name, value, { typed }),
      }
    : undefined;
}

/**
 * Restores a named field once, then follows it: typing saves the text; a value set by
 * the application only updates text already kept (a reset forgets it). `shown` starts at
 * the mounted value, so mounting itself never counts as a change.
 */
function useRestoredValue(
  name: string | undefined,
  value: string,
  update: ((value: string) => void) | undefined,
) {
  const named = useNamed(name);
  const typed = useRef<string | undefined>(undefined);
  const shown = useRef(value);
  const latest = useRef({ named, update, value });
  useLayoutEffect(() => {
    latest.current = { named, update, value };
  });
  useEffect(() => {
    const { named, update, value } = latest.current;
    const kept = named?.kept();
    if (kept === undefined || kept === value) return;
    // Restored text is unsaved work: it goes through the same path as typing.
    typed.current = kept;
    update?.(kept);
  }, []);
  useEffect(() => {
    if (value === shown.current) return;
    shown.current = value;
    if (value !== typed.current) latest.current.named?.save(value, false);
  }, [value]);
  return (text: string) => {
    typed.current = text;
    named?.save(text, true);
  };
}

export type FieldInputProps = Omit<InputProps, "value" | "onInput"> & {
  /**
   * Keeps the typed text for this history entry: it comes back after going back to
   * the entry, a crash or a development rebuild. `group/field` joins a group
   * (`useRestoredFields`). Unnamed, the field is OpenTUI's `<input>` as is.
   */
  name?: string;
  value: string;
  /** Every change typed, and the restored text once when the field mounts. */
  onInput?: (value: string) => void;
};
/** OpenTUI's single-line `<input>`, controlled, with an optional restorable `name`. */
export function Input({ name, value, onInput, ...props }: FieldInputProps) {
  const typed = useRestoredValue(name, value, onInput);
  return (
    <input
      {...props}
      value={value}
      onInput={(text: string) => {
        typed(text);
        onInput?.(text);
      }}
    />
  );
}

export type FieldTextareaProps = Omit<TextareaProps, "initialValue" | "onContentChange" | "ref"> & {
  /** As for `Input`: restorable per history entry, `group/field` joins a group. */
  name?: string;
  value: string;
  /** Every change typed, and the restored text once when the field mounts. */
  onChange?: (value: string) => void;
  ref?: Ref<TextareaRenderable>;
};
/**
 * OpenTUI's `<textarea>` made controlled: `value` in, `onChange` out, like the
 * single-line input. A value set from outside (a reset, a restored text) replaces the
 * content and puts the cursor at its end.
 */
export function Textarea({ name, value, onChange, ref, ...props }: FieldTextareaProps) {
  const field = useRef<TextareaRenderable | null>(null);
  const current = useRef(value);
  const typed = useRestoredValue(name, value, onChange);
  useLayoutEffect(() => {
    current.current = value;
    const node = field.current;
    if (!node || node.plainText === value) return;
    node.setText(value);
    node.cursorOffset = value.length;
  }, [value]);
  const attach = (node: TextareaRenderable | null) => {
    field.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };
  return (
    <textarea
      {...props}
      ref={attach}
      initialValue={value}
      onContentChange={() => {
        const text = field.current?.plainText;
        // A content change we caused by setting `value` is not an edit.
        if (text === undefined || text === current.current) return;
        current.current = text;
        typed(text);
        onChange?.(text);
      }}
    />
  );
}

export type RestoredFields = {
  /**
   * Sends the group: its kept text is forgotten before `action` runs, so a crash
   * during the request never offers it again (no double send). If the request provably
   * did not run (`not-sent`, `rejected`), or `failed(result)` says the Server refused
   * it, the text is kept again, unless the user typed newer text meanwhile.
   */
  submit<T>(action: () => Promise<T>, options?: { failed?: (result: T) => boolean }): Promise<T>;
  /** Forgets the group's kept text (an explicit discard). The fields keep their value. */
  clear(): void;
};
/**
 * The named fields `group/…` of the current history entry, as one form. Validation and
 * submission stay with the application or its form library (TanStack Form, …).
 */
export function useRestoredFields(group: string): RestoredFields {
  const { restoration, place } = usePlace(`Fields "${group}" are outside the terminal shell`);
  return useMemo(
    () => ({
      async submit<T>(action: () => Promise<T>, options: { failed?: (result: T) => boolean } = {}) {
        const taken = restoration.take(place, group);
        try {
          const result = await action();
          if (options.failed?.(result)) restoration.restore(place, taken);
          return result;
        } catch (e) {
          if (e instanceof TransportError && e.outcome !== "unknown")
            restoration.restore(place, taken);
          throw e;
        }
      },
      clear: () => void restoration.take(place, group),
    }),
    [restoration, place, group],
  );
}

/**
 * Which of `names` has the focus, kept per history entry like the fields' text: the
 * first one until the user moves it, the one they left it on after going back, a crash
 * or a rebuild. The application still decides the focus (`focused={focus === name}`);
 * this is its state, restored. A kept name no longer among `names` gives the first one.
 */
export function useRestoredFocus<const N extends string>(
  names: readonly [N, ...N[]],
): [focus: N, setFocus: (next: N | ((current: N) => N)) => void] {
  const { restoration, place } = usePlace(
    `The focus of "${names[0]}" is outside the terminal shell`,
  );
  const [focus, set] = useState<N>(() => {
    const kept = restoration.focused(place);
    return names.find((name) => name === kept) ?? names[0];
  });
  const current = useRef(focus);
  const setFocus = useCallback(
    (next: N | ((current: N) => N)) => {
      const name = typeof next === "function" ? next(current.current) : next;
      current.current = name;
      set(name);
      restoration.focus(place, name);
    },
    [restoration, place],
  );
  return [focus, setFocus];
}

export type FieldScrollBoxProps = ScrollBoxProps & {
  /**
   * Keeps how far the box is scrolled for this history entry: it comes back after
   * going back to the entry, a crash or a development rebuild. Unnamed, the box is
   * OpenTUI's `<scrollbox>` as is.
   */
  name?: string;
};
/**
 * OpenTUI's `<scrollbox>`, with an optional restorable `name`. The kept position is
 * applied as soon as the content is tall enough, for a moment after mounting (content
 * that loads later); scrolling by the user in the meantime wins.
 */
export function ScrollBox({ name, ref, ...props }: FieldScrollBoxProps) {
  const app = useContext(Runtime);
  if (name !== undefined && !app)
    throw new Error(`Scroll box "${name}" is outside the terminal shell`);
  const [place] = useState(() =>
    app && name !== undefined ? app.restoration.place(app.history) : undefined,
  );
  const box = useRef<ScrollBoxRenderable | null>(null);
  useLayoutEffect(() => {
    const node = box.current;
    if (!app || !place || name === undefined || !node) return;
    const { restoration } = app;
    const target = restoration.scrolled(place, name) ?? 0;
    let restoring = target > 0;
    let applying = false;
    const apply = () => {
      applying = true;
      node.scrollTop = target;
      applying = false;
      if (node.scrollTop === target) restoring = false;
    };
    // Every change of position, the user's or a shorter content's; not the restore's own.
    const changed = () => {
      if (applying) return;
      restoring = false;
      restoration.scroll(place, name, node.scrollTop);
    };
    node.verticalScrollBar.on("change", changed);
    if (restoring) apply();
    const started = Date.now();
    const timer = restoring
      ? setInterval(() => {
          if (restoring && Date.now() - started < SCROLL_RESTORE_MS) apply();
          else clearInterval(timer);
        }, SCROLL_RETRY_MS)
      : undefined;
    return () => {
      clearInterval(timer);
      node.verticalScrollBar.off("change", changed);
    };
  }, [app, place, name]);
  const attach = (node: ScrollBoxRenderable | null) => {
    box.current = node;
    if (typeof ref === "function") ref(node);
    else if (ref) ref.current = node;
  };
  return <scrollbox {...props} ref={attach} />;
}
