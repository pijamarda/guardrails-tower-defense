# Guardrail TD — Cloud Defense

A multiplayer tower defense game for team building, themed around AWS SCPs and Azure Policies. 8 tower types, 8 enemy types, 5 waves. Designed for 8–10 players in 10–20 minutes.

## Quick Start

### Local Development

Mounts `./app/src` into the container so file saves are reflected immediately. Nodemon auto-restarts the server when `.js` files change. For client files (`game.js`, `index.html`) just refresh the browser.

```bash
docker compose -f docker-compose.dev.yml up --build
```

Open [http://localhost:3000](http://localhost:3000).

To stop:

```bash
docker compose -f docker-compose.dev.yml down
```

### Production (local)

Uses the production Dockerfile — `--production` deps only, `node` (no nodemon), no volume mounts. Same image that gets pushed to ACR.

```bash
docker compose up --build -d
```

Or use the deploy script (also handles health check and logs):

```bash
./deploy.sh
```

---

## Project Structure

```
.
├── docker-compose.yml        # Production compose
├── docker-compose.dev.yml    # Dev compose (volume mount + nodemon)
├── deploy.sh                 # Production deploy script
└── app/
    ├── Dockerfile            # Production image (used by ACR pipeline)
    ├── Dockerfile.dev        # Dev image (nodemon, all deps)
    ├── package.json
    └── src/
        ├── server.js         # Express + Socket.io server
        ├── gameEngine.js     # Server-side game loop, enemy movement, tower firing
        ├── gameData.js       # Tower / enemy / wave definitions
        └── public/
            ├── index.html    # UI layout + CSS
            └── js/
                └── game.js   # Phaser 3 client — rendering, sounds, effects
```

---

## Dev vs Production at a glance

| | Dev | Production |
|---|---|---|
| Command | `docker compose -f docker-compose.dev.yml up` | `docker compose up` / `./deploy.sh` |
| Dockerfile | `Dockerfile.dev` | `Dockerfile` |
| Dependencies | All (incl. nodemon) | `--production` only |
| Source | Mounted from host (`./app/src`) | Copied into image at build time |
| Auto-restart | Yes — nodemon watches `src/*.js` | No |
| Pushed to ACR | Never | Yes |

> **Important:** Never use `docker-compose.dev.yml` or `Dockerfile.dev` in CI/CD. The ACR pipeline should always build from `Dockerfile`.

---

## Gameplay

### Tower domains

| Domain | Towers | Counters |
|---|---|---|
| Network | HTTPS Enforcer, Perimeter Wall | Unencrypted Bucket, Naked VM, Region Jumper |
| Data | Encryption Vault, Key Warden | Unencrypted Bucket, Stale Key |
| IAM | IAM Sentinel, Identity Gate | Rogue IAM User, Anon Container, Shadow Admin |
| GRC | Watchtower, Tag & Region Lock | Unlogged Resource, Region Jumper, Shadow Admin |

### Waves

| Wave | Theme | Boss? |
|---|---|---|
| 1 | Network Basics | No |
| 2 | Data at Risk | No |
| 3 | Identity Crisis | No |
| 4 | Dark Activity | No |
| 5 | Full Breach | Yes — Shadow Admin + Region Jumper |

### Host controls (during game)

- **LAUNCH WAVE** — skip planning timer early
- **SPEED: 1× / 2× / 3×** — cycle enemy speed during a wave (useful for testing or if the game is too slow)
- **NEXT WAVE** — advance after wave-cleared screen
- **RESET GAME** — return to lobby, keep player names

### Currency

- Starting: 100¢ per player
- Kill reward: split equally among all players
- Wave clear bonus: 25¢ per player
- Sell tower: 60% refund (planning phase only)

---

## Adding content

### New tower type

1. Add entry to `TOWERS` in [app/src/gameData.js](app/src/gameData.js)
2. Add entry to `TOWERS_DEF` in [app/src/public/js/game.js](app/src/public/js/game.js)
3. Update enemy `weakTo` arrays in `ENEMIES` if it should counter existing enemies

### New enemy type

1. Add entry to `ENEMIES` in [app/src/gameData.js](app/src/gameData.js)
2. Add emoji, color, shape, and description in [app/src/public/js/game.js](app/src/public/js/game.js) (`ENEMY_EMOJIS`, `ENEMY_COLORS`, `ENEMY_SHAPES`, `ENEMY_DEFS`)
3. Add it to a wave in `WAVES`

### New wave

Add an entry to `WAVES` in [app/src/gameData.js](app/src/gameData.js) — set `number`, `theme`, `teachingMoment`, and the `enemies` array with `{ type, count, interval }`.
