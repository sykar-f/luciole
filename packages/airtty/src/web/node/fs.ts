/**
 * `node:fs` and `node:fs/promises` in a page: there is no filesystem. What OpenTUI reaches
 * at runtime is log and debug output (inert here) and existence checks (nothing exists);
 * anything that would read or create a file says so.
 */
const noFilesystem = (name: string) => () => {
  throw new Error(`${name}: there is no filesystem in the browser runtime`);
};
const inert = () => undefined;
const inertAsync = async () => undefined;

export const existsSync = () => false;
export const writeFileSync = inert;
export const appendFileSync = inert;
export const mkdirSync = inert;
export const rmSync = inert;
export const unlinkSync = inert;
export const readFileSync = noFilesystem("readFileSync");
export const readdirSync = noFilesystem("readdirSync");
export const statSync = noFilesystem("statSync");
export const realpathSync = noFilesystem("realpathSync");
export const renameSync = noFilesystem("renameSync");
export const cpSync = noFilesystem("cpSync");
export const symlinkSync = noFilesystem("symlinkSync");
export const mkdtempSync = noFilesystem("mkdtempSync");
export const createWriteStream = noFilesystem("createWriteStream");

export const promises = {
  readFile: noFilesystem("readFile"),
  readdir: noFilesystem("readdir"),
  stat: noFilesystem("stat"),
  open: noFilesystem("open"),
  rename: noFilesystem("rename"),
  mkdtemp: noFilesystem("mkdtemp"),
  chmod: noFilesystem("chmod"),
  unlink: inertAsync,
  rm: inertAsync,
  writeFile: inertAsync,
  mkdir: inertAsync,
};
export default {
  existsSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  readFileSync,
  readdirSync,
  statSync,
  realpathSync,
  renameSync,
  cpSync,
  symlinkSync,
  mkdtempSync,
  createWriteStream,
  promises,
};
