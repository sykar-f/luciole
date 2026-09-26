/**
 * The web runtime's page (docs/WEB.md, § 3): the Client for one application, whose
 * Server is either the one that served this page (on this origin) or, in a static site
 * (`airtty build --web-local`, `#airtty[data-server="worker"]`), a SharedWorker next to it.
 * Built once per runtime ABI key (build.ts). What fails before the terminal exists is
 * written into the page instead.
 */
import "./setup";
import { applicationOf, loadAppBundle } from "./platform/app-bundle";
import { runInPage } from "./platform/run";
import { connectServer } from "./server/page";
import { lookOf, restoreOf, stage } from "./embed";
import { messageOf } from "../guards";

const element = document.getElementById("airtty");
if (!element) throw new Error("The page has no #airtty element to run in");
stage("runtime");
const look = lookOf(location.search);
// The margin around the terminal is the page's: the same colour, or it shows.
if (look.background) document.body.style.background = look.background;
try {
  const inPage = element.dataset.server === "worker";
  const here = new URL("./", location.href);
  const server = inPage ? here : new URL("/", location.href);
  const bundle = await loadAppBundle(server, inPage ? { files: new URL("app/", here) } : {});
  stage("bundle");
  const name = bundle.manifest.name;
  document.title = name;
  const fetch = inPage ? await connectServer(new URL("server-worker.js", here), name) : undefined;
  stage("server");
  await runInPage((options) => applicationOf(bundle, options), {
    element,
    server,
    fetch,
    name,
    restore: restoreOf(location.search),
    ...look,
  });
} catch (error) {
  element.textContent = messageOf(error);
  element.classList.add("failed");
  throw error;
}
