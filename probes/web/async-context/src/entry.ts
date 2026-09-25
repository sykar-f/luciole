// The scenario on this probe's AsyncLocalStorage, printed as JSON (under Bun).
import { install } from "./async-context";
import { scenario } from "./scenario";

install();
console.log(JSON.stringify(await scenario()));
