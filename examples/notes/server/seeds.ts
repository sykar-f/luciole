import "server-only";

/**
 * Notes a new notebook starts with, besides the welcome one: each has another shape (the whole
 * Markdown spec, long prose, tables, code, a checklist, one line, nothing) so a first look at
 * the app shows how every kind is listed and drawn.
 */

const SPEC = `Every construct of CommonMark, plus the GitHub extensions (tables, task lists, strikethrough, bare links). Edit this note to see the Markdown behind each one.

# Heading 1
## Heading 2
### Heading 3
#### Heading 4
##### Heading 5
###### Heading 6

Setext heading 1
================

Setext heading 2
----------------

## Inline

Plain text, *emphasis*, _emphasis too_, **strong**, __strong too__, ***both at once***, ~~struck through~~ and \`inline code\`, even \`\`code with a \` backtick\`\`.

A line ending with two spaces
breaks here, and one ending with a backslash\\
breaks too. A single newline
only continues the paragraph.

Escapes keep characters literal: \\*not emphasis\\*, \\# not a heading, \\[not a link\\]. Entities: &copy; &amp; &lt;tag&gt; &#8364; &#x1F4A1;.

## Links

- Inline: [luciole](https://luciole.sh)
- With a title: [CommonMark](https://commonmark.org "The Markdown spec")
- By reference: [the GFM spec][gfm], and a [collapsed][] one
- Autolinks: <https://github.com> and <hello@luciole.sh>
- A bare URL, linked by GitHub's extension: https://www.markdownguide.org

[gfm]: https://github.github.com/gfm/ "GitHub Flavored Markdown"
[collapsed]: https://spec.commonmark.org/0.31.2/#link-reference-definitions

## Images

![The Markdown mark](https://raw.githubusercontent.com/github/explore/main/topics/markdown/markdown.png)

An image by reference, then one inside a link:

![SQLite][sqlite-logo]

[![Markdown, linked to its guide](https://raw.githubusercontent.com/github/explore/main/topics/markdown/markdown.png)](https://www.markdownguide.org)

![A missing image shows its alternative text](missing/picture.png)

[sqlite-logo]: https://raw.githubusercontent.com/github/explore/main/topics/sqlite/sqlite.png "SQLite"

## Lists

- Unordered, with dashes
* or stars
+ or pluses

1. Ordered
2. Numbered on their own
3. From one

7) Starting at seven
8) With parentheses

- Nested
  - Second level
    - Third level
      1. Ordered inside
      2. Still inside
- Back to the top

- A loose list

- Its items are paragraphs

  With a second paragraph in the item.

## Task lists

- [x] Write the spec note
- [x] Seed it
- [ ] Read it in the terminal
  - [ ] Nested task

## Quotes

> A quote.
>
> > Nested inside another.
>
> With **Markdown** inside, and a list:
>
> - one
> - two

## Code

\`\`\`ts
// Fenced, with a language: highlighted
export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}
\`\`\`

~~~bash
# Tildes fence code too
bun run dev
~~~

    Indented by four spaces: a code block without a language.

\`\`\`diff
- the line before
+ the line after
  unchanged
\`\`\`

\`\`\`
No language at all.
\`\`\`

## Tables

| Left | Center | Right |
| :--- | :----: | ----: |
| apples | 3 | 1.20 € |
| *pears* | \`12\` | 4.80 € |
| ~~plums~~ | 0 | — |

## Beyond CommonMark

What notes often write, as GitHub and others read it:

> [!NOTE]
> An alert: a quote whose first line is \`[!NOTE]\`, \`[!TIP]\`, \`[!IMPORTANT]\`, \`[!WARNING]\` or \`[!CAUTION]\`.

> [!WARNING]
> Each kind has its color.

A ==highlight==, a footnote[^1], an emoji :tada:, keys <kbd>Ctrl</kbd>+<kbd>K</kbd>, H<sub>2</sub>O and x<sup>2</sup>, <mark>marked</mark> and <u>underlined</u> text, a line<br>broken by HTML.

[^1]: Footnotes are written anywhere in the note.

## Rules

Three ways to draw one:

---

***

___

## HTML

Inline <kbd>HTML</kbd> and <sub>tags</sub> pass through as written.

<details>
<summary>A block of HTML</summary>

Kept as it is.

</details>

<!-- A comment, hidden -->

That's the whole spec.`;

const TRIP = `# Lisbon, 4 days

## Before leaving

- [x] Book flights
- [x] Apartment in Alfama
- [ ] Lisboa Card for the trams
- [ ] Download offline maps

## Plan

### Day 1 — Alfama

Get lost on purpose. The **28 tram** up to *Miradouro de Santa Luzia*, then walk down through the alleys for dinner.

### Day 2 — Belém

1. Jerónimos Monastery, early, before the queues
2. Pastéis de Belém (*the* pastel de nata)
3. MAAT along the river at sunset

### Day 3 — Sintra

Train from Rossio, 40 minutes. Pena Palace in the morning, Quinta da Regaleira after lunch.

> Wear good shoes. Everything in Sintra is uphill, including the way down.

### Day 4 — LX Factory, then home

## Budget

| Item | Per person | Paid |
| :--- | ---: | :---: |
| Flights | 180 € | ✓ |
| Apartment | 240 € | ✓ |
| Food | 160 € | |
| Transport | 40 € | |
| **Total** | **620 €** | |`;

const MEETING = `**Attendees:** Ana, Karim, Léa, Tom

## Decisions

- Ship the **offline mode** before the redesign
- Weekly release train, on Tuesdays

## Action items

- [ ] Ana — draft the release notes
- [ ] Karim — measure cold start on a slow network
- [x] Léa — close the stale issues
- [ ] Tom — book the retro

## Open questions

1. Do we keep the old sync endpoint for a quarter?
2. Who owns the docs site?`;

const SNIPPETS = `Things I keep looking up.

## Git

\`\`\`bash
# Undo the last commit, keep the changes
git reset --soft HEAD~1

# Which branch contains a commit
git branch --contains <sha>
\`\`\`

## SQLite

\`\`\`sql
SELECT title, datetime(updated / 1000, 'unixepoch') AS edited
FROM notes
WHERE deleted IS NULL
ORDER BY updated DESC
LIMIT 10;
\`\`\`

## TypeScript

\`\`\`ts
type Result<T> = { ok: true; value: T } | { ok: false; error: string };

function parse(input: string): Result<number> {
  const value = Number(input);
  return Number.isNaN(value) ? { ok: false, error: "not a number" } : { ok: true, value };
}
\`\`\`

## Python

\`\`\`python
from collections import Counter

words = open("notes.md").read().split()
print(Counter(words).most_common(5))
\`\`\`

## TSX

\`\`\`tsx
export function Greeting({ name }: { name: string }) {
  return <p className="greeting">Hello, {name}!</p>;
}
\`\`\`

## Lua

\`\`\`lua
local function greet(name)
  return "Hello, " .. name
end
\`\`\`

## Diff

\`\`\`diff
@@ -1,2 +1,2 @@
-const answer = 41;
+const answer = 42;
 export default answer;
\`\`\`

## JSON

\`\`\`json
{
  "name": "notes",
  "version": "1.4.0",
  "private": true,
  "scripts": { "dev": "luciole dev", "test": "bun test" },
  "limits": { "notes": 10000, "ratio": 0.75, "owner": null },
  "tags": ["markdown", "terminal"]
}
\`\`\``;

const RECIPE = `*Serves 2 · 25 minutes*

| Ingredient | Quantity |
| :--- | ---: |
| Eggs | 4 |
| Crushed tomatoes | 400 g |
| Red pepper | 1 |
| Onion | 1 |
| Cumin, paprika | 1 tsp each |
| Feta | 50 g |

## Steps

1. Soften the onion and pepper in olive oil, **8 minutes**.
2. Add the spices, stir for 30 seconds, then the tomatoes.
3. Simmer until thick, about 10 minutes. Salt.
4. Make four wells, crack an egg in each.
5. Cover, cook until the whites set and the yolks stay runny.
6. Crumble the feta, add parsley, serve with bread.

> The yolks keep cooking off the heat: take it off a minute early.`;

const READING = `## Reading

- [x] *The Pragmatic Programmer* — Hunt & Thomas
- [ ] *A Philosophy of Software Design* — John Ousterhout
- [ ] *Designing Data-Intensive Applications* — Martin Kleppmann

## Articles

- [Out of the Tar Pit](https://curtclifton.net/papers/MoseleyMarks06a.pdf) — complexity and state
- [The Log](https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying) — Jay Kreps
- [Local-first software](https://www.inkandswitch.com/local-first/) — Ink & Switch

## Talks

- *Simple Made Easy*, Rich Hickey
- *The Mess We're In*, Joe Armstrong`;

const MOODS = [
  "Slow morning. Tea on the balcony, then a long walk by the river before the rain.",
  "Finally fixed the flaky test: it was a timer nobody cleared. **Two days** for one line.",
  "Read in the park. The light at seven is the best part of the day this month.",
  "Too many meetings. Wrote nothing I'm proud of, but cleared the inbox.",
];
const JOURNAL_DAYS = 12;
// Long enough to scroll: one entry a day, the moods taking turns.
const JOURNAL = Array.from(
  { length: JOURNAL_DAYS },
  (_, index) => `## September ${index + 1}\n\n${MOODS[index % MOODS.length]}`,
).join("\n\n");

const RELEASE = `---
title: Release 1.4
owner: Léa
due: 2026-10-02
tags: [release, mobile]
---

A note can open with front matter: YAML between two \`---\` lines, kept as written.

> [!TIP]
> Go through the list top to bottom, ticking as you go.

## Before tagging

1. Freeze the \`main\` branch
2. Update the changelog
3. Bump the version in \`package.json\`
4. Run the full test suite
5. Build every target
6. Smoke-test on a real phone
7. Check crash reports from the beta
8. Write the release notes
9. Get a second pair of eyes
10. Tag and push

> [!IMPORTANT]
> Tag only from \`main\`, never from a feature branch.

- [x] Migration written
- [ ] Migration dry run on a copy of production
  - [ ] Time it
  - [ ] Check the row counts

> [!CAUTION]
> Never skip the dry run: a failed migration takes the app down.

## Configuration

\`\`\`yaml
release:
  version: "1.4.0"
  channels: [stable, beta]
  rollout: 0.25 # a quarter of users first
\`\`\`

\`\`\`toml
[release]
version = "1.4.0"
rollout = 0.25
\`\`\``;

const MATH = `Math as GitHub writes it, in TeX between dollars. In a line, Unicode spells what it can: the circle's area is $\\pi r^2$, and $\\alpha \\leq \\beta_1$; the rest stays TeX, like $\\frac{a}{b}$. The other way to write it in a line: $\`\\sqrt{3}\`$. Money is not math: $5 and $10.

A block, between two \`$$\` lines, is drawn as a picture where the terminal draws pictures:

$$
\\left( \\sum_{k=1}^n a_k b_k \\right)^2 \\leq \\left( \\sum_{k=1}^n a_k^2 \\right) \\left( \\sum_{k=1}^n b_k^2 \\right)
$$

A \`math\` code block too:

\`\`\`math
x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
\`\`\`

$$
\\mathbf{A} = \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}, \\qquad e^{i\\pi} + 1 = 0
$$`;

/** `[id, title, Markdown, last edited]`: all older than the welcome note, which stays on top. */
export const SEEDS: readonly (readonly [string, string, string, string])[] = [
  ["3", "Markdown, the whole spec", SPEC, "2026-09-22T09:00:00Z"],
  ["13", "Math, as GitHub writes it", MATH, "2026-09-21T20:00:00Z"],
  ["4", "Trip to Lisbon", TRIP, "2026-09-21T18:30:00Z"],
  ["12", "Release 1.4", RELEASE, "2026-09-19T09:00:00Z"],
  ["5", "Weekly sync — decisions and action items", MEETING, "2026-09-20T10:00:00Z"],
  ["6", "Snippets", SNIPPETS, "2026-09-18T14:00:00Z"],
  ["7", "Shakshuka", RECIPE, "2026-09-15T19:00:00Z"],
  ["8", "Reading list", READING, "2026-09-10T08:00:00Z"],
  ["9", "Journal", JOURNAL, "2026-09-03T22:00:00Z"],
  // A title and nothing else, long enough to be cut in the list.
  ["10", "Call the plumber about the kitchen sink before Friday", "", "2026-08-24T12:00:00Z"],
  // One line, from last year: the list shows its year.
  [
    "11",
    "Idea",
    "What if the list could be grouped by month, like Notes on the Mac?",
    "2025-08-19T16:00:00Z",
  ],
];
