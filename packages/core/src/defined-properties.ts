/** Optional keys whose value is undefined are absent from an options object. */
type DefinedProperties<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** Copies plain options or decoded records, keeping only defined properties. */
export function definedProperties<T extends Record<string, unknown>>(
  value: T,
): DefinedProperties<T>;
export function definedProperties(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}
