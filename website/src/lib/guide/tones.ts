// Where a thing runs, and so its colour: the Client (teal), the Server (amber), the wire between
// them (blue), the build (violet), and everything else (grey).
export type Tone = "client" | "server" | "wire" | "build" | "neutral";

export const toneLabel: Record<Tone, string> = {
  client: "Client",
  server: "Server",
  wire: "Réseau",
  build: "Build",
  neutral: "Hors runtime",
};
