/**
 * What `bun run stage` leaves for the build (scripts/stage.ts), in `.stage/`: the app's
 * two-role binary in `bin/`, its built metadata (`metadata.json`, luciole/metadata) and its
 * icon, as a PNG and, on macOS, as an iconset. The bundle keeps `bin/` and the metadata
 * under `luciole/`, next to the views.
 */
import { AppMetadata } from "luciole/metadata";

export const STAGE = ".stage";
/** Where the staged files land in the bundle, relative to `Resources/app`. */
export const BUNDLED = "luciole";
export const METADATA = "metadata.json";
export const ICON_PNG = "icon.png";
export const ICONSET = "icon.iconset";

export const readMetadata = (text: string) => AppMetadata.parse(JSON.parse(text));
