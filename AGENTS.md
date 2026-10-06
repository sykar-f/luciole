# AGENTS.md

## Release

Publier une version ou une préversion sur npm : suivre `docs/RELEASING.md`.
`bun run release <version>` prépare les fichiers ; un suffixe (`0.2.0-rc.1`) part sur le
dist-tag `next`, sans suffixe sur `latest`.

Le tag `v<version>` et l'approbation de l'environnement GitHub `npm` appartiennent au
propriétaire : préparer la version, la mener jusqu'à une CI verte sur `main`, puis lui rendre
la main avec la commande de tag à lancer.
