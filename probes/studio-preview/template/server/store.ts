// In-memory state of the generated app's Server: kept until the next rebuild.
let value = 0;
export const count = () => value;
export function add(step: number) {
  value += step;
  return value;
}
