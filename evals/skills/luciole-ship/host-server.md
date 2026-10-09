---
expect-skill: luciole-ship
checks:
  - match:
      file: deploy/build.sh
      pattern: --target[ =]bun-linux-x64(?!-musl)
  - match:
      file: deploy/build.sh
      pattern: --native-dir
  - match:
      file: deploy/notes.service
      pattern: ^ExecStart=\S+ serve --http (127\.0\.0\.1)?:\d+
  - match:
      file: deploy/notes.service
      pattern: (EnvironmentFile=|LUCIOLE_TOKEN)
  - match:
      file: deploy/Caddyfile
      pattern: reverse_proxy (127\.0\.0\.1|localhost):\d+
  - run: bun run verify
---

Use the luciole-ship skill to prepare hosting this app's Server on our Debian machine (x86_64,
systemd), behind Caddy at notes.example.com, for users who connect from their own machines.
Write `deploy/build.sh` with the commands that build what the Server's machine runs, from this
directory; `deploy/notes.service`, the systemd unit; and `deploy/Caddyfile`. Do not deploy and do
not connect to any other machine. Keep `bun run verify` passing.
