# Cache Server `"use cache"` et invalidation par tags

Inspiré des Cache Components de Next.js 16, réduit à ce qu'un Client terminal utilise :
des **lectures de données** mises en cache côté Server, étiquetées par tags, et une
invalidation qui purge ce cache puis revalide **seulement** les routes Client qui ont lu
ces tags.

```ts
// server/queries.ts
"use cache";
import { cacheLife, cacheTag } from "airtty/server";
import { listNotes } from "./repository";

export async function notesOf(owner: string) {
  cacheTag(`notes:${owner}`);
  cacheLife("hours");
  return listNotes(owner);
}
```

```ts
// actions/notes.ts
"use server";
import { getSession, invalidate } from "airtty/server";

export async function saveNote(snapshot: Snapshot) {
  const result = save(snapshot);
  if (result.ok) await invalidate({ tag: `notes:${getSession().userId}` });
  return result;
}
```

## Déclarer

- **Module** : `"use cache"` en tête de fichier met en cache chaque fonction exportée.
  Le module n'exporte que des déclarations `export async function nom()` (et des types) ;
  ses fonctions non exportées restent des helpers ordinaires.
- **Fonction** : `"use cache"` en première instruction du corps d'une
  `export async function` déclarée au niveau du module.

Le build refuse, en citant fichier et ligne : une closure, une méthode, une fonction
fléchée, une fonction non exportée ou synchrone, un export par défaut (un composant de
page), une valeur exportée ou une réexportation dans un module `"use cache"`, une
directive qui n'ouvre pas le corps, `"use cache"` dans un module `"use server"` (ses
fonctions reçoivent des arguments du Client : mettre en cache les fonctions qu'elles
appellent) ou `"use client"`, et un module `"use cache"` atteint par le graphe Client.
Une closure capturerait des valeurs de la requête dans un résultat partagé ; les
fonctions exportées ont un identifiant stable (`chemin#nom`).

La transformation n'a lieu que dans le bundle Server : le build ajoute à la fin du module
`nom = cached(nom, "chemin#nom")`. Une déclaration de fonction est une liaison mutable et
les exports ESM sont vivants : les importeurs, et les appels internes au module, passent
par l'enveloppe.

## Clé, valeurs et déduplication

La clé est le SHA-256 de `buildId`, de l'identifiant de la fonction et des arguments
encodés par le codec de réponse de React Flight (`encodeReply`, celui des arguments de
Server Functions) : `Date`, `Map`, `Set`, `BigInt`, `undefined` survivent, et un même
argument donne toujours le même texte. **Un nouveau build ne lit jamais les entrées d'un
autre.** Le résultat est encodé de la même façon puis décodé à chaque lecture : chaque
appelant reçoit sa propre copie.

Sont refusés avec une erreur explicite : un async iterable ou un `ReadableStream`
(résultat ou argument, même imbriqué ; il ne se lit qu'une fois et peut ne jamais
finir), un élément React, une fonction Client, un `Blob`. Le cache stocke des
**données**, pas des arbres : mettre en cache un composant de page n'est pas pris en
charge (écart assumé avec Next.js, voir « Limites »).

Les appels concurrents d'une même clé partagent un seul calcul ; ceux qui le rejoignent
sont comptés comme `hit`. Une exception n'est jamais mise en cache.

## `cacheLife` et `cacheTag`

Appelables uniquement pendant l'exécution d'une fonction `"use cache"` (sinon ils lèvent).

- `cacheTag(...tags)` : étiquette le résultat. Un tag est fait de 1 à 256 caractères ASCII
  visibles, sans virgule ; au plus 64 par résultat. Encoder
  les identifiants libres (`encodeURIComponent`), comme `examples/notes/server/tags.ts`.
- `cacheLife(profil | { revalidate?, expire? })`, en **secondes** comme Next.js.
  Profils (`revalidate` / `expire`) : `default` (900 / jamais), `seconds` (1 / 60),
  `minutes` (60 / 3600), `hours` (3600 / 86 400), `days`, `weeks`, `max`. Un champ
  omis reprend `default` ; `revalidate` ne dépasse pas `expire`. Plusieurs appels : la
  durée la plus courte de chaque champ gagne.
  - âge < `revalidate` : `hit` ;
  - `revalidate` ≤ âge < `expire` : `stale`, l'ancienne valeur est servie tout de suite et
    une nouvelle est calculée derrière (un échec garde l'ancienne jusqu'à `expire`) ;
  - âge ≥ `expire` : `miss`, l'appelant attend le calcul.
  - Pas de `stale` (la fraîcheur côté Client de Next.js) : elle ne s'appliquerait à rien
    ici, et `cacheLife({ stale })` est refusé. La fraîcheur côté Client est
    `export const staleTime` de la page (plus bas).

Une fonction cachée qui en appelle une autre hérite de ses tags et de sa durée la plus
courte : invalider le tag intérieur invalide aussi le résultat extérieur.

## Identité interdite

`getSession()` et `getOptionalSession()` **lèvent** dans une fonction cachée (et dans tout
ce qu'elle appelle) : son résultat est partagé par tous les appelants des mêmes
arguments. L'identité passe en argument :

```ts
export default async function Page() {
  return <NoteList notes={await notesOf(getSession().userId)} />;
}
```

## Handler

```ts
type CacheEntry = {
  value: string; // résultat encodé, opaque
  tags: readonly string[];
  createdAt: number; // epoch ms
  revalidate: number; // secondes
  expire: number; // Infinity : jamais
};
type CacheHandler = {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): void | Promise<void>;
  invalidateTags(tags: readonly string[]): void | Promise<void>;
};
```

- `memoryCache({ maxEntries = 1000 })`, par défaut : ce processus seulement, le moins
  récemment utilisé sort en premier, vidé à chaque redémarrage (donc à chaque rebuild de
  `airtty dev`).
- `sqliteCache({ path, maxEntries = 10 000 })` (`bun:sqlite`) : survit aux redémarrages et
  se partage entre les processus Server d'une machine ; les plus anciennes entrées
  sortent au-delà de `maxEntries`, ce qui élimine aussi celles des builds précédents.

L'application choisit par un fichier optionnel `server/cache.ts`, sur le modèle de
`server/auth.ts` : le build l'inclut dans le seul graphe Server et passe son export par
défaut à `serve({ cache })`.

```ts
// server/cache.ts
import { sqliteCache } from "airtty/server";
export default sqliteCache({ path: process.env.CACHE_DB ?? "cache.sqlite" });
```

La fraîcheur est décidée par le runtime, pas par le handler. `invalidateTags` doit avoir
supprimé les entrées avant de se résoudre : le Client relit juste après.

## Invalidation : chemins ou tags

`invalidate()` garde sa forme et accepte en plus un objet :

| Appel                      | Effet                                                                       |
| -------------------------- | --------------------------------------------------------------------------- |
| `invalidate()`             | Revalide toutes les routes du Client (`"/"`).                               |
| `invalidate("/repos/web")` | Revalide ce chemin et ses descendants, jamais un simple préfixe.            |
| `invalidate({ tag: "t" })` | Purge les résultats étiquetés `t`, puis revalide les routes qui ont lu `t`. |

```ts
function invalidate(path?: string): void; // Server Function seulement
function invalidate(target: { tag: string }): Promise<void>; // partout côté Server
```

Pourquoi un objet plutôt qu'une convention sur la chaîne (« commence par `/` ») ou une
seconde fonction : un seul verbe pour « ceci a changé », et le **type** distingue les deux
cas. Un tag qui commencerait par `/` n'est jamais pris pour un chemin, TypeScript guide
l'appel, et les appels existants `invalidate(path?)` ne changent pas. Les deux formes se
combinent dans une même Server Function.

La purge commence tout de suite et la promesse se résout quand les entrées ont disparu.
Dans une Server Function, la réponse l'attend de toute façon : `await` ne coûte rien et
satisfait `no-floating-promises`. Un calcul
commencé avant l'invalidation n'écrit pas son résultat s'il porte un tag invalidé, et les
appels suivants ne le rejoignent plus. Les tags invalidés voyagent dans l'enveloppe de la
réponse (`tags`) avec les chemins : une réponse perdue n'invalide rien côté Client (la
purge Server, elle, a eu lieu).

Un chemin ne purge pas le cache Server : les entrées ne savent pas quelles routes les ont
lues. Pour purger, invalider par tag.

### Hors d'une Server Function

`invalidate({ tag })` s'appelle aussi **hors de toute Server Function** : tâche de fond,
webhook, pendant un rendu, agent DevTools. Il purge alors **le cache Server seulement** :
aucune réponse ne part vers un Client, donc aucun Client n'est prévenu ni ne revalide.
Chacun lit les données fraîches à son prochain rendu de la route (navigation, `refresh()`,
fin du `staleTime`, autre invalidation) ; un arbre déjà en cache dans un routeur reste
affiché jusque-là. L'événement `cache` (`op: "invalidate"`, `key` et `fn` vides, `tags`)
est émis comme dans une action, avec `callId: ""` hors requête.

`invalidate(path)` hors d'une Server Function reste une erreur : sans réponse, aucun Client
ne peut l'entendre.

**Entrée pour l'agent DevTools Server** (`src/devtools/`, dans le processus Server) :

```ts
import { invalidate } from "../server"; // airtty/server pour une application

await invalidate({ tag: "notes:local" }); // rejette si le handler échoue
```

Le bundle Server ne contient qu'une copie du runtime : l'agent purge le même cache que
les pages. Un tag invalide (virgule, espace, non-ASCII, > 256 caractères) lève tout de
suite.

## Tags d'un rendu et invalidation précise côté Client

Pendant `/render`, chaque lecture cachée (hit ou miss) ajoute ses tags à ceux du rendu,
y compris celles des composants Server asynchrones sous `Suspense`. Les tags voyagent
**dans le flux Flight** : le modèle racine de `/render` est

```ts
{
  tree: ReadableStream<Uint8Array>;
  tags: Promise<string[]>;
}
```

`tree` est la page rendue dans **son propre flux Flight**, que le Client décode à son tour ;
`tags` se résout quand ce flux s'est terminé, donc quand tout le rendu l'est (`Suspense`
compris). Pourquoi un flux imbriqué plutôt que `{ tree, tags }` directement dans une seule
réponse : Flight ne signale à personne qu'une réponse est complète en continuant de la
diffuser, et une promesse en attente dans la même réponse l'empêcherait justement de se
terminer. Le flux de la page, lui, se termine : c'est lui qu'on observe. Le coût est un
encadrement binaire des octets de la page (quelques octets par morceau) et un second
décodage côté Client.

Rien n'attend la page avant les en-têtes : ils partent tout de suite, la coquille suit dès
que Flight l'écrit, et les tags arrivent après le dernier morceau. Il n'y a plus d'en-tête
`x-airtty-tags`.

Le Client retient les tags de chaque arbre chargé (par l'objet que garde son match
TanStack). À l'invalidation par tag, il revalide les routes dont l'arbre a lu un de ces
tags, plus celles dont il ne connaît pas les tags (encore en chargement, ou rendues par un
transport qui n'en envoie pas) : jamais une route qui a pu lire un tag n'est oubliée.
`useInvalidation((paths, tags) => …)` reçoit aussi les tags. Le loader se résout avec
l'arbre, avant les tags : entre les deux, la route compte comme ayant lu n'importe quel tag.
Un flux coupé ne livre jamais ses tags ; la route reste alors dans ce cas prudent.
`Transport.render` les rapporte par `RequestContext.onTags`, appelé après sa résolution.

Avec `staleTime` 0 (le défaut), TanStack recharge toute route **montée** à chaque
invalidation, ciblée ou non : la précision porte sur les routes en cache et sur les pages
qui déclarent un `staleTime`.

## `staleTime` d'une page

```ts
export const staleTime = 30; // secondes ; un littéral ou un produit (5 * 60)
```

Devient le `staleTime` TanStack de la route (en millisecondes dans `routeTree.gen.ts`) :
pendant cette durée, revenir sur la page affiche l'arbre en cache **sans requête**. Sans
déclaration, `staleTime` vaut 0 : l'arbre en cache s'affiche puis se revalide. Une
invalidation (chemin, tag, `refresh()`) passe outre.

## Événements

Server, via `serve({ instrument })`, en plus des événements de requête :

```ts
{ type: "cache", op: "hit" | "miss" | "stale" | "write" | "invalidate",
  key, fn, tags, callId, ms, at }
```

`key` est la clé hachée (vide pour `invalidate`), `fn` la fonction (`server/queries.ts#notesOf`,
vide pour `invalidate`), `tags` ceux de l'entrée (ou les tags invalidés), `callId` celui de
la requête qui a causé l'opération, `ms` sa durée, `at` en epoch ms (même horloge que le
Client). Ordre : `miss` est émis quand la fonction a rendu sa valeur, après le `write` de
cette valeur ; `stale` précède le `write` du rafraîchissement.

Client, via `onEvent` : chaque `loader` porte `source`. `network` : le loader a tourné
(requête, ou réponse d'un décorateur de transport). `router-cache` : une navigation a
affiché une page que le routeur avait en cache sans appeler son loader (fraîche selon
`staleTime`, préchargée, ou Échap) : rien n'a commencé, seul un `end` est émis, avec
`ms: 0` et `result: "ok"`. Un consommateur distingue les deux par `source === "router-cache"`,
pas par la présence de `source`, que porte chaque `loader`.
L'événement `invalidate` porte `tags` quand des tags ont été invalidés.

## Dans Notes

`server/queries.ts` (`"use cache"`) met en cache la liste et chaque note par
propriétaire, avec les tags de `server/tags.ts`. `saveNote` et `getOperation` invalident
le tag de la liste et celui de la note enregistrée, au lieu de tout revalider : la page de
l'autre note, en cache dans le routeur, n'est pas redemandée. La liste déclare
`staleTime = 30`.

## Limites et suite

- Pas de mise en cache d'arbres React (composants, pages) : le codec de réponse de Flight
  refuse les éléments ; il faudrait décoder du Flight côté Server avec un manifest de
  références Client.
- Pas d'invalidation par tag depuis le Client (`useApplication().invalidate` reste par
  chemin). Hors d'une Server Function, un tag ne purge que le Server (plus haut).
- Dédup et invalidation des calculs en vol sont par processus ; SQLite partage les
  entrées, pas les calculs.
