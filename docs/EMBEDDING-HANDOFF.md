# Handoff — Client générique et applications embarquées

Date : 24 septembre 2026. Statut : la recherche est terminée, l'implémentation dans `src/`
n'a pas commencé. Ce document est destiné à l'agent qui implémentera le plan ; il ne
remplace pas [EMBEDDING.md](EMBEDDING.md), qui reste la référence de conception.

## Mission

Faire de luciole un hôte capable d'ouvrir plusieurs applications à la fois : un navigateur à
onglets pour des applications servies par d'autres Servers, et un multiplexeur local à la
tmux/herdr (shells, vim, applications luciole). L'isolation est un **curseur par origine**,
choisi par l'utilisateur, jamais par l'application :

| Mode      | Exécution                          | Isolation                     | Usage                            |
| --------- | ---------------------------------- | ----------------------------- | -------------------------------- |
| `inline`  | même processus, même arbre React   | aucune                        | code de confiance, composition   |
| `process` | processus enfant dans un widget VT | crashs seulement              | multiplexeur local, sans surcoût |
| `sandbox` | enfant + sandbox OS + capacités    | crashs + capacités appliquées | URL distante, paquet non signé   |

Règle non négociable : une capacité n'est affichée comme appliquée que si l'OS, le proxy
ou l'hôte l'applique réellement. `process` n'ajoute aucune couche de sécurité ; tout
accorder en `sandbox` revient à proposer `process`, jamais une sandbox vide.

## État au départ

Sur `main` (après le merge d'`integration`) :

- `docs/EMBEDDING.md` : modèle, capacités, Client générique, six obstacles mesurés dans
  `src/` (O1 à O6) avec leur refactor, risques, plan en 8 étapes, décisions.
- Quatre probes, chacun avec README, `results.json` et commande de lancement :
  `probes/inline` (20/20), `probes/generic-client` (9/9), `probes/sandbox` (38/38 macOS,
  12/12 Linux en conteneur), `probes/vt-embed` (15/15).
- Le lanceur de feat/distribution est livré : résolution chemin → installé → npm → git →
  URL (`src/launcher/`), champ `luciole` (`name`, `buildId`, `binaries`) dans le
  `package.json`. L'étape URL répond aujourd'hui « non supporté encore » : c'est là que se
  branche le Client générique (étape 5).

## Décisions déjà prises (ne pas rouvrir)

1. Pane embarquable : nouvel export `<Embed app name active />` dans `luciole/client` ;
   `Shell` ne change pas.
2. Pas de nouvelle commande : `luciole https://…` passe par le lanceur.
3. Capacités déclarées statiquement dans `luciole.capabilities` du `package.json`, schéma
   Zod de `probes/sandbox/capabilities.ts`, recopiées dans le manifeste signé.
4. Deux panes du même build : préfixe **par instance** dès l'étape 1 (`x-luciole-instance`,
   ids `<clé>@<buildId>/<chemin>`).
5. `inline` autorise tout, y compris `child_process` ; le lanceur l'affiche avant
   l'ouverture. Texte proposé, à caler avec le lanceur : « Confiance totale : cette app
   s'exécute dans le processus du lanceur ; aucune capacité n'est appliquée. »
6. Sandbox Linux : un **lanceur natif en Rust** (`luciole-sandbox`, livré compilé avec
   luciole) applique lui-même Landlock (fichiers, exécution par binaire, ports TCP depuis
   l'ABI 4 / noyau 6.7 : sortie réseau forcée vers le proxy de l'hôte sans namespace) et
   seccomp (TIOCSTI, `ptrace`…), puis `exec` l'enfant. Pas de dépendance à bwrap ni à
   `landrun`, pas besoin des user namespaces (restreints par AppArmor sur Ubuntu ≥ 23.10).
   Noyau sans Landlock suffisant : bwrap s'il est présent, sinon le mode `sandbox` est
   **refusé** avec un message clair, jamais simulé.

## Commencer ici

1. Lire `docs/EMBEDDING.md` en entier, puis `docs/ARCHITECTURE.md`, `docs/API.md` et
   `docs/DISTRIBUTION.md`.
2. Relancer les probes `inline` et `generic-client` (commandes dans leurs README) : ils
   décrivent exactement le comportement attendu des étapes 1 à 3, refactors appliqués
   depuis l'extérieur de `src/` (`probes/generic-client/host.tsx`,
   `probes/inline/instance-server.ts`).
3. Implémenter l'étape 1, puis s'arrêter pour relecture avant l'étape 2.

## Plan (section 7 d'EMBEDDING.md)

Chaque étape est mergeable seule, garde `bun run verify` et les smokes PTY verts, et ne
change pas le comportement d'une application existante (un seul pane = aujourd'hui).

| Étape | Contenu                                                                          | Estimation |
| ----- | -------------------------------------------------------------------------------- | ---------- |
| 1     | Préfixe d'instance, `registerModules`, `actionReference` lié au pane (O1, O2)    | 3 j        |
| 2     | `<Embed>` : keymap par pane, error boundary, focus retiré/rendu (O3, O4)         | 3 j        |
| 3     | Sortie `.luciole/app/` sans runtime, ABI (`src/abi.ts`), `luciole.capabilities`  | 3,5 j      |
| 4     | Signature Ed25519, routes `/manifest` et `/bundle`                               | 2 j        |
| 5     | Client générique sur l'étape URL du lanceur, TOFU, stockage par origine, onglets | 4 j        |
| 6     | Mode `process` : widget VT (`EmbeddedTerminalRenderable` d'OpenTUI), PTY Bun     | 5–8 j      |
| 7     | Mode `sandbox` macOS : Seatbelt généré, proxy de sortie, IPC des capacités       | 6–8 j      |
| 8     | Sandbox Linux : lanceur Rust Landlock + seccomp (décision 6), repli bwrap, CI    | 5–7 j      |

Les étapes 1, 2 et 6 servent déjà le multiplexeur local sans rien de la sécurité : si
l'objectif prioritaire est tmux/herdr, l'ordre 1 → 2 → 6 est légitime.

## Étape 1 en détail

- `src/flight/client.ts` : remplacer le résolveur global unique par un registre
  `clé → resolver`. `installResolver(next)` devient `registerModules(key, resolver): () => void`.
  Le `__webpack_require__` global aiguille sur le préfixe `<clé>@` ; sans préfixe, sur
  l'unique résolveur enregistré (le Client actuel ne change pas).
- `src/transport.ts` : en-tête `x-luciole-instance` si `HttpTransportOptions.instance` est
  défini ; `ApplicationOptions.instance` le transmet. Réglé par l'hôte, jamais par l'app.
- `src/server.ts` : en-tête validé par Zod (`[a-z0-9-]{1,32}`), copie du manifeste préfixée
  par clé passée à `renderToReadableStream`, dans un **cache borné** (la clé vient du
  Client). Les ids de Server Functions ne changent pas.
- `src/client.tsx` : supprimer `let current: Application`. Chaque pane évalue son bundle
  avec sa propre table `require`, donc son propre `actionReference` lié à son Application.
- Tests : deux panes du même build contre deux Servers, et deux builds différents dans un
  même processus (repris de `probes/inline`, scénario `panes/instance`).

Pourquoi l'id doit porter l'instance : le codec Flight navigateur ne prend pas de table de
modules par réponse, et il résout les modules **pendant le rendu** (`React.lazy`), bien
après le décodage. Aucun « résolveur de la réponse courante » n'est fiable.

## Pièges déjà rencontrés

- **Dépendances propres à un probe** : `probes/vt-embed` et `probes/devtools-tanstack` ont
  leur propre `package.json`. Ils sont exclus du `tsconfig.json` et de l'oxlint racine et
  se vérifient par leur `bun run check`. Tout nouveau probe à dépendances suit ce schéma,
  sinon `verify` échoue sur un checkout neuf (et en CI) tout en passant chez vous.
- **Import dynamique vers le runtime Client** : un import dynamique qui atteint
  `transport.ts` a fait planter tous les Clients buildés (`__promiseAll is not defined`,
  bundling de Bun avec le top-level await de Flight). Voir le commit
  `fix(client): keep Flight's top-level await out of the DevTools chunk`.
- **Focus OpenTUI global au renderer** : un `<input focused>` d'un pane inactif reçoit
  encore la frappe ; `<Embed>` doit retirer et rendre le focus à la bascule.
- **Touche préfixe** : seule la touche de l'hôte (`Ctrl+O` dans le probe) est réservée ;
  tout le reste doit atteindre le terminal ou l'application du pane actif.
- **PTY** : `Bun.Terminal` avec `detached: true`, sinon `Ctrl+C` n'interrompt rien.
- **OpenTUI 0.5.12** : F1–F12, `Alt+x`, Backspace sans protocole kitty, DA1/DA2, OSC 10/11
  manquent ; `probes/vt-embed/gaps.ts` les comble. À remonter en amont plutôt qu'à
  recopier dans `src/`.
- **PTY smokes** : scripts Bun sous `scripts/pty/` (`bun run test:pty:<parcours>`), sans
  dépendance hors du dépôt ; l'écran est reconstruit par l'émulateur d'OpenTUI.

## Règles de travail

- Diffs minimaux et justifiés dans les fichiers chauds (`client.tsx`, `server.ts`,
  `transport.ts`, `build.ts`) ; le reste dans de nouveaux modules.
- Commits atomiques selon les conventions du dépôt (le corps explique le pourquoi).
- Une question qui change l'API publique et que ce document ne tranche pas : s'arrêter et
  la poser.

## Questions encore ouvertes

- Rotation des clés d'éditeur (déclaration signée par l'ancienne clé, à concevoir).
- Deux origines qui servent exactement le même build : couvert par le préfixe d'instance,
  à confirmer par un test dédié à l'étape 1.
- Fidélité VT pour les images kitty de `files` : v2 par diffs de cellules OpenTUI, après
  la v1.
