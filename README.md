# Engram

**One shared, encrypted memory for every AI agent.**

Engram is a zero-dependency, cross-agent shared-memory daemon. Any AI agent,
CLI tool, or mobile device on your network can read and write the same
encrypted memory over a tiny HTTP API:

- **Shared memory** — agents (Claude Code, Cursor, Copilot, engram CLI, …) all
  access the same store via `localhost`.
- **Encrypted at rest** — AES-256-GCM (scrypt key derivation). Optional
  unlock password; plaintext fallback for quick local use.
- **Session-aware** — each agent session is stored exactly once; re-sending the
  same session updates that record in place. End a session to delete it wholly.
- **Mobile access** — pair your phone via a 6-digit code (`/m`), no VPN needed.
- **Dedupes** — session identity first, then text-similarity (4-gram Jaccard).
- **Port-claim behavior** — `--claim kill|shift|refuse` decides what happens
  when another process already owns the port.
- **Zero dependencies** — stdlib only. `npm audit` has nothing to scan.

## Requirements

- Node.js **>= 18** (no other dependencies, no `npm install` needed).

## Quick start

```sh
# Run the daemon (binds 127.0.0.1:8040 by default)
node bin/engramd.js

# In another terminal, talk to it
node bin/engram.js remember "the deploy key is in the vault" --project p
node bin/engram.js recall "deploy key" --project p
node bin/engram.js list --project p
node bin/engram.js export --project p
```

Open http://127.0.0.1:8040 for the dashboard, or http://127.0.0.1:8040/m on
your phone to pair.

Install globally (links the `engram`/`engramd` commands):

```sh
npm install -g .
```

### Encrypt the store

```sh
# Run with a password (encrypted at rest, unlock required after boot)
node bin/engramd.js --password 'a strong passphrase'

# Or set a password on a running daemon
curl -X POST http://127.0.0.1:8040/v1/unlock -d '{"password":"a strong passphrase"}'
```

After 5 wrong unlock attempts the daemon locks for a cooldown period.

### Auto-discover and integrate the AI agents on this machine

Engram can locate whatever AI agents are present and register itself as their
shared MCP memory — no per-agent config hunting:

```sh
engram agents scan      # what agents are here, where their config lives
engram agents install   # wire each supported one to engram's MCP server
```

Detected agents (when present): Claude Code, Codex CLI, Gemini CLI, opencode,
Cline, Cursor, and Freebuff. Unsupported ones are reported so an adapter can be
added in `lib/agents.js`. Every modified config gets a `.engram-bak` backup.
The command is idempotent — re-running it does nothing once integrated.

### Agent / MCP

`engram serve-mcp` exposes the memory tools over Model Context Protocol (stdio)
for Claude Code/Cursor/agents:

```ini
# .cursor/mcp.json (example)
{ "mcpServers": { "engram": { "command": "engram", "args": ["serve-mcp"] } } }
```

### Mobile pairing

On the machine running the daemon: `curl -X POST http://127.0.0.1:8040/v1/pair/start`
→ a 6-digit code. Enter it in the mobile page (`/m`) once, then the device has
its own token scoped to memory read/write (it can never revoke devices, change
the password, or start new pairings).

## API (all under `/v1`)

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/v1/remember` | POST | Add/update a memory (`{project,text,tags?,pinned?,source?,session?}`) |
| `/v1/recall?project=p&query=…` | GET | BM25 search |
| `/v1/list?project=p[&limit=…]` | GET | List (most recent first) |
| `/v1/update` | PATCH | Edit a record (`{project,id,…}`) |
| `/v1/forget` | DELETE | Remove a record (id via body or path `/v1/forget/<id>`) |
| `/v1/prune` | POST | Batch delete by query/ids/tags/session (`{project,…}`, `commit:true`) |
| `/v1/export?project=p` | GET | Dump all records |
| `/v1/devices` / `/v1/revoke/<id>` | GET/DELETE | Manage paired devices |
| `/v1/pair/start` / `/v1/pair/claim` | POST | Mobile pairing |
| `/v1/unlock` | POST | Set/enter the encryption password |
| `/v1/status` | GET | Public daemon status |

Requests other than `GET`/`HEAD` must set `Content-Length` when they send a
body (Node's HTTP parser rejects `DELETE`/chunked otherwise).

## Security & operations

- Binds to `127.0.0.1` by default. Pass `--host 0.0.0.0` only if you also use
  pairing and/or `--tls-key/--tls-cert`.
- The daemon writes its descriptor `engram.json` in its data dir with `0600`
  (root token, devices). Never commit this file.
- Run `node scripts/dast.js` for the built-in DAST suite, `npm test` for the
  unit suite, `npm run audit` to confirm the zero-dependency supply chain.
- Data dirs: `$ENGRAM_DIR` → XDG (`~/.local/share/engramd`) → `%APPDATA%\engramd`.

## License

MIT © 2026.