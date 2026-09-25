# airtty-sandbox

Le lanceur Linux du mode `sandbox` d'airtty ([EMBEDDING.md](../../docs/EMBEDDING.md),
décision 6 et étape 8). L'hôte (`src/sandbox/linux.ts`) le démarre sur le PTY d'un widget
VT :

```sh
airtty-sandbox --policy '<json>' -- /chemin/absolu/bun child.js …   # confine, puis exec
airtty-sandbox --probe                                             # ce que ce système permet
```

La politique est du JSON structuré (`src/policy.rs`, champs inconnus refusés, chemins
absolus sans `.`/`..`), validé aussi côté hôte ; rien ne passe par un shell. Dans l'ordre :
espaces de noms (utilisateur, montage, IPC, réseau ; PID dans un processus intermédiaire),
relais TCP → socket Unix de l'hôte, Landlock (appels système directs, droits selon l'ABI),
seccomp (`seccompiler`), puis `execv`. Avec espaces de noms ou relais, le parent reste
superviseur : il relaie, transmet les signaux et sort comme l'enfant.

## Construire

Les binaires livrés sont dans `dist/linux-{x64,arm64}/` (statiques, musl : ils tournent
sur glibc comme sur musl), avec `dist/SHA256SUMS`, vérifié par airtty avant usage.

```sh
bun scripts/build-sandbox.ts            # reconstruit les deux, met à jour SHA256SUMS
bun scripts/build-sandbox.ts --check    # reconstruit à part et compare (CI)
```

Reproductible : image `rust:1.95.0-alpine3.22` épinglée par digest de manifeste par
plateforme, `Cargo.lock` (`--locked`), dépendances épinglées (`libc`, `seccompiler`,
`serde`, `serde_json`), chemins du conteneur retirés (`--remap-path-prefix`). L'autre
architecture tourne émulée.

## Tester

```sh
bun scripts/linux-sandbox.ts [--arch arm64|x64] [--only userns|bwrap|landlock]
```

Conteneurs Debian avec Bun, bubblewrap et pyte : `tests/sandbox.test.ts` et
`scripts/pty-sandbox.py` par mécanisme, puis `cargo test`. L'émulation x86_64 d'une
machine arm64 (Rosetta) n'a ni Landlock ni les appels de montage dont bubblewrap a besoin :
x64 se teste sur une machine x64 (le job CI `linux-sandbox`).
