import { createInterface } from "node:readline";
const input = createInterface({ input: process.stdin });
console.log(JSON.stringify({ ready: true, pid: process.pid }));
for await (const line of input) {
  const request = JSON.parse(line);
  console.log(JSON.stringify({ started: request.id }));
  const end = performance.now() + 400;
  while (performance.now() < end) {} // Deliberately block ONLY business process.
  console.log(
    JSON.stringify({ id: request.id, value: request.value.toUpperCase(), pid: process.pid }),
  );
}
