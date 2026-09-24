# Client générique : télécharger, vérifier, rendre une application

Exécuté avec succès le 24 septembre 2026, macOS 26.6.2 (arm64), Bun 1.4.2, depuis la
racine du dépôt :

```sh
bun probes/generic-client/probe.tsx     # écrit results.json à côté
```

Aucune dépendance propre : le probe utilise les paquets du dépôt et importe `src/` sans
le modifier. Il construit `examples/mdreader` (`src/build.ts`), en tire un bundle Client
« runtime external », le signe, le sert par `GET /manifest` et `GET /bundle` devant le
vrai Server de l'application, puis un Client générique le télécharge, le vérifie,
l'évalue et le rend dans OpenTUI (`testRender`).

## Fichiers

| Fichier            | Rôle                                                                                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `abi.ts`           | ABI de runtime : 12 spécifiers autorisés, version manuelle + versions exactes des paquets, clé `1-<sha256>`.                                                |
| `runtime-entry.ts` | Surface du runtime (airtty client/route-tree, TanStack) ; `runtime.ts` la bundle (redirection `isServer` de TanStack) et fournit la table `require`.        |
| `bundle.ts`        | Bundle d'application : Client Components + route tree + stubs d'actions, format `bun-cjs`, ABI en external, audit des built-ins Node via le metafile.       |
| `loader.ts`        | Manifeste Zod, signature Ed25519, épinglage TOFU par origine (`known-origins.json`), ABI, cache par sha256, évaluation avec un `require` limité.            |
| `publish.ts`       | Clés de l'éditeur, manifeste signé, serveur `/manifest` + `/bundle` qui relaie le reste (render, action, flux live) vers le Server de l'application.        |
| `host.tsx`         | Plusieurs Applications par processus : résolveur aiguilleur par préfixe, `airtty/client` par origine, keymap scopé, error boundary par embed (voir inline). |

## Assertions (toutes vertes)

| Assertion                                                                 | Observé                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------ |
| Le bundle exporte le buildId signé dans le manifeste                      | oui                                              |
| mdreader téléchargé rend son document d'accueil                           | frame contenant « Handbook »                     |
| Une Server Function importée (`useLive(watchLibrary)`) atteint son Server | requête `action`, cause `live`, vers son origine |
| Démarrage à chaud : bundle lu depuis le cache, aucun `GET /bundle`        | `cacheHit: true`                                 |
| Bundle altéré (un octet ajouté)                                           | refusé : hash ≠ hash signé                       |
| Manifeste modifié après signature                                         | refusé : signature invalide                      |
| Clé d'éditeur changée pour une origine épinglée                           | refusé : « publisher key changed »               |
| Bundle compilé pour une autre ABI                                         | refusé avant téléchargement                      |
| `require` hors ABI et hors built-ins déclarés (`node:child_process`)      | refusé à l'évaluation                            |

## Mesures (`results.json`)

| Mesure                                    | Valeur                                      |
| ----------------------------------------- | ------------------------------------------- |
| Bundle mdreader minifié / gzip / non min. | 20 099 o / 7 472 o / 36 066 o               |
| Modules Client référencés / sources       | 8 / 15                                      |
| Runtime (airtty + TanStack, sans React)   | 292 255 o, 67 884 o gzip                    |
| `airtty build` puis bundle générique      | ≈ 2,7 s puis ≈ 65 ms                        |
| Froid : manifeste, vérif., download, hash | ≈ 2 ms, 0,3 ms, 0,3 ms, 0,6 ms (loopback)   |
| Évaluation du bundle                      | ≈ 2–3 ms                                    |
| Froid jusqu'à la première frame complète  | ≈ 180–220 ms (dont rendu Server et listing) |
| Chaud : manifeste + vérif. + cache        | < 1,3 ms                                    |

## Ce que cela exige du build

1. **Un second bundle Client** par application, sans runtime : `react`, `@opentui/*`,
   `@tanstack/react-router`, `zod`, `airtty/client`, `airtty/route-tree` restent des
   `require` résolus par l'hôte. Le bundle actuel (`.airtty/client/index.js`) embarque
   au contraire le runtime airtty, TanStack et le keymap : deux applications y auraient
   deux routeurs et deux contextes de keymap.
2. **Un format évaluable par l'hôte** : `bun-cjs` expose
   `(function (exports, require, module, …) {…})`. L'hôte passe son `require` : la table
   _est_ l'ABI, un spécifier inconnu échoue au chargement. Pas de `node_modules` côté
   Client, pas de résolution disque, une instance de module par évaluation. Limite : un
   module applicatif avec `await` au niveau supérieur n'est pas exprimable en CJS.
3. **Le runtime lui-même bundlé** avec la redirection `@tanstack/router-core/isServer`
   de `src/build.ts` : le Client générique est un artefact de build, pas `src/` importé.
4. **Les stubs `"use server"`** générés contre `airtty/client` (l'ABI), avec l'id
   `<buildId>/<chemin>#<export>` ; l'hôte fournit un `airtty/client` par origine.
5. **Un audit des built-ins Node** : Bun les externalise avant tout plugin, ils sont lus
   dans le metafile. `files` demande `crypto`, `fs/promises`, `path`, `url` (le dépôt de
   fichiers par glisser-déposer lit le disque côté Client) : c'est une capacité à
   déclarer dans le manifeste.
6. **Le manifeste lie** buildId, sha256, taille, clé ABI, built-ins et clé publique ; le
   Server l'expose avec le bundle. La signature couvre un encodage canonique (tableau
   ordonné), jamais le JSON reçu.

## Limites

- Le serveur `/manifest` + `/bundle` est un relais devant le Server : dans `src/`, ce
  seraient deux routes de `serve()` (voir docs/EMBEDDING.md).
- TOFU seulement : pas de rotation de clé (déclaration signée par l'ancienne clé), pas de
  révocation, pas de journal de transparence.
- L'origine est `new URL(url).origin` : un tunnel `ssh://` dont le port local change
  changerait l'origine ; il faut épingler l'adresse donnée par l'utilisateur, comme le
  fait déjà `src/session.ts`.
- `require` des built-ins déclarés n'est pas une sandbox : en mode `inline` ou `process`,
  le code chargé a tous les droits du processus. La liste sert d'affichage et de
  contrôle de cohérence ; seul le mode `sandbox` l'applique (voir probes/sandbox).
- React/OpenTUI ne sont pas comptés dans la taille du runtime (ils sont dans le binaire
  du Client générique, comme aujourd'hui dans chaque Client compilé).
