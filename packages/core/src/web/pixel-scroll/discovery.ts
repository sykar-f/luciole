import { decode, encode, MODE, VERSION, type PixelReport } from "../../pixel-scroll/protocol";

/** Nonblocking negotiation. A revoked nonce can never enable private input again. */
export class PixelDiscovery {
  private nonce: string | undefined;
  private revoked = false;
  ready = false;

  query() {
    this.nonce = crypto.randomUUID();
    this.revoked = false;
    this.ready = false;
    return encode({ op: "query", version: VERSION, nonce: this.nonce });
  }

  receive(sequence: string): Extract<PixelReport, { op: "capability" }> | undefined {
    const report = decode(sequence);
    if (report?.op !== "capability" || report.nonce !== this.nonce || this.revoked) return;
    this.ready = report.snapshot && report.precise && report.reason === "ready";
    if (!this.ready) this.revoked = true;
    return report;
  }

  mode() {
    return `\x1b[?${MODE}${this.ready ? "h" : "l"}`;
  }
}
