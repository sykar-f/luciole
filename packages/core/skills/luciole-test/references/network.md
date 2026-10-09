# Latency and faults in a test

`openClient` passes its options to the Client's transport, the only place that simulates the
network:

- `latencyMs`: a round trip added to every request;
- `network.jitterMs`, `network.chunkDelayMs`: random extra delay, slow streams;
- `network.fault(request)`: `"refuse"`, `"drop"`, `"cut"` or `undefined`, chosen per request.
  `request` is `{ kind: "render" | "action", target }`; an action's target ends with
  `#<function name>`, for example `…/actions/notes.ts#saveNote`;
- `fetch` or `wrapTransport`, for any other answer.

What each fault means for the app is in
`node_modules/@luciole-sh/core/docs/guides/latency-and-faults.md`. For a test, pick it by what
the user must see:

- `refuse`: nothing reaches the Server (`not-sent`). The Client also counts the connection as
  down, so Notes shows "○ Disconnected. Your text is kept here." after 3 s.
- `drop` and `cut`: the Server ran (`unknown`). An app that looks the call up, as Notes does
  for a save, settles it and shows no failure.

Fault only the requests under test, so the page still loads:

```ts
await using server = await startServer(app, { NOTES_DB: ":memory:" });
await using client = await openClient(app, server, {
  network: {
    fault: ({ kind, target }) =>
      kind === "action" && target.endsWith("#saveNote") ? "refuse" : undefined,
  },
});
await client.waitFor("Welcome to Notes");
await client.click("Welcome to Notes");
await client.waitFor("Getting around");
await client.press("e", { ctrl: true });
await client.type("Milk");
expect(await client.waitFor("Your text is kept here.")).toContain("Milk");
```

To change the fault during a test, read a variable from `fault` and set it when the test is
ready. `client.requests.finished` lists the ended requests with their outcome.
