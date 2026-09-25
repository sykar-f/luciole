# Handoff — construire la démo complexe « Incident Control Room »

> **Réalisé sous une autre forme.** La démo complexe livrée est Forge
> (`examples/forge`), une forge de code review qui reprend cette matrice de preuves et
> va au-delà du contrat (search params, préchargement, streaming continu). Voir
> [FORGE.md](FORGE.md). Ce document reste la spécification d'origine.

## Mission

Créer `examples/control-room`, une application TUI crédible de pilotage d'incidents
et de déploiements. Elle doit exercer ensemble toutes les capacités actuellement
livrées par airtty et rendre visible sa promesse centrale : les interactions
locales restent immédiates, même lorsqu'une lecture ou mutation Server subit 500 ms
de roundtrip.

Le résultat attendu est une application démontrable, testée et documentée, pas un
catalogue de widgets. Chaque écran doit appartenir au même flux métier : connexion,
triage d'un incident, édition d'un runbook, déclenchement d'un déploiement, gestion
d'un conflit et récupération d'un résultat de sauvegarde perdu.

## Démarrage de la session

1. Vérifier `git status`, lire les derniers commits et préserver tout changement
   existant qui n'appartient pas à la mission.
2. Lire `README.md`, `docs/API.md`, `docs/ARCHITECTURE.md`,
   `docs/BOUNDARIES.md`, `docs/VALIDATION.md` et `docs/ROUTER.md`.
3. Parcourir `examples/notes`, `examples/latency`, les tests de navigation/auth/draft
   et les scripts PTY avant de choisir les seams de test.
4. Écrire un court plan reliant chaque feature à un écran et à une preuve. La phase
   de découverte est terminée lorsque chaque ligne de la matrice ci-dessous a un
   propriétaire précis dans le code et dans les tests.

Les layouts Client imbriqués et persistants et les groupes `(group)` sont présents
depuis la migration TanStack Router ([ROUTER.md](ROUTER.md)). La démo les utilise
là où le parcours en a besoin ; les layouts Server persistants restent hors contrat.

## Parcours produit

### 1. Connexion publique

- `/login` est une page publique avec une Server Function publique dans un module
  dédié.
- La connexion de démonstration valide ses arguments côté Server, crée une session
  opaque dans SQLite et retourne un bearer temporaire.
- Le Client installe ce bearer avec `useApplication().setToken(token)`, puis navigue
  vers `/` sans recréer l'`Application`.
- `server/auth.ts` résout le bearer en `{ userId, role }` et configure
  `unauthorizedPath: "/login"`.
- Un logout protégé révoque la session, efface le token côté Client et revient à
  `/login`.

Le flux est explicitement une auth de démonstration locale. Aucun secret n'entre
dans une prop RSC ou un bundle Client ; les autorisations métier restent vérifiées
dans les actions et repositories.

### 2. Tableau de contrôle protégé

`/` charge côté Server les incidents actifs, services et déploiements récents. Un
Client Component fournit recherche, filtres, sélection clavier, hover et liste
scrollable. Ces opérations sont purement locales et ne provoquent aucun fetch.

Une section secondaire lente est rendue derrière une frontière `Suspense` pour
prouver le Flight progressif : le résumé utilisable arrive avant l'historique ou
les métriques coûteuses.

### 3. Création et détail d'incident

- `/incidents/new` est une route statique et `/incidents/[id]` une route dynamique ;
  le test doit prouver que `new` ne devient jamais un `id`.
- La création passe par une Server Function protégée et navigue vers l'incident.
- `app/incidents/[id]/loading.tsx` est un fallback Client local, géométriquement
  stable, animé sans trafic réseau.
- Échap annule une navigation lente vers un incident et restaure la dernière route
  confirmée.
- Le détail contient un runbook éditable utilisant `useDraft`. Mapper le runbook au
  contrat actuel `{ id, title, value, version }` sans généraliser prématurément le
  framework.
- La sauvegarde SQLite est atomique avec un identifiant d'opération. Elle couvre
  dirty/pending, frappe pendant la sauvegarde, résultat inconnu, `recover`, conflit
  de version et abandon explicite.
- Une action de test ou un second opérateur simulé permet de modifier la version
  Server afin de rendre le conflit reproductible.

### 4. Déploiement

`/deployments/[id]` affiche l'état Server et expose une mutation protégée pour lancer
ou approuver un déploiement. L'action journalise `getCallId()` pour la corrélation de
transport, mais utilise un identifiant métier distinct pour l'idempotence.

Pendant l'action retardée, saisie, hover et scroll de l'écran restent actifs. Après
succès, le composant qui a déclenché la mutation appelle `router.invalidate()` ; les
lectures par Server Function ne rafraîchissent rien. Un refresh manuel conserve le
composant monté ; un échec de refresh ne transforme pas la mutation confirmée en
échec.

Il n'existe actuellement ni subscription ni tâche durable dans le framework. Le
statut est donc actualisé par refresh explicite, sans faux temps réel ni boucle de
polling cachée.

## Matrice de couverture obligatoire

| Capacité actuelle          | Usage dans la démo                                                                         | Preuve attendue                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Server Components          | lectures SQLite et composition des pages                                                   | données métier absentes du bundle Client                           |
| Client Components          | filtres, formulaire, hover, scroll, raccourcis                                             | interactions visibles sans nouvelle requête                        |
| Server Functions           | login, logout, création, sauvegarde, déploiement                                           | appels Flight typés et droits revalidés côté Server                |
| Auth publique/protégée     | `/login` public, reste protégé                                                             | redirection 401, action publique et action refusée sans bearer     |
| Session                    | identité publique rendue par une page ou un contexte Client, `getSession()` dans le métier | identité et rôle corrects, cas anonyme accepté uniquement où prévu |
| Token dynamique            | login/logout via `setToken`                                                                | même instance `Application`, état local non réinitialisé           |
| Routage statique/dynamique | `/incidents/new` et `/incidents/[id]`                                                      | priorité statique testée                                           |
| Loading local              | détail incident lent                                                                       | affichage immédiat, annulation locale, zéro donnée Server supposée |
| Navigation                 | `useNavigate`, cancel, refresh, réponses périmées                                          | la dernière navigation TanStack gagne                              |
| Suspense/Flight progressif | métriques ou historique lent                                                               | premier contenu avant le sous-arbre lent                           |
| Draft de session           | runbook d'incident                                                                         | frappe concurrente, conflit, discard et rétention inter-route      |
| Résultat inconnu           | sauvegarde atomique + ledger d'opérations                                                  | récupération sans rejouer la mutation                              |
| Réactivité OpenTUI         | input, clavier, hover, scroll                                                              | fonctionne pendant un RTT simulé de 500 ms                         |
| Build séparé               | artefacts Client et Server                                                                 | aucun repository, token ou SQL dans le bundle Client               |
| Build mismatch             | Client/Server incompatibles                                                                | refus avant décodage sans perte du Draft monté                     |
| Production                 | build puis lancement des deux rôles                                                        | smoke PTY sur artefacts produits                                   |

## Modèle de données conseillé

Utiliser une base `CONTROL_ROOM_DB`, temporaire dans les tests. Un schéma compact
suffit :

- `users` et `sessions` pour l'identité de démonstration ;
- `services` ;
- `incidents` avec statut, sévérité et version ;
- `runbooks` avec contenu et version monotone ;
- `deployments` avec état et identifiant métier d'opération ;
- `operation_results` pour résoudre les issues inconnues ;
- `audit_events` avec acteur, action, `call_id` et date.

Les repositories possèdent les transactions, l'ownership et les transitions d'état.
Les Server Functions valident les entrées et orchestrent ; les pages ne contiennent
pas de SQL. Fournir des données initiales déterministes au premier démarrage.

## Contraintes d'architecture

- Garder une seule codebase applicative `app/`, `components/`, `actions/`, `server/`.
- Ne pas ajouter de protocole RPC, endpoint HTTP applicatif ou manifest manuel.
- Ne pas importer de package Client non supporté par le compilateur. React,
  OpenTUI et `airtty/client` suffisent.
- Mettre chaque action publique dans un module `"use server"` séparé ; toutes les
  autres actions restent protégées par défaut.
- Chaque action revalide rôle, ownership, version et arguments. Une référence Flight
  ne constitue jamais une autorisation.
- Utiliser des erreurs métier sérialisables pour les issues attendues. Réserver les
  exceptions aux défauts inattendus ou transport.
- Conserver une géométrie stable entre loading et écran final.
- Ne pas transformer `useDraft` en framework générique au passage. Documenter les
  frictions observées afin qu'une généralisation future parte de deux usages réels.
- Une petite correction du framework est acceptable uniquement si la démo révèle
  un blocage réel, avec test de régression et documentation du contrat. Éviter les
  abstractions anticipant subscriptions, cache de données ou tâches.

## Séquence avec critères de fin

1. **Socle et données.** Créer l'exemple, le schéma, les repositories et les seeds.
   Terminé quand une fixture temporaire reproduit exactement le même état et que les
   droits sont testables sans UI.
2. **Auth bout en bout.** Implémenter adapter, login, logout et protections. Terminé
   quand pages et actions publiques/protégées ont chacune un test positif et négatif.
3. **Routes Server.** Ajouter dashboard, routes statique/dynamique et Suspense.
   Terminé quand les données et l'ordre d'arrivée Flight sont observés par les tests.
4. **Interactions locales.** Ajouter listes, formulaires, hover, scroll, raccourcis,
   loading, cancel et refresh. Terminé quand les métriques Server restent inchangées
   pendant ces interactions sous `AIRTTY_LATENCY_MS=500`.
5. **Mutations robustes.** Ajouter runbook, déploiement, conflit et recovery. Terminé
   quand aucun scénario inconnu ne rejoue automatiquement une mutation.
6. **Distribution.** Construire les deux rôles et inspecter les artefacts. Terminé
   quand les marqueurs Server sont absents du Client et qu'un smoke PTY production
   couvre login → incident → sauvegarde → déploiement.
7. **Documentation.** Ajouter au README la commande de lancement, les identifiants de
   démo, le keymap, le scénario 500 ms et les limites honnêtes. Terminé quand une
   personne fraîche peut reproduire le parcours sans lire le code.

## Vérification

Ajouter des tests ciblés plutôt qu'un seul scénario opaque : repository, auth,
build/graphes, navigation, draft/recovery, latence et PTY. Réutiliser les helpers et
les conventions existants.

Avant livraison, obtenir :

```sh
bun run check
bun run lint
bun run format:check
bun test --max-concurrency 1 --timeout 20000
bun run build
```

Construire aussi explicitement la démo :

```sh
bun packages/airtty/src/cli.ts build --app examples/control-room
```

Lancer ensuite son Server et son Client de production sur un port isolé dans le
smoke. Ne pas tuer un processus de développement appartenant à une autre session en
cas de collision de port.

## Handoff final attendu

Livrer :

- la liste des parcours réellement fonctionnels ;
- la matrice ci-dessus renseignée avec fichiers et tests ;
- les commandes de reproduction locale et production ;
- les résultats exacts des validations ;
- les limites ou frictions découvertes, séparées entre responsabilité framework et
  responsabilité application ;
- des commits cohérents, sans artefacts `.airtty`, base SQLite ou logs suivis.

La mission est terminée uniquement lorsque le scénario complet fonctionne sous
latence simulée et dans les artefacts de production, pas seulement dans des tests de
composants isolés.
