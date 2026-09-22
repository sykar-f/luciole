import { loadNote } from "../../../server/repository";
import { saveNote, getOperation } from "../../../actions/notes";
import { NoteEditor } from "../../../components/NoteEditor";
export default async function Page({ params }: { params: { id: string } }) {
  const note = loadNote(params.id);
  return (
    <box flexDirection="column" gap={1}>
      <text fg="#67d9bc">
        {note.title} · version {note.version}
      </text>
      <NoteEditor
        key={note.id}
        initialNote={note}
        saveAction={saveNote}
        resolveAction={getOperation}
      />
    </box>
  );
}
