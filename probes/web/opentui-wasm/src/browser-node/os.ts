/** `node:os` in a page: one logical processor, no home or temporary directory. */
export const platform = () => "browser";
export const tmpdir = () => "/tmp";
export const homedir = () => "/";
export const availableParallelism = () => 1;
export const cpus = () => [];
export const EOL = "\n";
export default { platform, tmpdir, homedir, availableParallelism, cpus, EOL };
