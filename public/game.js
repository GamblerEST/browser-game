'use strict';

let socket;
let gameId;
let currentPlayer;
let gameState = null;
let animationFrameId = null;

const keys = {};
const renderedObjects = new Map();

let localX = 0;
let localY = 0;
let localInitialised = false;

const PLAYER_SPEED_PX = 300;

let lastMoveSent = 0;
const MOVE_SEND_INTERVAL = 50;

let arenaW = 0;
let arenaH = 0;

function refreshArenaDimensions() {
  const arena = document.getElementById('gameArena');
  const newW = arena.clientWidth;
  const newH = arena.clientHeight;
  
  if (localInitialised && arenaW > 0 && arenaH > 0 && (newW !== arenaW || newH !== arenaH)) {
    const pctX = localX / arenaW;
    const pctY = localY / arenaH;
    localX = pctX * newW;
    localY = pctY * newH;
  }
  
  arenaW = newW;
  arenaH = newH;
}

let lastTimerTick = -1;

let frameCount = 0;
let lastFpsUpdate = 0;
let lastFrameTime = 0;
initSocket();
let audioCtx = null;

function getAudioCtx() {
  if (!audioCtx) {
    const Cls = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    audioCtx = new Cls();
  }
  return audioCtx;
}

function createTone(freq, duration, type = 'sine', volume = 0.25) {
  try {
    const ctx  = getAudioCtx();
    const osc  = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = freq;
    osc.type = type;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
  } catch (e) {
    console.warn('Audio playback failed:', e.message);
  }
}

function playSound(soundType) {
  const t = (delay, f, d, type, vol) =>
    setTimeout(() => createTone(f, d, type, vol), delay);
  switch (soundType) {
    case 'join':    t(0, 440, .12); t(80, 554, .1); break;
    case 'start':   t(0, 523, .15); t(120, 659, .15); t(250, 784, .25); break;
    case 'collect': t(0, 880, .08, 'square', .2); break;
    case 'hit':     t(0, 180, .18, 'sawtooth', .3); t(80, 120, .12, 'sawtooth', .2); break;
    case 'powerup': t(0, 660, .1); t(60, 880, .1); t(120, 1100, .18); break;
    case 'win':     t(0, 523, .2); t(160, 659, .2); t(320, 784, .25); t(500, 1047, .4); break;
    case 'tick':    t(0, 1200, .06, 'sine', .15); break;
  }
}
function initSocket() {
  socket = io();

  socket.on('connect', () => console.log('Connected', socket.id));

  socket.on('gameState', (state) => {
    const prev = gameState ? gameState.state : null;
    gameState   = state;

    if (prev !== 'playing' && state.state === 'playing') {
      showScreen('game');
      startGameLoop();
    } else if (state.state === 'finished' && prev !== 'finished') {
      showEndScreen();
    } else if (state.state === 'playing') {
      // Check if local player was eliminated BUT other players are still alive
      const me = state.players.find(p => p.id === currentPlayer?.id);
      const alivePlayers = state.players.filter(p => p.lives > 0);
      // Only show eliminated overlay if: (1) I'm dead, (2) others are alive, (3) overlay not already shown
      if (me && me.lives <= 0 && alivePlayers.length > 0 && document.getElementById('endOverlay').hidden) {
        showEliminatedOverlay();
      }
    }

    updateUI();
  });

  socket.on('collisionEvents', ({ playerId, events }) => {
    if (playerId !== currentPlayer?.id) return;
    events.forEach(ev => {
      if (ev.type === 'crystal') playSound('collect');
      if (ev.type === 'hazard')  playSound('hit');
      if (ev.type === 'powerup') playSound('powerup');
    });
  });

  socket.on('playerJoined', ({ playerName }) => {
    showNotification(`⚔️ ${playerName} joined the battle!`);
    playSound('join');
    updateLobbyPlayerCount();
  });

  socket.on('playerLeft',  ({ playerName }) => showNotification(`${playerName} left`));
  socket.on('playerQuit',  ({ playerName }) => showNotification(`${playerName} quit`));

  socket.on('gameStarted', () => {
    playSound('start');
    showNotification('⚡ Battle begins!', 2500);
  });

  socket.on('gamePaused', ({ playerName }) => {
    showNotification(`⏸ ${playerName} paused the game`);
    document.getElementById('gameMenu').hidden = false;
  });

  socket.on('gameResumed', ({ playerName }) => {
    showNotification(`▶ ${playerName} resumed the game`);
    document.getElementById('gameMenu').hidden = true;
  });

  socket.on('serverError', (msg) => {
    document.getElementById('startError').textContent = msg;
    setTimeout(() => { document.getElementById('startError').textContent = ''; }, 4000);
  });

  socket.on('chatMessage', ({ playerName, color, text }) => {
    appendChatMessage(playerName, color, text);
  });
}
const screens = {
  join:  document.getElementById('joinScreen'),
  lobby: document.getElementById('lobbyScreen'),
  game:  document.getElementById('gameScreen'),
  end:   document.getElementById('endScreen')
};

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}
document.getElementById('createBtn').addEventListener('click', handleCreate);
document.getElementById('joinBtn').addEventListener('click', handleJoin);

document.getElementById('playerName').addEventListener('keypress', e => {
  if (e.key === 'Enter') handleCreate();
});
document.getElementById('gameIdInput').addEventListener('keypress', e => {
  if (e.key === 'Enter') handleJoin();
});
document.getElementById('gameIdInput').addEventListener('input', function () {
  this.value = this.value.toUpperCase();
});

function getPlayerName() {
  return document.getElementById('playerName').value.trim();
}

function handleCreate() {
  getAudioCtx();
  const name = getPlayerName();
  if (!name) { showError('Please enter your name first'); return; }
  socket.emit('createGame', name, (res) => {
    if (res.success) {
      gameId = res.gameId;
      currentPlayer = res.player;
      showLobby(true);
      playSound('join');
    } else {
      showError(res.error || 'Could not create game');
    }
  });
}

function handleJoin() {
  getAudioCtx();
  const name = getPlayerName();
  const gid  = document.getElementById('gameIdInput').value.trim().toUpperCase();
  if (!name)          { showError('Please enter your name first'); return; }
  if (!gid)           { showError('Please enter a Game ID to join'); return; }
  if (gid.length < 6) { showError('Game ID must be 6 characters'); return; }
  socket.emit('joinGame', { gameId: gid, playerName: name }, (res) => {
    if (res.success) {
      gameId = res.gameId;
      currentPlayer = res.player;
      showLobby(false);
      playSound('join');
    } else {
      showError(res.error);
    }
  });
}
function showLobby(isHost) {
  showScreen('lobby');
  document.getElementById('displayGameId').textContent = gameId;
  if (isHost) document.getElementById('startGameContainer').style.display = 'block';
  if (gameState?.devMode) document.getElementById('devModeBadge').style.display = 'block';
}

function updateLobbyPlayerCount() {
  if (!gameState) return;
  document.getElementById('playerCount').textContent = `(${gameState.players.length}/4)`;
}

document.getElementById('copyIdBtn').addEventListener('click', () => {
  navigator.clipboard?.writeText(gameId).then(() => {
    const btn = document.getElementById('copyIdBtn');
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⎘'; }, 1500);
  });
});

document.getElementById('startGameBtn').addEventListener('click', () => {
  socket.emit('startGame');
});
document.getElementById('menuBtn').addEventListener('click', () => {
  if (gameState?.state === 'playing') socket.emit('pauseGame');
});
document.getElementById('resumeBtn').addEventListener('click', () => {
  socket.emit('resumeGame');
});
document.getElementById('quitBtn').addEventListener('click', () => {
  socket.emit('quitGame');
  setTimeout(() => location.reload(), 200);
});
document.addEventListener('keydown', (e) => {
  const chatFocused = document.activeElement === document.getElementById('chatInput');

  // Only hijack game keys when the chat box is not active
  if (!chatFocused) {
    keys[e.key.toLowerCase()] = true;
    if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight',' '].includes(e.key)) {
      e.preventDefault();
    }
    if (e.key === 'Escape') {
      if (gameState?.state === 'playing')     socket.emit('pauseGame');
      else if (gameState?.state === 'paused') socket.emit('resumeGame');
    }
  }

  if (e.key === 'Enter' && chatFocused) {
    sendChat();
  }
});
document.addEventListener('keyup', (e) => {
  if (document.activeElement !== document.getElementById('chatInput')) {
    keys[e.key.toLowerCase()] = false;
  }
});

// Refresh arena size on window resize
window.addEventListener('resize', () => {
  refreshArenaDimensions();
  checkViewportSize();
});

// Check viewport size and show warning if too small
function checkViewportSize() {
  const minW = 800;
  const minH = 600;
  const w = window.innerWidth;
  const h = window.innerHeight;
  const warning = document.getElementById('viewportWarning');
  const sizeSpan = document.getElementById('currentSize');
  
  if (w < minW || h < minH) {
    warning.classList.add('show');
    sizeSpan.textContent = `${w}×${h}`;
  } else {
    warning.classList.remove('show');
  }
}

// Check on load and after resize
checkViewportSize();
function updateUI() {
  if (!gameState) return;
  if (gameState.state === 'waiting') {
    updatePlayersList();
    updateLobbyPlayerCount();
  }
  if (gameState.state === 'playing' || gameState.state === 'paused') {
    updateTimer();
    updateScores();
  }
}

function updatePlayersList() {
  const list = document.getElementById('playersList');
  list.innerHTML = '';
  gameState.players.forEach(p => {
    const card = document.createElement('div');
    card.className = 'player-card';
    card.style.borderColor = p.color;
    card.innerHTML = `
      <div class="player-card-name">${escapeHtml(p.name)}</div>
      <div class="player-card-status">${p.id === gameState.leadPlayer ? '⭐ Host' : 'Ready'}</div>`;
    list.appendChild(card);
  });

  document.getElementById('devModeBadge').style.display = gameState.devMode ? 'block' : 'none';
  const statusEl = document.getElementById('lobbyStatusMsg');
  const min = gameState.minPlayers ?? 2;
  const count = gameState.players.length;
  if (gameState.devMode) {
    statusEl.innerHTML = '🛠️ <strong>DEV MODE</strong> — you can start with 1 player';
  } else if (count < min) {
    statusEl.textContent = `Waiting for players… (need ${min - count} more)`;
  } else {
    statusEl.textContent = 'All players ready — host can start!';
  }
}

function updateTimer() {
  const ms = gameState.timeRemaining ?? 0;
  const totalSecs = Math.ceil(ms / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const el = document.getElementById('timer');
  el.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  if (totalSecs <= 15) {
    el.classList.add('urgent');
    if (totalSecs <= 10 && secs !== lastTimerTick) {
      playSound('tick');
      lastTimerTick = secs;
    }
  } else {
    el.classList.remove('urgent');
  }
}

function updateScores() {
  const list = document.getElementById('scoresList');
  list.innerHTML = '';
  const sorted = [...gameState.players].sort((a, b) => b.score - a.score);
  sorted.forEach(p => {
    const item = document.createElement('div');
    item.className = 'score-item';
    item.style.borderColor = p.color;
    if (p.id === currentPlayer?.id) {
      item.classList.add('current-player');
      item.style.boxShadow = `0 0 16px ${p.color}`;
    }
    // Mark eliminated players
    if (p.lives <= 0) {
      item.classList.add('eliminated');
    }
    const hearts = p.lives > 0 ? '❤️'.repeat(p.lives) + '🖤'.repeat(Math.max(0, 3 - p.lives)) : '💀';
    const powerupIcons = { speed: ' ►', shield: ' ■', magnet: ' ◆' };
    const powerIcon = powerupIcons[p.powerup] ?? '';
    item.innerHTML = `
      <span class="score-player-name" style="color:${p.color}">${escapeHtml(p.name)}${powerIcon}</span>
      <span class="score-value">${p.score}</span>
      <span class="score-lives">${hearts}</span>`;
    list.appendChild(item);
  });
}
function startGameLoop() {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }

  document.getElementById('gameMenu').hidden = true;
  refreshArenaDimensions();

  const me = gameState.players.find(p => p.id === currentPlayer.id);
  if (me) {
    localX = (me.x / 100) * arenaW;
    localY = (me.y / 100) * arenaH;
  }
  localInitialised = true;

  lastTimerTick = -1;
  lastFrameTime = performance.now();
  animationFrameId = requestAnimationFrame(gameLoop);
}

function gameLoop(timestamp) {
  // Cap delta to 100ms so a tab-switch or slow frame doesn't teleport the player
  const deltaTime = Math.min(timestamp - lastFrameTime, 100);
  lastFrameTime = timestamp;

  frameCount++;
  if (timestamp - lastFpsUpdate >= 1000) {
    frameCount = 0;
    lastFpsUpdate = timestamp;
  }

  if (gameState?.state === 'playing') {
    handleInput(deltaTime, timestamp);
    render();
  }

  animationFrameId = requestAnimationFrame(gameLoop);
}
function handleInput(deltaTime, now) {
  if (!currentPlayer || !gameState || !localInitialised) return;
  if (document.activeElement === document.getElementById('chatInput')) return;

  let dx = 0;
  let dy = 0;
  if (keys['w'] || keys['arrowup'])    dy -= 1;
  if (keys['s'] || keys['arrowdown'])  dy += 1;
  if (keys['a'] || keys['arrowleft'])  dx -= 1;
  if (keys['d'] || keys['arrowright']) dx += 1;

  if (dx === 0 && dy === 0) return;

  // Normalise diagonal so it's the same speed as cardinal directions
  if (dx !== 0 && dy !== 0) {
    dx *= (1 / Math.SQRT2);
    dy *= (1 / Math.SQRT2);
  }

  // Speed powerup multiplier from server state
  const serverMe = gameState.players.find(p => p.id === currentPlayer.id);
  const speedMult = serverMe?.powerup === 'speed' ? 1.6 : 1;

  // Move in pixels — same unit on both axes
  const dist = PLAYER_SPEED_PX * speedMult * (deltaTime / 1000);
  const margin = 20; // keep player inside arena by this many px

  localX = Math.max(margin, Math.min(arenaW - margin, localX + dx * dist));
  localY = Math.max(margin, Math.min(arenaH - margin, localY + dy * dist));

  // Convert to % for the server
  const pctX = (localX / arenaW) * 100;
  const pctY = (localY / arenaH) * 100;

  if (now - lastMoveSent >= MOVE_SEND_INTERVAL) {
    socket.emit('playerMove', { x: pctX, y: pctY });
    lastMoveSent = now;
  }
}
// All elements sit at left:0 top:0 in CSS, and are positioned via
// transform:translate(px,px) which is GPU-composited and never triggers layout.
// The CSS margin:-halfSize centres each element on its coordinate point.

function pctToPx(pct, total) {
  return (pct / 100) * total;
}

// Half-sizes for centering each object type on its coordinate point
const HALF = { player: 20, crystal: 9, crystalHigh: 13, hazard: 15, powerup: 16 };

function render() {
  if (!gameState || !localInitialised) return;

  const arena = document.getElementById('gameObjects');
  const live  = new Set();

  // ── Local player: use client-side pixel position ──
  const localPlayerData = gameState.players.find(p => p.id === currentPlayer.id);
  if (localPlayerData) {
    const eid = `player-${localPlayerData.id}`;
    live.add(eid);
    let el = renderedObjects.get(eid);
    if (!el) {
      el = createPlayerElement(localPlayerData);
      arena.appendChild(el);
      renderedObjects.set(eid, el);
    }
    // localX/Y is px from arena top-left; subtract half-size to centre the element
    el.style.transform = `translate(${localX - HALF.player}px, ${localY - HALF.player}px)`;
    stylePlayer(el, localPlayerData);
  }

  // ── Remote players: use server % → px via transform ──
  gameState.players.forEach(p => {
    if (p.id === currentPlayer.id) return;
    const eid = `player-${p.id}`;
    live.add(eid);
    let el = renderedObjects.get(eid);
    if (!el) {
      el = createPlayerElement(p);
      arena.appendChild(el);
      renderedObjects.set(eid, el);
    }
    el.style.transform = `translate(${pctToPx(p.x, arenaW) - HALF.player}px, ${pctToPx(p.y, arenaH) - HALF.player}px)`;
    stylePlayer(el, p);
  });

  // ── Crystals: use left/top % so CSS transform animations work freely ──
  gameState.crystals.forEach(c => {
    const eid = `crystal-${c.id}`;
    live.add(eid);
    let el = renderedObjects.get(eid);
    if (!el) {
      el = document.createElement('div');
      el.className = c.value > 1 ? 'crystal high-value' : 'crystal';
      arena.appendChild(el);
      renderedObjects.set(eid, el);
    }
    el.style.left = `${c.x}%`;
    el.style.top  = `${c.y}%`;
  });

  // ── Hazards: use left/top % ──
  gameState.hazards.forEach(h => {
    const eid = `hazard-${h.id}`;
    live.add(eid);
    let el = renderedObjects.get(eid);
    if (!el) {
      el = document.createElement('div');
      el.className = 'hazard';
      arena.appendChild(el);
      renderedObjects.set(eid, el);
    }
    el.style.left = `${h.x}%`;
    el.style.top  = `${h.y}%`;
  });

  // ── Powerups: use left/top % ──
  gameState.powerups.forEach(pu => {
    const eid = `powerup-${pu.id}`;
    live.add(eid);
    let el = renderedObjects.get(eid);
    if (!el) {
      el = document.createElement('div');
      el.className = 'powerup';
      el.setAttribute('aria-label', pu.type + ' powerup');
      const icons = { speed: '►', shield: '■', magnet: '◆' };
      el.textContent = icons[pu.type] ?? '?';
      arena.appendChild(el);
      renderedObjects.set(eid, el);
    }
    el.style.left = `${pu.x}%`;
    el.style.top  = `${pu.y}%`;
  });

  // ── Remove stale elements ──
  renderedObjects.forEach((el, id) => {
    if (!live.has(id)) {
      el.remove();
      renderedObjects.delete(id);
    }
  });
}

function createPlayerElement(p) {
  const el = document.createElement('div');
  el.className = 'player';
  const nameEl = document.createElement('div');
  nameEl.className = 'player-name';
  nameEl.textContent = p.name;
  const initEl = document.createElement('span');
  initEl.className = 'player-initial';
  initEl.textContent = p.name.charAt(0).toUpperCase();
  el.appendChild(nameEl);
  el.appendChild(initEl);
  return el;
}

function stylePlayer(el, p) {
  el.style.backgroundColor = p.color;
  el.style.borderColor     = p.color;
  el.style.boxShadow       = `0 0 18px ${p.color}`;
  const classes = ['player'];
  if (p.powerup)                      classes.push(p.powerup);
  if (p.invincibleUntil > Date.now()) classes.push('invincible');
  el.className = classes.join(' ');
  // Refresh text in case name was truncated server-side
  el.querySelector('.player-name').textContent    = p.name;
  el.querySelector('.player-initial').textContent = p.name.charAt(0).toUpperCase();
}
function showEliminatedOverlay() {
  const overlay = document.getElementById('endOverlay');
  // Only show once
  if (!overlay.hidden) return;
  
  overlay.hidden = false;
  overlay.classList.add('minimized');
  document.getElementById('endContent').hidden = true;
  document.getElementById('endCompact').hidden = false;
  
  // Update compact text to show "Eliminated"
  document.querySelector('.compact-status').textContent = 'Eliminated';
  
  playSound('hit');
}

function showEndScreen() {
  // Stop game loop but don't cancel render - arena stays frozen and visible
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  
  // Show overlay on top of frozen arena - restore if minimized
  const overlay = document.getElementById('endOverlay');
  overlay.hidden = false;
  overlay.classList.remove('minimized');
  document.getElementById('endContent').hidden = false;
  document.getElementById('endCompact').hidden = true;
  
  playSound('win');

  const winner = gameState.winner;
  const winEl  = document.getElementById('winnerDisplay');
  if (winner) {
    winEl.style.borderColor = winner.color;
    winEl.style.boxShadow   = `0 0 40px ${winner.color}`;
    winEl.innerHTML = `
      <div class="winner-crown">👑</div>
      <div class="winner-name" style="color:${winner.color}">${escapeHtml(winner.name)}</div>
      <div class="winner-score">${winner.score} Points</div>`;
  } else {
    winEl.innerHTML = '<div class="winner-name">Draw!</div>';
  }

  const finalEl = document.getElementById('finalScores');
  finalEl.innerHTML = '';
  const medals = ['🥇','🥈','🥉'];
  [...gameState.players]
    .sort((a, b) => b.score - a.score)
    .forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'final-score-item';
      row.style.borderColor = p.color;
      row.innerHTML = `
        <span class="final-score-name">${medals[i] || ''} ${escapeHtml(p.name)}</span>
        <span class="final-score-value" style="color:${p.color}">${p.score} pts</span>`;
      finalEl.appendChild(row);
    });
}

document.getElementById('playAgainBtn').addEventListener('click', () => location.reload());

// Minimize/restore end overlay
document.getElementById('minimizeEndBtn').addEventListener('click', () => {
  document.getElementById('endOverlay').classList.add('minimized');
  document.getElementById('endContent').hidden = true;
  document.getElementById('endCompact').hidden = false;
});

document.getElementById('restoreEndBtn').addEventListener('click', () => {
  document.getElementById('endOverlay').classList.remove('minimized');
  document.getElementById('endContent').hidden = false;
  document.getElementById('endCompact').hidden = true;
});
function showNotification(msg, duration = 3500) {
  const container = document.getElementById('notifications');
  const el = document.createElement('div');
  el.className = 'notification';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 400);
  }, duration);
}

function showError(msg) {
  const el = document.getElementById('errorMessage');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 3500);
}
document.getElementById('chatSendBtn').addEventListener('click', sendChat);

function sendChat() {
  const input = document.getElementById('chatInput');
  const text  = input.value.trim();
  if (!text) return;
  socket.emit('chatMessage', text);
  input.value = '';
}

function appendChatMessage(name, color, text) {
  const box = document.getElementById('chatMessages');
  const row = document.createElement('div');
  row.className = 'chat-message';
  row.style.borderColor = color;
  row.innerHTML = `<span class="chat-sender" style="color:${color}">${escapeHtml(name)}:</span>${escapeHtml(text)}`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
  while (box.children.length > 30) box.firstChild.remove();
}
function escapeHtml(str) {
  return String(str)
    .replaceAll('&',  '&amp;')
    .replaceAll('<',  '&lt;')
    .replaceAll('>',  '&gt;')
    .replaceAll('"',  '&quot;');
}