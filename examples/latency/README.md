# Latency — saisie locale, serveur lent

Un terrain de jeu minuscule pour sentir l'effet de la latence : un champ de saisie, une
zone survolable et une liste défilante restent **locaux** (aucune requête), pendant qu'une
Server Function (`ping`) répond après le délai simulé. Tant que le Server n'a pas répondu,
on peut continuer à taper, défiler et survoler sans à-coup.

## Lancement

Depuis la racine du monorepo (les dépendances sont `workspace:*` et `catalog:` : l'exemple
ne se lance pas depuis son propre dossier) :

```sh
bun install --frozen-lockfile    # une fois, Bun 1.4.2
LUCIOLE_LATENCY_MS=500 bun packages/core/src/cli.ts dev --app examples/latency
```

Il n'y a pas de script `bun run` pour cet exemple. Aucune clé API, aucun réseau. Sans
`LUCIOLE_LATENCY_MS` (défaut `0`), la réponse est immédiate : le réglage est le but.

## Ce qu'on voit

- Un champ « Type here; Enter calls the Server » : Entrée envoie la requête, la ligne
  dessous affiche « Waiting for Server… » puis « Server replied in N ms » (N ≈ la latence
  choisie, aller-retour compris).
- Le texte tapé est repris en bas (`Input: …`) sans attendre le Server.
- Un cadre qui s'allume au survol et une liste de 100 lignes qui défile à la molette.

`Ctrl+C` quitte.
