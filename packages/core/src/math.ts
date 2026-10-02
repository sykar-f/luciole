/**
 * `import { renderMath } from "@luciole-sh/core/math"`: TeX to a PNG, for `@luciole-sh/markdown-editor`'s `math`
 * option, which draws display math with it in terminals that draw pictures.
 *
 * Opt-in, like `@luciole-sh/core/grammars`: MathJax (TeX to SVG, without a browser) and resvg (SVG
 * to PNG, in WebAssembly: nothing native to build) weigh a few megabytes. Both start on the
 * first formula, then each formula takes milliseconds.
 */
import { loadOptional } from "./optional";

/** Where a copied file is, resolved from this module (see `@luciole-sh/core/grammars`). */
function at(file: string) {
  const url = new URL(file, import.meta.url);
  return url.protocol === "file:" ? decodeURIComponent(url.pathname) : url.href;
}

const FEATURE = "@luciole-sh/core/math";

let started: ReturnType<typeof start> | undefined;
async function start() {
  // Optional dependencies (docs/DEPENDENCIES.md): loaded on the first formula.
  const resvg = await loadOptional(FEATURE, "@resvg/resvg-wasm", () => import("@resvg/resvg-wasm"));
  const resvgWasm = await loadOptional(
    FEATURE,
    "@resvg/resvg-wasm",
    () => import("@resvg/resvg-wasm/index_bg.wasm", { with: { type: "file" } }),
  );
  const [
    { LiteElement },
    { liteAdaptor },
    { RegisterHTMLHandler },
    { AllPackages },
    { TeX },
    { mathjax },
    { SVG },
  ] = await loadOptional(FEATURE, "mathjax-full", () =>
    Promise.all([
      import("mathjax-full/js/adaptors/lite/Element.js"),
      import("mathjax-full/js/adaptors/liteAdaptor.js"),
      import("mathjax-full/js/handlers/html.js"),
      import("mathjax-full/js/input/tex/AllPackages.js"),
      import("mathjax-full/js/input/tex.js"),
      import("mathjax-full/js/mathjax.js"),
      import("mathjax-full/js/output/svg.js"),
    ]),
  );
  await resvg.initWasm(await Bun.file(at(resvgWasm.default)).arrayBuffer());
  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const document = mathjax.document("", {
    // Without `noundefined`, which draws an unknown command in red: it is an error, and the
    // editor shows the TeX as written instead.
    InputJax: new TeX({ packages: AllPackages.filter((name) => name !== "noundefined") }),
    // Each formula carries its own glyphs: it is drawn alone.
    OutputJax: new SVG({ fontCache: "local" }),
  });
  return { adaptor, document, LiteElement, Resvg: resvg.Resvg };
}

const EX = /height="([\d.]+)ex"/;

/**
 * `tex` as a PNG on a transparent background, in `color`, at `scale` pixels per `ex`.
 * Rejects TeX that MathJax cannot read (the editor then shows the TeX itself).
 */
export async function renderMath(
  tex: string,
  options: { display: boolean; color: string; scale: number },
): Promise<Uint8Array> {
  started ??= start();
  const { adaptor, document, LiteElement, Resvg } = await started;
  // MathJax types what it converts as any: the lite adaptor makes elements of its own.
  const node: unknown = document.convert(tex, { display: options.display });
  if (!(node instanceof LiteElement)) throw new Error(`MathJax gave no element for ${tex}`);
  const svg = adaptor.innerHTML(node);
  if (svg.includes("data-mjx-error")) throw new Error(`MathJax cannot read ${tex}`);
  const height = Number(EX.exec(svg)?.[1] ?? 1);
  const colored = svg.replaceAll("currentColor", options.color);
  const image = new Resvg(colored, {
    fitTo: { mode: "height", value: Math.max(1, Math.round(height * options.scale)) },
  });
  return image.render().asPng();
}
