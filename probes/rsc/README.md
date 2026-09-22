# Prototype Flight → React → OpenTUI

Exécuté avec succès le 22 septembre 2026 dans
`/private/tmp/twp-opentui-rsc-probe`, Bun 1.4.2.

Pour reproduire dans un dossier isolé : copier ces fichiers, puis exécuter
`bun install --frozen-lockfile` et `bun probe.tsx` depuis ce dossier.

Versions : OpenTUI Core/React 0.5.12 ; React/Flight 19.3.0. Le lockfile fixe
les dépendances transitives. Le serveur est un processus séparé utilisant la
condition `react-server`. Il ne charge pas OpenTUI. Il envoie un arbre Flight
contenant une référence vers un composant Client.

Assertions : montage d'un arbre Flight dans OpenTUI ; résolution d'une Client
Reference ; saisie locale ; affichage d'une deuxième révision serveur ;
préservation de l'instance input et du Draft ; nouvelle saisie après refresh.

Limites : manifests manuels ; shim Webpack limité à un module ; zéro compilation
de directives ; pas de Server Function ; pas de transport WAN, reconnexion ou
latence artificielle. Les Server Components s'exécutent réellement côté Server
et le composant avec `useState` réellement côté Client. Le test headless prouve
les assertions listées, pas la qualité de rendu dans tous les terminaux.

Le shell React est monté une fois. Les nouveaux arbres y entrent via son état,
pour ne pas dépendre de la sémantique des appels répétés à OpenTUI `root.render`.

`results.json` contient la sortie observée. La capture est prise avant la
dernière frappe ; l'assertion de dernière frappe vérifie directement `field.value`.
