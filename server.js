const express = require('express');
const http = require('node:http');
const socketIo = require('socket.io');
const path = require('node:path');

const DEV_MODE = process.env.DEV === 'true';
const MIN_PLAYERS = DEV_MODE ? 1 : 2;
console.log(`DEV_MODE=${DEV_MODE} (process.env.DEV="${process.env.DEV}") MIN_PLAYERS=${MIN_PLAYERS}`);

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: '*' }
});

// Serve static files from 'public' folder
app.use(express.static(path.join(__dirname, 'public')));

// Game state
const games = new Map();
const playerSockets = new Map();

// Game configuration
const GAME_CONFIG = {
  CRYSTAL_COUNT: 30,
  HAZARD_COUNT: 12,
  GAME_DURATION: 120000,       // 2 minutes
  CRYSTAL_RESPAWN_TIME: 5000,
  POWERUP_SPAWN_INTERVAL: 8000,
  HAZARD_SPEED: 0.08,          // % per tick at 60fps — slow enough to dodge
  COLLISION_RADIUS_CRYSTAL: 3.5,
  COLLISION_RADIUS_HAZARD: 3,
  COLLISION_RADIUS_POWERUP: 3.5,
  MAGNET_RADIUS: 15,           // % units — magnet pull range
  MAGNET_SPEED: 0.3            // how fast crystals move toward magnetised player
};

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function randomId() {
  return Math.random().toString(36).substr(2, 9);
}

// Always produces exactly 6 uppercase alphanumeric characters (A-Z0-9)
function generateGameId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // omit O,0,I,1 to avoid confusion
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---------------------------------------------------------------------------
// Game class
// ---------------------------------------------------------------------------
class Game {
  constructor(gameId) {
    this.id = gameId;
    this.players = new Map();
    this.crystals = [];
    this.hazards = [];
    this.powerups = [];
    this.state = 'waiting';
    this.startTime = null;
    this.endTime = null;
    this.leadPlayer = null;
    this.lastUpdate = Date.now();
    this.lastPowerupSpawn = 0;
    this.initializeGameObjects();
  }

  initializeGameObjects() {
    for (let i = 0; i < GAME_CONFIG.CRYSTAL_COUNT; i++) {
      this.crystals.push(this.createCrystal());
    }
    for (let i = 0; i < GAME_CONFIG.HAZARD_COUNT; i++) {
      this.hazards.push(this.createHazard());
    }
  }

  createCrystal() {
    return {
      id: randomId(),
      x: Math.random() * 86 + 7,
      y: Math.random() * 86 + 7,
      value: Math.random() > 0.7 ? 5 : 1,
      collected: false
    };
  }

  createHazard() {
    return {
      id: randomId(),
      x: Math.random() * 86 + 7,
      y: Math.random() * 86 + 7,
      type: Math.random() > 0.4 ? 'moving' : 'static',
      direction: Math.random() * Math.PI * 2,
      speed: GAME_CONFIG.HAZARD_SPEED * (0.7 + Math.random() * 0.6)
    };
  }

  createPowerup() {
    const types = ['speed', 'shield', 'magnet'];
    return {
      id: randomId(),
      x: Math.random() * 80 + 10,
      y: Math.random() * 80 + 10,
      type: types[Math.floor(Math.random() * types.length)],
      collected: false
    };
  }

  addPlayer(socketId, name) {
    const palette = ['#FF6B6B', '#4ECDC4', '#FFD93D', '#A78BFA', '#FB923C', '#34D399'];
    const usedColors = new Set([...this.players.values()].map(p => p.color));
    const color = palette.find(c => !usedColors.has(c)) ?? palette[0];

    const spawnPositions = [
      { x: 20, y: 20 },
      { x: 80, y: 20 },
      { x: 20, y: 80 },
      { x: 80, y: 80 }
    ];
    const pos = spawnPositions[this.players.size] || { x: 50, y: 50 };

    const player = {
      id: socketId,
      name,
      x: pos.x,
      y: pos.y,
      color,
      score: 0,
      lives: 3,
      powerup: null,
      powerupEndTime: null,
      invincibleUntil: 0  // brief invincibility after being hit
    };

    this.players.set(socketId, player);
    if (!this.leadPlayer) this.leadPlayer = socketId;
    return player;
  }

  removePlayer(socketId) {
    this.players.delete(socketId);
    if (this.leadPlayer === socketId && this.players.size > 0) {
      this.leadPlayer = this.players.keys().next().value;
    }
  }

  startGame() {
    this.state = 'playing';
    this.startTime = Date.now();
    this.endTime = this.startTime + GAME_CONFIG.GAME_DURATION;
    this.lastPowerupSpawn = this.startTime;
  }

  pauseGame() {
    if (this.state === 'playing') {
      this.state = 'paused';
      this.pausedTimeRemaining = this.endTime - Date.now();
    }
  }

  resumeGame() {
    if (this.state === 'paused') {
      this.state = 'playing';
      this.endTime = Date.now() + this.pausedTimeRemaining;
    }
  }

  endGame() {
    this.state = 'finished';
  }

  getWinner() {
    // Winner is highest score, regardless of lives (they may have died but scored most)
    let best = null;
    this.players.forEach(p => {
      if (!best || p.score > best.score) best = p;
    });
    // Return null if tied
    const tied = [...this.players.values()].filter(p => p.score === best?.score);
    return tied.length > 1 ? null : best;
  }

  updatePlayerPosition(socketId, x, y) {
    const player = this.players.get(socketId);
    if (!player) return null;
    player.x = Math.max(1, Math.min(99, x));
    player.y = Math.max(1, Math.min(99, y));
    return player;
  }

  // --- Collision helpers ---

  #collectCrystals(player, events) {
    for (const crystal of this.crystals) {
      if (crystal.collected) continue;
      if (distance(player, crystal) < GAME_CONFIG.COLLISION_RADIUS_CRYSTAL) {
        crystal.collected = true;
        player.score += crystal.value;
        events.push({ type: 'crystal', value: crystal.value });
        setTimeout(() => {
          const idx = this.crystals.indexOf(crystal);
          if (idx !== -1) this.crystals[idx] = this.createCrystal();
        }, GAME_CONFIG.CRYSTAL_RESPAWN_TIME);
      }
    }
  }

  #checkHazard(player, now, events) {
    if (player.powerup === 'shield' || now <= player.invincibleUntil) return;
    for (const hazard of this.hazards) {
      if (distance(player, hazard) < GAME_CONFIG.COLLISION_RADIUS_HAZARD) {
        player.lives = Math.max(0, player.lives - 1);
        player.invincibleUntil = now + 2000;
        const corners = [
          { x: 20, y: 20 }, { x: 80, y: 20 },
          { x: 20, y: 80 }, { x: 80, y: 80 }
        ];
        const safe = corners[Math.floor(Math.random() * corners.length)];
        player.x = safe.x;
        player.y = safe.y;
        events.push({ type: 'hazard' });
        break;
      }
    }
  }

  #collectPowerup(player, now, events) {
    for (const powerup of this.powerups) {
      if (powerup.collected) continue;
      if (distance(player, powerup) < GAME_CONFIG.COLLISION_RADIUS_POWERUP) {
        powerup.collected = true;
        player.powerup = powerup.type;
        player.powerupEndTime = now + 10000;
        events.push({ type: 'powerup', powerupType: powerup.type });
        break;
      }
    }
  }

  // Returns an array of collision events to send to the client
  checkCollisions(socketId) {
    const player = this.players.get(socketId);
    if (!player) return [];

    const now = Date.now();
    const events = [];

    this.#collectCrystals(player, events);
    this.#checkHazard(player, now, events);
    this.#collectPowerup(player, now, events);

    return events;
  }

  update() {
    if (this.state !== 'playing') return;

    const now = Date.now();

    // Check if all players have 0 lives (game over)
    const alivePlayers = [...this.players.values()].filter(p => p.lives > 0);
    if (alivePlayers.length === 0) {
      this.endGame();
      return;
    }

    // Time's up?
    if (now >= this.endTime) {
      this.endGame();
      return;
    }

    // --- Move hazards ---
    for (const hazard of this.hazards) {
      if (hazard.type !== 'moving') continue;
      hazard.x += Math.cos(hazard.direction) * hazard.speed;
      hazard.y += Math.sin(hazard.direction) * hazard.speed;

      if (hazard.x < 5 || hazard.x > 95) {
        hazard.direction = Math.PI - hazard.direction;
        hazard.x = Math.max(5, Math.min(95, hazard.x));
      }
      if (hazard.y < 5 || hazard.y > 95) {
        hazard.direction = -hazard.direction;
        hazard.y = Math.max(5, Math.min(95, hazard.y));
      }
    }

    // --- Magnet powerup: pull nearby uncollected crystals toward player ---
    this.players.forEach(player => {
      if (player.powerup !== 'magnet') return;
      for (const crystal of this.crystals) {
        if (crystal.collected) continue;
        const dist = distance(player, crystal);
        if (dist < GAME_CONFIG.MAGNET_RADIUS && dist > 0.1) {
          const pull = GAME_CONFIG.MAGNET_SPEED;
          crystal.x += ((player.x - crystal.x) / dist) * pull;
          crystal.y += ((player.y - crystal.y) / dist) * pull;
        }
      }
    });

    // --- Expire powerups ---
    this.players.forEach(player => {
      if (player.powerupEndTime && now >= player.powerupEndTime) {
        player.powerup = null;
        player.powerupEndTime = null;
      }
    });

    // --- Spawn powerup periodically ---
    const activePowerups = this.powerups.filter(p => !p.collected).length;
    if (activePowerups < 3 && now - this.lastPowerupSpawn > GAME_CONFIG.POWERUP_SPAWN_INTERVAL) {
      this.powerups.push(this.createPowerup());
      this.lastPowerupSpawn = now;
    }

    // Remove collected powerups from array
    this.powerups = this.powerups.filter(p => !p.collected);

    this.lastUpdate = now;
  }

  getState() {
    return {
      id: this.id,
      state: this.state,
      players: [...this.players.values()],
      crystals: this.crystals.filter(c => !c.collected),
      hazards: this.hazards,
      powerups: this.powerups.filter(p => !p.collected),
      leadPlayer: this.leadPlayer,
      timeRemaining: this.state === 'playing' ? Math.max(0, this.endTime - Date.now()) : (this.pausedTimeRemaining || 0),
      winner: this.state === 'finished' ? this.getWinner() : null,
      devMode: DEV_MODE,
      minPlayers: MIN_PLAYERS
    };
  }
}

// ---------------------------------------------------------------------------
// Socket.IO
// ---------------------------------------------------------------------------
io.on('connection', (socket) => {
  console.log('Connected:', socket.id);

  socket.on('createGame', (playerName, callback) => {
    if (typeof playerName !== 'string' || !playerName.trim()) {
      return callback({ success: false, error: 'Invalid name' });
    }
    const name = playerName.trim().substring(0, 12);
    const gameId = generateGameId();
    const game = new Game(gameId);
    const player = game.addPlayer(socket.id, name);

    games.set(gameId, game);
    playerSockets.set(socket.id, gameId);
    socket.join(gameId);

    console.log(`[createGame] id="${gameId}" host="${name}"`);

    callback({ success: true, gameId, player });
    io.to(gameId).emit('gameState', game.getState());
  });

  socket.on('joinGame', (data, callback) => {
    const { gameId, playerName } = data || {};
    if (!gameId || !playerName) {
      return callback({ success: false, error: 'Missing data' });
    }
    const name = String(playerName).trim().substring(0, 12);
    const lookupKey = String(gameId).trim().toUpperCase();
    console.log(`[joinGame] lookup="${lookupKey}" found=${games.has(lookupKey)} keys=[${[...games.keys()].join(',')}]`);
    const game = games.get(lookupKey);

    if (!game) return callback({ success: false, error: 'Game not found' });
    if (game.state !== 'waiting') return callback({ success: false, error: 'Game already started' });
    if (game.players.size >= 4) return callback({ success: false, error: 'Game is full (max 4)' });
    if ([...game.players.values()].some(p => p.name === name)) {
      return callback({ success: false, error: 'Name already taken' });
    }

    const player = game.addPlayer(socket.id, name);
    playerSockets.set(socket.id, lookupKey);
    socket.join(lookupKey);

    callback({ success: true, gameId: lookupKey, player });
    io.to(lookupKey).emit('gameState', game.getState());
    io.to(lookupKey).emit('playerJoined', { playerName: name });
  });

  socket.on('startGame', () => {
    const gameId = playerSockets.get(socket.id);
    const game = games.get(gameId);
    if (!game || game.leadPlayer !== socket.id) return;
    if (game.players.size < MIN_PLAYERS) {
      return socket.emit('serverError', `Need at least ${MIN_PLAYERS} player${MIN_PLAYERS > 1 ? 's' : ''} to start`);
    }
    game.startGame();
    io.to(gameId).emit('gameStarted');
    io.to(gameId).emit('gameState', game.getState());
  });

  socket.on('playerMove', (data) => {
    const gameId = playerSockets.get(socket.id);
    const game = games.get(gameId);
    if (!game || game.state !== 'playing') return;

    const player = game.updatePlayerPosition(socket.id, data.x, data.y);
    if (!player) return;

    const events = game.checkCollisions(socket.id);

    // Only emit state — the server loop handles regular broadcasts.
    // Emit immediately only when there are collision events so clients
    // see score/lives update without waiting for next tick.
    if (events.length > 0) {
      io.to(gameId).emit('collisionEvents', { playerId: socket.id, events });
      io.to(gameId).emit('gameState', game.getState());
    }
  });

  socket.on('pauseGame', () => {
    const gameId = playerSockets.get(socket.id);
    const game = games.get(gameId);
    if (!game || game.state !== 'playing') return;
    const player = game.players.get(socket.id);
    if (!player) return;
    game.pauseGame();
    io.to(gameId).emit('gamePaused', { playerName: player.name });
    io.to(gameId).emit('gameState', game.getState());
  });

  socket.on('resumeGame', () => {
    const gameId = playerSockets.get(socket.id);
    const game = games.get(gameId);
    if (!game || game.state !== 'paused') return;
    const player = game.players.get(socket.id);
    if (!player) return;
    game.resumeGame();
    io.to(gameId).emit('gameResumed', { playerName: player.name });
    io.to(gameId).emit('gameState', game.getState());
  });

  socket.on('quitGame', () => {
    const gameId = playerSockets.get(socket.id);
    const game = games.get(gameId);
    if (!game) return;
    const player = game.players.get(socket.id);
    if (player) {
      io.to(gameId).emit('playerQuit', { playerName: player.name });
    }
    handleDisconnect(socket);
  });

  socket.on('chatMessage', (text) => {
    const gameId = playerSockets.get(socket.id);
    const game = games.get(gameId);
    if (!game) return;
    const player = game.players.get(socket.id);
    if (!player) return;
    const safe = String(text).substring(0, 100).replaceAll('<', '').replaceAll('>', '');
    io.to(gameId).emit('chatMessage', { playerName: player.name, color: player.color, text: safe });
  });

  socket.on('disconnect', () => handleDisconnect(socket));

  function handleDisconnect(socket) {
    const gameId = playerSockets.get(socket.id);
    const game = games.get(gameId);
    if (game) {
      const player = game.players.get(socket.id);
      game.removePlayer(socket.id);
      if (game.players.size === 0) {
        games.delete(gameId);
      } else {
        if (player) io.to(gameId).emit('playerLeft', { playerName: player.name });
        io.to(gameId).emit('gameState', game.getState());
      }
    }
    playerSockets.delete(socket.id);
    console.log('Disconnected:', socket.id);
  }
});

const SERVER_TICK_RATE = 1000 / 20; // 20 updates/s to avoid bandwidth flood

setInterval(() => {
  games.forEach((game, gameId) => {
    if (game.state === 'playing') {
      game.update();
      io.to(gameId).emit('gameState', game.getState());
    }
    if (game.state === 'finished') {
      io.to(gameId).emit('gameState', game.getState());
    }
  });
}, SERVER_TICK_RATE);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Crystal Clash server running on port ${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser`);
  if (DEV_MODE) {
    console.log('⚠️  DEV MODE — single player start enabled');
  }
});