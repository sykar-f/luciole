# Testing a restart

`client.app.restoration.snapshot()` is the restored session a restart would reopen; passing
it as `session` to a new Client restores it. The second Client needs a `tag` of its own, or it
shares the first one's Drafts and shows the typed text whether restore works or not.
`node_modules/@luciole-sh/core/docs/concepts/session-restore.md` says what a session keeps.

```ts
await using server = await startServer(app, { NOTES_DB: ":memory:", NOTES_AUTOSAVE_MS: "0" });
let session;
{
  await using before = await openClient(app, server, { tag: "before-restart" });
  await before.waitFor("Welcome to Notes");
  await before.click("Welcome to Notes");
  await before.waitFor("Getting around");
  await before.press("e", { ctrl: true });
  await before.type("Milk");
  await before.waitFor("● Unsaved");
  session = before.app.restoration.snapshot();
} // The first Client stops here, as a crash would end it.
await using after = await openClient(app, server, { session, tag: "after-restart" });
expect(await after.waitFor("Milk")).toContain("● Unsaved");
```

The Server keeps running across the restart: a restart of the Client alone is what the
restored session covers.
