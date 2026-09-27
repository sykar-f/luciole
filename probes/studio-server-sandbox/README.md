# Sonde studio-server-sandbox : confiner le Server d'une app générée

Exécutée le 27 septembre 2026 sur macOS 26.6.2 (arm64), Bun 1.4.2, deux fois (la
seconde sur une machine chargée). Sert la conception de
[docs/studio/SPEC.md](../../docs/studio/SPEC.md), section 6.

Question : le mode `sandbox` d'[EMBEDDING.md](../../docs/EMBEDDING.md) confine le
**Client** d'une origine ; son Server tourne ailleurs (distant, ou lancé par
l'utilisateur). Dans studio, le Server de l'app générée exécute du code écrit par un
modèle (pages, Server Functions, `server/`) sur la machine de l'utilisateur. Peut-on le
lancer sous Seatbelt avec le profil que `src/sandbox/profile.ts` génère déjà, et servir
quand même l'aperçu ? Qu'est-ce que ce code perd ?

Réponse : **oui**, avec le profil existant plus **deux règles** (écouter sur un port
loopback précis), pour ≈ 11 ms de plus au démarrage.

```sh
bun probes/studio-server-sandbox/probe.tsx    # depuis la racine ; macOS seul ; écrit results.json
```

Aucune dépendance propre, `src/` n'est pas modifié. La sonde copie
`../studio-preview/template` dans `.airtty-work/app/`, lui ajoute `server/escape.ts`
(appelé par la page, il tente de sortir et rend le résultat), construit l'app, lance son
Server nu puis confiné et rend la page avec le Client construit (`testRender`).

Profil du Server confiné : `seatbeltProfile()` avec aucune capacité, en lecture
`.airtty/` et `package.json` de l'app (pas ses sources), en écriture un répertoire
`data/`, `/dev/null` pour terminal, puis :

```scheme
(allow network-bind (local ip "localhost:<port>"))
(allow network-inbound (local ip "localhost:<port>"))
```

Environnement réduit à `PATH`, `HOME` et `TMPDIR` (répertoire privé), `PORT`.

## Résultats (8/8)

| Tentative du code généré                                | Nu     | Confiné        |
| ------------------------------------------------------- | ------ | -------------- |
| lire un fichier hors du workspace                       | permis | `EPERM`        |
| lire `~/.zshrc`                                         | permis | `EPERM`        |
| écrire hors de `data/`                                  | permis | `EPERM`        |
| écrire dans `data/`                                     | permis | permis         |
| se connecter à un service local (127.0.0.1, autre port) | permis | `ECONNREFUSED` |
| `fetch("https://example.com")`                          | permis | `ENOTFOUND`    |
| `Bun.spawnSync(["/bin/echo"])`                          | permis | `EPERM`        |
| servir la page à l'aperçu                               | oui    | oui            |

Démarrage du Server jusqu'à sa ligne `ready` (médiane de 7, alternés) :

| Run         | Nu    | Confiné |
| ----------- | ----- | ------- |
| 1           | 60 ms | 71 ms   |
| 2 (chargée) | 83 ms | 95 ms   |

## Constats

1. Le profil du Client suffit au Server : aucun service mach, rien de `/System`, pas de
   JIT ; seule l'écoute manque. `confine()` (`src/sandbox/confine.ts`) ne connaît qu'une
   route vers un Server (`ServerRoute`), pas un Server qui écoute : il faut l'étendre
   (spec, section 7).
2. Un Server confiné ne lit pas ses sources : seul le build (`.airtty/`) est ouvert. Le
   build reste fait par studio, hors sandbox, qui lit les sources.
3. `data/` est le seul endroit persistant : une base `bun:sqlite` y survit aux
   rechargements (l'état en mémoire, non : voir [studio-preview](../studio-preview/README.md)).
4. Linux (`airtty-sandbox`, espaces de noms réseau) n'est pas mesuré : le Server devrait
   y écouter dans son espace de noms et l'hôte le joindre par un relais inverse ; à
   concevoir en C5b.
5. Le port est choisi par l'hôte juste avant le lancement (petite course possible) ; un
   socket Unix dans un répertoire privé l'éviterait, comme le fait déjà le lanceur
   (`AIRTTY_SOCKET`), mais demande une règle Seatbelt sur ce chemin, non mesurée.
