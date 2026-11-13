const { BaseMode, W, H } = require('./base');

const R_START = 400;
const R_MIN = 120;
const SHRINK_FROM = 8;
const SHRINK_TO = 55;

class Sumo extends BaseMode {
  static title = 'Sumo de blobs';
  static help = 'Empujá a todos fuera de la plataforma. Se achica con el tiempo.';

  constructor(players) {
    super(players);
    this.duration = 90;
    this.cx = W / 2;
    this.cy = H / 2;
    this.arenaR = R_START;
    this.out = [];
    this.knockouts = {};
    const n = this.bodies.length;
    const ring = n === 1 ? 0 : Math.min(290, 60 + n * 14);
    this.bodies.forEach((b, i) => {
      const a = (i / n) * Math.PI * 2;
      b.x = this.cx + Math.cos(a) * ring;
      b.y = this.cy + Math.sin(a) * ring;
    });
  }

  tick(dt, frozen) {
    if (!frozen) {
      this.time += dt;
      const t = Math.max(0, Math.min(1, (this.time - SHRINK_FROM) / (SHRINK_TO - SHRINK_FROM)));
      this.arenaR = R_START + (R_MIN - R_START) * t;
    }
    this.move(dt, frozen, { grip: 3.2, maxV: 260, dashPow: 560 });
    this.collide(
      (a, b, impact) => {
        if (impact < 60) return;
        a.lastHit = { by: b, at: this.time };
        b.lastHit = { by: a, at: this.time };
      },
      { bounce: 0.9, dashBoost: 260 }
    );

    for (const b of this.bodies) {
      if (!b.alive || Math.hypot(b.x - this.cx, b.y - this.cy) <= this.arenaR) continue;
      b.alive = false;
      this.out.push(b);
      const pusher = b.lastHit && this.time - b.lastHit.at < 3 ? b.lastHit.by : null;
      if (pusher) {
        this.knockouts[pusher.id] = (this.knockouts[pusher.id] || 0) + 1;
        this.event(`💥 ${pusher.p.name} sacó a ${b.p.name}`);
      } else {
        this.event(`🫠 ${b.p.name} se cayó solito`);
      }
    }
  }

  isDone() {
    const alive = this.bodies.filter((b) => b.alive).length;
    const minAlive = this.bodies.length > 1 ? 1 : 0;
    return alive <= minAlive || this.time >= this.duration;
  }

  results() {
    const points = {};
    this.out.forEach((b, i) => (points[b.id] = i));
    const alive = this.bodies.filter((b) => b.alive);
    for (const b of alive) points[b.id] = this.out.length + (alive.length === 1 ? 3 : 1);
    for (const [id, ko] of Object.entries(this.knockouts)) points[id] = (points[id] || 0) + ko;

    let title;
    if (alive.length === 1) title = `¡${alive[0].p.name} es el último en pie!`;
    else if (alive.length > 1) title = `Empate entre ${alive.length} sobrevivientes`;
    else title = 'Nadie quedó arriba 🫠';

    const lines = [];
    const best = Object.entries(this.knockouts).sort((a, b) => b[1] - a[1])[0];
    if (best) lines.push(`Más empujones: ${this.byId(Number(best[0])).p.name} (${best[1]})`);
    if (this.out[0]) lines.push(`Primero en caer: ${this.out[0].p.name}`);
    return { title, lines, points };
  }

  extra() {
    return { r: Math.round(this.arenaR) };
  }

  staticInfo() {
    return { cx: this.cx, cy: this.cy, r0: R_START };
  }
}

module.exports = Sumo;
