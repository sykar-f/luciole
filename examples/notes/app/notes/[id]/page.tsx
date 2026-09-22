import { NotePageFrame } from "../../../components/NoteFrame";
import { loadNote } from "../../../server/repository";
import { saveNote, getOperation } from "../../../actions/notes";
import { NoteEditor } from "../../../components/NoteEditor";
export default async function Page({ params }: { params: { id: string } }) {
  const note = loadNote(params.id);
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
