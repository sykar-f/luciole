// The three axes of a palette (styles/palettes.css), each an attribute on the root.
export const AXES = ["tint", "dominant", "encoding"] as const;
export type Axis = (typeof AXES)[number];
export type Choice = Record<Axis, string>;

/** Whether `value` names an axis: the attribute a select or the address carries. */
export const isAxis = (value: unknown): value is Axis => AXES.some((axis) => axis === value);
