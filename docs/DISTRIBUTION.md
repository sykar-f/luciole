# Distribution et lancement des apps

Une même bibliothèque, `src/launcher/`, lance une app d'où qu'elle vienne. Elle sert
`airtty <cible>`, `airttyx <cible>` et les binaires d'app autonomes ; le registre
(`src/registry/`) installe et met à jour les apps publiées.

## Lancer : `airtty <cible>`

Résolution explicite, première correspondance (`resolveTarget`) :

| Cible                                | Exemple                                 | Effet                                                               |
| ------------------------------------ | --------------------------------------- | ------------------------------------------------------------------- |
| chemin (`./`, `../`, `/`, `~/`, `.`) | `airtty ./examples/notes`               | build, puis lancement local                                         |
| app installée                        | `airtty notes`                          | son binaire                                                         |
| spec npm                             | `airtty @ada/notes@^1.2`                | installée après confirmation si absente, puis lancée                |
| source git                           | `airtty github:ada/tools#v1/apps/notes` | fetch, confiance, install, build (en cache), lancement local        |
| URL de Server                        | `airtty https://notes.example.com`      | Client générique : bundle signé, clé épinglée, `sandbox` par défaut |

Une URL de Server ouvre l'app par son bundle signé (`/manifest`, `/bundle/<sha256>`) dans
le Client générique, en onglets (plusieurs URL possibles) : voir
[EMBEDDING.md](EMBEDDING.md), étapes 5, 7 et 8. Elle s'ouvre dans le mode `sandbox` où il
confine aussi le réseau (macOS ; Linux avec espaces de noms ou bubblewrap, grâce à
`native/airtty-sandbox`, livré compilé) ; ailleurs, rien ne s'ouvre sans `--sandbox` ou
`--inline` explicite (mémorisé par origine) ; `airtty trust <url> <SHA256:…>` épingle hors
bande une nouvelle clé d'éditeur.

Un mot nu (`notes`) est une app installée s'il en existe une, sinon une spec npm. Un
chemin relatif sans `./` est refusé avec cette indication plutôt que deviné.

Les arguments qui suivent la cible vont à l'app. Un répertoire buildé (chemin, git)
accepte `--url <url>` (Client seul) et `--grace <durée>`, vérifiés avant le build, puis
les options que l'app déclare dans `app/args.ts` ([API.md](API.md#arguments-de-lapplication)),
vérifiées par son schéma avant que son Server démarre ; `--help` liste les unes et les
autres. Un binaire reçoit tout (`--url`, `--on`, `serve`, les options de l'app). `--yes`
accepte sans demander installations et commits.

Les options de l'app configurent son Server : elles lui arrivent par `AIRTTY_ARGS`, pas
par sa ligne de commande (visible de tous par `ps`) ; avec `--on`, par l'entrée standard
du `serve --detach` distant. Elles sont refusées avec `--url`, `airtty connect` et le
Client générique, qui rejoignent un Server déjà configuré. Une option inconnue ou une
valeur refusée sort avec le code 2.

`airttyx <cible>` fait la même chose sans jamais lire la cible comme une
sous-commande : `airttyx build` lance l'app nommée `build`.

Une spec npm déjà installée dans une version qui la satisfait est lancée sans
interroger le registre, donc aussi hors ligne.

## Lancement local : un socket, pas de port

`ensureServer` (`src/launcher/managed.ts`) démarre le Server avec `AIRTTY_SOCKET` :
`serve()` écoute alors sur ce socket Unix (mode 0600) au lieu de TCP, dans le répertoire
0700 de l'utilisateur (`$XDG_RUNTIME_DIR/airtty`, sinon `/tmp/airtty-<uid>`, dont le
propriétaire et le mode sont vérifiés). Le chemin est stable : `<sha256(clé de
session)[:16]>.sock`. Pas de conflit de port, et personne d'autre ne peut s'y connecter.
Deux lancements de la même cible partagent le même Server.

Le Client reçoit `--url unix:/chemin/s` ; `connect()` (`src/connect.ts`) envoie ses
requêtes par ce socket, sans changement de `transport.ts`.

La session restaurable du Client (historique et champs, reprise après crash) est
rattachée à une clé stable plutôt qu'à l'URL du socket, qui change à chaque lancement.
Elle part de la cible : `local:<répertoire>` pour un chemin, `git:<url>[/<dir>]` pour une
source git (un nouveau commit garde les sessions), `local:<app>` pour un binaire,
`ssh:<hôte>/<app>` avec `--on`. Le lanceur la passe par `AIRTTY_SESSION_KEY` ou
`run(create, { name, sessionKey })`.

### Qui partage un Server : `airtty.server`

L'application choisit dans son `package.json` quels lancements partagent un Server, et
son délai de grâce par défaut (`--grace` l'emporte) :

```jsonc
{ "airtty": { "server": "per-launch", "grace": "10m" } }
```

| `server`          | Clé                                | Pour                                                 |
| ----------------- | ---------------------------------- | ---------------------------------------------------- |
| `shared` (défaut) | `<cible>[#<empreinte>]`            | Notes, mdreader : un Server pour tous les lancements |
| `per-directory`   | `<cible>@<cwd>[#<empreinte>]`      | une app qui écrit dans le répertoire où on la lance  |
| `per-launch`      | `<cible>@<cwd>[#<empreinte>]!<id>` | coder : une session d'agent par lancement            |

L'empreinte est celle des arguments de l'application, après validation : **un Server = un
jeu d'arguments**, jamais hérité d'un autre lancement. Elle est absente pour une app qui
n'en déclare pas (clés inchangées). `GET /lifetime/status` la rend (`args`), avec l'id du
lancement (`launch`) : un Server d'un autre jeu d'arguments n'est jamais rattaché. Le
Server tourne dans le répertoire où la commande a été tapée ; `getLaunch()`
(`airtty/server`) rend `{ scope, id?, cwd }`.

`per-launch` donne à chaque lancement son Server. Quand un Client meurt (crash, terminal
fermé), son Server attend en grâce ; le lancement suivant dans le même répertoire, avec
les mêmes arguments, **réclame** le fichier de session laissé par ce Client (renommage
atomique, `claimOrphan` de `src/session.ts`), en tire l'id du lancement et retrouve ce
Server, son état, sa route et ses champs nommés. `--new` démarre toujours un lancement
neuf. Deux relances simultanées ne réclament jamais la même session. `airtty dev` est
déjà un Server par exécution : il se déclare `per-launch`, d'id sa session de
développement.

Ce que le Server écrit va dans `$XDG_STATE_HOME/airtty/<app>/server.log`, jamais sur
l'écran du Client ; un Server qui ne démarre pas est expliqué par la fin de ce log.
Le Server tourne dans le répertoire courant de l'utilisateur, comme toute commande :
Notes y crée `notes.sqlite`, mdreader y lit ses fichiers.

## Binaire autonome à deux rôles

```text
airtty build --compile [--name notes] [--target t] …   → .airtty/bin/<os>-<arch>/notes (+ native/)
```

Le binaire contient le Client **et** le Server d'un même build, plus le lanceur
(`src/launcher/binary.ts`) :

| Commande                                                      | Rôle                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------- |
| `notes [--grace d] [options]`                                 | les deux, ici ; Server sur socket privé                     |
| `notes serve [--http [host]:port \| --socket p] [-- options]` | Server seul (sans option : `PORT`, `AIRTTY_HOST`, …)        |
| `notes serve --detach --id <id> [--grace d]`                  | Server géré, détaché (utilisé par `--on`)                   |
| `notes --url <url>`                                           | Client seul                                                 |
| `notes --on [user@]host[:port] [--target f] [--grace d]`      | Server sur l'hôte (installé au besoin), Client ici, via ssh |
| `notes --new`                                                 | lancement neuf, sans réclamer de session (`per-launch`)     |
| `notes --version`                                             | identité : app, build ID, cible                             |

`--http :8080` écoute sur la boucle locale ; `0.0.0.0:8080` doit être explicite (et
exige toujours `AIRTTY_TOKEN` ou `server/auth.ts`, comme `serve()`).

Un bundle ne peut pas contenir React sous deux conditions d'export : `compileApp`
(`src/compile.ts`) bundle d'abord le Server entier sous `react-server`, puis compile une
entrée qui importe l'une ou l'autre moitié selon le rôle. L'entrée Client générée exporte
désormais `run` (une ligne dans `build.ts`) : importée, elle n'est pas
`import.meta.main`. L'identité du binaire est écrite comme littéral
`airtty-binary:1:<app>:<buildId>:<cible>;` : `readBinaryIdentity` la lit dans les
octets d'un binaire étranger sans l'exécuter.

Le build l'avertit à chaque `--compile` : le binaire contient le code Server, métier
compris, lisible par qui le reçoit. `--client-only` produit l'ancien artefact, Client seul, pour une app dont le code Server
ne doit pas arriver sur les postes des utilisateurs.

### Modules natifs côté Server

Un paquet à code natif (un addon `.node` et les bibliothèques qu'il lie) ne tient pas dans
un fichier unique. `src/native.ts` le reconnaît : il contient un `.node`, dépend d'un
chargeur (node-gyp-build, bindings, prebuild-install, node-pre-gyp) ou a, parmi ses
optionalDependencies, des paquets de plateforme (`os`/`cpu`) qui en contiennent un (sharp
et ses `@img/*`). Le build le laisse externe côté Server (un `onResolve` dans
`build.ts`) : `airtty ./app` le résout dans `node_modules` comme avant.

`--compile` pose alors, à côté du binaire, `native/node_modules/` avec ces paquets, leurs
dépendances et les seuls paquets de plateforme de la cible, dans la disposition
d'installation : l'addon de sharp trouve libvips par ses chemins relatifs
(`../../sharp-libvips-<plateforme>/lib`). Un binaire compilé ne résout aucun paquet à
l'exécution (vérifié : ni `require`, ni `createRequire`, ni `Bun.resolveSync`, ni un
plugin d'exécution) : le Server de ces apps est donc `native/server.js`, que le binaire
lance en se comportant comme Bun (`BUN_BE_BUN=1`, retiré aussitôt de l'environnement du
Server), avec la même interface (`serve`, cycle de vie, signaux, code de sortie).
`AIRTTY_NATIVE_DIR` remplace l'emplacement. Pour une autre plateforme, installer les
paquets de l'app pour cette cible **depuis son lockfile**, puis passer ce répertoire en
`--native-dir` : copier `package.json` et `bun.lock`, puis
`bun install --frozen-lockfile --os=linux --cpu=x64`. Les versions restent celles du
lockfile, comme sur la plateforme de build (`bun add` résoudrait la version du jour) ; un paquet sans code natif pour la cible est
refusé avec cette indication. `native/TARGET` empêche de mélanger deux cibles dans un
même répertoire.

`native/` voyage avec le binaire : dans l'archive de `--on` (couverte par
`SHA256SUMS`), dans le paquet npm de plateforme (`bin/native/`), et dans
`apps/<app>/<buildId>/` à l'installation. Référence : `examples/files` (miniatures sharp)
compilé fonctionne loin de tout `node_modules` (`tests/native.test.ts`).

### `--on user@host`

1. Une connexion ssh maîtresse (`ControlMaster`, socket de contrôle privé) authentifie
   une fois ; sonde, envoi et Server la réutilisent. `AIRTTY_SSH` remplace `ssh`.
2. L'hôte donne son OS, son architecture, sa libc, et si
   `${XDG_DATA_HOME:-~/.local/share}/airtty/apps/<app>/<buildId>/<app>` existe.
3. Sinon, ou si ce build ne correspond plus au `SHA256SUMS` écrit à son installation
   (fichier abîmé ou modifié, vérifié à chaque lancement par `sha256sum -c` ou
   `shasum -a 256 -c`) : le binaire se copie lui-même si la cible est la sienne, sinon il
   envoie celui de `--target`, dont l'identité doit être la même app, le même build et la
   cible de l'hôte. L'envoi est une archive tar avec son `SHA256SUMS`, extraite à côté,
   vérifiée, puis substituée en entier. Sans binaire pour la plateforme de l'hôte, un
   build altéré est refusé avec l'explication, jamais lancé. Un répertoire verrou
   contenant le pid de l'envoyeur fait attendre les lancements concurrents ; un verrou
   dont le pid est mort est repris.
4. `<app> serve --detach --id <id> --grace <ms> --env-stdin` retrouve le Server géré de
   cette clé (`ssh:<hôte>/<app>`, plus portée et empreinte) dans le répertoire runtime de
   l'hôte, ou en démarre un, détaché de ssh, puis rend la main avec le chemin de son
   socket. Les arguments de l'application et le lancement arrivent en une ligne JSON sur
   son entrée standard ; le répertoire du Server est celui de la session ssh.
5. Un tunnel `ssh -N -L <socket local>:<socket distant>` le relie au Client
   (`ServerAliveInterval=10`, `ServerAliveCountMax=3`). S'il tombe alors que le Client
   vit, il est relancé après 1 s, 2 s, 4 s… jusqu'à 30 s, sur le même socket local, sans
   invite (`BatchMode`) : le Client retrouve le même Server.

Les scripts distants passent par `sh -c '<script>'` et ne contiennent ni apostrophe ni
barre oblique inverse : bash, zsh et fish les transmettent tels quels à `sh`.

`airtty connect ssh://host/dir/sock` sait aussi joindre un socket distant.

## Cycle de vie du Server

Local ou `--on`, le même mécanisme (`src/launcher/lifetime.ts` dans le Server,
`managed.ts` dans le lanceur, `connect.ts` dans le Client) :

| Événement                                                                                   | Effet                                                                   |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Le Client tourne                                                                            | ping `POST /lifetime/ping` toutes les 10 s (toute requête compte aussi) |
| Ctrl+C, `app.quit` (sortie volontaire)                                                      | `POST /lifetime/leave` ; dernier Client parti : arrêt immédiat          |
| Aucune requête ni ping pendant 30 s (watchdog)                                              | ce Client est perdu                                                     |
| Fin de l'entrée standard du Server sans `leave` (lanceur local mort, crash, terminal fermé) | le Client du lanceur est perdu                                          |
| Dernier Client perdu                                                                        | grâce : 15 min par défaut, `--grace <durée>`, `0` = arrêt immédiat      |
| Un Client revient pendant la grâce                                                          | rattaché, la grâce s'arrête                                             |
| Grâce écoulée                                                                               | arrêt                                                                   |

Le Server est détaché (sa propre session, sa sortie dans son log) : il survit au
lanceur, au terminal fermé et à ssh. Un nouveau lancement de la même cible avec la même
clé de session le retrouve à son socket et vérifie son build (`GET /lifetime/status`) :
même build et mêmes arguments, il s'y rattache ; sinon il l'arrête
(`POST /lifetime/stop`) et en démarre un nouveau. `--grace` se passe au lanceur (`airtty ./app --grace 5m`) ou au
binaire (`notes --grace 0`, `notes --on host --grace 1h`).

Pendant une coupure, le Client vivant voit ses pings échouer : il passe
« Disconnected », puis « Connected » dès qu'ils repassent (tunnel relancé), sans rien
perdre de son état. Un Client mort puis relancé rouvre sa route et ses champs nommés par
sa session (clé stable), auprès du même Server s'il est encore en grâce.

**Ce que garantit le framework** : un Server qui survit à la perte du Client pendant la
grâce, avec ses données en mémoire ; le tunnel rétabli ; la route et le texte des champs
nommés (`<Input name>`, `<Textarea name>`) restaurés. **Ce qui reste à l'application** :
tout autre état mémoire du Client (brouillons hors champs nommés, sélection, défilement :
voir les `draft.ts` de Notes et Forge), et le sens métier d'une opération dont l'issue
est `unknown` (a-t-elle eu lieu ? faut-il la rejouer ?), que seul le domaine sait
trancher, par exemple avec des identifiants d'opération idempotents.

## Sources git

`github:user/repo[#ref][/dir]`, `gitlab:…`, `https://github.com/user/repo[/tree/ref/dir]`,
`git+https://…`, `git+ssh://…/repo.git[/dir][#ref[/dir]]`, `git+file://…`. Une branche
contenant `/` ne peut pas s'écrire dans la forme `#ref/dir`.

Cache `$XDG_CACHE_HOME/airtty/git/<sha256(url)[:16]>/` :

```text
refs.json                  où pointait chaque ref, et si elle peut bouger (branche)
<sha>/<dépôt>/             checkout superficiel et sans blobs (--depth 1 --filter=blob:none)
<sha>/<dépôt>/<dir>/.airtty-launch.json   hash de bun.lock et du framework du dernier build
```

À chaque lancement d'une branche (ou du HEAD distant) : `git ls-remote`. Commit
inchangé → lancé directement. Nouveau commit → fetch, résumé des nouveaux commits,
`bun install --frozen-lockfile` (s'il y a un `bun.lock`, celui de l'app ou d'un espace de
travail englobant), build, lancement. Build refait aussi si `bun.lock` ou les sources
du framework ont changé. Un sha complet ou un tag ne bouge pas : aucune vérification
après la première résolution. Hors ligne, une branche relance son dernier checkout avec
un avertissement. Un verrou par commit sépare les lancements concurrents.

**Confiance.** Un dépôt est du code arbitraire, Server compris ; les scripts
d'installation et les macros du bundler s'exécutent avant l'app. La confiance porte
sur le **dépôt** (son URL) : au premier lancement d'un dépôt, le lanceur affiche l'URL et
le commit (sha, sujet, auteur, date) et demande confirmation **avant** install et build.
Un nouveau commit d'un dépôt accepté se lance sans question, après un court résumé des
nouveaux commits depuis le dernier lancé (sha court et sujet, dix au plus, puis « … » ;
hors ligne ou historique réécrit, le résumé le signale). Mémorisé dans
`$XDG_CONFIG_HOME/airtty/trust.json`. Sans terminal, la réponse est non (sauf `--yes`).
Le comportement par défaut de Bun est conservé : aucun script de cycle de vie d'une
dépendance ne s'exécute sauf si l'app la déclare dans `trustedDependencies`. Un
`package.json` sans `bun.lock` est refusé plutôt que résolu au jour du lancement.

## Registre

`Registry` (`src/registry/registry.ts`) : `search(text)`, `resolve(spec)`,
`download(release, target)`. L'implémentation npm (`src/registry/npm.ts`) n'utilise que
l'API publique de lecture (packuments, tarballs, `/-/v1/search`) ; l'adresse vient de
`AIRTTY_REGISTRY`, puis `NPM_CONFIG_REGISTRY`, puis `https://registry.npmjs.org`. Chaque
tarball est comparé à l'`integrity` publiée (les signatures npm ne sont pas vérifiées).

Une app publiée, à la manière d'esbuild :

```jsonc
// @ada/notes
{
  "name": "@ada/notes",
  "version": "1.2.0",
  "keywords": ["airtty-app"],
  "airtty": {
    "name": "notes", // commande et répertoire d'installation
    "buildId": "63a20f3e393090d17b459ff9",
    "binaries": {
      "bun-darwin-arm64": "@ada/notes-darwin-arm64",
      "bun-linux-x64": "@ada/notes-linux-x64",
    },
  },
  "optionalDependencies": { "@ada/notes-darwin-arm64": "1.2.0", "@ada/notes-linux-x64": "1.2.0" },
}
// @ada/notes-linux-x64 : { "os": ["linux"], "cpu": ["x64"], "libc": ["glibc"], "files": ["bin"] } + bin/notes (+ bin/native/)
```

Ce sont de vrais paquets installables ; le registre n'est jamais utilisé comme base de
données : ce qui est installé est noté localement.

Le champ `airtty` accepte aussi `capabilities` (schéma `src/capabilities.ts`, décision 3
d'[EMBEDDING.md](EMBEDDING.md)) : ce que l'app déclare pouvoir faire, lisible avant toute
exécution. Déclarer n'est pas appliquer : seul le mode `sandbox` les applique.

```text
airtty build --compile --name notes --target bun-darwin-arm64
airtty build --compile --name notes --target bun-linux-x64 --native-dir …
airtty pack --package @ada/notes --version 1.2.0 .airtty/bin/*/notes   → npm/…, plateformes d'abord
```

Installé dans `$XDG_DATA_HOME/airtty/apps/<app>/` : `installed.json` (paquet, version,
plage suivie, build, cible, registre) et `<buildId>/<app>`, la même disposition que
`--on` sur un hôte distant. Une mise à jour écrit le nouveau binaire à côté, bascule
`installed.json`, puis supprime l'ancien. Un binaire dont l'identité ne correspond pas à
ce que déclare son `package.json` est refusé.

| Commande                         | Effet                                                     |
| -------------------------------- | --------------------------------------------------------- |
| `airtty search [texte]`          | apps (`keywords:airtty-app`) correspondant au texte       |
| `airtty install <spec>… [--yes]` | installe ou bascule vers la version désignée              |
| `airtty update [app…]`           | chaque app vers la plus récente version de sa plage       |
| `airtty list`                    | apps installées                                           |
| `airtty remove <app>…`           | supprime l'app et ses binaires                            |
| `airtty pack …`                  | paquets npm à partir de binaires compilés d'un même build |

## Lanceur : `airtty` sans argument

`airtty` seul ouvre le lanceur, une app airtty (`src/launcher/airtty/`) lancée comme
n'importe quelle app locale (`src/launcher/home.ts`). Il liste les apps installées,
cherche dans le registre, installe, met à jour et supprime par ses Server Functions,
qui appellent la même bibliothèque (`src/registry/apps.ts`, `resolveTarget`). Son champ
accepte aussi toute cible d'`airtty <cible>` (chemin, source git, URL).

Pour lancer, le Server écrit la cible dans un fichier de passage privé
(`AIRTTY_LAUNCHER_HANDOFF`) et le Client quitte ; `airtty` lance alors la cible au
premier plan, terminal et invites de confiance compris, puis rouvre le lanceur avec
son issue (`AIRTTY_LAUNCHER_NOTICE` : code de sortie ou erreur). Quitter le lanceur sans
choisir termine `airtty`.

| Touche        | Effet                                                                                                 |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| Tab           | champ → apps installées → résultats                                                                   |
| Entrée        | champ : recherche, ou lance un chemin / une source git ; liste : lance ; résultat : installe et lance |
| `u`, `U`, `x` | met à jour l'app, toutes les apps, supprime l'app                                                     |
| `i`           | installe le résultat sans le lancer                                                                   |

Vérifié par `bun run test:pty:launcher` (hors ligne : app installée factice, registre
injoignable). Les capacités accordées à une URL sont mémorisées par origine
(`origin.json`, [EMBEDDING.md](EMBEDDING.md), étape 7).

## Répertoires (XDG)

| Quoi                                  | Où                                                         |
| ------------------------------------- | ---------------------------------------------------------- |
| apps installées, installations `--on` | `$XDG_DATA_HOME/airtty/apps/<app>/`                        |
| checkouts et builds git               | `$XDG_CACHE_HOME/airtty/git/`                              |
| confiance accordée aux dépôts         | `$XDG_CONFIG_HOME/airtty/trust.json`                       |
| clé d'éditeur (`airtty keys`)         | `$XDG_CONFIG_HOME/airtty/keys/publisher.pem`               |
| origines ouvertes par URL             | `$XDG_STATE_HOME/airtty/origins/<sha256(origine)>/`        |
| bundles téléchargés par URL           | `$XDG_CACHE_HOME/airtty/bundles/<sha256>.cjs`              |
| runtime web (`airtty build --web`)    | `$XDG_CACHE_HOME/airtty/web/<ABI>-<framework>/`            |
| logs des Servers lancés               | `$XDG_STATE_HOME/airtty/<app>/server.log` (de chaque hôte) |
| sockets des Servers gérés             | `$XDG_RUNTIME_DIR/airtty` ou `/tmp/airtty-<uid>` (0700)    |
| sockets des tunnels                   | `$XDG_RUNTIME_DIR`, `$TMPDIR` ou `/tmp`, répertoires 0700  |

## Limites connues

- `--on` ne nettoie pas les anciens builds sur l'hôte distant.
- Le tunnel relancé n'invite jamais (`BatchMode`) : une authentification par mot de
  passe seul ne se rétablit pas toute seule ; il faut relancer le Client.
- Le registre npm privé (jeton) n'est pas géré ; `update` ne concerne pas les sources git.
- `hostTarget()` ne détecte pas musl : sur Alpine, `install` choisirait le binaire glibc.
