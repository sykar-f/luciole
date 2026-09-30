# coder

Une session d'agent de code dans un terminal, comme `claude`, `codex`, `pi` ou
`opencode` — **une session, un dossier, un agent** — mais avec le harness choisi au
lancement. coder ne parle jamais à un modèle et ne lit aucun jeton : il pilote les
binaires officiels déjà installés et connectés par l'utilisateur.

```sh
bun run coder -- --harness fake          # démo scriptée, hors ligne, sans quota
bun run coder -- -H codex --mode edits   # développement (luciole dev … --)
luciole ./examples/coder -H claude --resume
coder --help                             # binaire compilé : aide générée depuis app/args.ts
```

| Option                          | Effet                                                                   |
| ------------------------------- | ----------------------------------------------------------------------- |
| `-H, --harness`                 | `claude`, `codex`, `pi`, `opencode`, ou `fake` (démo scriptée)          |
| `-C, --cwd DIR`                 | dossier du projet (défaut : là où la commande est tapée)                |
| `-m, --model`, `-e, --effort`   | modèle et effort de raisonnement, tels que le harness les nomme         |
| `--mode read\|ask\|edits\|full` | permissions (défaut `ask` : chaque écriture ou commande est demandée)   |
| `-r, --resume [ID]`             | reprend la dernière session du dossier, ou celle-ci                     |
| `--new`                         | nouvelle session au lieu de rattacher un lancement interrompu (runtime) |

Sans `--harness`, coder prend le premier harness prêt dans l'ordre claude, codex,
opencode, pi, sinon il dit ce qui manque. `CODER_HARNESS` et `CODER_CWD` tiennent lieu de
`--harness` et `--cwd` quand la ligne de commande ne les donne pas.

## Démo web

Le site fait tourner coder dans la page (`luciole build --web-local`, docs/WEB.md) : le
Server vit dans un Worker, sans processus ni réseau, donc sur le harness `fake` seul.
`website/scripts/demo.ts` lui donne `CODER_HARNESS=fake` et un projet fictif
(`CODER_CWD=/home/ada/src/timers`). Dans le Worker, `server/session.ts` importe
`@luciole/harness/adapters`, que le `package.json` de `packages/harness` résout en
`src/adapters/browser.ts` sous la condition `browser` : l'Agent SDK de Claude
(`readline`, `net`) et les autres adaptateurs n'y entrent pas.

Avec le harness `fake`, la ligne d'état affiche **« Scripted demo · no model calls »** à
la place de « powered by … » (`SCRIPTED` dans `packages/harness/src/ui/StatusLine.tsx`), au terminal
comme dans la page : aucun drapeau à ajouter côté site.

Le scénario du site se joue avec le prompt `DEMO_PROMPT` (`packages/harness/src/adapters/fake.ts`) :
raisonnement, lecture de `src/duration.ts` (appel d'outil), réponse en streaming, diff à
approuver (`y` en mode `ask`), `bun test` puis la main rendue sur `DEMO_END`. Mêmes
textes et mêmes durées affichées à chaque fois ; environ 12 s une fois le prompt envoyé.

## Ce que montre l'exemple

coder est aussi la vitrine de luciole ; chaque capacité du framework y sert :

| Capacité                               | Ici                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Server / Client séparés                | le Server possède la session : le Client peut crasher ou être rebuildé, l'agent continue        |
| `app/args.ts` (`luciole/args`)         | vraie ligne de commande, `--help` et erreurs générés, lue par le Server (`cli.get()`)           |
| `"server": "per-launch"`               | deux `coder` dans le même dossier = deux sessions ; un Client tué retrouve la sienne            |
| `useLive`                              | un snapshot puis des patchs (`{seq, items, removed, fields}`), pas un snapshot toutes les 50 ms |
| issues `not-sent / rejected / unknown` | une approbation n'est jamais rejouée : une issue inconnue est consultée (`requestState`)        |
| champs nommés restaurés                | le prompt en cours survit à un crash ou à un rebuild                                            |
| `useBindings` + `<KeyHelp>`            | modes clavier (prompt, parcours, dialogue, sélecteur) et barre d'aide générée                   |
| `host.notify`                          | notification quand une requête attend et que le terminal n'a pas le focus                       |
| `renderer.suspend()`                   | Ctrl+G : écrire le prompt dans `$EDITOR`                                                        |
| `<Markdown>`                           | réponses et « thinking » stables pendant le streaming                                           |
| OpenTUI                                | `<diff>` par fichier, `<code>`, textarea, overlays, sélection + OSC 52                          |

## Clavier

| Mode     | Touches                                                                                                                                                                                                                                              |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt   | ⏎ envoyer (pendant un tour : injecter, ou mettre en file si le harness ne sait pas) · ⌥⏎ mettre en file · Maj+⏎ / Ctrl+J nouvelle ligne · Échap interrompre · Maj+Tab mode suivant · Ctrl+G éditeur · Ctrl+O parcours · `/` commandes · `@` fichiers |
| Parcours | `j`/`k` bloc · ⏎/Espace plier · `a` tout plier · `y` copier le bloc · `g`/`G` haut/bas · `i` ou Échap retour                                                                                                                                         |
| Dialogue | `y` une fois · `s` pour la session · `a` toujours · `n` refuser · chiffres pour les options · Échap refuser et interrompre                                                                                                                           |
| Partout  | PgUp/PgDn défiler · Fin suivre · Ctrl+R rouvrir le flux · Ctrl+C quitter (le harness est arrêté)                                                                                                                                                     |

Commandes de l'app : `/new`, `/resume`, `/model`, `/effort`, `/mode`, `/plan`, `/compact`,
`/status`, `/help` ; celles du harness (skills, prompts, plugins) s'ajoutent telles qu'il
les expose. Une commande que le harness ne sait pas faire n'apparaît pas.

## Architecture

```
app/args.ts           options (zod) : lues par le lanceur et par le Server
app/page.tsx          Server : démarre la session, rend le premier snapshot
components/           Client : SessionScreen, Completion, éditeur externe
actions/session.ts    "use server" : send, interrupt, respond, setModel, setMode, feed…
server/session.ts     la session de ce lancement, sur la HarnessSession du paquet harness
server/config.ts      arguments et lancement ; launches.ts : session reprise après un rebuild
```

Le reste est partagé avec studio dans `packages/harness` (`@luciole/harness`, paquet privé
du workspace) :

```
src/session.ts        HarnessSession : état, items, requêtes, journal de révisions → patchs
src/adapters/         un adaptateur par harness, vers un vocabulaire neutre (types.ts)
src/detect.ts         harness installé, version, connecté ? — sans requête au modèle
src/jsonl.ts          lecteur JSON-lines (LF seulement) et client JSON-RPC
src/model.ts          le vocabulaire neutre, commun au Server et au Client
src/ui/               Client : Transcript, Dialogs, Picker, StatusLine, store du flux…
```

Les réponses et les blocs « thinking » passent par `<Markdown>` (`luciole/client`), pas par le
`<markdown>` d'OpenTUI : pendant le streaming, celui-ci redessine le dernier bloc depuis un
aperçu puis depuis Tree-sitter, et la réponse clignote. Le composant découpe la réponse en
blocs (`marked`), fige tous les blocs sauf le dernier, met le texte en forme sans
Tree-sitter et ferme d'avance les marqueurs ouverts du dernier bloc ; le rendu d'une
réponse finie est celui de `<markdown conceal>`. Décisions et mesures :
`docs/streaming-markdown/STATUS.md`.

Les adaptateurs traduisent chaque protocole en événements neutres (`turn.*`, `item.*`,
`request.*`, `plan.updated`, `usage.updated`…). Les actions rendent la main tout de
suite (délai de 10 s des actions luciole) ; la progression passe par le flux.

## Conformité

- **Claude Code** : piloté par l'Agent SDK avec le binaire `claude` de l'utilisateur, non
  modifié et connecté par lui ; jamais le binaire embarqué du SDK, jamais `--bare`, aucun
  appel aux endpoints OAuth, aucun user-agent emprunté. La licence de l'Agent SDK
  Anthropic n'est **pas** une licence OSI : cet exemple est destiné à un usage personnel,
  non commercial.
- **Aucun secret n'est lu** : ni `~/.claude/.credentials.json`, ni le trousseau, ni
  `~/.codex/auth.json`, ni les valeurs des `auth.json` de pi et d'opencode. La connexion
  est toujours déléguée au harness (`claude auth login`, `codex login`, `/login` dans pi,
  `opencode auth login`).
- **Pas d'OAuth Anthropic dans pi ni dans opencode** : les modèles Anthropic y sont
  bloqués quand la connexion est un abonnement Claude ; utilisez `--harness claude`.
- **opencode** : un `opencode serve` par session, sur 127.0.0.1, derrière un mot de passe
  tiré au hasard à chaque lancement ; le partage public des sessions est désactivé.
- **Codex** se voit présenter coder sous son nom (`clientInfo.name = "luciole-coder"`).
- Chaque harness consomme **le quota de l'utilisateur**. Le harness `fake` n'en consomme
  aucun : tests, démo web et découverte de l'interface.
- « powered by … » en texte seulement : aucune marque n'est reprise.

## Tests

```sh
bun test tests/coder.test.tsx tests/coder-store.test.ts   # vrai Server + Client rendu, harness factice
bun run test:pty:coder                                    # parcours PTY complet, harness factice
bun run test:web:coder                                    # la démo web dans Chrome headless
bun test tests/markdown*.test.ts*                         # <Markdown> : blocs figés, fermeture, parité
bun run test:pty:markdown                                 # 0 oscillation en streaming (mot-clé `markdown`)
```

Les parcours sur les vrais harnesses sont manuels : ils consomment un peu de quota.

```sh
bun scripts/pty/coder-real.ts claude|codex|pi|opencode [modèle]
bun scripts/pty/markdown-stability.ts claude|codex|pi|opencode   # une réponse Markdown réelle
```

Les adaptateurs sont testés sur des échanges enregistrés une fois sur les vrais binaires
(`scripts/coder/record-*.ts` → `tests/fixtures/coder/`), rejoués pas à pas
(`tests/coder-{claude,codex,pi,opencode}.test.ts`).
