/** `node:fs/promises` in a page: see fs.ts. */
import { promises } from "./fs";

export const {
  readFile,
  readdir,
  stat,
  lstat,
  realpath,
  readlink,
  access,
  open,
  rename,
  mkdtemp,
  chmod,
  copyFile,
  link,
  unlink,
  rm,
  writeFile,
  mkdir,
} = promises;
/** Only a type in OpenTUI's sources. */
export class FileHandle {}
export default promises;
