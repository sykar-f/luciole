# Sonde studio-preview : l'aperçu en direct d'une app générée

Exécutée le 27 septembre 2026 sur macOS 26.6.2 (arm64), Bun 1.4.2, OpenTUI 0.5.12, deux
fois (machine chargée par d'autres sessions la seconde fois : les deux mesures sont
données). Sert la conception de [docs/studio/SPEC.md](../../docs/studio/SPEC.md).

Question : l'aperçu de studio peut-il être une app airtty lancée par `airtty dev` dans le
widget VT (`<Terminal>`, mode `process` de [EMBEDDING.md](../../docs/EMBEDDING.md)),
rechargée à chaque modification de ses fichiers par un harness ? Que montre-t-il quand le
build échoue, quand un rendu jette, quand l'app meurt ?

Réponse : **oui, cela marche sans rien changer à `src/`**, en 1,4 à 2,6 s par
modification ; mais `airtty dev` n'est pas le bon superviseur pour studio (voir
« Conséquences »).

```sh
bun probes/studio-preview/preview.tsx    # depuis la racine ; écrit results.json, code 1 si échec
```

Aucune dépendance propre. Chaque scénario copie `template/` dans `.airtty-work/<nom>/`
(ignoré par git et par tsc), le fait tourner par `airtty dev` dans un `<Terminal>` rendu
par `testRender` (100×24), modifie ses fichiers comme le ferait un harness et lit l'écran
composé.

| Fichier       | Rôle                                                                                                                                |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `template/`   | l'app de départ que studio donnerait au harness : layout (état + erreur de build), page Server, composant Client, action Zod, store |
| `preview.tsx` | les trois scénarios ci-dessous                                                                                                      |

## Résultats (17/17)

Le run 1 est la première exécution, avant l'ajout du scénario SIGTERM (il a révélé les
orphelins) ; le run 2 est la version commitée.

| Mesure ou assertion                                                          | Run 1           | Run 2 (chargé)  |
| ---------------------------------------------------------------------------- | --------------- | --------------- |
| démarrage à froid, jusqu'au premier écran de l'app                           | 2,1 s           | 2,9 s           |
| l'aperçu est interactif (touche → Server Function → rendu)                   | oui             | oui             |
| rechargement après modification d'un fichier Server (médiane de 5)           | 1,49 s          | 2,07 s          |
| rechargement après modification d'un composant Client (médiane de 5)         | 1,45 s          | 2,05 s          |
| l'état en mémoire du Server généré est perdu à chaque rechargement           | oui             | oui             |
| erreur de syntaxe : bandeau par-dessus le dernier écran valide               | 174 ms          | 191 ms          |
| réparation : bandeau effacé (nouveau Client)                                 | 0,63 s          | 0,75 s          |
| page Server qui jette : message affiché, état `Disconnected`                 | oui             | oui             |
| composant Client qui jette : message affiché, `airtty dev` continue          | oui             | oui             |
| le Client généré quitte (`process.exit(3)`) : `airtty dev` s'arrête, code 0  | 1,5 s           | 1,6 s           |
| premier build en échec : texte brut dans le PTY, `airtty dev` attend         | oui             | oui             |
| réparation d'un premier build en échec                                       | 2,2 s           | 3,1 s           |
| modifier `package.json` ne déclenche pas de rebuild                          | oui             | oui             |
| fermer `<Terminal>` (SIGHUP) laisse le Server et le Client générés orphelins | **2 orphelins** | **2 orphelins** |
| même aperçu terminé par SIGTERM : aucun processus restant                    | —               | oui             |

Écran lors d'une erreur de syntaxe (le bandeau est celui du template, qui lit
`useConnection().buildError`) :

```text
 STUDIO APP · Connected
 Build failed: components/Counter.tsx:1:1: '>' expected.
 studio preview v6
 Count: 0 (press + to increment, edit 4)
```

## Constats

1. **Position des erreurs de syntaxe perdue** : toujours `1:1`. Cause vérifiée :
   `packages/airtty/src/build.ts:322` passe le nœud racine (`ast`) à `fail()` au lieu de
   la position du diagnostic TypeScript (`error.start`). Même constat dans
   [studio-generate](../studio-generate/README.md).
2. **SIGHUP orphelin** : `<Terminal>` termine son programme par SIGHUP ;
   `src/commands/dev.ts` n'écoute que SIGINT et SIGTERM, meurt sans arrêter le Server et
   le Client qu'il a lancés (ils ont survécu, sans parent, jusqu'à leur arrêt par la
   sonde).
3. **Mort du Client indiscernable** : `airtty dev` sort avec 0, que le Client ait quitté
   volontairement ou planté.
4. **Rebuild à chaque écriture** : le watcher de `airtty dev` (debounce 150 ms)
   reconstruit dès qu'un fichier change ; un harness qui écrit quatre fichiers en
   plusieurs secondes montrerait des états intermédiaires incohérents.
5. **Erreurs non structurées** : les erreurs de build arrivent au Client par l'IPC de
   `airtty dev`, celles de rendu seulement à l'écran ; rien ne revient à un superviseur
   sous une forme exploitable par une boucle de correction.

## Conséquences pour studio

L'aperçu garde le widget VT, mais studio pilote lui-même build et relance (superviseur
propre, décrit dans la spec, section 3) : build en fin de tour, diagnostics structurés,
Server confiné ([studio-server-sandbox](../studio-server-sandbox/README.md)), arrêt par
SIGTERM. Les constats 1 et 2 sont des correctifs courts du framework (spec, section 7).
