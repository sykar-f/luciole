// Deterministic demo data. Timestamps derive from a fixed epoch so two fresh databases
// are identical; seeded CI attempts started long ago and are therefore finished.
export const SEED_EPOCH = Date.UTC(2026, 8, 1, 9, 0, 0);
const minutes = (n: number) => SEED_EPOCH + n * 60_000;

export const USERS = [
  { id: "alice", name: "Alice Martin", role: "maintainer" },
  { id: "bob", name: "Bob Keller", role: "contributor" },
  { id: "carol", name: "Carol Diaz", role: "reader" },
] as const;

export const REPOS = [
  { slug: "payments", description: "Payment service: refunds, ledger, settlement" },
  { slug: "web", description: "Customer web application" },
] as const;

type SeedFile = { path: string; before: string; after: string };
export type SeedPull = {
  repo: string;
  number: number;
  title: string;
  author: string;
  state: "open" | "merged";
  head: string;
  description: string;
  files: SeedFile[];
  /** Attempts that fail per check name: a flaky test fails its first attempt only. */
  failing?: Partial<Record<"lint" | "test" | "build", number>>;
  reviews?: { reviewer: string; verdict: "approve" | "changes"; at: number }[];
  comments?: {
    author: string;
    body: string;
    at: number;
    path?: string;
    side?: "old" | "new";
    line?: number;
  }[];
  mergedBy?: string;
  created: number;
};

const refundsBefore = `import { ledger } from "./ledger";

export type Refund = { paymentId: string; amount: number; reason: string };

export async function refund(request: Refund) {
  if (request.amount <= 0) throw new Error("Refund amount must be positive");
  const payment = await ledger.payment(request.paymentId);
  if (!payment) throw new Error("Unknown payment");
  if (request.amount > payment.captured - payment.refunded)
    throw new Error("Refund exceeds captured amount");
  await ledger.record({ kind: "refund", ...request });
  return { status: "accepted" as const };
}
`;
const refundsAfter = `import { ledger } from "./ledger";

export type Refund = {
  paymentId: string;
  amount: number;
  reason: string;
  /** Client-chosen key: retrying the same refund never moves money twice. */
  idempotencyKey: string;
};

export async function refund(request: Refund) {
  if (request.amount <= 0) throw new Error("Refund amount must be positive");
  if (!/^[0-9a-f-]{36}$/.test(request.idempotencyKey))
    throw new Error("idempotencyKey must be a UUID");
  return ledger.transaction(async (tx) => {
    const previous = await tx.outcome(request.idempotencyKey);
    if (previous) return previous;
    const payment = await tx.payment(request.paymentId);
    if (!payment) throw new Error("Unknown payment");
    if (request.amount > payment.captured - payment.refunded)
      throw new Error("Refund exceeds captured amount");
    await tx.record({ kind: "refund", ...request });
    const outcome = { status: "accepted" as const, key: request.idempotencyKey };
    await tx.remember(request.idempotencyKey, outcome);
    return outcome;
  });
}
`;
const ledgerBefore = `export type Entry = { kind: "capture" | "refund"; paymentId: string; amount: number };

export const ledger = {
  async payment(id: string) {
    return db.get("SELECT captured, refunded FROM payments WHERE id = ?", id);
  },
  async record(entry: Entry) {
    await db.run("INSERT INTO entries(kind, payment_id, amount) VALUES (?, ?, ?)", entry.kind, entry.paymentId, entry.amount);
  },
};
`;
const ledgerAfter = `export type Entry = { kind: "capture" | "refund"; paymentId: string; amount: number };

export const ledger = {
  async payment(id: string) {
    return db.get("SELECT captured, refunded FROM payments WHERE id = ?", id);
  },
  async record(entry: Entry) {
    await db.run("INSERT INTO entries(kind, payment_id, amount) VALUES (?, ?, ?)", entry.kind, entry.paymentId, entry.amount);
  },
  /** Runs \`work\` in one IMMEDIATE transaction; outcomes are stored with the entry. */
  async transaction<T>(work: (tx: Transaction) => Promise<T>) {
    return db.immediate(() => work(transactionOf(db)));
  },
};
`;
const refundsTest = `import { expect, test } from "bun:test";
import { refund } from "../src/refunds";

test("a retried refund returns the first outcome", async () => {
  const key = crypto.randomUUID();
  const first = await refund({ paymentId: "p1", amount: 10, reason: "damaged", idempotencyKey: key });
  const retry = await refund({ paymentId: "p1", amount: 10, reason: "damaged", idempotencyKey: key });
  expect(retry).toEqual(first);
  expect(await ledgerTotal("p1")).toBe(10);
});

test("an invalid key is refused before any ledger access", async () => {
  await expect(refund({ paymentId: "p1", amount: 10, reason: "x", idempotencyKey: "1" })).rejects.toThrow("UUID");
});
`;
const readmeBefore = `# payments

Refunds, captures and settlement for the checkout.

## Refunds

\`POST /refunds\` with \`paymentId\`, \`amount\` and \`reason\`.
`;
const readmeAfter = `# payments

Refunds, captures and settlement for the checkout.

## Refunds

\`POST /refunds\` with \`paymentId\`, \`amount\`, \`reason\` and \`idempotencyKey\`.

Retrying with the same key returns the first outcome and never refunds twice.
Choose a new UUID for each distinct refund.
`;

const settlementAfter = `import { ledger } from "./ledger";

export type SettlementLine = { paymentId: string; captured: number; refunded: number };

/** Streams a day's settlement without loading it in memory. */
export async function* settlement(day: string): AsyncGenerator<SettlementLine> {
  let cursor = "";
  for (;;) {
    const page = await ledger.page(day, cursor, 500);
    for (const line of page.lines) yield line;
    if (!page.next) return;
    cursor = page.next;
  }
}

export async function totals(day: string) {
  let captured = 0;
  let refunded = 0;
  for await (const line of settlement(day)) {
    captured += line.captured;
    refunded += line.refunded;
  }
  return { captured, refunded, net: captured - refunded };
}
`;
const reportBefore = `import { ledger } from "./ledger";

export async function dailyReport(day: string) {
  const lines = await ledger.all(day);
  const captured = lines.reduce((sum, line) => sum + line.captured, 0);
  const refunded = lines.reduce((sum, line) => sum + line.refunded, 0);
  return \`\${day}: captured \${captured}, refunded \${refunded}\`;
}
`;
const reportAfter = `import { totals } from "./settlement";

export async function dailyReport(day: string) {
  const { captured, refunded, net } = await totals(day);
  return \`\${day}: captured \${captured}, refunded \${refunded}, net \${net}\`;
}
`;

const roundingBefore = `export function round(amount: number, currency: string) {
  const digits = currency === "JPY" ? 0 : 2;
  const factor = 10 ** digits;
  return Math.round(amount * factor) / factor;
}
`;
const roundingAfter = `import { CURRENCIES } from "./currencies";

/** Banker's rounding in minor units, using the ISO 4217 exponent of the currency. */
export function round(amount: number, currency: string) {
  const exponent = CURRENCIES[currency]?.exponent;
  if (exponent === undefined) throw new Error(\`Unknown currency \${currency}\`);
  const factor = 10 ** exponent;
  const scaled = amount * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const even = floor % 2 === 0;
  const minor = diff > 0.5 || (diff === 0.5 && !even) ? floor + 1 : floor;
  return minor / factor;
}
`;
// A large generated table: the review screen must stay usable while it streams.
const currencyCodes = Array.from({ length: 360 }, (_, i) => {
  const a = String.fromCharCode(65 + (i % 26)),
    b = String.fromCharCode(65 + (Math.floor(i / 26) % 26)),
    c = String.fromCharCode(65 + ((i * 7) % 26));
  return `${a}${b}${c}`;
});
const currenciesAfter =
  "// Generated from ISO 4217. Do not edit by hand.\n" +
  "export const CURRENCIES: Record<string, { exponent: number; name: string }> = {\n" +
  currencyCodes
    .map(
      (code, i) =>
        `  ${code}: {\n    exponent: ${code === "JPY" ? 0 : i % 11 === 0 ? 3 : 2},\n    name: "Currency ${code}",\n  },`,
    )
    .join("\n") +
  "\n};\n";

const webhooksBefore = `export async function deliver(url: string, body: unknown) {
  const response = await fetch(url, { method: "POST", body: JSON.stringify(body) });
  if (!response.ok) throw new Error(\`Webhook failed: \${response.status}\`);
}
`;
const webhooksAfter = `const DELAYS = [1_000, 5_000, 30_000, 120_000];

export async function deliver(url: string, body: unknown, attempt = 0): Promise<void> {
  const response = await fetch(url, { method: "POST", body: JSON.stringify(body) });
  if (response.ok) return;
  if (response.status < 500 || attempt >= DELAYS.length)
    throw new Error(\`Webhook failed: \${response.status}\`);
  await Bun.sleep(DELAYS[attempt]);
  return deliver(url, body, attempt + 1);
}
`;

const tokensBefore = `:root {
  --background: #ffffff;
  --foreground: #1f2328;
  --accent: #0969da;
}
`;
const tokensAfter = `:root {
  --background: #ffffff;
  --foreground: #1f2328;
  --accent: #0969da;
}

@media (prefers-color-scheme: dark) {
  :root {
    --background: #0d1117;
    --foreground: #e6edf3;
    --accent: #4493f8;
  }
}
`;
const themeAfter = `export type Theme = "light" | "dark" | "system";

export function applyTheme(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  localStorage.setItem("theme", theme);
}
`;
const focusBefore = `export function trapFocus(container: HTMLElement) {
  container.focus();
}
`;
const focusAfter = `const FOCUSABLE = "a[href], button:not([disabled]), input, select, textarea, [tabindex]";

export function trapFocus(container: HTMLElement) {
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)];
  items[0]?.focus();
  container.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { last.focus(); event.preventDefault(); }
    else if (!event.shiftKey && document.activeElement === last) { first.focus(); event.preventDefault(); }
  });
}
`;

export const PULLS: SeedPull[] = [
  {
    repo: "payments",
    number: 1,
    title: "Add idempotency keys to refunds",
    author: "bob",
    state: "open",
    head: "feature/refund-idempotency",
    created: 30,
    description: `Refund retries currently move money twice when the first response is lost.

## Change

- \`refund()\` requires an \`idempotencyKey\` (UUID).
- The outcome is stored **in the same transaction** as the ledger entry.
- A retry with the same key returns the stored outcome.

## Not in scope

Partial refund aggregation stays in the settlement job.`,
    files: [
      { path: "src/refunds.ts", before: refundsBefore, after: refundsAfter },
      { path: "src/ledger.ts", before: ledgerBefore, after: ledgerAfter },
      { path: "test/refunds.test.ts", before: "", after: refundsTest },
      { path: "README.md", before: readmeBefore, after: readmeAfter },
    ],
    comments: [
      {
        author: "carol",
        at: 42,
        body: "Does a retry with a *different* amount but the same key return the first outcome too?",
      },
    ],
  },
  {
    repo: "payments",
    number: 2,
    title: "Stream settlement reports",
    author: "alice",
    state: "open",
    head: "feature/settlement-stream",
    created: 60,
    failing: { test: 1 },
    description: `Daily reports load every ledger line in memory; large merchants time out.

Settlement is now an async generator paged by 500 lines. \`dailyReport\` folds it.`,
    files: [
      { path: "src/settlement.ts", before: "", after: settlementAfter },
      { path: "src/report.ts", before: reportBefore, after: reportAfter },
    ],
    comments: [
      {
        author: "bob",
        at: 74,
        path: "src/settlement.ts",
        side: "new",
        line: 9,
        body: "`500` could live in a named constant shared with the export job.",
      },
    ],
  },
  {
    repo: "payments",
    number: 3,
    title: "Rewrite currency rounding tables",
    author: "bob",
    state: "open",
    head: "feature/iso-4217",
    created: 90,
    description: `Rounding hard-coded JPY. It now reads the ISO 4217 exponent of every currency
and uses banker's rounding.

The generated table is large: review \`src/rounding.ts\` first.`,
    files: [
      { path: "src/rounding.ts", before: roundingBefore, after: roundingAfter },
      { path: "src/currencies.ts", before: "", after: currenciesAfter },
    ],
    reviews: [{ reviewer: "alice", verdict: "changes", at: 120 }],
    comments: [
      {
        author: "alice",
        at: 119,
        path: "src/rounding.ts",
        side: "new",
        line: 8,
        body: "Floating point: `2.675 * 100` is `267.49999…`. Round on integer minor units instead.",
      },
      {
        author: "alice",
        at: 120,
        body: "Requesting changes for the floating point issue; the table itself looks right.",
      },
    ],
  },
  {
    repo: "payments",
    number: 4,
    title: "Initial ledger schema",
    author: "alice",
    state: "merged",
    mergedBy: "alice",
    head: "feature/ledger-schema",
    created: 5,
    description: "Creates `payments` and `entries` tables.",
    files: [{ path: "src/ledger.ts", before: "", after: ledgerBefore }],
    reviews: [{ reviewer: "bob", verdict: "approve", at: 10 }],
  },
  {
    repo: "web",
    number: 1,
    title: "Dark mode design tokens",
    author: "bob",
    state: "open",
    head: "feature/dark-mode",
    created: 45,
    description: "Adds a dark palette behind `prefers-color-scheme` and a manual override.",
    files: [
      { path: "styles/tokens.css", before: tokensBefore, after: tokensAfter },
      { path: "src/theme.ts", before: "", after: themeAfter },
    ],
  },
];

export const BRANCHES = [
  {
    repo: "payments",
    name: "feature/webhook-retries",
    author: "bob",
    files: [{ path: "src/webhooks.ts", before: webhooksBefore, after: webhooksAfter }],
  },
  {
    repo: "web",
    name: "feature/focus-trap",
    author: "alice",
    files: [{ path: "src/focus.ts", before: focusBefore, after: focusAfter }],
  },
];

export const at = minutes;
