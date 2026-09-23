# airtty — MVP

Framework expérimental React Server Components pour le terminal : React/Flight
compose l’interface sur un Server, OpenTUI assure les interactions dans un Client
séparé. L’application Notes fournit liste, édition, sauvegarde SQLite, navigation,
Drafts de session et récupération d’une sauvegarde dont la réponse s’est perdue.
Le paquet et son CLI s’appellent `airtty` ; aucun paquet n’est encore publié
sur un registre.

## Installation et démarrage

Installer **Bun 1.4.2**. Depuis un checkout de ce dépôt :

```sh
bun install --frozen-lockfile
bun run dev
```

Une commande compile et lance les deux processus. La base `notes.sqlite` est créée
dans le répertoire courant. `NOTES_DB=/chemin/notes.sqlite bun run dev` choisit un
autre fichier. Les tests utilisent exclusivement des bases temporaires.

Dans la liste : flèches puis Entrée. Dans une note : Entrée ou Ctrl+S sauvegarde,
Échap revient à la liste, Ctrl+D abandonne le Draft au profit du dernier contenu
Server reçu. Ctrl+R reconnecte/rafraîchit ; Ctrl+O consulte le résultat d’une
opération inconnue ; Ctrl+T affiche les requêtes. Ctrl+C restaure le terminal et quitte.
L’aide en bas de l’écran est générée depuis les raccourcis actifs.

Le Client reste éditable pendant une sauvegarde et après une perte de connexion.
Le framework rapporte l’issue de chaque requête (`not-sent`, `rejected`, `unknown`) ;
Notes en tire sa politique : une sauvegarde jamais envoyée échoue, une opération
inconnue n’est jamais rejouée automatiquement, elle est consultée. Une erreur de
refresh ne transforme pas une sauvegarde confirmée en échec.

## Tester une connexion à 500 ms de ping

```sh
AIRTTY_LATENCY_MS=500 bun run dev
# Banc de test dédié : input, scroll et hover pendant un appel distant
AIRTTY_LATENCY_MS=500 bun src/cli.ts dev --app examples/latency
```

`AIRTTY_LATENCY_MS` ajoute un délai aller-retour à **chaque requête applicative**
(rendu Flight, navigation, action, refresh, récupération) : 250 ms avant l’envoi et
250 ms avant de livrer la réponse pour une valeur de 500. Les attentes sont
asynchrones, inclues dans le timeout, et indépendantes entre requêtes. La latence
réelle s’ajoute à cette valeur. Par défaut, aucun délai n’est ajouté.

Dans le banc de test, Entrée appelle le Server. Pendant « Waiting for Server… »,
continuer à taper, faire défiler les 100 lignes à la molette et survoler la zone
colorée. Le résultat indique le temps d’aller-retour observé. Ctrl+R permet aussi
de tester un refresh lent en conservant l’interface montée. La navigation vers
une page distante attend le réseau ; ces interactions locales n’en dépendent pas.
Le terminal doit transmettre les événements souris pour le scroll et le hover.

Pour éprouver la gestion d’erreurs d’une application, `AIRTTY_JITTER_MS` ajoute un
délai aléatoire à chaque trajet, `AIRTTY_CHUNK_DELAY_MS` ralentit chaque chunk d’un
stream Flight, et `AIRTTY_FAULT=refuse:0.1,drop:0.05,cut:0.05` injecte des fautes :
requête jamais envoyée, réponse perdue après exécution sur le Server, corps coupé.

C’est une simulation de latence de requête/réponse, pas une émulation TCP : elle
ne simule pas bande passante, pertes, jitter, ni le délai individuel de chaque
chunk d’un stream Flight. Elle suppose le Client exécuté localement ; exécuter le
Client lui-même à travers SSH ajoute la latence du terminal à chaque interaction.
`NOTES_DELAY_MS` reste uniquement une sonde de traitement métier pour Notes.

Le test `tests/latency.test.tsx` vérifie les délais, la saisie, le scroll effectif,
le hover visible, l’absence de trafic supplémentaire lié à ces interactions et
la conservation du composant après refresh.

## Chargement des pages

La navigation est portée par TanStack Router (memory history) : les layouts
`layout.tsx` sont des Client Components persistants, les pages restent Server et
arrivent par Flight. Les navigations affichent immédiatement un écran local à la
place de la page, layouts conservés. Notes fournit `app/notes/[id]/loading.tsx` :
avec `AIRTTY_LATENCY_MS=500 bun run dev`, ouvrir une note affiche son squelette
pendant l’attente, et `app/notes/layout.tsx` garde son historique local d’une note à
l’autre. Échap annule et revient à la dernière page résolue.

Au tout premier démarrage, le framework affiche aussi un « Connecting… » pulsé
localement pendant que le premier arbre Flight arrive.

Un refresh conserve l’éditeur monté avec un indicateur « Refreshing… ». Notes anime
localement la luminosité grise de son squelette pendant l’attente ; cette animation
est arrêtée au démontage et ne fait aucun appel réseau. L’application peut fournir
ses propres `loading.tsx` Client, hérités depuis les répertoires parents.
Voir le [contrat de navigation](docs/API.md#navigation-et-chargement-local).

## Démo complexe : Forge

`examples/forge` est une forge de code review dans le terminal (PR, diffs colorés,
commentaires de ligne, CI en direct, merge) qui exerce ensemble toutes les capacités
du framework, d'OpenTUI et de TanStack Router :

```sh
bun run forge                           # importe aussi les derniers commits de ce dépôt
AIRTTY_LATENCY_MS=500 bun run forge   # même parcours sous 500 ms de RTT
bun run forge:operator lose merge       # second opérateur : réponse perdue, conflit, push
```

Comptes `alice`, `bob`, `carol`, PIN `forge`. Clavier, scénario de démonstration de
cinq minutes, matrice de preuves et limites : [docs/FORGE.md](docs/FORGE.md).

## Nouveau starter

Depuis le checkout du framework :

```sh
bun src/cli.ts init /tmp/my-airtty-app
cd /tmp/my-airtty-app
bun install
bun run check
bun run dev
# Plus tard, après arrêt du mode dev :
bun run build
```

Le starter contient une seule codebase `app/`, `components/`, `actions/`, `server/`.
Sa dépendance locale `airtty` utilise `file:` vers ce checkout ;
conserver celui-ci pendant le développement. `bun install` installe le CLI et les
outils du starter. Il n’y a aucun manifest ni RPC à écrire. Le starter possède
son `tsconfig.json`, les configurations Oxc et les réglages VS Code.
Le CLI est aussi déclaré sous le nom `airtty` dans `package.json` ; dans ce
checkout, `bun src/cli.ts` exécute les mêmes commandes sans installation globale.

## Production : deux artefacts

Depuis le checkout du framework :

```sh
bun run build
bun src/cli.ts start --role server
# Dans un autre terminal :
bun src/cli.ts start --role client --url http://127.0.0.1:3000
```

Pour distribuer le Client sans Bun ni `node_modules` sur la machine du terminal :

```sh
bun src/cli.ts build --compile                        # exécutable pour cette machine
./examples/notes/.airtty/client/notes-darwin-arm64 --url http://127.0.0.1:3000
```

Le binaire embarque le runtime Bun, la bibliothèque native d’OpenTUI et l’identifiant
de build. Le runtime est par défaut celui que Bun publie sur npm pour la cible
(`@oven/bun-<os>-<arch>`, même version que le Bun du build) : il est téléchargé à la
première compilation, vérifié contre l’empreinte `integrity` publiée par le registre,
puis réutilisé depuis `$XDG_CACHE_HOME/airtty` (`~/.cache/airtty`) sans réseau.
`airtty runtime [--target …]` remplit ce cache à l’avance. Hors ligne et sans cache,
la compilation échoue en le disant. `--runtime host` embarque le Bun qui exécute le
build (le build avertit s’il dépend de bibliothèques hors système, Nix ou Homebrew :
le binaire ne démarrerait pas sur une autre machine) ; `--runtime <chemin>` embarque
un exécutable Bun choisi. `--target bun-linux-x64` (et `--native-dir` pour le paquet
natif de cette cible) produit un binaire pour une autre plateforme.

`--app /chemin/app` sélectionne un autre projet. Le build produit :

```text
app/.airtty/
  manifest.json           # build, graphes, route graph et Client References
  client/                 # index.js, package.json, bun.lock
  server/                 # index.js, package.json, bun.lock
```

Copier **tout le répertoire du rôle** sur sa machine cible puis installer ses
dépendances. Aucune source Server n’est nécessaire sur la machine Client :

```sh
# Dans la copie server/ :
bun install --frozen-lockfile
NODE_ENV=production NOTES_DB=/chemin/notes.sqlite PORT=3000 \
  bun --conditions=react-server index.js

# Dans la copie client/, sur la machine du terminal :
bun install --frozen-lockfile
NODE_ENV=production bun index.js --url http://127.0.0.1:3000
```

Les deux rôles doivent provenir du **même build**. Un hash de sources, runtime et
lockfile lie modules et actions ; un désaccord est refusé avant décodage, sans
réinitialiser les Drafts déjà montés. Les dépendances natives OpenTUI sont installées
pour la plateforme cible. Pour conserver un lockfile unique et vérifié, les deux
artefacts embarquent le même manifeste de dépendances, y compris l’outillage ;
le bundle Server n’importe pas OpenTUI et le bundle Client ne contient pas le métier.

## Connexion distante

Le Server écoute par défaut sur loopback. Pour une connexion privée, garder cette
écoute et utiliser un tunnel SSH :

```sh
ssh -N -L 3001:127.0.0.1:3000 user@server
NODE_ENV=production bun client/index.js --url http://127.0.0.1:3001
```

Avant toute exposition publique, placer le Server derrière un reverse proxy TLS,
limiter l’accès réseau au backend et configurer `AIRTTY_TOKEN` sur les deux rôles,
ou fournir l'adapter `server/auth.ts`. Une écoute hors loopback (`AIRTTY_HOST`)
est refusée sans l'un de ces deux mécanismes. Le Client transmet le token par en-tête
Authorization ; utiliser une URL HTTPS pour éviter sa transmission en clair. Les
requêtes portant un Origin de navigateur sont refusées.

Le MVP offre une **session mono-utilisateur** : le token est associé côté Server
à `AIRTTY_USER` (défaut `local`). `getSession()` fournit cette identité aux actions
et au repository, qui vérifie la propriété des notes. Une référence Flight ne donne
aucun droit par elle-même. Une authentification multi-utilisateur doit remplacer
cette association dans le runtime Server avant un tel déploiement. Ne jamais
placer un secret dans les sources Client ou une prop RSC.

Une application peut remplacer ce mode par `server/auth.ts`. Les pages et Server
Functions sont alors protégées par défaut ; une page ou un module d'actions public
déclare `export const auth = "public"`. `unauthorizedPath` redirige un Client sans
session vers une route publique, et `useApplication().setToken()` installe le bearer
obtenu par le flux de connexion. Le framework transporte la session ; login, stockage
du token, renouvellement et autorisations métier restent sous la responsabilité de
l'application. Voir [le contrat d'authentification](docs/API.md#authentification-des-routes-et-actions).

## TypeScript, Oxc et VS Code

Ouvrir ce checkout comme dossier racine VS Code pour appliquer `.vscode/`.
Installer les extensions TypeScript 7 et Oxc recommandées. Le serveur TypeScript natif
utilise le package local ; le SDK TypeScript 6 sert de repli pour l’extension classique.
Si un ancien diagnostic reste affiché, recharger la fenêtre VS Code.

```sh
bun run check          # TypeScript strict : sources, exemple, tests, scripts et sondes
bun run lint           # Oxlint, aucune erreur ni warning accepté
bun run lint:fix        # corrections automatiques sûres
bun run format         # Oxfmt
bun run format:check   # vérification sans écriture
```

`tsconfig.base.json` porte les options communes (Bun/Node, JSX OpenTUI, modules ESM).
Le projet et les starters utilisent cette base ; les fichiers générés et
`node_modules` sont exclus. Prettier est remplacé par Oxlint 1.85.0 et Oxfmt 0.70.0,
versions épinglées. Oxc assure le lint/format ; le compilateur du framework utilise
l’API AST officielle `@typescript/typescript6` 6.0.2 et le bundler Bun, tandis que
les contrôles de types utilisent TypeScript 7.0.2. Voir le [guide de tooling](docs/TOOLING.md).

## Tests reproductibles

```sh
bun run probes               # les deux sondes d’origine, avec leurs lockfiles
bun run verify               # types, lint, format, intégration et build
bun run format:check
bun audit --json

python3 -m venv /tmp/airtty-pty
/tmp/airtty-pty/bin/pip install -r scripts/requirements-pty.txt
/tmp/airtty-pty/bin/python scripts/pty-smoke.py
/tmp/airtty-pty/bin/python scripts/pty-dev.py
PYTHON=/tmp/airtty-pty/bin/python bun scripts/clean-install.ts
```

Le dernier test part d’une copie sans dépendances ni artefacts, crée un starter,
installe les rôles séparément et pilote le Client de production dans un PTY.
La CI couvre macOS et Linux ; son workflow est fourni, son exécution hébergée
n’a pas encore eu lieu. Voir [les preuves et limites](docs/VALIDATION.md).

## Contrat et limites

- [Structure et distribution](docs/ARCHITECTURE.md).
- [Frontières de compilation](docs/BOUNDARIES.md) et [API minimale](docs/API.md).
- React/Flight 19.3.0, OpenTUI 0.5.12 et reconciler 0.33.0 (plage d'OpenTUI) exactement épinglés.
  L’adapter Flight est isolé dans `src/flight/` et doit être retesté à toute mise à jour.
- TanStack Router 1.170.38 est l’unique autorité de navigation ; Suspense progresse
  dans le flux Flight. Layouts Client imbriqués et persistants, groupes `(group)`,
  `[param]`, `[...catchAll]`, `loading.tsx`, `error.tsx` et `not-found.tsx` hérités,
  `notFound()`, search params et préchargement TanStack sont pris en charge ; pas de
  params optionnels ni de layout Server persistant. La navigation est typée par
  `app/routeTree.gen.ts`, généré par le build et versionné. Voir [ROUTER.md](docs/ROUTER.md).
- Le framework ne garde aucun état métier. Les Drafts de Notes et Forge sont du code
  applicatif, en mémoire, au plus 32 documents par session ; les Drafts sales/en
  attente ne sont pas évincés. **Quitter le Client perd les Drafts non sauvegardés.**
- Une Server Function déclare ses changements avec `invalidate()` ; `useLive` abonne un
  écran à une Server Function génératrice, fermée quand l’écran se démonte. Rien ne se
  reconnecte automatiquement.
- Un Client Component importe n’importe quel package, sans le déclarer. `server-only`
  et `client-only` gardent un module (applicatif ou npm) d’un seul côté ; `airtty.json`
  peut ranger côté Server un package tiers qui ne se déclare pas. Chaque erreur montre
  la chaîne d’imports. Voir [BOUNDARIES.md](docs/BOUNDARIES.md).
- Une erreur de build est affichée dans le shell existant et laisse l’édition active.
  Un rebuild valide redémarre les deux processus et **perd l’état du Client** (Drafts compris).
  Pas de Fast Refresh.
- Dans Notes, la sauvegarde et son résultat d’opération sont atomiques dans SQLite. La
  consultation résout un résultat perdu ; ce n’est pas une garantie générique
  exactly-once. Si aucun résultat n’est retrouvé, l’opération reste inconnue et n’est
  pas rejouée.
- Distribution par bundle applicatif de confiance. Le point de résolution de modules
  reste remplaçable ; ni téléchargement de code distant, ni Client universel, ni sandbox.
  Le Client peut être livré en un seul exécutable (`build --compile`) ; binaires non
  signés ni notarisés.
- Le parcours distant a été testé macOS → Linux via SSH ; aucune campagne WAN,
  mesure écran physique ou garantie de résistance à une boucle infinie Client.
