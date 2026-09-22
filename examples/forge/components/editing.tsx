"use client";
import { createContext, useContext, useEffect, type ReactNode } from "react";

// Terminal keyboards have one stream of keys: while a text field is focused, single
// letters are text; otherwise they are commands. The app chrome owns this mode.
type Mode = { editing: boolean; setEditing: (editing: boolean) => void };
const EditingContext = createContext<Mode>({ editing: false, setEditing: () => {} });

export function EditingProvider({ value, children }: { value: Mode; children: ReactNode }) {
  return <EditingContext.Provider value={value}>{children}</EditingContext.Provider>;
}
export function useEditing() {
  return useContext(EditingContext);
}
/** Declares that a field of this component is focused; cleared when it unmounts. */
export function useEditingWhile(active: boolean) {
  const { setEditing } = useEditing();
  useEffect(() => {
    setEditing(active);
    return () => setEditing(false);
  }, [active, setEditing]);
}
