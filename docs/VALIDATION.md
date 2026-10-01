# Validation du MVP — 22 septembre 2026

Les jalons ont été réalisés dans l’ordre prévu.
Projet indépendant créé dans `luciole/`, sans Engine, Protocol ou compilateur
TWP. Machine principale : macOS arm64 ; Server distant : Linux x86_64.

## Environnement verrouillé

Bun 1.4.2 ; OpenTUI core/react 0.5.12 ; React, react-dom et Flight 19.3.0 ;
react-reconciler 0.33.0 (plage déclarée par OpenTUI) ; TanStack Router 1.170.38 ;
TypeScript 7.0.2 et API `@typescript/typescript6` 6.0.2. Le lockfile fixe les transitives.
Chaque sonde a son propre manifest et son lockfile, sans override du reconciler.

`bun audit --json` a retourné `{}` (code 0) sur chaque lockfile du dépôt ce jour-là,
après mise à jour des dépendances. Cela signifie aucun avis connu retourné par cet audit à cette date,
pas une garantie de sécurité future. Références consultées :
[Server Functions](https://react.dev/reference/rsc/server-functions),
[React 19.3](https://react.dev/blog/2026/09/09/react-19-3),
[avis RSC](https://github.com/react/react/security/advisories),
[bindings OpenTUI React](https://opentui.com/docs/bindings/react/).

L’inspection locale d’OpenTUI 0.5.12 (`chunk-3h3pmzdr.js`, `_render`) confirme la
création d’un container à chaque appel de ce chemin. Le runtime monte une seule
racine ; ses mises à jour passent par le store du shell. L’adapter se limite aux
entrées Flight `client.browser` et `server.node`, avec un loader généré synchrone ;
`client.node` (codec du cache) et `server.edge` (Server du runtime web) s'y sont ajoutés
depuis.

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

| Jalon             | Vérification réalisée                                                                                                                                                                                                                                                                                                                                             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — action réelle | `tests/action.test.tsx` : référence dans Flight, interaction Entrée OpenTUI, appel HTTP avec `abc`, PIDs distincts, résultat affiché, `abcd` et même instance après refresh.                                                                                                                                                                                      |
| 2 — compilation   | `tests/build.test.ts` : exports Client et réexports, proxy d’action importée, manifests générés, exclusion du marqueur métier, diagnostics transitifs/marker/inline, builtins acceptés côté Client, build actif conservé lors d’une erreur. Starter sans registre manuel.                                                                                         |
| 3 — Notes         | `tests/notes.test.tsx`, `draft.test.ts`, validation métier dans `transport.test.tsx` : SQLite, versions, conflits, normalisation conditionnelle, Baseline `abc`/Draft `abcd`, retour au Draft visité, identité différente, store borné.                                                                                                                           |
| 4 — réseau        | `transport.test.tsx` : navigations inversées, incompatibilité réelle HTTP 409, refresh en erreur après succès, arrêt du processus Server après commit avant réponse, redémarrage sur la même base/URL puis consultation du résultat sans nouvelle sauvegarde. Compteurs inchangés pendant frappe, déplacement du curseur, focus et scroll locaux.                 |
| 5 — livraison     | Artefacts indépendants avec lockfiles ; README, API, starter ; `scripts/clean-install.ts` installe une copie neuve et les deux rôles séparément ; `scripts/pty/smoke.ts` pilote le Client de production ; `scripts/pty/dev.ts` vérifie erreur de compilation, saisie conservée, rebuild valide, restauration du terminal et absence de processus enfant orphelin. |

`bun run verify` passe : tests, vérification des types et build. `bun run format:check`
passe. La CI (`.github/workflows/ci.yml`) tourne sur GitHub Actions à chaque push et pull
request. Son job `verify`, sous macOS et Linux, enchaîne `bun run probes`, `bun run verify`,
`test:pty`, `test:pty:dev` et `scripts/clean-install.ts`, puis `scripts/linux-client.ts`
sous Linux ; le job `linux-sandbox` lance `scripts/build-sandbox.ts --check` et
`scripts/linux-sandbox.ts` ([TOOLING.md](TOOLING.md#commandes-et-ci)).

## PTY et deux machines

Les parcours PTY (`scripts/pty/`, scripts Bun) reconstruisent l’écran avec
l’émulateur d’OpenTUI (libghostty-vt), envoient les vraies séquences clavier et
passent par le renderer natif. Les assertions attendent une frame synchronisée
complète, dessinée après la dernière touche, pas seulement un fragment d’octets.
Jusqu’au 25 septembre 2026 ces parcours étaient des scripts Python (`scripts/pty-*.py`,
écran reconstruit par pyte) : les résultats consignés avant cette date viennent de ces
versions, aux assertions identiques. Capture textuelle : [pty-frame.txt](pty-frame.txt).

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

`LUCIOLE_LATENCY_MS=500 NOTES_DELAY_MS=0 bun run test:pty`
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
`LUCIOLE_LATENCY_MS` ajoute un délai aller-retour à chaque requête applicative (la moitié avant
l’envoi, la moitié avant la livraison de la réponse, dans le timeout) ; la latence réelle
s’y ajoute.

## Chargement local des routes

Avec le même RTT simulé de 500 ms et sans délai métier, `scripts/pty/smoke.ts` vérifie
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
au-delà de son contrat. `bun run verify` passe : tests, types des quatre programmes,
Oxlint sans avertissement, format et build.

| Preuve               | Vérification réalisée                                                                                                                                                                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Domaine sans UI      | `forge-domain.test.ts` : seed identique sur deux bases neuves, sessions (PIN, expiration, révocation), droits par rôle, merge idempotent par ledger, CI flaky puis rerun à horloge injectée, conflits de versions.      |
| Parcours au clavier  | `forge.test.tsx` : login public, commentaire de ligne, approbation, onglets et layout persistant, filtre d'état dans l'URL et retour, merge perdu résolu sans rejeu, conflit de description, logs CI en direct.         |
| Latence 500 ms       | `forge-latency.test.tsx` : filtre, hover et molette sans requête ; PR préchargée ouverte en moins de 250 ms sans rendu supplémentaire ; loading immédiat et géométrie identique à la page chargée.                      |
| Frontières           | `forge-build.test.ts` : SQL, git, sessions, seed et injection de fautes absents du bundle Client ; aucune page dans le graphe Client ; payload Flight sans token ni session ; import git réel de ce dépôt.              |
| Correctifs framework | `server-errors.test.ts` (500 générique sans fuite), `stream.test.ts` (stream au-delà du timeout), `search.test.tsx` (search textuelle, cache par search, retour arrière), purge des arbres privés dans `auth.test.tsx`. |
| Production           | `scripts/pty/forge.ts` sur les artefacts, 500 ms de RTT : login → approbation → commentaire → fichiers → checks → merge ; terminal restauré, code de sortie 0.                                                          |

Observations PTY de production (sortie PTY, pas écran physique), 500 ms de RTT
simulé : ouverture d'une PR préchargée **63 ms**, frappe dans un Draft **7 ms**.
Capture finale : [forge-pty-frame.txt](forge-pty-frame.txt). `scripts/pty/smoke.ts` (Notes)
passe toujours sous la même latence.

Rendu mesuré dans le renderer de test : diff de 1 443 lignes affiché et parcouru
(`G`, 20 × `j`) en moins de 15 ms ; commit réel de migration TanStack (40 fichiers,
+1 380/−559) importé depuis git et navigable fichier par fichier.

## Contrat « l'erreur au développeur » (23 septembre 2026)

`bun run verify` passe. Les trois parcours PTY (`scripts/pty/smoke.ts`, y
compris sous 500 ms de RTT, `scripts/pty/dev.ts`, `scripts/pty/forge.ts`) et `clean-install.ts`
passent sur macOS arm64.

| Capacité                 | Preuve                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issue typée des requêtes | `outcome.test.ts`, contre un vrai Server Notes et sa base : Server arrêté et annulation avant envoi (`not-sent`, rien d'écrit), 401/409/404 (`rejected`, rien d'écrit), commit puis réponse perdue et exception (`unknown`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Réseau simulé            | `outcome.test.ts` : `refuse`, `drop`, `cut` produisent l'outcome et l'effet en base de leur équivalent réel ; délai par chunk, jitter et `LUCIOLE_FAULT` validés.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Packages et côtés        | `build.test.ts` : package et dépendance transitive embarqués sans déclaration et inventoriés ; `server-only`, `luciole/server` et `serverPackages` refusés côté Client, `client-only` côté Server (code applicatif et packages), autorisé derrière `"use client"` ; chaîne d'imports complète depuis la page.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Écrans de route          | `route-screens.test.tsx` : `notFound(what)`, `error.tsx` avec `retry()`, catch-all et priorité de `[param]`, URL inconnue, erreur de transport avec son outcome, layout jamais démonté ; flux Flight de production sans message d'exception.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Invalidation Server      | `invalidation.test.tsx` : seule la route déclarée est rechargée, jamais un simple préfixe ; `useInvalidation` notifié ; aucune requête sans `invalidate()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Abonnements live         | `live.test.tsx` : valeurs au fil de l'eau bornées par `limit`, générateur Server arrêté (`finally`) au démontage, coupure rapportée en `unknown`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Keymap                   | `keymap.test.tsx` : aide générée depuis les couches montées, filtrée par groupe ; la couche d'une page disparaît avec elle.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Observabilité            | `observability.test.tsx` : l'overlay reste à zéro requête pendant frappe et molette, puis montre la sauvegarde et son RTT ; un span par requête, fermé avec son corps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Client autonome          | `compile.test.ts` : binaire lancé dans un PTY depuis un répertoire vide, sans Bun dans le `PATH` ni `node_modules`, affiche Notes servi par le Server ; build ID embarqué ; cible et paquet natif manquants expliqués.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Signature macOS          | `compile.test.ts` : le binaire du test PTY est signé ad hoc avec hardened runtime et les entitlements `allow-jit` et `disable-library-validation`, vérifié (`codesign --verify --strict`, flags `adhoc,runtime`), puis s'exécute ; `--sign` hors cible macOS et `--notarize` sans identité Developer ID refusés avant tout build. Contrôlé à la main : sans ces entitlements le binaire échoue, `notarytool` avec un profil absent produit une erreur explicite. Non exécutés : signature Developer ID, horodatage, notarisation, lancement d'un binaire en quarantaine.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| URL et tunnel SSH        | `connect.test.ts` : priorité `--url` > `LUCIOLE_URL` > fichier XDG > défaut, fichier invalide signalé ; un faux `ssh` forwarde la socket Unix vers un Server réel, arguments exacts (`-N`, `ExitOnForwardFailure`, `-p`, `--`), processus et socket supprimés à la fermeture, repli sur `/tmp` quand `TMPDIR` est trop long pour une socket ; refus de clé, blocage d'authentification (délai), hôte commençant par `-` et `ssh` absent expliqués. De bout en bout à la main : binaire compilé sans `--url`, URL `ssh://` lue dans `$XDG_CONFIG_HOME/luciole/notes.json`, vrai OpenSSH vers un `sshd` Alpine (Docker) puis le Server Notes de l'hôte : liste affichée ; `ssh` et sa socket disparaissent après Ctrl+C, SIGTERM et SIGHUP (le Client ignorait SIGHUP et survivait à la fermeture de son terminal : il s'arrête désormais) ; port ssh fermé et JSON invalide donnent un message et le code 1. Non testés : `ProxyJump`, saisie interactive d'une passphrase, Server Linux distant réel. |
| Client Linux exécuté     | `bun run test:linux` (Docker) : binaires croisés depuis macOS avec `--native-dir` et runtime officiel, lancés dans `debian:bookworm-slim` (glibc) et `alpine:3.22` + `libstdc++` (musl), sans Bun, contre le Server de l'hôte ; `/tmp` `noexec` avec `TMPDIR`. Exécuté sur macOS arm64 (OrbStack) pour arm64 et x64 (Rosetta). `compile.test.ts` passe sous Linux arm64 (`oven/bun:1.4.2`, util-linux). Étape du job Linux de la CI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Runtime Bun officiel     | `runtime.test.ts` (faux registre npm local) : téléchargement vérifié contre l'`integrity` sha512 publiée, cache publié par un seul `rename` sans résidu, réutilisé sans requête, archive altérée jamais mise en cache, entrée incomplète remplacée ; `--compile` l'utilise par défaut et explique l'absence de réseau ; `--runtime host` refusé pour une cible étrangère. Contrôlé à la main contre registry.npmjs.org : l'archive `@oven/bun-darwin-aarch64@1.4.2` correspond à l'`integrity` et au `shasum` publiés, et le binaire compilé lie `/usr/lib/libicucore.A.dylib`.                                                                                                                                                                                                                                                                                                                                                                                                                       |

## Typage strict et Zod (23 septembre 2026)

`bun run verify` passe, avec le lint strict et type-aware actif sur le framework, les
exemples, les tests, les scripts et les sondes (périmètre actuel dans
[TOOLING.md](TOOLING.md#commandes-et-ci)). Les trois parcours PTY, `bun run probes`
et `clean-install.ts` (starter neuf, lint strict compris) passent sur macOS arm64.

Mesuré par Oxlint avec les mêmes règles, avant et après, sans aucune dérogation :

| Violation                                      | Avant | Après |
| ---------------------------------------------- | ----: | ----: |
| `any` explicite                                |    54 |     0 |
| assertion `as` (hors `as const`)               |    74 |     0 |
| assertion non-null `!`                         |    49 |     0 |
| `Function` / `object`                          |     4 |     0 |
| flux `any` implicites (`no-unsafe-*`)          | 1 042 |     0 |
| nombres magiques hors tests                    |   113 |    32 |
| suppressions de lint (justifiées sur 2 lignes) |     3 |     3 |

Les 32 nombres restants se trouvaient dans les deux tables de données de Forge exemptées
(`ci.ts`, `seed.ts`). Le bundle Client de Notes passe de 415 à 460 Ko (`zod/mini`,
`build.test.ts` vérifie que l'API classique n'y entre pas) ; démarrage inchangé.

| Frontière                   | Preuve                                                                                                                  |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Enveloppe d'action          | `http-transport.test.ts` : chemins non textuels, autre `kind` ou autre `callId` donnent une `TransportError`.           |
| Racine d'un rendu           | `http-transport.test.ts` : une racine qui n'est pas un nœud React est refusée ; `stream.test.ts` : ses flux continuent. |
| Params et search Server     | `auth.test.tsx` : mêmes refus 400 qu'avant (clés en trop, JSON invalide, valeurs non textuelles), écrits en schémas.    |
| Arguments des exemples      | `forge-domain.test.ts` (verdict, opération) et `outcome.test.ts` (Notes) : argument invalide refusé avant tout effet.   |
| Zod applicatif sans install | `scripts/pty/dev.ts` : une application copiée sans `node_modules` compile avec le Zod du framework.                     |

Limite : une Server Function qui refuse ses arguments répond 500 (`unknown`), pas `rejected` :
le framework ne peut pas savoir qu'aucun code applicatif n'a tourné avant ce refus.

## Intégration des trois branches (23 septembre 2026)

Distribution, typage strict et Forge (keymap, `$EDITOR`, builtins côté Client) sont
fusionnés dans cet ordre. Le code de distribution et de Forge, écrit avant les règles
strictes, y est tenu : schémas pour la config utilisateur, le document npm, la sortie de
`notarytool` et la requête `fileSource` ; type `Fetch` pour le tunnel ; nombres nommés ;
tests sur `rejectionOf`, `present`, `renderable` et `readManifest`.

`bun run verify` passe, lint strict et type-aware compris. `scripts/pty/smoke.ts`,
`scripts/pty/dev.ts`, `scripts/pty/forge.ts` (avec l'ouverture dans `$EDITOR`) et `clean-install.ts`
passent sur macOS arm64.

Correctifs issus de la relecture des branches, chacun avec un test qui échoue sans lui :

| Défaut                                                                                  | Test              |
| --------------------------------------------------------------------------------------- | ----------------- |
| Un signal pendant l'authentification ssh laissait `ssh` et son répertoire de socket.    | `connect.test.ts` |
| `--sign`/`--notarize` sans valeur étaient ignorés, le build réussissait sans notariser. | `compile.test.ts` |
| Un runtime mis en cache par l'ancien format, extraction interrompue, restait réutilisé. | `runtime.test.ts` |
| Un package dépendant d'un autre zod recevait celui du framework.                        | `build.test.ts`   |

Non exécuté ici : `bun run test:linux` (Docker), signature Developer ID et notarisation
réelles, éditeurs réels (vim, `code --wait`) : seul un éditeur factice est piloté.

## Champs restaurables et formulaires (23 septembre 2026)

`bun run verify` passe (tests, types, lint, format, build). Les
parcours PTY `scripts/pty/restore.ts` (nouveau), `scripts/pty/dev.ts`, `scripts/pty/smoke.ts` et `scripts/pty/forge.ts`
passent sur macOS arm64 ; `clean-install.ts` et `test:linux` n'ont pas été relancés.

| Capacité                  | Preuve                                                                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Session par entrée        | `restore.test.ts` : texte rendu au retour sur l'entrée, entrée neuve vide après un push, replace qui garde la même adresse seulement, champ rattaché à son entrée de montage, valeur posée par l'application sans effet, groupe oublié à l'envoi puis rendu, plafond. |
| Redémarrage et envoi      | `restore-notes.test.tsx` (vrai Server Notes) : texte tapé revenu dans un Client neuf et Draft sale ; envoi refusé à la connexion (`not-sent`) : texte gardé ; envoi commis : texte oublié ; premier bearer : gardé, bearer remplacé : oublié.                         |
| Fichier de session        | `session.test.ts` : `0600` et répertoire `0700`, reprise de la session la plus récente d'un Client mort pour la même adresse, jamais deux fois ni celle d'un Client vivant, écriture après une pause, suppression, sessions trop anciennes ou illisibles écartées.    |
| Crash, signal, sortie     | `scripts/pty/restore.ts` (Client de production) : texte revenu après `kill -9` et après SIGTERM, fichier `0600`, session supprimée par Ctrl+C et rien de restauré au lancement suivant.                                                                               |
| Rebuild de développement  | `scripts/pty/dev.ts` : après un rebuild valide, le nouveau Client rouvre la note avec le texte tapé pendant l'erreur de build ; Ctrl+C ne laisse aucune session.                                                                                                      |
| TanStack Form             | `forge.test.tsx` : validation locale sans requête ; titre et description tapés, Client neuf avec la session et le bearer : champs rendus, Ctrl+S ouvre la PR, texte oublié ensuite. Parcours existant d'ouverture de PR inchangé.                                     |
| Opération jamais exécutée | `forge.test.tsx` : merge refusé à la connexion affiché « not sent », base inchangée, nouvelle tentative qui merge.                                                                                                                                                    |

Sondes du scratchpad (hors dépôt) sur le renderer de test OpenTUI : TanStack Form,
React Hook Form (`useController`, focus sur erreur compris) et Formik (`useFormik`)
fonctionnent ; `register()` de React Hook Form (`target.name` sur un événement DOM) et
`<Form>` de Formik (`Unknown component type: form`) échouent. Non vérifiés : terminal
physique, restauration après une vraie coupure SSH (aucun parcours PTY n'envoie SIGHUP ;
l'arrêt du tunnel sur SIGHUP a été vérifié à la main, voir « URL et tunnel SSH »),
deux Clients lancés au même instant sur une vraie machine.
