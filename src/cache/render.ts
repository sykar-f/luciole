import React from "react";
import { renderTags } from "./scope";

/** A comma-separated header: `Tag` (src/cache/runtime.ts) admits neither commas nor spaces. */
export const TAGS_HEADER = "x-airtty-tags";

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  "then" in value &&
  typeof value.then === "function";

const isFunctionComponent = <P>(
  component: React.ComponentType<P>,
): component is React.FunctionComponent<P> => {
  const prototype: unknown = component.prototype;
  return !(typeof prototype === "object" && prototype !== null && "isReactComponent" in prototype);
};

/**
 * Renders a page with `render` and tells which cache tags it read, for the Client to
 * invalidate that route precisely. Headers precede the body, so the page function itself
 * runs first: its tags are known once it resolved. Data read later, below a Suspense
 * boundary, is not attributed; the stream behind the page is unchanged.
 */
export async function renderPage<P extends Record<string, unknown>, B>(
  Page: React.ComponentType<P>,
  props: P,
  render: (tree: React.ReactNode) => B,
): Promise<{ body: B; tags: string[] }> {
  const tags = new Set<string>();
  if (!isFunctionComponent(Page))
    return { body: renderTags.run(tags, () => render(React.createElement(Page, props))), tags: [] };
  // The page function runs inside `Root`, in the same Flight task: hooks, `use()` and
  // thrown digests behave as if Flight had called it.
  const call = Page;
  let settle = () => {};
  const settled = new Promise<void>((resolve) => (settle = resolve));
  function Root() {
    try {
      const tree = call(props);
      if (!isThenable(tree)) {
        settle();
        return tree;
      }
      return Promise.resolve(tree).finally(settle);
    } catch (error) {
      settle();
      throw error;
    }
  }
  Root.displayName = Page.displayName ?? Page.name;
  const body = renderTags.run(tags, () => render(React.createElement(Root)));
  await settled;
  return { body, tags: [...tags] };
}
