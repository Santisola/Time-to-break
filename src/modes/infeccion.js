const { BaseMode, W, H } = require('./base');

const WALLS = [
  { x: 300, y: 130, w: 40, h: 260 },
  { x: 300, y: 510, w: 40, h: 260 },
  { x: 1260, y: 130, w: 40, h: 260 },
  { x: 1260, y: 510, w: 40, h: 260 },
  { x: 560, y: 190, w: 480, h: 40 },
  { x: 560, y: 670, w: 480, h: 40 },
  { x: 760, y: 390, w: 80, h: 120 },
  { x: 90, y: 430, w: 130, h: 40 },
  { x: 1380, y: 430, w: 130, h: 40 },
  { x: 560, y: 380, w: 40, h: 140 },
  { x: 1000, y: 380, w: 40, h: 140 },
];
const ZOMBIE_DELAY = 3;

function clearOfWalls(x, y, gap) {
  return WALLS.every((w) => {
    const cx = Math.max(w.x, Math.min(x, w.x + w.w));
    const cy = Math.max(w.y, Math.min(y, w.y + w.h));
    return Math.hypot(x - cx, y - cy) > gap;
  });
}

class Infeccion extends BaseMode {
  static title = 'Infección';
  static help = 'Los zombies contagian tocando. Sobreviví hasta que se acabe el tiempo.';

  constructor(players) {
    super(players);
    this.duration = 100;
    this.phys = { grip: 8, maxV: 250, dashPow: 520, bounded: true };
    this.infections = {};
    const zombies = Math.max(1, Math.round(this.bodies.length / 6));
    const zombieSpots = [
      { x: W / 2, y: 300 },
      { x: W / 2, y: 600 },
      { x: 450, y: H / 2 },
      { x: 1150, y: H / 2 },
    ];
    this.bodies.forEach((b, i) => {
      if (i < zombies) {
        const s = zombieSpots[i % zombieSpots.length];
        Object.assign(b, { x: s.x + (i >> 2) * 50, y: s.y, stun: ZOMBIE_DELAY });
        this.makeZombie(b);
      } else {
        const z = this.bodies.slice(0, zombies);
        const spot = this.randomSpot(
          (x, y) =>
            clearOfWalls(x, y, 40) &&
            z.every((o) => Math.hypot(o.x - x, o.y - y) > 380) &&
            this.bodies.slice(zombies, i).every((o) => Math.hypot(o.x - x, o.y - y) > 60)
        );
        Object.assign(b, spot);
      }
    });
  }

  makeZombie(b) {
    b.z = true;
    b.speed = 1.08;
    b.dashCooldown = 2.4;
    b.infectedAt = this.time;
  }

  tick(dt, frozen) {
    if (!frozen) this.time += dt;
    this.move(dt, frozen);
    this.collide(
      (a, b) => {
        if (frozen || a.z === b.z) return;
        const zombie = a.z ? a : b;
        const human = a.z ? b : a;
        if (zombie.stun > 0) return;
        this.makeZombie(human);
        human.stun = 1;
        this.infections[zombie.id] = (this.infections[zombie.id] || 0) + 1;
        this.event(`🧟 ${zombie.p.name} contagió a ${human.p.name}`);
      },
      { bounce: 0.3 }
    );
    this.walls(WALLS);
    this.bounds();
  }

  survivors() {
    return this.bodies.filter((b) => !b.z);
  }

  isDone() {
    return this.time >= this.duration || this.survivors().length === 0;
  }

  results() {
    const points = {};
    const survivors = this.survivors();
    for (const b of this.bodies) {
      let pts = (this.infections[b.id] || 0) * 2;
      pts += b.z ? Math.floor((b.infectedAt || 0) / 20) : 5;
      points[b.id] = pts;
    }
    const title = survivors.length
      ? `¡${survivors.length === 1 ? `${survivors[0].p.name} sobrevivió` : `Sobrevivieron ${survivors.length}`}!`
      : `Ganaron los zombies en ${Math.round(this.time)}s 🧟`;
    const lines = [];
    if (survivors.length > 1) lines.push(survivors.map((b) => b.p.name).join(', '));
    const best = Object.entries(this.infections).sort((a, b) => b[1] - a[1])[0];
    if (best) lines.push(`Zombie más voraz: ${this.byId(Number(best[0])).p.name} (${best[1]} contagios)`);
    return { title, lines, points };
  }

  bodyState(b) {
    const o = super.bodyState(b);
    if (b.z) o.z = 1;
    return o;
  }

  staticInfo() {
    return { walls: WALLS };
  }
}

module.exports = Infeccion;
