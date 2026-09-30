import { color } from "./theme";

// `luciole › examples › files`: the root's own name, then the path below it.
export function Title({ root, path }: { root: string; path: string }) {
  const parts = path ? path.split("/") : [];
  const base = root.split("/").at(-1) || "/";
  return (
    <>
      <span fg={parts.length ? color.muted : color.accent}>{base}</span>
      {parts.map((part, i) => (
        <span key={i} fg={i === parts.length - 1 ? color.accent : color.muted}>
          {" › "}
          {part}
        </span>
      ))}
    </>
  );
}
