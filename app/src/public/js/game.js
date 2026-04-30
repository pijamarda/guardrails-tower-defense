// ─────────────────────────────────────────────
//  GUARDRAIL TD — Phaser 3 Game Client
// ─────────────────────────────────────────────

// ── Constants ─────────────────────────────────
const CELL = 68;
const COLS = 20;
const ROWS = 14;
const CANVAS_W = COLS * CELL;   // 1040
const CANVAS_H = ROWS * CELL;   // 728

const PATH = [
  [0,2],[1,2],[2,2],[3,2],[4,2],
  [4,3],[4,4],[4,5],[4,6],
  [5,6],[6,6],[7,6],[8,6],[9,6],
  [9,5],[9,4],[9,3],[9,2],
  [10,2],[11,2],[12,2],[13,2],
  [13,3],[13,4],[13,5],[13,6],[13,7],[13,8],
  [12,8],[11,8],[10,8],[9,8],[8,8],[7,8],
  [7,9],[7,10],[7,11],
  [8,11],[9,11],[10,11],[11,11],[12,11],[13,11],[14,11],[15,11],[16,11],[17,11],[18,11],[19,11],
];
const PATH_SET = new Set(PATH.map(([c,r]) => `${c},${r}`));

const TOWERS_DEF = {
  https_enforcer:  { name:'HTTPS Enforcer',   domain:'Network',         cost:50,  color:0x00aaff, emoji:'🔒', description:'Enforces TLS 1.2+ and blocks plain HTTP traffic',                             guardrails:'G.01.01, G.01.08' },
  perimeter_wall:  { name:'Perimeter Wall',   domain:'Network',         cost:75,  color:0x0066cc, emoji:'🧱', description:'Blocks public access, prevents default VPCs and rogue NATs',                 guardrails:'G.01.04, G.01.06, G.01.07' },
  encryption_vault:{ name:'Encryption Vault', domain:'Data Protection', cost:60,  color:0xffaa00, emoji:'🔐', description:'Encrypts everything at rest and in transit',                                  guardrails:'G.02.01, G.02.02' },
  key_warden:      { name:'Key Warden',       domain:'Data Protection', cost:80,  color:0xff6600, emoji:'🗝️', description:'Prevents cross-tenant replication, expires stale keys',                      guardrails:'G.02.04, G.02.06' },
  iam_sentinel:    { name:'IAM Sentinel',     domain:'IAM',             cost:100, color:0xcc00cc, emoji:'🛡️', description:'Prevents IAM user creation, denies root access, protects central roles',     guardrails:'G.03.01, G.03.07, G.03.08' },
  identity_gate:   { name:'Identity Gate',    domain:'IAM',             cost:70,  color:0x9900cc, emoji:'🚪', description:'Enforces IMDSv2, blocks anonymous access, requires Entra ID auth',           guardrails:'G.03.03, G.03.05, G.03.06' },
  watchtower:      { name:'Watchtower',       domain:'GRC',             cost:90,  color:0x00cc66, emoji:'🔭', description:'Streams logs, protects CloudTrail and GuardDuty, streams Defender data',     guardrails:'G.04.01–G.04.04' },
  tag_region_lock: { name:'Tag & Region Lock',domain:'GRC',             cost:55,  color:0x009966, emoji:'📍', description:'Enforces reserved tags, restricts regions, limits allowed SKUs',             guardrails:'G.04.05, G.04.08, G.04.10' },
};

const DOMAIN_COLORS = {
  'Network':         '#00aaff',
  'Data Protection': '#ffaa00',
  'IAM':             '#cc44cc',
  'GRC':             '#00cc66',
};

// ── State ──────────────────────────────────────
const socket = io();
let myId = null;
let myName = '';
let gameState = null;
let selectedTower = null;
let phaserGame = null;
let gameScene = null;
let planningTimer = null;

// ── Lobby ──────────────────────────────────────
document.getElementById('join-btn').addEventListener('click', joinGame);
document.getElementById('name-input').addEventListener('keydown', e => { if (e.key === 'Enter') joinGame(); });

function joinGame() {
  const name = document.getElementById('name-input').value.trim();
  if (!name) return;
  myName = name;
  socket.emit('join', { name });
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('game-ui').style.display = 'flex';
  initPhaser();
}

// ── Socket events ──────────────────────────────
socket.on('connect', () => { myId = socket.id; });

socket.on('state_update', (state) => {
  gameState = state;
  if (document.getElementById('game-ui').style.display === 'flex') {
    syncUI();
  } else {
    // Still in lobby — show player list
    updateLobbyPlayers(state.players);
  }
});

socket.on('phase_change', ({ phase, endsAt, waveNumber, theme, waveIndex, waveTheme, incomingEnemies }) => {
  if (!gameState) return;
  gameState.phase = phase;
  if (waveIndex !== undefined) gameState.waveIndex = waveIndex;
  updatePhaseUI(phase, endsAt, waveNumber, theme);
  if (phase === 'planning' && incomingEnemies) {
    renderWavePreview(incomingEnemies, waveTheme);
  } else if (phase === 'wave' || phase === 'waveover' || phase === 'gameover') {
    hideWavePreview();
  }
});

socket.on('tower_placed', ({ tower, players }) => {
  if (gameState) gameState.towers = [...(gameState.towers || []).filter(t => t.id !== tower.id), tower];
  updatePlayers(players);
  if (gameScene) gameScene.renderTower(tower);
});

socket.on('tower_sold', ({ towerId, players }) => {
  if (gameState) gameState.towers = (gameState.towers || []).filter(t => t.id !== towerId);
  updatePlayers(players);
  if (gameScene) gameScene.removeTower(towerId);
});

socket.on('enemies_update', ({ enemies, lives }) => {
  if (gameState) gameState.lives = lives;
  document.getElementById('lives-val').textContent = lives;
  if (gameScene) gameScene.updateEnemies(enemies);
});

socket.on('tower_shot', (data) => {
  if (gameScene) gameScene.showShot(data);
});

socket.on('enemy_killed', ({ enemyId, enemyName, enemyType, isBoss, description, killerOwner, reward, share, players }) => {
  if (gameScene) gameScene.removeEnemy(enemyId);
  if (players) updatePlayers(players);
  addKillFeedEntry({ enemyName, enemyType, isBoss, description, killerOwner, share });
});

socket.on('enemy_reached_end', ({ enemyId, livesLeft }) => {
  if (gameScene) gameScene.removeEnemy(enemyId);
  if (gameState) gameState.lives = livesLeft;
  document.getElementById('lives-val').textContent = livesLeft;
  if (gameScene) gameScene.flashLives();
});

socket.on('wave_cleared', ({ waveNumber, theme, teachingMoment, players, lives, score }) => {
  updatePlayers(players);
  if (gameState) { gameState.score = score; gameState.lives = lives; }
  document.getElementById('score-val').textContent = score;
  document.getElementById('lives-val').textContent = lives;
  showOverlay(`WAVE ${waveNumber} CLEARED`, teachingMoment, players, true);
  updateHostButtons();
});

socket.on('game_over', ({ victory, score, leaderboard }) => {
  const title = victory ? '✦ VICTORY ✦' : '✖ BREACH ✖';
  const body = victory
    ? `All waves repelled! Your guardrails held. Final score: ${score}`
    : `The misconfigurations broke through. Final score: ${score}`;
  showOverlay(title, body, leaderboard, false);
  if (gameScene) gameScene.stopAll();
});

socket.on('game_reset', (state) => {
  gameState = state;
  hideOverlay();
  syncUI();
  if (gameScene) gameScene.resetScene(state);
});

socket.on('error_msg', (msg) => {
  showPopup(`<strong style="color:#ff4444">ERROR:</strong> ${msg}`, 2500);
});

// ── UI helpers ─────────────────────────────────
function updateLobbyPlayers(players) {
  const el = document.getElementById('lobby-players');
  if (!players || players.length === 0) { el.textContent = ''; return; }
  el.textContent = 'Online: ' + players.map(p => p.name).join(', ');
}

function waveDisplay() {
  if (!gameState) return '0/5';
  const phase = gameState.phase;
  // waveIndex increments after wave ends, so during planning/wave it's the current wave (1-based)
  if (phase === 'lobby') return '0/5';
  if (phase === 'gameover') return '5/5';
  return `${gameState.waveIndex + 1}/5`;
}

function syncUI() {
  if (!gameState) return;
  updatePlayers(gameState.players);
  updateHostButtons();
  document.getElementById('lives-val').textContent = gameState.lives;
  document.getElementById('wave-val').textContent = waveDisplay();
  document.getElementById('score-val').textContent = gameState.score || 0;
  const me = (gameState.players || []).find(p => p.id === myId);
  if (me) document.getElementById('my-currency-val').textContent = me.currency;
  updatePhaseUI(gameState.phase, gameState.planningEndsAt);
  renderTowerShop();
}

function updateMyCurrency(players) {
  const me = (players || []).find(p => p.id === myId);
  if (me) document.getElementById('my-currency-val').textContent = me.currency;
}

function updatePlayers(players) {
  updateMyCurrency(players);

  const list = document.getElementById('player-list');
  list.innerHTML = '';
  const sorted = [...players].sort((a,b) => b.kills - a.kills || b.towersPlaced - a.towersPlaced);
  sorted.forEach((p, i) => {
    const isHost = p.id === gameState?.hostId;
    const row = document.createElement('div');
    row.className = 'player-row' + (p.id === myId ? ' me' : '');
    row.innerHTML = `
      <span class="player-name">${i+1}. ${escHtml(p.name)}${isHost ? ' <span style="color:#ffcc00" title="Game host">★</span>' : ''}</span>
      <span class="player-stats">${p.kills}k · ${p.towersPlaced}t</span>
      <span class="player-currency">${p.currency}¢</span>
    `;
    list.appendChild(row);
  });

  renderTowerShop();
}

function updatePhaseUI(phase, endsAt, waveNumber, theme) {
  const phaseText = document.getElementById('phase-text');
  const waveEl = document.getElementById('wave-val');

  if (phase === 'lobby') phaseText.textContent = 'LOBBY';
  else if (phase === 'planning') phaseText.textContent = `PLANNING — WAVE ${(gameState?.waveIndex||0)+1}`;
  else if (phase === 'wave') { phaseText.textContent = `WAVE ${waveNumber||'?'}: ${theme||''}`; }
  else if (phase === 'waveover') phaseText.textContent = 'WAVE CLEARED';
  else if (phase === 'gameover') phaseText.textContent = 'GAME OVER';

  if (gameState) waveEl.textContent = waveDisplay();

  // Timer bar
  if (planningTimer) { clearInterval(planningTimer); planningTimer = null; }
  const bar = document.getElementById('timer-bar');
  if (phase === 'planning' && endsAt) {
    planningTimer = setInterval(() => {
      const left = Math.max(0, endsAt - Date.now());
      bar.style.width = ((left / 60000) * 100) + '%';
      if (left === 0) { clearInterval(planningTimer); planningTimer = null; }
    }, 250);
  } else {
    bar.style.width = phase === 'wave' ? '100%' : '0%';
    bar.style.background = phase === 'wave' ? '#ff4444' : '#00ff88';
  }

  updateHostButtons();
}

function updateHostButtons() {
  if (!gameState) return;
  const isHost = myId === gameState.hostId;
  const hostSection = document.getElementById('host-only');
  hostSection.style.display = isHost ? 'block' : 'none';
  if (!isHost) return;

  // Show a reminder of who is driving
  let hostNote = document.getElementById('host-note');
  if (!hostNote) {
    hostNote = document.createElement('div');
    hostNote.id = 'host-note';
    hostNote.style.cssText = 'font-size:0.68rem;color:#ffcc00;margin-bottom:6px;letter-spacing:1px;';
    hostSection.prepend(hostNote);
  }
  hostNote.textContent = '★ You are the host';

  const phase = gameState.phase;
  document.getElementById('btn-start').style.display         = phase === 'lobby'    ? 'block' : 'none';
  document.getElementById('btn-skip-planning').style.display = phase === 'planning' ? 'block' : 'none';
  document.getElementById('btn-next-wave').style.display     = phase === 'waveover' ? 'block' : 'none';
  document.getElementById('btn-reset').style.display         = phase !== 'lobby'    ? 'block' : 'none';
}

function renderWavePreview(incomingEnemies, theme) {
  const panel = document.getElementById('wave-preview');
  const list = document.getElementById('wave-preview-list');
  list.innerHTML = '';

  // Render as compact horizontal badges: emoji + name + ×count
  for (const e of incomingEnemies) {
    const emoji = ENEMY_EMOJIS[e.type] || '❓';
    const color = '#' + (ENEMY_COLORS[e.type] || 0xff4444).toString(16).padStart(6, '0');
    const badge = document.createElement('div');
    badge.title = ENEMY_DEFS[e.type]?.description || '';
    badge.style.cssText = `
      display:inline-flex;align-items:center;gap:3px;
      padding:3px 6px;
      background:#111;
      border:1px solid ${color}55;
      font-size:0.7rem;font-family:'Courier New',monospace;
      white-space:nowrap;
    `;
    badge.innerHTML = `
      <span style="font-size:13px;line-height:1">${emoji}</span>
      <span style="color:${color}">${e.name}</span>
      <span style="color:#555">×${e.count}${e.isBoss ? ' <span style="color:#ff4444;font-weight:bold">BOSS</span>' : ''}</span>
    `;
    list.appendChild(badge);
  }

  panel.style.display = 'block';
}

function hideWavePreview() {
  document.getElementById('wave-preview').style.display = 'none';
}

function renderTowerShop() {
  const list = document.getElementById('tower-list');
  list.innerHTML = '';
  const myMoney = (gameState?.players || []).find(p => p.id === myId)?.currency ?? 0;

  Object.entries(TOWERS_DEF).forEach(([id, t]) => {
    const canAfford = myMoney >= t.cost;
    const btn = document.createElement('button');
    btn.className = 'tower-btn' + (selectedTower === id ? ' selected' : '') + (!canAfford ? ' cant-afford' : '');
    btn.dataset.towerId = id;

    const hexColor = '#' + t.color.toString(16).padStart(6, '0');
    const domColor = DOMAIN_COLORS[t.domain] || '#aaa';

    btn.innerHTML = `
      <div class="tower-icon" style="background:${hexColor}22;border:1px solid ${hexColor};color:${hexColor};font-size:22px">${t.emoji}</div>
      <div class="tower-info">
        <div class="tower-name" style="color:${domColor}">${t.name}</div>
        <div class="tower-meta">${t.domain}</div>
      </div>
      <div class="tower-cost">${t.cost}¢</div>
    `;

    btn.addEventListener('click', () => {
      if (!canAfford || gameState?.phase !== 'planning') return;
      selectedTower = selectedTower === id ? null : id;
      renderTowerShop();
      if (gameScene) gameScene.setSelectedTower(selectedTower);
    });

    // Tooltip
    btn.addEventListener('mouseenter', (e) => showTowerTooltip(t, e));
    btn.addEventListener('mouseleave', hideTowerTooltip);

    list.appendChild(btn);
  });
}

function showTowerTooltip(t, e) {
  const tt = document.getElementById('tower-tooltip');
  tt.innerHTML = `<strong>${t.name}</strong>${t.description}<div class="tt-ids">${t.guardrails}</div>`;
  tt.style.display = 'block';
  tt.style.left = (e.clientX - 220) + 'px';
  tt.style.top = e.clientY + 'px';
}
function hideTowerTooltip() {
  document.getElementById('tower-tooltip').style.display = 'none';
}

function showOverlay(title, body, leaderboard, isContinuable) {
  document.getElementById('overlay-title').textContent = title;
  document.getElementById('overlay-body').textContent = body;

  const lb = document.getElementById('overlay-leaderboard');
  lb.innerHTML = '';
  if (leaderboard && leaderboard.length) {
    leaderboard.forEach(p => {
      const row = document.createElement('div');
      row.className = 'lb-row';
      row.innerHTML = `<span class="lb-rank">#${p.rank}</span><span class="lb-name">${escHtml(p.name)}</span><span class="lb-kills">${p.kills} kills</span>`;
      lb.appendChild(row);
    });
  }

  const continueBtn = document.getElementById('overlay-btn');
  if (isContinuable) {
    continueBtn.style.display = 'inline-block';
    if (myId === gameState?.hostId) {
      continueBtn.textContent = 'NEXT WAVE ▶';
      continueBtn.onclick = () => { hideOverlay(); socket.emit('next_wave'); };
    } else {
      continueBtn.textContent = 'READY ✓';
      continueBtn.onclick = () => { hideOverlay(); };
    }
  } else {
    continueBtn.style.display = 'none';
  }

  document.getElementById('overlay').classList.add('show');
}

function hideOverlay() {
  document.getElementById('overlay').classList.remove('show');
}

let popupTimeout = null;
function showPopup(html, duration = 4000) {
  const el = document.getElementById('popup');
  el.innerHTML = html;
  el.classList.add('show');
  if (popupTimeout) clearTimeout(popupTimeout);
  popupTimeout = setTimeout(() => el.classList.remove('show'), duration);
}

const MAX_KILL_FEED = 30;
function addKillFeedEntry({ enemyName, enemyType, isBoss, description, killerOwner, share }) {
  const feed = document.getElementById('kill-feed-entries');
  if (!feed) return;
  const emoji = ENEMY_EMOJIS[enemyType] || '💀';
  const entry = document.createElement('div');
  entry.className = 'kf-entry' + (isBoss ? ' boss' : '');
  entry.innerHTML =
    `<span class="kf-tower">${escHtml(killerOwner)}</span> ▶ <span class="kf-emoji">${emoji}</span> <span class="kf-enemy">${escHtml(enemyName)}</span> ` +
    `<span class="kf-reward">+${share}¢</span>` +
    `<span class="kf-desc">${escHtml(description)}</span>`;
  feed.appendChild(entry);
  // cap entries so DOM doesn't grow forever
  while (feed.children.length > MAX_KILL_FEED) feed.removeChild(feed.firstChild);
  // auto-remove after animation completes (6s total)
  setTimeout(() => { if (entry.parentNode) entry.parentNode.removeChild(entry); }, 6200);
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Host button wiring ─────────────────────────
document.getElementById('btn-start').addEventListener('click', () => socket.emit('start_game'));
document.getElementById('btn-skip-planning').addEventListener('click', () => socket.emit('skip_planning'));
document.getElementById('btn-next-wave').addEventListener('click', () => { hideOverlay(); socket.emit('next_wave'); });
document.getElementById('btn-reset').addEventListener('click', () => socket.emit('reset_game'));

// ── Phaser Game ────────────────────────────────
function initPhaser() {
  phaserGame = new Phaser.Game({
    type: Phaser.CANVAS,
    canvas: document.getElementById('game-canvas'),
    width: CANVAS_W,
    height: CANVAS_H,
    backgroundColor: '#0a0a0f',
    scene: { create, update },
    parent: 'canvas-wrap',
  });
}

// Phaser scene refs
let scene, graphics, towerGroup, enemyGroup, bulletGroup, uiGroup;
let placementPreview = null;
let pointerCol = -1, pointerRow = -1;
let towersOnCanvas = {};   // towerId -> { sprite, text }
let enemiesOnCanvas = {};  // enemyId -> { container, bar, hpFill }
let bulletsOnCanvas = [];

function create() {
  scene = this;
  gameScene = {
    renderTower,
    removeTower,
    updateEnemies,
    showShot,
    removeEnemy,
    flashLives,
    setSelectedTower: (id) => { selectedTower = id; },
    resetScene,
    stopAll,
  };

  graphics = scene.add.graphics();
  towerGroup = scene.add.group();
  enemyGroup = scene.add.group();
  bulletGroup = scene.add.group();
  uiGroup = scene.add.group();

  drawGrid();
  drawDecor();

  // Placement preview
  placementPreview = scene.add.graphics();

  // Pointer tracking for tower placement + canvas tooltips
  scene.input.on('pointermove', (ptr) => {
    pointerCol = Math.floor(ptr.x / CELL);
    pointerRow = Math.floor(ptr.y / CELL);
    drawPlacementPreview();
    updateCanvasTooltip(ptr.x, ptr.y, ptr.event);
  });

  scene.input.on('pointerout', () => {
    hideCanvasTooltip();
  });

  scene.input.on('pointerdown', (ptr) => {
    if (!selectedTower || gameState?.phase !== 'planning') return;
    const col = Math.floor(ptr.x / CELL);
    const row = Math.floor(ptr.y / CELL);
    socket.emit('place_tower', { type: selectedTower, col, row }, (res) => {
      if (!res.ok) showPopup(`<strong style="color:#ff4444">${res.error}</strong>`, 2000);
    });
  });

  // Right-click to sell tower
  scene.input.on('pointerdown', (ptr) => {
    if (ptr.rightButtonDown()) {
      const col = Math.floor(ptr.x / CELL);
      const row = Math.floor(ptr.y / CELL);
      const tower = gameState?.towers?.find(t => t.col === col && t.row === row && t.ownerId === myId);
      if (tower && gameState?.phase === 'planning') {
        socket.emit('sell_tower', { towerId: tower.id }, (res) => {
          if (!res.ok) showPopup(`<strong style="color:#ff4444">${res.error}</strong>`, 2000);
        });
      }
    }
  });

  scene.input.mouse.disableContextMenu();

  // Render any existing towers from state
  if (gameState?.towers) gameState.towers.forEach(renderTower);
}

function update() {
  // Bullet movement handled per-bullet in showShot
}

// ── Grid drawing ───────────────────────────────
function drawGrid() {
  graphics.clear();

  // Background cells — brighter green-grid tech theme
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const isPath = PATH_SET.has(`${c},${r}`);
      if (isPath) {
        // Path: warm sand tone, clearly walkable
        graphics.fillStyle(0x2a2010, 1);
        graphics.fillRect(c * CELL, r * CELL, CELL, CELL);
        // Path lane stripe
        graphics.fillStyle(0x3a3018, 1);
        graphics.fillRect(c * CELL + 6, r * CELL + 6, CELL - 12, CELL - 12);
      } else {
        // Buildable cells: dark teal grid
        graphics.fillStyle(0x0d1f1a, 1);
        graphics.fillRect(c * CELL, r * CELL, CELL, CELL);
        // subtle inner cell
        graphics.fillStyle(0x0f2420, 1);
        graphics.fillRect(c * CELL + 1, r * CELL + 1, CELL - 2, CELL - 2);
      }
    }
  }

  // Grid lines — bright green, tech feel
  graphics.lineStyle(1, 0x00ff88, 0.18);
  for (let c = 0; c <= COLS; c++) {
    graphics.lineBetween(c * CELL, 0, c * CELL, ROWS * CELL);
  }
  for (let r = 0; r <= ROWS; r++) {
    graphics.lineBetween(0, r * CELL, COLS * CELL, r * CELL);
  }

  // Path center line — dashed amber glow
  graphics.lineStyle(2, 0xffaa00, 0.5);
  for (let i = 0; i < PATH.length - 1; i++) {
    const [c1, r1] = PATH[i];
    const [c2, r2] = PATH[i+1];
    graphics.lineBetween(
      c1 * CELL + CELL/2, r1 * CELL + CELL/2,
      c2 * CELL + CELL/2, r2 * CELL + CELL/2
    );
  }

  // Arrow indicators along the path every few steps
  const arrowSteps = [4, 9, 14, 20, 26, 32, 38];
  for (const idx of arrowSteps) {
    if (idx >= PATH.length - 1) continue;
    const [c1, r1] = PATH[idx];
    const [c2, r2] = PATH[idx + 1];
    const ax = c1 * CELL + CELL/2;
    const ay = r1 * CELL + CELL/2;
    const dx = c2 - c1;
    const dy = r2 - r1;
    const arrowText = dx === 1 ? '›' : dx === -1 ? '‹' : dy === 1 ? 'v' : '^';
    scene.add.text(ax, ay, arrowText, {
      font: 'bold 14px Courier New', color: '#ffaa0066', align: 'center'
    }).setOrigin(0.5).setAlpha(0.5);
  }

  // Start marker
  const [sc, sr] = PATH[0];
  graphics.fillStyle(0x00ff88, 0.25);
  graphics.fillRect(sc * CELL + 2, sr * CELL + 2, CELL - 4, CELL - 4);
  scene.add.text(sc * CELL + CELL/2, sr * CELL + CELL/2, '▶ IN', {
    font: 'bold 10px Courier New', color: '#00ff88', align: 'center'
  }).setOrigin(0.5);

  // End marker
  const [ec, er] = PATH[PATH.length - 1];
  graphics.fillStyle(0xff4444, 0.25);
  graphics.fillRect(ec * CELL + 2, er * CELL + 2, CELL - 4, CELL - 4);
  scene.add.text(ec * CELL + CELL/2, er * CELL + CELL/2, '✖ OUT', {
    font: 'bold 10px Courier New', color: '#ff4444', align: 'center'
  }).setOrigin(0.5);

  // Domain zone labels — subtle background hints
  const ZONE_LABELS = [
    { text: 'NETWORK',    c: 1,  r: 0,  color: '#00aaff' },
    { text: 'DATA',       c: 10, r: 4,  color: '#ffaa00' },
    { text: 'IAM',        c: 15, r: 4,  color: '#cc44cc' },
    { text: 'GRC',        c: 1,  r: 9,  color: '#00cc66' },
  ];
  for (const z of ZONE_LABELS) {
    if (PATH_SET.has(`${z.c},${z.r}`)) continue;
    scene.add.text(z.c * CELL + CELL/2, z.r * CELL + CELL/2, z.text, {
      font: 'bold 9px Courier New', color: z.color, align: 'center'
     }).setOrigin(0.5).setAlpha(0.22);
  }
}

// ── Decorative background emoji ────────────────
function drawDecor() {
  const layer = document.getElementById('decor-layer');
  if (!layer) return;
  layer.innerHTML = '';

  // Nature emoji pool — rendered via DOM so they show on Linux/Docker
  const TREES  = ['🌲', '🌳', '🌿', '🍃', '🌾', '🪨', '🌵', '☁️', '🌫️', '🍀'];
  // Deterministic LCG — same layout every game
  let seed = 42;
  const rand = () => { seed = (seed * 1664525 + 1013904223) & 0xffffffff; return (seed >>> 0) / 0xffffffff; };

  // Neighbour check: don't place on path or adjacent to path (keeps path readable)
  const isNearPath = (c, r) => {
    for (let dc = -1; dc <= 1; dc++)
      for (let dr = -1; dr <= 1; dr++)
        if (PATH_SET.has(`${c+dc},${r+dr}`)) return true;
    return false;
  };

  // About 25% of free non-adjacent cells get a decoration
  for (let c = 0; c < COLS; c++) {
    for (let r = 0; r < ROWS; r++) {
      const v = rand(); // consume rng for every cell to keep positions stable
      if (PATH_SET.has(`${c},${r}`)) continue;
      if (isNearPath(c, r)) continue;
      if (v > 0.28) continue; // ~28% fill

      const emoji = TREES[Math.floor(rand() * TREES.length)];
      // Slight sub-cell offset so they don't sit perfectly centered (more natural)
      const offsetX = (rand() - 0.5) * CELL * 0.4;
      const offsetY = (rand() - 0.5) * CELL * 0.4;
      const px = c * CELL + CELL / 2 + offsetX;
      const py = r * CELL + CELL / 2 + offsetY;

      const el = document.createElement('span');
      el.className = 'decor-cell';
      el.textContent = emoji;
      el.style.left = px + 'px';
      el.style.top  = py + 'px';
      // vary size a little for depth
      const sz = 20 + Math.floor(rand() * 14);
      el.style.fontSize = sz + 'px';
      layer.appendChild(el);
    }
  }
}

function drawPlacementPreview() {
  placementPreview.clear();
  if (!selectedTower || gameState?.phase !== 'planning') return;

  const c = pointerCol, r = pointerRow;
  if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return;

  const isPath = PATH_SET.has(`${c},${r}`);
  const occupied = gameState?.towers?.some(t => t.col === c && t.row === r);
  const canPlace = !isPath && !occupied;

  placementPreview.fillStyle(canPlace ? 0x00ff88 : 0xff4444, 0.25);
  placementPreview.fillRect(c * CELL, r * CELL, CELL - 1, CELL - 1);
  placementPreview.lineStyle(1, canPlace ? 0x00ff88 : 0xff4444, 0.6);
  placementPreview.strokeRect(c * CELL, r * CELL, CELL - 1, CELL - 1);

  // Range indicator
  if (canPlace && TOWERS_DEF[selectedTower]) {
    const range = 2 * CELL;
    placementPreview.lineStyle(1, 0x00ff88, 0.2);
    placementPreview.strokeCircle(c * CELL + CELL/2, r * CELL + CELL/2, range);
  }
}

// ── Tower rendering ────────────────────────────
function renderTower(tower) {
  if (towersOnCanvas[tower.id]) removeTower(tower.id);

  const def = TOWERS_DEF[tower.type];
  if (!def) return;

  const x = tower.col * CELL + CELL / 2;
  const y = tower.row * CELL + CELL / 2;
  const isMe = tower.ownerId === myId;

  // Tile background
  const g = scene.add.graphics();
  g.fillStyle(def.color, isMe ? 0.35 : 0.2);
  g.fillRect(x - CELL/2 + 3, y - CELL/2 + 3, CELL - 6, CELL - 6);
  g.lineStyle(isMe ? 2 : 1, def.color, isMe ? 1.0 : 0.55);
  g.strokeRect(x - CELL/2 + 3, y - CELL/2 + 3, CELL - 6, CELL - 6);

  // Corner accent dots for "tech" feel
  g.fillStyle(def.color, 0.8);
  const d = 3, m = 5;
  g.fillRect(x - CELL/2 + m,     y - CELL/2 + m,     d, d);
  g.fillRect(x + CELL/2 - m - d, y - CELL/2 + m,     d, d);
  g.fillRect(x - CELL/2 + m,     y + CELL/2 - m - d, d, d);
  g.fillRect(x + CELL/2 - m - d, y + CELL/2 - m - d, d, d);

  // Emoji icon — big and readable
  const emoji = scene.add.text(x, y - 8, def.emoji, {
    fontSize: '34px',
    fontFamily: '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", Arial, sans-serif',
    align: 'center',
  }).setOrigin(0.5);

  // Owner label
  const ownerLabel = scene.add.text(x, y + 22, tower.ownerName.substring(0, 6), {
    font: '11px Courier New',
    color: isMe ? '#ffff88' : '#888888',
    align: 'center',
  }).setOrigin(0.5);

  towersOnCanvas[tower.id] = { g, label: emoji, ownerLabel };
}

function removeTower(towerId) {
  const obj = towersOnCanvas[towerId];
  if (!obj) return;
  obj.g.destroy();
  obj.label.destroy();
  obj.ownerLabel.destroy();
  delete towersOnCanvas[towerId];
}

// ── Enemy rendering ────────────────────────────
const ENEMY_COLORS = {
  unencrypted_bucket: 0xff4444,
  naked_vm:           0xff6600,
  stale_key:          0xffcc00,
  rogue_iam_user:     0xcc44cc,
  anon_container:     0xaa44ff,
  unlogged_resource:  0x888888,
  shadow_admin:       0xdd0000,
  region_jumper:      0x2255cc,
};

const ENEMY_EMOJIS = {
  unencrypted_bucket: '🪣',
  naked_vm:           '🖥️',
  stale_key:          '🗝️',
  rogue_iam_user:     '👤',
  anon_container:     '📦',
  unlogged_resource:  '👻',
  shadow_admin:       '💀',
  region_jumper:      '🌍',
};

function updateEnemies(enemies) {
  const seen = new Set();
  for (const e of enemies) {
    seen.add(e.id);
    if (!enemiesOnCanvas[e.id]) {
      spawnEnemySprite(e);
    } else {
      moveEnemySprite(e);
    }
  }
  // Remove enemies that are gone
  for (const id of Object.keys(enemiesOnCanvas)) {
    if (!seen.has(id)) removeEnemy(id);
  }
}

// Shape per enemy type: 'circle' | 'square' | 'triangle' | 'hex' | 'diamond'
const ENEMY_SHAPES = {
  unencrypted_bucket: 'circle',
  naked_vm:           'square',
  stale_key:          'triangle',
  rogue_iam_user:     'hex',
  anon_container:     'circle',
  unlogged_resource:  'square',
  shadow_admin:       'diamond',   // boss
  region_jumper:      'diamond',   // boss
};

function drawEnemyShape(g, shape, size, color, isBoss) {
  const alpha = isBoss ? 0.55 : 0.4;
  const strokeAlpha = isBoss ? 1.0 : 0.85;
  const strokeW = isBoss ? 2 : 1;
  g.fillStyle(color, alpha);
  g.lineStyle(strokeW, color, strokeAlpha);

  if (shape === 'circle') {
    g.fillCircle(0, 0, size);
    g.strokeCircle(0, 0, size);
  } else if (shape === 'square') {
    g.fillRect(-size, -size, size * 2, size * 2);
    g.strokeRect(-size, -size, size * 2, size * 2);
  } else if (shape === 'triangle') {
    g.fillTriangle(0, -size, size, size * 0.7, -size, size * 0.7);
    g.strokeTriangle(0, -size, size, size * 0.7, -size, size * 0.7);
  } else if (shape === 'hex') {
    const pts = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      pts.push(Math.cos(a) * size, Math.sin(a) * size);
    }
    g.fillPoints([
      {x: pts[0], y: pts[1]}, {x: pts[2], y: pts[3]}, {x: pts[4], y: pts[5]},
      {x: pts[6], y: pts[7]}, {x: pts[8], y: pts[9]}, {x: pts[10], y: pts[11]},
    ], true);
    for (let i = 0; i < 6; i++) {
      const nx = (i + 1) % 6;
      g.lineBetween(pts[i*2], pts[i*2+1], pts[nx*2], pts[nx*2+1]);
    }
  } else if (shape === 'diamond') {
    g.fillTriangle(-size, 0, 0, -size, size, 0);
    g.fillTriangle(-size, 0, 0, size, size, 0);
    g.strokeTriangle(-size, 0, 0, -size, size, 0);
    g.strokeTriangle(-size, 0, 0, size, size, 0);
  }
}

// DOM overlay container for enemy labels
const enemyLabelContainer = () => document.getElementById('enemy-labels');

function createEnemyDOMLabel(e) {
  const color = '#' + (ENEMY_COLORS[e.type] || 0xff4444).toString(16).padStart(6, '0');
  const emoji = ENEMY_EMOJIS[e.type] || '?';
  const div = document.createElement('div');
  div.className = 'enemy-label' + (e.isBoss ? ' boss' : '');
  div.id = `elabel-${e.id}`;
  div.innerHTML = `<span class="e-emoji">${emoji}</span><span class="e-name" style="color:${color}">${e.name}</span>`;
  enemyLabelContainer().appendChild(div);
  return div;
}

function moveEnemyDOMLabel(domLabel, x, y) {
  domLabel.style.left = x + 'px';
  domLabel.style.top = y + 'px';
}

function removeEnemyDOMLabel(enemyId) {
  const el = document.getElementById(`elabel-${enemyId}`);
  if (el) el.remove();
}

function spawnEnemySprite(e) {
  const color = ENEMY_COLORS[e.type] || 0xff0000;
  const isBoss = e.isBoss;
  const size = isBoss ? 22 : 18;
  const shape = ENEMY_SHAPES[e.type] || 'square';

  // Canvas: shape only
  const g = scene.add.graphics();
  drawEnemyShape(g, shape, size, color, isBoss);

  // Canvas: HP bar — placed well above the enemy shape so the DOM emoji doesn't cover it
  const barW = isBoss ? 56 : 44;
  const barY = -(size + 42);   // high enough to clear the 44px emoji overlay
  const barBg = scene.add.graphics();
  barBg.fillStyle(0x111111, 0.9);
  barBg.fillRect(-barW/2, barY, barW, 6);
  barBg.lineStyle(1, 0x333333, 1);
  barBg.strokeRect(-barW/2, barY, barW, 6);

  const barFill = scene.add.graphics();
  drawHpBar(barFill, e.hp, e.maxHp, barW, size);

  g.setPosition(e.x, e.y);
  barBg.setPosition(e.x, e.y);
  barFill.setPosition(e.x, e.y);

  // DOM: emoji + name label floating over the canvas
  const domLabel = createEnemyDOMLabel(e);
  moveEnemyDOMLabel(domLabel, e.x, e.y);

  enemiesOnCanvas[e.id] = { g, domLabel, barBg, barFill, barW, size, isBoss, type: e.type };
}

function moveEnemySprite(e) {
  const obj = enemiesOnCanvas[e.id];
  if (!obj) return;
  obj.g.setPosition(e.x, e.y);
  obj.barBg.setPosition(e.x, e.y);
  obj.barFill.setPosition(e.x, e.y);
  drawHpBar(obj.barFill, e.hp, e.maxHp, obj.barW, obj.size);
  moveEnemyDOMLabel(obj.domLabel, e.x, e.y);
}

function drawHpBar(g, hp, maxHp, barW, size) {
  g.clear();
  const pct = Math.max(0, hp / maxHp);
  const color = pct > 0.5 ? 0x00ff44 : pct > 0.25 ? 0xffaa00 : 0xff2222;
  g.fillStyle(color, 1);
  g.fillRect(-barW/2, -(size + 42), barW * pct, 6);
}

function removeEnemy(enemyId) {
  const obj = enemiesOnCanvas[enemyId];
  if (!obj) return;
  obj.g.destroy();
  obj.barBg.destroy();
  obj.barFill.destroy();
  removeEnemyDOMLabel(enemyId);
  delete enemiesOnCanvas[enemyId];
}

// ── Shooting effects ───────────────────────────
// ── Canvas tooltips ────────────────────────────
const ENEMY_DEFS = {
  unencrypted_bucket: { name:'Unencrypted Bucket', description:'S3/Blob storage with no encryption at rest — data exposed in plaintext',      weakTo:'HTTPS Enforcer, Encryption Vault' },
  naked_vm:           { name:'Naked VM',           description:'EC2/VM with a public IP and zero perimeter controls',                          weakTo:'Perimeter Wall, HTTPS Enforcer' },
  stale_key:          { name:'Stale Key',          description:'Key Vault key with no expiry — been rotating since 2019',                      weakTo:'Key Warden, Encryption Vault' },
  rogue_iam_user:     { name:'Rogue IAM User',     description:'IAM user created outside approved process — no MFA, wide permissions',         weakTo:'IAM Sentinel, Identity Gate' },
  anon_container:     { name:'Anon Container',     description:'Azure container registry with anonymous public read enabled',                   weakTo:'Identity Gate, IAM Sentinel' },
  unlogged_resource:  { name:'Unlogged Resource',  description:'Resource with no CloudTrail trail or log stream — invisible to defenders',     weakTo:'Watchtower, Tag & Region Lock' },
  shadow_admin:       { name:'Shadow Admin ☠ BOSS',description:'Escalated privileges operating entirely outside SCP boundaries',               weakTo:'IAM Sentinel, Watchtower, Identity Gate' },
  region_jumper:      { name:'Region Jumper 🌍 BOSS',description:'Workload deployed in a forbidden region, evading all controls',             weakTo:'Tag & Region Lock, Perimeter Wall, Watchtower' },
};

function updateCanvasTooltip(px, py, nativeEvent) {
  const col = Math.floor(px / CELL);
  const row = Math.floor(py / CELL);
  const tt = document.getElementById('tower-tooltip');

  // Check tower at cell
  const tower = gameState?.towers?.find(t => t.col === col && t.row === row);
  if (tower) {
    const def = TOWERS_DEF[tower.type];
    if (def) {
      const domColor = DOMAIN_COLORS[def.domain] || '#aaa';
      tt.innerHTML = `
        <strong style="color:${domColor}">${def.emoji} ${def.name}</strong>
        <div style="margin:4px 0">${def.description}</div>
        <div style="color:#555;font-size:0.68rem">${def.guardrails}</div>
        <div style="color:#888;font-size:0.68rem;margin-top:3px">Domain: ${def.domain} · Cost: ${def.cost}¢</div>
        <div style="color:#666;font-size:0.68rem">Owner: ${escHtml(tower.ownerName)}</div>
      `;
      positionTooltip(tt, nativeEvent);
      tt.style.display = 'block';
      return;
    }
  }

  // Check nearby enemy (within 22px radius of canvas position)
  for (const [id, obj] of Object.entries(enemiesOnCanvas)) {
    const ex = obj.g.x, ey = obj.g.y;
    if (Math.abs(px - ex) < 22 && Math.abs(py - ey) < 22) {
      const type = obj.type;
      const def = type ? ENEMY_DEFS[type] : null;
      if (def) {
        const color = '#' + (ENEMY_COLORS[type] || 0xff4444).toString(16).padStart(6, '0');
        const hpPct = obj.barFill ? '' : '';
        tt.innerHTML = `
          <strong style="color:${color}">${ENEMY_EMOJIS[type] || ''} ${def.name}</strong>
          <div style="margin:4px 0">${def.description}</div>
          <div style="color:#00ff88;font-size:0.68rem">⚡ Weak to: ${def.weakTo}</div>
        `;
        positionTooltip(tt, nativeEvent);
        tt.style.display = 'block';
        return;
      }
    }
  }

  tt.style.display = 'none';
}

function positionTooltip(tt, nativeEvent) {
  if (!nativeEvent) return;
  const x = nativeEvent.clientX || nativeEvent.pageX || 0;
  const y = nativeEvent.clientY || nativeEvent.pageY || 0;
  const w = tt.offsetWidth || 200;
  tt.style.left = Math.min(x + 14, window.innerWidth - w - 10) + 'px';
  tt.style.top = (y - 10) + 'px';
}

function hideCanvasTooltip() {
  document.getElementById('tower-tooltip').style.display = 'none';
}

function showShot({ towerId, enemyId, damage, multiplier, tx, ty, ex, ey }) {
  const color = multiplier >= 2 ? 0xffff00 : 0x00ff88;

  const line = scene.add.graphics();
  line.lineStyle(multiplier >= 2 ? 3 : 1, color, 0.9);
  line.lineBetween(tx, ty, ex, ey);

  // Flash on enemy
  const obj = enemiesOnCanvas[enemyId];
  if (obj) {
    scene.tweens.add({
      targets: obj.g,
      alpha: 0.2,
      duration: 80,
      yoyo: true,
      repeat: 1,
    });
  }

  // Damage number
  const dmgText = scene.add.text(ex, ey - 10, `-${damage}`, {
    font: `bold ${multiplier >= 2 ? 14 : 11}px Courier New`,
    color: multiplier >= 2 ? '#ffff00' : '#ffffff',
  }).setOrigin(0.5);

  scene.tweens.add({
    targets: dmgText,
    y: ey - 35,
    alpha: 0,
    duration: 700,
    onComplete: () => dmgText.destroy(),
  });

  scene.time.delayedCall(150, () => line.destroy());
}

// ── Lives flash ────────────────────────────────
function flashLives() {
  const el = document.getElementById('lives-val');
  el.style.color = '#ff0000';
  el.style.textShadow = '0 0 10px #ff0000';
  setTimeout(() => { el.style.color = '#ff4444'; el.style.textShadow = ''; }, 600);
}

// ── Scene control ──────────────────────────────
function stopAll() { /* enemy updates will stop from server */ }

function resetScene(state) {
  // Clear all sprites and DOM labels
  Object.keys(towersOnCanvas).forEach(removeTower);
  Object.keys(enemiesOnCanvas).forEach(removeEnemy);
  // Wipe any remaining DOM labels that may have been orphaned
  const container = enemyLabelContainer();
  if (container) container.innerHTML = '';
  towersOnCanvas = {};
  enemiesOnCanvas = {};
  if (state.towers) state.towers.forEach(renderTower);
  hideOverlay();
  syncUI();
}
