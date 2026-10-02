/**
 * The first import of a generated Server entry (src/build.ts): marks the process as a
 * Server before any application module is evaluated, so `app/args.ts`'s `defineArgs`
 * parses the launch's arguments as it is defined and `cli.get()` works at module level.
 */
import { markServer } from "./args";

markServer(process.env, process.cwd());
