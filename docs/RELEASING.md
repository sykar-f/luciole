# Publier une version

Cinq paquets partent sur npm, ensemble, à la même version. **Rien n'est publié tant que le
propriétaire n'a pas poussé un tag `v<version>` et approuvé l'environnement GitHub `npm`** :
préparer une version, la vérifier à blanc ou fusionner du code ne publie jamais.

| Paquet                        | Dossier                    | Rôle                                          |
| ----------------------------- | -------------------------- | --------------------------------------------- |
| `@luciole-sh/core`            | `packages/core`            | le framework et les CLI `luciole`, `luciolex` |
| `@luciole-sh/flow-graph`      | `packages/flow-graph`      | graphes de nœuds                              |
| `@luciole-sh/markdown-editor` | `packages/markdown-editor` | éditeur Markdown WYSIWYG                      |
| `@luciole-sh/create`          | `packages/create`          | `bunx @luciole-sh/create my-app`              |
| `luciole.sh`                  | `packages/luciole.sh`      | nom d'installation : `bunx luciole.sh init`   |

`@luciole-sh/harness` et `@luciole-sh/desktop` restent `private: true` et ne partent jamais.
Les exemples ne sont pas publiés : ils tournent depuis git, au tag `v<version>`
(`luciole example <nom>`).

## Versions

Les cinq paquets partagent **une seule version** (lockstep), et le tag est `v<version>` :
`v0.2.0` publie `0.2.0`. Un tag `v1.0.0-rc.1` est une préversion, publiée sous le dist-tag
`next` au lieu de `latest`.

Le workflow compare le tag à la `version` de chaque `package.json` publiable avant toute
publication ; un écart (ou un paquet `private`) arrête la release sans rien publier.
`luciole.sh` dépend de `@luciole-sh/core` par `workspace:*`, que `bun pm pack` remplace par
la version du dépôt.

## Les garde-fous

Les mêmes vérifications tournent sur chaque push (job `publishable` de `ci.yml`, Linux) et
avant la publication (job `verify` de `release.yml`) :

- `bun scripts/pack-check.ts <les cinq dossiers>` : chaque paquet se range en tarball, sans
  spec `workspace:` ni `catalog:`, sans test ni fichier hors de `files`, toutes ses cibles
  d'`exports` et de `bin` présentes ; le tarball s'installe dans un projet vierge (avec les
  tarballs des paquets du dépôt dont il dépend) et chaque export s'importe sous node (sauf
  paquets Bun seul) et sous bun ;
- `bun run licenses` : aucune licence bloquante (GPL, AGPL, SSPL, absente) dans l'arbre
  de production des cinq paquets ;
- `bun publish --dry-run` dans chaque dossier. Sans jeton npm, bun s'arrête sur « missing
  authentication » avant le dry-run : les étapes posent un `NPM_CONFIG_TOKEN` factice, qui
  n'est pas un identifiant et ne peut rien publier.

Les listes de paquets de `ci.yml` et de `release.yml` sont écrites à la main : en changer
une, c'est changer l'autre. L'ordre de `release.yml` est celui des dépendances (`core`
avant `luciole.sh`).

## Réglages à faire une fois, avant la première release

Par le propriétaire, sur GitHub et npm ; aucune session de développement ne les fait.

1. **Environnement `npm`** : Settings → Environments → New environment, nommé `npm`, avec des
   _required reviewers_. C'est lui qui arrête un tag poussé par erreur : le job `publish`
   attend l'approbation d'un relecteur. Sans relecteurs, il part tout seul.
2. **Authentification npm**, au choix :
   - un secret `NPM_TOKEN` de l'environnement `npm` (jeton _granular_ ou _automation_ de
     l'organisation `luciole-sh`, droit d'écriture sur ces paquets), lu comme
     `NODE_AUTH_TOKEN` ;
   - ou la _trusted publishing_ de npm (OIDC, sans jeton) : sur npmjs.com, par paquet,
     Settings → Trusted Publisher → GitHub Actions, dépôt `sykar-f/luciole`, workflow
     `release.yml`, environnement `npm`. Elle demande npm ≥ 11.5.1, que le workflow installe
     déjà. Une fois configurée, retirer le secret `NPM_TOKEN` et, dans l'étape
     « Publish in dependency order » de `release.yml`, **les deux** endroits qui le portent :
     le bloc `env:` (`NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`) et la ligne `echo` qui écrit
     `//registry.npmjs.org/:_authToken=…` dans `$HOME/.npmrc`. Retirer le seul `env:` laisserait
     un `.npmrc` au jeton vide, qui fait échouer la publication en 401 au lieu de laisser
     npm passer par OIDC.
3. Les paquets sont publiés `--access public` avec la provenance npm (`id-token: write`,
   npm ≥ 9.5). Bun 1.4.2 n'a pas d'option de provenance : `bun pm pack` fabrique le tarball
   que `pack-check` a éprouvé, `npm publish <tarball> --provenance` le publie.

## Couper une release

1. Sur `main`, à jour et vert, mettre la même `version` dans les cinq `package.json`
   publiables et, dans le même commit, passer les liens `blob/v<ancienne>/…` de
   `packages/markdown-editor/README.md` à `blob/v<version>/…`, parce que ce README part dans
   le tarball et doit pointer vers le tag qui contient les fichiers qu'il cite
   (`tests/source-links.test.ts` échoue tant que ce tag et la `version` du paquet diffèrent) ;
   la fusionner par le circuit habituel.
2. Répéter à blanc (ci-dessous) sur ce commit.
3. **Documentation.** Sur ce même commit, avant le tag :
   - relire `/status/` (`website/src/pages/status.astro`) ligne à ligne contre le code et la CI,
     puis mettre à jour sa date et sa révision (`CHECKED`) : la révision doit être celle qui
     sera taguée ou un de ses ancêtres ;
   - mettre à jour la version partout où la documentation la cite (README, `CHANGELOG.md`,
     `SECURITY.md`, site), et la date de l'entrée du `CHANGELOG.md` au jour du tag ;
   - après la publication, faire le test de fumée de l'étape 7 (`bunx luciole.sh@<version> init`).
4. Pousser le tag, de ce commit-là seulement :

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

5. Le workflow `Release` démarre : `verify` (tag, pack-check, licences, dry-run), puis
   `publish` attend l'approbation de l'environnement `npm`. Relire la sortie de `verify`,
   approuver.
6. `publish` publie dans l'ordre des dépendances, avec provenance. Un paquet déjà présent
   au registre à cette version est sauté : si un paquet échoue, corriger la cause et relancer
   le workflow (Re-run failed jobs) reprend où il s'était arrêté. Une version publiée ne
   se republie pas : si le tarball lui-même est faux, la suite est une nouvelle version.
7. **Test de fumée de la documentation.** Dans un dossier vide, avec la version publiée :

   ```sh
   bunx luciole.sh@<version> init my-app
   cd my-app && bun install && bun run dev
   ```

   C'est le chemin du README et de _Getting started_ sur luciole.sh/docs. S'il échoue, la
   documentation ment : le corriger avant d'annoncer la version.

## Répéter à blanc

- **En local**, depuis la racine, après `bun install --frozen-lockfile` :

  ```sh
  bun scripts/pack-check.ts packages/core packages/flow-graph packages/markdown-editor \
    packages/create packages/luciole.sh
  bun run licenses
  for d in core flow-graph markdown-editor create luciole.sh; do
    (cd packages/$d && NPM_CONFIG_TOKEN=dry-run-placeholder bun publish --dry-run)
  done
  ```

- **Sur GitHub**, Actions → Release → _Run workflow_ : l'entrée `dry-run` vaut `true` par
  défaut et le job `publish` ne démarre pas. Lancé depuis une branche, il prend la version
  de `packages/core` et vérifie que les quatre autres la partagent.

Seul un tag ET `dry-run` décoché lancent `publish`, et il attend alors l'environnement `npm`.
