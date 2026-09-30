import ts from "@typescript/typescript6";

const DIRECTIVE = "use cache";
type Fail = (node: ts.Node, message: string) => never;
const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
  ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === kind);
const isDirective = (node: ts.Node): node is ts.ExpressionStatement =>
  ts.isExpressionStatement(node) &&
  ts.isStringLiteral(node.expression) &&
  node.expression.text === DIRECTIVE;
const ONLY =
  '"use cache" supports named, exported, async function declarations at the top of a module';

/**
 * The functions of a module that `"use cache"` wraps: every export of a module that
 * declares it first, or each exported function opening its body with it. Anything else is
 * refused: a closure would capture per-request values into a shared result, and a
 * component returns elements, which the cache does not store (it stores data).
 */
export function cachedFunctions(ast: ts.SourceFile, directive: string, fail: Fail): string[] {
  const names = new Set<string>();
  const wraps = (node: ts.Node): node is ts.FunctionDeclaration & { name: ts.Identifier } => {
    if (!ts.isFunctionDeclaration(node) || !hasModifier(node, ts.SyntaxKind.ExportKeyword))
      return false;
    if (hasModifier(node, ts.SyntaxKind.DefaultKeyword))
      fail(node, `${ONLY}; a default export (a page component) is unsupported`);
    if (!node.name || !hasModifier(node, ts.SyntaxKind.AsyncKeyword)) fail(node, ONLY);
    return true;
  };
  if (directive === DIRECTIVE)
    for (const s of ast.statements) {
      if (ts.isExportDeclaration(s) && !s.isTypeOnly)
        fail(s, '"use cache" modules cannot reexport; export named async declarations');
      if (ts.isExportAssignment(s)) fail(s, `${ONLY}; a default export is unsupported`);
      if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) continue;
      if (!hasModifier(s, ts.SyntaxKind.ExportKeyword)) continue;
      if (!wraps(s)) fail(s, ONLY);
      names.add(s.name.text);
    }
  function visit(node: ts.Node) {
    if (isDirective(node) && node.parent !== ast) {
      const body = node.parent,
        declaration = body.parent;
      if (!ts.isBlock(body) || !declaration || declaration.parent !== ast || !wraps(declaration))
        fail(node, `${ONLY}; closures, methods and arrow functions are unsupported`);
      const at = body.statements.indexOf(node);
      if (body.statements.slice(0, at).some((s) => !ts.isExpressionStatement(s)))
        fail(node, '"use cache" must open the function body');
      if (directive === "use server")
        fail(
          node,
          '"use cache" is unavailable in a "use server" module: its functions receive Client arguments; cache the functions they call',
        );
      if (directive === "use client") fail(node, '"use cache" runs on the Server only');
      names.add(declaration.name.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return [...names];
}

/**
 * Appended to the Server's copy of the module. A function declaration is a mutable
 * binding and exports are live: importers, and calls inside the module, get the wrapper.
 */
export function cacheSource(
  names: readonly string[],
  id: (name: string) => string,
  runtime: string,
) {
  return (
    `\nimport {cached as __lucioleCached} from ${JSON.stringify(runtime)};\n` +
    names.map((n) => `${n}=__lucioleCached(${n},${JSON.stringify(id(n))});`).join("\n")
  );
}

const unwrap = (node: ts.Expression): ts.Expression =>
  ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
    ? unwrap(node.expression)
    : node;
// `30` or `5 * 60`: evaluated by the build, so the Client route tree carries the number.
function seconds(node: ts.Expression): number | undefined {
  const value = unwrap(node);
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (ts.isBinaryExpression(value) && value.operatorToken.kind === ts.SyntaxKind.AsteriskToken) {
    const [left, right] = [seconds(value.left), seconds(value.right)];
    return left === undefined || right === undefined ? undefined : left * right;
  }
  return undefined;
}
const MS = 1000;
/**
 * A page's `export const staleTime = <seconds>`, in milliseconds: how long the Client's
 * router shows its cached tree without asking the Server again (TanStack's `staleTime`).
 */
export function staleTimeOf(ast: ts.SourceFile, fail: Fail): number | undefined {
  for (const s of ast.statements) {
    if (!ts.isVariableStatement(s) || !hasModifier(s, ts.SyntaxKind.ExportKeyword)) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== "staleTime") continue;
      const value = d.initializer && seconds(d.initializer);
      if (value === undefined || !Number.isFinite(value) || value < 0)
        fail(d, "staleTime must be a number of seconds ≥ 0: a literal or a product of literals");
      return Math.round(value * MS);
    }
  }
  return undefined;
}
