# Sonde locale React / OpenTUI + processus métier

Exécutée le 22 septembre 2026 sur macOS, Bun 1.4.2, OpenTUI 0.5.12 et React 19.3.0.
Installer les dépendances avec `bun install`, puis `bun run probe` depuis ce dossier.
On peut copier le dossier dans `/tmp` pour garder les dépendances hors du dépôt.

La sonde utilise le vrai renderer de test natif OpenTUI avec React et des entrées
clavier simulées. Le processus métier distinct reçoit une valeur en JSONL sur
stdin, signale qu'il commence, bloque son propre thread pendant 400 ms, puis
retourne une normalisation en majuscules. Aucun réseau ni RSC n'est utilisé.
Les numéros de processus sont comparés par assertion, sans être persistés.

Assertions :

- Saisir `abc`, lancer une requête métier, puis saisir `d` affiche `abcd` pendant
  le travail distant simulé ; un update React conserve le même InputRenderable.
- Appliquer naïvement le résultat `ABC` au state React écrase `abcd`.
- Avec une révision locale capturée à l'envoi, le même résultat ne remplace pas
  la saisie plus récente. La sonde ne traite ni Baseline ni version métier.
- Après arrêt du processus métier, la frappe de `e` fonctionne encore.
- Un calcul synchrone de 150 ms dans le processus Client retarde un timer local.

`results.json` contient la dernière exécution. Les durées sont des observations
ponctuelles headless, pas des percentiles, ni une mesure de latence physique,
ni un comparatif de performances avec TWP. La sonde ne couvre pas le WAN,
l'authentification, les retries, une sauvegarde durable, l'undo, les changements
d'identité, le redémarrage Client ou la reconnexion.
