# luciole-pty

The macOS PTY launcher attaches fd 0 as the controlling terminal, then runs the
command with `execvp`. It does not fork. The command keeps its pid, environment,
arguments and file descriptors, including Bun's IPC channel.

Bun 1.4.x does not attach a preallocated `Bun.Terminal` to the child's session.
`spawnPty` uses this helper on macOS so that the kernel sends SIGWINCH and SIGINT
to the foreground process group. Linux still uses `setsid -c`.

## Build

Run from the repository root on macOS with Xcode command line tools:

```sh
bun scripts/build-pty.ts
bun scripts/build-pty.ts --check
```

The binary contains arm64 and x86_64 code. Its minimum macOS version is 13.0.
This is the `LC_BUILD_VERSION` minimum of the official Bun 1.4.x runtime that
luciole uses (`packages/core/src/compile.ts`). The core package requires Bun
1.4.1 or later. Check the runtime with `otool -l <bun>`.

The committed build uses Apple clang 21.0.0 (clang-2100.3.34.2), from the macOS
27.0 SDK. The linker UUID is disabled. With this toolchain, fresh builds in
different directories have the same bytes, including the ad hoc signature.
`--check` compares the SHA-256 of the full rebuilt binary and the committed
binary with `dist/SHA256SUMS`. It does not strip or normalize either file.
A different compiler or SDK can change the bytes. Use the recorded toolchain
to check this build, or rebuild and review the binary and checksum together.

The npm package includes `dist/`. A compiled macOS Client or app includes a copy
at `native/luciole-pty` next to its binary. The desktop build copies this directory
into the bundle and signs the helper before it signs the bundle. Users do not
need a compiler.
