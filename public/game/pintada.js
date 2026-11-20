import { BaseMode, W, H, cluster } from './base.js';

const CELL = 50;
const COLS = W / CELL;
const ROWS = H / CELL;
const TEAMS = [
  { name: 'Rojo', color: '#ff4d6d' },
  { name: 'Azul', color: '#3a86ff' },
  { name: 'Verde', color: '#2ec4b6' },
  { name: 'Amarillo', color: '#ffbe0b' },
];
const BASES = {
  2: [
    { x: 180, y: H / 2 },
    { x: W - 180, y: H / 2 },
  ],
  4: [
    { x: 200, y: 200 },
    { x: W - 200, y: H - 200 },
    { x: W - 200, y: 200 },
    { x: 200, y: H - 200 },
  ],
};
const BUCKET_EVERY = 7;
const BUCKET_RADIUS = 150;

class Pintada extends BaseMode {
  static title = 'Pintada';
  static help = 'Pintá el piso con el color de tu equipo. Agarrá los baldes 🪣 para manchar a lo grande.';

  constructor(players) {
    super(players);
    this.duration = 90;
    this.phys = { grip: 7, maxV: 270, dashPow: 600, bounce: 0.6, dashBoost: 140, bounded: true };
    this.teamCount = this.bodies.length >= 12 ? 4 : 2;
    this.teams = TEAMS.slice(0, this.teamCount);
    this.grid = new Uint8Array(COLS * ROWS);
    this.diffs = [];
    this.painted = {};
    this.buckets = [];
    this.nextBucket = 5;
    this.bucketId = 1;

    this.bodies.forEach((b, i) => (b.tm = i % this.teamCount));
    for (let t = 0; t < this.teamCount; t++) {
      const members = this.bodies.filter((b) => b.tm === t);
      const base = BASES[this.teamCount][t];
      cluster(base.x, base.y, members.length).forEach((pos, i) => Object.assign(members[i], pos));
    }
  }

  paint(x, y, radius, body) {
    const value = body.tm + 1;
    const reach = radius + CELL * 0.35;
    const c0 = Math.max(0, Math.floor((x - reach) / CELL));
    const c1 = Math.min(COLS - 1, Math.floor((x + reach) / CELL));
    const r0 = Math.max(0, Math.floor((y - reach) / CELL));
    const r1 = Math.min(ROWS - 1, Math.floor((y + reach) / CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const dist = Math.hypot((c + 0.5) * CELL - x, (r + 0.5) * CELL - y);
        const idx = r * COLS + c;
        if (dist > reach || this.grid[idx] === value) continue;
        this.grid[idx] = value;
        this.diffs.push(idx, value);
        this.painted[body.id] = (this.painted[body.id] || 0) + 1;
      }
    }
  }

  tick(dt, frozen) {
    this.move(dt, frozen);
    this.collide(null);
    this.bounds();
    if (frozen) return;

    this.time += dt;
    for (const b of this.bodies) this.paint(b.x, b.y, 8, b);

    if (this.time >= this.nextBucket) {
      this.nextBucket = this.time + BUCKET_EVERY;
      if (this.buckets.length < 2) {
        const spot = this.randomSpot((x, y) => this.bodies.every((b) => Math.hypot(b.x - x, b.y - y) > 150), 100);
        this.buckets.push({ id: this.bucketId++, ...spot });
      }
    }
    for (const bucket of [...this.buckets]) {
      const taker = this.bodies.find((b) => Math.hypot(b.x - bucket.x, b.y - bucket.y) < b.r + 20);
      if (!taker) continue;
      this.buckets = this.buckets.filter((k) => k !== bucket);
      this.paint(bucket.x, bucket.y, BUCKET_RADIUS, taker);
      this.event(`🪣 ${taker.p.name} reventó un balde de ${this.teams[taker.tm].name.toLowerCase()}`);
    }
  }

  counts() {
    const counts = new Array(this.teamCount).fill(0);
    for (const v of this.grid) if (v) counts[v - 1]++;
    return counts;
  }

  isDone() {
    return this.time >= this.duration;
  }

  results() {
    const counts = this.counts();
    const order = counts.map((c, t) => ({ t, c })).sort((a, b) => b.c - a.c);
    const top = order[0].c;
    const winners = order.filter((o) => o.c === top && top > 0).map((o) => o.t);
    const second = this.teamCount === 4 ? order.find((o) => o.c < top)?.t : undefined;

    const points = {};
    for (const b of this.bodies) {
      let pts = Math.floor((this.painted[b.id] || 0) / 25);
      if (winners.includes(b.tm)) pts += 4;
      else if (b.tm === second) pts += 2;
      points[b.id] = pts;
    }

    const total = COLS * ROWS;
    const title =
      winners.length === 1
        ? `¡Ganó el equipo ${this.teams[winners[0]].name}!`
        : winners.length
          ? `Empate entre ${winners.map((t) => this.teams[t].name).join(' y ')}`
          : 'Nadie pintó nada 🤨';
    const lines = [order.map((o) => `${this.teams[o.t].name} ${Math.round((o.c / total) * 100)}%`).join(' · ')];
    const best = Object.entries(this.painted).sort((a, b) => b[1] - a[1])[0];
    if (best) lines.push(`Pincel de oro: ${this.byId(Number(best[0])).p.name}`);
    return { title, lines, points };
  }

  bodyState(b) {
    return { ...super.bodyState(b), tm: b.tm };
  }

  extra() {
    return {
      c: this.counts(),
      k: this.buckets.map((k) => [k.id, Math.round(k.x), Math.round(k.y)]),
    };
  }

  reliableExtra() {
    return this.diffs.splice(0);
  }

  staticInfo() {
    return { cell: CELL, cols: COLS, rows: ROWS, teams: this.teams, grid: Array.from(this.grid) };
  }
}

export default Pintada;
