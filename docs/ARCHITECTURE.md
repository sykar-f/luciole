# Structure et distribution

Le dépôt contient **un framework** et **une application exemple**, sans dépendance
sur TWP. L’application est une codebase unique ; son build produit deux programmes.

## Le framework que nous développons

| Fichier          | Responsabilité                                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/cli.ts`     | Création du starter, commandes dev/build/start, supervision des processus et erreurs de rebuild.                     |
| `src/build.ts`   | Lecture de l’AST, graphes Client/Server, validation des frontières, références Flight, routes, manifests et bundles. |
| `src/server.ts`  | HTTP, contexte de session, rendu des routes et exécution des Server Functions.                                       |
| `src/client.tsx` | Connexion HTTP, shell React persistant, navigation, actions et hooks publics.                                        |
| `src/draft.ts`   | État d’édition, Baseline, révisions, résultats inconnus et store de session.                                         |
| `src/flight/`    | Adapter du vrai codec React Flight et contrat de résolution des modules Client.                                      |

`tests/`, `probes/` et `scripts/` servent à développer et vérifier le framework.
Ils ne sont pas du code à recopier dans chaque application.

## Le code écrit par un développeur d’application

`examples/notes/` représente exactement cette partie :

```text
app/layout.tsx             composition commune côté Server
app/page.tsx               liste côté Server
app/notes/[id]/page.tsx     chargement et composition d’une note
app/notes/[id]/loading.tsx  squelette local pendant la navigation, "use client"
components/NoteList.tsx    sélection/navigation locale, "use client"
components/NoteEditor.tsx  édition et événements locaux, "use client"
actions/notes.ts           fonctions métier appelables, "use server"
server/repository.ts       accès SQLite, droits et transactions
```

Le développeur remplace ces fichiers par ses pages, composants et règles métier.
Il utilise React et les composants OpenTUI, importe les hooks du framework et passe
les Server Functions en props ou les importe dans des Client Components. Il ne
rédige ni protocole RPC, ni registre de modules, ni manifest Flight, ni bootstrap
OpenTUI.

Dans Notes, la page Server charge une note et transmet `saveNote` au composant
`NoteEditor`. Le composant traite chaque frappe localement. À Entrée, il appelle
la référence de `saveNote` ; le framework encode l’appel via Flight, l’envoie au
Server, puis reçoit le résultat et rafraîchit l’arbre. SQLite reste côté Server.

## Deux formes de distribution

**Pour l’auteur d’application**, le produit est le package `@terminal/framework` :
CLI `terminal`, entrées `/client`, `/server`, `/build` et configuration `/tsconfig`.
Aujourd’hui il est privé et local ; le starter utilise une dépendance `file:` vers
le checkout. La publication sur un registre et le nom définitif restent à faire.
Les outils TypeScript/Oxc accompagnent le développement.

**Pour l’utilisateur de l’application**, le build produit :

```text
sources de l’application + framework
                 │ terminal build
                 ├── .terminal/server/ → machine qui exécute le métier et garde la base
                 └── .terminal/client/ → terminal de l’utilisateur
                                          │
                                          └── HTTP/Flight vers un Server compatible
```

Le Client contient le runtime terminal et les Client Components de **cette
application**. Le Server contient le runtime HTTP, les routes, les actions et le
métier. Chacun embarque `index.js`, `package.json` et `bun.lock` ; installer ses
dépendances puis lancer Bun. Le Client n’a pas besoin des sources Server ni de la
base. Les deux artefacts doivent correspondre au même identifiant de build.

Le packaging actuel privilégie la reproductibilité : les manifests de dépendances
des deux rôles sont identiques et incluent aussi les outils de développement.
Réduire ces manifests et publier le package sont des travaux de packaging futurs.
Le code métier reste exclu du bundle Client malgré ce manifeste commun.

Ce n’est pas encore un Client générique qui télécharge une application en ouvrant
une URL. Chaque application distribue son propre Client de confiance. L’interface
de résolution de modules laisse cette évolution possible, mais la distribution
dynamique et son modèle de confiance restent à décider.

Enfin, l’API de Draft actuelle porte encore les types `Note`, `Snapshot` et
`SaveResult`. C’est un raccourci du MVP ; une deuxième application doit guider leur
généralisation avant de présenter cette partie comme une API universelle de formulaires.
