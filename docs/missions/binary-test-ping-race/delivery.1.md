# Delivery binary-test-ping-race @ 1fd087b14fd64490434de878d37e189eabe0ddb4 (round 1)

Status: DONE
Summary: In the cut-tunnel test of tests/binary.test.ts, the `Bun.sleep(300)` that stood for "the ping baseline is set" is removed. keepAlive (connect.ts, landed with load-sensitive-tests) starts reachable, reports a failing first ping and ignores stale answers, so whatever the timing of the first ping, once the tunnel is killed the watch sees [false, true]. The tunnel exists before the kill (runOn has returned), so nothing else needed holding; the fake-ssh path needed no held answers.
Deviations from the brief: none
Verification: `bun run check`, `bun run lint`, `bun run format:check` → exit 0. Load run: 100 busy loops (`while :; do :; done &`, counted 100 by `jobs -p`), then 20 consecutive `bun run test tests/binary.test.ts -t "a lost Client finds its Server again"` → pass=20 fail=0. Full file afterwards, unloaded: 7 pass, 0 fail.
Tests: tests/binary.test.ts
Risks: none beyond the test itself; connect.ts untouched, assertions untouched.
Merge notes: only tests/binary.test.ts (one line removed); no conflicts expected.
