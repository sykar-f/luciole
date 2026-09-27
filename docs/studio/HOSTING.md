# Étude : studio hébergé, l'onglet « Try it (beta) »

> **Statut : étude, rien n'est implémenté.** Branche `studio/hosting-study`, 2026-09-27.
> Le studio lui-même (chat + harness qui génère une app airtty + aperçu live) est spécifié
> ailleurs (`docs/studio/SPEC.md`, cluster C5a). Ce document ne traite que de sa version
> **hébergée** : un visiteur du site génère sa première app TUI en ligne.
> Les faits externes (prix, API, produits) renvoient à la [section Sources](#sources), toutes
> consultées le **2026-09-27**. Les calculs de coût sont les nôtres, à partir de ces tarifs.

## Résumé

- **L'app générée ne tourne pas chez nous.** Elle est construite en `--web-local` dans un
  bac à sable, puis s'exécute dans le navigateur du visiteur (Client et Server dans la page
  et un SharedWorker, [WEB.md](../WEB.md)). Elle est servie depuis une origine jetable, à part
  du site. Cela contourne la lacune « pas de PTY dans le navigateur » : l'aperçu n'est plus un
  `<Terminal>` dans le studio, c'est un second `iframe` à côté du studio.
- **Ce qui tourne chez nous, dans une microVM par session** : pi (en RPC), le build airtty et
  le Server du studio. Construire exécute déjà du code généré (`app/args.ts` est évalué par le
  build, `packages/airtty/src/build.ts:155`), et pi n'a aucun système de permissions. Il faut
  donc une vraie isolation, quel que soit le réglage des outils.
- **La clé LLM n'entre jamais dans le bac à sable.** pi appelle OpenRouter avec une clé
  factice. Un proxy de sortie tenu par nous (ou le handler `outbound` de Cloudflare Sandbox)
  remplace l'en-tête par la vraie clé : la nôtre, plafonnée par utilisateur et par jour via
  l'API de gestion de clés d'OpenRouter, ou celle du visiteur (BYOK), gardée en mémoire hors
  du bac à sable.
- **Plateforme recommandée pour le prototype : Cloudflare Sandbox SDK.** Elle offre une VM par
  instance, une allowlist d'egress par domaine, l'injection de secrets hors du bac à sable, la
  facturation du CPU actif et Turnstile chez le même fournisseur. E2B est le plan B, avec un
  plan gratuit pour prototyper.
- **Modèle : « DeepSeek 4.1 flash » existe** (DeepSeek-V4.1-Flash, sorti le 2026-09-10, id API
  `deepseek-flash`, id OpenRouter `deepseek/deepseek-v4.1-flash`). Avec GPT-6 Luna, c'est le
  candidat le moins cher. Coût estimé : **~0,08 à 0,10 $ par session**, calcul compris. Le
  banc d'essai (§ 6) doit confirmer la qualité avant tout choix.

## 1. Architecture

### Ce qui tourne où

```text
 navigateur du visiteur (https://airtty.dev/try)
┌──────────────────────────────────────────────────────────────────────────────────┐
│ page hôte (site, origine de confiance) : login GitHub, Turnstile, saisie BYOK,   │
│ file d'attente, compteur de quota, bouton « télécharger le projet »              │
│  ┌───────────────────────────────┐                 ┌──────────────────────────┐  │
│  │ iframe studio (Client web)    │   postMessage   │ iframe aperçu web-local  │  │
│  │ <sid>.studio.<domaine>        │ ◀─────────────▶ │ <sid>.<domaine-contenu>  │  │
│  │ runtime web airtty            │  « build prêt » │ Client + Server de l'app │  │
│  │ + xterm.js                    │                 │ générée : SharedWorker,  │  │
│  └───────────────┬───────────────┘                 │ SQLite WASM, OPFS        │  │
│                  │ HTTPS (Flight, live)            └────────────▲─────────────┘  │
└──────────────────┼──────────────────────────────────────────────┼────────────────┘
                   │                                              │ fichiers statiques
                   ▼                                              │ (R2, TTL 24 h)
┌──────────────────────────────────────────┐          ┌───────────┴───────────────┐
│ Worker « contrôle » + Durable Object par │ copie des│ Worker « contenu » :      │
│ session : auth, quotas, file, clé BYOK   │ artefacts│ sert .airtty/web/ d'une   │
│ en mémoire, routage vers la VM           │ ───────▶ │ session, CSP stricte      │
└──────────────────┬───────────────────────┘          └───────────────────────────┘
                   │ requêtes vers la VM de la session
                   ▼
┌──────────────────────────────────────────────────────────────────────────────────┐
│ microVM de la session (bac à sable, jetable, sans secret)                        │
│  Server du studio (airtty, --web, AIRTTY_WEB_ORIGIN = origine studio)            │
│   └─ pi --mode rpc (utilisateur non privilégié, --no-session)                    │
│        └─ outils : read/write/edit/ls/grep/find + « build » (extension)          │
│  projet : starter airtty, node_modules pré-installés dans l'image                │
│  egress : tout refusé sauf openrouter.ai ─▶ handler outbound / proxy             │
│           qui remplace l'en-tête Authorization (clé factice → vraie clé)         │
└──────────────────────────────────────────────────────────────────────────────────┘
```

| Élément                       | Où                                        | Pourquoi là                                                                                                                                        |
| ----------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Harness pi                    | microVM de la session                     | il exécute du code choisi par un LLM piloté par un anonyme ; pi « does not include a built-in permission system » (README pi)                      |
| Build (`airtty build`, `tsc`) | même microVM, via l'outil `build`         | le build évalue `app/args.ts` (`build.ts:155`) : construire, c'est exécuter                                                                        |
| Server du studio              | même microVM                              | il pilote pi et le build en local ; une VM par session évite un Server multi-tenant (même choix que `"server": "per-launch"` de coder)             |
| Client du studio              | navigateur, Client web (`--web`)          | forme existante : même origine pour shell et API, bearer en mémoire ([WEB.md § 3](../WEB.md#client-web--vrai-server))                              |
| **App générée**               | **navigateur du visiteur**, `--web-local` | coût de calcul nul chez nous ; la frontière est le bac à sable du navigateur ; ~185 Ko gzip par app en plus du runtime partagé (mesure ci-dessous) |
| Clés LLM, quotas, file        | Worker + Durable Object (hors VM)         | tout ce qui doit survivre à une VM compromise reste dehors                                                                                         |

### La lacune « pas de PTY dans le navigateur »

En local, le studio affiche l'app générée dans un `<Terminal>` (PTY + émulateur,
[EMBEDDING.md § 4](../EMBEDDING.md#4-modes-process-et-sandbox--widget-vt)). Le runtime web
n'a ni PTY ni `<Terminal>` : il affiche « indisponible ici » ([WEB.md § 2, W9](../WEB.md)).
Trois manières de montrer l'aperçu en ligne :

| Option                                                               | Où tourne l'app générée           | Coût chez nous                | Apps couvertes                                                   | Verdict                                                                                         |
| -------------------------------------------------------------------- | --------------------------------- | ----------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **A. `--web-local` dans un second `iframe`**                         | navigateur du visiteur            | nul (fichiers statiques)      | profil Server web : `bun:sqlite`, `crypto`, `fetch` même origine | **retenue pour la v1**                                                                          |
| B. `--web` : Server de l'app dans la VM, Client web dans un `iframe` | VM (Server) + navigateur (Client) | un Server de plus par session | toutes, y compris `fs` et `child_process` (dans la VM)           | repli (phase 3)                                                                                 |
| C. PTY dans la VM, terminal WebSocket vers xterm.js                  | VM                                | un process + flux terminal    | toutes                                                           | écartée : l'app tourne chez nous, et le flux coûte (Vercel facture le trafic des ports exposés) |

L'option A exige que le studio ait une **couture « aperçu »** : en local un `<Terminal>`,
hébergé un événement « build prêt » (`{buildId, url}`) que la page hôte relaie à l'`iframe`
d'aperçu, qu'elle recharge. C'est une exigence à reporter dans `docs/studio/SPEC.md` (C5a).
Le protocole `postMessage` de [WEB.md § Page embarquée](../WEB.md#page-embarquée) (étapes
`stage`, `input`) ne vaut qu'entre même origine ; ici, la page hôte et l'aperçu ont des
origines différentes par construction : la page hôte ne fait que changer l'URL de l'`iframe`.

**Constat mesuré (2026-09-27, M1 Pro, starter `airtty init`) :**

| Mesure                                               | Valeur                                                                                                                              |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `bun install` du starter (cache chaud)               | 2,1 s ; `node_modules` 397 Mo                                                                                                       |
| `airtty build` (1er / 2e)                            | 2,4 s / 1,0 s                                                                                                                       |
| `tsc --noEmit` (`bun run check`)                     | 2,3 s                                                                                                                               |
| `airtty build --web` (runtime web en cache)          | 7,0 s                                                                                                                               |
| `airtty build --web-local` (1er / 2e)                | 2,4 s / 1,1 s                                                                                                                       |
| `.airtty/web/` total                                 | 20 Mo, dont `runtime.js` 652 Ko gzip, `opentui.wasm` 452 Ko, `sqlite3.wasm` 402 Ko, `tree-sitter/` 3,6 Mo, cartes de sources 9,6 Mo |
| Propre à l'app                                       | `app/` 28 Ko + `server-worker.js` 157 Ko gzip                                                                                       |
| Import de `node:child_process` dans un module Server | **le build `--web-local` réussit** : l'appel échouerait seulement à l'usage                                                         |

Conséquences : le runtime, `sqlite3.wasm` et `tree-sitter/` ne dépendent pas de l'app. On les
sert une fois, en cache, depuis l'origine de contenu : seuls ~185 Ko changent par build. Le
calcul d'un build est de l'ordre de la seconde, donc le coût de VM est dominé par la mémoire
réservée et l'attente du LLM, pas par le CPU. Enfin, puisque le build ne refuse pas `fs` ni
`child_process` en `--web-local`, il faut à l'outil `build` une vérification propre (liste
des built-ins importés par le graphe Server, ou un chargement headless de l'aperçu, comme
`scripts/web/`) pour renvoyer l'erreur à l'agent au lieu d'un écran cassé chez le visiteur.

### Le studio dans le navigateur

Le studio est une app airtty. Hébergé, il est servi en **Client web** par son Server dans la
VM : le Worker de contrôle relaie `https://<sid>.studio.<domaine>/*` vers la VM de la session.
Chaque VM démarre avec `AIRTTY_WEB_ORIGIN=https://<sid>.studio.<domaine>`. Une origine par
session respecte la règle « une seule origine déclarée » du Server (WEB.md § 3) sans la
modifier. Il faut un DNS wildcard, ce que les preview URLs de Cloudflare Sandbox exigent aussi.

Le relais HTTP du Worker vers un port du conteneur n'est pas vérifié ici. `exposePort()` est
déprécié depuis juin 2026 au profit des Tunnels (cloudflared dans le conteneur), et je n'ai
pas trouvé comment les Tunnels coexistent avec `enableInternet = false`. C'est la sonde P3 du
§ 7.

Alternative écartée pour la v1 : un chat HTML classique à la place du studio TUI. Il serait
plus simple, mais la vitrine d'un framework TUI est justement le studio en TUI, et la forme
Client web existe déjà. C'est un point à trancher (§ 7).

### Parcours d'une session

1. Le visiteur ouvre `/try`, se connecte avec GitHub, passe Turnstile.
2. Le Worker de contrôle vérifie son quota, le place en file ou lui attribue une VM, et lui
   crée (ou réutilise) sa clé OpenRouter plafonnée.
3. La VM démarre depuis une image qui contient déjà le starter, `node_modules`, pi et le
   runtime web (`airtty web-runtime`, ~30 s et du réseau selon WEB.md : fait au build de
   l'image, jamais en session). Démarrage annoncé : 1 à 3 s selon la taille de l'image.
4. Le visiteur décrit son app. pi écrit le code et appelle l'outil `build`. En cas d'échec,
   l'erreur revient à pi. En cas de succès, les artefacts propres à l'app sont copiés vers R2
   et l'aperçu est rechargé.
5. Fin : 30 min au plus, ou 10 min d'inactivité. La VM est détruite, et le visiteur peut
   télécharger son projet (zip des sources) pour continuer en local avec `airtty dev`.
   L'aperçu expire 24 h plus tard.

## 2. Isolation

### Modèle de menace

Donner pi à un anonyme, c'est lui donner un shell : même sans l'outil `bash`, le build
exécute `app/args.ts`, et un Bun macro exécuterait du code au bundling. On suppose donc que
**le visiteur contrôle entièrement la VM**. Les menaces :

| Menace                                         | Parade                                                                                                                                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Évasion vers l'hôte ou d'autres sessions       | isolation par VM (Firecracker ou équivalent) chez le fournisseur ; une VM par session, jamais réutilisée                                |
| Vol de secrets                                 | aucun secret dans la VM : clé LLM injectée à la sortie, jeton de session limité à la VM                                                 |
| Minage, calcul abusif                          | type d'instance fixe (½ à 1 vCPU), durée max 30 min, quota de sessions par compte, facturation au CPU actif donc coût borné             |
| Egress abusif (spam, scan, DDoS, exfiltration) | tout refusé sauf `openrouter.ai` (80/443) ; pas de registre npm en v1 : `node_modules` est dans l'image                                 |
| Épuisement du budget LLM                       | clé par utilisateur plafonnée par OpenRouter (402 `openrouter_key_limit`), solde prépayé sans recharge automatique comme plafond global |
| Contenu hébergé abusif (phishing, illégal)     | aperçu sur un domaine séparé, URL signée, non indexé, TTL 24 h, visible par son auteur seulement en v1 (pas de partage)                 |
| Code généré attaquant le visiteur ou le site   | aperçu sur un **domaine registrable distinct** (à la `githubusercontent.com`), un sous-domaine par session, CSP `connect-src 'self'`    |

**Outils de pi.** Recommandé : `--tools read,write,edit,ls,grep,find`, plus un outil `build`
enregistré par une extension (`pi.registerTool`, rapport pi) qui lance une commande fixe :
`airtty build --web-local`, `tsc --noEmit` et la vérification des built-ins. On perd `bash`
(installer un paquet, lancer un script arbitraire), mais on gagne un comportement prévisible
et des erreurs structurées. Cela réduit la surface sans remplacer la VM. À vérifier
(sonde P1) : qu'un outil d'extension reste actif sous `--tools`.

**Aperçu dans le navigateur.** L'app générée s'exécute avec les droits d'une page de son
origine : elle ne doit donc partager aucune origine avec le site, le studio ou un autre
visiteur. OPFS et le SharedWorker sont partitionnés par origine, et un sous-domaine par
session sépare les données de deux sessions. Le profil web d'un Server d'app n'appelle que
`fetch` vers la même origine (WEB.md § W9). Une CSP `connect-src 'self'` en fait une règle du
navigateur, pas une convention : l'app ne peut pas faire de requêtes ailleurs depuis le
navigateur du visiteur. L'attribut `sandbox` d'`iframe` sans `allow-same-origin` donnerait
une origine opaque, incompatible avec le SharedWorker et OPFS : c'est pourquoi on isole par
domaine plutôt que par cet attribut (à confirmer, sonde P2).

### Options comparées

Session type du calcul : 30 min, ~1 vCPU, ~2 GiB, CPU à 100 %. C'est un majorant : en
pratique, le CPU attend surtout le LLM (§ 5).

| Option                                      | Isolation                          | Démarrage annoncé                   | Egress                                                                                                                                                     | Limites                                                                           | Prix                                                                                                       | ≈ 30 min (majorant)           | Accès navigateur                                           |
| ------------------------------------------- | ---------------------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| **Cloudflare Sandbox SDK** (sur Containers) | une VM par instance                | 1–3 s selon l'image                 | `enableInternet=false` + `allowedHosts` (globs) ; handlers `outbound` avec TLS intercepté et **injection de secrets côté Worker** ; ports ≠ 80/443 refusés | lite à standard-4 (4 vCPU, 12 GiB, 20 GB) ; pas de durée max, `sleepAfter` 10 min | 0,00002 $/vCPU-s **actif** ; 0,0000025 $/GiB-s et 0,00000007 $/GB-s provisionnés ; 5 $/mois (Workers Paid) | ≤ 0,065 $ (standard-2, 6 GiB) | terminal WebSocket natif ; `exposePort` déprécié → Tunnels |
| E2B                                         | Firecracker                        | non publié officiellement           | `allowInternetAccess:false`, `allowOut`/`denyOut` (IP, CIDR, domaines sur 80/443), modifiable à chaud                                                      | 1 h (Hobby) / 24 h (Pro) ; 20 / 100 sandboxes concurrents                         | 0,000014 $/vCPU-s ; 0,0000045 $/GiB-s ; Hobby 0 $ (100 $ de crédit) ; Pro 150 $/mois                       | ~0,041 $                      | `getHost(port)`, URL publique restreignable                |
| Vercel Sandbox                              | Firecracker                        | « milliseconds »                    | le plus complet : deny-all (DNS compris), domaines par SNI, CIDR, injection de credentials, proxy                                                          | Hobby 45 min / 10 concurrents ; Pro 24 h                                          | 0,128 $/h CPU actif ; 0,0212 $/GB-h ; **0,15 $/GB de transfert, trafic des ports exposés compris**         | ≤ 0,085 $ + trafic            | 15 ports exposés                                           |
| Modal Sandboxes                             | gVisor                             | non publié                          | `block_network`, allowlist CIDR, allowlist de domaines sur 443 (bêta)                                                                                      | 5 min par défaut, 24 h max                                                        | 0,00003942 $/cœur-s (1 cœur = 2 vCPU) ; 0,00000667 $/GiB-s                                                 | ~0,059 $                      | `encrypted_ports` avec jeton, WebSocket compris            |
| Fly Machines                                | Firecracker                        | redémarrage « well under a second » | policies par port et protocole seulement, **pas de domaines** ; proxy à construire                                                                         | durée libre                                                                       | shared-cpu-1x 2 GB 0,0000038 $/s ; performance-1x 0,00001196 $/s ; egress 0,02 $/GB (UE)                   | ~0,007 $ (shared) / ~0,022 $  | Fly Proxy (non re-vérifié ici)                             |
| Daytona                                     | conteneur par défaut, VM en option | < 90 ms (conteneur)                 | allowlist de domaines et CIDR seulement aux tiers 3–4                                                                                                      | 4 vCPU, 8 GB max                                                                  | 0,0504 $/vCPU-h ; 0,0162 $/GiB-h ; prix du mode VM non trouvé                                              | ~0,041 $                      | preview URLs, terminal web                                 |
| gVisor (runsc) sur VM Hetzner               | noyau applicatif (gVisor)          | process local, non mesuré           | entièrement à construire                                                                                                                                   | capacité fixe                                                                     | CX33 8,49 €/mois, CX43 15,99 €/mois (prix au 2026-06-15)                                                   | marginal ≈ 0                  | à construire                                               |

**Lecture.**

- **Cloudflare Sandbox SDK** coche le plus de cases pour ce cas précis. Ses handlers
  `outbound` injectent un secret côté Worker, ce qui est exactement le besoin BYOK et quota
  (§ 4). Sa facturation au CPU actif colle à une charge qui attend le LLM. Durable Objects,
  R2 et Turnstile sont chez le même fournisseur. Réserves : `exposePort` est déprécié et la
  question Tunnels/egress est ouverte (P3). SDK 1.0 = `@cloudflare/sandbox@next`, donc une
  API encore en mouvement. Enfin, la mémoire est facturée au provisionné, et le plancher est
  de 3 GiB par vCPU en instance custom.
- **E2B** est le meilleur plan B : Firecracker, allowlist par domaine, plan Hobby gratuit
  (1 h, 20 concurrents) suffisant pour la bêta fermée. Il n'a pas d'injection de secret : la
  clé passe alors par notre propre proxy LLM (variante du § 4).
- **Vercel Sandbox** a le meilleur pare-feu. Mais son transfert facture tout le trafic des
  ports exposés, donc le Client web du studio (flux Flight, live) coûte au Go.
- **Fly** est le moins cher, mais il faut construire le filtrage par domaine, le pool de VM et
  le nettoyage. **gVisor sur Hetzner** a le coût fixe le plus bas et le coût humain le plus
  haut. Aucun des deux ne se justifie avant d'avoir du trafic réel.
- **Daytona** isole par conteneur par défaut, ce qui ne convient pas à du code non fiable. Le
  prix de son mode VM n'est pas trouvé.

## 3. Accès et anti-abus

| Mécanisme        | Choix proposé                                                                                                                                                                                                                                        |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login            | **OAuth App GitHub sans scope** : accès en lecture à l'information publique ; `GET /user` renvoie `id`, `login` et `created_at`. Le jeton GitHub est jeté après la lecture du profil ; notre session est un cookie `HttpOnly` sur l'origine du site. |
| Âge du compte    | `created_at` : compte de moins de 30 jours → BYOK seulement (seuil à trancher). Bloque les comptes créés à la chaîne pour le quota gratuit.                                                                                                          |
| Turnstile        | gratuit (siteverify illimité, 20 widgets) ; jeton à usage unique, valable 300 s, **vérifié côté serveur** (« Tokens can be forged ») ; demandé à chaque démarrage de session, pas à chaque message.                                                  |
| Quota par compte | 3 sessions par jour, 1 à la fois, 30 min et 0,25 $ de LLM par session au plus. Le plafond LLM est appliqué par OpenRouter : une clé par compte GitHub, `limit` = plafond du jour, `limit_reset: "daily"` (API de gestion de clés).                   |
| Plafond global   | le **solde prépayé** OpenRouter, sans recharge automatique : quand il est épuisé, OpenRouter répond 402 (`openrouter_credits`), et le studio bascule en « BYOK seulement ». Doublé d'un compteur mensuel dans le Durable Object, qui coupe avant.    |
| Concurrence      | N VM au plus (20 en bêta fermée, la limite du plan Hobby d'E2B et un ordre de grandeur raisonnable ailleurs). Au-delà, **file d'attente** dans un Durable Object, avec la position affichée et un jeton de place valable 2 min à l'appel.            |
| Durée de vie     | 30 min dures, 10 min d'inactivité (`sleepAfter`) ; avertissement à T-5 min ; la VM est détruite, pas mise en veille (pas de reprise en v1).                                                                                                          |
| Arrêt d'urgence  | un interrupteur global (Durable Object) : « Try it » passe en lecture seule ou en BYOK seulement ; révocation d'un compte (clé OpenRouter `disabled: true`).                                                                                         |

**Ce qu'on journalise** (30 jours) : `id` et `login` GitHub, `created_at` du compte, début et
fin de session, modèle, tokens et coût (lus sur la clé OpenRouter ou par
`get_session_stats` de pi), nombre de builds réussis ou échoués, signaux d'abus (CPU soutenu,
connexions sortantes refusées), IP tronquée ou hachée pour la limite de débit.

**Ce qu'on ne journalise pas** : prompts, code généré, sorties de l'agent (sauf opt-in
explicite pour le banc d'essai ou un rapport de bug), en-têtes `Authorization`, clés, jeton
GitHub. Le handler `outbound` et le Worker ne loguent jamais les en-têtes des requêtes vers
OpenRouter.

**À dire au visiteur** : ses prompts transitent par OpenRouter et par le fournisseur du
modèle choisi. Leurs politiques de conservation n'ont pas été vérifiées ici et doivent l'être
avant l'ouverture (surtout pour un fournisseur dont les données partent hors UE).

## 4. BYOK

**Périmètre : une clé OpenRouter, rien d'autre en v1.** Une seule intégration donne tous les
modèles (pi a `openrouter` intégré, variable `OPENROUTER_API_KEY`). Cela règle aussi la
conformité : une chaîne n'est acceptée que si `GET https://openrouter.ai/api/v1/key` répond
200, ce qu'aucun jeton d'abonnement Claude ou ChatGPT ne fait. On respecte ainsi la règle de
[CODER-HANDOFF.md § 3](../CODER-HANDOFF.md#3-conformité--garde-fous-non-négociables) sans
détecter de préfixes.

### Deux manières d'obtenir la clé

1. **OAuth PKCE OpenRouter (recommandé).** Redirection vers
   `https://openrouter.ai/auth?callback_url=…&code_challenge=…&code_challenge_method=S256`,
   puis `POST /api/v1/auth/keys {code, code_verifier}` qui renvoie `{key}`, facturée sur le
   compte du visiteur. Il ne copie jamais sa clé ; l'API `POST /api/v1/auth/keys/code`
   accepte `limit`, `usage_limit_type` et `expires_at` : on peut créer une clé **plafonnée et
   qui expire**. Non vérifié : que l'URL `/auth` du navigateur accepte aussi `limit`.
2. **Coller une clé existante.** Champ sur la page hôte, jamais dans le studio TUI : tout ce
   qui est tapé dans le studio arrive au Server du studio, donc dans la VM.

### Cycle de vie

```text
 page hôte ──POST (TLS)──▶ Worker de contrôle ──GET /api/v1/key──▶ OpenRouter
                                  │ 200 : limit_remaining, is_free_tier affichés
                                  ▼
                      Durable Object de la session : clé en mémoire (champ JS),
                      jamais dans son stockage, jamais journalisée
                                  │
 VM : pi ─▶ https://openrouter.ai (OPENROUTER_API_KEY = "session-<sid>")
                                  │ handler outbound : Authorization remplacé
                                  ▼
                            OpenRouter, facturé au visiteur
 fin de session, éviction du DO ou « oublier ma clé » : la clé disparaît
```

La consigne de départ était « mémoire du conteneur seulement ». Cette étude propose de garder
la clé **en mémoire, mais hors du conteneur** : dans le conteneur, n'importe quel code généré
lirait `process.env` ou `/proc/<pid>/environ` de pi. L'allowlist d'egress limiterait où la
clé peut partir, mais elle ne serait plus un secret. Le Durable Object de la session offre la
même durée de vie, perdue à l'éviction, sans cette exposition. C'est à trancher (§ 7).
Variante hors Cloudflare (E2B, Fly) : pi pointe vers notre propre proxy LLM via `models.json`
(`baseUrl`, `apiKey: "session-<sid>"`), qui injecte la clé. Même principe.

### Validation et UX

- À la saisie : `GET /api/v1/key`. 401 → « clé refusée par OpenRouter ». On affiche
  `limit_remaining` et `usage_daily`. Si `is_free_tier` vaut vrai, on prévient : seuls les
  modèles `:free` seront disponibles, à 50 requêtes par jour sans 10 $ de crédits achetés.
- Pendant la session : un 402 d'OpenRouter est traduit selon `limit_source` (« votre clé a
  atteint sa limite » ou « votre compte n'a plus de crédit »), jamais un écran d'erreur
  générique.
- Texte d'explication, près du champ : « Votre clé sert uniquement pendant cette session,
  pour appeler OpenRouter. Elle reste en mémoire sur nos serveurs, n'est jamais écrite sur
  disque ni dans un journal, et n'est jamais transmise au bac à sable où tourne le code
  généré. Préférez une clé dédiée avec une limite de crédit ; supprimez-la après
  usage. » Plus un lien vers la page de la clé (`https://openrouter.ai/keys/<sha256>`).

### Risques propres au BYOK

| Risque                                               | Parade                                                                                                                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Exfiltration par le code généré                      | la clé n'est pas dans la VM ; l'egress n'autorise qu'`openrouter.ai`                                                                                        |
| Code généré qui brûle le crédit du visiteur          | il peut appeler OpenRouter par le handler, qui injecte la clé : plafond par session appliqué par le Worker (tokens comptés) et clé OAuth créée avec `limit` |
| Domain fronting (SNI `openrouter.ai`, Host ailleurs) | le handler Cloudflare intercepte le TLS et voit la requête HTTP réelle ; avec un filtre SNI seul (Vercel), le risque existe (la doc Vercel le signale)      |
| Fuite par nos journaux ou par un traceur d'erreurs   | aucun log d'en-têtes ; les erreurs sont filtrées avant envoi à un service tiers ; revue de code dédiée                                                      |
| Confusion avec un abonnement                         | on refuse tout ce qui n'est pas une clé OpenRouter valide ; aucun champ « token Claude/ChatGPT »                                                            |

## 5. Modèle de coût

### Hypothèses

- **Session type** : 20 min, 5 demandes du visiteur, ~40 appels LLM au total (boucle
  d'outils). Contexte moyen par appel ~30 k tokens (prompt système, guide airtty condensé,
  fichiers lus), dont **80 % en cache**, et ~1,5 k tokens de sortie par appel. Soit **1,2 M
  tokens d'entrée** (0,96 M en cache, 0,24 M hors cache) et **60 k tokens de sortie**. Ces
  chiffres sont les plus incertains du document : le banc (§ 6) les mesure.
- **Calcul** : Cloudflare standard-1 (½ vCPU, 4 GiB, 8 GB) pendant 20 min, avec ~2 min de CPU
  actif (builds de ~1 à 3 s, `tsc`, pi). Mémoire 4 × 1 200 × 0,0000025 = 0,012 $ ; CPU
  120 × 0,00002 = 0,0024 $ ; disque 8 × 1 200 × 0,00000007 = 0,0007 $. **≈ 0,015 $.** Pire
  cas (30 min, CPU à 100 %) : ≈ 0,037 $. Egress négligeable : quelques Mo de trafic LLM,
  et les aperçus sont servis par R2. Fixe : 5 $/mois (Workers Paid).
- **OpenRouter** : +5,5 % à l'achat de crédits par carte, sans majoration sur l'inférence.
  Prix pris sur l'endpoint du fournisseur d'origine, pas sur le moins cher : ce dernier est
  parfois quantifié, et fiabilise moins les appels d'outils.

### Coût par session

| Modèle (id OpenRouter)                                                  | Prix /M (entrée, cache, sortie) | LLM par session                                           | + 5,5 % | + calcul | **Total**   |
| ----------------------------------------------------------------------- | ------------------------------- | --------------------------------------------------------- | ------- | -------- | ----------- |
| DeepSeek V4.1 Flash (`deepseek/deepseek-v4.1-flash`, endpoint DeepSeek) | 0,15 / 0,003 / 0,60             | 0,036 + 0,003 + 0,036 = 0,075 $                           | 0,079 $ | 0,015 $  | **0,094 $** |
| GPT-6 Luna (`openai/gpt-6-luna`)                                        | 0,10 / 0,01 / 0,50              | 0,024 + 0,010 + 0,030 = 0,064 $                           | 0,067 $ | 0,015 $  | **0,082 $** |
| Gemini 3.8 Flash (`google/gemini-3.8-flash`)                            | 0,75 / 0,075 / 3,75             | 0,180 + 0,072 + 0,225 = 0,477 $                           | 0,503 $ | 0,015 $  | **0,518 $** |
| _Référence qualité : Claude Haiku 4.5 (`anthropic/claude-haiku-4.5`)_   | 1,00 / 0,10 / 5,00              | 0,240 + 0,096 + 0,300 = 0,636 $ (hors écritures de cache) | 0,671 $ | 0,015 $  | _0,686 $_   |

Remarques : en direct chez DeepSeek, `deepseek-flash` coûte le double en heures pleines
(0,30 / 0,006 / 1,20 ; 01:00–04:00 et 06:00–10:00 UTC en semaine), le même prix en heures
creuses. Le prix de Gemini 3.8 Flash doublera au 2027-01-01 (1,50 / 7,50). GLM-5.3 Flash
(0,15 / 0,50 chez Z.AI) et MiMo V2.6 Flash (0,14 / 0,28) sont dans la même zone que DeepSeek
et GPT-6 Luna : à inclure au banc.

### Coût mensuel (sessions payées par nous)

Trois niveaux : bêta fermée (10 sessions/jour), ouverture discrète (100/jour), pic de
lancement soutenu (1 000/jour). Fixe inclus (5 $).

| Sessions/mois | DeepSeek V4.1 Flash | GPT-6 Luna | Gemini 3.8 Flash |
| ------------- | ------------------- | ---------- | ---------------- |
| 300           | ≈ 33 $              | ≈ 30 $     | ≈ 160 $          |
| 3 000         | ≈ 287 $             | ≈ 251 $    | ≈ 1 559 $        |
| 30 000        | ≈ 2 825 $           | ≈ 2 465 $  | ≈ 15 545 $       |

Sensibilité : si les tokens réels sont trois fois l'hypothèse, le coût LLM triple et le calcul
ne bouge pas. Les sessions BYOK ne nous coûtent que le calcul (~0,015 $), soit 450 $/mois à
30 000 sessions. Avec un plafond global de 100 $/mois et un modèle à ~0,09 $, on offre
~1 000 sessions/mois ; au-delà, c'est BYOK seulement.

## 6. Choix du modèle : banc d'essai

**Non exécuté** : il coûte de l'argent. Estimation : 10 prompts × 3 essais × 4 modèles,
aux coûts par session du § 5, soit **~40 $** (dont ~36 $ pour Gemini et Haiku). Il faut l'accord de l'utilisateur et une clé OpenRouter
dédiée plafonnée à ce montant. Une variante gratuite existe, sur des modèles `:free` comme
`qwen/qwen3.8-27b:free` (20 requêtes/min, 50 par jour), mais elle n'est pas représentative.

**Montage.** Le même que la production : image de VM, pi 0.87.x en RPC, mêmes outils (dont
`build`), même prompt système et même guide airtty condensé. Seul le modèle change
(`--model openrouter/<id>`, routage OpenRouter forcé sur le fournisseur d'origine).
`--no-session`, température par défaut.

**Prompts** (du plus simple au plus exigeant ; profil `--web-local`) :

1. Compteur avec `+`, `-`, remise à zéro, et l'aide des touches en bas.
2. Liste de tâches persistée dans `bun:sqlite` (ajout, cocher, supprimer).
3. Minuteur Pomodoro avec barre de progression et pause.
4. Convertisseur d'unités à formulaire et validation.
5. Quiz de 5 questions, score à la fin, navigation entre écrans (routes).
6. Kanban à trois colonnes, déplacement au clavier, persistant.
7. Carnet de notes Markdown (liste + rendu `<markdown>`).
8. Tableau de bord « live » : valeurs simulées côté Server, écran abonné par `useLive`.
9. Jeu Snake au clavier.
10. Modification : reprendre l'app 2 et ajouter un filtre et un compteur de tâches restantes.

**Mesures par essai** :

| Critère               | Mesure                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build réussi          | l'outil `build` réussit (build `--web-local`, `tsc`, vérification des built-ins) ; au premier essai, et en au plus 5 itérations                                                                                    |
| Rendu correct         | aperçu chargé en Chrome headless par le driver de `scripts/web/` : pas d'écran d'erreur, textes attendus présents, un scénario clavier propre au prompt (lecture du buffer de l'émulateur, comme les parcours PTY) |
| Itérations            | nombre d'appels à `build` jusqu'au succès ; nombre de tours du visiteur simulé (relances scriptées : « l'écran affiche une erreur : … »)                                                                           |
| Coût et tokens        | `get_session_stats` de pi (tokens, coût en USD) recoupé avec `usage` de la clé OpenRouter                                                                                                                          |
| Temps                 | durée du premier prompt jusqu'à l'aperçu réussi                                                                                                                                                                    |
| Robustesse des outils | appels d'outils mal formés, boucles (même édition répétée), abandons                                                                                                                                               |

**Décision** : on retient le modèle le moins cher dont le taux de « rendu correct en ≤ 5
itérations » est à moins de 10 points de la référence (Haiku 4.5). En cas d'égalité, le temps
médian départage. Les tokens mesurés remplacent les hypothèses du § 5.

## 7. Recommandation phasée, risques, points à trancher

### Phases

| Phase                           | Contenu                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Sortie                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **0. Sondes** (sans public)     | **P1** : pi en RPC dans Cloudflare Sandbox, `enableInternet=false`, `OPENROUTER_API_KEY` factice remplacée par le handler `outbound` ; outil `build` d'extension sous `--tools`. **P2** : aperçu `--web-local` servi depuis un domaine distinct avec CSP `connect-src 'self'` : SharedWorker et OPFS fonctionnent. **P3** : le Client web du studio joint son Server dans la VM (relais Worker ou Tunnel) avec l'egress fermé. **P4** : le banc (§ 6), après accord sur le budget. | faisabilité, tokens et coût réels, choix du modèle |
| **1. Bêta fermée**              | liste d'invités GitHub ; quota hébergé à 50 $/mois et BYOK ; 20 VM ; pas de partage d'aperçu ; journal minimal ; E2B Hobby si Cloudflare bloque en P3                                                                                                                                                                                                                                                                                                                              | retours qualitatifs, métriques de coût             |
| **2. « Try it (beta) » public** | Turnstile, âge du compte, quotas par compte et plafond global, file d'attente, arrêt d'urgence, page d'explication BYOK et données ; téléchargement du projet                                                                                                                                                                                                                                                                                                                      | ouverture sur le site                              |
| **3. Extensions**               | apps `--web` (option B), ajout de dépendances npm via un miroir en allowlist, partage d'aperçu (avec modération), autres clés fournisseur                                                                                                                                                                                                                                                                                                                                          | selon la demande                                   |

### Risques

| Risque                                                                                                                            | Effet                                      | Parade                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| API Cloudflare Sandbox en mouvement (SDK 1.0, `exposePort` déprécié, Tunnels et egress non vérifiés)                              | prototype à réécrire                       | P3 d'abord ; couche fine autour du fournisseur ; E2B en plan B                        |
| Modèle bon marché trop faible sur airtty (framework récent, absent des données d'entraînement)                                    | builds ratés, mauvaise première impression | guide airtty condensé dans le prompt, outil `build` aux erreurs structurées, banc § 6 |
| Tokens par session sous-estimés                                                                                                   | coût × 2 ou × 3                            | plafond par session appliqué par la clé ; mesure au banc                              |
| Abus malgré GitHub (fermes de comptes)                                                                                            | budget consommé                            | âge du compte, Turnstile, plafond global dur, arrêt d'urgence                         |
| Contenu généré abusif dans l'aperçu                                                                                               | réputation, signalements                   | domaine séparé, URL signée, TTL, pas de partage en v1                                 |
| Build `--web-local` qui accepte `fs`/`child_process` (mesuré)                                                                     | aperçu cassé à l'usage                     | vérification des built-ins dans l'outil `build`                                       |
| Dépendance au prix et à la disponibilité d'un modèle (DeepSeek : `deepseek-v4-pro` routé vers Flash, page de prix contradictoire) | prix ou comportement qui changent          | OpenRouter : changer de modèle = changer un id ; banc rejouable                       |
| Données des visiteurs chez des fournisseurs tiers                                                                                 | conformité (RGPD)                          | vérifier les politiques de conservation ; choisir les endpoints ; l'annoncer          |
| Poids de l'aperçu (runtime + wasm ≈ 1,5 Mo gzip au premier chargement, `tree-sitter/` à la demande)                               | attente au premier aperçu                  | cache long sur l'origine de contenu ; chargement pendant que l'agent travaille        |

### Points à trancher par l'utilisateur

1. **Clé BYOK hors du conteneur** (Durable Object, en mémoire) plutôt que dans le conteneur
   (consigne initiale) : recommandé, pour qu'aucun code généré ne puisse la lire.
2. **Plateforme** : Cloudflare Sandbox SDK (recommandé) ou E2B ; cela conditionne aussi où
   vit le site.
3. **Outils de pi** : sans `bash`, avec un outil `build` (recommandé), ou `bash` complet
   (plus autonome, surface plus large).
4. **Studio hébergé en TUI** (Client web, recommandé) ou chat HTML simple.
5. **Profil des apps générées en v1** : `--web-local` seulement (recommandé), sans
   dépendances npm nouvelles.
6. **Modèle par défaut** : après le banc ; candidats DeepSeek V4.1 Flash et GPT-6 Luna.
   Budget du banc : ~40 $, à approuver.
7. **Chiffres de quota** : sessions par jour et par compte, plafond LLM par session, plafond
   global mensuel (50 $ en bêta ?), seuil d'âge du compte GitHub.
8. **Domaines** : domaine du site, et domaine registrable séparé pour les aperçus (à
   acheter).
9. **Journalisation des prompts** : jamais (recommandé), ou opt-in pour améliorer le guide et
   le banc.
10. **Partage des aperçus** : exclu en v1 (recommandé), à cause de la modération.

## Sources

Toutes consultées le 2026-09-27.

**Dépôt airtty** : [README.md](../../README.md), [WEB.md](../WEB.md),
[EMBEDDING.md](../EMBEDDING.md), [DISTRIBUTION.md](../DISTRIBUTION.md),
[CODER-HANDOFF.md](../CODER-HANDOFF.md), [pi-report.md](../coder/research/pi-report.md),
`packages/airtty/src/build.ts:155` (évaluation d'`app/args.ts`), mesures locales ci-dessus.

**pi**

- Paquet `@earendil-works/pi-coding-agent` 0.87.1 (2026-09-22), successeur de `@mariozechner/pi-coding-agent` (déprécié en 0.73.1) : https://www.npmjs.com/package/@earendil-works/pi-coding-agent, https://www.npmjs.com/package/@mariozechner/pi-coding-agent
- Fournisseurs : https://github.com/badlogic/pi-mono/tree/main/packages/ai/src/providers ; clés et variables : https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md ; priorité des clés, `models.json` : https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/models.md ; CLI (`--api-key`, `--tools`, `auth check`) : https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/cli.md ; modes : https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/cli-integration.md ; SDK : https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md ; stockage : https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/configuration.md et sessions.md ; variables : environment-variables.md ; absence de permissions : https://github.com/badlogic/pi-mono/blob/main/README.md ; `deepseek-flash` dans le catalogue (0.86.0) : https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md

**Modèles et OpenRouter**

- DeepSeek V4.1 Flash (annonce, routage de `deepseek-v4-pro`) : https://api-docs.deepseek.com/news/news260910/ ; prix : https://api-docs.deepseek.com/quick_start/pricing
- Catalogue et prix OpenRouter : https://openrouter.ai/api/v1/models, https://openrouter.ai/api/v1/models/deepseek/deepseek-v4.1-flash/endpoints
- GPT-6 Luna, GPT-5.4 mini : https://developers.openai.com/api/docs/pricing ; Gemini 3.8 Flash : https://ai.google.dev/gemini-api/docs/pricing
- Frais OpenRouter : https://openrouter.ai/docs/faq.md ; BYOK : https://openrouter.ai/docs/guides/overview/auth/byok.md ; `GET /api/v1/key`, 402, limites des modèles gratuits : https://openrouter.ai/docs/api_reference/limits.md ; clés de gestion : https://openrouter.ai/docs/guides/overview/auth/management-api-keys.md ; OAuth PKCE : https://openrouter.ai/docs/guides/overview/auth/oauth.md, https://openrouter.ai/docs/api/api-reference/oauth/create-authorization-code.md

**Bacs à sable**

- Cloudflare Containers : https://developers.cloudflare.com/containers/platform-details/architecture/, https://developers.cloudflare.com/containers/platform-details/limits/, https://developers.cloudflare.com/containers/pricing/, https://developers.cloudflare.com/changelog/product/containers/, https://developers.cloudflare.com/changelog/post/2025-11-21-new-cpu-pricing/
- Cloudflare Sandbox SDK : https://developers.cloudflare.com/sandbox/, https://developers.cloudflare.com/sandbox/platform/pricing/, https://developers.cloudflare.com/sandbox/guides/outbound-traffic/, https://developers.cloudflare.com/sandbox/guides/browser-terminals/, https://developers.cloudflare.com/sandbox/configuration/sandbox-options/, https://developers.cloudflare.com/sandbox/guides/expose-services/, https://developers.cloudflare.com/sandbox/guides/2026-deprecation/
- E2B : https://e2b.dev/pricing, https://docs.e2b.dev/sandbox, https://docs.e2b.dev/sandbox/internet-access, https://docs.e2b.dev/network/public-url
- Vercel Sandbox : https://vercel.com/docs/sandbox/concepts, https://vercel.com/docs/vercel-sandbox/pricing, https://vercel.com/docs/sandbox/concepts/firewall
- Modal : https://modal.com/docs/guide/sandbox, https://modal.com/docs/guide/sandbox-networking, https://modal.com/pricing
- Fly.io : https://docs.fly.io/reference/architecture/, https://docs.fly.io/machines/overview/, https://docs.fly.io/about/pricing/, https://docs.fly.io/machines/guides-examples/network-policies/
- Daytona : https://www.daytona.io/docs/en/sandboxes/, https://www.daytona.io/pricing, https://www.daytona.io/docs/en/network-limits/
- gVisor : https://gvisor.dev/docs/ ; Hetzner : https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/

**Accès**

- Turnstile : https://developers.cloudflare.com/turnstile/plans/, https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
- GitHub : https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps, https://docs.github.com/en/rest/users/users?apiVersion=2022-11-28#get-the-authenticated-user, https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps

**Non vérifié** (à lever en phase 0 ou avant l'ouverture) : les Tunnels Cloudflare avec
`enableInternet=false` ; le relais Worker vers un port du conteneur avec le SDK 1.0 ; un outil
d'extension pi actif sous `--tools` ; le paramètre `limit` sur l'URL `/auth` d'OpenRouter ;
le démarrage à froid officiel d'E2B et de Modal ; le prix du mode VM de Daytona ; le statut
réel de `deepseek-v4-pro` ; les politiques de conservation des données d'OpenRouter et des
fournisseurs ; la qualité de chaque modèle sur airtty (banc § 6).
