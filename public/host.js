// Lado host: maneja el worker que simula la partida y reparte el estado a cada jugador.
export class HostEngine {
  constructor(net, { deliver, toServer, onError }) {
    Object.assign(this, { net, deliver, toServer, onError });
    this.me = null;
    this.worker = new Worker(new URL('./game/worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => this.fromWorker(e.data);
  }

  setRoom(room, me) {
    this.me = me;
    this.worker.postMessage({
      t: 'players',
      list: room.players.map((p) => ({ id: p.id, name: p.name, connected: p.connected })),
    });
  }

  fromWorker(m) {
    switch (m.t) {
      case 'round': {
        const str = JSON.stringify(m.round);
        if (m.to) return this.net.sendTo(m.to, str, true);
        for (const id of this.net.peerIds()) this.net.sendTo(id, str, true);
        this.deliver(JSON.parse(str));
        break;
      }
      case 'snap': {
        // Mismo snapshot para todos + la velocidad propia de cada uno (para su predicción).
        const common = JSON.stringify(m.s).slice(0, -1);
        const forId = (id) => `${common},"v":${JSON.stringify(m.v[id] ?? null)}}`;
        for (const id of this.net.peerIds()) this.net.sendTo(id, forId(id), false);
        this.deliver(JSON.parse(forId(this.me)));
        break;
      }
      case 'x': {
        const str = JSON.stringify(m.x);
        for (const id of this.net.peerIds()) this.net.sendTo(id, str, true);
        this.deliver(JSON.parse(str));
        break;
      }
      case 'phase':
        this.toServer({ t: 'phase', phase: m.phase, mode: m.mode });
        break;
      case 'results':
        this.toServer({ t: 'results', title: m.title, lines: m.lines, points: m.points });
        break;
      case 'error':
        this.onError(m.msg);
        break;
    }
  }

  fromPeer(id, m) {
    switch (m.t) {
      case 'input':
        this.worker.postMessage({ t: 'input', id, x: m.x, y: m.y, d: m.d });
        break;
      case 'ping':
        this.net.sendTo(id, JSON.stringify({ t: 'pong', c: m.c }), false);
        break;
      case 'hello':
      case 'linked':
        // Recién conectado (o cambió de vía): mandarle la ronda en curso, si hay.
        this.worker.postMessage({ t: 'sync', id });
        break;
    }
  }

  input(x, y, d) {
    this.worker.postMessage({ t: 'input', id: this.me, x, y, d });
  }

  start(mode) {
    this.worker.postMessage({ t: 'start', mode });
  }

  end() {
    this.worker.postMessage({ t: 'end' });
  }

  abort() {
    this.worker.postMessage({ t: 'abort' });
  }

  destroy() {
    this.worker.terminate();
  }
}
