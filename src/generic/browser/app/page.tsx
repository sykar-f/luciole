// The generic Client's help line, rendered by its local Server like any page.
export default function HelpLine() {
  return (
    <text height={1} wrapMode="none" truncate fg="#8b98a5">
      Ctrl+O then: o next tab · x close tab · q quit
    </text>
  );
}
