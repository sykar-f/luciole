import { getSession } from "luciole/server";
import { notesOf } from "../server/queries";
import { NoteList } from "../components/NoteList";
// Back from a note, the router shows the list it has for 30 s without asking the Server;
// a save invalidates it anyway, through its cache tag.
export const staleTime = 30;
export default async function Page() {
  return <NoteList notes={await notesOf(getSession().userId)} />;
}
