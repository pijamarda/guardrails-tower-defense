// ─────────────────────────────────────────────
//  GUARDRAIL TD  —  Server-side Game State
// ─────────────────────────────────────────────
const { v4: uuidv4 } = require('uuid');
const { TOWERS, ENEMIES, WAVES, PATH, getDamageMultiplier } = require('./gameData');

const GRID_COLS = 20;
const GRID_ROWS = 14;
const CELL_SIZE = 68;
const STARTING_CURRENCY = 100;  // per player
const TARGET_PLAYERS = 10;      // HP is tuned for this many players; scales linearly below
// Minimum HP fraction so even solo play needs ≥2 matched hits to kill any enemy.
// Weakest matched hit = 18dmg * 2x = 36. Floor at 0.65 of base so weakest enemy (40hp)
// becomes 26hp — still needs 2 unmatched hits or 1 matched; stronger enemies survive 2+.
// Effectively: 1-3 players feel real, 8-10 players feel hard.
const MIN_HP_SCALE = 0.65;
const PLANNING_DURATION = 60000; // 60s
const STARTING_LIVES = 20;

// Set of path cells for quick lookup
const PATH_SET = new Set(PATH.map(([c, r]) => `${c},${r}`));

function createGameState() {
  return {
    phase: 'lobby',
    waveIndex: 0,
    lives: STARTING_LIVES,
    players: {},          // socketId -> { name, currency, kills, towersPlaced }
    towers: {},
    enemies: {},
    planningEndsAt: null,
    waveSpawnQueue: [],
    score: 0,
    hostId: null,
    speedMultiplier: 1,
  };
}

class GameEngine {
  constructor(io) {
    this.io = io;
    this.state = createGameState();
    this.tickInterval = null;
    this.spawnTimeout = null;
    this.planningTimeout = null;
    this.pendingKillInfo = [];   // educational popups queued
  }

  // ── Player management ──────────────────────────────────────

  addPlayer(socketId, name) {
    this.state.players[socketId] = {
      id: socketId,
      name: name || `Player_${Object.keys(this.state.players).length + 1}`,
      currency: STARTING_CURRENCY,
      kills: 0,
      towersPlaced: 0,
    };
    if (!this.state.hostId) this.state.hostId = socketId;
    this.broadcast('state_update', this.getPublicState());
  }

  removePlayer(socketId) {
    delete this.state.players[socketId];
    if (this.state.hostId === socketId) {
      const remaining = Object.keys(this.state.players);
      this.state.hostId = remaining.length > 0 ? remaining[0] : null;
    }
    this.broadcast('state_update', this.getPublicState());
  }

  // ── Phase transitions ──────────────────────────────────────

  startPlanning() {
    this.state.phase = 'planning';
    this.state.planningEndsAt = Date.now() + PLANNING_DURATION;
    const wave = WAVES[this.state.waveIndex];
    // Build a summary of incoming enemies for the preview panel
    const incomingEnemies = wave ? wave.enemies.map(e => ({
      type: e.type,
      count: e.count,
      name: ENEMIES[e.type]?.name || e.type,
      isBoss: ENEMIES[e.type]?.isBoss || false,
    })) : [];
    this.broadcast('phase_change', {
      phase: 'planning',
      endsAt: this.state.planningEndsAt,
      waveIndex: this.state.waveIndex,
      waveTheme: wave?.theme || '',
      incomingEnemies,
    });
    this.planningTimeout = setTimeout(() => this.startWave(), PLANNING_DURATION);
  }

  startWave() {
    if (this.planningTimeout) { clearTimeout(this.planningTimeout); this.planningTimeout = null; }
    const wave = WAVES[this.state.waveIndex];
    if (!wave) { this.endGame(true); return; }

    this.state.phase = 'wave';
    this.state.speedMultiplier = 1;
    this.state.waveSpawnQueue = this._buildSpawnQueue(wave);
    this.broadcast('phase_change', { phase: 'wave', waveNumber: wave.number, theme: wave.theme });

    this._scheduleNextSpawn();
    this.tickInterval = setInterval(() => this._tick(), 100);
  }

  _buildSpawnQueue(wave) {
    const queue = [];
    let t = 500; // initial delay before first enemy
    for (const group of wave.enemies) {
      for (let i = 0; i < group.count; i++) {
        queue.push({ type: group.type, spawnAt: t });
        t += group.interval;
      }
    }
    return queue.sort((a, b) => a.spawnAt - b.spawnAt);
  }

  _scheduleNextSpawn() {
    if (!this._waveStartTime) this._waveStartTime = Date.now();
    const spawnNext = () => {
      if (this.state.waveSpawnQueue.length === 0) return;
      const next = this.state.waveSpawnQueue[0];
      const delay = Math.max(0, this._waveStartTime + next.spawnAt - Date.now());
      this.spawnTimeout = setTimeout(() => {
        this.state.waveSpawnQueue.shift();
        this._spawnEnemy(next.type);
        spawnNext();
      }, delay);
    };
    spawnNext();
  }

  _spawnEnemy(type) {
    const template = ENEMIES[type];
    if (!template) return;
    const playerCount = Object.keys(this.state.players).length;
    const hpScale = MIN_HP_SCALE + (1 - MIN_HP_SCALE) * (playerCount / TARGET_PLAYERS);
    const scaledHp = Math.ceil(template.hp * Math.min(1, hpScale));
    const id = uuidv4();
    this.state.enemies[id] = {
      id,
      type,
      name: template.name,
      hp: scaledHp,
      maxHp: scaledHp,
      speed: template.speed,
      livesDamage: template.livesDamage,
      reward: template.reward,
      pathIndex: 0,
      // pixel position starts at path[0]
      x: PATH[0][0] * CELL_SIZE + CELL_SIZE / 2,
      y: PATH[0][1] * CELL_SIZE + CELL_SIZE / 2,
      isBoss: template.isBoss || false,
      weakTo: template.weakTo || [],
    };
  }

  _tick() {
    const now = Date.now();
    const dt = 0.1; // 100ms tick in seconds

    // Move enemies
    const reachedEnd = [];
    for (const [id, enemy] of Object.entries(this.state.enemies)) {
      if (enemy.pathIndex >= PATH.length - 1) {
        reachedEnd.push(id);
        continue;
      }
      const targetCell = PATH[enemy.pathIndex + 1];
      const tx = targetCell[0] * CELL_SIZE + CELL_SIZE / 2;
      const ty = targetCell[1] * CELL_SIZE + CELL_SIZE / 2;
      const dx = tx - enemy.x;
      const dy = ty - enemy.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const step = enemy.speed * dt * (this.state.speedMultiplier || 1);
      if (dist <= step) {
        enemy.x = tx;
        enemy.y = ty;
        enemy.pathIndex++;
      } else {
        enemy.x += (dx / dist) * step;
        enemy.y += (dy / dist) * step;
      }
    }

    // Handle enemies that reached end
    for (const id of reachedEnd) {
      const enemy = this.state.enemies[id];
      this.state.lives = Math.max(0, this.state.lives - enemy.livesDamage);
      delete this.state.enemies[id];
      this.broadcast('enemy_reached_end', { enemyId: id, livesLeft: this.state.lives });
      if (this.state.lives <= 0) {
        this.endGame(false);
        return;
      }
    }

    // Tower attacks
    for (const tower of Object.values(this.state.towers)) {
      if (!tower.lastFired) tower.lastFired = 0;
      if (now - tower.lastFired < tower.fireRate) continue;

      const tDef = TOWERS[tower.type];
      const rangePixels = tower.range * CELL_SIZE;
      const tx = tower.col * CELL_SIZE + CELL_SIZE / 2;
      const ty = tower.row * CELL_SIZE + CELL_SIZE / 2;

      // Find target: prefer furthest-along matched enemy, fall back to any furthest-along
      let target = null;
      let bestPathIndex = -1;
      let fallbackTarget = null;
      let fallbackPathIndex = -1;

      for (const enemy of Object.values(this.state.enemies)) {
        const dx = enemy.x - tx;
        const dy = enemy.y - ty;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > rangePixels) continue;

        const isMatch = enemy.weakTo && enemy.weakTo.includes(tower.type);
        if (isMatch && enemy.pathIndex > bestPathIndex) {
          target = enemy;
          bestPathIndex = enemy.pathIndex;
        }
        if (enemy.pathIndex > fallbackPathIndex) {
          fallbackTarget = enemy;
          fallbackPathIndex = enemy.pathIndex;
        }
      }

      // Use matched target if found, else fall back to any enemy in range
      if (!target) target = fallbackTarget;

      if (target) {
        tower.lastFired = now;
        const multiplier = getDamageMultiplier(tower.type, target.type);
        const dmg = Math.round(tDef.damage * multiplier);
        target.hp -= dmg;

        this.broadcast('tower_shot', {
          towerId: tower.id,
          enemyId: target.id,
          damage: dmg,
          multiplier,
          tx, ty,
          ex: target.x, ey: target.y,
        });

        if (target.hp <= 0) {
          this._killEnemy(target, tower);
        }
      }
    }

    // Broadcast lightweight enemy positions
    this.broadcast('enemies_update', {
      enemies: Object.values(this.state.enemies).map(e => ({
        id: e.id, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp, pathIndex: e.pathIndex,
        type: e.type, name: e.name, isBoss: e.isBoss,
      })),
      lives: this.state.lives,
    });

    // Check wave clear
    if (this.state.waveSpawnQueue.length === 0 && Object.keys(this.state.enemies).length === 0) {
      this._waveCleared();
    }
  }

  _killEnemy(enemy, killerTower) {
    const tDef = ENEMIES[enemy.type];
    delete this.state.enemies[enemy.id];

    // Kill tracked on the tower owner for leaderboard
    const owner = this.state.players[killerTower.ownerId];
    if (owner) owner.kills++;

    // Reward split equally among all connected players
    const playerList = Object.values(this.state.players);
    const share = Math.max(1, Math.floor(enemy.reward / playerList.length));
    for (const player of playerList) {
      player.currency += share;
    }
    this.state.score += enemy.reward;

    // Broadcast kill event with updated currency per player so clients refresh instantly
    this.broadcast('enemy_killed', {
      enemyId: enemy.id,
      enemyName: enemy.name,
      enemyType: enemy.type,
      isBoss: enemy.isBoss || false,
      description: tDef ? tDef.description : '',
      killerTowerType: killerTower.type,
      killerOwner: killerTower.ownerName,
      reward: enemy.reward,
      share,
      players: this.getPublicPlayers(),
    });
  }

  _waveCleared() {
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
    this._waveStartTime = null;

    // Wave clear bonus — each player gets a flat reward
    for (const player of Object.values(this.state.players)) {
      player.currency += 25;
    }

    const wave = WAVES[this.state.waveIndex];
    this.state.phase = 'waveover';
    this.broadcast('wave_cleared', {
      waveNumber: wave.number,
      theme: wave.theme,
      teachingMoment: wave.teachingMoment,
      players: this.getLeaderboard(),
      lives: this.state.lives,
      score: this.state.score,
    });

    this.state.waveIndex++;
    if (this.state.waveIndex >= WAVES.length) {
      setTimeout(() => this.endGame(true), 6000);
    }
  }

  endGame(victory) {
    if (this.tickInterval) { clearInterval(this.tickInterval); this.tickInterval = null; }
    if (this.spawnTimeout) { clearTimeout(this.spawnTimeout); this.spawnTimeout = null; }
    this.state.phase = 'gameover';
    this.broadcast('game_over', {
      victory,
      score: this.state.score,
      leaderboard: this.getLeaderboard(),
    });
  }

  // ── Player actions ─────────────────────────────────────────

  placeTower(socketId, { type, col, row }) {
    const player = this.state.players[socketId];
    if (!player) return { ok: false, error: 'Player not found' };
    if (this.state.phase !== 'planning') return { ok: false, error: 'Not in planning phase' };

    const tDef = TOWERS[type];
    if (!tDef) return { ok: false, error: 'Unknown tower type' };
    if (player.currency < tDef.cost) return { ok: false, error: 'Not enough currency' };
    if (PATH_SET.has(`${col},${row}`)) return { ok: false, error: 'Cannot place on path' };
    if (col < 0 || col >= GRID_COLS || row < 0 || row >= GRID_ROWS) return { ok: false, error: 'Out of bounds' };

    // Check not already occupied
    const occupied = Object.values(this.state.towers).some(t => t.col === col && t.row === row);
    if (occupied) return { ok: false, error: 'Cell already occupied' };

    const id = uuidv4();
    this.state.towers[id] = {
      id, type, col, row,
      ownerId: socketId,
      ownerName: player.name,
      range: tDef.range,
      fireRate: tDef.fireRate,
      lastFired: 0,
    };
    player.currency -= tDef.cost;
    player.towersPlaced++;

    this.broadcast('tower_placed', {
      tower: this.state.towers[id],
      players: this.getPublicPlayers(),
    });
    return { ok: true, towerId: id };
  }

  sellTower(socketId, towerId) {
    const tower = this.state.towers[towerId];
    if (!tower) return { ok: false, error: 'Tower not found' };
    if (tower.ownerId !== socketId) return { ok: false, error: 'Not your tower' };
    if (this.state.phase !== 'planning') return { ok: false, error: 'Can only sell during planning' };

    const tDef = TOWERS[tower.type];
    const refund = Math.floor(tDef.cost * 0.6);
    this.state.players[socketId].currency += refund;
    this.state.players[socketId].towersPlaced = Math.max(0, this.state.players[socketId].towersPlaced - 1);
    delete this.state.towers[towerId];

    this.broadcast('tower_sold', { towerId, players: this.getPublicPlayers() });
    return { ok: true };
  }

  startGameByHost(socketId) {
    if (socketId !== this.state.hostId) return { ok: false, error: 'Only host can start' };
    if (this.state.phase !== 'lobby') return { ok: false, error: 'Game already started' };
    this.startPlanning();
    return { ok: true };
  }

  skipPlanningByHost(socketId) {
    if (socketId !== this.state.hostId) return { ok: false, error: 'Only host can skip' };
    if (this.state.phase !== 'planning') return { ok: false, error: 'Not in planning phase' };
    this.startWave();
    return { ok: true };
  }

  nextWaveByHost(socketId) {
    if (socketId !== this.state.hostId) return { ok: false, error: 'Only host can advance' };
    if (this.state.phase !== 'waveover') return { ok: false, error: 'Not between waves' };
    this.startPlanning();
    return { ok: true };
  }

  setSpeedByHost(socketId, multiplier) {
    if (socketId !== this.state.hostId) return { ok: false, error: 'Only host can change speed' };
    if (this.state.phase !== 'wave') return { ok: false, error: 'Can only change speed during a wave' };
    const valid = [1, 2, 3];
    this.state.speedMultiplier = valid.includes(multiplier) ? multiplier : 1;
    this.broadcast('speed_changed', { speedMultiplier: this.state.speedMultiplier });
    return { ok: true };
  }

  resetGame(socketId) {
    if (socketId !== this.state.hostId) return { ok: false, error: 'Only host can reset' };
    if (this.tickInterval) clearInterval(this.tickInterval);
    if (this.spawnTimeout) clearTimeout(this.spawnTimeout);
    if (this.planningTimeout) clearTimeout(this.planningTimeout);
    const newState = createGameState();
    for (const [id, p] of Object.entries(this.state.players)) {
      newState.players[id] = { id, name: p.name, currency: STARTING_CURRENCY, kills: 0, towersPlaced: 0 };
    }
    newState.hostId = this.state.hostId;
    this.state = newState;
    this._waveStartTime = null;
    this.broadcast('game_reset', this.getPublicState());
    return { ok: true };
  }

  // ── Helpers ────────────────────────────────────────────────

  getLeaderboard() {
    return Object.values(this.state.players)
      .sort((a, b) => b.kills - a.kills || b.towersPlaced - a.towersPlaced)
      .map((p, i) => ({ rank: i + 1, name: p.name, kills: p.kills, towersPlaced: p.towersPlaced }));
  }

  getPublicPlayers() {
    return Object.values(this.state.players).map(p => ({
      id: p.id, name: p.name, currency: p.currency, kills: p.kills, towersPlaced: p.towersPlaced,
    }));
  }

  getPublicState() {
    return {
      phase: this.state.phase,
      waveIndex: this.state.waveIndex,
      lives: this.state.lives,
      score: this.state.score,
      players: this.getPublicPlayers(),
      towers: Object.values(this.state.towers),
      hostId: this.state.hostId,
      planningEndsAt: this.state.planningEndsAt,
      speedMultiplier: this.state.speedMultiplier || 1,
    };
  }

  broadcast(event, data) {
    this.io.emit(event, data);
  }
}

module.exports = { GameEngine, TOWERS, ENEMIES, WAVES, PATH, GRID_COLS, GRID_ROWS, CELL_SIZE, PATH_SET };
