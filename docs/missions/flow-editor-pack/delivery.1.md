# Delivery flow-editor-pack @ a3d667b9e8f75b066a4e2893d9242f3075b467ff (round 1)

Status: DONE
Summary: Les deux paquets avaient déjà license, repository, sideEffects, files, README, LICENSE et build ; il manquait `prepack` (dist n'était jamais construit au pack) et `engines`, ajoutés. `scripts/pack-check.ts` (CLI : `bun scripts/pack-check.ts <dir>...`, documenté en en-tête) packe, vérifie specs/cibles/tests/files, installe le tarball avec ses pairs et importe chaque export sous node et bun. Les README gagnent une section Installation (pairs). `marked: "catalog:"` est laissé : `bun pm pack` le résout (le tarball est vérifié sans spec `catalog:`).
Deviations from the brief: aucune, hors le constat que la plupart des champs listés existaient déjà.
Verification: bun run check, bun run lint, bun run format:check → verts. `bun scripts/pack-check.ts packages/flow packages/editor` → exit 0 ; flow et editor s'importent sous node et sous bun. Un fixture avec `catalog:` hors lockfile échoue (test).
Tests: tests/pack-check.test.ts, packages/flow/test/package.test.ts, packages/editor/test/package.test.ts
Risks: pack-check installe depuis le registre npm (dépendances propres du paquet, ex. marked) : réseau requis. Le cas `catalog:` dans un tarball déjà packé n'est couvert que par le test unitaire de `unresolvedSpecs`, `bun pm pack` échouant avant hors workspace.
Merge notes: seuls packages/{flow,editor}/package.json et READMEs touchés ; ajouts scripts/pack-check.ts et tests/pack-check.test.ts ; le package.json racine est intact.
