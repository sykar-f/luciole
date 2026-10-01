/**
 * Just enough of a source map (v3) to name where a position of a bundle came from: the
 * scroll bench attributes the CPU time of a minified runtime to xterm.js, OpenTUI, React
 * or luciole. Lines and columns are 0-based, as the DevTools protocol gives them.
 */
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const DIGIT: Record<string, number> = Object.fromEntries(
  Array.from({ length: BASE64.length }, (_, i) => [BASE64.charAt(i), i]),
);
const VLQ_SHIFT = 5;
const VLQ_CONTINUE = 32;
const VLQ_MASK = 31;

/** The values of one segment, each relative to the previous segment's. */
function decodeSegment(text: string) {
  const values: number[] = [];
  let value = 0;
  let shift = 0;
  for (const char of text) {
    const digit = DIGIT[char] ?? 0;
    value += (digit & VLQ_MASK) << shift;
    if (digit & VLQ_CONTINUE) shift += VLQ_SHIFT;
    else {
      values.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return values;
}

type Segment = { column: number; source: number };

export type SourceMap = { sourceAt(line: number, column: number): string | undefined };

export function parseSourceMap(json: { sources: string[]; mappings: string }): SourceMap {
  const lines: Segment[][] = [];
  let source = 0;
  for (const line of json.mappings.split(";")) {
    const segments: Segment[] = [];
    let column = 0;
    for (const text of line.split(",")) {
      if (!text) continue;
      const [dColumn = 0, dSource] = decodeSegment(text);
      column += dColumn;
      if (dSource !== undefined) source += dSource;
      segments.push({ column, source });
    }
    lines.push(segments);
  }
  return {
    sourceAt(line, column) {
      const segments = lines[line];
      if (!segments?.length) return undefined;
      // The last segment starting at or before the column.
      let low = 0;
      let high = segments.length - 1;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if ((segments[middle]?.column ?? 0) <= column) low = middle;
        else high = middle - 1;
      }
      const found = segments[low];
      return found ? json.sources[found.source] : undefined;
    },
  };
}
