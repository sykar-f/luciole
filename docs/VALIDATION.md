# Validation du MVP — 22 septembre 2026

Les jalons ont été réalisés dans l’ordre du [handoff conservé](HANDOFF.md).
Projet indépendant créé dans `terminal-rsc/`, sans Engine, Protocol ou compilateur
TWP. Machine principale : macOS arm64 ; Server distant : Linux x86_64.

## Environnement verrouillé

Bun 1.4.2 ; OpenTUI core/react 0.5.12 ; React, react-dom et Flight 19.3.0 ;
react-reconciler 0.34.0 ; TypeScript 7.0.2 et API `@typescript/typescript6` 6.0.2. Le lockfile fixe les transitives.
Les deux sondes ont leurs propres manifests/lockfiles ; leur override reconciler
a été aligné avec celui du framework lors de la mise à jour des dépendances.

`bun audit --json` a retourné `{}` (code 0) sur les trois lockfiles finaux, après mise à jour
des dépendances. Cela signifie aucun avis connu retourné par cet audit à cette date,
pas une garantie de sécurité future. Références consultées :
[Server Functions](https://react.dev/reference/rsc/server-functions),
[React 19.3](https://react.dev/blog/2026/09/09/react-19-3),
[avis RSC](https://github.com/react/react/security/advisories),
[bindings OpenTUI React](https://opentui.com/docs/bindings/react/).

L’inspection locale d’OpenTUI 0.5.12 (`chunk-3h3pmzdr.js`, `_render`) confirme la
création d’un container à chaque appel de ce chemin. Le runtime monte une seule
racine ; ses mises à jour passent par le store du shell. L’adapter se limite aux
entrées Flight `client.browser` et `server.node`, avec un loader généré synchrone.

## Sondes reproduites

Commande : `bun run probes`. Les résultats observés sont dans
[`probes/rsc/results.json`](../probes/rsc/results.json) et
[`probes/rpc/results.json`](../probes/rpc/results.json).

RSC : Client Reference résolue, refresh visible, instance et saisie préservées.
RPC : calcul métier séparé de 400 ms, frappe locale maintenue, écrasement naïf
reproduit, garde de révision vérifiée, édition après arrêt du processus métier.
Ces sondes restent des démonstrations isolées ; leur registre manuel n’est pas
utilisé dans le compilateur.

## Jalons et preuves

| Jalon             | Vérification réalisée                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — action réelle | `tests/action.test.tsx` : référence dans Flight, interaction Entrée OpenTUI, appel HTTP avec `abc`, PIDs distincts, résultat affiché, `abcd` et même instance après refresh.                                                                                                                                                                      |
| 2 — compilation   | `tests/build.test.ts` : exports Client et réexports, proxy d’action importée, manifests générés, exclusion du marqueur métier, diagnostics transitifs/marker/builtin/inline, build actif conservé lors d’une erreur. Starter sans registre manuel.                                                                                                |
| 3 — Notes         | `tests/notes.test.tsx`, `draft.test.ts`, validation métier dans `transport.test.tsx` : SQLite, versions, conflits, normalisation conditionnelle, Baseline `abc`/Draft `abcd`, retour au Draft visité, identité différente, store borné.                                                                                                           |
| 4 — réseau        | `transport.test.tsx` : navigations inversées, incompatibilité réelle HTTP 409, refresh en erreur après succès, arrêt du processus Server après commit avant réponse, redémarrage sur la même base/URL puis consultation du résultat sans nouvelle sauvegarde. Compteurs inchangés pendant frappe, déplacement du curseur, focus et scroll locaux. |
| 5 — livraison     | Artefacts indépendants avec lockfiles ; README, API, starter ; `scripts/clean-install.ts` installe une copie neuve et les deux rôles séparément ; `pty-smoke.py` pilote le Client de production ; `pty-dev.py` vérifie erreur de compilation, saisie conservée, rebuild valide, restauration du terminal et absence de processus enfant orphelin. |

`bun run verify` : **18 tests passent**, vérification des types et build passent.
`bun run format:check` passe. Le workflow CI macOS/Linux est livré ; il n’a pas
encore été exécuté sur GitHub, car ce dépôt local n’a pas été publié.

## PTY et deux machines

Les PTY utilisent un parseur d’écran pyte, les vraies séquences clavier et le
renderer natif. Les assertions attendent les frames synchronisées complètes,
pas seulement un fragment d’octets. Capture textuelle : [pty-frame.txt](pty-frame.txt).

Parcours : liste → détail → `abc` → sauvegarde avec 700 ms de délai métier → frappe
`d` avant réponse → Baseline `abc`/Draft `abcd` → liste → détail avec Draft conservé.
Sur loopback, arrêt du Server, refresh échoué puis frappe `e` toujours visible.
Ctrl+C restaure exactement les attributs termios d’entrée.

Observations ponctuelles du MVP initial, avant la mise à jour du reconciler
(pas des percentiles ni un budget contractuel) :

| Exécution                                                 | Frappe `d` → sortie PTY contenant le nouvel écran |
| --------------------------------------------------------- | ------------------------------------------------: |
| Production loopback macOS                                 |                                          16,78 ms |
| Artefacts installés séparément, répertoire neuf, loopback |                                          17,13 ms |
| Client macOS → Server Linux via tunnel SSH                |                                          17,21 ms |

La validation distante a utilisé le même bundle applicatif, Bun 1.4.2 des deux côtés,
un Server installé sans sources dans un répertoire de cache temporaire Linux,
une base SQLite de test et un tunnel SSH `43187 → 127.0.0.1:43188`. Le Server écoute
uniquement sur le loopback Linux ; le parcours traverse effectivement les deux
machines. Les processus et le tunnel ont été arrêtés après validation.

Ne sont **pas** prouvés : performance WAN représentative, latence physique
frappe-à-photon, charge multi-utilisateur, proxy TLS public, durabilité des Drafts
après arrêt du Client, résistance à une boucle infinie dans un composant de confiance.
La distribution universelle de code et sa sandbox restent des extensions.
