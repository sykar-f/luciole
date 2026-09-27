# studio : décrire une application airtty, la voir se construire

Statut : **C5b livré** sur `studio/local` (étapes 0 à 4 et 7 du plan, section 8 ; l'étape 5,
Linux, et la mesure de l'étape 6 restent à faire), voir
[État de l'implémentation](#état-de-limplémentation-c5b). La conception (C5a) s'appuie sur
trois probes exécutés le 27 septembre 2026 (macOS 26.6.2 arm64, Bun 1.4.2) :
[studio-preview](../../probes/studio-preview/README.md),
[studio-server-sandbox](../../probes/studio-server-sandbox/README.md),
[studio-generate](../../probes/studio-generate/README.md). Les décisions sont en
[section 11](#11-décisions).

Hors de ce document : la version hébergée « Try it » (étude C6a), la publication npm et la
commande `npx airttyx studio` (C7, le nom `airtty` n'est pas définitif).

## Résumé

Un nouvel exemple, `examples/studio` : à gauche une conversation avec un harness local
(Claude Code ou Codex, par les adaptateurs d'`examples/coder`), à droite l'application
airtty que ce harness écrit, **en fonctionnement**, embarquée par le widget VT
(`<Terminal>`, [EMBEDDING.md](../EMBEDDING.md) section 4) et rechargée après chaque tour.

| Question                         | Proposition                                                                                                                       | Appui                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Qui construit et relance l'app ? | le Server de studio, en **fin de tour** (pas `airtty dev`, qui reconstruit à chaque écriture)                                     | probe studio-preview        |
| Comment vérifier une génération  | quatre étapes : garde-fou statique → build → rendu headless (aperçu mis à jour) ; `tsc` en parallèle                              | probe studio-generate       |
| Correction automatique           | diagnostics renvoyés au harness comme message de studio, 2 tentatives par défaut                                                  | probe studio-generate       |
| Isolation par défaut             | **Server de l'app confiné** (Seatbelt / `airtty-sandbox`) et **Client en `sandbox`**, bundle signé par une clé éphémère du projet | probe studio-server-sandbox |
| Réutilisation de coder           | extraire un paquet privé `packages/harness` (adaptateurs, modèle d'événements, session) après la fusion de C4                     | section 4                   |
| Web                              | C5c : page qui compose deux `iframe` (studio rejoué, révision précompilée de l'app) ; pas de widget VT dans le navigateur         | section 7                   |

## État de l'implémentation (C5b)

L'exemple est `examples/studio` ([README](../../examples/studio/README.md)) ; tout tourne
hors ligne sur le **générateur scripté** (`-H fake`), qui écrit vraiment le projet d'après
les scénarios du probe studio-generate. Ce qui s'écarte de la conception ci-dessous :

| Sujet                 | Conçu                                                    | Fait, et pourquoi                                                                                                                                                                                                                                   |
| --------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Étape « rendu »       | rendu headless dans le Server studio, puis G6 plus tard  | **G6 d'emblée** : le Client de l'aperçu signale ses pages en échec (`onFailure` d'`openSandbox`, IPC en mode `process`), le Client studio le transmet (`previewFailed`) ; pas de second rendu                                                       |
| Ordre                 | garde-fou → build → rendu → aperçu                       | garde-fou → build → **Server** (un Server qui ne démarre pas est un échec avec son stderr) → révision → aperçu ; `tsc` et le rapport de rendu ensuite. Une révision est donc « construite et démarrée », son éventuel problème y est noté           |
| Build                 | dans `.airtty/`                                          | un dossier par tentative sous `.airtty-studio/builds/` (`build(dir, output)`, `startAppServer({ output })`) : valider la suivante ne touche jamais celle que l'aperçu montre                                                                        |
| Bascule de panneau    | `Ctrl+O Tab`                                             | `Ctrl+O` puis `o`, comme le « pane suivant » de mux ; les séquences sont listées dans la ligne d'aide                                                                                                                                               |
| Options               | `--dir`, `--project`, `--resume`, `--preview`, `--model` | plus `--fixes N` (décision 3 : réglable) ; sans `--dir` ni `--project`, un nouveau projet `app-<date>`                                                                                                                                              |
| Capacités             | demande du harness, accord de l'utilisateur              | `/allow HOST` et `/deny HOST` : studio écrit `airtty.capabilities.net` et committe lui-même, le garde-fou ne s'applique qu'au harness ; les autres capacités ne sont pas encore proposées                                                           |
| Sans sandbox          | refus au lancement                                       | l'écran s'ouvre et dit pourquoi ; aucun message n'est envoyé au harness tant que studio ne tourne pas avec `--preview process`                                                                                                                      |
| Codex sans commandes  | « mode sans exécution si le protocole le permet »        | non trouvé dans le protocole : Codex tourne en `workspace-write` + `on-request`, qui ne demande une approbation que pour sortir du workspace ou le réseau (docs/coder/research/codex-report.md) ; les commandes dans le projet ne sont pas bloquées |
| Réels Claude et Codex | fixtures enregistrées, mesure (étape 6)                  | **non exécuté** (quota) : `scripts/studio/measure.ts` est prêt et refuse sans `--accept-quota` ; les options passées aux adaptateurs sont vérifiées par types et tests, pas contre les binaires                                                     |

Lacunes du framework comblées (section 7), chacune dans un commit à part, avec son test :
G1 (`confineServer`, macOS), G2, G3, G4, G5, G6, G7 (`airtty/dev`). L'implémentation en a
trouvé quatre autres, corrigées de même : le profil Seatbelt ne suivait pas un lien
`node_modules` lisible (le projet est hors du dépôt) ; `airtty/build` et `airtty/sandbox`
cherchaient les sources d'airtty par `import.meta` même une fois bundlés dans une
application (`src/sources.ts`) ; `TerminalView` est exporté par `airtty/client` (pas par
`airtty/sandbox`, que les Servers importent) ; `startAppServer` démarre une sortie de
build hors de `.airtty/`.

Mesures (générateur scripté, macOS 26.6.2, machine chargée par d'autres sessions) : le
parcours de bout en bout (`tests/studio.test.tsx`, trois prompts, une erreur de build et
une page en échec corrigées, une annulation) prend ≈ 25 s ; la mesure de
`scripts/studio/measure.ts --harness fake` donne 5/13 scénarios bons au premier essai et
13/13 après au plus deux corrections (ce sont des fautes écrites exprès, pas un taux réel).

## 1. Vision et périmètre

L'utilisateur décrit une application (« une liste de tâches avec des priorités, `j`/`k`
pour naviguer, `space` pour cocher ») ; studio la fait écrire par un harness dans un
dossier de projet partant d'un template, la construit, la montre et la laisse utiliser
tout de suite, dans le même terminal. Il itère en conversant (« ajoute un filtre »),
revient à une version précédente, puis garde le dossier : c'est une app airtty ordinaire
(`airtty dev --app <dossier>`).

C'est une vitrine d'airtty au même titre que coder : elle exerce l'embarquement
(`process`/`sandbox`), les capacités, le build comme bibliothèque, `useLive` et les
adaptateurs de harness.

Non-objectifs v1 : dépendances npm arbitraires dans l'app générée, apps multi-origines,
édition collaborative, hébergement, Windows (pas de PTY Bun), Linux avant la fin de C5b
(section 8).

## 2. UX

### 2.1 Disposition

Plein écran (comme coder) ; au-dessus de 120 colonnes, deux panneaux côte à côte, en
dessous, un seul panneau visible à la fois (`Ctrl+O o` bascule).

```text
┌ studio · todo-app · Claude Code (sonnet) ─────────────────────────── r4 · ✓ 1,6 s ┐
│ ▸ une liste de tâches, j/k, space pour cocher│┌ aperçu · sandbox ───────────────────┐│
│                                              ││ STUDIO APP · Connected              ││
│ ● Écrit app/todos/page.tsx, components/…     ││ [x] Try studio                      ││
│ ● Build ✓  Rendu ✓  Types ✓                  ││ [ ] Generate an app                 ││
│   → révision r4                              ││                                     ││
│                                              ││                                     ││
│ ▸ ajoute des priorités                       ││                                     ││
│ ● Build ✗ app/todos/page.tsx:12 …            ││                                     ││
│   correction automatique 1/2…                ││                                     ││
│                                              │└─────────────────────────────────────┘│
│ ╭──────────────────────────────────────────╮ │ r4 ✓ · données : data/ · Ctrl+O p     │
│ │ décrivez une modification…               │ │                                       │
│ ╰──────────────────────────────────────────╯ │                                       │
└ Ctrl+O : o panneau · p aperçu · u annuler · d diff · r relancer · ? aide ─────────┘
```

- **Barre haute** : projet, harness et modèle (texte « powered by … », pas de marque
  usurpée, CODER-HANDOFF §3.6), révision affichée, état de la dernière validation.
- **Conversation** : le transcript de coder (messages, outils, diffs repliés) plus des
  blocs propres à studio : validation (étapes et durées), révision créée, correction
  automatique en cours, garde-fou déclenché.
- **Aperçu** : le widget VT, cadre coloré selon l'état, ligne d'état (révision, mode
  d'isolation, capacités accordées).

### 2.2 Flux

```text
prompt ─▶ tour du harness ─▶ fin de tour ─▶ garde-fou ─▶ build ─▶ rendu headless ─▶ aperçu rechargé
              (streaming)         │             │ ✗         │ ✗          │ ✗                (révision rN)
                                  │             └───────────┴────────────┴─▶ diagnostics ─▶ correction
                                  │                                                     automatique (≤ 2)
                                  └─▶ tsc en parallèle du rendu ─▶ ✗ : correction automatique aussi
```

1. L'utilisateur envoie un prompt ; studio l'envoie au harness avec ses instructions
   (section 5.3). Le transcript se remplit en direct (`useLive`, comme coder).
2. Pendant le tour, l'aperçu **ne bouge pas** : il montre la dernière révision valide.
   Reconstruire à chaque écriture montrerait des états intermédiaires incohérents (un
   harness écrit plusieurs fichiers en plusieurs secondes ; `airtty dev` reconstruit
   150 ms après chaque écriture, constat 4 de studio-preview).
3. En fin de tour : validation (section 5.4). Si elle passe, studio crée la révision
   (commit dans le dépôt git du projet) et recharge l'aperçu.
4. Si une étape échoue : l'aperçu garde la révision précédente, la conversation montre
   le diagnostic, et studio relance le harness avec ce diagnostic (correction
   automatique), au plus 2 fois de suite par défaut ; ensuite la main revient à
   l'utilisateur (« corrige », « annule », ou il écrit autre chose).

Coût mesuré entre la fin d'un tour et l'aperçu rechargé : build 1,2–1,4 s (médianes ;
1,1–2,8 s), rendu headless ≈ 0,55 s, démarrage du Server confiné ≈ 70–95 ms, premier
écran du Client (pas mesuré seul en `sandbox` ; 280–330 ms pour mdreader d'après
EMBEDDING.md, étape 7). Budget : **≈ 2–3 s**, du même ordre qu'`airtty dev`
(1,4–2,6 s mesurés).

### 2.3 États

| État                     | Conversation                                                                      | Aperçu                                                                         |
| ------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| projet neuf              | invite « décrivez votre app » et 3 exemples                                       | le template (compteur) déjà en marche                                          |
| génération en cours      | streaming du harness, fichiers écrits                                             | dernière révision, bandeau discret « génération… »                             |
| en attente d'une réponse | question ou approbation du harness (dialogue de coder)                            | inchangé                                                                       |
| validation               | étapes cochées au fil de l'eau                                                    | inchangé                                                                       |
| garde-fou déclenché      | fichiers refusés et raison ; modifications annulées                               | inchangé                                                                       |
| build ou types en échec  | diagnostic (fichier:ligne quand il y en a) ; correction k/2                       | dernière révision valide, cadre orange « r3 affichée, r4 en échec »            |
| app plantée au rendu     | message de l'erreur (Server ou Client)                                            | l'écran d'erreur de l'app (TanStack) tant que non corrigé ; `Ctrl+O r` relance |
| Client de l'aperçu mort  | « l'aperçu s'est arrêté (code N) »                                                | dernier écran figé, cadre rouge, `Ctrl+O r` relance                            |
| harness déconnecté       | commande de connexion à lancer (`claude auth login`…), jamais de login par studio | inchangé                                                                       |
| isolation indisponible   | au lancement, avant toute génération : raison et choix explicite (section 6)      | —                                                                              |

### 2.4 Raccourcis

Même principe que mux et coder : `Ctrl+O` est la seule touche que l'hôte réserve, tout le
reste va au panneau actif ; dans l'aperçu, toutes les touches vont à l'app générée
(`Ctrl+C` compris), comme dans un terminal embarqué.

| Touches              | Action                                                                       |
| -------------------- | ---------------------------------------------------------------------------- |
| `Ctrl+O o`           | conversation ↔ aperçu (clic : même effet)                                    |
| `Ctrl+O p`           | aperçu plein écran / retour                                                  |
| `Ctrl+O r`           | relancer l'aperçu (même révision, Server neuf)                               |
| `Ctrl+O u`           | revenir à la révision précédente (le harness en est informé au tour suivant) |
| `Ctrl+O d`           | diff de la dernière révision (composant `<diff>` de coder)                   |
| `Ctrl+O h`           | historique des révisions : choisir, comparer, restaurer                      |
| `Esc` (conversation) | interrompre le tour ou la correction automatique                             |
| `Ctrl+O ?`           | aide (`KeyHelp`)                                                             |

Les commandes `/` de coder restent (`/model`, `/new`, `/resume`…), plus `/revert rN`,
`/open` (ouvre le dossier dans `$EDITOR` par `renderer.suspend()`), `/export <dir>`.

### 2.5 Sessions multiples

Un lancement de studio = **un projet** (un dossier) = une session de harness, comme coder
(`"server": "per-launch"`). Plusieurs projets = plusieurs lancements, dans des
terminaux ou des panes différents ; deux studios sur le même dossier sont refusés
(verrou de projet : deux harness qui écrivent les mêmes fichiers se contredisent).

```sh
studio [--harness claude|codex|fake] [--dir DIR | --project NAME] [--resume [ID]] \
       [--preview sandbox|process] [--model M]
```

`--new` est déjà un flag réservé du runtime (session neuve, sans rattachement) : un projet
se nomme donc par `--project`. Sans `--dir`, les projets vivent sous
`$XDG_DATA_HOME/airtty/studio/<nom>/` ; `--resume`
reprend la session du harness et la dernière révision (le harness sait déjà reprendre,
les révisions sont dans git).

**Révisions** : le projet est un dépôt git initialisé par studio (identité locale au
dépôt, jamais celle de l'utilisateur) ; chaque validation réussie est un commit
`studio: r4 · <prompt tronqué>`. Annuler = restaurer une révision dans l'arbre de
travail, en créer une nouvelle. airtty utilise déjà git pour ses sources git ; sans git,
studio refuse `u`/`h` et le dit (point 11.5).

## 3. Architecture

```text
            terminal de l'utilisateur
┌──────────────────────────────────────────────────────────────────────────────┐
│ Client studio (TUI)                                                          │
│  conversation (composants de coder)      aperçu : <Terminal>/TerminalView    │
│        ▲ useLive / actions                     │ PTY                          │
└────────┼───────────────────────────────────────┼──────────────────────────────┘
         │ HTTP (socket Unix, lanceur)           ▼
┌────────┴──────────────────────────┐   ┌──────────────────────────────────────┐
│ Server studio (per-launch)        │   │ Client de l'app générée              │
│  session harness (paquet harness) │   │  sandbox : Seatbelt / airtty-sandbox  │
│  workspace + git (révisions)      │   │  bundle .airtty/app signé (clé du     │
│  validateur (garde-fou, build,    │   │  projet), IPC des capacités médiées   │
│   rendu headless, tsc)            │   └──────────────┬───────────────────────┘
│  superviseur d'aperçu ────────────┼──── démarre ──┐  │ HTTP loopback
│   (révision, port, état)          │               ▼  ▼
│        │                          │   ┌──────────────────────────────────────┐
│        ▼ enfants                  │   │ Server de l'app générée              │
│  claude (Agent SDK) / codex       │   │  confiné : lit .airtty/, écrit data/, │
│  app-server, cwd = workspace      │   │  écoute un port loopback, rien d'autre│
└───────────────────────────────────┘   └──────────────────────────────────────┘
```

### 3.1 Où tourne quoi

| Élément                      | Processus                                                  | Pourquoi                                                                                        |
| ---------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| harness                      | enfant du **Server studio**, `cwd` = workspace             | comme coder : le Server possède la session, survit à un Client tué (grâce, `claimOrphan`)       |
| workspace                    | dossier du projet, dépôt git                               | l'app reste une app airtty ordinaire, utilisable sans studio                                    |
| build, `tsc`, rendu headless | **Server studio** (`airtty/build` est une entrée publique) | diagnostics structurés, build en fin de tour seulement ; lit les sources, hors sandbox          |
| Server de l'app générée      | enfant du Server studio, **confiné**, port loopback        | il exécute du code écrit par un modèle ; confiné, il ne lit que son build (probe)               |
| Client de l'app générée      | enfant du **Client studio**, sur un PTY                    | le PTY doit être dans le processus qui dessine ; en `sandbox`, lancé par `openSandbox` existant |

Le Server studio publie l'état de l'aperçu par `useLive` : `{ revision, state, url,
bundle, diagnostics }`. Le Client studio monte la vue du terminal **clé = révision** :
une révision nouvelle démonte l'ancien Client (fin par SIGTERM, section 3.3) et lance le
nouveau contre le nouveau Server.

### 3.2 Pourquoi pas `airtty dev` dans le widget

Le probe studio-preview montre que `airtty dev` dans `<Terminal>` marche tel quel
(rechargement 1,4–2,6 s, erreurs de build en bandeau). Il n'est pas retenu comme
superviseur :

1. il reconstruit à chaque écriture (états intermédiaires visibles pendant un tour) ;
2. ses erreurs de build vont au Client généré par IPC et s'affichent, rien ne revient
   à studio sous une forme exploitable (fichier, ligne) pour la correction automatique ;
3. il lance le Server généré comme son propre enfant, sans confinement possible
   séparément ;
4. il sort avec le code 0 quand le Client généré plante ;
5. fermé par SIGHUP (ce que fait `<Terminal>`), il laisse le Server et le Client générés
   orphelins (mesuré : 2 processus).

Studio reprend donc la logique de `src/commands/dev.ts` (build, attente de la ligne
`ready`, session `AIRTTY_SESSION` gardée d'un Client à l'autre, bearer passé en mémoire)
dans un **superviseur d'aperçu**, déclenché par la fin de tour. Proposition : extraire
cette logique de `dev.ts` dans un module du framework réutilisable (`src/dev/supervisor.ts`),
dont `airtty dev` devient un client (watcher → `rebuild()`), et studio un autre
(fin de tour → `rebuild()`). À décider en C5b selon la taille du diff.

### 3.3 Rechargement de l'aperçu

1. Validation réussie : build de la révision N dans `.airtty/` (verrou de build existant).
2. Signature du bundle d'app par la clé éphémère du projet
   (`AIRTTY_PUBLISHER_KEY` dans le dossier d'état du projet, jamais la clé d'éditeur de
   l'utilisateur), comme le fait `airtty build --sign-bundle`.
3. Démarrage du Server N confiné sur un port neuf ; attente de `ready` (≈ 70–95 ms).
4. `useLive` publie `{ revision: N, url, bundle }` ; le Client studio démonte la vue N−1
   (SIGTERM) et ouvre N : `openSandbox({ origin: "studio:<projet>", url, app, … })`, puis
   `TerminalView` avec `sandbox.spawn` (patron de `src/generic`).
5. Le Server N−1 est arrêté quand le Client N a rendu (ou après un délai), pour ne jamais
   montrer un cadre vide.

État conservé : la **route et les champs nommés** (session `AIRTTY_SESSION` partagée,
comme `airtty dev`) ; perdus : l'état en mémoire du Server et du Client (mesuré). Le
template range les données dans `data/` (`bun:sqlite`), seul répertoire inscriptible du
Server confiné : elles survivent aux révisions. `Ctrl+O r` relance la même révision.

Reconnexion : le Client généré ne se reconnecte pas seul (`useLive` non plus) ; comme le
Server change à chaque révision, le Client est toujours relancé, jamais reconnecté.

### 3.4 Mode `process` (repli)

Sans sandbox disponible (ou `--preview process` explicite) : Client généré lancé
directement (`bun .airtty/client/index.js --url …`) dans `TerminalView`, **fin par
SIGTERM** (`<Terminal>` envoie SIGHUP ; mesuré sans orphelin en SIGTERM), Server non
confiné. Avertissement permanent dans le cadre de l'aperçu : « aperçu non isolé : le
code généré a vos droits ».

## 4. Réutilisation de coder

### 4.1 Ce qui se partage

| Morceau d'`examples/coder`                                              | Studio                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `server/adapters/{types,claude,codex,fake}.ts` + protocoles             | tel quel ; pi et opencode possibles plus tard (même interface)               |
| `server/jsonl.ts`, `detect.ts`, `anthropic-guard.ts`, `diff.ts`         | tel quel (conformité incluse)                                                |
| `components/model.ts` (modèle neutre, `HarnessEvent`)                   | tel quel, plus des items propres à studio (validation, révision)             |
| `server/session.ts` (snapshot puis patchs, requêtes idempotentes, file) | à généraliser : studio y branche la fin de tour et la correction automatique |
| `components/` (Transcript, blocs, Composer, Dialogs, StatusLine)        | largement ; le panneau de studio est plus étroit                             |
| `server/pi-gate.ts`                                                     | non (pi pas en v1)                                                           |

### 4.2 Proposition : un paquet privé `packages/harness`

Importer `../coder/server/…` depuis `examples/studio` couplerait deux exemples par des
chemins relatifs et dupliquerait les tests. Proposition (non faite) :

- `packages/harness` (`@airtty/harness`, `private: true`, workspace) : adaptateurs,
  protocoles générés (Codex), jsonl, détection, garde de conformité, diff, modèle
  d'événements neutre (la partie non-UI de `components/model.ts`), et une `Session`
  paramétrable (hooks `onTurnCompleted`, messages synthétiques).
- Les composants UI restent dans coder en C5b ; ils ne rejoignent un paquet
  (`@airtty/harness-ui`) que si studio en réutilise vraiment l'essentiel.
- Dépendances : l'Agent SDK passe du `package.json` de coder à celui du paquet ;
  `overrides` racine (`no-bundled-claude`) inchangés ; `docs/DEPENDENCIES.md` mis à jour.

Impacts sur `examples/coder` : imports réécrits (15 fichiers de coder importent aujourd'hui
`server/` ou `components/model`), 14 fichiers de `tests/` et `scripts/` repointés, aucun changement de comportement ; `bun run verify` et `test:pty:coder`
doivent rester verts. **Conflit** : C4 (démo web scriptée de coder) touche aussi
`examples/coder` ; l'extraction se fait **après la fusion de C4** (ordre déjà prévu :
C4 avant C5b).

### 4.3 Ce que les adaptateurs doivent gagner

Vérifié dans les types installés : Agent SDK 0.3.283 `systemPrompt: { type: "preset",
preset: "claude_code", append }` et `disallowedTools` ; Codex 0.156.1
`ThreadStartParams.developerInstructions`. Ajouts proposés à `StartOptions` :

- `instructions?: string` → `append` (Claude), `developerInstructions` (Codex) ;
- `tools?: { deny: string[] }` → `disallowedTools` (Claude) ; Codex : mode sans
  exécution de commandes si le protocole le permet, sinon approbations refusées par
  studio (section 5.5) ;
- `policy?: (request) => Response | undefined` : studio répond lui-même aux
  approbations (écriture dans le périmètre : oui ; commande, réseau : non), sans
  déranger l'utilisateur ; ce que la politique ne tranche pas remonte comme dans coder.

### 4.4 Conformité

Studio hérite des règles non négociables de CODER-HANDOFF §3 sans exception : binaire
`claude` de l'utilisateur via l'Agent SDK, jamais le binaire embarqué ni `--bare`, zéro
secret lu, login délégué, `clientInfo.name = "airtty-studio"` pour Codex, mention
« powered by … », README qui rappelle que chaque génération consomme le quota de
l'utilisateur. La correction automatique consomme aussi du quota : elle est bornée
(section 5.4) et visible.

## 5. Génération fiable

### 5.1 Template de départ

Celui du probe ([probes/studio-preview/template](../../probes/studio-preview/template)),
à compléter :

```text
app/layout.tsx       "use client" : état de connexion + bandeau d'erreur de build
app/page.tsx         page Server : lit server/, passe les actions aux composants
components/*.tsx     composants Client ("use client")
actions/*.ts         "use server", arguments validés par Zod
server/*.ts          état et données (bun:sqlite dans data/)
data/                seul répertoire inscriptible à l'exécution
package.json         airtty.capabilities: {} ; dépendances figées par studio
STUDIO.md            aide-mémoire pour le harness (section 5.3), lisible par l'utilisateur
```

Il démarre et s'affiche tout de suite : l'aperçu n'est jamais vide.

### 5.2 Périmètre contraint

- **Fichiers** : `app/`, `components/`, `server/`, `actions/`, `.ts`/`.tsx` ; pas
  `package.json`, pas `app/routeTree.gen.ts` (écrit par le build), rien hors du projet.
- **Paquets** : `airtty/client`, `airtty/server`, `react`, `@opentui/core`,
  `@opentui/react`, `@tanstack/react-router`, `zod` ; built-ins sans effet externe
  (`crypto`, `path`, `url`, `util`, `events`, `buffer`) et `bun:sqlite`. Le reste
  demande une capacité (section 5.5).
- **Composants fournis** (v2, proposition) : un petit kit `studio-kit` (liste
  navigable, formulaire, tableau, onglets) dans le template, pour que le harness
  assemble plutôt qu'il ne réinvente la navigation clavier.

### 5.3 Instructions au harness

Injectées par l'adaptateur (`instructions`, section 4.3) et non par un fichier que le
modèle pourrait réécrire ; `STUDIO.md` en reprend le contenu pour l'utilisateur.
Contenu (à écrire en anglais, comme le code) :

1. Ce qu'est une app airtty : pages Server rendues par le Server, `"use client"` pour
   tout état ou hook, `"use server"` pour les mutations, arguments en Zod.
2. Le périmètre de 5.2, et « n'exécute pas de commandes : studio construit, vérifie et
   te renvoie les erreurs ».
3. Aide-mémoire OpenTUI : éléments (`box`, `text`, `input`, `textarea`, `scrollbox`,
   `select`), propriétés fréquentes (`fg`, `bg`, pas `color` : faute du corpus),
   clavier (`useBindings`, pas de lettre seule quand un champ a le focus).
4. Les pièges mesurés : hook dans une page (le Server meurt au démarrage), données vides.
5. Style de réponse : court, dire quels fichiers changent.

Réglages : Claude `settingSources` limité au projet (pas les hooks, MCP ni réglages
utilisateur dans une génération ; point 11.4), `permissionMode` piloté par la politique
de studio ; Codex `sandbox: "workspace-write"` avec `cwd` = projet.

### 5.4 Validation et correction automatique

Mesures du probe studio-generate (12 cas scriptés, aucun modèle) :

| Étape          | Arrête                                                       | Coût (médiane) | Diagnostic                         |
| -------------- | ------------------------------------------------------------ | -------------- | ---------------------------------- |
| garde-fou      | chemin interdit, paquet inconnu, built-in à capacité (3/10)  | < 1 ms         | fichier + raison                   |
| build          | syntaxe, import introuvable (2/10)                           | 1,2–1,4 s      | fichier ; **ligne fausse (`1:1`)** |
| rendu headless | page qui jette, composant qui jette, hook côté Server (3/10) | ≈ 0,55 s       | message, sans position             |
| `tsc`          | type faux, propriété inexistante (2/10)                      | 1,6–1,8 s      | fichier et ligne exacts            |

Ordre retenu : garde-fou → build → rendu headless → **aperçu mis à jour** ; `tsc` tourne
en parallèle du rendu et ne bloque pas l'aperçu (une erreur de type ne casse ni le build
ni forcément le rendu), mais son échec déclenche aussi une correction. Plafond de temps
sur `tsc` (des pointes à 10–168 s ont été vues sur une machine chargée, non reproduites).

Correction automatique :

- message synthétique au harness, marqué comme venant de studio : étape, diagnostics
  (5 au plus, chemins relatifs au projet), extrait de l'écran d'erreur pour le rendu ;
- **2 tentatives par défaut** (point 11.3), jamais deux fois le même diagnostic (empreinte) ;
- interruptible (`Esc`) ; chaque tentative apparaît dans la conversation ;
- le rendu headless est à terme remplacé par un rapport du Client de l'aperçu
  lui-même (lacune G6).

### 5.5 Garde-fous et capacités de l'app générée

Quatre couches, de la plus lisible à la plus sûre :

| Couche                      | Où                                        | Quoi                                                                                           |
| --------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1. politique du harness     | adaptateur (approbations, outils refusés) | écritures hors périmètre refusées **avant** d'avoir lieu ; pas de Bash, pas de web             |
| 2. garde-fou de fin de tour | Server studio, sur le diff du tour        | chemins, imports, appels dangereux ; refus → fichiers restaurés depuis git, message au harness |
| 3. audit du build           | `airtty build` (existe)                   | built-ins du bundle Client comparés à `airtty.capabilities`                                    |
| 4. confinement              | OS (Seatbelt, `airtty-sandbox`)           | Server et Client de l'aperçu : fichiers, réseau, exec (mesuré pour le Server)                  |

Les couches 1–3 donnent des refus compréhensibles ; seule la 4 est une barrière (le
garde-fou statique ne voit ni `require` calculé ni `globalThis["Bun"]`).

**Capacités** : l'app générée n'en a aucune par défaut (`airtty.capabilities: {}`). Si
le harness en a besoin (« affiche la météo » → `net: api.open-meteo.com`), il le dit ;
studio affiche la demande et **l'utilisateur** l'accorde ; studio (pas le harness) écrit
alors `package.json`, et le profil de l'aperçu suit. `pty` reste refusée sur macOS en
sandbox (EMBEDDING.md étape 7) : une app générée ne peut pas embarquer de shell.

## 6. Sécurité locale

Le code de l'app générée est **non fiable** : écrit par un modèle, éventuellement sous
l'influence d'un contenu hostile (prompt injection dans une page lue par le harness).

| Menace                                                  | Mitigation                                                                                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| le Server généré lit `~/.ssh`, écrit ailleurs, exfiltre | Server confiné : lecture de `.airtty/` seul, écriture de `data/`, aucun réseau sauf son port (mesuré)  |
| le Client généré fait de même                           | Client en `sandbox` (existant) ; bundle signé par la clé du projet, épinglée par studio                |
| OSC 52, notification, ouverture d'URL depuis l'aperçu   | capacités médiées par l'hôte (existant) : refusées sauf accord                                         |
| le harness exécute des commandes dangereuses            | pas de Bash (Claude), politique d'approbation de studio ; sandbox du harness (Codex `workspace-write`) |
| le harness écrit hors du projet                         | couche 1 (refus avant écriture), couche 2 (restauration git)                                           |
| dépendance malveillante                                 | aucune installation par le harness ; `package.json` écrit par studio seul                              |
| confusion « l'aperçu est sûr » en mode `process`        | refus par défaut sans sandbox ; `--preview process` explicite, avertissement permanent                 |

**Mode par défaut proposé : `sandbox`** pour le Server et le Client de l'aperçu, sur
macOS (Seatbelt) et, après C5b étape 5, sur Linux quand le mécanisme confine le réseau
(`userns`, `bwrap`). Sans mécanisme : refus expliqué au lancement, `--preview process`
pour passer outre (point 11.1). Coût mesuré : +11 ms au démarrage du Server ; le Client
sandboxé démarre en 280–330 ms (mdreader, EMBEDDING.md).

## 7. Lacunes du framework

| #   | Lacune                                                                                                          | Constat                                             | Proposition                                                                                                      | Taille |
| --- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------ |
| G1  | `confine()` ne sait pas confiner un Server qui écoute                                                           | probe server-sandbox : 2 règles suffisent sur macOS | `ServerRoute` « listen » (port loopback, ou socket Unix) ; Linux : écoute dans l'espace de noms + relais inverse | 2–3 j  |
| G2  | `airtty dev` ignore SIGHUP : Server et Client orphelins quand le terminal se ferme                              | probe preview : 2 orphelins                         | traiter SIGHUP comme SIGTERM dans `src/commands/dev.ts`                                                          | 0,5 j  |
| G3  | erreurs de syntaxe du build toujours en `1:1` ; import introuvable sans ligne                                   | les deux probes ; cause : `build.ts:322`            | positionner `fail()` sur `error.start` ; ligne de l'import dans `Cannot resolve`                                 | 0,5 j  |
| G4  | hook dans un Server Component : build accepté, Server mort au démarrage (« Export named 'useState' not found ») | probe generate                                      | le build détecte les hooks/`useState` importés dans le graphe Server et suggère `"use client"`                   | 1 j    |
| G5  | mort du Client sous `airtty dev` : code 0, indiscernable d'un départ volontaire                                 | probe preview                                       | propager le code du Client                                                                                       | 0,5 j  |
| G6  | aucun rapport structuré des erreurs de rendu du Client vers son superviseur                                     | probe preview                                       | message IPC `render-error` (le canal `airtty dev` ↔ Client existe) ; remplace le rendu headless                  | 1–2 j  |
| G7  | logique de supervision enfermée dans `commands/dev.ts`                                                          | section 3.2                                         | module réutilisable, `rebuild()` déclenché par l'appelant                                                        | 1–2 j  |
| G8  | `package.json` non surveillé par `airtty dev`                                                                   | probe preview                                       | sans objet pour studio (il reconstruit lui-même) ; à noter pour `dev`                                            | —      |
| G9  | runtime web : pas de widget VT, `<Terminal>` affiche « cannot run here »                                        | `src/web/platform/vt/terminal.tsx`                  | ci-dessous                                                                                                       | —      |
| G10 | pas de build dans le navigateur (`Bun.build`, `ts`)                                                             | WEB.md                                              | révisions construites à l'avance pour C5c ; hébergé : build côté serveur (C6a)                                   | —      |

### Le web en particulier

Le Client web ([WEB.md](../WEB.md)) évalue un bundle d'app contre un runtime navigateur ;
le widget VT n'y existe pas (pas de PTY, pas de libghostty en WebAssembly, le runtime web
remplace `<Terminal>` par un message). Un studio dans le navigateur ne peut donc pas
reprendre l'architecture locale telle quelle. Options :

| Option                                                                                                                                                                       | Coût      | Risques                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Deux `iframe` composées par la page** : studio (build `--web-local`, harness rejoué) à gauche, révision de l'app générée (`.airtty/web/` construit à l'avance) à droite | 3–5 j     | la page, pas le runtime, fait la mise en page ; il faut un message app → page « révision N prête » (le protocole d'embed n'a que `stage`/`event`) |
| B. Embarquement `inline` dans le runtime web : `openApplication` web (fetch + `evaluateAppBundle`) contre un second SharedWorker                                             | 5–8 j     | aucune isolation entre studio et l'app dans la page : acceptable pour un contenu rejoué, pas pour du code d'utilisateurs (Try it)                 |
| C. Widget VT web : libghostty en WebAssembly ou xterm.js imbriqué, Client généré dans un Worker produisant de l'ANSI                                                         | 10–15 j   | rendu natif absent (W7), ghostty-web écarté pour fuite entre instances (EMBEDDING §4) ; lourd pour un gain de démo                                |
| D. Exécution côté serveur, ANSI diffusé au navigateur                                                                                                                        | étude C6a | coût d'hébergement, isolation serveur ; hors de ce document                                                                                       |

Recommandation : **A pour C5c** (réutilise `.airtty/web/`, `test:web:embed`, la landing),
B plus tard si une démo unifiée dans une seule grille vaut son coût ; pour une version
hébergée avec du code d'utilisateurs, seule une isolation par origine (A avec une origine
séparée pour l'app) ou D conviennent.

## 8. Plan d'implémentation

### C5b : studio local

| Étape | Contenu                                                                                                                                                           | Validation                                                                                                                        | Estimation |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 0     | Correctifs framework G2, G3, G5 ; G1 macOS (`confine` pour un Server)                                                                                             | tests unitaires ; probes `studio-preview` et `studio-server-sandbox` réécrits en tests dans `tests/`                              | 3–4 j      |
| 1     | `packages/harness` extrait de coder (après fusion de C4) ; options `instructions`, `tools`, `policy`                                                              | `verify` et `test:pty:coder` verts, aucun changement de comportement de coder                                                     | 2–3 j      |
| 2     | Squelette `examples/studio` : args, projet (template, git, verrou), conversation sur le harness factice                                                           | `studio --harness fake --project demo` : conversation, révision r0 = template                                                     | 3 j        |
| 3     | Superviseur d'aperçu (G7) : build fin de tour, Server confiné, Client `sandbox` (clé du projet), rechargement par révision, `process` en repli                    | aperçu rechargé < 3 s après la fin d'un tour (médiane, macOS) ; aucun processus restant à la sortie (vérifié par le parcours PTY) | 4–5 j      |
| 4     | Validation 4 étapes + correction automatique + garde-fou + politique d'approbation ; harness factice **générateur** (corpus du probe rejoué comme harness)        | les 12 cas du corpus : faute détectée à la bonne étape, réparée au tour suivant ; tentatives bornées                              | 3–4 j      |
| 5     | Linux : G1 sous `airtty-sandbox` (écoute + relais inverse) ; CI `linux-sandbox`                                                                                   | tests d'évasion du probe, dans les conteneurs de `scripts/linux-sandbox.ts`                                                       | 3–4 j      |
| 6     | Claude et Codex réels : instructions, fixtures enregistrées (prompts minuscules) ; **mesure du taux de build réussi** sur 5 prompts, avec accord de l'utilisateur | taux mesuré et publié dans le README ; aucun appel non conforme (tests de conformité de coder étendus)                            | 2–3 j      |
| 7     | UX : révisions (`u`, `h`, diff), capacités demandées, états de 2.3, README français, `test:pty:studio`                                                            | parcours PTY sur le harness factice : prompt → aperçu → build cassé → correction → annulation                                     | 3–4 j      |

Total : 23–30 jours.

### C5c : rejeu scripté dans le navigateur

| Étape | Contenu                                                                                                                                                | Validation                                                                             | Estimation |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ---------- |
| 1     | Enregistreur : une session studio locale produit un script (événements du harness horodatés, révisions : fichiers + `.airtty/web/` de chaque révision) | un script rejouable sans réseau ni modèle                                              | 2 j        |
| 2     | Harness `replay` (sur l'interface du paquet harness) ; studio en `--web-local`, sans aperçu interne                                                    | studio web rejoue la conversation à l'identique                                        | 2 j        |
| 3     | Page composée (option A) : message app → page « révision N » ; `iframe` de l'aperçu remplacée à chaque révision                                        | `test:web:studio` (Chrome headless, CDP) : écran de chaque révision lu dans l'`iframe` | 3 j        |
| 4     | Intégration `website/` (après C1)                                                                                                                      | capture de la page, poids servi mesuré                                                 | 1–2 j      |

Total : 8–9 jours.

## 9. Risques

| Risque                                                                       | Mitigation                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Taux de réussite des vrais harness inconnu (le probe n'appelle aucun modèle) | étape C5b.6 le mesure ; template, kit et instructions ajustés d'après les fautes réelles |
| La correction automatique brûle le quota de l'utilisateur                    | 2 tentatives, empreinte des diagnostics, visible et interruptible                        |
| Build et `tsc` lents sur machine chargée (pointes vues à 168 s pour `tsc`)   | `tsc` hors du chemin critique de l'aperçu, avec plafond                                  |
| `sandbox-exec` obsolète (macOS)                                              | déjà assumé par EMBEDDING.md (étape 7) ; le probe sert de test                           |
| Course sur le port choisi pour le Server confiné                             | socket Unix privé (règle Seatbelt à mesurer) ou nouvel essai                             |
| Couplage coder/studio lors de l'extraction                                   | extraction après C4, sans changement de comportement, tests existants comme filet        |
| Diagnostics de rendu pauvres (pas de position)                               | G6, puis pile source-mappée côté Server                                                  |
| Instructions contournées par le modèle                                       | elles ne protègent rien : les couches 1, 2 et 4 appliquent                               |

## 10. Décisions reprises

Déjà tranchées par l'utilisateur (27 septembre 2026) : nom de travail `studio`, jamais
la marque d'un produit existant ; exemple airtty local avec Claude Code ou Codex par les
adaptateurs de coder ; version hébergée étudiée à part (C6a) ; commande `npx airttyx
studio` plus tard (C7). La version hébergée ne pourra pas utiliser d'abonnement (clés
d'API seulement), ce qui ne concerne pas la version locale.

## 11. Décisions

Tranchées le 27 septembre 2026 (déléguées à l'orchestrateur, qui a repris les
propositions) :

1. **Isolation** : `sandbox` pour le Server et le Client de l'aperçu ; sans mécanisme,
   pas de génération ; `process` seulement sur demande (`--preview process`), avec un
   avertissement permanent.
2. **Outils du harness** : aucune commande ; studio construit et vérifie lui-même.
3. **Correction automatique** : 2 tentatives par défaut, réglable (`--fixes`).
4. **Réglages Claude de l'utilisateur** ignorés pendant une génération (`isolated`).
5. **Révisions** : dépôt git créé par studio dans le projet.
6. **macOS d'abord** : l'étape 5 (Linux) vient après la v1 macOS.
7. **`packages/harness`** extrait, sans changement de comportement de coder.
8. **Kit de composants** du template : après la mesure des fautes réelles, pas dans C5b.
