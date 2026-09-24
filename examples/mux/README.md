# mux : multiplexeur local

Des programmes locaux côte à côte, chacun sur son PTY, dans une application airtty :
un petit tmux construit avec `<Terminal>` (`airtty/client`). C'est le mode `process` de
[EMBEDDING.md](../../docs/EMBEDDING.md) : aucune isolation, les programmes ont vos droits.

```sh
bun src/cli.ts dev --app examples/mux        # bun run mux
MUX_PANES='[["htop"],["vim","README.md"]]' bun run mux
```

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
fermeture d'un pane, redimensionnement, sortie sans programme orphelin).
