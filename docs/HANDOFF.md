# Handoff — un framework React Server Components pour le terminal

> Document historique du MVP. Le contrat de navigation qu'il décrit (shell seul
> persistant, refresh par génération) est supersédé par [ROUTER.md](ROUTER.md).

Date : 22 septembre 2026. Statut : spécification d'un nouveau projet, pas une
description de fonctionnalités déjà livrées. Ce document est autonome et destiné
à l'agent qui créera le nouveau dépôt. Les noms `terminal` et `@terminal/*` sont
des placeholders, sans réservation de nom ni engagement d'API définitive.

## Mission

Créer une sorte de « Next.js du terminal » fondée sur **React, OpenTUI et Flight** :
le développeur compose son application dans une seule codebase TypeScript/TSX,
le métier et les Server Components s'exécutent sur un Server local ou distant,
et toute interaction immédiate s'exécute sur le Client terminal.

Livrer d'abord une tranche verticale utilisable : une application Notes avec
composition Server, éditeur Client, vraie Server Function, sauvegarde et refresh
préservant la saisie. Le développeur de cette application ne doit écrire ni RPC,
ni manifests Flight, ni registre de modules, ni glue OpenTUI de démarrage.

Le projet est indépendant de TWP. Réutiliser les enseignements et sondes fournis,
pas son Engine, son Protocol ou son compilateur TS/Wasm. Ses ADR ne s'imposent
pas au nouveau dépôt. Le but est de concentrer le travail spécifique sur la
frontière distribuée et la DX, en utilisant React/OpenTUI pour l'interface.

## Décisions de départ et questions laissées ouvertes

| Sujet | Décision pour démarrer |
| --- | --- |
| Stack | TypeScript, React, OpenTUI, véritable Flight |
| Runtime initial | Bun, combinaison de versions exactement épinglée |
| Processus | Client et Server séparés, également en développement local |
| Composition | Server Components par défaut dans le graphe Server ; frontière `"use client"` |
| Métier appelable | Exports async de modules `"use server"` |
| Distribution MVP | Bundle UI de confiance par application, installé avec son Client |
| Transport MVP | HTTP streaming sur loopback ou URL distante ; même code applicatif |
| Persistance exemple | SQLite côté Server, base temporaire pour les tests |
| Déploiement initial | Deux artefacts compatibles : Client applicatif et Server |

La distribution par bundle est une **hypothèse de MVP proposée**, pas une décision
utilisateur définitive. L'utilisateur souhaite discuter plus tard du Client
générique ouvrant des applications fournies par des Servers. Garder une interface
de résolution de modules qui permettra d'explorer ce modèle ; ne pas construire
maintenant un marketplace, un téléchargeur universel ou une sandbox.

La réactivité locale normale est exigée. La résistance à une boucle infinie dans
un composant React de confiance n'est pas une garantie du MVP. Une panne du Server
ne doit pas arrêter l'édition du contenu déjà chargé.

## Commencer ici

1. Dans un nouveau répertoire, initialiser un dépôt indépendant et y conserver
   ce handoff. Employer un nom provisoire si aucun nom n'a été choisi.
2. Reproduire `probes/rsc/` et `probes/rpc/` dans un environnement isolé. Enregistrer
   versions, commandes et résultats observés. Ces sondes sont des références,
   pas le squelette d'un runtime de production.
3. Lire les contrats de build, actions et état ci-dessous, puis exécuter le jalon 1.
4. Continuer jusqu'au MVP défini ici. Documenter les choix ordinaires sans bloquer
   sur le nom, le packaging final ou une future distribution universelle.

Fin de l'étape de départ : les deux sondes passent, les dépendances sont fixées
et une commande de test reproductible existe dans le nouveau dépôt.

## Preuves disponibles et limites

Versions testées : Bun 1.4.2, `@opentui/core` et `@opentui/react` 0.5.12,
React et `react-server-dom-webpack` 19.3.0. Il s'agit d'un point de référence,
pas d'une affirmation sur les dernières versions disponibles. Vérifier la
compatibilité et les correctifs de sécurité avant de retenir une version.

`probes/rsc/` a démontré : un processus lancé avec `--conditions=react-server`
produit un flux Flight contenant une Client Reference ; le Client le décode,
affiche un éditeur avec `useState`, puis reçoit un deuxième arbre Server sans
perdre l'instance du champ ni sa saisie. Le registre et les manifests sont manuels.

`probes/rpc/` a démontré : la saisie reste locale pendant 400 ms de calcul métier
dans un autre processus, puis après son arrêt. Une réponse appliquée naïvement
écrase une nouvelle frappe ; une garde de révision protège ce cas simple.

**Restent à prouver** : Server Functions dans ce renderer, génération automatique
des frontières, streaming progressif dans le shell, transport réseau, refresh
après action, reprise de session et build distribuable. Les tests sont headless ;
ils ne mesurent pas la latence physique du terminal ni une charge de production.

## Expérience développeur cible

```text
app/
  layout.tsx
  page.tsx
  notes/[id]/page.tsx
components/
  NoteEditor.tsx           # "use client"
actions/
  notes.ts                # "use server"
server/
  repository.ts           # dépendance métier strictement Server
```

Exemple d'API cible, à rendre réellement compilable dans le starter :

```tsx
// app/notes/[id]/page.tsx — Server Component
import { NoteEditor } from '../../../components/NoteEditor';
import { saveNote } from '../../../actions/notes';
import { loadNote } from '../../../server/repository';

export default async function NotePage({ params }) {
  const note = await loadNote(params.id);
  return (
    <box flexDirection="column">
      <text>{note.title}</text>
      <NoteEditor key={note.id} initialNote={note} saveAction={saveNote} />
    </box>
  );
}
```

Le Client Component utilise React et les composants OpenTUI. Son événement de
submit appelle la référence `saveAction` avec un snapshot sérialisable. Le module
d'actions utilise `"use server"` et exporte des fonctions async ; le repository
reste absent du bundle Client. Le starter doit typer les props et arguments.

Une seule commande `airtty dev` construit et lance les deux processus. Cible
suivante : `airtty build`, `airtty start --role server` et
`airtty start --role client --url …`. Ces commandes sont à implémenter ; elles
ne sont pas des commandes OpenTUI existantes.

## Architecture

```text
Sources TSX
  └─ build : graphe Server / graphe Client / manifests / identifiant de build

Server
  ├─ routes et layouts → Server Components → Flight stream
  └─ dispatcher de Server Functions → métier → résultat + invalidation
              ↕ HTTP : rendu, appels et erreurs
Client
  ├─ loader des modules Client et décodeur Flight
  ├─ shell React persistant, navigation et état de connexion
  ├─ composants interactifs et stores locaux
  └─ @opentui/react → OpenTUI → terminal local
```

Séparer ces responsabilités en modules ; un package framework avec entrées
`client`, `server` et `build` suffit d'abord. Ajouter un CLI et l'application
Notes. Éviter une multiplication de packages avant d'avoir le parcours complet.

### Build et frontières de modules

- Employer un parseur/transformeur AST ou une intégration RSC existante adaptée.
  Les transformations de directives ne doivent pas reposer sur des regex.
- Construire deux graphes. `"use client"` marque une frontière d'importations,
  pas seulement un composant à sauter lors d'un rendu.
- Remplacer les imports Client du graphe Server par des Client References ;
  générer leurs manifests et résoudre les exports dans le bundle Client.
- Transformer les exports async des modules `"use server"` en Server References
  et proxies, et les enregistrer dans le dispatcher Server.
- Pour le MVP, supporter les fonctions Server exportées au niveau du module.
  Diagnostiquer explicitement les Server Functions inline et les captures de
  closures non supportées ; leur compilation est une extension ultérieure.
- Rejeter les imports métier Server-only dans un graphe Client, sauf les exports
  d'actions transformés. Les imports transitifs et réexports doivent être couverts.
- Compiler le JSX Server avec une entrée compatible `react-server`, sans importer
  le runtime OpenTUI natif côté Server ; utiliser le JSX adapté à OpenTUI côté Client.
- Aligner React, Flight et reconciler ; dédupliquer React/Core dans le Client.
  Un identifiant de build lie manifests, bundles et références d'actions.

Fin du contrat de build : le starter passe d'un checkout neuf à deux bundles,
sans manifests écrits par l'application, et un import interdit produit un
diagnostic fichier/ligne. L'inspection du graphe confirme l'absence du repository
et de ses dépendances Server-only dans le bundle Client.

### Intégration Flight : premier risque à lever

Le probe utilise `react-server-dom-webpack/client.node`. Dans les sources
inspectées, ce chemin injecte `noServerCall` : décoder un arbre ne suffit donc
pas pour appeler une Server Function.

Choisir et prouver un adapter qui gère aussi `callServer` et l'encodage/décodage
des arguments/résultats, avec le chargement des modules requis. Le client browser
expose des points utiles mais impose des contrats de bundler ; le nom du package
ne constitue pas une preuve de compatibilité Bun/OpenTUI. Isoler cet adapter dans
un module versionné et testé ; limiter les dépendances à des internals dispersés.

Utiliser le vrai codec Flight. Le registre Webpack minimal du probe est un outil
de démonstration à remplacer par le loader/manifeste généré. L'intégration doit
supporter une référence d'action transmise en prop à travers le flux.

### Shell et rafraîchissement

Monter une seule racine React persistante, puis actualiser son sous-arbre via un
state/store. Les sources OpenTUI inspectées recréaient un container à chaque
appel à `root.render` ; vérifier cette propriété avec la version retenue.

Les updates de route reçoivent une génération. Ignorer une ancienne réponse
lorsqu'une navigation plus récente a gagné. Conserver des clés par identité
métier ; une version de sauvegarde ne doit pas devenir la clé d'un éditeur.

Traiter des morceaux Flight progressivement avec une boundary de chargement et
une boundary d'erreur. Prouver le comportement Suspense dans OpenTUI avant de
le promettre. Le premier probe attendait l'arbre : il ne prouve pas ce streaming.

Après action, renvoyer son résultat et demander le refresh des routes concernées.
Un premier design peut les traiter par deux requêtes. Une erreur de refresh ne
doit pas transformer une sauvegarde réussie en échec métier. Un refresh est une
politique explicite du framework ; RSC n'observe pas automatiquement la base.

### Actions, sessions et réseau

Prévoir un rendu de route, un endpoint d'action et une vérification de compatibilité
de build. Les noms exacts des endpoints sont internes. Les requêtes portent une
identité d'appel ; les réponses distinguent résultat métier, erreur attendue et
erreur de transport. Les paramètres métier restent typés et validés côté Server.

Les références d'actions ne sont pas des autorisations. L'application reçoit un
contexte de session pour vérifier les droits ; les secrets restent sur le Server.
Le développement écoute sur loopback. Le mode distant documente authentification
et transport sécurisé avant exposition publique, sans imposer un fournisseur.

Le Client installé doit pouvoir se connecter à un Server compatible sans source
Server sur sa machine. Refuser proprement un build incompatible, sans reset
silencieux des saisies déjà présentes. Après perte du transport, conserver le
shell et l'édition locale ; afficher la déconnexion et proposer une reconnexion.

Une mutation dont la réponse s'est perdue a un résultat **inconnu**. Le MVP ne
la rejoue pas automatiquement. Pour Notes, associer un identifiant d'opération
à la mutation et stocker son résultat avec l'écriture dans une même transaction
SQLite ; une consultation du résultat permet de résoudre l'incertitude après
reconnexion. Exposer un point d'intégration, pas une promesse générique exactly-once.

### État local et formulaires

OpenTUI possède les comportements natifs des contrôles, React la composition et
les états applicatifs locaux. Ajouter une petite abstraction de Draft explicite,
testée indépendamment du renderer, puis l'intégrer dans un hook/composant.

Elle suit identité du contenu, valeur courante, Baseline, révision locale, version
métier et opération en cours. Autoriser une sauvegarde en vol par document tout en
laissant la saisie active. Sur confirmation, actualiser la Baseline correspondant
au snapshot soumis ; conserver toute édition plus récente. Appliquer une valeur
normalisée au Draft uniquement si sa révision et son identité correspondent encore.

Un refresh RSC ne recopie pas aveuglément les props dans le Draft. Pour Notes,
conserver les Drafts visités dans un store borné de session, au-dessus des routes,
jusqu'à sauvegarde/abandon explicite. L'application contrôle la politique de conflit
si les données externes ont changé. La persistance après arrêt du Client est hors
MVP ; le README doit le dire.

## Jalons, dans cet ordre

### 1. Action réelle à travers Flight

Étendre la preuve RSC : une Server Reference traverse Flight vers un Client
Component ; une interaction OpenTUI l'appelle dans un autre processus via HTTP,
obtient un résultat et rafraîchit le contenu Server sans remonter le champ.
Les manifests peuvent être manuels dans cette seule épreuve d'intégration.

**Terminé quand** un test vérifie PIDs distincts, appel et arguments réellement
reçus, résultat visible et saisie préservée pendant l'attente. Une fonction locale
ou un callback RPC indépendant remplaçant la référence Flight ne valide pas ce jalon.

### 2. Compilation et démarrage automatiques

Produire graphes, références, manifests, bundles et CLI dev depuis des modules
`"use client"` / `"use server"`. Exposer les erreurs de build sans corrompre
l'interface déjà utilisable. Rebuild/restart est acceptable au MVP ; annoncer les
limites de conservation d'état. Fast Refresh complet est une extension.

**Terminé quand** un nouveau starter atteint le jalon 1 sans enregistrement manuel,
et les cas positifs/négatifs de frontières d'import sont testés.

### 3. Application Notes et routes

Livrer liste de notes, détail éditable, sauvegarde, validation métier et retour à
la liste. Implémenter `page.tsx`, un layout persistant et `[id]` pour ces routes,
avec une petite API de navigation Client. Faire une interface lisible avec les
composants OpenTUI : hiérarchie, espacements, focus et aide clavier cohérents.

**Terminé quand** sauvegarder `abc` puis taper `d` durant la requête conserve
`abcd` comme Draft avec `abc` confirmé, et quitter/revenir au détail retrouve le
Draft selon le contrat de session. Une clé changée réinitialise intentionnellement
le bon contenu sans appliquer une réponse ancienne à une autre note.

### 4. Transport distant et erreurs

Exécuter la même application avec un Server lancé séparément, puis sur deux
machines si l'environnement le permet. Ajouter retard, réponse obsolète et coupure
après commit ; tester la récupération du résultat Notes et le refresh ultérieur.

**Terminé quand** aucun événement d'édition/focus/scroll ne déclenche par défaut
un appel métier, l'édition reste possible hors connexion et une incompatibilité
de build est diagnostiquée. Une exécution sur loopback ne doit pas être présentée
comme une preuve WAN ; consigner séparément les tests réalisés et non réalisés.

### 5. Livraison du MVP

Fournir build de production Client/Server, starter, README d'installation et de
déploiement, guide des frontières, API publique minimale et tests CI.

**Terminé quand** une personne suit le README depuis un répertoire neuf, lance
l'app locale puis connecte son Client au Server séparé sans modifier ses composants.
Le parcours réel est vérifié en PTY en plus des tests headless.

## Validation ciblée

| Test | Ce qu'il doit détecter |
| --- | --- |
| Flux Flight + Client Reference | Mauvais module, version ou branche React |
| Server Function réelle | Faux succès où le métier reste local |
| Refresh avec saisie en cours | Remount ou props qui écrasent le Draft |
| Deux navigations, réponses inversées | Ancienne route qui reprend l'écran |
| Coupure après commit | Faux échec ou double mutation à la reconnexion |
| Import Server-only transitif | Métier ou dépendance Server dans le Client |
| Erreur de build/dev et arrêt | Terminal non restauré, processus orphelin |
| Délai Server de 300–1000 ms | Interaction locale accidentellement liée au RTT |

Mesurer frappe-à-affichage dans un terminal pour évaluer la sensation, et compter
les messages pour prouver la localité. Les temps headless des sondes ne sont pas
un budget de performance. Tester le comportement observé, pas la forme interne
des transforms. Les données des tests appartiennent à des bases temporaires.

## Extensions après le MVP

Layouts imbriqués, loading/error par route, invalidation plus fine, abonnements
Server, Fast Refresh, Server Functions inline, cache, préchargement, paquet
exécutable autonome et intégration DevTools. Les décider à partir d'applications
réelles. Les fonctions de Next.js dépendant du navigateur ou du DOM ne sont pas
automatiquement pertinentes dans le terminal.

Le Client générique et le téléchargement de bundles exigent une décision explicite
sur la confiance. Un loader ou un worker JavaScript n'est pas à lui seul une
sandbox. Conserver cette question ouverte sans la faire bloquer le MVP.

## Références à consulter selon le chantier

- Frontières et garanties RSC : [Server Components](https://react.dev/reference/rsc/server-components),
  [use client](https://react.dev/reference/rsc/use-client),
  [Server Functions](https://react.dev/reference/rsc/server-functions).
- Adapter Flight et références : [react-server README](https://github.com/react/react/tree/main/packages/react-server),
  [implémentation Webpack](https://github.com/react/react/tree/main/packages/react-server-dom-webpack).
- Montage et API terminal : [bindings OpenTUI React](https://opentui.com/docs/bindings/react/),
  [sources reconciler](https://github.com/anomalyco/opentui/tree/main/packages/react/src/reconciler).
- Identité et conservation : [state React](https://react.dev/learn/preserving-and-resetting-state).
- Distribution future : [runtime modules OpenTUI](https://opentui.com/docs/extend/runtime-plugins/).

Les API internes d'intégration RSC ne suivent pas la même stabilité que les API
applicatives React. Conserver la version exacte et une suite d'intégration lors
de toute mise à jour. Les limites et preuves de ce handoff sont datées ; vérifier
les sources actuelles avant de dépendre d'un comportement interne.
