# airtty — buy vs build notes

Research date: 2026-09-22. Primary sources only.

## Cross-cutting constraint

The current client compiler rejects every non-local runtime package except React,
OpenTUI, and `airtty/client` (`src/build.ts`). Before ecosystem
integrations are practical, airtty needs an explicit, inspectable policy for
client dependencies. This does not imply making arbitrary packages trusted Server
code or weakening the Client/Server boundary.

## Findings

| Capability           | External option                                               | Fit                                                                                                        | Recommendation                                                                                |
| -------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Mutation UI          | React `useActionState`, `useOptimistic`, `useTransition`      | Renderer-independent React primitives, but no lost-response/idempotency policy                             | Use React for UI state; keep only airtty's transport-certainty semantics internally           |
| Forms                | TanStack Form                                                 | React 19 compatible and fields accept values through handlers; UI can be OpenTUI                           | External dependency or documented integration, not a framework form engine                    |
| Query cache          | TanStack Query                                                | React 19 compatible; invalidation, optimistic mutations and persistence already exist                      | Use for client-owned resources; keep Flight tree/segment caching internal                     |
| General client state | Zustand                                                       | Vanilla subscribable store and custom persistence storage                                                  | Let applications choose it; do not turn it into a framework primitive                         |
| Complex workflows    | XState                                                        | Framework-agnostic actors, React binding, persisted snapshots                                              | Application/job adapter; do not reimplement statecharts                                       |
| Routing              | TanStack Router                                               | Memory history exists, but React adapter peers on `react-dom` and many facilities are browser/SSR oriented | Keep the Flight segment router internal; borrowing the whole router is a poor seam            |
| Keymaps              | `@opentui/keymap`                                             | Native OpenTUI commands, layers, focus targets, sequences, React bindings, testing                         | Adopt upstream directly; airtty should only install framework commands/layers                 |
| Live transport       | Bun WebSocket/SSE                                             | Native pub/sub, headers, backpressure, standard client WebSocket                                           | Implement a small Terminal protocol or adapter seam; do not build a general message broker    |
| Durable jobs         | Inngest, BullMQ, Temporal-like engines                        | They own persistence, retries, scheduling and operations                                                   | Define a task interface and adapters; never embed a durable execution engine in the framework |
| Auth                 | Better Auth/device authorization or an existing OIDC provider | Device flow explicitly targets CLI/limited-input clients                                                   | Own only `authenticate(Request) -> Session`; provide optional adapters                        |
| Renderer testing     | OpenTUI test renderer and React test utils                    | Native frame capture, input, clock, mouse and cleanup                                                      | Wrap them with route/action/network assertions; do not build another renderer harness         |
| Telemetry            | OpenTelemetry                                                 | Standard traces/metrics exporters; JS traces and metrics stable                                            | Emit spans/events internally, export through OTel; keep a small terminal debug overlay        |
| Hot reload           | Bun `--hot`/`server.reload`, React refresh concepts           | Useful substrate, but cannot preserve airtty build IDs, Flight references or Draft ownership alone         | Framework-specific orchestration remains internal                                             |

## Primary sources

- React Actions: https://react.dev/reference/react/useActionState
- React optimistic state: https://react.dev/reference/react/useOptimistic
- TanStack Form validation: https://tanstack.com/form/latest/docs/framework/react/guides/validation
- TanStack Query invalidation: https://tanstack.com/query/latest/docs/framework/react/guides/invalidations-from-mutations
- TanStack Query persistence: https://tanstack.com/query/latest/docs/framework/react/plugins/persistQueryClient
- Zustand vanilla stores: https://zustand.docs.pmnd.rs/reference/apis/create-store
- Zustand persistence: https://zustand.docs.pmnd.rs/reference/integrations/persisting-store-data
- XState persistence: https://stately.ai/docs/persistence
- TanStack Router history: https://tanstack.com/router/latest/docs/guide/history-types
- OpenTUI keymap React integration: https://opentui.com/docs/keymap/react/
- OpenTUI testing: https://opentui.com/docs/core-concepts/testing/
- Bun WebSockets: https://bun.sh/docs/runtime/http/websockets
- Inngest durable execution: https://www.inngest.com/docs/learn/how-functions-are-executed
- Inngest realtime: https://www.inngest.com/docs/features/realtime
- Better Auth device authorization: https://better-auth.com/docs/plugins/device-authorization
- OpenTelemetry JavaScript: https://opentelemetry.io/docs/languages/js/
- Bun server lifecycle/hot reload: https://bun.sh/docs/runtime/http/server
