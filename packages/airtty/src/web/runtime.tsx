/**
 * The web runtime's page (docs/WEB.md, § 3): the Client for the application its Server
 * serves on this origin. Built once per runtime ABI key (build.ts), served by the Server
 * under `/_airtty/web/` (routes.ts). What fails before the terminal exists is written into
 * the page instead.
 */
import "./setup";
import { applicationOf, loadAppBundle } from "./platform/app-bundle";
import { runInPage } from "./platform/run";
import { messageOf } from "../guards";

const element = document.getElementById("airtty");
if (!element) throw new Error("The page has no #airtty element to run in");
const server = new URL("/", location.href);
try {
  const bundle = await loadAppBundle(server);
  document.title = bundle.manifest.name;
  await runInPage((options) => applicationOf(bundle, options), {
    element,
    server,
    name: bundle.manifest.name,
  });
} catch (error) {
  element.textContent = messageOf(error);
  element.classList.add("failed");
  throw error;
}
