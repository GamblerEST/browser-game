# Neon Arcade ▲▼

Real-time multiplayer arena game for 2–4 players. Collect pixels, dodge glitch blocks, and grab power-ups to outscore opponents before time runs out.

Rendered entirely with DOM elements (no canvas).

---

## Quick Start

```bash
npm install
npm start
# Open http://localhost:3000
```

---

## How to Play

### Setup
1. **Host** creates game (gets 6-character ID)
2. **Players** join using the ID
3. **Host** launches when ready

### Controls
- **Move**: `WASD` or Arrow keys
- **Menu**: `ESC`
- **Chat**: Type and press `Enter`

### Scoring
- Small pixel: **1 point**
- Large pixel: **5 points**
- Highest score wins when timer expires

### Lives
- Start with **3 lives**
- Hit glitch block = lose 1 life + 2s invincibility
- Respawn at random corner

### Power-ups
- **►** Speed (60% faster, 10s)
- **■** Shield (immune to damage, 10s)
- **◆** Magnet (pull nearby pixels, 10s)

---

## Deployment

### Local network
```bash
npm start
# Share your local IP: http://192.168.x.x:3000
```

### Internet play
Use [ngrok](https://ngrok.com/):
```bash
ngrok http 3000
# Share the https URL
```

Or deploy to Railway/Render/Fly.io (free tier available).

---

## Project Structure

```
neon-arcade/
├── server.js          # Node.js game server (Socket.IO)
├── package.json
├── README.md
└── public/
    ├── index.html
    ├── styles.css
    └── game.js        # Client engine
```

---

## Technical

- Client: 60 FPS (`requestAnimationFrame`)
- Server: 20 Hz authoritative tick
- Network: Rate-limited to ~20 updates/s
- Rendering: DOM elements with CSS positioning
- Audio: Web Audio API (synthesized)