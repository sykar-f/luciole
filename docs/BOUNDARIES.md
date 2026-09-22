# Frontières de compilation

Le compilateur utilise l’AST TypeScript et le checker pour résoudre les exports.
Les directives sont reconnues uniquement dans le prologue du module. Il n’existe
aucune transformation de directive par regex.

Un module Server est le défaut dans le graphe des routes. Il peut importer le métier
et les actions, et composer des références de Client Components. Son JSX utilise
`react/jsx-runtime` sous `--conditions=react-server` : aucun import natif OpenTUI.

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

Le graphe Client refuse :

- les modules sous `server/` et tout import transitif de `server-only` ;
- les modules `node:*`, `bun:*` et `@terminal/framework/server` ;
- les imports de packages non analysés, hors React, OpenTUI et l’entrée Client
  du framework ; ajouter une intégration auditée pour un autre package Client ;
- `require()` et `import()` dynamiques dans les sources applicatives.

Les imports applicatifs utilisent des chemins relatifs avec extensions omises
ou explicites. Les alias tsconfig ne sont pas pris en charge par ce compilateur.
Le runtime interne est une dépendance de confiance. Une revue des intégrations
reste nécessaire avant d’élargir l’ensemble des packages Client autorisés.

`.terminal/manifest.json` expose les graphes pour inspection. Les tests contrôlent
l’absence d’un marqueur métier dans le bundle Client, les imports transitifs,
les réexports et le maintien du dernier build utilisable en cas d’erreur.

Le hash de build inclut les sources accessibles, les fichiers runtime et le lockfile.
Les artefacts sont construits dans un répertoire temporaire, puis publiés après
succès des deux compilations. Le build ne fait pas d’installation réseau et ne
modifie pas le build actif en cas de diagnostic de compilation. `bun run check`
valide séparément les types du framework et de l’exemple ; la compilation d’un
starter utilise la transpilation TypeScript, pas une vérification exhaustive des types.
