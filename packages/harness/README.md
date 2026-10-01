# @luciole/harness

Coding-agent harnesses behind one neutral model, for the luciole examples:
Claude Code, Codex, pi, opencode and a scripted one (`fake`). Each harness is
translated into the same plain-data events (`src/model.ts`), so a UI never
learns which protocol produced them.

**Internal.** This package is `"private": true` and is not published to npm.
Its API follows the needs of the examples and may change without notice.

**Bun only.** It spawns child processes with `Bun.spawn`, uses `Bun.which`,
and is consumed as TypeScript sources (`exports` point at `src/*.ts`).

## Modes

A session runs in one of four permission modes, in the order Shift+Tab walks
them: `read`, `ask`, `edits`, `full`. Each harness maps them to its own
controls.

| Mode    | Claude Code                               | Codex                                          |
| ------- | ----------------------------------------- | ---------------------------------------------- |
| `read`  | `plan`                                    | sandbox `read-only`, approval `on-request`     |
| `ask`   | `default`                                 | sandbox `workspace-write`, `on-request`        |
| `edits` | `acceptEdits`                             | sandbox `workspace-write`, `on-request`        |
| `full`  | `default`, every tool allowed by the host | sandbox `danger-full-access`, approval `never` |

pi and opencode get their own mapping (opencode: a per-mode list of session
rules; `read` also runs its `plan` agent). In the scripted harness, a requested edit is refused in `read`, asks for
approval in `ask` and is applied in `edits` and `full`.

### `full` is full access

On Codex, `full` means `danger-full-access` with approval `never`: no sandbox
and no confirmation. On Claude Code it is not `bypassPermissions` (that mode
never consults the host's permission callback, so questions and plan reviews
could not reach the user): Claude stays in `default` and the host allows each
tool itself, which is equally unrestricted. Use `full` only in a throwaway
checkout or a VM.

## Environment

The child process inherits the full environment of the host (`process.env`
unless a session is given another one), so it sees the same `PATH`, `HOME`
and credentials as the host. Each harness adds or removes only a few things:

- Claude Code receives it whole (it needs `HOME`, `PATH` and the keychain),
  plus `CLAUDE_CODE_ENABLE_TODO_TOOLS` and `CLAUDE_AGENT_SDK_CLIENT_APP`.
- Codex receives it as is.
- opencode receives it plus a random server username and password for its
  local `opencode serve`, and an `OPENCODE_CONFIG_CONTENT` that keeps the
  user's own value and sets `share` to `disabled`.
- pi and opencode receive it without Anthropic subscription (OAuth) tokens.

Anthropic reserves its subscription login (OAuth) for its own applications
(<https://code.claude.com/docs/en/legal-and-compliance>). When such a login
is detected for pi or opencode, the harness still starts and its other
providers stay usable, but Anthropic models are blocked (in the model picker,
when selecting a model and before each prompt) with a message pointing to
`--harness claude`. Claude stays available through an API key, or through the
Claude Code harness for a subscription.
