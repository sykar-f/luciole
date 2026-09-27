# studio

Décrire une application airtty à un agent de code et **s'en servir pendant qu'il l'écrit**.
À gauche la conversation avec le harness (Claude Code, Codex, ou un générateur scripté),
à droite l'application générée, en marche, embarquée par le widget VT et rechargée après
chaque tour. Conception : [docs/studio/SPEC.md](../../docs/studio/SPEC.md).

```sh
bun run studio -- -H fake                    # générateur scripté : hors ligne, sans quota
bun run studio -- -H claude --project todos  # un projet nommé, sous $XDG_DATA_HOME/airtty/studio
bun run studio -- --dir ~/apps/notes -r      # un dossier ; -r reprend la dernière session
```

| Option                        | Effet                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `-H, --harness`               | `claude`, `codex`, ou `fake` (générateur scripté) ; sans lui, le premier prêt de claude, codex |
| `-d, --dir DIR`               | dossier du projet : vide (ou absent), il reçoit le template ; un projet studio est rouvert     |
| `-p, --project NAME`          | projet sous `$XDG_DATA_HOME/airtty/studio/NAME` (défaut : un nouveau `app-<date>`)             |
| `-r, --resume [ID]`           | reprend la session du harness                                                                  |
| `--preview sandbox\|process`  | aperçu confiné (défaut), ou avec vos droits                                                    |
| `--fixes N`                   | corrections automatiques après un échec (défaut 2, au plus 5)                                  |
| `-m, --model`, `-e, --effort` | modèle et effort, tels que le harness les nomme                                                |

Chaque génération consomme le quota de **votre** abonnement ou de votre clé : studio ne
parle jamais à un modèle lui-même, il pilote le binaire officiel déjà installé et connecté
(mêmes règles que coder, [CODER-HANDOFF.md](../../docs/CODER-HANDOFF.md) §3 ; la licence
de l'Agent SDK d'Anthropic n'est pas OSI : usage personnel et non commercial). Une
correction automatique est un tour de plus.

## Ce qui se passe après chaque tour

1. **Garde-fou** : les fichiers changés doivent être des `.ts`/`.tsx` sous `app/`,
   `components/`, `server/`, `actions/`, et n'importer que les paquets permis (voir
   `STUDIO.md` dans le projet). Un changement refusé est annulé.
2. **Build** à part (`.airtty-studio/builds/`), signé par la clé propre au projet.
3. **Server** de l'application démarré **confiné** : il lit son build, écrit `data/`, ne
   joint aucun réseau sauf les hôtes que vous autorisez, ne lance aucun programme.
4. **Révision** : un commit du dépôt git que studio tient dans le projet (identité
   `studio`, jamais la vôtre) ; l'aperçu passe à la nouvelle révision.
5. **Types** vérifiés à côté (`tsc`), sans bloquer l'aperçu ; une **page en échec** dans
   l'aperçu est signalée par son Client lui-même.

Un échec revient au harness sous forme d'un message `[studio] …` (fichier, ligne, message),
au plus `--fixes` fois de suite et jamais deux fois pour le même échec ; ensuite la main
est à vous. Le harness n'a que des outils de fichiers (Claude : `Read`, `Write`, `Edit`,
`Glob`, `Grep`), les instructions de studio, aucun de vos réglages (hooks, MCP), et studio
refuse toute commande qu'il demande.

## Clavier

`Ctrl+O` est la seule touche que studio garde ; tout le reste va au panneau actif, l'aperçu
compris (`Ctrl+C` y va à l'application).

| Touches           | Action                                                         |
| ----------------- | -------------------------------------------------------------- |
| `Ctrl+O` puis `o` | conversation ↔ application (un clic aussi)                     |
| `Ctrl+O` puis `p` | application plein écran                                        |
| `Ctrl+O` puis `r` | relancer l'application (même révision, Server neuf)            |
| `Ctrl+O` puis `u` | revenir à la révision précédente (comme une nouvelle révision) |
| `Ctrl+O` puis `d` | ce qu'a changé la révision affichée                            |
| `Ctrl+O` puis `h` | les révisions : en choisir une la restaure                     |
| `Esc`             | interrompre le tour du harness                                 |

Commandes : `/allow HOST` et `/deny HOST` (réseau de l'application, écrit par studio dans
son `package.json`), `/restore N`, `/restart`, `/revisions`.

## Isolation

Par défaut l'aperçu est **confiné** : Server et Client de l'application sous Seatbelt
(macOS). Sans mécanisme disponible, studio ne démarre pas l'aperçu et dit pourquoi ;
`--preview process` le lance quand même, **avec vos droits**, et l'écrit en permanence
au-dessus de l'aperçu. Linux : le Client confiné existe (`airtty-sandbox`), pas encore le
Server confiné ; le mode `sandbox` y est donc refusé pour l'instant.

## Architecture

```
app/args.ts            options (zod)
app/page.tsx           Server : ouvre le projet, rend le premier état
components/            Client : StudioScreen (conversation, aperçu, révisions), Preview
actions/studio.ts      "use server" : feed, state, send, respond, restore, allowHost…
server/studio.ts       la boucle : session du harness, validation, révisions, corrections
server/harness.ts      adaptateur, choix du harness, options de démarrage
server/project.ts      dossier, template, dépôt git, verrou
server/preview.ts      build signé, Server confiné, tsc
server/validate.ts     garde-fou puis build
server/guard.ts        chemins et imports permis ; policy.ts : réponses aux demandes
server/generator.ts    le harness scripté : il écrit vraiment, d'après scenarios.ts
template/              le projet de départ ; server/template.gen.ts l'embarque
```

`bun examples/studio/scripts/template.ts` régénère `server/template.gen.ts` après une
modification du template (un test vérifie qu'il est à jour).

## Tests

```sh
bun test tests/studio-project.test.ts tests/studio-scenarios.test.ts tests/studio.test.tsx
bun run test:pty:studio
bun scripts/studio/measure.ts --harness fake      # la mesure de l'étape 6, sur le générateur
```

La mesure avec un vrai harness (`--harness claude|codex --accept-quota`) n'a pas encore
été faite : elle consomme votre quota.
