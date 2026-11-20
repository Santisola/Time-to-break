(() => {
  const W = 1600;
  const H = 900;
  const R = 22;

  const MODES = [
    { key: 'sumo', emoji: '🫧', title: 'Sumo de blobs', desc: 'Empujá a todos fuera de la plataforma, que se va achicando. Gana el último en pie.' },
    { key: 'infeccion', emoji: '🧟', title: 'Infección', desc: 'Los zombies contagian con solo tocarte. Aguantá vivo hasta que se acabe el tiempo.' },
    { key: 'pintada', emoji: '🎨', title: 'Pintada', desc: 'Pintá el piso con el color de tu equipo. Gana el que cubre más área.' },
    { key: 'futbol', emoji: '⚽', title: 'Haxblobs', desc: 'Fútbol Rojo contra Azul. Espacio patea (más fuerte cuanto más pegada), Shift embiste. Armás equipos, cancha y duración.' },
  ];

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const store = {
    get(k) {
      try {
        return localStorage.getItem(k);
      } catch {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem(k, v);
      } catch {}
    },
  };

  // Clave por pestaña (sessionStorage): sobrevive a un F5 para recuperar puntos,
  // pero dos pestañas del mismo navegador son dos jugadores distintos.
  let key = null;
  let reloaded = false;
  try {
    key = sessionStorage.getItem('ttb-key');
    reloaded = !!key;
    if (!key) {
      key = Math.random().toString(36).slice(2) + Date.now().toString(36);
      sessionStorage.setItem('ttb-key', key);
    }
  } catch {
    key = Math.random().toString(36).slice(2);
  }

  const S = {
    ws: null,
    me: null,
    code: null,
    name: '',
    room: null,
    round: null,
    snap: null,
    ents: new Map(),
    grid: null,
    results: null,
    feed: [],
    selected: 'sumo',
    fallen: new Map(),
    look: new Map(),
  };

  // Predicción local de tu blob: se mueve al instante con la misma física que el servidor
  // y se corrige de a poco comparando contra donde estabas hace un RTT.
  const P = { active: false, x: 0, y: 0, vx: 0, vy: 0, dashCd: 0, dashQueued: false, cooldown: 1.4, speed: 1, stun: false, hist: [], rtt: 0, ox: 0, oy: 0, dashT: 0, hitBy: new Map() };

  window.__ttb = { S, P }; // para depurar desde la consola

  const isHost = () => S.room && S.room.hostId === S.me;
  const playerById = (id) => S.room?.players.find((p) => p.id === id);
  const isTouch = matchMedia('(pointer: coarse)').matches;

  // ---------- Inicio ----------
  const params = new URLSearchParams(location.search);
  $('name').value = store.get('ttb-name') || '';
  $('code').value = (params.get('sala') || '').toUpperCase();
  ($('name').value ? $('code').value ? $('join') : $('create') : $('name')).focus();

  function homeMsg(text) {
    $('homeMsg').textContent = text;
  }

  function go(kind) {
    const name = $('name').value.trim();
    if (!name) return homeMsg('Poné tu nombre');
    const code = $('code').value.trim().toUpperCase();
    if (kind === 'join' && code.length !== 4) return homeMsg('El código tiene 4 letras');
    store.set('ttb-name', name);
    S.name = name;
    S.pending = kind === 'join' ? { t: 'join', code, name, key } : { t: 'create', name, key };
    homeMsg('Conectando…');
    connect();
  }

  $('create').onclick = () => go('create');
  $('join').onclick = () => go('join');
  $('name').addEventListener('keydown', (e) => e.key === 'Enter' && go($('code').value ? 'join' : 'create'));
  $('code').addEventListener('keydown', (e) => e.key === 'Enter' && go('join'));
  // F5 en medio de una sala: volver a entrar directo.
  if (reloaded && $('name').value && $('code').value) go('join');

  function connect() {
    if (S.ws) {
      S.ws.onclose = null;
      S.ws.close();
    }
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
    S.ws = ws;
    ws.onopen = () => {
      $('conn').classList.add('hidden');
      ws.send(JSON.stringify(S.code ? { t: 'join', code: S.code, name: S.name, key } : S.pending));
    };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data));
    ws.onclose = () => {
      if (S.ws !== ws || S.kicked) return;
      if (S.code) {
        $('conn').classList.remove('hidden');
        setTimeout(connect, 1500);
      } else {
        homeMsg('No se pudo conectar con el servidor');
      }
    };
  }

  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.remove('hidden');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  // ---------- Mensajes ----------
  function onMessage(m) {
    switch (m.t) {
      case 'joined':
        S.me = m.id;
        S.code = m.code;
        history.replaceState(null, '', `?sala=${m.code}`);
        $('home').classList.add('hidden');
        homeMsg('');
        break;
      case 'kicked':
        S.kicked = true;
        $('conn').textContent = 'Abriste el juego en otra pestaña. Recargá para jugar acá.';
        $('conn').classList.remove('hidden');
        break;
      case 'error':
        if (m.code === 'noroom' && S.code) {
          S.code = null;
          S.room = null;
          S.round = null;
          $('home').classList.remove('hidden');
          ui();
        }
        if (!$('home').classList.contains('hidden')) homeMsg(m.msg);
        else toast(m.msg);
        break;
      case 'room':
        S.room = m;
        if (m.phase === 'lobby') {
          S.round = null;
          S.results = null;
        }
        if (m.mode && !S.selectedByMe) S.selected = m.mode;
        ui();
        break;
      case 'round':
        P.active = false;
        S.round = m;
        S.snap = null;
        S.ball = null;
        S.ents.clear();
        S.fallen.clear();
        S.feed = [];
        S.results = null;
        S.grid = m.info.grid ? Uint8Array.from(m.info.grid) : null;
        ui();
        break;
      case 's':
        onSnapshot(m);
        break;
      case 'eco': {
        const sample = performance.now() - m.c;
        P.rtt = P.rtt ? P.rtt * 0.75 + sample * 0.25 : sample;
        break;
      }
      case 'results':
        S.results = m;
        ui();
        break;
    }
  }

  // Sin buffer de interpolación: se dibuja el último estado, extrapolado con la velocidad de cada uno.
  function onSnapshot(m) {
    if (!S.round) return;
    const now = performance.now();
    m.at = now;
    // Tuplas [id, x, y, vx, vy, flags, cooldown, equipo] → objetos (ver BaseMode.snapshot).
    m.b = m.b.map(([i, x, y, vx, vy, f, c, tm]) => ({ i, x, y, vx, vy, o: f & 1, d: f & 2, s: f & 4, z: f & 8, k: f & 16, dz: f & 32, c, tm }));
    for (const o of m.b) {
      const e = S.ents.get(o.i);
      if (e) {
        // Lo que se estaba dibujando vs. el dato nuevo: esa diferencia se disuelve en ~60 ms en vez de saltar.
        const shown = entityPos(e, now);
        const ox = shown.x - o.x;
        const oy = shown.y - o.y;
        const far = Math.hypot(ox, oy) > 120;
        S.ents.set(o.i, { ...o, at: now, ox: far ? 0 : ox, oy: far ? 0 : oy });
      } else {
        S.ents.set(o.i, { ...o, at: now, ox: 0, oy: 0 });
      }
    }
    if (m.v) {
      const mine = m.b.find((b) => b.i === S.me);
      if (mine) [mine.sp, mine.dc] = m.v;
    }
    if (m.g && S.grid) for (let i = 0; i < m.g.length; i += 2) S.grid[m.g[i]] = m.g[i + 1];
    for (const text of m.ev || []) S.feed.push({ text, at: now });
    if (m.x?.ball) {
      const [x, y, vx, vy] = m.x.ball;
      const prev = S.ball;
      let ox = 0;
      let oy = 0;
      if (prev) {
        const shown = entityPos(prev, now);
        ox = shown.x - x;
        oy = shown.y - y;
        if (Math.hypot(ox, oy) > 120) ox = oy = 0; // saque del medio: sin deslizar
      }
      S.ball = { x, y, vx, vy, at: now, ox, oy };
    }
    S.snap = m;
    reconcile(m);
    hud(m);
  }

  const EXTRAPOLATE_MAX = 0.1; // no adivinar más de 100 ms si se atrasa un snapshot
  const SMOOTH_MS = 60;

  function entityPos(e, now) {
    const age = Math.min(EXTRAPOLATE_MAX, (now - e.at) / 1000);
    const fade = Math.exp(-(now - e.at) / SMOOTH_MS);
    const moving = !e.o;
    return {
      x: e.x + (moving ? e.vx * age : 0) + e.ox * fade,
      y: e.y + (moving ? e.vy * age : 0) + e.oy * fade,
    };
  }

  function sendServer(msg) {
    if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(msg));
  }

  // ---------- Paneles ----------
  function ui() {
    const phase = S.room?.phase;
    const inRound = phase === 'countdown' || phase === 'playing';
    $('panel').classList.toggle('hidden', !S.room || inRound);
    $('hud').classList.toggle('hidden', !inRound);
    $('center').classList.toggle('hidden', !inRound);
    $('endBtn').classList.toggle('hidden', !(inRound && isHost()));
    $('touchDash').classList.toggle('hidden', !(inRound && isTouch));
    $('touchKick').classList.toggle('hidden', !(inRound && isTouch && S.round?.mode === 'futbol'));
    if (S.room && !inRound) renderPanel();
  }

  // Ping de cada jugador con el servidor: verde < 60 ms, amarillo < 120, rojo arriba.
  function pingTag(rtt) {
    if (rtt == null) return '';
    const cls = rtt < 60 ? 'p2p' : rtt < 120 ? 'relay' : 'bad';
    return `<span class="net ${cls}" title="Latencia con el servidor">${rtt} ms</span>`;
  }

  function resultsHtml(r) {
    if (r.phase !== 'results' || !S.results) return '';
    const res = S.results;
    const title = MODES.find((m) => m.key === res.mode)?.title || '';
    return `<div class="results">
        <div class="tag">${esc(title)} · resultado</div>
        <h2>${esc(res.title)}</h2>
        ${res.lines.map((l) => `<p>${esc(l)}</p>`).join('')}
        <ul class="pts">${res.round
          .filter((p) => p.pts > 0)
          .map((p) => `<li><span class="dot" style="background:${p.color}"></span>${esc(p.name)} <b>+${p.pts}</b></li>`)
          .join('')}</ul>
      </div>`;
  }

  // ---------- Armado del partido de fútbol ----------
  const FB_SIZES = { '1v1': 1, '3v3': 3, '5v5': 5, '7v7': 7 };
  const FB_MINUTES = [
    [2, '2 min'],
    [3, '3 min'],
    [5, '5 min'],
    [0, 'Sin límite'],
  ];
  const FB_GOALS = [
    [3, '3'],
    [5, '5'],
    [7, '7'],
    [0, 'Sin límite'],
  ];

  function futbolSetupHtml(r, host, hostName) {
    const fb = r.fb;
    const max = FB_SIZES[fb.size];
    const online = r.players.filter((p) => p.connected);
    const teamOf = (p) => (fb.teams[p.id] === 0 || fb.teams[p.id] === 1 ? fb.teams[p.id] : null);
    const myTeam = teamOf({ id: S.me });
    const seg = (key, options, current) =>
      `<div class="seg">${options
        .map(
          ([v, label]) =>
            `<button class="${v === current ? 'on' : ''}" data-cfg="${key}" data-v="${v}" ${host ? '' : 'disabled'}>${label}</button>`
        )
        .join('')}</div>`;
    // El host arrastra a cualquiera; cada jugador, solo a sí mismo.
    const chip = (p) => {
      const drag = host || p.id === S.me;
      return `<li class="${p.id === S.me ? 'me' : ''} ${drag ? 'drag' : ''}" data-id="${p.id}"><span class="grip">${drag ? '⠿' : ''}</span><span class="dot" style="background:${p.color}"></span><span class="nm">${esc(p.name)}${p.id === r.hostId ? ' 👑' : ''}</span>${pingTag(p.rtt)}</li>`;
    };
    const column = (team, title, color) => {
      const members = online.filter((p) => teamOf(p) === team);
      const full = team !== null && members.length >= max;
      const joinable = myTeam !== team && !full;
      return `<div class="fb-col" data-team="${team}" ${color ? `style="--team:${color}"` : ''}>
        <h3>${title}${team !== null ? ` <small>${members.length}/${max}</small>` : ''}</h3>
        <ul>${members.map((p) => chip(p)).join('') || '<li class="empty">Soltá acá</li>'}</ul>
        ${joinable ? `<button class="btn small" data-join="${team}">${team === null ? 'Mirar' : 'Unirme'}</button>` : ''}
      </div>`;
    };
    return `<div class="fb-setup">
      <div class="fb-head">
        <h2>⚽ Armado del partido</h2>
        <div class="roomcode"><span>Sala</span><b>${esc(r.code)}</b><button class="btn small" id="copy">Copiar link</button></div>
      </div>
      <div class="fb-opts">
        <label>Cancha ${seg('size', Object.keys(FB_SIZES).map((k) => [k, k]), fb.size)}</label>
        <label>Duración ${seg('minutes', FB_MINUTES, fb.minutes)}</label>
        <label>Goles ${seg('goals', FB_GOALS, fb.goals)}</label>
      </div>
      <div class="fb-teams">
        ${column(0, 'Rojo', '#ff4d6d')}
        ${column(null, 'Espectadores')}
        ${column(1, 'Azul', '#3a86ff')}
      </div>
      ${
        host
          ? `<div class="fb-actions">
              <button class="btn small" id="fbRandom">🎲 Random</button>
              <button class="btn small" id="fbReset">↺ Reset</button>
              <button class="btn small" id="fbBack">Volver a los juegos</button>
              <button class="btn primary" id="fbStart">¡Arrancar partido!</button>
            </div>`
          : `<p class="wait">Arrastrá tu nombre a un equipo (o tocá Unirme). ${esc(hostName)} arranca el partido.</p>`
      }
      <p class="keys">${isTouch ? '⚽ patea · 💨 embiste' : 'Espacio (o X) patea: cuanto más pegada la pelota, más fuerte · Shift embiste'}</p>
    </div>`;
  }

  function renderFutbolSetup(html) {
    const r = S.room;
    const panel = $('panel');
    const scroll = panel.firstElementChild?.scrollTop || 0;
    panel.innerHTML = html;
    panel.firstElementChild.scrollTop = scroll;
    const fb = (msg) => sendServer({ t: 'fb', ...msg });
    $('copy').onclick = () => copyLink(r.code);
    panel.querySelectorAll('[data-cfg]').forEach((b) => {
      b.onclick = () => {
        const v = b.dataset.cfg === 'size' ? b.dataset.v : Number(b.dataset.v);
        fb({ op: 'cfg', [b.dataset.cfg]: v });
      };
    });
    panel.querySelectorAll('li.drag').forEach((li) => enableDrag(li, (team) => fb({ op: 'team', id: Number(li.dataset.id), team })));
    panel.querySelectorAll('[data-join]').forEach((b) => {
      b.onclick = () => fb({ op: 'team', id: S.me, team: b.dataset.join === 'null' ? null : Number(b.dataset.join) });
    });
    if ($('fbRandom')) $('fbRandom').onclick = () => fb({ op: 'random' });
    if ($('fbReset')) $('fbReset').onclick = () => fb({ op: 'reset' });
    if ($('fbBack')) $('fbBack').onclick = () => sendServer({ t: 'setup', mode: null });
    if ($('fbStart')) $('fbStart').onclick = () => sendServer({ t: 'start', mode: 'futbol' });
  }

  // Arrastrar y soltar con pointer events: anda igual con mouse y con el dedo (el drag & drop nativo
  // de HTML no funciona en pantallas táctiles). Mientras se arrastra no se redibuja el panel.
  function enableDrag(li, onDrop) {
    li.addEventListener('pointerdown', (e) => {
      if (e.button > 0) return;
      const start = { x: e.clientX, y: e.clientY };
      const rect = li.getBoundingClientRect();
      let ghost = null;
      let over = null;
      try {
        li.setPointerCapture(e.pointerId); // seguir recibiendo el movimiento aunque salga del nombre
      } catch {}

      const columnAt = (x, y) => {
        if (ghost) ghost.style.display = 'none';
        const col = document.elementFromPoint(x, y)?.closest('.fb-col');
        if (ghost) ghost.style.display = '';
        return col;
      };
      const move = (ev) => {
        if (!ghost) {
          if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
          S.dragging = true;
          ghost = li.cloneNode(true);
          ghost.className = 'drag-ghost';
          ghost.style.width = `${rect.width}px`;
          document.body.appendChild(ghost);
          li.classList.add('dragging');
        }
        ghost.style.transform = `translate(${ev.clientX - rect.width / 2}px, ${ev.clientY - rect.height / 2}px)`;
        const col = columnAt(ev.clientX, ev.clientY);
        if (col !== over) {
          over?.classList.remove('drop-over');
          over = col;
          over?.classList.add('drop-over');
        }
      };
      const end = (ev) => {
        li.removeEventListener('pointermove', move);
        li.removeEventListener('pointerup', end);
        li.removeEventListener('pointercancel', end);
        if (!ghost) return;
        const col = ev.type === 'pointerup' ? columnAt(ev.clientX, ev.clientY) : null;
        ghost.remove();
        over?.classList.remove('drop-over');
        S.dragging = false;
        if (col && col !== li.closest('.fb-col')) {
          const t = col.dataset.team;
          onDrop(t === 'null' ? null : Number(t));
        }
        renderPanel();
      };
      li.addEventListener('pointermove', move);
      li.addEventListener('pointerup', end);
      li.addEventListener('pointercancel', end);
    });
  }

  function copyLink(code) {
    const link = `${location.origin}${location.pathname}?sala=${code}`;
    navigator.clipboard?.writeText(link).then(
      () => toast('Link copiado 👍'),
      () => prompt('Copiá el link:', link)
    ) ?? prompt('Copiá el link:', link);
  }

  function renderPanel() {
    if (S.dragging) return; // se redibuja al soltar
    const r = S.room;
    const host = isHost();
    const players = [...r.players].sort((a, b) => b.score - a.score || a.id - b.id);
    const online = players.filter((p) => p.connected).length;
    const mode = MODES.find((m) => m.key === S.selected) || MODES[0];
    const hostName = playerById(r.hostId)?.name || 'el host';

    let html = '<div class="card panel-card">' + resultsHtml(r);
    if (r.setup === 'futbol') return renderFutbolSetup(html + futbolSetupHtml(r, host, hostName) + '</div>');
    html += `<div class="cols">
      <div>
        <div class="roomcode"><span>Sala</span><b>${esc(r.code)}</b><button class="btn small" id="copy">Copiar link</button></div>
        <h3>Jugadores conectados: ${online}</h3>
        <ol class="players">${players
          .map(
            (p, i) => `<li class="${p.id === S.me ? 'me' : ''} ${p.connected ? '' : 'off'}">
              <span class="rank">${i + 1}</span>
              <span class="dot" style="background:${p.color}"></span>
              <span class="nm">${esc(p.name)}${p.id === r.hostId ? ' 👑' : ''}${p.id === S.me ? ' (vos)' : ''}</span>
              ${p.connected ? pingTag(p.rtt) : ''}
              <span class="sc">${p.score}</span>
            </li>`
          )
          .join('')}</ol>
      </div>
      <div>
        <h3>${host ? 'Elegí el juego' : 'Juegos'}</h3>
        <div class="modes">${MODES.map(
          (m) => `<button class="mode ${m.key === mode.key ? 'sel' : ''}" data-k="${m.key}" ${host ? '' : 'disabled'}>
            <span class="em">${m.emoji}</span><b>${m.title}</b><small>${m.desc}</small>
          </button>`
        ).join('')}</div>
        ${
          host
            ? `<button class="btn primary big" id="start">${mode.key === 'futbol' ? '⚽ Armar el partido' : `¡Jugar ${esc(mode.title)}!`}</button>`
            : `<p class="wait">Esperando a que ${esc(hostName)} arranque el próximo juego…</p>`
        }
        ${host && r.phase === 'results' ? '<div class="host-row"><button class="btn small" id="toLobby">Ocultar resultado</button></div>' : ''}
        <p class="keys">${isTouch ? 'Arrastrá el dedo para moverte · 💨 para embestir · ⚽ para patear' : 'Moverse: WASD o flechas · Embestida: Espacio (en fútbol: Shift; Espacio patea)'}</p>
      </div>
    </div></div>`;

    const panel = $('panel');
    const scroll = panel.firstElementChild?.scrollTop || 0;
    panel.innerHTML = html;
    panel.firstElementChild.scrollTop = scroll;

    $('copy').onclick = () => copyLink(r.code);
    panel.querySelectorAll('.mode').forEach((btn) => {
      btn.onclick = () => {
        S.selected = btn.dataset.k;
        S.selectedByMe = true;
        renderPanel();
      };
    });
    if ($('start'))
      $('start').onclick = () =>
        sendServer(S.selected === 'futbol' ? { t: 'setup', mode: 'futbol' } : { t: 'start', mode: S.selected });
    if ($('toLobby')) $('toLobby').onclick = () => sendServer({ t: 'lobby' });
  }

  $('endBtn').onclick = () => sendServer({ t: 'end' });

  // ---------- HUD ----------
  const hudCache = {};
  function setHud(id, html) {
    if (hudCache[id] === html) return;
    hudCache[id] = html;
    $(id).innerHTML = html;
  }

  function hud(snap) {
    const round = S.round;
    if (!round) return;
    // Reloj: cuenta regresiva; sin límite (tl null) cuenta para arriba; empatados al final, gol de oro.
    const secs = snap.tl ?? snap.x?.el ?? 0;
    const clock = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    setHud('hudMode', esc(round.title));
    setHud('hudTime', snap.x?.ot ? 'Gol de oro' : clock);
    $('hudTime').classList.toggle('low', snap.ph === 'playing' && ((snap.tl != null && snap.tl <= 10) || !!snap.x?.ot));

    const mine = snap.b.find((b) => b.i === S.me);
    let info = '';
    let banner = '';
    if (round.mode === 'sumo') {
      info = `Quedan <b>${snap.b.filter((b) => !b.o).length}</b>/${snap.b.length}`;
    } else if (round.mode === 'infeccion') {
      const z = snap.b.filter((b) => b.z).length;
      info = `🧑 <b>${snap.b.length - z}</b> · 🧟 <b>${z}</b>`;
      if (mine?.z) banner = '🧟 Sos zombie: ¡contagiá a todos!';
    } else if (round.mode === 'pintada' && snap.x?.c) {
      const total = round.info.cols * round.info.rows;
      info = snap.x.c
        .map((c, t) => `<span class="teambar"><i style="background:${round.info.teams[t].color}"></i>${Math.round((c / total) * 100)}%</span>`)
        .join('');
      if (mine) banner = '';
    } else if (round.mode === 'futbol' && snap.x?.s) {
      const [red, blue] = round.info.teams;
      info = `<span class="teambar"><i style="background:${red.color}"></i>${snap.x.s[0]}</span> – <span class="teambar">${snap.x.s[1]}<i style="background:${blue.color}"></i></span>`;
    }
    if (round.mode === 'futbol' && snap.x?.ko != null) {
      const t = round.info.teams[snap.x.ko];
      banner = `Saca ${t.name}${mine?.tm === snap.x.ko ? ': ¡te toca!' : ''}`;
    }
    setHud('hudInfo', info);
    const ping = Math.round(P.rtt);
    setHud('hudPing', P.rtt ? `<span class="net ${ping < 60 ? 'p2p' : ping < 120 ? 'relay' : 'bad'}">${ping} ms</span>` : '');
    $('banner').classList.toggle('hidden', !banner);
    setHud('banner', esc(banner));

    $('dash').classList.toggle('hidden', !mine || !!mine.o);
    if (mine) {
      const ready = P.active ? 1 - P.dashCd / P.cooldown : 1 - (mine.c || 0) / 9;
      $('dash').querySelector('i').style.width = `${ready * 100}%`;
      setHud('dashLabel', isTouch ? '💨 embestida' : round.mode === 'futbol' ? 'Shift = embestida · Espacio = patear' : 'Espacio = embestida');
    }

    let center = '';
    if (snap.ph === 'countdown') {
      let team = '';
      if (round.info.teams && mine) {
        const t = round.info.teams[mine.tm];
        team = `<div class="help">Sos del equipo <b style="color:${t.color}">${esc(t.name)}</b></div>`;
      }
      if (round.mode === 'infeccion' && mine?.z) team = '<div class="help">🧟 <b>Arrancás de zombie</b></div>';
      center = `<div class="big">${snap.cd}</div><div class="title">${esc(round.title)}</div><div class="help">${esc(round.help)}</div>${team}`;
    } else if (snap.x?.gol) {
      center = `<div class="big">¡GOL!</div><div class="title">${esc(snap.x.gol)}</div>`;
    } else if (!mine) {
      center = '<div class="note">👀 Estás mirando: entrás en la próxima ronda</div>';
    } else if (mine.o) {
      center = '<div class="note">🫠 ¡Afuera! Mirá cómo termina</div>';
    }
    setHud('center', center);

    const now = performance.now();
    S.feed = S.feed.filter((f) => now - f.at < 4500).slice(-5);
    setHud('feed', S.feed.map((f) => `<div>${esc(f.text)}</div>`).join(''));
  }

  // ---------- Input ----------
  const keys = new Set();
  let lastSent = '';
  let lastSentAt = 0;
  const joy = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
  window.__ttb.joy = joy;

  function direction() {
    let x = 0;
    let y = 0;
    if (joy.id !== null) {
      x = joy.x;
      y = joy.y;
    } else {
      x = (keys.has('d') || keys.has('arrowright') ? 1 : 0) - (keys.has('a') || keys.has('arrowleft') ? 1 : 0);
      y = (keys.has('s') || keys.has('arrowdown') ? 1 : 0) - (keys.has('w') || keys.has('arrowup') ? 1 : 0);
    }
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }

  // Intención de movimiento: sale en el mismo evento en que cambia (y un latido cada 2 s).
  // Con el dedo, el navegador dispara 60-120 eventos por segundo: se manda como máximo uno cada 33 ms
  // (el primer cambio sale al instante; el último siempre llega) y la dirección se redondea para que
  // los temblores del dedo no generen mensajes. Sin esto el servidor corta por exceso de mensajes.
  const INPUT_MIN_GAP_MS = 33;
  let inputTimer = null;

  function quantize(d) {
    const mag = Math.round(Math.min(1, Math.hypot(d.x, d.y)) * 10) / 10;
    if (!mag) return { x: 0, y: 0 };
    const step = Math.PI / 32; // 64 direcciones (5,6°)
    const a = Math.round(Math.atan2(d.y, d.x) / step) * step;
    return { x: Math.round(Math.cos(a) * mag * 100) / 100, y: Math.round(Math.sin(a) * mag * 100) / 100 };
  }

  function sendInput(force) {
    const phase = S.room?.phase;
    if (!S.ws || S.ws.readyState !== 1 || (phase !== 'countdown' && phase !== 'playing')) return;
    const { x, y } = quantize(direction());
    const sig = `${x},${y}`;
    const now = performance.now();
    if (!force && sig === lastSent && now - lastSentAt < 2000) return;
    const wait = INPUT_MIN_GAP_MS - (now - lastSentAt);
    if (wait > 0) {
      inputTimer ??= setTimeout(() => {
        inputTimer = null;
        sendInput(force);
      }, wait);
      return;
    }
    clearTimeout(inputTimer);
    inputTimer = null;
    lastSent = sig;
    lastSentAt = now;
    sendServer({ t: 'in', x, y });
  }

  // Patear (fútbol): el servidor decide si la pelota está en el área; acá solo el destello inmediato.
  function kick() {
    if (S.room?.phase !== 'playing') return;
    sendInput();
    sendServer({ t: 'kick' });
    P.kickAt = performance.now();
  }

  // Acción: directo desde el evento de teclado; el servidor la aplica al llegar.
  function dash() {
    if (P.active) P.dashQueued = true;
    sendInput();
    if (S.room?.phase === 'playing') sendServer({ t: 'dash' });
  }

  // Medición de latencia (eco): alimenta la predicción, el ping del HUD y el del lobby.
  setInterval(() => {
    if (S.ws?.readyState === 1 && S.me) sendServer({ t: 'eco', c: performance.now(), r: P.rtt ? Math.round(P.rtt) : null });
  }, 2000);

  // ---------- Predicción ----------
  function reconcile(snap) {
    const mine = snap.b.find((b) => b.i === S.me);
    if (!mine || mine.o || snap.ph !== 'playing') {
      P.active = false;
      P.dashQueued = false;
      return;
    }
    P.stun = !!mine.s;
    P.speed = mine.sp || 1;
    P.cooldown = mine.dc || 1.4;
    const reset = () => {
      Object.assign(P, { x: mine.x, y: mine.y, vx: mine.vx, vy: mine.vy, ox: 0, oy: 0, hist: [] });
    };
    if (!P.active) {
      P.active = true;
      P.dashCd = 0;
      return reset();
    }
    // Si la predicción estuvo frenada (pestaña de fondo, rAF pausado), no hay historia con qué comparar:
    // tomar directo la posición del servidor.
    if (!P.lastStep || performance.now() - P.lastStep > 250) return reset();
    // El estado que manda el servidor incluye tus teclas de hace ~1 RTT (+ ~8 ms de espera al próximo paso):
    // se compara con lo que se predijo para ese momento.
    const target = performance.now() - P.rtt - 8;
    let past = null;
    for (const h of P.hist) {
      if (h.t > target) break;
      past = h;
    }
    if (!past) return;
    const ex = mine.x - past.x;
    const ey = mine.y - past.y;
    P.err = Math.hypot(ex, ey); // para depurar: cuánto se equivocó la predicción
    if (Math.hypot(ex, ey) > 160) return reset();
    // Corrección completa e inmediata (un empujón se siente apenas llega); lo que se dibuja se desliza
    // hacia la posición corregida en ~50 ms para que no salte.
    const fix = { x: ex, y: ey, vx: mine.vx - past.vx, vy: mine.vy - past.vy };
    for (const s of [P, ...P.hist]) {
      s.x += fix.x;
      s.y += fix.y;
      s.vx += fix.vx;
      s.vy += fix.vy;
    }
    P.ox -= fix.x;
    P.oy -= fix.y;
  }

  function predictStep(dt, now, others) {
    const phys = S.round.phys;
    const pr = S.round.info.playerR || R; // en fútbol el blob es más chico
    const inp = P.stun ? { x: 0, y: 0 } : quantize(direction()); // la misma dirección que recibe el servidor
    P.dashCd = Math.max(0, P.dashCd - dt);
    if (P.dashQueued) {
      P.dashQueued = false;
      let dx = inp.x;
      let dy = inp.y;
      if (!dx && !dy) {
        const s = Math.hypot(P.vx, P.vy);
        if (s > 20) {
          dx = P.vx / s;
          dy = P.vy / s;
        }
      }
      const len = Math.hypot(dx, dy);
      if (!P.stun && P.dashCd <= 0 && len > 0) {
        P.vx += (dx / len) * phys.dashPow;
        P.vy += (dy / len) * phys.dashPow;
        P.dashCd = P.cooldown;
        P.dashT = 0.25;
      }
    }
    P.dashT = Math.max(0, (P.dashT || 0) - dt);
    // Mismo frenado exponencial que el servidor (BaseMode.move).
    const k = 1 - Math.exp(-phys.grip * dt);
    P.vx += (inp.x * phys.maxV * P.speed - P.vx) * k;
    P.vy += (inp.y * phys.maxV * P.speed - P.vy) * k;
    P.x += P.vx * dt;
    P.y += P.vy * dt;

    // Choques con los demás: la misma respuesta que BaseMode.collide, aplicada solo a tu blob
    // (a los demás los mueve el servidor). Rebote al instante en vez de esperar la ida y vuelta.
    for (const o of others) {
      if (o.o || o.i === S.me) continue;
      const dx = o.x - P.x;
      const dy = o.y - P.y;
      const d = Math.hypot(dx, dy);
      if (!d || d >= pr * 2) continue;
      const nx = dx / d;
      const ny = dy / d;
      P.x -= nx * (pr * 2 - d); // el otro no se mueve acá: salir del todo
      P.y -= ny * (pr * 2 - d);
      const rv = (o.vx - P.vx) * nx + (o.vy - P.vy) * ny;
      if (rv < 0) {
        const imp = (-(1 + phys.bounce) * rv) / 2;
        P.vx -= imp * nx;
        P.vy -= imp * ny;
      }
      if (phys.dashBoost) {
        if (P.dashT > 0) P.dashT = 0; // tu embestida se gasta en el impacto
        // Su embestida te empuja una sola vez por choque.
        if (o.d && now - (P.hitBy.get(o.i) || 0) > 300) {
          P.hitBy.set(o.i, now);
          P.vx -= nx * phys.dashBoost;
          P.vy -= ny * phys.dashBoost;
        }
      }
    }
    for (const c of S.round.info.posts || []) {
      const dx = P.x - c.x;
      const dy = P.y - c.y;
      const d = Math.hypot(dx, dy);
      if (!d || d >= pr + c.r) continue;
      P.x = c.x + (dx / d) * (pr + c.r);
      P.y = c.y + (dy / d) * (pr + c.r);
      const vn = (P.vx * dx + P.vy * dy) / d;
      if (vn < 0) {
        P.vx -= (1.3 * vn * dx) / d;
        P.vy -= (1.3 * vn * dy) / d;
      }
    }
    for (const w of S.round.info.walls || []) {
      const cx = Math.max(w.x, Math.min(P.x, w.x + w.w));
      const cy = Math.max(w.y, Math.min(P.y, w.y + w.h));
      const dx = P.x - cx;
      const dy = P.y - cy;
      const d = Math.hypot(dx, dy);
      if (d >= pr || d === 0) continue;
      P.x += (dx / d) * (pr - d);
      P.y += (dy / d) * (pr - d);
      const vn = (P.vx * dx + P.vy * dy) / d;
      if (vn < 0) {
        P.vx -= (1.3 * vn * dx) / d;
        P.vy -= (1.3 * vn * dy) / d;
      }
    }
    // Saque del medio (fútbol): las mismas trabas que Futbol.kickoffLimits, para no chocar contra la línea.
    const ko = S.snap?.x?.ko;
    const myTeam = S.snap?.b.find((b) => b.i === S.me)?.tm;
    if (ko != null && myTeam != null) {
      const { cx, cy } = S.round.info.field;
      if (myTeam === 0 && P.x > cx - pr) [P.x, P.vx] = [cx - pr, Math.min(0, P.vx)];
      if (myTeam === 1 && P.x < cx + pr) [P.x, P.vx] = [cx + pr, Math.max(0, P.vx)];
      const dx = P.x - cx;
      const dy = P.y - cy;
      const d = Math.hypot(dx, dy);
      const min = S.round.info.circleR + pr;
      if (myTeam !== ko && d < min) {
        const nx = d ? dx / d : myTeam === 0 ? -1 : 1;
        const ny = d ? dy / d : 0;
        P.x = cx + nx * min;
        P.y = cy + ny * min;
      }
    }
    if (phys.bounded) {
      const box = phys.box || { x0: 0, y0: 0, x1: W, y1: H };
      P.x = Math.max(box.x0 + pr, Math.min(box.x1 - pr, P.x));
      P.y = Math.max(box.y0 + pr, Math.min(box.y1 - pr, P.y));
    }
    P.hist.push({ t: now, x: P.x, y: P.y, vx: P.vx, vy: P.vy });
    P.lastStep = now;
    const fade = Math.exp(-dt / 0.05);
    P.ox *= fade;
    P.oy *= fade;
    while (P.hist.length && now - P.hist[0].t > 1500) P.hist.shift();
  }

  const GAME_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' ', 'shift', 'x'];
  addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (!GAME_KEYS.includes(k)) return;
    if (S.round) e.preventDefault();
    // En fútbol: Espacio (o X) patea y Shift embiste. En el resto, Espacio o Shift embisten.
    const futbol = S.round?.mode === 'futbol';
    if (!e.repeat) {
      if (futbol && (k === ' ' || k === 'x')) kick();
      else if (k === 'shift' || (!futbol && k === ' ')) dash();
    }
    keys.add(k);
    sendInput();
  });
  addEventListener('keyup', (e) => {
    keys.delete(e.key.toLowerCase());
    sendInput();
  });
  addEventListener('blur', () => {
    keys.clear();
    sendInput();
  });
  setInterval(sendInput, 50);

  const cv = $('cv');
  cv.addEventListener('touchstart', (e) => {
    const t = e.changedTouches[0];
    if (joy.id !== null || !S.round) return;
    Object.assign(joy, { id: t.identifier, ox: t.clientX, oy: t.clientY, x: 0, y: 0 });
  }, { passive: true });
  cv.addEventListener('touchmove', (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier !== joy.id) continue;
      const dx = (t.clientX - joy.ox) / 50;
      const dy = (t.clientY - joy.oy) / 50;
      const len = Math.hypot(dx, dy);
      joy.x = len > 1 ? dx / len : dx;
      joy.y = len > 1 ? dy / len : dy;
      sendInput();
    }
  }, { passive: true });
  const endTouch = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === joy.id) {
        joy.id = null;
        sendInput(true);
      }
    }
  };
  cv.addEventListener('touchend', endTouch);
  cv.addEventListener('touchcancel', endTouch);
  $('touchKick').addEventListener('touchstart', (e) => {
    e.preventDefault();
    kick();
  });
  $('touchDash').addEventListener('touchstart', (e) => {
    e.preventDefault();
    dash();
  });

  // ---------- Dibujo ----------
  const ctx = cv.getContext('2d');

  // Posición a dibujar de cada jugador: último snapshot + extrapolación (ver entityPos).
  function currentBodies(now) {
    return S.snap.b.map((o) => ({ ...o, ...entityPos(S.ents.get(o.i), now) }));
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, r);
  }

  function drawSumo(extra, now) {
    const { cx, cy, r0 } = S.round.info;
    const r = extra?.r ?? r0;
    for (let i = 0; i < 70; i++) {
      const sx = (i * 397) % W;
      const sy = (i * 211) % H;
      ctx.fillStyle = `rgba(255,255,255,${0.15 + 0.15 * Math.sin(now / 600 + i)})`;
      ctx.fillRect(sx, sy, 3, 3);
    }
    ctx.strokeStyle = 'rgba(118,70,221,0.45)';
    ctx.setLineDash([14, 14]);
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, r0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + 26, r, r * 0.98, 0, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
    g.addColorStop(0, '#fbe9cf');
    g.addColorStop(1, '#efcf9f');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 12;
    ctx.strokeStyle = r < r0 * 0.995 ? `hsl(${16 + 6 * Math.sin(now / 150)},96%,${55 + 8 * Math.sin(now / 150)}%)` : '#c98d4b';
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(160,100,40,0.35)';
    ctx.beginPath();
    ctx.arc(cx, cy, Math.max(10, r * 0.55), 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawInfeccion() {
    ctx.fillStyle = '#1b2036';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.04)';
    ctx.lineWidth = 2;
    for (let x = 0; x <= W; x += 50) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = 0; y <= H; y += 50) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    for (const w of S.round.info.walls) {
      ctx.fillStyle = '#0b0d1a';
      roundRect(w.x, w.y + 8, w.w, w.h, 8);
      ctx.fill();
      ctx.fillStyle = '#4a5288';
      roundRect(w.x, w.y, w.w, w.h, 8);
      ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      roundRect(w.x + 4, w.y + 4, w.w - 8, Math.min(10, w.h - 8), 4);
      ctx.fill();
    }
    ctx.strokeStyle = '#4a5288';
    ctx.lineWidth = 8;
    ctx.strokeRect(-4, -4, W + 8, H + 8);
  }

  function drawPintada(extra, now) {
    const { cell, cols, rows, teams } = S.round.info;
    ctx.fillStyle = '#e9ebf5';
    ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const v = S.grid[r * cols + c];
        if (!v) continue;
        ctx.fillStyle = teams[v - 1].color;
        ctx.fillRect(c * cell, r * cell, cell + 0.5, cell + 0.5);
      }
    }
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth = 1;
    for (let c = 0; c <= cols; c++) {
      ctx.beginPath();
      ctx.moveTo(c * cell, 0);
      ctx.lineTo(c * cell, H);
      ctx.stroke();
    }
    for (let r = 0; r <= rows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * cell);
      ctx.lineTo(W, r * cell);
      ctx.stroke();
    }
    ctx.strokeStyle = '#4a5288';
    ctx.lineWidth = 8;
    ctx.strokeRect(-4, -4, W + 8, H + 8);

    for (const [, x, y] of extra?.k || []) {
      const bob = Math.sin(now / 200 + x) * 5;
      const pulse = 1 + Math.sin(now / 150) * 0.08;
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.beginPath();
      ctx.ellipse(x, y + 22, 18, 6, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.translate(x, y + bob);
      ctx.scale(pulse, pulse);
      const g = ctx.createConicGradient(now / 400, 0, 0);
      teams.forEach((t, i) => g.addColorStop(i / teams.length, t.color));
      g.addColorStop(1, teams[0].color);
      ctx.fillStyle = g;
      ctx.strokeStyle = '#1b1d36';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-15, -12);
      ctx.lineTo(15, -12);
      ctx.lineTo(11, 16);
      ctx.lineTo(-11, 16);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -12, 13, Math.PI, 0);
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawCancha() {
    const { field: f, goal: g, posts, teams, view } = S.round.info;
    const { cx, cy } = f;
    // Pasto a franjas.
    const stripes = 12;
    const sw = (f.x1 - f.x0) / stripes;
    ctx.fillStyle = '#1f7a3f';
    ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 ? '#1f7a3f' : '#238a47';
      ctx.fillRect(f.x0 + i * sw, f.y0, sw + 0.5, f.y1 - f.y0);
    }
    // Arcos: la red, con el color del equipo que defiende.
    for (const [side, team] of [
      [-1, teams[0]],
      [1, teams[1]],
    ]) {
      const x = side < 0 ? f.x0 - g.depth : f.x1;
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(x, g.top, g.depth, g.bottom - g.top);
      ctx.strokeStyle = 'rgba(255,255,255,0.18)';
      ctx.lineWidth = 1.5;
      for (let yy = g.top + 12; yy < g.bottom; yy += 12) {
        ctx.beginPath();
        ctx.moveTo(x, yy);
        ctx.lineTo(x + g.depth, yy);
        ctx.stroke();
      }
      ctx.strokeStyle = team.color;
      ctx.lineWidth = 5;
      ctx.beginPath();
      const back = side < 0 ? f.x0 - g.depth : f.x1 + g.depth;
      const line = side < 0 ? f.x0 : f.x1;
      ctx.moveTo(line, g.top);
      ctx.lineTo(back, g.top);
      ctx.lineTo(back, g.bottom);
      ctx.lineTo(line, g.bottom);
      ctx.stroke();
    }
    // Líneas de la cancha.
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 4;
    ctx.strokeRect(f.x0, f.y0, f.x1 - f.x0, f.y1 - f.y0);
    ctx.beginPath();
    ctx.moveTo(cx, f.y0);
    ctx.lineTo(cx, f.y1);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, S.round.info.circleR, 0, Math.PI * 2);
    ctx.stroke();
    for (const side of [-1, 1]) {
      const line = side < 0 ? f.x0 : f.x1;
      const boxW = Math.min(160, (f.x1 - f.x0) * 0.12);
      const boxH = Math.min(380, (f.y1 - f.y0) * 0.55);
      ctx.strokeRect(side < 0 ? line : line - boxW, cy - boxH / 2, boxW, boxH);
    }
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx, cy, 5, 0, Math.PI * 2);
    ctx.fill();
    // Palos.
    for (const p of posts) {
      ctx.fillStyle = '#f3f4ff';
      ctx.strokeStyle = 'rgba(0,0,0,0.35)';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
  }

  function drawBall(now) {
    if (!S.ball) return;
    const { x, y } = entityPos(S.ball, now);
    const r = S.round.info.ballR;
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(x + 3, y + r * 0.8, r, r * 0.45, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#1b1d36';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Gajos que giran con la distancia recorrida, para que se note que rueda.
    const spin = (x + y) / r;
    ctx.fillStyle = '#1b1d36';
    for (let i = 0; i < 3; i++) {
      const a = spin + (i * Math.PI * 2) / 3;
      ctx.beginPath();
      ctx.arc(x + Math.cos(a) * r * 0.5, y + Math.sin(a) * r * 0.5, r * 0.22, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawBody(o, now, scale) {
    const round = S.round;
    const player = playerById(o.i);
    let color = player?.color || '#ccc';
    if (round.info.teams) color = round.info.teams[o.tm].color;
    if (o.z) color = '#5f7f3a';

    let size = 1;
    let alpha = 1;
    if (o.o) {
      if (!S.fallen.has(o.i)) S.fallen.set(o.i, now);
      const k = (now - S.fallen.get(o.i)) / 700;
      if (k >= 1) return;
      size = 1 - k;
      alpha = 1 - k * 0.7;
    }

    const look = S.look.get(o.i) || { x: o.x, y: o.y, dx: 0, dy: 1 };
    const mx = o.x - look.x;
    const my = o.y - look.y;
    const ml = Math.hypot(mx, my);
    if (ml > 0.5) {
      look.dx += (mx / ml - look.dx) * 0.25;
      look.dy += (my / ml - look.dy) * 0.25;
    }
    look.x = o.x;
    look.y = o.y;
    S.look.set(o.i, look);
    const dl = Math.hypot(look.dx, look.dy) || 1;
    const dx = look.dx / dl;
    const dy = look.dy / dl;

    const r = (round.info.playerR || R) * size;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(o.x, o.y);

    if (o.d) {
      for (let i = 1; i <= 3; i++) {
        ctx.fillStyle = color;
        ctx.globalAlpha = alpha * (0.25 - i * 0.06);
        ctx.beginPath();
        ctx.arc(-dx * i * 14, -dy * i * 14, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = alpha;
    }

    if (!o.o) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(0, r * 0.85, r * 0.9, r * 0.35, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    if (o.z) {
      const aura = ctx.createRadialGradient(0, 0, r * 0.6, 0, 0, r * 2);
      aura.addColorStop(0, `rgba(230,40,60,${0.45 + 0.15 * Math.sin(now / 180 + o.i)})`);
      aura.addColorStop(1, 'rgba(230,40,60,0)');
      ctx.fillStyle = aura;
      ctx.beginPath();
      ctx.arc(0, 0, r * 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // Fútbol: tu área de disparo (se ilumina con la pelota a tiro) y borde blanco cuando alguien patea.
    if (round.mode === 'futbol' && !o.o) {
      if (o.i === S.me && S.ball) {
        const reach = r + round.info.kickReach;
        const b = entityPos(S.ball, now);
        const inRange = Math.hypot(b.x - o.x, b.y - o.y) - round.info.ballR <= reach;
        const flash = P.kickAt && now - P.kickAt < 150;
        ctx.strokeStyle = flash ? 'rgba(255,255,255,0.95)' : inRange ? 'rgba(255,255,255,0.6)' : 'rgba(255,255,255,0.18)';
        ctx.lineWidth = flash ? 4 : 2;
        ctx.beginPath();
        ctx.arc(0, 0, reach, 0, Math.PI * 2);
        ctx.stroke();
      }
      if (o.k) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 5;
        ctx.beginPath();
        ctx.arc(0, 0, r + 3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    if (o.i === S.me && round.mode !== 'futbol') {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 6]);
      ctx.lineDashOffset = -now / 40;
      ctx.beginPath();
      ctx.arc(0, 0, r + 7, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    const squash = 1 + Math.sin(now / 120 + o.i) * 0.03;
    ctx.fillStyle = color;
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, 0, r * squash, r / squash, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.beginPath();
    ctx.ellipse(-r * 0.35, -r * 0.4, r * 0.3, r * 0.18, -0.5, 0, Math.PI * 2);
    ctx.fill();

    const px = -dy;
    const py = dx;
    for (const side of [-1, 1]) {
      const ex = dx * r * 0.3 + px * side * r * 0.32;
      const ey = dy * r * 0.3 + py * side * r * 0.32 - r * 0.1;
      const er = r * (o.z && side === 1 ? 0.24 : 0.28);
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(ex, ey, er, 0, Math.PI * 2);
      ctx.fill();
      if (o.dz) {
        // Mareado por un pelotazo: ojos en espiral que giran (cada uno para un lado).
        ctx.strokeStyle = '#1a1a2e';
        ctx.lineWidth = Math.max(1.2, er * 0.18);
        ctx.beginPath();
        const turn = (now / 90) * side;
        for (let k = 0; k <= 26; k++) {
          const a = turn + k * 0.5;
          const rr = (er * 0.85 * k) / 26;
          const sx = ex + Math.cos(a) * rr;
          const sy = ey + Math.sin(a) * rr;
          if (k) ctx.lineTo(sx, sy);
          else ctx.moveTo(sx, sy);
        }
        ctx.stroke();
        continue;
      }
      ctx.fillStyle = o.z ? '#d62839' : '#1a1a2e';
      ctx.beginPath();
      ctx.arc(ex + dx * er * 0.4, ey + dy * er * 0.4, er * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }

    if (o.s || o.dz) {
      ctx.font = '16px system-ui';
      ctx.textAlign = 'center';
      for (let i = 0; i < 3; i++) {
        const a = now / 200 + (i * Math.PI * 2) / 3;
        ctx.fillText('⭐', Math.cos(a) * r, -r - 6 + Math.sin(a) * 5);
      }
    }

    if (!o.o) {
      const fs = Math.max(17, 13 / scale);
      ctx.font = `600 ${fs}px Fredoka, system-ui`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const label = player?.name || '?';
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(10,10,25,0.85)';
      ctx.strokeText(label, 0, -r - 8);
      ctx.fillStyle = o.i === S.me ? '#ffd166' : '#fff';
      ctx.fillText(label, 0, -r - 8);
    }
    ctx.restore();
  }

  function drawIdle(now, cw, ch) {
    for (let i = 0; i < 14; i++) {
      const x = ((i * 173 + now * 0.02 * (1 + (i % 3))) % (cw + 200)) - 100;
      const y = ch * ((i * 0.37) % 1) + Math.sin(now / 900 + i) * 30;
      const r = 18 + (i % 4) * 8;
      ctx.fillStyle = `hsla(${(i * 137) % 360},80%,62%,0.18)`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawJoystick() {
    if (joy.id === null) return;
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(joy.ox, joy.oy, 50, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.beginPath();
    ctx.arc(joy.ox + joy.x * 50, joy.oy + joy.y * 50, 22, 0, Math.PI * 2);
    ctx.fill();
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dpr = Math.min(2, devicePixelRatio || 1);
    const cw = innerWidth;
    const ch = innerHeight;
    if (cv.width !== Math.round(cw * dpr) || cv.height !== Math.round(ch * dpr)) {
      cv.width = Math.round(cw * dpr);
      cv.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0f1020';
    ctx.fillRect(0, 0, cw, ch);

    const inRound = S.round && S.snap && (S.room?.phase === 'countdown' || S.room?.phase === 'playing');
    if (!inRound) return drawIdle(now, cw, ch);

    const top = 56;
    // Cámara: el mundo entero, o el rectángulo que pida el modo (fútbol: la cancha del tamaño elegido).
    const v = S.round.info.view || { x0: 0, y0: 0, x1: W, y1: H };
    const vw = v.x1 - v.x0;
    const vh = v.y1 - v.y0;
    const scale = Math.min((cw - 16) / vw, (ch - top - 12) / vh);
    const ox = (cw - vw * scale) / 2 - v.x0 * scale;
    const oy = top + (ch - top - vh * scale) / 2 - v.y0 * scale;
    ctx.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * ox, dpr * oy);

    const bodies = currentBodies(now);
    const extra = S.snap.x;
    const dt = Math.min(0.05, (now - (frame.last || now)) / 1000);
    frame.last = now;
    const mineIdx = bodies.findIndex((o) => o.i === S.me);
    if (mineIdx >= 0 && P.active) {
      predictStep(dt, now, bodies);
      bodies[mineIdx] = { ...bodies[mineIdx], x: P.x + P.ox, y: P.y + P.oy };
    }
    if (S.round.mode === 'sumo') drawSumo(extra, now);
    else if (S.round.mode === 'infeccion') drawInfeccion();
    else if (S.round.mode === 'pintada') drawPintada(extra, now);
    else if (S.round.mode === 'futbol') drawCancha();

    bodies.sort((a, b) => (b.o || 0) - (a.o || 0) || a.y - b.y);
    for (const o of bodies) drawBody(o, now, scale);
    if (S.round.mode === 'futbol') drawBall(now);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawJoystick();
  }
  requestAnimationFrame(frame);
})();
