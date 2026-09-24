# Distribution et lancement des apps

Une même bibliothèque, `src/launcher/`, lance une app d'où qu'elle vienne. Elle sert
`airtty <cible>`, `airttyx <cible>` et les binaires d'app autonomes ; le registre
(`src/registry/`) installe et met à jour les apps publiées.

## Lancer : `airtty <cible>`

Résolution explicite, première correspondance (`resolveTarget`) :

| Cible                                | Exemple                                 | Effet                                                           |
| ------------------------------------ | --------------------------------------- | --------------------------------------------------------------- |
| chemin (`./`, `../`, `/`, `~/`, `.`) | `airtty ./examples/notes`               | build, puis lancement local                                     |
| app installée                        | `airtty notes`                          | son binaire                                                     |
| spec npm                             | `airtty @ada/notes@^1.2`                | installée après confirmation si absente, puis lancée            |
| source git                           | `airtty github:ada/tools#v1/apps/notes` | fetch, confirmation, install, build (en cache), lancement local |
| URL de Server                        | `airtty https://notes.example.com`      | refusée : « non supporté encore » (pas de Client générique)     |

Un mot nu (`notes`) est une app installée s'il en existe une, sinon une spec npm. Un
chemin relatif sans `./` est refusé avec cette indication plutôt que deviné.

Les arguments qui suivent la cible vont à l'app. Un répertoire buildé (chemin, git)
accepte `--url <url>` (Client seul), vérifié avant le build ; un binaire reçoit tout
(`--url`, `--on`, `serve`). `--yes` accepte sans demander installations et commits.

`airttyx <cible>` fait la même chose sans jamais lire la cible comme une
sous-commande : `airttyx build` lance l'app nommée `build`.

Une spec npm déjà installée dans une version qui la satisfait est lancée sans
interroger le registre, donc aussi hors ligne.

## Lancement local : un socket, pas de port

`startServer` (`src/launcher/local.ts`) démarre le Server avec `AIRTTY_SOCKET` :
`serve()` écoute alors sur ce socket Unix (mode 0600) au lieu de TCP, dans un répertoire
0700 créé pour ce lancement (`$XDG_RUNTIME_DIR`, sinon `$TMPDIR` s'il est assez court
pour `sun_path`, sinon `/tmp`). Pas de conflit de port entre apps ni entre deux copies
de la même, et personne d'autre ne peut s'y connecter. La ligne `ready` du Server nomme
alors `socket` au lieu de `port`.

Le Client reçoit `--url unix:/chemin/s` ; `connect()` (`src/connect.ts`) envoie ses
requêtes par ce socket, sans changement de `client.tsx` ni de `transport.ts`.

Durée de vie : le lanceur garde ouverte l'entrée standard du Server sans jamais y
écrire (`--attached`, `src/launcher/attach.ts`). Quand le lanceur se termine, même
tué par SIGKILL, ou quand ssh perd la connexion d'un Server distant, stdin atteint sa
fin et le Server s'arrête. Ni fichier pid, ni scrutation.

Ce que le Server écrit va dans `$XDG_STATE_HOME/airtty/<app>/server.log`, jamais sur
l'écran du Client ; un Server qui ne démarre pas est expliqué par la fin de ce log.
Le Server tourne dans le répertoire courant de l'utilisateur, comme toute commande :
Notes y crée `notes.sqlite`, mdreader y lit ses fichiers.

## Binaire autonome à deux rôles

```text
airtty build --compile [--name notes] [--target t] …   → .airtty/bin/notes-<target>
```

Le binaire contient le Client **et** le Server d'un même build, plus le lanceur
(`src/launcher/binary.ts`) :

| Commande                                         | Rôle                                                        |
| ------------------------------------------------ | ----------------------------------------------------------- |
| `notes`                                          | les deux, ici ; Server sur socket privé                     |
| `notes serve [--http [host]:port \| --socket p]` | Server seul (sans option : `PORT`, `AIRTTY_HOST`, …)        |
| `notes --url <url>`                              | Client seul                                                 |
| `notes --on [user@]host[:port] [--target f]`     | Server sur l'hôte (installé au besoin), Client ici, via ssh |
| `notes --version`                                | identité : app, build ID, cible                             |

`--http :8080` écoute sur la boucle locale ; `0.0.0.0:8080` doit être explicite (et
exige toujours `AIRTTY_TOKEN` ou `server/auth.ts`, comme `serve()`).

Un bundle ne peut pas contenir React sous deux conditions d'export : `compileApp`
(`src/compile.ts`) bundle d'abord le Server entier sous `react-server`, puis compile une
entrée qui importe l'une ou l'autre moitié selon le rôle. L'entrée Client générée exporte
désormais `run` (une ligne dans `build.ts`) : importée, elle n'est pas
`import.meta.main`. L'identité du binaire est écrite comme littéral
`airtty-binary:1:<app>:<buildId>:<cible>;` : `readBinaryIdentity` la lit dans les
octets d'un binaire étranger sans l'exécuter.

`--client-only` produit l'ancien artefact, Client seul, pour une app dont le code Server
ne doit pas arriver sur les postes des utilisateurs.

### `--on user@host`

1. Une connexion ssh maîtresse (`ControlMaster`, socket de contrôle privé) authentifie
   une fois ; sonde, envoi et Server la réutilisent. `AIRTTY_SSH` remplace `ssh`.
2. L'hôte donne son OS, son architecture, sa libc, et si
   `${XDG_DATA_HOME:-~/.local/share}/airtty/apps/<app>/<buildId>/<app>` existe.
3. Sinon : le binaire se copie lui-même si la cible est la sienne, sinon il envoie celui
   de `--target`, dont l'identité doit être la même app, le même build et la cible de
   l'hôte. Un répertoire verrou contenant le pid de l'envoyeur fait attendre les
   lancements concurrents ; un verrou dont le pid est mort est repris. La taille reçue
   est vérifiée avant le `mv` final.
4. `<app> serve --socket /tmp/airtty-<aléa>/s --attached` démarre dans un répertoire
   `mkdir -m 700`, transféré socket à socket par la même commande ssh (`-L`). Le
   Server s'arrête avec ssh, son répertoire est supprimé.

Les scripts distants passent par `sh -c '<script>'` et ne contiennent ni apostrophe ni
barre oblique inverse : bash, zsh et fish les transmettent tels quels à `sh`.

`airtty connect ssh://host/dir/sock` sait aussi joindre un socket distant.

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
inchangé → lancé directement. Nouveau commit → fetch, confirmation,
`bun install --frozen-lockfile` (s'il y a un `bun.lock`, celui de l'app ou d'un espace de
travail englobant), build, lancement. Build refait aussi si `bun.lock` ou les sources
du framework ont changé. Un sha complet ou un tag ne bouge pas : aucune vérification
après la première résolution. Hors ligne, une branche relance son dernier checkout avec
un avertissement. Un verrou par commit sépare les lancements concurrents.

**Confiance.** Un dépôt est du code arbitraire, Server compris ; les scripts
d'installation et les macros du bundler s'exécutent avant l'app. Au premier lancement
d'un dépôt et à chaque nouveau commit, le lanceur affiche le dépôt, le commit (sha,
sujet, auteur, date) et le commit précédemment accepté, puis demande confirmation
**avant** install et build. La réponse est mémorisée par URL dans
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
// @ada/notes-linux-x64 : { "os": ["linux"], "cpu": ["x64"], "libc": ["glibc"], "files": ["bin"] } + bin/notes
```

Ce sont de vrais paquets installables ; le registre n'est jamais utilisé comme base de
données : ce qui est installé est noté localement.

```text
airtty build --compile --name notes --target bun-darwin-arm64 --outfile dist/notes-darwin-arm64
airtty build --compile --name notes --target bun-linux-x64 --native-dir … --outfile dist/notes-linux-x64
airtty pack --package @ada/notes --version 1.2.0 dist/notes-*   → npm/…, à publier plateformes d'abord
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

## Répertoires (XDG)

| Quoi                                  | Où                                                        |
| ------------------------------------- | --------------------------------------------------------- |
| apps installées, installations `--on` | `$XDG_DATA_HOME/airtty/apps/<app>/`                       |
| checkouts et builds git               | `$XDG_CACHE_HOME/airtty/git/`                             |
| confiance accordée aux dépôts         | `$XDG_CONFIG_HOME/airtty/trust.json`                      |
| logs des Servers lancés               | `$XDG_STATE_HOME/airtty/<app>/{server,remote-server}.log` |
| sockets                               | `$XDG_RUNTIME_DIR`, `$TMPDIR` ou `/tmp`, répertoires 0700 |

## Limites connues

- La session restaurable d'un Client lancé localement est rattachée à son URL, donc au
  socket, différent à chaque lancement : la reprise après crash ne s'applique pas encore
  aux lancements locaux. Il faudrait que `run()` accepte une clé de session stable.
- Le Server d'un binaire est bundlé entier : un module natif `.node` côté Server n'est
  pas encore pris en charge (Notes n'en a pas).
- `--on` ne nettoie pas les anciens builds sur l'hôte distant.
- Le registre npm privé (jeton) n'est pas géré ; `update` ne concerne pas les sources git.
- `hostTarget()` ne détecte pas musl : sur Alpine, `install` choisirait le binaire glibc.
