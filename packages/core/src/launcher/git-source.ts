/**
 * Git sources as users write them: `github:user/repo[#ref][/dir]`, `gitlab:…`,
 * `https://github.com/user/repo[/tree/ref/dir]`, `git+ssh://…`, `git+https://…`,
 * `git+file://…` (a fragment carries `#ref[/dir]`). Pure: the launcher UI's Server
 * classifies targets with it without loading git or the bundler.
 */
export type GitSource = {
  /** What git fetches from. */
  url: string;
  /** Branch, tag or full commit sha; the remote's HEAD when absent. */
  ref?: string;
  /** The app's directory inside the repository. */
  directory?: string;
};

const HOSTS = { github: "github.com", gitlab: "gitlab.com" } as const;
const HOST_SHORTHAND = /^(github|gitlab):([\w.-]+)\/([\w.-]+?)(?:\.git)?(\/[^#]*)?(?:#(.*))?$/;
const HOST_URL =
  /^https:\/\/(github\.com|gitlab\.com)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(\/[^#]*)?(?:#(.*))?$/;
const GIT_URL = /^git\+(ssh|https|http|file):\/\/|^git:\/\//;

/** `ref[/dir]`, as written after `#`. A branch containing "/" cannot be written so. */
function fragment(text: string | undefined) {
  if (!text) return {};
  const [ref, ...rest] = text.split("/");
  return { ref: ref || undefined, directory: rest.join("/") || undefined };
}
const trimSlashes = (path: string | undefined) => path?.replace(/^\/+|\/+$/g, "") || undefined;

/** The git source `spec` names, or `undefined` when it is not one. */
export function parseGitSource(spec: string): GitSource | undefined {
  const hosted = HOST_SHORTHAND.exec(spec) ?? HOST_URL.exec(spec);
  if (hosted) {
    const [, site = "", owner = "", repo = "", path, hash] = hosted;
    const host = site === "github" ? HOSTS.github : site === "gitlab" ? HOSTS.gitlab : site;
    let directory = trimSlashes(path);
    let ref: string | undefined;
    // What a browser shows: https://github.com/user/repo/tree/<ref>/<dir>.
    const tree = directory && /^(?:-\/)?tree\/([^/]+)(?:\/(.*))?$/.exec(directory);
    if (tree) [, ref, directory] = tree;
    const after = fragment(hash);
    return {
      url: `https://${host}/${owner}/${repo}.git`,
      ref: after.ref ?? ref,
      directory: trimSlashes(after.directory ?? directory),
    };
  }
  if (!GIT_URL.test(spec)) return undefined;
  const [location = "", hash] = spec.replace(/^git\+/, "").split("#", 2);
  // A directory after the repository's `.git`: git+ssh://host/repo.git/apps/notes.
  const inRepo = /^(.*?\.git)(\/.*)?$/.exec(location);
  const after = fragment(hash);
  return {
    url: inRepo?.[1] ?? location,
    ref: after.ref,
    directory: trimSlashes(after.directory ?? inRepo?.[2]),
  };
}

/** How the source reads back to the user. */
export const describeSource = ({ url, ref, directory }: GitSource) =>
  `${url}${ref ? `#${ref}` : ""}${directory ? ` (${directory})` : ""}`;
