import { NotePageFrame } from "../../../components/NoteFrame";
import { getSession } from "luciole/server";
import { noteOf } from "../../../server/queries";
import { saveNote, getOperation } from "../../../actions/notes";
import { NoteEditor } from "../../../components/NoteEditor";
export default async function Page({ params }: { params: { id: string } }) {
  const note = await noteOf(getSession().userId, params.id);
  return (
    <NotePageFrame title={`${note.title} · version ${note.version}`}>
      <NoteEditor
        key={note.id}
        initialNote={note}
        saveAction={saveNote}
        resolveAction={getOperation}
      />
    </NotePageFrame>
  );
}
