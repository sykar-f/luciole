# mux : multiplexeur local

Des programmes locaux côte à côte, chacun sur son PTY, dans une application luciole :
un petit tmux construit avec `<Terminal>` (`@luciole-sh/core/client`). C'est le mode `process` de
[EMBEDDING.md](../../docs/EMBEDDING.md) : aucune isolation, les programmes ont vos droits.

## Lancement

Sans cloner le dépôt : `luciole example mux` lance cet exemple depuis le tag git de la
version de luciole installée ([docs/DISTRIBUTION.md](../../docs/DISTRIBUTION.md#exemples)).
Les variables d'environnement et les clés ci-dessous s'appliquent de la même façon.

Depuis la racine du monorepo (les dépendances sont `workspace:*` et `catalog:` : l'exemple
ne se lance pas depuis son propre dossier). Prérequis : Bun 1.4.2 et `bun install
--frozen-lockfile` une fois. Aucune clé API, aucun réseau ;
les programmes des panes (`$SHELL`, `vim`, `htop`…) doivent être installés.

```sh
bun run mux                                              # votre shell, et vim s'il est installé
MUX_PANES='[["htop"],["vim","README.md"]]' bun run mux
```

`bun run mux` est `luciole dev --app examples/mux`.

Un pane peut aussi être une autre application luciole, affichée inline (`<Embed>`) avec
son Server déjà lancé : son bundle d'application (`.luciole/app`, sans runtime) est évalué
contre le runtime du multiplexeur.

```sh
bun packages/core/src/cli.ts build --app examples/mdreader               # produit .luciole/
bun --conditions=react-server examples/mdreader/.luciole/server/index.js &   # PORT=3000
MUX_APPS='[{"name":"docs","bundle":"examples/mdreader/.luciole/app","url":"http://127.0.0.1:3000"}]' bun run mux
```

Mêmes touches, même préfixe : `Ctrl+O` passe d'un terminal à l'application et
inversement ; dans l'application, `Ctrl+C` ferme son pane. `inline` = confiance totale :
l'application tourne dans le processus du multiplexeur.

Au départ : votre `$SHELL` et, si vim est installé, vim. Un pane dont le programme se
termine se ferme ; le dernier ferme le multiplexeur.

| Touches           | Action                                       |
| ----------------- | -------------------------------------------- |
| `Ctrl+O` puis `o` | pane suivant                                 |
| `Ctrl+O` puis `c` | nouveau shell                                |
| `Ctrl+O` puis `v` | vim (s'il est installé)                      |
| `Ctrl+O` puis `x` | fermer le pane actif                         |
| `Ctrl+O` puis `q` | quitter                                      |
| clic              | donner les touches au pane                   |
| tout le reste     | au programme du pane actif, `Ctrl+C` compris |

Les panes vivent dans le layout racine (`components/Mux.tsx`) : ils persistent quelle
que soit la page. La ligne d'aide est la page, rendue par le Server.

Smoke PTY : `bun run test:pty:mux` (shell et vim, `Ctrl+C` vers le shell, préfixe,
fermeture d'un pane, redimensionnement, sortie sans programme orphelin ; puis mdreader
inline à côté d'un shell).
