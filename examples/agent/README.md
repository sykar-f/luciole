# Agent : une UI d'agent de code dans le terminal

Interface minimale pour [pi](https://github.com/earendil-works/pi) : conversation,
texte streamé, appels d'outils (`read`, `bash`, `edit`, `write`) avec arguments et
résultats repliables, état en cours/idle, interruption et nouvelle session.

```sh
bun src/cli.ts dev --app examples/agent
```

Prérequis : le CLI `pi` (v0.85) dans le `PATH` et le provider `openai-codex` connecté
(`~/.pi/agent/auth.json`, abonnement ChatGPT). Chaque prompt consomme ce quota.

## Clavier

| Touche             | Effet                                                                          |
| ------------------ | ------------------------------------------------------------------------------ |
| Entrée             | Envoie le prompt ; pendant un travail, l'envoie en _steering_ (tour suivant)   |
| Ctrl+X             | Interrompt l'agent (vide aussi les messages en attente)                        |
| Ctrl+N (deux fois) | Nouvelle session ; l'ancienne reste dans l'historique de pi                    |
| Échap              | Parcourt les appels d'outils et réflexions (le prompt perd le focus)           |
| `j` `k` / ↑ ↓      | Sélectionne un appel ; Entrée ou Espace le plie/déplie, `a` plie/déplie tout   |
| `i` ou Échap       | Revient au prompt                                                              |
| Page ↑ / Page ↓    | Fait défiler la conversation (la molette aussi) ; un clic sur un appel le plie |
| Ctrl+R             | Rafraîchit ; rouvre le flux live s'il a été coupé                              |
| Ctrl+C             | Quitte                                                                         |

Comme dans Forge, les lettres appartiennent au texte tant que le prompt a le focus :
elles ne deviennent des commandes qu'en mode parcours. L'aide en bas de l'écran est
générée depuis les raccourcis actifs.

## Configuration

| Variable         | Défaut                                     | Rôle                                                             |
| ---------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| `AGENT_MODEL`    | `openai-codex/gpt-5.6-terra`               | Modèle pi ; sans `provider/`, `openai-codex/` est ajouté         |
| `AGENT_THINKING` | `low`                                      | `off` … `max`                                                    |
| `AGENT_CWD`      | `$TMPDIR/airtty-agent-sandbox`             | Répertoire de travail de l'agent (créé au besoin), pas le dépôt  |
| `AGENT_PI`       | `pi`                                       | Exécutable pi                                                    |
| sessions pi      | `$XDG_STATE_HOME/airtty/agent/pi-sessions` | Historique des conversations, repris au démarrage (`--continue`) |

**Pourquoi Terra.** Des trois variantes de GPT-5.6, Sol est la plus grande et la plus
lente, Luna la plus petite (tarifs API indicatifs : Sol 4/20 $, Terra 2/12 $, Luna
0,2/1,2 $ par million de tokens en entrée/sortie). Un agent de code enchaîne des
appels d'outils sur plusieurs tours : Terra les suit de façon fiable, reste réactive
et, sur l'abonnement, consomme moins de quota que Sol. Avec `low`, un tour court
répond en quelques secondes. `AGENT_MODEL=gpt-5.6-sol` pour les tâches difficiles,
`gpt-5.6-luna` pour des essais rapides.

## Fonctionnement

- `server/pi.ts` lance `pi --mode rpc` dans `AGENT_CWD` (JSON par ligne sur
  stdin/stdout, réponses corrélées par `id`) ; `server/protocol.ts` valide chaque ligne
  avec Zod. Extensions, skills et prompt templates sont désactivés ; seuls les quatre
  outils de base sont actifs. Une demande de dialogue d'extension est refusée.
- `server/transcript.ts` réduit les événements (`message_update`, `tool_execution_*`…)
  en blocs ; `server/agent.ts` tient l'unique agent du Server, le (re)démarre au
  besoin et publie un instantané à chaque changement (au plus un toutes les 50 ms).
- `actions/agent.ts` expose `sendPrompt`, `abort`, `newSession` et `feed`, un flux live
  lu par `useLive` : l'écran reçoit l'instantané courant puis chaque mise à jour.
  `feed` renvoie un itérateur écrit à la main plutôt qu'un générateur : quand le Client
  part, Flight appelle `throw()` pendant que l'abonné attend un changement qui peut ne
  jamais venir, et seul un itérateur peut interrompre cette attente.
- Au démarrage, pi reprend la dernière session de `AGENT_CWD` et la conversation est
  reconstruite depuis `get_messages` : un rebuild de `airtty dev` la conserve.
- Le prompt est un champ nommé (`agent/prompt`) : un texte tapé revient après un crash
  du Client ; il est oublié pendant l'envoi et remis dans le champ si l'envoi échoue.

## Vérification

```sh
tsc --noEmit -p examples/agent
oxlint --deny-warnings examples/agent
oxfmt --check examples/agent
python scripts/pty-agent.py   # vrai pi, vrai modèle : consomme un peu de quota
```

Le parcours PTY lance `airtty dev` avec un sandbox et un état temporaires, envoie un
prompt qui appelle `write` puis `bash`, vérifie le fichier créé, déplie les appels,
interrompt un `sleep 30` en cours, démarre une nouvelle session, quitte, et contrôle
que le terminal est restauré et qu'aucun processus pi ne survit.

## Limites

- **`AGENT_CWD` n'est pas un bac à sable** : `bash` peut lire et écrire hors de ce
  répertoire, avec les droits de l'utilisateur. Aucune confirmation avant une commande.
- Un seul agent par Server : plusieurs Clients voient et pilotent la même conversation.
- Chaque instantané contient toute la conversation (400 derniers blocs, sorties d'outil
  tronquées au milieu au-delà de 12 000 caractères) : simple et robuste à une
  reconnexion, mais coûteux pour de très longues sessions.
- Texte brut : pas de rendu Markdown (le composant `<markdown>` d'OpenTUI dépend de
  tree-sitter, non essayé ici). Prompt sur une ligne, pas d'images.
- Une nouvelle session sans réponse du modèle n'est pas écrite par pi : après un
  redémarrage du Server, `--continue` rouvre la session précédente.
- Le coût affiché par pi est un tarif API ; sur l'abonnement, seuls les tokens sont
  montrés.
- Framework : aucun blocage rencontré. À noter (lu dans le code de Flight, non mesuré) :
  un générateur `async function*` qui attend sans fin ne se ferme pas au départ du
  Client, car le `throw()` de Flight reste en file jusqu'au prochain `yield` ; d'où
  l'itérateur manuel.
