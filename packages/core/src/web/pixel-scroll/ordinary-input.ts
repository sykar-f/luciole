import { decode, type PixelReport } from "../../pixel-scroll/protocol";

const SHIFT = 1;
const ALT = 2;
const CTRL = 4;
const SGR_SHIFT = 4;
const SGR_ALT = 8;
const SGR_CTRL = 16;
const MOTION = 32;
const NO_BUTTON = 3;
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const LEFT_HELD = 1;
const MIDDLE_HELD = 4;
const RIGHT_HELD = 2;

type Input = Extract<PixelReport, { op: "pointer" | "wheel" }>;

/** Generation-free equivalents for the existing iframe typed/input replay API. */
export class OrdinaryPixelInput {
  private remainder = 0;

  convert(data: string): string {
    const report = decode(data);
    if (report?.op !== "wheel" && report?.op !== "pointer") return data;
    const modifiers =
      (report.modifiers & SHIFT ? SGR_SHIFT : 0) |
      (report.modifiers & ALT ? SGR_ALT : 0) |
      (report.modifiers & CTRL ? SGR_CTRL : 0);
    if (report.op === "wheel") {
      if (!report.dy) return "";
      if (Math.sign(report.dy) !== Math.sign(this.remainder)) this.remainder = 0;
      this.remainder += report.dy;
      const rows = Math.trunc(this.remainder);
      this.remainder -= rows;
      return this.sgr(report, (rows < 0 ? WHEEL_UP : WHEEL_DOWN) | modifiers).repeat(
        Math.abs(rows),
      );
    }
    if (report.action === "move") return this.sgr(report, MOTION | NO_BUTTON | modifiers);
    if (report.action === "drag") {
      const button =
        report.buttons & LEFT_HELD
          ? 0
          : report.buttons & MIDDLE_HELD
            ? 1
            : report.buttons & RIGHT_HELD
              ? 2
              : NO_BUTTON;
      return this.sgr(report, MOTION | button | modifiers);
    }
    // xterm's ordinary mouse path does not report auxiliary back/forward buttons.
    if (report.button >= NO_BUTTON) return "";
    return this.sgr(report, report.button | modifiers, report.action === "up");
  }

  private sgr(report: Input, button: number, up = false) {
    return `\x1b[<${button};${Math.floor(report.x) + 1};${Math.floor(report.y) + 1}${up ? "m" : "M"}`;
  }
}
