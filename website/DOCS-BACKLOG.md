# Ce que la landing a rendu à la documentation

La landing v2 ne garde que ce qui donne envie d'essayer. Le contenu ci-dessous en est
sorti ; il revient dans la future référence anglaise (`/docs/`). Chaque composant se
retrouve dans sa dernière version au commit **`e157896`** (base de la refonte) :

```sh
git show e157896:website/src/components/Toolbox.astro
```

Tant que ces pages n'existent pas, le site lie directement les documents du dépôt
(`docs/*.md`, en français) là où un lecteur en a besoin : `/status`, `/docs`, la bande
« Local or remote » de la landing (distribution et confinement).

| Contenu                                                                                                                                                         | Composant (à `e157896`)                                            | Source de vérité                                   | Destination prévue                            |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------- | --------------------------------------------- |
| Page man des capacités : routes en fichiers, `"use cache"`, `useLive`, champs restaurés, `<Terminal>`/`<Embed>`, auth par défaut, frontières vérifiées au build | `Toolbox.astro`                                                    | `API.md`, `ROUTER.md`, `CACHE.md`, `BOUNDARIES.md` | Référence : une page par capacité             |
| Sémantique des pannes : `not-sent`, `rejected`, `unknown`, et qui décide de rejouer                                                                             | `Wire.astro` (bloc `.outcomes`)                                    | README « Tester une connexion », `API.md`          | Référence : Server Functions, erreurs         |
| Modes de panne injectables (perdre la requête, perdre la réponse, couper le flux) et timeline des requêtes du transport                                         | `Wire.astro` (radios `faults`, `.timeline`)                        | README, `WEB.md` « Page embarquée »                | Guide : éprouver son app sous mauvais réseau  |
| Variables d'environnement de latence et de pannes : `AIRTTY_LATENCY_MS`, `AIRTTY_JITTER_MS`, `AIRTTY_CHUNK_DELAY_MS`, `AIRTTY_FAULT`                            | `Wire.astro` (`.repro`), `Toolbox.astro`                           | README                                             | Référence : variables d'environnement         |
| Explorateur des sept fichiers de Notes, régions Client/Server allumées sur la capture                                                                           | `HowItWorks.astro` (`.explorer`, `.drawn`)                         | `examples/notes`, `ARCHITECTURE.md`                | Guide : anatomie d'une app                    |
| Réponse React Flight brute, octet par octet, annotée                                                                                                            | `HowItWorks.astro` (onglet `GET /render`), `src/frames/flight.txt` | `ARCHITECTURE.md`, `scripts/capture.py` (`flight`) | Guide : ce qui passe sur le fil               |
| Ce que produit `airtty build` (`.airtty/client`, `.airtty/server`, même build ID des deux côtés)                                                                | `HowItWorks.astro` (`.split`)                                      | README « Production », `ARCHITECTURE.md`           | Référence : build                             |
| Trust détaillé : modes `inline` / `process` / `sandbox`, capacités déclarées, Seatbelt, Landlock, espaces de noms, clé d'éditeur épinglée                       | `Trust.astro`                                                      | `EMBEDDING.md`                                     | Référence : sécurité et confinement           |
| Distribution détaillée : `airtty github:…`, `--url ssh://…`, registre, Server détaché et grâce                                                                  | `Ship.astro`                                                       | `DISTRIBUTION.md`                                  | Référence : distribution                      |
| Animation de reconnexion (`--on` : Disconnected, tunnel relancé après 1 s, 2 s, 4 s…, Connected)                                                                | `Ship.astro` (`.replay`)                                           | `DISTRIBUTION.md` « `--on user@host` »             | Référence : distribution, avec ses conditions |
| Signature et notarisation macOS, runtime Bun embarqué, binaires glibc et musl                                                                                   | `Ship.astro`, `Limits.astro`                                       | README « Signature et notarisation »               | Référence : distribution                      |
| Liste des limites (déplacée et corrigée dans `/status`)                                                                                                         | `Limits.astro`                                                     | README « Contrat et limites », `VALIDATION.md`     | `/status` (fait)                              |
| Galerie live à onglets (Forge, Chat, mdreader, DevTools)                                                                                                        | `Apps.astro`                                                       | `scripts/demo.ts`                                  | `/examples` (fait, une démo au clic)          |

Hors site, à trancher ailleurs : le dépôt ne déclare pas de licence, et le début du
README (français, architecture d'abord) ne suit pas encore le parcours du site.
