// What a terminal answers an application with, told apart from what a hand typed: both
// come out of xterm.js's `onData` (src/web/embed.ts, `tellTyped`).
const ESC = "\u001b";
/**
 * After the escape, what a terminal answers an application's queries with, not what a
 * hand typed: OSC, DCS and APC strings (colours, …), device attributes, a cursor
 * position report, a mode report (DECRPM), a status report, window size, the keyboard
 * protocol's flags. xterm.js sends both through `onData`; replayed in another frame, an
 * answer would reach an application that never asked.
 */
const REPLY = /^(?:[\]P_][\s\S]*|\[\?[\d;]*(?:\$y|c|u)|\[>[\d;]*c|\[\d+;\d+R|\[\d*n|\[[\d;]*t)$/;
export const isReply = (data: string) => data.startsWith(ESC) && REPLY.test(data.slice(1));
