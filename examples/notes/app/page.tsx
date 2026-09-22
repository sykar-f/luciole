import { listNotes } from "../server/repository";
import { NoteList } from "../components/NoteList";
export default async function Page() {
  return <NoteList notes={listNotes()} />;
}
