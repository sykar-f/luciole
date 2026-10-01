# Forge — une forge de code dans le terminal

Pull requests, relectures, commentaires, checks CI en direct et fusion, sur le modèle
d'une forge de code : le Server tient une base SQLite (dépôts, utilisateurs, sessions,
audit) et simule la CI ; le Client dessine l'interface. C'est l'exemple le plus complet
de luciole : routes et navigation, authentification par session, formulaires, brouillons,
actions dont la réponse peut se perdre, flux live.

## Lancement

Depuis la racine du monorepo (les dépendances sont `workspace:*` et `catalog:` : l'exemple
ne se lance pas depuis son propre dossier) :

```sh
bun install --frozen-lockfile    # une fois, Bun 1.4.2
bun run forge
```

`bun run forge` lance `luciole dev` sur cet exemple avec `FORGE_GIT_REPO=.` : les dépôts
de démonstration s'accompagnent de l'historique git réel du clone, importé comme dépôt
`luciole`. Pour s'en passer :

```sh
bun packages/luciole/src/cli.ts dev --app examples/forge
```

Aucune clé API, aucun réseau. Au premier affichage, la page de connexion attend un
utilisateur et un PIN : `alice` (mainteneuse), `bob` (contributeur) ou `carol` (lectrice),
PIN `forge`. Attendez-vous ensuite à l'Inbox : les pull requests qui demandent votre relecture,
tous dépôts confondus.

| Variable             | Défaut         | Rôle                                                             |
| -------------------- | -------------- | ---------------------------------------------------------------- |
| `FORGE_DB`           | `forge.sqlite` | Base SQLite, créée au besoin dans le répertoire courant.         |
| `FORGE_CI_SCALE`     | `1`            | Facteur de durée des runs CI simulés (plus petit : plus rapide). |
| `FORGE_GIT_REPO`     | —              | Dépôt git à importer (`bun run forge` y met `.`).                |
| `FORGE_GIT_COMMITS`  | `8`            | Nombre de commits importés.                                      |
| `FORGE_SLOW_MS`      | `250`          | Délai ajouté aux opérations lentes, pour la démo.                |
| `FORGE_CLOCK_START`  | —              | Date ISO de départ de l'horloge du Server (captures stables).    |
| `LUCIOLE_LATENCY_MS` | `0`            | Latence réseau simulée avant chaque requête.                     |

Les touches sont rappelées en bas de l'écran (`?` ouvre l'aide complète).

## Un second opérateur

Pour rejouer des conflits pendant qu'un Client est ouvert, un script agit sur la même
base depuis un autre terminal (depuis la racine, avec le même `FORGE_DB`) :

```sh
bun run forge:operator push payments 1            # nouvelle révision : les approbations deviennent périmées
bun run forge:operator approve payments 1 bob
bun run forge:operator lose merge                 # la prochaine réponse de fusion est perdue après commit
```

`bun run forge:operator` sans argument affiche l'usage complet.

## Vérification

```sh
bun run test:pty:forge     # parcours PTY sur les artefacts construits, Server et Client séparés
bun run test:web:forge     # navigateur headless : Google Chrome (`CHROME=` pour un autre chemin) et runtime web (Zig 0.16.0, `ZIG=`)
```
