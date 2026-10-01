# Notes — un carnet personnel

Un carnet dans le terminal : liste de notes, éditeur Markdown, recherche, étiquettes,
renommage, copie, suppression avec annulation. Les notes vivent dans une base SQLite
**côté Server** ; le Client n'en voit que ce que les Server Functions lui renvoient. Le
même exemple sert d'application de bureau (`luciole` : nom, identifiant et icône dans son
`package.json`) et de démo web.

## Lancement

Depuis la racine du monorepo (les dépendances sont `workspace:*` et `catalog:` : l'exemple
ne se lance pas depuis son propre dossier) :

```sh
bun install --frozen-lockfile    # une fois, Bun 1.4.2
bun packages/luciole/src/cli.ts dev --app examples/notes
```

Il n'y a pas de script `bun run` pour cet exemple. Aucune clé API, aucun réseau. Au
premier lancement, la base `notes.sqlite` est créée dans le répertoire courant et
remplie de quelques notes d'exemple ; la liste est à gauche, la note ouverte à droite.

| Variable             | Défaut         | Rôle                                                                       |
| -------------------- | -------------- | -------------------------------------------------------------------------- |
| `NOTES_DB`           | `notes.sqlite` | Fichier SQLite des notes (relatif au répertoire courant).                  |
| `LUCIOLE_USER`       | `local`        | Propriétaire des notes : chaque utilisateur voit les siennes.              |
| `NOTES_AUTOSAVE_MS`  | `1000`         | Délai de sauvegarde après la dernière frappe ; `0` : à la main (`Ctrl+S`). |
| `NOTES_DELAY_MS`     | `0`            | Délai ajouté à chaque action, pour voir les états d'attente.               |
| `LUCIOLE_LATENCY_MS` | `0`            | Latence réseau simulée avant chaque requête.                               |

## Clavier

| Touche     | Action                                                            |
| ---------- | ----------------------------------------------------------------- |
| `↑` / `↓`  | Note précédente / suivante (la liste ou la recherche a le focus)  |
| Entrée     | Ouvrir la sélection, puis éditer la note ouverte                  |
| `Ctrl+E`   | Passer en édition / la terminer                                   |
| `Ctrl+S`   | Enregistrer (ou réessayer après un échec)                         |
| Échap      | Terminer l'édition, fermer un menu                                |
| clic droit | Menu d'une note : ouvrir, renommer, copier en Markdown, supprimer |
| `Ctrl+C`   | Quitter                                                           |

## Vérification

```sh
bun run test:web           # le même exemple dans un navigateur headless (runtime web, Zig 0.16.0)
```
