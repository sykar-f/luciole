# API applicative minimale

Entrée `@terminal/framework/client` (Client Components uniquement) :

| API                                                                                                                     | Contrat                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `useNavigate()`, `useRouter()`, `useRouterState()`, `useParams()`, `useLocation()`, `useMatchRoute()`, `useCanGoBack()` | Primitives TanStack Router réexportées telles quelles ; TanStack est l'unique état de navigation.  |
| `useApplication()`                                                                                                      | `{ setToken(token?), refresh(), cancel(), status, error, drafts }` du runtime terminal.            |
| `LayoutProps`                                                                                                           | `{ children, params }` reçu par un `layout.tsx` Client ; `params` limité aux segments du layout.   |
| `LoadingProps`                                                                                                          | `{ path, params }` reçu par un `loading.tsx` Client pendant l'attente de la page.                  |
| `useDraft(note)`                                                                                                        | `{ draft, edit, save, recover, discard }`. Store au-dessus des routes, indexé par identité métier. |
| `Note`                                                                                                                  | `{ id, title, value, version }` ; types importables côté Server avec `import type`.                |
| `Snapshot`                                                                                                              | `{ id, value, version, revision, operationId }` ; snapshot soumis immuable par convention.         |
| `SaveResult`                                                                                                            | `{ ok: true, note, operationId }` ou `{ ok: false, error, operationId }`.                          |

`save(action)` capture le Draft et bloque une deuxième sauvegarde du même document
jusqu’à un résultat connu. La saisie reste active. `recover(action)` consulte le
résultat de l’opération inconnue, sans rejouer la mutation. `discard()` réinitialise
le Draft au dernier état reçu ; une opération en vol/inconnue interdit l’abandon.

Le Draft expose `value`, `baseline`, `revision`, `version`, `pending`, `unknown`,
`dirty`, `conflict`, `error`. Une confirmation ajuste la Baseline du snapshot et la
version métier ; une normalisation remplace la valeur locale seulement si aucune
frappe plus récente n’a changé sa révision. Un refresh externe n’écrase pas un Draft
sale. L’application choisit la politique de conflit ; Notes conserve le Draft et
permet l’abandon explicite. Les clés React sont les identités des notes, jamais
leurs versions métier.

Entrée `@terminal/framework/server` :

- `getSession()` : `{ userId }` dans le contexte async du rendu ou de l’action.
- `getOptionalSession()` : la même session, ou `null` dans une page/action publique.
- `getCallId()` : identifiant de requête de transport, distinct de l’opération métier.

`useApplication().setToken(token)` remplace le bearer token des requêtes suivantes,
sans recréer le Client ni perdre son état local. L’application décide où obtenir,
stocker et renouveler ce token.

Une action vérifie les droits et valide ses arguments côté Server. Les échecs
métier attendus sont des valeurs `SaveResult`. Une erreur réseau, timeout ou réponse
inexploitable rend l’issue inconnue.

Le framework ne rafraîchit rien après une Server Function : une lecture
(`getOperation`, identité publique, recherche) ne coûte aucun rendu de page. Le code
Client qui déclenche une mutation confirmée invalide lui-même, sans attendre :

```tsx
const router = useRouter();
const result = await saveAction(snapshot);
if (result.ok) void router.invalidate().catch(() => {});
```

Sans `await`, le résultat métier est acquis avant le refresh et ne dépend jamais de
son succès. Une invalidation pendant une navigation relance le chargement de la
destination, qui reçoit alors des données postérieures au commit. Oublier
l'invalidation laisse l'écran sur les données précédentes : c'est la responsabilité
de l'application, comme dans TanStack Start.

Les fonctions `createApplication`, `Shell`, `serve` et `build` servent au CLI,
aux tests et aux intégrateurs du framework. Le résolveur de modules est une fonction
`(moduleId) => exports`, injectée dans `createApplication`. Le MVP accepte un seul
runtime applicatif par processus Client ; le registre est global pour satisfaire
le contrat bundler du codec Flight. Aucun chargement de chunks distants.

Le transport est une interface remplaçable (`src/transport.ts`), injectable via
`createApplication({ transport })` :

```ts
interface Transport {
  render(routeId: string, params: RouteParams, signal: AbortSignal): Promise<ReactNode>;
  call(actionId: string, args: unknown[], signal?: AbortSignal): Promise<unknown>;
  setToken(token?: string): void;
}
```

L'adapter par défaut `createHttpTransport` porte l'en-tête de build, le bearer, le
timeout, la latence simulée, les erreurs typées (`TransportError`, `BuildMismatch`,
`AuthenticationRequired`) et le décodage Flight progressif. Le runtime et les tests
utilisent aussi des transports factices.

## Authentification des routes et actions

Les pages et les modules `"use server"` exigent une session par défaut. Une page
publique le déclare explicitement :

```tsx
export const auth = "public" as const;

export default function LoginPage() {
  return <text>Sign in</text>;
}
```

Une application qui remplace l'identité locale fournit `server/auth.ts` :

```ts
import type { AuthConfig } from "@terminal/framework/server";

export default {
  unauthorizedPath: "/login",
  async authenticate(request) {
    const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
    return token ? await sessions.fromToken(token) : null;
  },
} satisfies AuthConfig;
```

Le chemin `unauthorizedPath` doit désigner une route publique existante. Une
navigation sans session vers une route protégée reçoit un `401` puis navigue
localement vers ce chemin. Sans `unauthorizedPath`, le Client reste sur la dernière
route confirmée et expose l'erreur `AuthenticationRequired`.

Les layouts sont des Client Components : ils ne peuvent pas appeler
`getOptionalSession()` ni `getSession()`, réservés aux pages Server, actions et
repositories. Une donnée publique de session nécessaire au chrome (nom affiché,
rôle) est rendue par la page Server ou transmise par l'application via un contexte
Client ; elle ne remplace jamais le contrôle Server.

Le guard Client n'est qu'une amélioration d'UX : chaque rendu `/render` valide
côté Server le `routeId`, les paramètres exacts attendus et la politique d'auth.
Un `routeId` inconnu répond `404`, des paramètres absents, en trop ou non textuels
répondent `400`, une page protégée sans session répond `401`.

`useApplication().setToken()` purge le cache de routes TanStack (et le purge de
nouveau à la fin d'une navigation en cours) : un arbre privé mis en cache sous un
bearer n'est jamais réaffiché sous un autre, ni après logout. Il ne recharge pas la
route montée ; après login/logout, l'application navigue vers la route voulue.

Une action est protégée indépendamment de la page qui fournit sa référence. Pour
autoriser une Server Function sans session, placer les actions publiques dans leur
propre module :

```ts
"use server";
export const auth = "public" as const;

export async function beginLogin() {
  // Valider les arguments même sans session.
}
```

Toutes les fonctions exportées d'un même module partagent cette politique. Une
référence Flight n'accorde aucun droit, et une route protégée ne remplace jamais
les contrôles d'autorisation métier dans l'action ou le repository.

Sans `server/auth.ts`, l'adapter historique reste actif : identité `TERMINAL_USER`
(`local` par défaut), éventuellement protégée par `TERMINAL_TOKEN`. Le starter
reste donc compatible avec son mode local.

## Navigation, layouts et chargement local

> Remplace le contrat précédent (shell seul persistant, layout Server, machine
> d'état `useNavigation()`). Voir `docs/ROUTER.md` pour la décision et ses
> compromis.

TanStack Router (`@tanstack/react-router`, memory history, sans TanStack Start) est
l'unique autorité Client pour le route tree, le matching, les params, les layouts,
le pending, l'annulation, le cache et l'invalidation. Le build compile `app/` en
route tree code-based ; chaque page est chargée par le loader de sa route sous
forme de valeur React Flight :

```text
RouterProvider + createMemoryHistory
  └── app/layout.tsx (Client, persistant)
      └── layout.tsx imbriqués (Client, persistants)
          └── page : loader → Transport.render(routeId, params, signal) → ReactNode Flight
```

Conventions :

- `app/layout.tsx` est obligatoire ; tout répertoire peut déclarer un `layout.tsx`.
  Un layout déclare `"use client"`, exporte un composant par défaut et reçoit
  `{ children, params }` ; `children` est l'outlet des routes descendantes. Le
  build refuse un layout sans directive ou sans export par défaut.
- Un layout reste monté tant que la destination reste sous son segment : état
  local, focus et scroll survivent aux navigations entre ses pages.
- `page.tsx` reste Server par défaut et n'entre jamais dans le bundle Client.
- `(group)` n'apparaît pas dans l'URL ; avec un `layout.tsx`, il devient un layout
  pathless. Les routes statiques précèdent `[param]`. Deux pages de même URL après
  suppression des groupes, deux motifs dynamiques équivalents (`/users/[id]` et
  `/users/[slug]`), un paramètre répété ou un segment mal formé font échouer le
  build en citant les fichiers.
- `loading.tsx` (Client) devient le `pendingComponent` de chaque page qui l'hérite
  (le plus proche parmi ses répertoires parents). Il remplace **seulement** la page :
  les layouts restent affichés autour. Sans déclaration, le framework affiche
  « Connecting… » avant la première réponse, puis « Loading… ».

Le build génère `app/routeTree.gen.ts` (à versionner, ne pas éditer) : il déclare
le `Register` de TanStack, donc `to`, `params` et `useParams` sont typés d'après les
fichiers de l'application. Une route inconnue ou un paramètre manquant est une
erreur TypeScript. Navigation depuis un Client Component, sans `<Link>` DOM :

```tsx
"use client";
import { useNavigate } from "@terminal/framework/client";
const navigate = useNavigate();
void navigate({ to: "/notes/$id", params: { id: "1" } });
```

Comportement observable :

- La dernière navigation gagne. Une navigation qui en remplace une autre annule le
  signal de son loader ; une réponse tardive ne modifie jamais l'écran. Une fois
  le modèle racine reçu, le stream Flight n'est plus lié à ce signal : les
  sous-arbres `Suspense` d'un arbre mis en cache continuent d'arriver.
- Le loading s'affiche immédiatement (`pendingMs = 0`). Échap (`useApplication()
.cancel()`) revient localement à la dernière route résolue, sans la recharger.
- Ctrl+R (`refresh()`) invalide la destination en cours ou la route montée. Pendant
  un refresh, l'arbre reste monté avec « Refreshing… » : champ, focus et saisie
  restent actifs. Un refresh échoué garde l'arbre monté et affiche l'erreur.
- Une navigation échouée affiche son erreur à la place de la page, layouts montés ;
  Ctrl+R réessaie la destination. Les Drafts restent dans le `DraftStore`.
- Un `401` redirige vers `unauthorizedPath` sans rendre de contenu protégé. Un
  `409` (build mismatch) est refusé avant décodage et purge le cache.
- Le cache est celui de TanStack (`staleTime` 0 : une page mise en cache s'affiche
  puis se revalide). Les annulations de navigation n'annulent jamais une mutation.
- Le `DraftStore` est au-dessus du route tree : les Drafts survivent aux
  démontages de pages. Les versions de Notes sont monotones.

Préchargement, `error.tsx`, catch-all, params optionnels et layouts Server
persistants (modèle « un payload Flight par segment ») restent hors contrat.

### Géométrie du loading

Un écran d’attente et son contenu final doivent partager leurs règles de layout.
Notes utilise `components/NoteFrame.tsx`, un module de présentation sans accès
Server : même layout, titre sur une ligne, cadre de champ de cinq lignes,
emplacements fixes pour statut, messages et aide. Le texte long est tronqué dans
ces emplacements. Le chrome du framework affiche les indications de navigation et
de refresh dans son en-tête de hauteur fixe. Aucun élément temporaire ne décale la page.

Le framework ne peut pas déduire les dimensions d’une page Server encore inconnue :
cette stabilité est un contrat de présentation de l’application, vérifié par les
tests de géométrie. Une animation de loading doit conserver ces dimensions et ne
modifier que les couleurs ou des glyphes de largeur constante. Notes fournit une
pulsation grise locale avec `useTimeline` d’OpenTUI : son cycle complet dure 1,7 seconde,
avec une opacité qui varie de 1 à 0,2 puis revient à 1. Le squelette part d’un gris clair pour
rester perceptible sur les terminaux sombres. Le nettoyage arrête la timeline au
démontage ; elle ne touche ni au transport ni à l’état Server.
