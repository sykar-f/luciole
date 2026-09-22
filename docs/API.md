# API applicative minimale

Entrée `@terminal/framework/client` (Client Components uniquement) :

| API | Contrat |
| --- | --- |
| `useNavigation()` | `{ navigate(path), refresh() }`. Navigation Server ; la réponse de génération la plus récente gagne. |
| `useDraft(note)` | `{ draft, edit, save, recover, discard }`. Store au-dessus des routes, indexé par identité métier. |
| `Note` | `{ id, title, value, version }` ; types importables côté Server avec `import type`. |
| `Snapshot` | `{ id, value, version, revision, operationId }` ; snapshot soumis immuable par convention. |
| `SaveResult` | `{ ok: true, note, operationId }` ou `{ ok: false, error, operationId }`. |

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
- `getCallId()` : identifiant de requête de transport, distinct de l’opération métier.

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
