// ─────────────────────────────────────────────
//  GUARDRAIL TD  —  Express + Socket.io Server
// ─────────────────────────────────────────────
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { GameEngine } = require('./gameEngine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const engine = new GameEngine(io);

io.on('connection', (socket) => {
  console.log(`[+] connected: ${socket.id}`);

  // Send current state immediately on join
  socket.emit('state_update', engine.getPublicState());

  socket.on('join', ({ name }) => {
    engine.addPlayer(socket.id, name);
    console.log(`[+] joined: ${name} (${socket.id})`);
  });

  socket.on('start_game', () => {
    const result = engine.startGameByHost(socket.id);
    if (!result.ok) socket.emit('error_msg', result.error);
  });

  socket.on('skip_planning', () => {
    const result = engine.skipPlanningByHost(socket.id);
    if (!result.ok) socket.emit('error_msg', result.error);
  });

  socket.on('next_wave', () => {
    const result = engine.nextWaveByHost(socket.id);
    if (!result.ok) socket.emit('error_msg', result.error);
  });

  socket.on('reset_game', () => {
    const result = engine.resetGame(socket.id);
    if (!result.ok) socket.emit('error_msg', result.error);
  });

  socket.on('set_speed', ({ multiplier }) => {
    const result = engine.setSpeedByHost(socket.id, multiplier);
    if (!result.ok) socket.emit('error_msg', result.error);
  });

  socket.on('place_tower', (data, callback) => {
    const result = engine.placeTower(socket.id, data);
    if (callback) callback(result);
  });

  socket.on('sell_tower', ({ towerId }, callback) => {
    const result = engine.sellTower(socket.id, towerId);
    if (callback) callback(result);
  });

  socket.on('disconnect', () => {
    console.log(`[-] disconnected: ${socket.id}`);
    engine.removePlayer(socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  Guardrail TD server running on http://localhost:${PORT}\n`);
});
