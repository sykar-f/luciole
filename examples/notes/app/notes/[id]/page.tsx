import { getSession, notFound } from "luciole/server";
import { z } from "zod";
import { noteOf } from "../../../server/queries";
import { saveNote, getOperation } from "../../../actions/notes";
import { NoteEditor } from "../../../components/NoteEditor";

/** How long after the last keystroke a note saves itself; 0 leaves saving to the user. */
const AUTOSAVE_MS = 1000;
const autosaveMs = z.coerce
  .number()
  .int()
  .nonnegative()
  .default(AUTOSAVE_MS)
  .parse(process.env.NOTES_AUTOSAVE_MS);

export default async function Page({ params }: { params: { id: string } }) {
  const note = await noteOf(getSession().userId, params.id);
  if (!note) notFound("Note");
  return (
    <NoteEditor
      key={note.id}
      initialNote={note}
      saveAction={saveNote}
      resolveAction={getOperation}
      autosaveMs={autosaveMs}
    />
  );
}
