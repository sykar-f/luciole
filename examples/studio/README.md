# studio

Décrire une application luciole à un agent de code et **s'en servir pendant qu'il l'écrit**.
À gauche la conversation avec le harness (Claude Code, ou un générateur scripté),
à droite l'application générée, en marche, embarquée par le widget VT : un **brouillon**
après chaque fichier écrit, une **révision** après chaque tour, sans perdre ce que vous
faisiez dans l'app. Conception : [docs/studio/SPEC.md](../../docs/studio/SPEC.md).

## Lancement

Depuis la racine du monorepo (les dépendances sont `workspace:*` et `catalog:` : l'exemple
ne se lance pas depuis son propre dossier). Prérequis : Bun 1.4.2, `bun install
--frozen-lockfile` une fois, et — pour `-H claude` seulement — le binaire `claude`
dans le `PATH`, déjà connecté par vous (`claude auth login`) ; aucune clé API n'est
lue. `-H fake` n'exige rien. Attendez-vous à la conversation à gauche et, à droite,
l'application générée qui apparaît au premier brouillon.

```sh
bun run studio -- -H fake                    # générateur scripté : hors ligne, sans quota
bun run studio -- -H claude --project todos  # un projet nommé, sous $XDG_DATA_HOME/luciole/studio
bun run studio -- --dir ~/apps/notes -r      # un dossier ; -r reprend la dernière session
```

| Option                        | Effet                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------ |
| `-H, --harness`               | `claude` (défaut) ou `fake` (générateur scripté)                                           |
| `-d, --dir DIR`               | dossier du projet : vide (ou absent), il reçoit le template ; un projet studio est rouvert |
| `-p, --project NAME`          | projet sous `$XDG_DATA_HOME/luciole/studio/NAME` (défaut : un nouveau `app-<date>`)        |
| `-r, --resume [ID]`           | reprend la session du harness                                                              |
| `--preview sandbox\|process`  | aperçu confiné (défaut), ou avec vos droits                                                |
| `--fixes N`                   | corrections automatiques après un échec (défaut 2, au plus 5)                              |
| `-m, --model`, `-e, --effort` | modèle et effort, tels que le harness les nomme                                            |

> **Attention.** L'agent hérite de tout l'environnement de studio (variables, clés
> comprises) et écrit dans le dossier du projet avec vos droits. Studio demande les
> permissions au mode `ask` et n'offre pas `--mode` ; le mode `full` de coder, qui
> désactive le bac à sable de l'agent (`danger-full-access` chez Codex), n'y est pas
> proposé, mais ne l'activez dans aucun harness lancé à côté sur ce dossier. De même,
> `--preview process` fait tourner l'application générée avec vos droits, sans confinement.

Codex, pi et opencode restent réservés à coder pour l'instant : studio ne sait pas empêcher
Codex de lancer des commandes (son protocole n'a pas de mode sans commandes), et les
demander à studio échoue avec cette raison.

Chaque génération consomme le quota de **votre** abonnement ou de votre clé : studio ne
parle jamais à un modèle lui-même, il pilote le binaire officiel déjà installé et connecté
(mêmes règles que coder, [CODER-HANDOFF.md](../../docs/CODER-HANDOFF.md) §3 ; la licence
de l'Agent SDK d'Anthropic n'est pas OSI : usage personnel et non commercial). Une
correction automatique est un tour de plus.

## Pendant le tour : les brouillons

Chaque écriture du harness (celles de 300 ms regroupées) donne un brouillon : le même
garde-fou (un fichier refusé ne tourne jamais, même en brouillon), un build à part, un
Server confiné, et l'aperçu bascule dessus. Le cadre dit ce qu'il montre : `draft` ou
`r12`, et `◐ draft` pendant qu'un brouillon se construit. Rien n'est commité, corrigé ni
renvoyé au harness : en plein tour un fichier importe souvent un fichier pas encore écrit,
donc un brouillon en échec garde l'écran qui marchait et l'écrit en haut du cadre
(« draft · waiting for a build that works »). Un seul brouillon à la fois ; une écriture
plus récente l'emporte sur celui qui tourne. La fin du tour reste celle d'avant.

**Ce qui survit** à un brouillon comme à une révision, en `sandbox` comme en `process` : la
page et l'historique, le texte des champs nommés, le champ qui a le focus
(`useRestoredFocus`) et la position des listes (`<ScrollBox name>`), ainsi que les données
dans `data/`. Le reste de la mémoire de l'app est perdu. Les instructions de studio
demandent donc de nommer chaque champ ; un `<Input>` ou `<Textarea>` sans `name` donne un
**conseil** (dans la conversation, puis avec votre message suivant au harness), jamais un
refus ni une correction.

Avec `-H fake`, le prompt « Add a guestbook page with a form to sign it » écrit en quatre
fois (une pause de `STUDIO_FAKE_WRITE_MS`, 1,5 s par défaut, entre deux écritures), puis
« Show how many people signed the guestbook » le modifie : tapez un nom dans le livre d'or
(`g` depuis l'accueil, `Tab` entre les champs, `PageDown` dans la liste) et regardez-le
survivre aux brouillons.

## Ce qui se passe après chaque tour

1. **Garde-fou** : les fichiers changés doivent être des `.ts`/`.tsx` sous `app/`,
   `components/`, `server/`, `actions/`, et n'importer que les paquets permis (voir
   `STUDIO.md` dans le projet). Un changement refusé est annulé.
2. **Build** à part (`.luciole-studio/builds/`), signé par la clé propre au projet.
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
au-dessus de l'aperçu. Linux : le Client confiné existe (`luciole-sandbox`), pas encore le
Server confiné ; le mode `sandbox` y est donc refusé pour l'instant.

## Architecture

```
app/args.ts            options (zod)
app/page.tsx           Server : ouvre le projet, rend le premier état
components/            Client : StudioScreen (conversation, aperçu, révisions), Preview
actions/studio.ts      "use server" : feed, state, send, respond, restore, allowHost…
server/studio.ts       la boucle : session du harness, brouillons, validation, révisions, corrections
server/drafts.ts       quand faire un brouillon : écritures regroupées, un à la fois
server/harness.ts      adaptateur, choix du harness, options de démarrage
server/project.ts      dossier, template, dépôt git, verrou
server/preview.ts      build signé, Server confiné, tsc
server/validate.ts     garde-fou puis build
server/guard.ts        chemins et imports permis, conseils (champs sans nom) ; policy.ts : réponses aux demandes
server/generator.ts    le harness scripté : il écrit vraiment, d'après scenarios.ts
template/              le projet de départ ; server/template.gen.ts l'embarque
```

`bun examples/studio/scripts/template.ts` régénère `server/template.gen.ts` après une
modification du template (un test vérifie qu'il est à jour).

## Tests

```sh
bun test tests/studio-project.test.ts tests/studio-scenarios.test.ts tests/studio-drafts.test.ts tests/studio.test.tsx
bun run test:pty:studio                            # brouillons et continuité, en sandbox puis en process
bun scripts/studio/measure.ts --harness fake      # la mesure de l'étape 6, sur le générateur
```

## Mesure sur Claude Code

Le 27 septembre 2026, avant les brouillons, avec votre accord, sur Claude Code 2.1.283 (Agent SDK 0.3.283, modèle
par défaut du compte : `claude-opus-5-5`) : les 13 prompts des scénarios, chacun dans un
projet neuf (les scénarios `guestbook` et `signatures` sont venus après), avec les
instructions, les outils et la politique de studio
(`scripts/studio/measure.ts --harness claude --accept-quota` ; résultats bruts :
[docs/studio/measures/claude-2026-09-27.json](../../docs/studio/measures/claude-2026-09-27.json)).

| Mesure                              | Résultat                                                  |
| ----------------------------------- | --------------------------------------------------------- |
| bons au premier essai               | **8/13**                                                  |
| bons après corrections (2 au plus)  | **13/13**                                                 |
| tours du harness                    | 21                                                        |
| durée d'un tour et de sa validation | médiane 14 s (8 à 45 s), 5,6 min en tout                  |
| coût rapporté par le SDK            | 1,41 $ en tout, médiane 0,06 $ par prompt (0,04 à 0,31 $) |

Le coût est celui que Claude Code rapporte ; sur un abonnement, il se compte en quota.
Le rendu dans l'aperçu n'est pas mesuré (le script n'ouvre pas de Client).

**Les 5 échecs venaient de studio, pas du modèle** : le template importait `node:fs`
(que le garde-fou refuse) dans le fichier que toute donnée touche, et un tour refusé
n'était annulé qu'en partie, d'où un build cassé juste après. Corrigés depuis (template
sans `node:fs`, tour refusé annulé en entier, diagnostics de build qui nomment le fichier),
**sans nouvelle mesure**. Aucune faute prévue par les scénarios (syntaxe, import inventé,
hook côté Server, mauvais type ou propriété, paquet ou commande interdits) n'a été commise
par Claude Code ; il a refusé de lui-même de lancer des tests, et une fois répondu à une
question (la branche git) au lieu de l'afficher dans l'app. Il a aussi mentionné un
connecteur claude.ai de votre compte : `isolated` les écarte désormais (types du SDK,
non revérifié sur un run).
