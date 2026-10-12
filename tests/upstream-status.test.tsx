/** @jsxImportSource @opentui/react */
import { expect, test } from "bun:test";
import { act, StrictMode, useEffect, useState } from "react";
import { createRootRoute } from "@tanstack/react-router";
import { testRender } from "@opentui/react/test-utils";
import {
  Application,
  Shell,
  UpstreamStatusProvider,
  usePublishUpstreamStatus,
  useUpstreamStatuses,
  type UpstreamStatus,
} from "../packages/core/src/client";
import { StatusLine, WindowStatusProvider } from "../examples/notes/components/StatusLine";
import { PaletteProvider } from "../examples/notes/components/theme";
import { destroy, untilFrame } from "./helpers";

function Publisher({ status }: { status: UpstreamStatus | null }) {
  usePublishUpstreamStatus(status);
  return null;
}
function Probe({ id }: { id: string }) {
  const statuses = useUpstreamStatuses();
  return (
    <text>
      {id}: {JSON.stringify(statuses)}
    </text>
  );
}

test("a component publishes an upstream down beside Connected, updates and withdraws", async () => {
  let change: (status: UpstreamStatus | null) => void = () => {};
  let mount: (shown: boolean) => void = () => {};
  function Screen() {
    const [status, setStatus] = useState<UpstreamStatus | null>({
      label: "Supervisor",
      state: "down",
      detail: "refused",
    });
    const [shown, setShown] = useState(true);
    useEffect(() => {
      change = setStatus;
      mount = setShown;
    }, []);
    return (
      <StrictMode>
        <PaletteProvider>
          <UpstreamStatusProvider>
            <WindowStatusProvider>
              {shown ? <Publisher status={status} /> : null}
              <StatusLine id="status" page={null} />
              <Probe id="app" />
            </WindowStatusProvider>
          </UpstreamStatusProvider>
        </PaletteProvider>
      </StrictMode>
    );
  }
  const app = new Application({
    url: "http://127.0.0.1:1",
    buildId: "upstream-test",
    resolveModule: () => ({}),
    routeTree: createRootRoute({ component: Screen }),
  });
  app.status = "Connected";
  await app.router.load();
  const ui = await testRender(<Shell app={app} />, { width: 110, height: 8 });
  try {
    await untilFrame(ui, "Connected · Supervisor: down (refused)");
    expect(ui.captureCharFrame()).toContain(
      'app: [{"label":"Supervisor","state":"down","detail":"refused"}]',
    );
    expect(app.status).toBe("Connected");
    await act(async () => change({ label: "Supervisor", state: "degraded" }));
    await untilFrame(ui, "Supervisor: degraded");
    expect(ui.captureCharFrame()).not.toContain("refused");
    await act(async () => change(null));
    await untilFrame(ui, "app: []");
    expect(ui.captureCharFrame()).not.toContain("Supervisor:");
    await act(async () => change({ label: "Supervisor", state: "ok" }));
    await untilFrame(ui, "Supervisor: ok");
    await act(async () => mount(false));
    await untilFrame(ui, "app: []");
    expect(ui.captureCharFrame()).not.toContain("Supervisor:");
  } finally {
    await destroy(ui);
    app.dispose();
  }
});

test("providers isolate apps and one publisher leaving preserves the others", async () => {
  let hide: () => void = () => {};
  function Screen() {
    const [shown, setShown] = useState(true);
    useEffect(() => {
      hide = () => setShown(false);
    }, []);
    return (
      <box flexDirection="column">
        <UpstreamStatusProvider>
          {shown ? <Publisher status={{ label: "A", state: "down" }} /> : null}
          <Publisher status={{ label: "B", state: "unknown" }} />
          <Probe id="first" />
        </UpstreamStatusProvider>
        <UpstreamStatusProvider>
          <Publisher status={{ label: "A", state: "ok" }} />
          <Probe id="second" />
        </UpstreamStatusProvider>
      </box>
    );
  }
  const ui = await testRender(<Screen />, { width: 120, height: 8 });
  try {
    await untilFrame(ui, 'first: [{"label":"A","state":"down"},{"label":"B","state":"unknown"}]');
    expect(ui.captureCharFrame()).toContain('second: [{"label":"A","state":"ok"}]');
    await act(async () => hide());
    await untilFrame(ui, 'first: [{"label":"B","state":"unknown"}]');
    expect(ui.captureCharFrame()).toContain('second: [{"label":"A","state":"ok"}]');
  } finally {
    await destroy(ui);
  }
});
