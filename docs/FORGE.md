# Forge — la démo complexe

Forge est une forge de code review dans le terminal : dépôts, pull requests, diffs
colorés, commentaires ligne à ligne, CI avec logs en direct, merge. Elle exerce dans
un seul flux métier les capacités de airtty, d'OpenTUI et de TanStack Router,
et elle a servi à pousser le framework au-delà de son contrat : ce qu'elle a cassé
est corrigé, testé et documenté ci-dessous.

Remplace la démo « Incident Control Room » prévue par
[COMPLEX-DEMO-HANDOFF.md](COMPLEX-DEMO-HANDOFF.md) : même matrice de preuves, domaine
choisi pour ses gros volumes, ses nombreux Drafts et sa mutation non rejouable (merge).

## Lancer

```sh
bun run forge                           # dev ; importe aussi les 8 derniers commits de ce dépôt
AIRTTY_LATENCY_MS=500 bun run forge   # la même chose sous 500 ms de RTT par requête
```

La base `forge.sqlite` est créée dans le répertoire courant (`FORGE_DB` pour en
choisir une autre) avec des données déterministes. Sans `FORGE_GIT_REPO`, seuls les
dépôts synthétiques `payments` et `web` existent ; `bun run forge` le positionne sur
ce checkout, qui devient le dépôt `airtty` : la démo revoit le code du framework.

Production, deux artefacts :

```sh
bun src/cli.ts build --app examples/forge
FORGE_DB=/tmp/forge.sqlite bun src/cli.ts start --role server --app examples/forge
bun src/cli.ts start --role client --app examples/forge --url http://127.0.0.1:3000
```

Réglages Server : `FORGE_SLOW_MS` (travail simulé, défaut 250 ms, rend le streaming
visible), `FORGE_CI_SCALE` (durée de la CI, défaut 1), `FORGE_GIT_REPO` et
`FORGE_GIT_COMMITS`. Ils sont validés par Zod au démarrage : une valeur invalide arrête
le Server en nommant la variable.

Chaque opération du domaine (`server/forge.ts`) reçoit ses entrées comme `unknown`, telles
que le réseau les a livrées aux Server Functions, et les valide avec Zod avant tout effet :
une entrée invalide lève `InvalidRequest` en nommant le champ fautif. Les résultats relus du
ledger sont revalidés par les schémas de `server/results.ts`, jamais castés.

Comptes, PIN `forge` pour tous : `alice` (maintainer, peut merger), `bob`
(contributor, peut reviewer et commenter), `carol` (reader, lecture seule).

## Clavier

| Où           | Touches                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------- |
| Partout      | `i` inbox · `1-9` dépôt · `u` retour · `?` aide · Ctrl+L déconnexion · Ctrl+R refresh          |
| Listes       | `↑↓`/`j k` sélection (préchargée) · Entrée ouvrir · `/` filtre local · `s` état (URL) · `n` PR |
| Pull request | Tab / Shift+Tab : Conversation → Files → Checks                                                |
| Conversation | `e` description · `c` commenter · `a` approuver · `x` demander des changements · `m` merger    |
| Files        | `[ ]` fichier · `j k` ligne · `c` commenter · `v` vu · `s` split · Espace page · `e` `$EDITOR` |
| Checks       | `↑↓` check · `r` relancer                                                                      |
| Édition      | Ctrl+S publier · Ctrl+X abandonner le Draft · Échap sortir sans perdre le Draft                |
| Issue perdue | Ctrl+O consulter le ledger (jamais de rejeu) · Ctrl+X oublier après une consultation vide      |

Une lettre est une commande tant qu'aucun champ n'a le focus ; dans un champ, c'est
du texte. `components/editing.tsx` porte ce mode : chaque écran déclare ses touches avec
`useBindings` (`desc` + `group`) et n'installe ses touches simples que hors édition. Une
couche de la keymap passe avant le champ focalisé et consomme la touche : une lettre liée
en permanence serait avalée, d'où ces couches conditionnelles (Tab et Entrée, qui ne sont
pas du texte, restent liées dans les formulaires). La ligne d'aide de chaque écran est
générée (`components/Help.tsx`, `<KeyHelp />` filtré par groupe) : la page Server nomme
les groupes de ses Client Components, les touches affichées sont celles actives à
l'instant (les lettres disparaissent pendant l'édition, les onglets aussi).

## Ouvrir le fichier dans son éditeur (`client-only`)

Dans l'onglet Files, `e` ouvre le fichier du diff courant dans l'éditeur de
l'utilisateur, sur son terminal. `components/editor.ts` importe `client-only` : Client et
Server tournant tous deux sur Bun, une page qui l'importerait par erreur compilerait et
lancerait l'éditeur **sur la machine du Server**, dans son terminal. Le build refuse ce
module dans le graphe Server hors d'une frontière `"use client"` ; `FilesReview` l'atteint
depuis la sienne.

Ce qui est ouvert, et pourquoi :

- **Le contenu vient du Server** (`fileSource`, une lecture sans invalidation) : le fichier
  entier, à la révision relue, du côté de la ligne sous le curseur (`new`, ou `old` sur une
  ligne supprimée), et l'éditeur s'ouvre sur cette ligne (`+LINE` pour vi, vim, nvim, nano,
  emacs, micro, kak). Le Client ne possède pas le dépôt : il ne reconstitue rien à partir
  du patch.
- **Un instantané en lecture seule** (`0444`) dans un répertoire privé de `$TMPDIR`
  (`mkdtemp`), nommé `fichier@r2.ts` (`fichier@r2.old.ts` pour l'ancien côté, l'extension
  reste reconnue par l'éditeur), supprimé avec son répertoire à la fermeture. Forge relit des révisions et n'a aucun moyen de reprendre une
  modification locale : un éditeur qui écrit quand même (`:w!`) voit sa modification
  signalée comme abandonnée, jamais envoyée.
- **L'éditeur** : `$VISUAL`, puis `$EDITOR`, puis `vi`, comme git ; les espaces séparent
  les arguments (pas de guillemets). Un éditeur graphique doit attendre sa fermeture
  (`code --wait`), sinon l'instantané disparaît avant son ouverture. Un éditeur
  introuvable affiche un message, l'UI reste là.
- **Le terminal** : `renderer.suspend()` d'OpenTUI rend l'écran principal, le mode cooked
  et la souris ; l'éditeur hérite du terminal ; `renderer.resume()` restaure l'UI (repeint
  complet), même si l'éditeur échoue.

Preuves : `tests/forge-editor.test.tsx` (build refusé pour une page qui importe le vrai
module ; `EDITOR` factice lancé par le processus Client, `+9`, fichier non inscriptible,
contenu identique à la révision, instantané supprimé, touches actives au retour) et
`scripts/pty-forge.py` (vrai PTY, artefacts de production : l'éditeur factice écrit sur le
terminal, reçoit une ligne tapée qui commence par `i`, Forge ne l'exécute pas, puis le
parcours reprend).

## Scénario de démonstration (5 minutes)

Dans un second terminal, `bun run forge:operator` joue le second opérateur (même
`FORGE_DB` que le Server).

1. **Latence.** Lancer avec `AIRTTY_LATENCY_MS=500`. Se connecter `bob`. Dans
   l'inbox, `/` puis taper : le filtre répond à chaque frappe, sans réseau. Survoler
   et faire défiler à la souris.
2. **Préchargement.** Descendre sur une PR, attendre une demi-seconde, Entrée :
   elle s'affiche sans attendre le RTT. Tab vers Files : l'écran de chargement local
   apparaît aussitôt, à la géométrie exacte de la page, onglets conservés.
3. **Streaming.** `payments#3` › Files : la liste des fichiers est utilisable pendant
   que chaque diff arrive derrière son propre Suspense ; le tableau généré de
   1 443 lignes défile sans à-coup (`Espace`, `G`).
4. **Commentaire de ligne.** `payments#2` › Files, `]`, `j` jusqu'à une ligne, `c`,
   taper, Ctrl+S. Continuer à taper pendant la publication. `v` marque le fichier vu :
   la marque survit au passage par Checks et Conversation (layout persistant).
5. **CI en direct.** Checks : `test` a échoué. `r` : les lignes du log arrivent une à
   une dans la réponse Flight (async iterable), la liste reste navigable ; à la fin,
   le composant invalide la route une fois et le statut passe au vert.
6. **Drafts et comptes.** Conversation de `payments#1`, `c`, taper sans publier,
   Échap : la sidebar compte le Draft. Ctrl+L demande confirmation, Ctrl+L encore.
   Se connecter `alice` : aucun texte de bob n'apparaît.
7. **Merge perdu.** `alice`, `payments#1`, `a` puis
   `bun run forge:operator lose merge`, puis `m` : le merge est commis mais la réponse
   se perd, l'écran affiche « outcome unknown ». `m` à nouveau ne fait rien. Ctrl+O
   consulte le ledger : « Merged #1 into main », une seule fois.
8. **Conflit.** `payments#2`, `e`, taper. Côté opérateur :
   `bun run forge:operator describe payments 2 Autre texte`. Ctrl+R : le Draft est
   gardé et signalé. Ctrl+S est refusé par le Server (version), Ctrl+X recharge la
   version Server.
9. **Révision poussée.** `bun run forge:operator push payments 2`, Ctrl+R : les
   approbations deviennent « stale », les commentaires « outdated », un Draft de
   ligne ancré sur l'ancienne révision est refusé à la publication.

## Matrice de couverture

| Capacité                   | Dans Forge                                                                                     | Preuve                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Server Components          | pages sans SQL, domaine `server/forge.ts`, section lente `components/Activity.tsx`             | `forge-build.test.ts` : SQL, git, sessions et seed absents du bundle Client |
| Client Components          | `PullList`, `FilesReview`, `ChecksPanel`, `Conversation`, `DraftEditor`                        | `forge-latency.test.tsx` : filtre, hover, molette sans requête sous 500 ms  |
| Server Functions           | `actions/session.ts` (publique), `account.ts`, `pulls.ts`                                      | `forge.test.tsx` ; droits revalidés dans `forge-domain.test.ts`             |
| Auth publique / protégée   | `/login` et `login()` publics, adapter `server/auth.ts`, `unauthorizedPath`                    | `forge.test.tsx` : redirection, PIN refusé, rendu protégé en 401            |
| Session                    | identité publique au chrome (`components/session.ts`), `actor()` dans le métier                | `forge-build.test.ts` : le payload Flight ne contient ni token ni session   |
| Token dynamique            | login, changement de compte, logout sur la même `Application`                                  | `forge.test.tsx` : Drafts de bob invisibles pour alice                      |
| Routage statique/dynamique | `pulls/new` avant `pulls/[number]`, groupes `(public)`/`(app)`                                 | `forge.test.tsx`, `forge-build.test.ts` (route graph)                       |
| Layouts persistants        | chrome, dépôt (trail), PR (onglets, fichiers vus, curseurs)                                    | `forge.test.tsx` : « files 1/2 viewed » après deux changements d'onglet     |
| Loading local              | `loading.tsx` par niveau, `Pulse` sur OpenTUI `useTimeline`                                    | `forge-latency.test.tsx` : affichage < RTT/2, géométrie identique           |
| Search params              | `/repos/payments?state=merged`, filtré par le Server                                           | `forge.test.tsx` (URL, retour arrière), `search.test.tsx`                   |
| Préchargement              | sélection d'une ligne → `router.preloadRoute`                                                  | `forge-latency.test.tsx` : ouverture < RTT/2, aucun rendu supplémentaire    |
| Flight progressif          | diff = Promise passée en prop (`use()`), activité derrière Suspense                            | `forge.test.tsx`, capture « Streaming … » dans l'onglet Files               |
| Streaming continu          | logs CI = async generator passé en prop, `components/live.ts`                                  | `forge.test.tsx` (lignes partielles puis fin), `stream.test.ts`             |
| Draft de session           | description, composers de conversation, de ligne et de nouvelle PR                             | `forge.test.tsx` : conflit, abandon, frappe pendant publication             |
| Résultat inconnu           | ledger `operations` + `components/operations.ts` pour review/merge/rerun                       | `forge.test.tsx` : merge perdu résolu, jamais rejoué                        |
| OpenTUI                    | `diff`, `code`/tree-sitter, `markdown`, `textarea`, `input`, `scrollbox`, `ascii-font`, souris | `forge.test.tsx`, captures PTY                                              |
| Build séparé et production | deux artefacts, lockfiles                                                                      | `scripts/pty-forge.py` sur les artefacts, [capture](forge-pty-frame.txt)    |
| `client-only`              | `components/editor.ts` : `e` ouvre le fichier relu dans `$EDITOR`, UI suspendue puis restaurée | `forge-editor.test.tsx`, `scripts/pty-forge.py`                             |

## Ce que la démo a poussé dans le framework

Chaque point est parti d'un besoin réel de Forge et d'un test qui échouait.

| Découverte                                                                                                                        | Changement                                                                                                    | Test                                     |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Fuite d'informations** : une Server Function qui lève renvoyait la page d'erreur HTML de Bun (message, stack, chemins, source). | `serve()` attend le contexte async : toute exception devient le 500 générique.                                | `server-errors.test.ts`                  |
| **Drafts entre comptes** : après `setToken`, le compte suivant voyait (et pouvait publier sous son nom) les Drafts du précédent.  | `setToken()` vide le `DraftStore` ; `{ preserveDrafts: true }` pour renouveler le bearer d'une même identité. | `auth.test.tsx`, `draft.test.ts`         |
| **Streams longs coupés** : le timeout de 10 s couvrait tout le corps de la réponse, donc tout log ou Suspense plus long.          | Le timeout borne l'attente du modèle racine ; le stream qui suit n'est plus coupé.                            | `stream.test.ts`                         |
| **Pas de search params** : `render()` ne transmettait que les params de chemin.                                                   | `validateSearch` + `loaderDeps` générés, `render(…, search)`, validation Server, prop `searchParams`.         | `search.test.tsx`, `route-types.test.ts` |
| Travail non sauvegardé invisible pour l'application.                                                                              | `drafts.unsaved()`, `drafts.size`, `drafts.clear()`.                                                          | `draft.test.ts`                          |
| Titre « TERMINAL / NOTES » codé en dur dans le chrome.                                                                            | Titre dérivé du répertoire de l'application.                                                                  | captures PTY                             |
| `import "client-only"` refusé par `tsc` dans une application (TS2882) : seul le programme du framework déclarait `server-only`.   | `src/markers.d.ts`, inclus par `airtty/tsconfig` : les deux marqueurs, sans package.                          | `bun run check` (Forge)                  |
| `node:*` et `bun:*` refusés dans tout module Client applicatif, même `client-only` : l'éditeur contournait avec les globaux Bun.  | Heuristique supprimée : seuls les marqueurs de côté décident, comme pour les packages.                        | `build.test.ts`                          |

Vérifié sans changement : `router.preloadRoute` fonctionne tel quel et TanStack
réutilise l'arbre préchargé ; Flight 19.3 sérialise les Promises et les async
iterables en props, livrés au fil de l'eau par le transport HTTP existant.

## Frictions observées, et ce qu'elles sont devenues

Relevées sur Notes et Forge, puis tranchées :

- **Drafts et opérations inconnues** : sortis du framework. Le runtime rapporte l'issue
  de chaque requête (`TransportError.outcome` : `not-sent`, `rejected`, `unknown`) ;
  Forge garde `components/draft.ts` et `components/operations.ts`. Une sauvegarde, une
  review, un merge ou une relance jamais exécutés (`not-sent`, `rejected`) échouent
  franchement et peuvent être retentés, au lieu de laisser une issue inconnue à résoudre.
- **Note stable exigée** : inchangé, c'est désormais une propriété du `useDraft` de Forge.
- **Invalidation dupliquée** : résolue. Les Server Functions déclarent `invalidate()` ;
  le chrome relit ses compteurs avec `useInvalidation`. `changes.ts` est supprimé (il
  invalidait aussi toutes les routes à chaque transition d'opération, pending compris).
- **Déconnexion** : `setToken()` ne touche plus aux Drafts ; Forge navigue vers la route
  publique, vide ses stores, puis change le bearer.
- **Streams et cache** : résolus pour la CI. Les logs viennent d'une Server Function
  génératrice (`checkLog`) lue avec `useLive` : le flux s'ouvre avec l'onglet Checks et
  s'arrête côté Server quand on le quitte. `live.ts` est supprimé.
- **`error.tsx` et `notFound()`** : résolus. Les pages appellent `notFound(what)` ;
  `app/(app)/not-found.tsx` affiche l'écran dans le chrome.
- **Raccourcis** : migration faite. Chrome, onglets, listes, conversation, fichiers,
  checks, éditeurs de Draft, formulaires et login déclarent leurs touches avec
  `useBindings` ; plus aucun `useKeyboard`, plus aucun texte d'aide écrit à la main dans
  les pages. Pièges rencontrés : une couche consomme la touche par défaut, donc `Ctrl+O`
  (plusieurs issues inconnues à consulter à la fois) déclare `fallthrough` ; `"G"` est lu
  comme `g`, il faut écrire `shift+g`. Tests : aide générée et mode édition dans
  `forge.test.tsx`.
- **Données publiques de session dans le chrome** : toujours faites par l'application
  (`components/session.ts` + `whoami()`).
- **Module `client-only` et builtins** : résolu. Le graphe Client refusait `node:*` et
  `bun:*` dans le code applicatif, même dans un module `client-only` ; `editor.ts` devait
  contourner deux défauts de Bun 1.4.2 (`Bun.write` ignore `mode`, `Bun.spawn` ignore les
  changements de `process.env`). La règle est supprimée : seuls `server-only` (ou
  `server/`) et `client-only` décident du côté d'un module, et `editor.ts` utilise
  `node:fs/promises` et `node:child_process`.

Côté application, choix assumés : politique de conflit (Draft gardé jusqu'à
l'abandon), révision poussée qui rend les approbations caduques, CI simulée
dérivée de l'horloge (aucune tâche cachée), fautes injectées uniquement par
l'opérateur local.

## Limites honnêtes

- CI simulée et dérivée du temps ; aucune tâche durable ni subscription.
- Auth de démonstration : PIN commun, sessions opaques en SQLite, pas de limitation
  de débit. Ne pas exposer tel quel.
- La latence simulée porte sur chaque requête, pas sur chaque chunk de stream.
- Un arbre préchargé peut avoir jusqu'à 30 s (défaut TanStack `preloadStaleTime`)
  avant d'être revalidé à la navigation.
- Les tests pilotent le renderer de test d'OpenTUI et un PTY réel ; aucune mesure
  d'affichage physique ni campagne WAN.
