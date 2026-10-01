# Chat — démo IA via OpenRouter

Un chat IA dans le terminal : réponses streamées token par token, rendu Markdown léger,
historique, plusieurs conversations, compteur de tokens et de coût. La clé et tous les
appels réseau restent côté Server ; le Client ne reçoit que la description du modèle et
les événements de chaque réponse.

## Lancement

Depuis la racine du monorepo (les dépendances sont `workspace:*` et `catalog:` : l'exemple
ne se lance pas depuis son propre dossier). Prérequis : Bun 1.4.2 et `bun install
--frozen-lockfile` une fois.

```sh
export OPENROUTER_API_KEY=sk-or-…          # https://openrouter.ai/keys
bun run chat
CHAT_DEMO=1 bun run chat                   # sans clé ni réseau : un modèle scripté répond
```

`bun run chat` est `luciole dev --app examples/chat`. Attendez-vous à une conversation
vide et à un champ de saisie ; sans clé ni `CHAT_DEMO`, l'écran dit qu'il manque la clé.

| Variable              | Défaut                         | Rôle                                                |
| --------------------- | ------------------------------ | --------------------------------------------------- |
| `OPENROUTER_API_KEY`  | —                              | Clé OpenRouter, lue uniquement par le Server.       |
| `OPENROUTER_MODEL`    | `deepseek/deepseek-v4.1-flash` | Tout identifiant de `GET /api/v1/models`.           |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | Autre endpoint compatible OpenAI (faux serveur).    |
| `CHAT_DEMO`           | —                              | `1` : un modèle scripté répond, sans clé ni réseau. |

Le modèle par défaut est le « flash » DeepSeek le plus récent listé par
`GET https://openrouter.ai/api/v1/models` au 23/09/2026 (0,10 $/M tokens en entrée,
0,50 $/M en sortie, 1M de contexte). Sans clé, l'écran l'indique et Entrée n'envoie rien ;
une variable invalide (`OPENROUTER_BASE_URL` qui n'est pas une URL http(s)) est nommée.

Sans clé ni réseau, `CHAT_DEMO=1` fait répondre le faux fournisseur
(`server/fake-provider.ts`) dans le Server même : la démo live de la landing, dont le Server
tourne dans la page, où aucune clé ne peut vivre. Le même fournisseur, servi en HTTP, sert
aux tests et aux captures :

```sh
bun examples/chat/scripts/fake-openrouter.ts     # affiche {"port": …}
OPENROUTER_API_KEY=sk-or-fake OPENROUTER_BASE_URL=http://127.0.0.1:<port>/api/v1 \
  bun run chat
```

Il renvoie un écho Markdown du dernier message (précédé de reasoning), puis l'usage et le
coût. La clé `sk-or-bad` est refusée (401) ; un message contenant « fail » coupe le flux.

## Clavier

| Touche                    | Action                                                            |
| ------------------------- | ----------------------------------------------------------------- |
| Entrée                    | Envoyer                                                           |
| Alt+Entrée, Ctrl+J        | Nouvelle ligne (Maj+Entrée sur les terminaux qui la transmettent) |
| Échap                     | Arrêter la réponse en cours (le texte reçu reste)                 |
| Ctrl+G                    | Relancer une réponse arrêtée ou en erreur                         |
| Ctrl+N                    | Nouvelle conversation                                             |
| Ctrl+↑ / Ctrl+↓ (ou clic) | Conversation plus récente / plus ancienne                         |
| PgUp / PgDn, molette      | Faire défiler la conversation                                     |
| Ctrl+R · Ctrl+T · Ctrl+C  | Rafraîchir · requêtes (DebugOverlay) · quitter                    |

L'aide en bas d'écran est générée depuis les raccourcis actifs, comme dans Forge.

## Fonctionnement

- `app/page.tsx` (Server) décrit la configuration : modèle, prix et contexte lus dans
  `/models` (mis en cache), présence de la clé — jamais sa valeur. `app/loading.tsx`
  garde la même géométrie pendant cette recherche.
- `actions/chat.ts` expose `reply(history)`, une Server Function génératrice validée par
  Zod. `server/openrouter.ts` appelle `/chat/completions` en `stream: true`, lit le SSE et
  produit des `ChatEvent` (`start`, `reasoning`, `text`, `usage`, `error`), regroupés par
  lecture réseau. Aucune erreur n'est levée : un 401, 402, 429, une coupure en cours de
  flux ou un endpoint injoignable devient un message lisible.
- Côté Client, `components/ReplyStream.tsx` s'abonne avec `useLive` (comme les logs CI de
  Forge) et verse les événements dans `components/conversations.ts`, un store au-dessus
  des routes. Échap démonte l'abonnement : le générateur Server se ferme et interrompt la
  requête OpenRouter. Une réponse continue de streamer si l'on change de conversation.
- Le coût vient de `usage.cost` d'OpenRouter ; à défaut il est estimé depuis le prix
  catalogue et préfixé de `≈`.
- Le champ de saisie est nommé (`chat/prompt`) : un texte non envoyé doit revenir après
  un crash ou un rebuild (mécanisme du framework, non rejoué par le script PTY) ; il est
  oublié dès l'envoi.

## Vérification

```sh
tsc --noEmit -p examples/chat && oxlint --deny-warnings examples/chat && oxfmt --check examples/chat
bun run test:pty:chat
```

`scripts/pty/chat.ts` lance `luciole dev` dans un PTY contre le faux serveur : message sans
clé, réponse streamée et rendue en Markdown, usage et coût, historique renvoyé au modèle,
Échap qui interrompt la requête amont, Ctrl+G, erreur en cours de flux, Ctrl+N et
Ctrl+↓, sortie propre du terminal. Il écrit le dernier écran dans `pty-frame.txt`.

## Limites

- Le flux réel d'OpenRouter n'a pas été exercé faute de clé : seuls `/models` et le refus
  d'une clé invalide (401) ont été vérifiés contre l'API réelle, le reste contre le faux
  serveur qui suit le format OpenAI/OpenRouter.
- Les conversations vivent en mémoire du Client : Ctrl+C, un crash ou un rebuild de
  `luciole dev` les perdent (seul le texte en cours de saisie est restauré).
- Pas de copie presse-papiers, d'édition d'un message envoyé ni de choix du modèle depuis
  l'interface. Le reasoning n'est montré (en gris, une ligne) que tant qu'aucun texte n'est
  arrivé.
- Une annulation n'atteint OpenRouter qu'au chunk suivant : un générateur async ne peut
  pas être interrompu pendant un `await` réseau.
- La hauteur du champ de saisie estime les retours à la ligne ; au-delà de six lignes il
  défile.

### Points relevés sur le framework

- Le `textarea` d'OpenTUI émet son changement de contenu **après** `onSubmit` quand
  Entrée arrive dans la même lecture que la frappe (frappe rapide, collage) : l'état
  contrôlé de `<Textarea>` est alors en retard. L'exemple lit `plainText` du renderable au
  submit et le vide directement (`components/Chat.tsx`). Un helper du framework pour ce
  cas éviterait de le redécouvrir.
- Pendant un rebuild de `luciole dev`, un répertoire de staging `examples/<app>/.luciole-<uuid>/`
  existe brièvement ; ni `.gitignore` ni `oxlint` ne l'ignorent, donc un `oxlint` lancé à
  ce moment échoue sur le bundle généré.
