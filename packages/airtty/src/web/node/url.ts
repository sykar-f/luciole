/** `node:url` in a page: file URLs name nothing that can be read, but they still parse. */
export const fileURLToPath = (url: string | URL) => new URL(url).pathname;
export const pathToFileURL = (path: string) => new URL(`file://${path}`);
const { URL: PageURL } = globalThis;
export { PageURL as URL };
export default { fileURLToPath, pathToFileURL, URL: PageURL };
