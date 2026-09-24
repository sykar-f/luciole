# Sonde sandbox — capacités → Seatbelt (macOS), bubblewrap/Landlock/seccomp (Linux)

Exécutée le 24 septembre 2026 sur macOS 26.6.2 (Darwin 25.6.0, Apple Silicon), Bun 1.4.2
(installé par Nix). Partie Linux : conteneur `oven/bun:1.4.2` arm64 privilégié sous
OrbStack, noyau 7.0.14, bubblewrap 0.12.0, Landlock ABI 8.

```sh
bun probes/sandbox/probe.ts            # macOS seul
bun probes/sandbox/probe.ts --linux    # + bubblewrap dans Docker (installe bubblewrap via apt)
```

Aucune dépendance ajoutée (Zod et OpenTUI viennent de la racine). Le probe démarre deux
serveurs HTTP et le proxy sur 127.0.0.1, les arrête à la fin, écrit `results.json` et sort
en code 1 si une assertion échoue. Il modifie puis restaure le presse-papiers `find`
(pas le presse-papiers général) et lance `open -g -j -a Finder` hors sandbox (Finder
tourne déjà : rien ne s'affiche).

## Fichiers

| Fichier           | Rôle                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------- |
| `capabilities.ts` | Schéma Zod des capacités (forme du manifeste), `granted()`, correspondance d'hôtes.             |
| `seatbelt.ts`     | `profileFor(caps, runtime)` → `{ profile, report }` : SBPL généré + qui applique chaque grant.  |
| `proxy.ts`        | Proxy de sortie de l'hôte (HTTP forward + CONNECT), liste d'hôtes, TCP loopback ou socket unix. |
| `child.ts`        | Côté sandboxé : une action par lancement, une ligne JSON `{ ok, detail }`.                      |
| `sandbox-init.ts` | Alternative à `sandbox-exec` : `sandbox_init_with_parameters` via `bun:ffi`.                    |
| `linux.ts`        | `linuxPlan(caps, runtime)` → arguments bwrap, ruleset Landlock, liste seccomp, `report`.        |
| `linux-run.ts`    | Exécuté dans le conteneur : bwrap réel + assertions ; `relay.ts` expose le socket du proxy.     |
| `landlock-abi.ts` | ABI Landlock du noyau (`landlock_create_ruleset(…, VERSION)` via `bun:ffi`).                    |

Forme des capacités : `{ fs: { read: [], write: [] }, net: ["host", "*.host", "host:port",
"*"], exec: false | true | ["/abs/bin"], pty, clipboard: { read, write }, notify, openUrl,
secrets: ["nom"], inputGlobal, tabsMessage }`. Deux ajustements au cahier : `exec` accepte une
liste de binaires (Seatbelt et Landlock filtrent l'exécution par chemin, et un exec hérite du
sandbox) ; `clipboard` sépare lecture et écriture bien que l'OS ne le puisse pas (un seul
service pasteboard) — c'est l'hôte qui applique les deux.

## Résultats macOS (38/38)

| Assertion                                                      | Attendu | Observé                                                           |
| -------------------------------------------------------------- | ------- | ----------------------------------------------------------------- |
| SBPL `(remote ip "example.com:443")` / `"93.184.215.14:443"`   | refusé  | `host must be * or localhost in network address` (les deux)       |
| `sandbox-exec` présent, man page « DEPRECATED »                | oui     | oui                                                               |
| `bun -e 0` sous le profil de base                              | OK      | OK                                                                |
| React + renderer natif OpenTUI (`createTestRenderer`)          | OK      | OK (`libopentui.dylib` chargée depuis `node_modules`)             |
| Fuseau horaire identique au processus hors sandbox             | OK      | OK (voir règles mesurées)                                         |
| fs.read chemin accordé / autre chemin                          | OK / ✗  | contenu / `EPERM`                                                 |
| `~/.ssh/config` : hors sandbox / sandboxé                      | OK / ✗  | lisible / `EPERM`                                                 |
| fs.write accordé / chemin seulement lisible / autre            | OK/✗/✗  | écrit / `EPERM` / `EPERM`                                         |
| exec `/bin/ls` sans capacité / listé / `/bin/cat` non listé    | ✗/OK/✗  | `EPERM posix_spawn` / OK / `EPERM posix_spawn`                    |
| Un sous-processus (bun, autorisé) lit `~/.ssh`                 | ✗       | `EPERM` : le profil est hérité                                    |
| PTY (`/dev/ptmx`) sans / avec `pty`                            | ✗ / OK  | `EPERM` / ouvert                                                  |
| `pbpaste`, `pbcopy` (binaires autorisés)                       | ✗       | status 1, nonce ni lu ni écrasé (mach-lookup pasteboard refusé)   |
| `security list-keychains` (autorisé)                           | ✗       | `SecKeychainCopySearchList: unknown error -50`                    |
| `open -g -j -a Finder` (autorisé)                              | ✗       | `Unable to find application named 'Finder'` (LaunchServices muet) |
| DNS `localhost` sans net / avec liste d'hôtes                  | ✗ / ✗   | `ENOTFOUND` : l'enfant ne résout jamais, le proxy le fait         |
| TCP direct vers un serveur local (net = liste)                 | ✗       | `ECONNREFUSED` (forme du refus Seatbelt ; le serveur écoute)      |
| Proxy injoignable sans capacité `net`                          | ✗       | `ECONNREFUSED`                                                    |
| Proxy → hôte autorisé (forward HTTP, `fetch({ proxy })`)       | OK      | `200 allowed host`                                                |
| Proxy → autre hôte                                             | ✗       | `403`                                                             |
| CONNECT → hôte autorisé / autre hôte                           | OK / ✗  | tunnel OK / `HTTP/1.1 403 Forbidden`                              |
| `net: ["*"]` → TCP direct                                      | OK      | connecté                                                          |
| `sandbox_init_with_parameters` via `bun:ffi`, puis `~/.ssh`    | ✗       | `sandbox_init=0`, `EPERM`                                         |
| Rapport : une ligne par capacité accordée, aucune `unenforced` | oui     | oui (12 capacités)                                                |

### Règles de base mesurées (bissection)

Profil `(deny default)` puis, pour que `bun` démarre :

- `sysctl-read` : sans elle l'allocateur de Bun échoue (`memory allocation of 48 bytes
failed`, abort).
- `file-read*` sur `"/"` (littéral), `/usr/lib`, `/private/var/db/dyld` (cache partagé), le
  binaire et le répertoire des dylibs non système (ICU de Nix, lu par `otool -L`). Rien de
  `/System` n'est nécessaire ; aucun `mach-lookup` ; pas de règle JIT (hors hardened
  runtime, `sandbox-exec` n'exige pas `dynamic-code-generation`).
- Métadonnées (pas le contenu) des ancêtres des chemins accordés : la résolution de modules
  fait `stat` sur chaque parent. Plus la **lecture du répertoire qui contient
  `node_modules`** : sans elle Bun s'arrête sur `bun is unable to write files: EPERM`
  (message trompeur).
- `/etc` et `/var` (les liens symboliques eux-mêmes) + `/private/etc/localtime` +
  `/private/var/db/timezone` : sans les liens, Bun passe **silencieusement** en UTC.
- `/dev/null`, `/dev/urandom`, `/dev/random`. Les fd hérités (stdio, PTY de l'hôte) ne
  sont pas revérifiés : Seatbelt contrôle l'ouverture, pas l'usage.

Le profil complet généré pour « toutes les capacités » est dans `results.json`
(`sampleProfile`).

### Surcoût mesuré (médiane de 15 lancements, 3 exécutions)

| Mesure                              | Sans sandbox | `sandbox-exec` |
| ----------------------------------- | ------------ | -------------- |
| `bun -e 0`                          | 9–13 ms      | 19–23 ms       |
| Enfant réel (React + OpenTUI natif) | 63–82 ms     | 71–91 ms       |
| `sandbox-init.ts` (ffi + lecture)   | —            | 19–25 ms       |
| Génération du profil                | 0,3 ms       |                |

Le coût fixe (~10 ms : un `exec` de plus et la compilation SBPL) disparaît dans le démarrage
d'une vraie application ; l'écart sur l'enfant réel est du même ordre que le bruit.

### `sandbox-exec` déprécié, `sandbox_init` en `bun:ffi`

`sandbox-exec` est marqué DEPRECATED depuis macOS 10.8 mais présent et fonctionnel sur
macOS 26.6. L'alternative est prouvée : un lanceur Bun appelle
`sandbox_init_with_parameters(profil, 0, params, &err)` (exporté par `libSystem.B.dylib`)
puis exécute l'app dans le même processus ; le profil s'applique au processus et à ses
descendants. C'est une API privée, la même que celle qu'enveloppe `sandbox-exec` (Chromium
et Firefox utilisent la même famille). Différence : tout ce que le lanceur a ouvert avant
l'appel reste utilisable, donc le lanceur doit être minimal et de confiance. Recommandation :
`sandbox-exec` tant qu'il existe (processus neuf, rien d'hérité), `sandbox_init` en repli.

## Résultats Linux (12/12, bubblewrap réel dans le conteneur)

Lecture accordée OK ; `/root/.ssh` absent (`ENOENT`, non monté) ; écriture accordée OK ;
écriture sur un chemin monté en lecture seule `EROFS` ; hors montages `ENOENT` ; `/dev/ptmx`
absent sans `pty`, présent avec (`--dev` crée un devpts privé) ; TCP direct vers l'IP du
conteneur refusé (namespace réseau : seulement loopback) ; via `relay.ts` → socket unix
monté → proxy : hôte autorisé `200`, autre hôte `403`, CONNECT OK ; `net: ["*"]`
(`--share-net`) connecte. Landlock et seccomp ne sont **pas appliqués** par le probe : ils
sont générés (bits d'accès, règles par chemin et port TCP, `scoped`, liste de syscalls) et
l'ABI du noyau est lue ; l'échantillon est dans `results.json` (`linux.sample`).

## Capacité → mécanisme

| Capacité          | macOS (Seatbelt)                                        | Linux (bwrap + Landlock + seccomp)                                       |
| ----------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| `fs.read`         | OS : `file-read*` par sous-chemin                       | OS : `--ro-bind` + Landlock `READ_*`                                     |
| `fs.write`        | OS : `file-write*` par sous-chemin                      | OS : `--bind` + Landlock `WRITE/MAKE/REMOVE/TRUNCATE`                    |
| `net` (hôtes)     | proxy : OS limite à `localhost:<port du proxy>`         | proxy : netns (loopback seul) + socket unix monté ; Landlock TCP ≥ ABI 4 |
| `net` (`*`)       | OS : `network-outbound` + DNS                           | OS : `--share-net`                                                       |
| `exec`            | OS : `process-exec` par chemin, hérité                  | OS : Landlock `EXECUTE` par chemin (sans Landlock : `unenforced`)        |
| `pty`             | OS : `/dev/ptmx`, `/dev/ttys*`                          | OS : `--dev` (devpts privé) sinon seuls null/zero/random                 |
| `clipboard.read`  | hôte : mach pasteboard refusé ; OSC 52 via le widget VT | hôte : aucun socket Wayland/X11 monté ; OSC 52                           |
| `clipboard.write` | hôte (idem)                                             | hôte (idem)                                                              |
| `notify`          | hôte : usernoted refusé ; OSC 9/777                     | hôte : pas de D-Bus                                                      |
| `open-url`        | hôte : LaunchServices refusé ; requête IPC / OSC 8      | hôte : pas de portail                                                    |
| `secrets`         | hôte : securityd refusé ; IPC, trousseau par origine    | hôte : pas de Secret Service                                             |
| `input.global`    | hôte : seul le PTY de l'embed reçoit des touches        | hôte (idem ; seccomp refuse `TIOCSTI`, `--new-session`)                  |
| `tabs.message`    | hôte : IPC                                              | hôte : IPC                                                               |

« Hôte » signifie : l'OS bloque la voie directe (prouvé ci-dessus pour pasteboard, trousseau,
LaunchServices), et l'enfant ne peut que demander à l'hôte, qui applique la décision de
l'utilisateur. Ne jamais afficher une permission que personne n'applique : `report` sert à
l'invite, et un grant `unenforced` doit être refusé ou signalé, pas affiché comme accordé.

## Limites

- Seatbelt ne filtre ni par nom ni par IP : la liste d'hôtes n'existe **que** grâce au proxy.
  Autoriser `localhost:<port>` autorise aussi tout autre service qui prendrait ce port.
- Le proxy ne regarde que l'en-tête `Host`/la cible CONNECT ; il ne fait pas de TLS (le
  tunnel CONNECT est opaque, comme dans un navigateur). Il résout lui-même les noms : un
  enfant ne peut pas exfiltrer par DNS (vérifié sur macOS : `ENOTFOUND`).
- Sur macOS le profil suppose que `bun` ne demande aucun service mach ; un runtime qui en
  aurait besoin (notifications natives, trousseau) les recevrait par l'hôte, pas par l'OS.
- Linux : Landlock seul (sans user namespaces, p. ex. distributions durcies) ne peut pas
  appliquer une liste d'hôtes — TCP par port vers n'importe quelle adresse, UDP non filtré :
  `landlockOnlyNet()` le rapporte `unenforced`. Landlock et seccomp sont générés, pas appliqués
  (appliquer Landlock depuis Bun exige `landlock_restrict_self` sur le thread qui fera l'exec :
  à faire dans un petit lanceur natif ou via `bwrap --seccomp` + un outil comme `landrun`).
- Le PTY de l'hôte (`/dev/ttysNNN` de l'embed) est hérité en fd : pas de règle nécessaire,
  mais un enfant avec `pty` peut ouvrir d'autres `/dev/ttys*` accessibles à l'utilisateur ;
  une règle par chemin exact de l'esclave alloué serait plus stricte.
- Mesures ponctuelles sur une machine, pas des percentiles.
