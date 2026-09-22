# Étude — layouts imbriqués et groupes de routes

## Décision proposée

Ajouter deux conventions au routeur existant :

1. `layout.tsx` peut exister dans tout répertoire sous `app/` et enveloppe les
   pages descendantes ;
2. un répertoire nommé `(group)` participe à l'arbre physique mais pas à l'URL.

Cette première livraison garantit la **composition Server** des layouts. Elle ne
garantit pas leur persistance pendant une navigation. La persistance requiert un
protocole de segments Client/Flight distinct et doit faire l'objet d'un RFC puis
d'un prototype séparés.

Le gain net est positif : le build possède déjà la découverte des pages, les
graphes Client/Server, le matching, le loading et le manifest. Faire reconstruire
cette logique dans chaque application produirait des conventions incompatibles et
ne permettrait pas de contrôler le démontage effectué par le shell.

## Sémantique visée

```text
app/
├── layout.tsx
├── page.tsx                         → /
├── (public)/
│   └── login/
│       ├── page.tsx                 → /login
│       └── loading.tsx
└── (workspace)/
    ├── layout.tsx                   → layout pathless
    ├── dashboard/
    │   └── page.tsx                 → /dashboard
    └── projects/
        ├── layout.tsx               → layout du segment /projects
        ├── new/
        │   └── page.tsx             → /projects/new
        └── [projectId]/
            ├── layout.tsx
            ├── loading.tsx
            ├── page.tsx             → /projects/[projectId]
            └── settings/
                └── page.tsx         → /projects/[projectId]/settings
```

Pour `/projects/42/settings`, le modèle rendu est :

```tsx
<RootLayout params={{}}>
  <WorkspaceLayout params={{}}>
    <ProjectsLayout params={{}}>
      <ProjectLayout params={{ projectId: "42" }}>
        <SettingsPage params={{ projectId: "42" }} />
      </ProjectLayout>
    </ProjectsLayout>
  </WorkspaceLayout>
</RootLayout>
```

Contrat :

- `app/layout.tsx` reste obligatoire ;
- un `layout.tsx` n'a pas besoin d'un `page.tsx` frère ;
- les layouts sont ordonnés de la racine vers la feuille ;
- chaque layout reçoit `{ children, params }` ;
- `params` contient les paramètres dynamiques connus jusqu'au segment du layout,
  tandis que la page reçoit tous les paramètres de la route ;
- un layout suit les frontières de compilation existantes : Server par défaut,
  ou Client avec `"use client"` ;
- `(group)` n'ajoute ni segment d'URL ni paramètre ; sans `layout.tsx`, il sert
  uniquement à organiser les sources ;
- le `loading.tsx` le plus proche dans l'ascendance physique reste le fallback de
  toute la route ;
- les routes statiques restent prioritaires sur `[param]`.

TanStack distingue les pathless layouts préfixés par `_`, qui enveloppent leurs
descendants, des groupes `(name)`, qui ne changent ni l'URL ni l'arbre rendu
([Routing concepts](https://tanstack.com/router/latest/docs/routing/routing-concepts),
[File-based routing](https://tanstack.com/router/latest/docs/routing/file-based-routing)).
Terminal RSC utilise déjà les conventions Next-like `layout.tsx`, `page.tsx` et
`[param]` : `(group)/layout.tsx` conserve cette cohérence. Le groupe seul organise ;
c'est le fichier `layout.tsx` qui ajoute l'enveloppe.

## Trois interfaces considérées

### A. Convention seule, branches compilées — recommandée

L'interface applicative se limite aux deux conventions ci-dessus. Un module interne
compile l'inventaire de fichiers en branches complètes :

```ts
type RoutePlan = {
  id: string;
  path: string;
  pageFile: string;
  layouts: readonly {
    file: string;
    params: readonly string[];
  }[];
  loadingFile?: string;
  auth: "public" | "required";
};

function compileRoutePlans(files: readonly RouteFile[]): readonly RoutePlan[];
```

Le build génère ensuite une fonction de rendu par feuille. `serve()` reçoit des
routes déjà composées et ignore les conventions filesystem.

Cette interface a la meilleure profondeur : aucune nouvelle fonction à apprendre
pour l'auteur d'application, tandis que découverte, validation, ordre des layouts,
loading, graphes et génération restent derrière une seule seam interne.

### B. Arbre de routes runtime avec `Outlet`

Chaque layout devient un nœud runtime identifié et rend un `<Outlet>`. Le Server et
le Client partagent un manifest arborescent, et la navigation cible un nœud plutôt
qu'une branche aplatie.

Cette interface prépare mieux la persistance segmentée et les futurs loading/error
par segment. En revanche elle expose prématurément des identifiants, un outlet, des
règles de cache et une sémantique d'invalidation que le protocole actuel ne sait pas
tenir. Pour la seule composition, le module serait shallow : l'appelant apprendrait
presque autant de concepts que l'implémentation n'en fournit.

### C. Adapter vers TanStack Router ou React Router

Un adapter traduirait leurs arbres, outlets et matches vers Flight et OpenTUI. Cela
externaliserait le parsing des chemins, mais pas la partie coûteuse : graphes de
compilation, références Flight, loading local, auth, remplacement de l'arbre et
génération des deux bundles.

Leur runtime Client, leur historique, leurs hooks et leur intégration bundler ne se
branchent pas sur la seam actuelle. L'adapter serait presque aussi complexe que le
petit compilateur interne et introduirait une seconde autorité sur la navigation.
Le gain net est négatif tant que Terminal RSC ne prend en charge que les segments
statiques et `[param]`.

## Module et locality

Extraire de `src/build.ts` un module interne, par exemple `src/route-tree.ts`. Sa
petite interface reçoit un inventaire déterministe et retourne des `RoutePlan` ou
des diagnostics. Son implémentation cache :

- classification des fichiers et segments ;
- suppression des groupes dans les patterns URL ;
- chaîne ordonnée des layouts ;
- portée des paramètres de chaque layout ;
- héritage du loading ;
- ordre statique/dynamique ;
- détection des collisions ;
- identifiants stables et données de manifest.

La transformation est in-process et doit être testée comme une fonction pure. Le
filesystem est local-substituable par les fixtures temporaires existantes ; exposer
un port filesystem n'ajouterait aucune valeur avec un seul adapter réel.

Le manifest de diagnostic devrait rendre la décision inspectable :

```json
{
  "path": "/projects/[projectId]",
  "auth": "required",
  "page": "app/(workspace)/projects/[projectId]/page.tsx",
  "layouts": [
    "app/layout.tsx",
    "app/(workspace)/layout.tsx",
    "app/(workspace)/projects/layout.tsx",
    "app/(workspace)/projects/[projectId]/layout.tsx"
  ],
  "loading": "app/(workspace)/projects/[projectId]/loading.tsx"
}
```

## Diagnostics obligatoires

Le build doit échouer avant de générer les bundles pour :

- un `layout.tsx` sans export par défaut ;
- `()` ou un nom de groupe aux parenthèses mal formées ;
- deux pages donnant la même URL après suppression des groupes ;
- deux patterns dynamiquement équivalents, comme `/users/[id]` et
  `/users/[slug]` ;
- un nom de paramètre répété dans une branche.

Une collision doit citer les deux fichiers. Les chemins sources, groupes inclus,
servent d'identifiants stables ; les patterns URL, groupes exclus, servent au
matching. Le hash de build inclut tous les layouts effectivement utilisés.

La complexité attendue est `O(F + S)` au build, avec `F` fichiers et `S` la somme
des profondeurs des pages. La composition crée `O(D)` éléments React pour une
branche de profondeur `D`. Elle n'ajoute ni roundtrip ni code de routing au Client.

## Auth : garder la feuille comme autorité en v1

La première version doit conserver l'auth sur `page.tsx` et sur les modules
`"use server"` :

- une page est `required` par défaut et peut déclarer `auth = "public"` ;
- l'auth de chaque action reste indépendante ;
- un layout commun à des pages publiques et privées utilise
  `getOptionalSession()`.

Faire hériter `auth` depuis un layout semble attrayant pour `(public)` et
`(workspace)`, mais oblige immédiatement à définir les downgrades : une page
publique peut-elle ouvrir un layout `required` qui appelle `getSession()` ? Le
défaut sécurisé rend en outre les annotations `required` de groupe largement
redondantes. Ce coût sémantique dépasse le gain actuel.

Une évolution ultérieure pourrait traiter `auth` sur un layout comme une valeur
par défaut de sous-arbre, avec diagnostics empêchant toute ouverture sous un
ancêtre explicitement verrouillé. Elle mérite son propre contrat et ses tests ; elle
ne doit pas être implicite dans les layouts imbriqués.

## Composition n'est pas persistance

Aujourd'hui, `Shell` remplace explicitement l'arbre courant par le composant de
loading dès qu'une navigation change de route. Tous les layouts de la route sont
donc démontés avant l'arrivée du nouveau modèle Flight. React pourrait parfois
réconcilier deux Client Components identiques, mais le framework ne peut pas en
faire un invariant avec ce cycle de rendu.

La première phase garantit seulement :

- composition et chargement de données Server partagés ;
- chrome visuel commun ;
- passage de Client Components et Server Functions dans la chaîne ;
- organisation pathless des sources.

Une vraie persistance exige un nouveau module de navigation segmentée :

- identités stables des segments physiques ;
- branche courante et destination connues du Client ;
- conservation de leur préfixe commun ;
- slots stables et remplacement du seul suffixe divergent ;
- payload Flight adressable par segment ;
- loading, erreur, annulation et génération par slot ;
- règles de refresh, invalidation, cache et éviction ;
- politique de recalcul des layouts Server.

Ce travail traverse le build, le manifest, `src/server.ts` et `src/client.tsx`. Il
doit commencer par un prototype qui prouve qu'un Client Component de layout garde
son état, son focus et son scroll entre deux feuilles, y compris sous latence et
annulation. Des clés React ajoutées à l'arbre complet ne suffisent pas.

## Séquence d'implémentation recommandée

1. Extraire `compileRoutePlans` sans changer le comportement actuel. Terminé quand
   les tests existants passent via sa seule interface.
2. Découvrir tous les `layout.tsx`, calculer les chaînes et générer les fonctions de
   rendu. Terminé quand un test Server observe l'ordre root → feuille et la portée
   correcte des params.
3. Ajouter `(group)` et les collisions canoniques. Terminé quand groupes imbriqués,
   groupes organisationnels et ambiguïtés dynamiques sont couverts.
4. Faire suivre loading, graphes et build ID. Terminé quand un layout Client, un
   import Server invalide et un changement de layout sont vérifiés.
5. Documenter explicitement l'absence de persistance et migrer une application
   exemple pour exercer plusieurs branches.
6. Ouvrir séparément le RFC de navigation segmentée ; son prototype est terminé
   uniquement lorsque l'état, le focus et le scroll d'un layout survivent à une
   navigation réelle.

## Verdict contradictoire

À développer dans le framework : découverte, composition, groupes pathless,
matching déterministe, diagnostics, intégration aux graphes et au manifest. Ce sont
des capacités impossibles à fournir correctement depuis une application sans
dupliquer le compilateur ou contourner le shell.

À laisser à l'application : contenu visuel, lecture de données, navigation métier,
contrôles d'autorisation métier et choix de placer un layout au bon niveau.

À différer : héritage d'auth, `error.tsx`, catch-all, paramètres optionnels, layouts
persistants et cache segmenté. Leur valeur est plausible, mais ils ne sont pas
nécessaires pour obtenir le gain immédiat et ils élargiraient fortement l'interface.
