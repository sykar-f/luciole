# Delivery flow-editor-pack @ cb1df42e6197bb4f3c26e708c38f79ceb85078e6 (round 2)

Status: DONE
Summary: pack-check développe désormais les cibles `*` de `exports` contre le tarball (un motif sans correspondance échoue), importe chaque sous-chemin public sous node et bun (JSON avec attribut d'import), échoue explicitement sur un export qu'aucun import ne peut charger (au lieu de le sauter), et filtre `files` avec les chemins, dossiers, globs et exclusions `!` de npm. Le README de l'éditeur installe aussi `luciole`, importé par son exemple.
Deviations from the brief: none
Verification: bun run check, bun run lint, bun run format:check → verts. Sortie de `bun scripts/pack-check.ts packages/flow packages/editor` (exit 0) :

    @luciole/flow: tarball luciole-flow-0.1.0.tgz, 87 files
    @luciole/flow: import @luciole/flow under node ok
    @luciole/flow: import @luciole/flow under bun ok
    @luciole/flow: import @luciole/flow/package.json under node ok
    @luciole/flow: import @luciole/flow/package.json under bun ok
    packages/flow: ok
    @luciole/editor: tarball luciole-editor-0.1.0.tgz, 144 files
    @luciole/editor: import @luciole/editor under node ok
    @luciole/editor: import @luciole/editor under bun ok
    @luciole/editor: import @luciole/editor/package.json under node ok
    @luciole/editor: import @luciole/editor/package.json under bun ok
    packages/editor: ok

Tests: tests/pack-check.test.ts, packages/flow/test/package.test.ts, packages/editor/test/package.test.ts
Risks: un export vers un fichier non importable (css…) échoue désormais ; voulu, un paquet qui en aurait devra l'admettre explicitement dans une évolution du script. luciole exporte des .ts sous la condition par défaut : node ne les chargera pas, ce que la mission luciole devra trancher.
Merge notes: inchangé (scripts/pack-check.ts, tests/pack-check.test.ts, packages/editor/README.md).
Findings addressed: wildcard/JSON skipped → expansion + import + échec explicite, testés ; files patterns → inFiles + tests ; README éditeur sans luciole → ajouté ; sortie collée ci-dessus ; tests ajoutés (wildcard, JSON, files, outside/test rejection, échec par runtime).
