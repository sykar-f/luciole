// Rendered by the Server like any page: the multiplexer's panes are local to the Client,
// its help line is not.
export default function HelpLine() {
  return (
    <text height={1} wrapMode="none" truncate fg="#8b98a5">
      Ctrl+O then: o next pane · c new shell · v vim · x close · q quit · click to focus
    </text>
  );
}
