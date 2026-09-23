import { createInterface } from "node:readline";
// Simulated business work, blocking this process only.
const WORK_MS = 400;
// One JSON request per line from the probe; checked, never trusted.
const isRequest = (value: unknown): value is { id: number; value: string } =>
  typeof value === "object" &&
  value !== null &&
  "id" in value &&
  typeof value.id === "number" &&
  "value" in value &&
  typeof value.value === "string";
const input = createInterface({ input: process.stdin });
console.log(JSON.stringify({ ready: true, pid: process.pid }));
for await (const line of input) {
  const request: unknown = JSON.parse(line);
  if (!isRequest(request)) throw new Error(`Invalid request: ${line}`);
  console.log(JSON.stringify({ started: request.id }));
  const end = performance.now() + WORK_MS;
  while (performance.now() < end) {} // Deliberately block ONLY business process.
  console.log(
    JSON.stringify({ id: request.id, value: request.value.toUpperCase(), pid: process.pid }),
  );
}
