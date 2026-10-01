# Delivery binary-test-ping-race @ f91d66dbf0fca5588349f4d09a56251aa5d8b41f (round 2)

Status: DONE
Summary: Round 1 removed the sleep; this round removes the remaining load dependency, the 100 ms answer deadline on each ping. The cut-tunnel test now drives `keepAlive` (as tests/lifetime.test.ts does) with a fetch over the tunnel's socket that sets `signal: undefined`: a killed tunnel refuses at once, so the watcher sees [false, true] from the tunnel's state alone. LUCIOLE_PING_MS (100) and the assertion are unchanged; connect.ts untouched. The test never drove a compiled Client process, so no question was needed.
Deviations from the brief: none
Verification: `bun run check`, `bun run lint`, `bun run format:check` → exit 0. 100 busy loops (counted 100), then 20 consecutive `bun run test tests/binary.test.ts -t "a lost Client finds its Server again"` → pass=20 fail=0. Full file unloaded: 7 pass, 0 fail.
Tests: tests/binary.test.ts
Risks: the test now bypasses connect()'s own managed wiring for this watch (keepAlive called directly); that wiring is covered elsewhere (clientOf in the other tests).
Merge notes: only tests/binary.test.ts.
Findings addressed: [major] ping answer deadline still load-sensitive → pings go through a fetch with no deadline, without raising LUCIOLE_PING_MS or changing the assertion.
