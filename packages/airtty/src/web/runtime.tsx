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
import { messageOf } from "../guards";

const element = document.getElementById("airtty");
if (!element) throw new Error("The page has no #airtty element to run in");
try {
  const inPage = element.dataset.server === "worker";
  const here = new URL("./", location.href);
  const server = inPage ? here : new URL("/", location.href);
  const bundle = await loadAppBundle(server, inPage ? { files: new URL("app/", here) } : {});
  const name = bundle.manifest.name;
  document.title = name;
  const fetch = inPage ? await connectServer(new URL("server-worker.js", here), name) : undefined;
  await runInPage((options) => applicationOf(bundle, options), { element, server, fetch, name });
} catch (error) {
  element.textContent = messageOf(error);
  element.classList.add("failed");
  throw error;
}
