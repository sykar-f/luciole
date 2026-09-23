# Validation du MVP — 22 septembre 2026

Les jalons ont été réalisés dans l’ordre du [handoff conservé](HANDOFF.md).
Projet indépendant créé dans `airtty/`, sans Engine, Protocol ou compilateur
TWP. Machine principale : macOS arm64 ; Server distant : Linux x86_64.

## Environnement verrouillé

Bun 1.4.2 ; OpenTUI core/react 0.5.12 ; React, react-dom et Flight 19.3.0 ;
react-reconciler 0.33.0 (plage déclarée par OpenTUI) ; TanStack Router 1.170.38 ;
TypeScript 7.0.2 et API `@typescript/typescript6` 6.0.2. Le lockfile fixe les transitives.
Les deux sondes ont leurs propres manifests/lockfiles, sans override du reconciler.

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

`bun run verify` : **93 tests passent**, vérification des types et build passent.
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

## Simulation de latence réseau

`AIRTTY_LATENCY_MS=500 NOTES_DELAY_MS=0 /tmp/airtty-pty-venv/bin/python scripts/pty-smoke.py`
a passé le parcours PTY avec 500 ms de délai aller-retour simulé et aucun délai
métier. Sur cette exécution, la frappe pendant la sauvegarde apparaît dans la
sortie PTY en **16,78 ms** ; ce n’est pas une mesure de latence physique de l’écran.
Navigation, conservation du Draft, édition hors ligne et restauration du terminal passent.

`tests/latency.test.tsx` monte l’application dédiée `examples/latency`, vérifie
un rendu et une action différés d’au moins 480 ms (tolérance des timers), puis
la saisie, le changement visible au survol et le déplacement réel du scroll
pendant l’attente. Les compteurs du Server confirment une seule action et son
refresh, sans trafic supplémentaire pour les interactions locales. Le test
vérifie aussi la configuration invalide et le timeout pendant le délai simulé.
Les limites de cette simulation sont décrites dans le [README](../README.md#tester-une-connexion-à-500-ms-de-ping).

## Chargement local des routes

Avec le même RTT simulé de 500 ms et sans délai métier, `pty-smoke.py` vérifie
maintenant que le squelette « Opening note 1… » apparaît avant la réponse réseau.
Observation de la sortie PTY après migration TanStack Router (22 septembre 2026) :
**9,74 ms** pour le loading, **16,7 ms** pour la frappe pendant la sauvegarde. Ce sont des observations ponctuelles de sortie PTY,
pas des mesures physiques d’écran.

`tests/navigation.test.tsx` retient explicitement les réponses pour vérifier le
loading avant toute réponse, l’annulation par Échap, la relance de la destination,
la conservation du même champ pendant un refresh, le retour à la dernière route
résolue et au Draft après un échec, y compris lorsqu’une sauvegarde se confirme
pendant la navigation, et l’ignorance des réponses obsolètes. `tests/route-graph.test.ts`
couvre layouts imbriqués, groupes pathless, héritage des loadings et collisions ;
`tests/routes.test.tsx` pilote le route tree généré (statique avant dynamique,
params, layout de groupe persistant) ; `tests/auth.test.tsx` la purge du cache au
logout et au changement de bearer et la validation Server des routes/params ;
`tests/renderer.test.tsx` le commit des transitions React sur OpenTUI avec le reconciler
épinglé. Les tests de build vérifient l’inclusion des layouts et loadings dans
l’identité du build et le graphe Client, le rejet des imports Server et l'absence
de la variante serveur de TanStack dans le bundle Client. Le starter neuf et les artefacts indépendants
passent aussi les contrôles et le parcours PTY.

La géométrie loading/page chargée est aussi comparée dans le renderer aux largeurs
100 et 44 colonnes : en-tête, titre, cadre d’input, statut, messages, aide et pied
de page. Le test couvre également le refresh et la saisie d’un texte long. Le PTY
avec latence compare les lignes du layout et les bordures avant/après chargement.

La pulsation du squelette est une timeline OpenTUI locale qui anime directement
l’opacité d’un rendu natif. Elle ne déclenche pas de re-render React à chaque frame,
ne modifie aucune dimension et est arrêtée lorsque le loading est démonté.

## Démo Forge — 22 septembre 2026

`examples/forge` ([FORGE.md](FORGE.md)) a été construite pour pousser le framework
au-delà de son contrat. `bun run verify` : **93 tests passent** (48 avant Forge),
types des quatre programmes, Oxlint sans avertissement, format et build.

| Preuve               | Vérification réalisée                                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domaine sans UI      | `forge-domain.test.ts` : seed identique sur deux bases neuves, sessions (PIN, expiration, révocation), droits par rôle, merge idempotent par ledger, CI flaky puis rerun à horloge injectée, conflits de versions.      |
| Parcours au clavier  | `forge.test.tsx` : login public, commentaire de ligne, approbation, onglets et layout persistant, filtre d'état dans l'URL et retour, merge perdu résolu sans rejeu, conflit de description, logs CI en direct.         |
| Latence 500 ms       | `forge-latency.test.tsx` : filtre, hover et molette sans requête ; PR préchargée ouverte en moins de 250 ms sans rendu supplémentaire ; loading immédiat et géométrie identique à la page chargée.                      |
| Frontières           | `forge-build.test.ts` : SQL, git, sessions, seed et injection de fautes absents du bundle Client ; aucune page dans le graphe Client ; payload Flight sans token ni session ; import git réel de ce dépôt.              |
| Correctifs framework | `server-errors.test.ts` (500 générique sans fuite), `stream.test.ts` (stream au-delà du timeout), `search.test.tsx` (search textuelle, cache par search, retour arrière), purge des arbres privés dans `auth.test.tsx`. |
| Production           | `scripts/pty-forge.py` sur les artefacts, 500 ms de RTT : login → approbation → commentaire → fichiers → checks → merge ; terminal restauré, code de sortie 0.                                                          |

Observations PTY de production (sortie PTY, pas écran physique), 500 ms de RTT
simulé : ouverture d'une PR préchargée **63 ms**, frappe dans un Draft **7 ms**.
Capture finale : [forge-pty-frame.txt](forge-pty-frame.txt). `pty-smoke.py` (Notes)
passe toujours sous la même latence.

Rendu mesuré dans le renderer de test : diff de 1 443 lignes affiché et parcouru
(`G`, 20 × `j`) en moins de 15 ms ; commit réel de migration TanStack (40 fichiers,
+1 380/−559) importé depuis git et navigable fichier par fichier.

## Contrat « l'erreur au développeur » (23 septembre 2026)

`bun run verify` : **93 tests passent**. Les trois parcours PTY (`pty-smoke.py`, y
compris sous 500 ms de RTT, `pty-dev.py`, `pty-forge.py`) et `clean-install.ts`
passent sur macOS arm64.

| Capacité                 | Preuve                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue typée des requêtes | `outcome.test.ts`, contre un vrai Server Notes et sa base : Server arrêté et annulation avant envoi (`not-sent`, rien d'écrit), 401/409/404 (`rejected`, rien d'écrit), commit puis réponse perdue et exception (`unknown`).                                                                                                                                                                                                                                                                                                                                                    |
| Réseau simulé            | `outcome.test.ts` : `refuse`, `drop`, `cut` produisent l'outcome et l'effet en base de leur équivalent réel ; délai par chunk, jitter et `AIRTTY_FAULT` validés.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Packages et côtés        | `build.test.ts` : package et dépendance transitive embarqués sans déclaration et inventoriés ; `server-only`, `airtty/server` et `serverPackages` refusés côté Client, `client-only` côté Server (code applicatif et packages), autorisé derrière `"use client"` ; chaîne d'imports complète depuis la page.                                                                                                                                                                                                                                                                    |
| Écrans de route          | `route-screens.test.tsx` : `notFound(what)`, `error.tsx` avec `retry()`, catch-all et priorité de `[param]`, URL inconnue, erreur de transport avec son outcome, layout jamais démonté ; flux Flight de production sans message d'exception.                                                                                                                                                                                                                                                                                                                                    |
| Invalidation Server      | `invalidation.test.tsx` : seule la route déclarée est rechargée, jamais un simple préfixe ; `useInvalidation` notifié ; aucune requête sans `invalidate()`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Abonnements live         | `live.test.tsx` : valeurs au fil de l'eau bornées par `limit`, générateur Server arrêté (`finally`) au démontage, coupure rapportée en `unknown`.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Keymap                   | `keymap.test.tsx` : aide générée depuis les couches montées, filtrée par groupe ; la couche d'une page disparaît avec elle.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Observabilité            | `observability.test.tsx` : l'overlay reste à zéro requête pendant frappe et molette, puis montre la sauvegarde et son RTT ; un span par requête, fermé avec son corps.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Client autonome          | `compile.test.ts` : binaire lancé dans un PTY depuis un répertoire vide, sans Bun dans le `PATH` ni `node_modules`, affiche Notes servi par le Server ; build ID embarqué ; cible et paquet natif manquants expliqués.                                                                                                                                                                                                                                                                                                                                                          |
| Client Linux exécuté     | `bun run test:linux` (Docker) : binaires croisés depuis macOS avec `--native-dir` et runtime officiel, lancés dans `debian:bookworm-slim` (glibc) et `alpine:3.22` + `libstdc++` (musl), sans Bun, contre le Server de l'hôte ; `/tmp` `noexec` avec `TMPDIR`. Exécuté sur macOS arm64 (OrbStack) pour arm64 et x64 (Rosetta). `compile.test.ts` passe sous Linux arm64 (`oven/bun:1.4.2`, util-linux). Étape ajoutée au job Linux de la CI, pas encore exécutée par GitHub.                                                                                                    |
| Runtime Bun officiel     | `runtime.test.ts` (faux registre npm local) : téléchargement vérifié contre l'`integrity` sha512 publiée, cache publié par un seul `rename` sans résidu, réutilisé sans requête, archive altérée jamais mise en cache, entrée incomplète remplacée ; `--compile` l'utilise par défaut et explique l'absence de réseau ; `--runtime host` refusé pour une cible étrangère. Contrôlé à la main contre registry.npmjs.org : l'archive `@oven/bun-darwin-aarch64@1.4.2` correspond à l'`integrity` et au `shasum` publiés, et le binaire compilé lie `/usr/lib/libicucore.A.dylib`. |

Non vérifié : binaires Linux sur machine physique ou arm64 sous CI (seulement conteneurs
et Rosetta), signature et notarisation macOS, migration des écrans internes de Forge vers la keymap.
