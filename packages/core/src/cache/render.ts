import { renderTags } from "./scope";

/**
 * The root model of a `/render` response: the page, rendered as its own Flight stream,
 * and the "use cache" tags that render read, resolved once its stream ended (content
 * below Suspense included). Flight tells no one when a response is complete, and a
 * promise in the same response would keep it open: the page's own stream does end, so
 * it is the one observed. The shell still leaves as soon as Flight writes it.
 */
export function renderPage(
  // A page element; any Flight model streams the same way (streams, iterables, promises).
  tree: unknown,
  render: (model: unknown) => ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const read = new Set<string>();
  const page = renderTags.run(read, () => render(tree)).getReader();
  let settle = (_tags: string[]) => {};
  const tags = new Promise<string[]>((resolve) => (settle = resolve));
  // A cut or cancelled page resolves with what it read so far: the response is ending.
  const end = () => settle([...read]);
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await page.read();
        if (!done) return controller.enqueue(value);
        end();
        controller.close();
      } catch (error) {
        end();
        controller.error(error);
      }
    },
    cancel(reason) {
      end();
      return page.cancel(reason);
    },
  });
  return render({ tree: stream, tags });
}
