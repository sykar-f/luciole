# API applicative minimale

Entrée `@terminal/framework/client` (Client Components uniquement) :

| API               | Contrat                                                                                            |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `useNavigation()` | `{ path, pending, navigate(path), refresh(), cancel() }`. État réactif et navigation Server.       |
| `useDraft(note)`  | `{ draft, edit, save, recover, discard }`. Store au-dessus des routes, indexé par identité métier. |
| `Note`            | `{ id, title, value, version }` ; types importables côté Server avec `import type`.                |
| `Snapshot`        | `{ id, value, version, revision, operationId }` ; snapshot soumis immuable par convention.         |
| `SaveResult`      | `{ ok: true, note, operationId }` ou `{ ok: false, error, operationId }`.                          |

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
inexploitable rend l’issue inconnue. Après réponse métier, le framework demande
un refresh séparé si la navigation n’a pas changé depuis l’appel. Le résultat de
l’action reste acquis si ce refresh échoue.

Les fonctions `createApplication`, `Shell`, `serve` et `build` servent au CLI,
aux tests et aux intégrateurs du framework. Le résolveur de modules est une fonction
`(moduleId) => exports`, injectée dans `createApplication`. Le MVP accepte un seul
runtime applicatif par processus Client ; le registre est global pour satisfaire
le contrat bundler du codec Flight. Aucun chargement de chunks distants.

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

Le layout racine enveloppe aussi les pages publiques. S'il affiche l'utilisateur,
il doit donc utiliser `getOptionalSession()` et accepter le cas `null`; réserver
`getSession()` aux pages, actions et repositories qui exigent effectivement une
identité.

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

## Navigation et chargement local

Le framework sépare la route confirmée (`path`) de la navigation en cours
(`pending`, soit `null`, soit `{ path, kind: "navigate" | "refresh" }`).
`useNavigation()` s’abonne à cet état. La réponse de la génération la plus récente
gagne ; commencer une nouvelle navigation annule la requête précédente et ignore
ses éventuels résultats tardifs, même si le transport ne respecte pas l’annulation.

Une navigation vers une autre route remplace immédiatement le contenu de route
par un écran local. Le shell du framework reste monté. Déclarer par exemple :

```tsx
// app/notes/[id]/loading.tsx
"use client";
import type { LoadingProps } from "@terminal/framework/client";
export default function Loading({ params }: LoadingProps) {
  return <text>Opening note {params.id}…</text>;
}
```

Le build sélectionne le `loading.tsx` le plus proche dans les parents de chaque
`page.tsx`, jusqu’à `app/loading.tsx`. Sans déclaration, le framework affiche
« Loading… ». Les routes statiques précèdent les paramètres dynamiques, avec la
même sélection côté Client et Server. `LoadingProps` fournit `path` et `params` ;
aucune donnée Server n’est disponible avant sa réponse. Le fichier doit exporter
un composant Client par défaut, destiné à un rendu synchrone et local. Son graphe
est soumis aux mêmes contrôles d’imports que les autres Client Components et il
entre dans l’identité du build.

Quand aucun arbre n’a encore été reçu, le shell utilise son propre fallback
« Connecting… » pulsé. Ce fallback est fourni par le framework, reste à hauteur
fixe et utilise la même animation native côté Client que l’exemple Notes.

L’écran local couvre l’attente avant le premier modèle Flight, puis sert aussi de
fallback Suspense pour le contenu de route. Les frontières Suspense déclarées dans
les pages Server continuent à gérer leurs sous-arbres progressifs. Ce mécanisme
ne télécharge pas le loading sur demande : il est déjà dans l’artefact Client.

Un refresh de la route courante conserve l’arbre monté et affiche « Refreshing… » :
le champ, son focus et sa saisie restent actifs. `refresh()` pendant une navigation
relance la destination en cours. Un changement de route démonte l’ancien écran,
pour désactiver ses interactions, mais conserve les Drafts du store de session.
Les autres états React propres à cet écran ne sont pas conservés lors du démontage.
Les versions de Notes sont monotones : restaurer une vue plus ancienne ne peut pas
remplacer une confirmation de sauvegarde plus récente dans le store.

`cancel()` revient localement à la dernière route confirmée sans attendre le
Server ; Échap l’appelle pendant une navigation vers une autre page. Une navigation
initiale sans page précédente ne peut pas être annulée. En cas d’échec, le framework
réaffiche la dernière route confirmée et son erreur ; un refresh échoué laisse
l’éditeur monté. Les annulations de navigation n’annulent jamais une mutation.

Le layout Server actuel appartient au modèle Flight complet ; seul le shell du
framework est persistant. Le loading décrit donc le contenu d’attente entier de
la route, pas un emplacement dans un layout Server déjà connu. Les layouts imbriqués
persistants et le préchargement de routes nécessiteraient un contrat de segments
supplémentaire ; ils ne sont pas implicites dans cette convention.

### Géométrie du loading

Un écran d’attente et son contenu final doivent partager leurs règles de layout.
Notes utilise `components/NoteFrame.tsx`, un module de présentation sans accès
Server : même layout, titre sur une ligne, cadre de champ de cinq lignes,
emplacements fixes pour statut, messages et aide. Le texte long est tronqué dans
ces emplacements. Le shell affiche les indications de navigation et de refresh
dans son en-tête de hauteur fixe. Aucun élément temporaire ne décale la page.

Le framework ne peut pas déduire les dimensions d’une page Server encore inconnue :
cette stabilité est un contrat de présentation de l’application, vérifié par les
tests de géométrie. Une animation de loading doit conserver ces dimensions et ne
modifier que les couleurs ou des glyphes de largeur constante. Notes fournit une
pulsation grise locale avec `useTimeline` d’OpenTUI : son cycle complet dure 1,7 seconde,
avec une opacité qui varie de 1 à 0,2 puis revient à 1. Le squelette part d’un gris clair pour
rester perceptible sur les terminaux sombres. Le nettoyage arrête la timeline au
démontage ; elle ne touche ni au transport ni à l’état Server.
