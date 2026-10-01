# Delivery community-files @ 853ef2e (round 2)

Status: DONE
Summary: Same content as round 1, with the two triage fixes: the website install in CONTRIBUTING.md runs in a subshell, and the first commit carries a scope.
Deviations from the brief: none.
Verification: bun run format:check re-run after the rewrite → pass; the only content change is one CONTRIBUTING.md line (check and lint cover no changed file).
Tests: none — documentation only, no code exercised
Risks: same as round 1 (advisories URL assumes sykar-f/luciole).
Merge notes: history rewritten, base unchanged (f80912e); README status block and ci.yml line 1 only, as before.
Findings addressed: CONTRIBUTING.md:19 now `(cd website && bun install --frozen-lockfile)`; commit reworded `docs(community): add SECURITY, CONTRIBUTING and CHANGELOG`; the no-tests finding was dismissed by the triage.
