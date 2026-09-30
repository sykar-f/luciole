/**
 * OpenTUI's `DownloadUtils` in the tree-sitter Worker of a page (src/web/opentui/plugin.ts):
 * parsers and highlight queries are files of the web runtime, fetched by URL; the
 * browser's HTTP cache keeps them, so there is no cache directory to write. `filePath` is
 * the URL itself: `Language.load` fetches it again, from that cache.
 */
import { Buffer } from "node:buffer";

export interface DownloadResult {
  content?: Buffer;
  filePath?: string;
  error?: string;
}

async function load(source: string): Promise<DownloadResult> {
  try {
    const response = await fetch(source);
    if (!response.ok) return { error: `Failed to fetch ${source}: ${response.status}` };
    return { content: Buffer.from(await response.arrayBuffer()), filePath: source };
  } catch (error: unknown) {
    return { error: `Error fetching ${source}: ${String(error)}` };
  }
}

export class DownloadUtils {
  static downloadOrLoad(source: string): Promise<DownloadResult> {
    return load(source);
  }

  static downloadToPath(source: string): Promise<DownloadResult> {
    return load(source);
  }

  static async fetchHighlightQueries(sources: string[]): Promise<string> {
    const results = await Promise.all(sources.map(load));
    return results
      .map((result) => (result.content ? new TextDecoder().decode(result.content) : ""))
      .filter((query) => query.trim().length > 0)
      .join("\n");
  }
}
