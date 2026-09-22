/** Shared route selection for Server pages and local navigation fallbacks. */
export function matchRoute<T extends { path: string }>(routes: readonly T[], path: string) {
  const actual = path.split("/");
  const ordered = [...routes].sort((a, b) => {
    const left = a.path.split("/"),
      right = b.path.split("/");
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      const specificity = Number(left[i].startsWith("[")) - Number(right[i].startsWith("["));
      if (specificity) return specificity;
    }
    return 0;
  });
  for (const route of ordered) {
    const expected = route.path.split("/");
    const params: Record<string, string> = {};
    if (expected.length !== actual.length) continue;
    if (
      expected.every((segment, i) => {
        if (!segment.startsWith("[")) return segment === actual[i];
        if (!actual[i]) return false;
        params[segment.slice(1, -1)] = decodeURIComponent(actual[i]);
        return true;
      })
    )
      return { route, params };
  }
}
