/**
 * Rewrites a module so that code after an `await` or a `yield` runs in the async context
 * frame it had before (async-context.ts): the build step that stands in for the engine's
 * own async context, for the Server's browser bundle (docs/WEB.md, W6).
 *
 *   await x            → __ac.resume(__ac.save(), await x)
 *   yield x            → __ac.resume(__ac.save(), yield x)        (async generators)
 *   for await (…) body → { const f = __ac.save(); for await (…) { __ac.resume(f); body } __ac.resume(f) }
 */
import ts from "@typescript/typescript6";

const HOOKS = "__ac";
const f = ts.factory;
const hook = (name: "save" | "resume", args: readonly ts.Expression[]) =>
  f.createCallExpression(
    f.createPropertyAccessExpression(f.createIdentifier(HOOKS), name),
    undefined,
    args,
  );
const save = () => hook("save", []);
const resume = (frame: ts.Expression, value: ts.Expression) => hook("resume", [frame, value]);

function isInAsyncGenerator(node: ts.Node) {
  let scope = node.parent;
  while (scope && !ts.isFunctionLike(scope)) scope = scope.parent;
  if (
    !scope ||
    !(
      ts.isFunctionDeclaration(scope) ||
      ts.isFunctionExpression(scope) ||
      ts.isMethodDeclaration(scope)
    )
  )
    return false;
  return (
    !!scope.asteriskToken &&
    !!ts.getModifiers(scope)?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
  );
}

export function transformAsyncContext(source: string, fileName: string): string {
  // Cheap exit: most modules never wait.
  if (!/\bawait\b|\byield\b/.test(source)) return source;
  const kind = fileName.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : fileName.endsWith(".ts")
      ? ts.ScriptKind.TS
      : fileName.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.ESNext, true, kind);
  let changed = false;
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit = (node: ts.Node): ts.Node => {
      if (ts.isAwaitExpression(node)) {
        changed = true;
        return resume(
          save(),
          f.updateAwaitExpression(node, ts.visitNode(node.expression, visit, ts.isExpression)),
        );
      }
      if (ts.isYieldExpression(node) && isInAsyncGenerator(node)) {
        changed = true;
        const yielded = ts.visitEachChild(node, visit, context);
        return resume(save(), f.createParenthesizedExpression(yielded));
      }
      if (ts.isForOfStatement(node) && node.awaitModifier) {
        changed = true;
        const frame = f.createUniqueName("__acFrame");
        const body = ts.visitNode(node.statement, visit, ts.isStatement);
        const restore = f.createExpressionStatement(resume(frame, f.createVoidZero()));
        return f.createBlock(
          [
            f.createVariableStatement(
              undefined,
              f.createVariableDeclarationList(
                [f.createVariableDeclaration(frame, undefined, undefined, save())],
                ts.NodeFlags.Const,
              ),
            ),
            f.updateForOfStatement(
              node,
              node.awaitModifier,
              ts.visitNode(node.initializer, visit, ts.isForInitializer),
              ts.visitNode(node.expression, visit, ts.isExpression),
              f.createBlock(
                [restore, ...(body && ts.isBlock(body) ? body.statements : body ? [body] : [])],
                true,
              ),
            ),
            restore,
          ],
          true,
        );
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (file) => ts.visitNode(file, visit, ts.isSourceFile);
  };
  const result = ts.transform(ast, [transformer]);
  const [output] = result.transformed;
  result.dispose();
  if (!changed || !output) return source;
  return ts.createPrinter({ removeComments: false }).printFile(output);
}
