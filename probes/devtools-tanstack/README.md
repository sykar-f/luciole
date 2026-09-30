# Sonde : le protocole DevTools de luciole sur le bus de TanStack DevTools

Exécutée le 24 septembre 2026 sur macOS, Bun 1.4.2, `@tanstack/devtools-event-bus`
0.4.3 et `@tanstack/devtools-event-client` 0.4.4. `bun install` puis `bun run probe`
depuis ce dossier ; `results.json` garde la dernière exécution.

Ses dépendances lui sont propres : le `tsconfig.json` et l'oxlint racine l'excluent pour
qu'un checkout neuf passe `bun run verify` sans elles. Il se vérifie à part, après son
`bun install` : `bun run check` (`tsc -p .` + `oxlint -c oxlint.json`, nommé ainsi pour
qu'oxlint lancé à la racine ne le découvre pas).

**Question.** Un futur front web des DevTools de luciole pourrait-il réutiliser le shell
de TanStack DevTools, donc leur bus d'événements, sans que notre conception en dépende ?

**Montage.** Le vrai `ServerEventBus` (celui que démarre leur plugin Vite : HTTP, WebSocket
`/__devtools/ws`, SSE `/__devtools/sse`) tourne dans le processus. Un pont, ce que ferait
le Server des DevTools de luciole, envoie chaque message stocké comme `tanstack-dispatch-event`
sur leur cible globale, exactement ce que fait `EventClient.emit`. Un WebSocket et un
lecteur SSE jouent leur shell navigateur. Les messages sont la session simulée
(`src/devtools/fixtures.ts`, 83 événements de tous les plugins).

## Résultats

- Les 83 messages arrivent au shell **inchangés et dans l'ordre**, par WebSocket comme par
  SSE, et se relisent avec notre `parseEvent`. Un champ de premier niveau en plus
  (`source`, le processus inspecté) traverse aussi.
- `new EventClient({ pluginId: "luciole-client" }).emit("request", p)` produit **notre**
  message (mêmes champs et valeurs ; seul l'ordre des clés diffère).
- Sens inverse : une commande `luciole-devtools:invalidate` envoyée par le shell arrive au
  pont et se valide avec `parseCommand` ; un `EventClient` de plugin `luciole-devtools`
  abonné à `invalidate` la reçoit aussi : un panneau écrit comme plugin TanStack peut
  piloter l'application.
- BigInt : TanStack encode `{ __type: "bigint", value }`, nous une chaîne. Aucun de nos
  payloads n'en contient ; à aligner seulement s'il en apparaît un.

## Conclusion

**Réaliste.** L'enveloppe `{ type: "<pluginId>:<suffixe>", pluginId, payload }` est déjà
la leur ; leur bus transporte nos messages sans adaptation. Un front web consisterait en :
un `ServerEventBus` (ou leur protocole WS/SSE, trivial) ouvert par le Server des DevTools,
alimenté par le pont ci-dessus, et des panneaux React enregistrés comme plugins dans leur
shell, abonnés par `EventClient.on("…")`.

Limites, qui ne changent pas notre conception :

- **Pas d'identité de processus** chez TanStack : un événement ne dit pas de quel processus
  il vient. Chez nous c'est la connexion (`luciole:hello`) ; le pont ajoute `source`.
- **Leur bus ne relaie pas client → clients** : un message reçu par WebSocket ne va qu'aux
  écouteurs du processus du bus (`emitToServer`). Les processus inspectés ne peuvent donc
  pas se brancher directement sur leur bus pour parler au shell : il faut le pont dans le
  processus du bus. C'est notre architecture (le Server des DevTools tient le bus).
- **Les panneaux ne se partagent pas** : leur shell est une UI navigateur, les nôtres des
  composants OpenTUI. Ce qui se partage, c'est le protocole et les modèles purs
  (`src/devtools/model/*`), écrits sans dépendance au terminal.
- Leur bus ne démarre qu'avec `NODE_ENV=development`, et écoute par défaut le port 4206
  (repli sur un port libre).
