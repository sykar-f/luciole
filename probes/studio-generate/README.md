# Sonde studio-generate : la boucle « génération → validation → correction »

Exécutée le 27 septembre 2026 sur macOS 26.6.2 (arm64), Bun 1.4.2, tsc 6.0.3 (celui de
`bun run check`). Sert la conception de [docs/studio/SPEC.md](../../docs/studio/SPEC.md),
section 5.

Question : après chaque tour d'un harness, quelles vérifications studio doit-il faire
pour qu'une app générée qui ne marche pas soit détectée, avec un diagnostic assez précis
pour que le harness la corrige seul ? Que coûte chaque vérification ?

**Aucun modèle n'est appelé.** Le taux de réussite d'un vrai harness n'est pas mesuré
ici : chaque prompt réel consomme le quota de l'utilisateur
([CODER-HANDOFF.md](../../docs/CODER-HANDOFF.md), section 3), et le harness factice de
`examples/coder` n'écrit pas de fichiers. La sonde rejoue donc un corpus **scripté** :
pour chaque demande, une première tentative (juste, ou avec une faute typique d'un modèle
de code dans une base qu'il ne connaît pas) puis la correction qu'un harness ferait après
avoir lu les diagnostics. Mesurer un vrai taux de réussite est prévu en C5b, avec accord
explicite de l'utilisateur (spec, section 8, étape C5b.6).

```sh
bun probes/studio-generate/probe.ts      # depuis la racine ; écrit results.json, code 1 si échec
```

| Fichier        | Rôle                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------- |
| `corpus.ts`    | 12 demandes : tentative(s) scriptée(s), étape attendue de l'échec, position de la faute                        |
| `guard.ts`     | garde-fou statique d'un lot de modifications : chemins permis, imports permis, appels dangereux                |
| `validate.tsx` | les quatre étapes : garde-fou, build (`src/build.ts`), types (`tsc --noEmit`), rendu headless contre le Server |
| `probe.ts`     | applique chaque tentative sur une copie neuve du template de `../studio-preview/template`, puis valide         |

Le rendu headless lance le vrai Server de l'app (`tests/helpers.ts`, `launch`), rend son
Client construit avec `testRender`, attend que l'écran se stabilise (400 ms) et relève :
erreur rattrapée par une boundary, `app.error`, chargement de route en échec
(`loader`/`error`), `console.error` (React y signale ce qu'une boundary de route a
rattrapé), stderr du Server.

## Résultats (12/12)

| Cas                        | Faute                                          | Détectée par      | Diagnostic                                                        | Pointe la faute   |
| -------------------------- | ---------------------------------------------- | ----------------- | ----------------------------------------------------------------- | ----------------- |
| `greeting`                 | —                                              | passe             | —                                                                 | —                 |
| `todo`                     | — (page, action Zod, store, composant clavier) | passe             | —                                                                 | —                 |
| `syntax`                   | `<text>` non fermé, ligne 9                    | build             | `app/page.tsx:1:1: JSX element 'text' has no corresponding…`      | **non** (1:1)     |
| `invented-import`          | import d'un composant inexistant               | build             | `app/page.tsx: Cannot resolve ../components/Header`               | fichier seul      |
| `hook-in-server-component` | `useState` sans `"use client"`                 | rendu (démarrage) | `Export named 'useState' not found in module …react.react-server` | non               |
| `wrong-type`               | `initial="10"` pour un `number`                | types             | `app/page.tsx:10 TS2322 …`                                        | oui               |
| `wrong-prop`               | `color="red"` sur `<text>` (c'est `fg`)        | types             | `app/page.tsx:9 TS2322 …`                                         | oui               |
| `server-crash`             | page qui jette sur une liste vide              | rendu             | `route / failed to load`, `no todo to show`                       | non (pas de pile) |
| `client-crash`             | `JSON.parse("")` dans un composant             | rendu             | `JSON Parse error: Unexpected EOF`                                | non               |
| `unknown-package`          | `import numeral`                               | garde-fou         | `imports numeral, not in the allowed packages`                    | fichier           |
| `shell-out`                | `node:child_process` dans `server/`            | garde-fou         | `imports node:child_process: needs a capability…`                 | fichier           |
| `dependency`               | écriture de `package.json`                     | garde-fou         | `writes outside app/, components/, server/, actions/`             | fichier           |

Chaque cas fautif est réparé par sa correction scriptée au tour suivant (2 tours).

Coût des étapes (médianes sur les 12 cas, toutes tentatives ; run commité, puis un run
antérieur) :

| Étape                        | Run commité      | Run antérieur | Remarque                                                                   |
| ---------------------------- | ---------------- | ------------- | -------------------------------------------------------------------------- |
| garde-fou                    | < 1 ms           | < 1 ms        | `Bun.Transpiler.scanImports`                                               |
| build                        | 1,44 s (1,2–1,7) | 1,24 s        | ≈ 5 ms quand l'analyse du graphe échoue tôt (syntaxe, import)              |
| types (`tsc --noEmit -p`)    | 1,56 s (max 2,5) | 1,78 s        | le run antérieur a eu 5 valeurs de 10 à 168 s (load ≈ 10), voir ci-dessous |
| rendu headless (Server + UI) | 0,53 s           | 0,55 s        | démarrage du Server compris                                                |

Les valeurs aberrantes de tsc ne se sont reproduites ni seules (3 × 1,5–1,6 s sur le même
workspace), ni dans le run commité : attribuées à la charge de la machine (autres
sessions), sans preuve. Un plafond de temps sur l'étape types est prudent.

## Constats

1. **Quatre étapes, pas une** : des 10 fautes du corpus, le build en arrête 2, les
   types 2, le rendu 3 ; le garde-fou arrête les 3 fautes de périmètre avant tout build. Les
   erreurs de types n'arrêtent pas le build : sans tsc, elles atteindraient l'aperçu.
2. **Positions** : tsc donne fichier et ligne exacts ; le build, jamais (erreur de
   syntaxe toujours en `1:1`, cause vérifiée : `packages/luciole/src/build.ts:322` passe
   le nœud racine à `fail()` ; import introuvable sans ligne) ; le rendu donne un message
   sans position.
3. **Hook dans un Server Component** : le build accepte la page, le Server généré meurt
   au démarrage avec une erreur d'export ; le diagnostic ne dit pas « ajoutez `"use
client"` ». Un message du framework dédié aiderait le harness (spec, section 7).
4. **Le garde-fou statique est un filtre, pas une barrière** : il ne voit ni
   `require(nom)` calculé ni `globalThis["Bun"]`. La barrière est le confinement de
   l'aperçu ([studio-server-sandbox](../studio-server-sandbox/README.md)).
5. **Budget d'un tour** : ≈ 1,2–1,4 s (build) + 0,55 s (rendu) avant l'aperçu ; tsc en
   parallèle du rendu, ≈ 1,6–1,8 s.
