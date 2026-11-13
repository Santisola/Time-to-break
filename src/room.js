// Sala: jugadores, host, fase y puntajes. La partida no corre acá sino en el navegador del host
// (public/game/worker.js); el servidor presenta a los navegadores entre sí (WebRTC) y retransmite
// los mensajes de quienes no pudieron conectarse en directo.

const MAX_PLAYERS = 24;
const ABANDON_MS = 10 * 60 * 1000;
const HOST_GRACE_MS = 8000;
const MODE_KEYS = ['sumo', 'infeccion', 'pintada'];

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
}

class Room {
  constructor(code) {
    this.code = code;
    this.players = new Map();
    this.hostId = null;
    this.phase = 'lobby'; // lobby | countdown | playing | results (la reporta el host)
    this.modeKey = null;
    this.results = null;
    this.nextId = 1;
    this.hueSeed = Math.random() * 360;
    this.emptySince = Date.now();
  }

  connected() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  inRound() {
    return this.phase === 'countdown' || this.phase === 'playing';
  }

  addPlayer(ws, name, key) {
    let p = key ? [...this.players.values()].find((x) => x.key === key) : null;
    if (p) {
      if (p.ws && p.ws !== ws) {
        send(p.ws, { t: 'kicked' });
        p.ws.close();
      }
      Object.assign(p, { ws, name, connected: true });
    } else {
      if (this.connected().length >= MAX_PLAYERS) return { error: 'La sala está llena' };
      const id = this.nextId++;
      const hue = Math.round((this.hueSeed + id * 137.508) % 360);
      p = { id, key, name, ws, connected: true, score: 0, color: `hsl(${hue},85%,62%)`, conn: 0 };
      this.players.set(id, p);
    }
    p.conn++; // cada reconexión es una conexión WebRTC nueva
    p.net = null;
    const host = this.players.get(this.hostId);
    if (!host || (!host.connected && Date.now() - host.leftAt > HOST_GRACE_MS)) this.setHost(p.id);
    this.emptySince = null;

    send(ws, { t: 'joined', code: this.code, id: p.id });
    if (this.phase === 'results' && this.results) send(ws, this.results);
    this.broadcastRoom();
    return { player: p };
  }

  removeConnection(p, ws) {
    if (p.ws !== ws) return;
    p.ws = null;
    p.connected = false;
    p.net = null;
    p.leftAt = Date.now();
    // La partida vivía en el navegador del host: si se va, la ronda se corta.
    if (p.id === this.hostId && this.inRound()) this.abortRound('Se cortó la ronda: el host se desconectó');
    if (!this.connected().length) this.emptySince = Date.now();
    this.broadcastRoom();
  }

  setHost(id) {
    if (this.hostId === id) return;
    this.hostId = id;
    if (this.inRound()) this.abortRound('Se cortó la ronda: cambió el host');
  }

  abortRound(msg) {
    this.phase = 'lobby';
    this.results = null;
    this.broadcast({ t: 'aborted', msg });
  }

  handle(p, msg) {
    switch (msg.t) {
      case 'ping':
        return send(p.ws, { t: 'pong', c: msg.c });
      case 'sig':
      case 'relay': {
        // Solo entre el host y un jugador (estrella), nunca jugador ↔ jugador.
        const to = this.players.get(msg.to);
        if (!to?.connected || (p.id !== this.hostId && to.id !== this.hostId)) return;
        if (msg.t === 'relay' && typeof msg.d !== 'string') return;
        return send(to.ws, { t: msg.t, from: p.id, d: msg.d });
      }
      case 'net':
        if (!['p2p', 'relay'].includes(msg.mode) || p.net === msg.mode) return;
        p.net = msg.mode;
        return this.broadcastRoom();
    }

    if (p.id !== this.hostId) return;
    switch (msg.t) {
      case 'phase':
        if (!['countdown', 'playing'].includes(msg.phase) || !MODE_KEYS.includes(msg.mode)) return;
        if (msg.phase === 'playing' && this.phase !== 'countdown') return;
        this.phase = msg.phase;
        this.modeKey = msg.mode;
        this.results = null;
        return this.broadcastRoom();
      case 'results':
        if (this.inRound()) this.finish(msg);
        return;
      case 'lobby':
        if (this.phase !== 'results') return;
        this.phase = 'lobby';
        this.results = null;
        return this.broadcastRoom();
    }
  }

  finish(msg) {
    const points = msg.points && typeof msg.points === 'object' ? msg.points : {};
    const round = [];
    for (const [id, raw] of Object.entries(points)) {
      const pl = this.players.get(Number(id));
      if (!pl) continue;
      const pts = Math.max(0, Math.min(50, Math.floor(Number(raw) || 0)));
      pl.score += pts;
      round.push({ id: pl.id, name: pl.name, color: pl.color, pts });
    }
    round.sort((a, b) => b.pts - a.pts);
    this.results = {
      t: 'results',
      mode: this.modeKey,
      title: String(msg.title || '').slice(0, 120),
      lines: (Array.isArray(msg.lines) ? msg.lines : []).slice(0, 5).map((l) => String(l).slice(0, 160)),
      round,
    };
    this.phase = 'results';
    this.broadcast(this.results);
    this.broadcastRoom();
  }

  // Si el host recarga la página tiene unos segundos para volver antes de perder la corona.
  tick() {
    const host = this.players.get(this.hostId);
    if (host && !host.connected && Date.now() - host.leftAt > HOST_GRACE_MS) {
      const next = this.connected()[0];
      if (next) {
        this.setHost(next.id);
        this.broadcastRoom();
      }
    }
  }

  broadcastRoom() {
    this.broadcast({
      t: 'room',
      code: this.code,
      hostId: this.hostId,
      phase: this.phase,
      mode: this.modeKey,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        score: p.score,
        connected: p.connected,
        conn: p.conn,
        net: p.net,
      })),
    });
  }

  broadcast(msg) {
    const data = typeof msg === 'string' ? msg : JSON.stringify(msg);
    for (const p of this.players.values()) send(p.ws, data);
  }

  isAbandoned(now) {
    return this.emptySince !== null && now - this.emptySince > ABANDON_MS;
  }
}

module.exports = { Room, send };
