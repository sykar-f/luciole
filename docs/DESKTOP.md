# Mode desktop

Une application airtty peut remplir une fenêtre à elle, comme une app de bureau, plutôt
qu'un onglet de terminal. L'hôte (la fenêtre) lance le binaire de l'app sur un PTY et en
affiche l'écran ; le Client, lui, sait qu'il n'est plus dans un terminal partagé.

## Le contrat : `AIRTTY_DESKTOP=1`

L'hôte pose `AIRTTY_DESKTOP=1` dans l'environnement du binaire. Le lanceur (binaire
à deux rôles, [DISTRIBUTION.md](DISTRIBUTION.md)) la transmet au Client, et le Client
générique à ses onglets sandboxés. Sous cette variable :

| Geste                             | Terminal                      | Fenêtre desktop                                      |
| --------------------------------- | ----------------------------- | ---------------------------------------------------- |
| Ctrl+C                            | Quitte (session supprimée)    | Touche de l'application, comme une autre             |
| Terminal / fenêtre fermé (SIGHUP) | Interruption : session gardée | Sortie volontaire : session supprimée, Server quitté |
| SIGTERM, SIGINT (arrêt, `kill`)   | Interruption : session gardée | Interruption : session gardée                        |
| `app.quit()`                      | Sortie volontaire             | Sortie volontaire                                    |

Dans un terminal, le fermer n'est pas quitter l'application : l'utilisateur ferme un
onglet, l'app reprend où elle en était au prochain lancement. Une fenêtre desktop _est_
l'application : la fermer (ou Cmd+Q) raccroche son PTY, et c'est le quit de
l'utilisateur. Le Server local s'arrête alors aussitôt au lieu d'attendre son délai de
grâce (`POST /lifetime/leave`, `src/launcher/lifetime.ts`).

Aucun protocole propre à l'hôte : un hangup de PTY est ce que tout émulateur fait en
fermant une fenêtre, donc le contrat vaut pour n'importe quel hôte (Electrobun, WezTerm
ou Ghostty en kiosque, app native). Limite : un hôte qui plante raccroche aussi le PTY,
et la session est alors oubliée comme après un quit.

Côté code, `run()` lit la variable et crée l'Application avec `quitOnCtrlC: false`
(`ApplicationOptions`) ; `Runtime` ne déclare alors plus `ctrl+c`, et la barre d'aide
générée ne l'affiche plus. Un hôte qui ouvre des panes (`openApplication`) leur passe la
même option.
