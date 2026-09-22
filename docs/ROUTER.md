# Navigation — TanStack Router, modèle B

## Décision

La navigation Client est entièrement confiée à `@tanstack/react-router` 1.170.38,
sans TanStack Start, avec `createMemoryHistory`. Il n'existe plus de seconde
machine d'état : `Application.path`, `pendingNavigation`, `generation`, `tree`,
`navigate`, `cancelNavigation`, `ApplicationOptions.loadingRoutes`, `useNavigation()`,
`NavigationLoading`, `src/routes.ts` et `matchRoute` ont été supprimés.

Modèle B : les layouts sont des Client Components persistants ; chaque page reste un
Server Component rendu à la demande et livré au loader de sa route comme valeur
React Flight. Le modèle C (un payload Flight par segment, layouts Server
persistants) est écarté tant qu'aucun besoin concret ne l'impose.

Supersède :

- la recommandation « routeur interne » de `FILE-BASED-LAYOUTS-DESIGN.md` ;
- l'ancien contrat « seul le shell du framework persiste », le layout racine Server
  et l'absence de layouts imbriqués ;
- le refresh post-action conditionné par une génération de navigation.

## Seams

| Module               | Interface                                                    | Adapters / tests                           |
| -------------------- | ------------------------------------------------------------ | ------------------------------------------ |
| `src/route-graph.ts` | `compileRouteGraph(files)` → layouts, pages, diagnostics     | fonction pure, `tests/route-graph.test.ts` |
| `src/transport.ts`   | `Transport { render, call, setToken }`                       | HTTP/Flight, transports factices           |
| `src/client.tsx`     | `createApplication`, `Shell`, hooks réexportés               | Client généré piloté dans OpenTUI          |
| `src/server.ts`      | registre autoritaire `routeId → { component, auth, params }` | Server réel lancé par les tests            |
| `src/build.ts`       | spec de route tree Client + registre Server, manifests       | fixtures temporaires                       |

Le build n'utilise pas le plugin de génération de TanStack : il génère une spec
(`root`, `layouts`, `pages`) que `buildRouteTree` transforme en routes code-based.
Le Server ne fait plus de matching de chemin : il reçoit un `routeId` et des
paramètres, qu'il valide.

## Preuve préalable

Le spike `spike/tanstack-router.tsx` (branche jetable `spike/tanstack-router`,
commit `64185db`) a prouvé sur OpenTUI, contre un vrai Server Flight : Outlet sans
DOM, navigation clavier en memory history, layout Client conservant état, focus et
scroll, modèle racine avant un `Suspense` lent, annulation du loader remplacé,
redirection `401`, action indépendante d'une invalidation échouée, purge du cache,
annulation par Échap.

## Typage

Le build écrit `app/routeTree.gen.ts`, versionné comme le `routeTree.gen.ts` de
TanStack (les contrôles de types d'une application en ont besoin avant tout build).
Il appelle `createRoute` avec les chemins littéraux et déclare `Register` : `to`,
`params` et `useParams` sont vérifiés contre les routes de **cette** application.
Chaque application a donc son propre programme TypeScript (`tsc -p examples/notes`).
Le loader est généré sans annotation, `loader: (ctx) => loadPage(ctx, …)` : un
paramètre annoté deviendrait un site d'inférence et élargirait les params déduits du
chemin. Le fichier est ignoré par Oxfmt/Oxlint et par le watcher de `dev`, réécrit
seulement si le route graph change ; `tests/route-types.test.ts` vérifie les erreurs
attendues et que les fichiers des exemples sont à jour. Le bundle Client résout
`@tanstack/react-router` depuis le framework : une seule instance du routeur.

## Adaptations au terminal

- **Build Client de TanStack.** La condition d'export `bun` sélectionne la variante
  serveur de `@tanstack/router-core/isServer` (rendu synchrone, pas de
  `Transitioner`), qui plante sous OpenTUI. Le bundle Client redirige ce module vers
  sa variante `client.js` ; `tests/build.test.ts` vérifie l'absence de la variante
  serveur.
- **`scrollTo`.** La remise à zéro du scroll de TanStack appelle le global
  `scrollTo()` après chaque rendu, sans option pour la désactiver. OpenTUI installe
  déjà un `window` minimal ; `createApplication` ajoute un `scrollTo` no-op.
- **Reconciler.** TanStack commit ses navigations via `startTransition`. Le
  reconciler 0.34 appelle alors `suspendOnActiveViewTransition`, absent du host
  config d'OpenTUI 0.5.12. Le framework reste donc sur reconciler 0.33.0, dans la
  plage déclarée par OpenTUI, sans override ni patch ; `tests/renderer.test.tsx`
  garde ce point (le chemin est invisible sous `act()`).

## Comportements choisis

- **Refresh échoué** : le loader renvoie l'arbre du match résolu (`loaderData`) au
  lieu de laisser l'`errorComponent` remplacer l'éditeur ; l'erreur va au statut.
- **Navigation échouée** : comportement natif de TanStack, l'erreur s'affiche dans
  l'emplacement de la page, les layouts restent montés, Ctrl+R réessaie. Les Drafts
  sont au-dessus du routeur.
- **Échap** : navigation vers la location résolue avec `state.terminalRestore` ;
  `shouldReload` renvoie `false` pour cette seule location et `undefined` sinon, ce
  qui laisse intactes les règles de fraîcheur de TanStack. Un layout quitté par la
  navigation en attente est remonté (son état local repart de zéro), comme la page.
- **Invalidation explicite** : aucune Server Function ne rafraîchit automatiquement.
  Le code Client qui mute appelle `router.invalidate()` sans l'attendre (option B,
  alignée sur TanStack Start). Les lectures ne coûtent donc aucun rendu. Alternative
  écartée pour l'instant : une invalidation déclarée par le Server dans l'enveloppe de
  réponse (modèle `revalidatePath` de Next.js), à reconsidérer si les appels
  `invalidate()` se dupliquent entre composants.
- **Statut** : seul le chargement courant publie le statut de connexion ; une réponse
  d'un chargement abandonné n'écrase jamais « Disconnected ».
- **Purge différée** : un commit remet la route quittée dans le cache ; une purge
  demandée pendant une navigation est répétée à `onResolved`.
- **`<Link>`** n'est pas exposé : il rend une ancre DOM.
- Les layouts ne lisent pas la session Server ; exposer des données publiques de
  session au chrome reste à concevoir.
