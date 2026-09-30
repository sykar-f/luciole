"use client";
import { NoNoteShown } from "../../../components/NoNoteShown";

// A deleted note, or one that never was: the notebook carries on as if none was chosen.
export default function Missing() {
  return <NoNoteShown />;
}
