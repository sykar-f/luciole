// The scenario on this probe's AsyncLocalStorage, posted to the page (in a Worker).
import { install } from "./async-context";
import { scenario } from "./scenario";

install();
postMessage(await scenario());
