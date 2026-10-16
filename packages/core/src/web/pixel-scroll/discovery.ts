import {
  decode,
  encode,
  MODE,
  VERSION,
  PRESENTATION_VERSION,
  type PixelReport,
} from "../../pixel-scroll/protocol";

/** Nonblocking negotiation. A revoked nonce can never enable private input again. */
export class PixelDiscovery {
  private nonce: string | undefined;
  private revoked = false;
  ready = false;
  presentations = false;

  query() {
    this.nonce = crypto.randomUUID();
    this.revoked = false;
    this.ready = false;
    this.presentations = false;
    // A strict v1 host ignores only the second query; neither peer needs a timer.
    return (
      encode({ op: "query", version: VERSION, nonce: this.nonce }) +
      encode({ op: "query", version: PRESENTATION_VERSION, nonce: this.nonce })
    );
  }

  receive(sequence: string): Extract<PixelReport, { op: "capability" }> | undefined {
    const report = decode(sequence);
    if (
      report?.op !== "capability" ||
      report.nonce !== this.nonce ||
      (this.revoked && report.reason === "ready")
    )
      return;
    this.ready = report.snapshot && report.precise && report.reason === "ready";
    if (!this.ready) {
      this.revoked = true;
      this.presentations = false;
    } else if (report.version === PRESENTATION_VERSION) this.presentations = true;
    return report;
  }

  mode() {
    return `\x1b[?${MODE}${this.ready ? "h" : "l"}`;
  }
}
