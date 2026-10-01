# flow — un pipeline CI sur un canevas de nœuds

Un éditeur de pipeline dans le terminal : les étapes d'une CI (checkout, install, lint,
typecheck, test, build, e2e, déploiements) sur un canevas façon React Flow, dessiné par
[`@luciole/flow`](../../packages/flow/README.md). On les déplace, on en ajoute, on les
relie, on les renomme, on les supprime, et on lance un run qui les allume l'une après
l'autre.

## Lancer

Depuis la racine du monorepo (les dépendances sont `workspace:*` et `catalog:` : l'exemple
ne se lance pas depuis son propre dossier). Prérequis : Bun 1.4.2 et `bun install
--frozen-lockfile` une fois. Aucune clé API, aucun réseau.

```sh
bun run flow                        # dev
FLOW_RUN_SCALE=0.3 bun run flow     # des runs trois fois plus courts
```

Production, deux artefacts :

```sh
bun packages/luciole/src/cli.ts build --app examples/flow
bun packages/luciole/src/cli.ts start --role server --app examples/flow
bun packages/luciole/src/cli.ts start --role client --app examples/flow --url http://127.0.0.1:3000
```

Le canevas tient en entier à partir de ~160 colonnes ; en dessous, `fitView` choisit le
niveau de zoom `compact` (labels seuls), et `=` revient au détail complet.

## Ce qui tourne où

| Où     | Quoi                                                                                                                                                       |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server | Le pipeline (`server/pipeline.ts`, en mémoire : il repart de zéro à chaque démarrage) et les runs simulés. La page le rend au premier affichage.           |
| Client | Pan, zoom, drag, sélection, navigation au clavier, inspecteur : aucun aller-retour.                                                                        |
| Aller  | Server Functions de `actions/pipeline.ts`, arguments validés par Zod : `moveSteps`, `addStep`, `renameStep`, `removeElements`, `connectSteps`, `startRun`. |
| Retour | `watchRun`, Server Function génératrice lue par `useLive` : chaque avancée du run, pour tous les Clients.                                                  |

Les déplacements partent quand ils se posent : à la fin d'un drag, ou 250 ms après une
rafale de `H J K L`. Un lien qui fermerait un cycle, un doublon ou une suppression
pendant un run sont refusés par le Server ; le Client affiche la raison et recharge le
pipeline tel que le Server le garde (`loadPipeline`), sans rien deviner.

Un run démarre chaque étape quand toutes ses étapes amont ont réussi ; après un échec,
l'aval est sauté. `e2e` est instable exprès : elle échoue aux runs impairs, pour montrer
un échec. Les arêtes qui mènent à une étape en cours sont animées, celles qui partent
d'une étape réussie vertes, d'une étape en échec rouges.

## Touches

| Touches               | Action                                                    |
| --------------------- | --------------------------------------------------------- |
| `tab`, `Maj+tab`      | Étape suivante, précédente                                |
| `]`, `[`, `}`, `{`    | Aval, amont, frères                                       |
| `h j k l`, `H J K L`  | Déplacer la vue, déplacer l'étape                         |
| `a`                   | Ajouter une étape après la sélection (reliée), ou seule   |
| `n`                   | Renommer l'étape (`Entrée` enregistre, `Échap` annule)    |
| `c`, `tab`…, `Entrée` | Relier l'étape à la cible proposée                        |
| `e`, `x`              | Sélectionner les liens de l'étape, supprimer la sélection |
| `r`                   | Lancer un run                                             |
| `-`, `=`, `0`         | Dézoomer (labels, puis points), zoomer, tout voir         |

À la souris : clic pour sélectionner, glisser une étape ou le fond, glisser depuis le
`●` de l'étape sélectionnée jusqu'à une autre pour les relier, molette pour la vue
(Ctrl : zoom), clic dans la minimap pour y aller.

## Vérification

`bun run test:pty:flow` ([`scripts/pty/flow.ts`](../../scripts/pty/flow.ts)) construit
l'exemple, lance Server et Client de production sur un vrai PTY de 160×40 et parcourt :
tab et `]` → ajout, renommage, suppression → liaison au clavier → clic et drag → run en
direct (arêtes animées, `e2e` échoue, `production` sautée) → zoom sémantique. Un second
Client relit ensuite le pipeline : le lien et le déplacement sont bien sur le Server. La
frame finale est écrite dans `docs/flow-pty-frame.txt` (non versionné).
