# Frontières de compilation

Le compilateur utilise l’AST TypeScript et le checker pour résoudre les exports.
Les directives sont reconnues uniquement dans le prologue du module. Il n’existe
aucune transformation de directive par regex.

Un module Server est le défaut dans le graphe des routes. Il peut importer le métier
et les actions, et composer des références de Client Components. Son JSX utilise
`react/jsx-runtime` sous `--conditions=react-server` : aucun import natif OpenTUI.

Les `layout.tsx`, `loading.tsx`, `error.tsx` et `not-found.tsx` sont toujours des
Client Components : ils
doivent déclarer `"use client"` et un export par défaut, sinon le build échoue avec
fichier/ligne. Ils ne peuvent donc importer ni `airtty/server`, ni un
module `server/`. Les pages restent Server et n'entrent jamais dans le bundle Client.

`"use client"` coupe le graphe Server. Tous les imports et réexports runtime locaux
accessibles depuis cette frontière appartiennent au graphe Client. Le build génère
une Client Reference par export runtime et un manifest, puis assemble le registre
de modules installés dans le bundle Client. Les types seuls ne créent pas d’arête.

`"use server"` autorise des **déclarations de fonctions async nommées et exportées** :

```ts
"use server";
export async function saveNote(snapshot: Snapshot): Promise<SaveResult> {
  return repository.save(snapshot);
}
```

Le build enregistre ces fonctions dans le dispatcher Server et dans Flight. Un
import Client du même module est remplacé par un proxy Flight, sans embarquer ses
imports métier. Une référence reçue en prop suit le même `callServer`. Arguments et
résultats utilisent le codec Flight, et non un remplacement JSON de RSC.

Les fonctions inline, captures de closures, exports d’actions par variable, default
ou réexport sont refusés avec fichier/ligne. Les réexports de Client Components
restent supportés. Les fonctions liées avec `.bind` et le passage de références
d’actions en arguments d’autres actions ne font pas partie de l’API validée du MVP.

Le seul export runtime supplémentaire autorisé dans un module `"use server"` est
`export const auth = "public" | "required"`. Il décrit toutes les actions nommées
du module et n'est ni enregistré comme Server Function ni envoyé au Client. La
valeur par défaut est `"required"`. Les pages utilisent la même métadonnée ; leur
valeur est enregistrée dans le manifest de routes.

Le graphe Client refuse :

- les modules sous `server/` et tout import transitif de `server-only` ;
- `airtty/server` ;
- `require()` et `import()` dynamiques dans les sources applicatives.

Les builtins `node:*` et `bun:*` ne décident pas du côté d'un module : le Client
tourne sur Bun, il peut lire un fichier, lancer un processus ou ouvrir une base locale,
comme un package. Seuls `server-only` (ou le répertoire `server/`) et `client-only`
rangent un module d'un côté, pour le code applicatif comme pour les packages. Un module
métier qui ouvre la base du Server doit donc le déclarer : sans marqueur, il serait
embarqué dans le Client et ouvrirait une base sur la machine de l'utilisateur.

TanStack Router est l'intégration auditée du runtime : les applications
utilisent ses primitives via `airtty/client`, et le bundle Client l'embarque en forçant
sa variante navigateur de `@tanstack/router-core/isServer`.

## Rester d'un seul côté

Une règle par intention :

| Intention                                        | Moyen                                                        |
| ------------------------------------------------ | ------------------------------------------------------------ |
| Un composant rendu par le Server                 | `"use client"` (frontière : le Server reçoit des références) |
| Du code qui ne doit jamais atteindre le Client   | `import "server-only"`, ou un fichier sous `server/`         |
| Du code qui ne doit jamais tourner sur le Server | `import "client-only"`                                       |

`"use client"` et `client-only` ne sont pas équivalents. Une page peut importer un
module `"use client"` : elle n'en reçoit que des références, et un appel direct côté
Server échoue à l'exécution. Un module qui importe `client-only` ne doit pas être
atteint dans le graphe Server hors d'une frontière `"use client"` : le build échoue.
Le Client et le Server tournant tous deux sur Bun, un code destiné au terminal de
l'utilisateur (`$EDITOR`, `~/.config`, presse-papiers) ne plante pas sur le Server, il
agit sur la mauvaise machine : c'est ce que `client-only` empêche. Exemple réel :
`examples/forge/components/editor.ts` (voir [FORGE.md](FORGE.md#ouvrir-le-fichier-dans-son-éditeur-client-only)).

Les deux marqueurs valent pour le code applicatif et pour les packages npm, qui ne
peuvent pas être renommés. Il n'y a pas de suffixe `*.server.*` ni `*.client.*`.
Ils ne demandent aucun package : le build les résout en modules vides, et
`airtty/tsconfig` les déclare (`src/markers.d.ts`) pour que `tsc` accepte l'import.

## Packages

Un Client Component peut importer n'importe quel package installé, sans le déclarer :
le bundler l'embarque avec ses dépendances transitives. Le Client tourne sur Bun, pas
dans un navigateur : un package qui utilise `node:path` y fonctionne normalement.

Un package qui importe `server-only` ou `airtty/server` et atteint le bundle Client,
ou qui importe `client-only` et atteint le bundle Server, fait échouer le build. Pour
un package tiers qui ne se déclare pas lui-même, `airtty.json` (facultatif) le range
côté Server :

```json
{ "serverPackages": ["@prisma/client", "bcrypt"] }
```

Chaque erreur de frontière montre la chaîne complète, depuis la page :

```text
Client package db-client imports server-only: it is Server-only
  via app/page.tsx → components/widget.tsx → lib/format.ts → db-client/index.js → server-only
```

Le manifest liste les packages réellement embarqués dans le Client, avec leur version,
d'après le bundler lui-même ; le `bun.lock` de l'application entre dans l'identifiant
de build. Ces contrôles protègent la frontière Client/Server ; ce n'est pas un sandbox :
le code d'un package s'exécute avec les droits de son processus.

Les imports applicatifs utilisent des chemins relatifs avec extensions omises
ou explicites. Les alias tsconfig ne sont pas pris en charge par ce compilateur.
Le runtime interne est une dépendance de confiance.

`.airtty/manifest.json` expose les graphes pour inspection. Les tests contrôlent
l’absence d’un marqueur métier dans le bundle Client, les imports transitifs,
les réexports et le maintien du dernier build utilisable en cas d’erreur.

Le hash de build inclut les sources accessibles (dont tous les layouts, loadings et
écrans d'erreur), tous les fichiers du runtime et les lockfiles.
Les artefacts sont construits dans un répertoire temporaire, puis publiés après
succès des deux compilations. Le build ne fait pas d’installation réseau et ne
modifie pas le build actif en cas de diagnostic de compilation. `bun run check`
valide séparément les types du framework et de l’exemple ; la compilation d’un
starter utilise la transpilation TypeScript, pas une vérification exhaustive des types.
