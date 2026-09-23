# Client autonome via `bun build --compile`

Exécuté le 23 septembre 2026 sur macOS arm64, Bun 1.4.2, OpenTUI 0.5.12.
Question : le Client de production peut-il être livré en un seul exécutable,
lancé sur une machine sans Bun ni `node_modules` ? **Oui** pour darwin-arm64.
Le test lance le binaire dans un PTY, avec l'application Notes.

## Chargement natif d'OpenTUI

`@opentui/core` (`chunk-bun-*.js`, `resolveNativeLibraryPath`) fait
`await import("@opentui/core-<os>-<arch>")`. L'entrée `bun` de ce paquet contient
`import("./libopentui.dylib", { with: { type: "file" } })`. Le bundler embarque
donc la bibliothèque. Bun remplace `process.platform` et `process.arch` par des
constantes de la cible et supprime les branches des autres plateformes. Au
lancement, Bun extrait la dylib dans `$TMPDIR/.bun-<uid>-<hash>.dylib`, puis
`dlopen` la charge (vérifié avec `lsof`). Les autres ressources passent aussi par
`with { type: "file" }` : `parser.worker.js`, `tree-sitter.wasm`, grammaires
`.wasm` et `.scm`. `OTUI_ASSET_ROOT` peut rediriger ces ressources, mais ce n'est
pas nécessaire.

## Commandes

```sh
bun run build                                   # racine : produit .airtty/client/index.js
cd probes/compile
bun install --os='*' --cpu='*'                  # paquets natifs Linux (cross-compilation)
bun compile.ts                                  # → .out/notes-client-darwin-arm64
bun compile.ts --target bun-linux-x64           # idem linux-x64, linux-arm64
bun compile.ts --runtime host                   # utilise le bun local au lieu du runtime npm
./smoke.sh .out/notes-client-darwin-arm64 http://127.0.0.1:<port>
bun compile.ts --entry treesitter.ts --out .out/ts   # worker + wasm tree-sitter
```

Pour lancer le Server : `cd examples/notes/.airtty/server && NOTES_DB=$(mktemp -d)/n.sqlite PORT=0 bun --conditions=react-server index.js`.
`smoke.sh` copie le binaire dans un `mktemp -d` sous `/private/tmp`, sans
`node_modules` dans les dossiers parents. Il utilise `env -i` avec
`PATH=/usr/bin:/bin`, donc sans Bun, puis lance `script`. Il envoie `Enter`, puis
`Ctrl+C`.

## Résultats

| Essai                                                                       | Résultat                                                                                                            |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| CLI `bun build --compile --target=bun-darwin-arm64 .airtty/client/index.js` | OK en 0,3 s : 40 modules, sans plugin ni option                                                                     |
| Binaire darwin-arm64, dossier vide, sans Bun                                | Rendu `NOTES · Connected`, liste, `Enter` → `Opening note 1…`, éditeur `First note · version 1` ; `Ctrl+C` → code 0 |
| Binaire compilé avant un rebuild du Server                                  | `Incompatible build: install matching Client and Server` (409). Le buildId est figé dans le binaire                 |
| `treesitter.ts` compilé (worker `parser.worker.js`, wasm)                   | `{"highlights":10,"error":null}`, code 0. Cache écrit dans `$HOME/.local/share/opentui/tree-sitter`                 |
| Entrée wrapper `import ".../client/index.js"` (`wrapper.ts`)                | Sortie vide, code 0 : `import.meta.main` vaut `false` et `run` n'est pas exporté                                    |
| `--target=bun-linux-x64` depuis la racine                                   | Échec : `error: Could not resolve: "@opentui/core-linux-x64". Maybe you need to "bun install"?` (idem `-musl`)      |
| `compile.ts --target bun-linux-x64` / `bun-linux-arm64`                     | ELF produit, une seule `libopentui.so` embarquée. **Non exécuté** : aucun daemon Docker actif                       |
| `compile.ts --target bun-linux-x64-musl`                                    | Échec attendu, `@opentui/core-linux-x64-musl` n'est pas installé                                                    |

Tailles : darwin-arm64 71,5 Mio (runtime Bun 59 Mio + dylib 5,3 Mio + ressources
tree-sitter 3,3 Mio + JS), linux-x64 90,3 Mio, linux-arm64 89,9 Mio.

## Pièges

1. **Le runtime copié est celui du `bun` local.** Pour la cible hôte, `--compile`
   copie l'exécutable courant. Ici, Bun vient de Nix : `otool -L` du binaire
   montre `/nix/store/…-ICU-76142.4.7/lib/libicucore.A.dylib`. Ce binaire ne peut
   pas démarrer sur un Mac sans ce chemin. Un suffixe de version
   (`bun-darwin-arm64-v1.4.2`) ne change rien. La correction passe par
   `executablePath` : `compile.ts` télécharge
   `@oven/bun-darwin-aarch64@<Bun.version>` depuis npm. Le binaire lie alors
   `/usr/lib/libicucore.A.dylib`. Homebrew pose peut-être le même problème ;
   ce n'est pas vérifié. `airtty build --compile` embarque désormais ce runtime
   par défaut (mis en cache, `--runtime host` pour revenir au Bun local).
2. **Cross-compilation** : le paquet `@opentui/core-<os>-<arch>` de la cible doit
   être présent. Un plugin `onResolve` le résout depuis un dossier installé avec
   `bun install --os --cpu`.
3. **glibc/musl** : OpenTUI lit `OPENTUI_LIBC` à l'exécution. Sans `define`, les
   deux paquets Linux sont exigés. `define: {"process.env.OPENTUI_LIBC": '""'}`
   (ou `'"musl"'`) supprime la branche inutile.
4. **L'entrée doit être le bundle lui-même** : un wrapper n'exécute rien.
5. `autoloadDotenv` et `autoloadBunfig` valent `true` par défaut. Le binaire lirait
   alors `.env` et `bunfig.toml` depuis le cwd de l'utilisateur. `compile.ts` les
   désactive.
6. La signature est ad hoc (`flags=0x20002(adhoc,linker-signed)`). Pour un
   binaire téléchargé, Gatekeeper exigera Developer ID et notarisation (non testé).
   `$TMPDIR` doit être accessible en écriture pour extraire la dylib ; un `/tmp`
   `noexec` sous Linux reste à vérifier.

## Mécanisme recommandé : `airtty build --compile [--target …]`

Après `build()`, compiler `.airtty/client/index.js` tel quel. Les externals se
résolvent alors depuis les `node_modules` de l'application :

```ts
await Bun.build({
  entrypoints: [join(output, "client/index.js")],
  compile: {
    target,
    outfile,
    executablePath: await officialRuntime(target),
    autoloadDotenv: false,
    autoloadBunfig: false,
  },
  define: os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(musl ? "musl" : "") } : {},
  plugins: [
    {
      name: "opentui-native-target",
      setup(b) {
        b.onResolve({ filter: /^@opentui\/core-(darwin|linux|win32)-/ }, (a) => ({
          path: Bun.resolveSync(a.path, nativePackagesDir),
        }));
      },
    },
  ],
});
```

Livrer le binaire et le Server du même build : leurs buildId doivent correspondre.
