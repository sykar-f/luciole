/** @jsxImportSource @opentui/react */
/**
 * `<Terminal>` in a page (src/vt/terminal.tsx): a page cannot start a local program, so
 * the pane says so where the program would have been (docs/WEB.md, W9).
 */
import type { TerminalProps } from "../../../vt/terminal";

export type { TerminalProps } from "../../../vt/terminal";

export function Terminal({ command, id, flexGrow, width, height }: TerminalProps) {
  return (
    <box id={id} flexGrow={flexGrow} width={width} height={height} border borderStyle="single">
      <text>{`${command[0] ?? "A program"} cannot run here: local programs need airtty in a terminal.`}</text>
    </box>
  );
}
