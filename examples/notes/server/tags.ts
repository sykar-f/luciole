import "server-only";

// Cache tags of Notes' reads (server/queries.ts), invalidated by its Server Functions.
// Encoded: a tag is visible ASCII without commas, a user id or a note id may not be.
const part = encodeURIComponent;
export const notesTag = (owner: string) => `notes:${part(owner)}`;
export const noteTag = (owner: string, id: string) => `note:${part(owner)}:${part(id)}`;
