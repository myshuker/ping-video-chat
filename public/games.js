/* ============================================================
   Ping mini-games: Tetris, Pac-Man, River Raid, Space Invaders
   Every game is a small canvas game with the same interface:
     { W, H, score, over, update(dt), draw(), key(name, isDown) }
   key names: left right up down a
   All players in a call get the same random seed, so everybody
   plays exactly the same game (same pieces, same waves…).
   ============================================================ */
(() => {
  'use strict';

  const rngFrom = seed => {            // small seeded random number generator
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const text = (ctx, s, x, y, size = 14, color = '#fff', align = 'left') => {
    ctx.fillStyle = color; ctx.font = `700 ${size}px system-ui, sans-serif`;
    ctx.textAlign = align; ctx.textBaseline = 'alphabetic'; ctx.fillText(s, x, y);
  };

  /* ============================================================
     TETRIS
     ============================================================ */
  function makeTetris(ctx, rand) {
    const COLS = 10, ROWS = 20, S = 24, W = 360, H = 480;
    const PIECES = [
      { c: '#00d8ff', m: [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]] },   // I
      { c: '#ffd400', m: [[1,1],[1,1]] },                                // O
      { c: '#b44dff', m: [[0,1,0],[1,1,1],[0,0,0]] },                    // T
      { c: '#3ddc6b', m: [[0,1,1],[1,1,0],[0,0,0]] },                    // S
      { c: '#ff4d4d', m: [[1,1,0],[0,1,1],[0,0,0]] },                    // Z
      { c: '#4d7cff', m: [[1,0,0],[1,1,1],[0,0,0]] },                    // J
      { c: '#ff9d2e', m: [[0,0,1],[1,1,1],[0,0,0]] },                    // L
    ];
    let grid, cur, next, bag = [], score = 0, lines = 0, level = 1, acc = 0, over = false;
    const hold = { dir: 0, t: 0 }; let down = false;

    const copy = m => m.map(r => r.slice());
    const rotate = m => m[0].map((_, i) => m.map(r => r[i]).reverse());
    const draw7 = () => {
      if (!bag.length) {
        bag = [0, 1, 2, 3, 4, 5, 6];
        for (let i = 6; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
      }
      return bag.pop();
    };
    function collide(m, x, y) {
      for (let cy = 0; cy < m.length; cy++) for (let cx = 0; cx < m[cy].length; cx++) {
        if (!m[cy][cx]) continue;
        const nx = x + cx, ny = y + cy;
        if (nx < 0 || nx >= COLS || ny >= ROWS) return true;
        if (ny >= 0 && grid[ny][nx]) return true;
      }
      return false;
    }
    function spawn() {
      const p = PIECES[next];
      cur = { i: next, m: copy(p.m), x: Math.floor((COLS - p.m.length) / 2), y: p.m.length === 4 ? -1 : 0 };
      next = draw7();
      if (collide(cur.m, cur.x, cur.y)) over = true;
    }
    function lock() {
      cur.m.forEach((row, cy) => row.forEach((v, cx) => {
        const y = cur.y + cy, x = cur.x + cx;
        if (v && y >= 0) grid[y][x] = PIECES[cur.i].c;
      }));
      let n = 0;
      for (let y = ROWS - 1; y >= 0;) {
        if (grid[y].every(Boolean)) { grid.splice(y, 1); grid.unshift(Array(COLS).fill(0)); n++; } else y--;
      }
      if (n) { lines += n; level = 1 + Math.floor(lines / 10); score += [0, 100, 300, 500, 800][n] * level; }
      spawn();
    }
    const move = dx => { if (!collide(cur.m, cur.x + dx, cur.y)) cur.x += dx; };
    function turn() {
      const r = rotate(cur.m);
      for (const k of [0, -1, 1, -2, 2]) {
        if (!collide(r, cur.x + k, cur.y)) { cur.m = r; cur.x += k; return; }
      }
    }
    function hardDrop() {
      let d = 0;
      while (!collide(cur.m, cur.x, cur.y + 1)) { cur.y++; d++; }
      score += d * 2; lock(); acc = 0;
    }

    grid = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    next = draw7(); spawn();

    const cell = (x, y, c, a = 1) => {
      ctx.globalAlpha = a;
      ctx.fillStyle = c; ctx.fillRect(x * S + 1, y * S + 1, S - 2, S - 2);
      ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.fillRect(x * S + 1, y * S + 1, S - 2, 4);
      ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(x * S + 1, y * S + S - 5, S - 2, 4);
      ctx.globalAlpha = 1;
    };

    return {
      W, H,
      get score() { return score }, get over() { return over },
      get info() { return { lines, level } },
      update(dt) {
        if (over) return;
        if (hold.dir) {
          hold.t -= dt;
          while (hold.t <= 0) { move(hold.dir); hold.t += 0.055; }
        }
        acc += dt;
        const interval = down ? 0.045 : Math.max(0.09, 0.8 - (level - 1) * 0.07);
        while (acc >= interval && !over) {
          acc -= interval;
          if (!collide(cur.m, cur.x, cur.y + 1)) { cur.y++; if (down) score++; } else lock();
        }
      },
      key(k, d) {
        if (over) return;
        if (k === 'left' || k === 'right') {
          const dir = k === 'left' ? -1 : 1;
          if (d) { move(dir); hold.dir = dir; hold.t = 0.17; } else if (hold.dir === dir) hold.dir = 0;
        } else if (k === 'down') down = d;
        else if (d && k === 'up') turn();
        else if (d && k === 'a') hardDrop();
      },
      draw() {
        ctx.fillStyle = '#0b1020'; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = '#10182e'; ctx.fillRect(0, 0, COLS * S, H);
        ctx.strokeStyle = 'rgba(255,255,255,.05)'; ctx.lineWidth = 1;
        for (let x = 1; x < COLS; x++) { ctx.beginPath(); ctx.moveTo(x * S + .5, 0); ctx.lineTo(x * S + .5, H); ctx.stroke(); }
        for (let y = 1; y < ROWS; y++) { ctx.beginPath(); ctx.moveTo(0, y * S + .5); ctx.lineTo(COLS * S, y * S + .5); ctx.stroke(); }
        for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (grid[y][x]) cell(x, y, grid[y][x]);
        if (!over) {
          let gy = cur.y; while (!collide(cur.m, cur.x, gy + 1)) gy++;
          cur.m.forEach((r, cy) => r.forEach((v, cx) => { if (v && gy + cy >= 0) cell(cur.x + cx, gy + cy, PIECES[cur.i].c, .22); }));
          cur.m.forEach((r, cy) => r.forEach((v, cx) => { if (v && cur.y + cy >= 0) cell(cur.x + cx, cur.y + cy, PIECES[cur.i].c); }));
        }
        const px = COLS * S + 14;
        text(ctx, 'SCORE', px, 36, 13, '#8b97b8'); text(ctx, String(score), px, 62, 24);
        text(ctx, 'LINES', px, 100, 13, '#8b97b8'); text(ctx, String(lines), px, 124, 20);
        text(ctx, 'LEVEL', px, 160, 13, '#8b97b8'); text(ctx, String(level), px, 184, 20);
        text(ctx, 'NEXT', px, 224, 13, '#8b97b8');
        const nm = PIECES[next].m, ns = 18;
        nm.forEach((r, cy) => r.forEach((v, cx) => {
          if (!v) return;
          ctx.fillStyle = PIECES[next].c; ctx.fillRect(px + cx * ns, 240 + cy * ns, ns - 2, ns - 2);
        }));
      },
    };
  }

  /* ============================================================
     SPACE INVADERS
     ============================================================ */
  function makeInvaders(ctx, rand) {
    const W = 360, H = 480;
    const SPR = [
      [["...##...","..####..",".######.","##.##.##","########","..#..#..",".#.##.#.","#.#..#.#"],
       ["...##...","..####..",".######.","##.##.##","########",".#.##.#.","#......#",".#....#."]],
      [["..#..#..","...##...","..####..",".##..##.","########","#.####.#","#.#..#.#","...##..."],
       ["..#..#..","#..##..#","#.####.#","###..###","########",".######.","..#..#..",".#....#."]],
      [[".######.","########","###..###","########","..#..#..",".#.##.#.","#.#..#.#",".#....#."],
       [".######.","########","###..###","########",".#.##.#.","#......#",".#....#.","#......#"]],
    ];
    const COLORS = ['#ff6bd6', '#4de1ff', '#7dff7a'];
    const POINTS = [30, 20, 20, 10, 10];
    const IW = 22, IH = 18, PX = 2.7;
    let score = 0, lives = 3, wave = 0, over = false;
    let px = W / 2, hold = { left: false, right: false }, bullet = null, cool = 0, dead = 0, invuln = 0;
    let inv, dir, stepT, frame, shots, shotT, ebullets, ufo, ufoT, shields, boom = [];

    function buildShields() {
      shields = [];
      const mask = ['011110', '111111', '111111', '110011'];
      for (let s = 0; s < 4; s++) {
        const ox = 28 + s * 84;
        mask.forEach((row, ry) => [...row].forEach((c, rx) => {
          if (c === '1') shields.push({ x: ox + rx * 7, y: H - 104 + ry * 7, w: 7, h: 7 });
        }));
      }
    }
    function buildWave() {
      inv = [];
      for (let r = 0; r < 5; r++) for (let c = 0; c < 8; c++)
        inv.push({ r, c, x: 26 + c * 38, y: 56 + Math.min(wave, 5) * 14 + r * 30, alive: true });
      dir = 1; stepT = 0; frame = 0; ebullets = []; shotT = 1; ufo = null; ufoT = 12 + rand() * 8; bullet = null;
    }
    buildShields(); buildWave();

    const alive = () => inv.filter(i => i.alive);
    const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    function hurtShield(b, radius = 1) {
      for (let i = shields.length - 1; i >= 0; i--) {
        if (hit({ x: b.x - 1, y: b.y - 3, w: 3, h: 6 }, shields[i])) {
          const s = shields[i];
          shields = shields.filter(o => !(Math.abs(o.x - s.x) <= 7 * radius && Math.abs(o.y - s.y) <= 7 * radius && (o === s || rand() < .45)));
          return true;
        }
      }
      return false;
    }
    function loseLife() {
      lives--; boom.push({ x: px, y: H - 34, t: 0.6 });
      if (lives <= 0) { over = true; return; }
      dead = 1.1; invuln = 2; ebullets = []; bullet = null;
    }

    return {
      W, H,
      get score() { return score }, get over() { return over },
      get info() { return { lives, wave: wave + 1 } },
      update(dt) {
        boom = boom.filter(b => (b.t -= dt) > 0);
        if (over) return;
        if (dead > 0) { dead -= dt; return; }
        invuln = Math.max(0, invuln - dt); cool = Math.max(0, cool - dt);
        px = clamp(px + ((hold.right ? 1 : 0) - (hold.left ? 1 : 0)) * 190 * dt, 18, W - 18);

        // my bullet
        if (bullet) {
          bullet.y -= 470 * dt;
          if (bullet.y < 0) bullet = null;
          else {
            const b = { x: bullet.x - 1.5, y: bullet.y, w: 3, h: 10 };
            const target = inv.find(i => i.alive && hit(b, { x: i.x, y: i.y, w: IW, h: IH }));
            if (target) { target.alive = false; score += POINTS[target.r]; bullet = null; boom.push({ x: target.x + IW / 2, y: target.y + IH / 2, t: .15 }); }
            else if (ufo && hit(b, { x: ufo.x, y: 28, w: 30, h: 12 })) { score += [50, 100, 150, 300][Math.floor(rand() * 4)]; boom.push({ x: ufo.x + 15, y: 34, t: .3 }); ufo = null; bullet = null; }
            else if (bullet && hurtShield(b)) bullet = null;
          }
        }
        // invader march
        const a = alive();
        if (!a.length) { wave++; score += 100; buildWave(); buildShields(); return; }
        stepT += dt;
        const interval = (0.06 + a.length / 40 * 0.62) * Math.pow(0.9, wave);
        if (stepT >= interval) {
          stepT = 0; frame ^= 1;
          const edge = a.some(i => (dir > 0 && i.x + IW + 8 > W - 8) || (dir < 0 && i.x - 8 < 8));
          if (edge) { dir = -dir; a.forEach(i => { i.y += 14; }); } else a.forEach(i => { i.x += 8 * dir; });
        }
        a.forEach(i => {
          const r = { x: i.x, y: i.y, w: IW, h: IH };
          shields = shields.filter(s => !hit(r, s));
          if (i.y + IH >= H - 52) over = true;
        });
        // invader fire
        shotT -= dt;
        if (shotT <= 0) {
          shotT = Math.max(0.35, 1.1 - wave * 0.1) * (0.6 + rand() * 0.8);
          const cols = [...new Set(a.map(i => i.c))];
          const col = cols[Math.floor(rand() * cols.length)];
          const shooter = a.filter(i => i.c === col).sort((p, q) => q.y - p.y)[0];
          ebullets.push({ x: shooter.x + IW / 2, y: shooter.y + IH });
        }
        for (const e of ebullets) {
          e.y += (160 + wave * 12) * dt;
          const b = { x: e.x - 1.5, y: e.y, w: 3, h: 10 };
          if (hurtShield(b)) e.dead = true;
          else if (!invuln && hit(b, { x: px - 13, y: H - 40, w: 26, h: 14 })) { e.dead = true; loseLife(); }
          if (e.y > H) e.dead = true;
        }
        ebullets = ebullets.filter(e => !e.dead);
        // mystery ship
        ufoT -= dt;
        if (ufoT <= 0 && !ufo) { ufo = { x: -34, v: 90 }; ufoT = 18 + rand() * 12; }
        if (ufo) { ufo.x += ufo.v * dt; if (ufo.x > W + 10) ufo = null; }
      },
      key(k, d) {
        if (k === 'left') hold.left = d;
        else if (k === 'right') hold.right = d;
        else if (k === 'a' && d && !over && dead <= 0 && !bullet && cool <= 0) { bullet = { x: px, y: H - 44 }; cool = .12; }
      },
      draw() {
        ctx.fillStyle = '#05060f'; ctx.fillRect(0, 0, W, H);
        for (let i = 0; i < 40; i++) { ctx.fillStyle = 'rgba(255,255,255,.35)'; ctx.fillRect((i * 97) % W, (i * 53) % (H - 80), 1.5, 1.5); }
        inv.forEach(i => {
          if (!i.alive) return;
          const spr = SPR[i.r === 0 ? 0 : i.r < 3 ? 1 : 2][frame];
          ctx.fillStyle = COLORS[i.r === 0 ? 0 : i.r < 3 ? 1 : 2];
          spr.forEach((row, y) => [...row].forEach((c, x) => { if (c === '#') ctx.fillRect(i.x + x * PX, i.y + y * PX, PX, PX); }));
        });
        ctx.fillStyle = '#39d353'; shields.forEach(s => ctx.fillRect(s.x, s.y, s.w - 1, s.h - 1));
        if (ufo) {
          ctx.fillStyle = '#ff3b3b'; ctx.beginPath(); ctx.ellipse(ufo.x + 15, 34, 15, 7, 0, 0, 7); ctx.fill();
          ctx.fillStyle = '#ffb3b3'; ctx.fillRect(ufo.x + 9, 28, 12, 4);
        }
        if (bullet) { ctx.fillStyle = '#fff'; ctx.fillRect(bullet.x - 1.5, bullet.y, 3, 10); }
        ctx.fillStyle = '#ff6b6b'; ebullets.forEach(e => ctx.fillRect(e.x - 1.5, e.y, 3, 10));
        if (dead <= 0 && !over && (Math.floor(invuln * 10) % 2 === 0)) {
          ctx.fillStyle = '#4de1ff'; ctx.fillRect(px - 13, H - 30, 26, 8);
          ctx.fillRect(px - 8, H - 36, 16, 6); ctx.fillRect(px - 2, H - 42, 4, 6);
        }
        boom.forEach(b => { ctx.fillStyle = 'rgba(255,200,80,.85)'; ctx.beginPath(); ctx.arc(b.x, b.y, 10 + (0.6 - b.t) * 14, 0, 7); ctx.fill(); });
        ctx.fillStyle = '#39d353'; ctx.fillRect(0, H - 16, W, 2);
        text(ctx, 'SCORE ' + score, 10, 20, 14); text(ctx, 'WAVE ' + (wave + 1), W / 2, 20, 12, '#8b97b8', 'center');
        for (let i = 0; i < lives; i++) { ctx.fillStyle = '#4de1ff'; ctx.fillRect(W - 24 - i * 22, 10, 16, 6); ctx.fillRect(W - 20 - i * 22, 6, 8, 5); }
      },
    };
  }

  /* ============================================================
     PAC-MAN
     ============================================================ */
  const MAZE = [
    '#################',
    '#o......#......o#',
    '#.##.##.#.##.##.#',
    '#...............#',
    '#.##.#.###.#.##.#',
    '#....#.....#....#',
    '####.##.#.##.####',
    '####.........####',
    '#####.##-##.#####',
    '#####.# G #.#####',
    '#####.#####.#####',
    ' ............... ',
    '#.##.#.###.#.##.#',
    '#o.#.........#.o#',
    '##.#.#.###.#.#.##',
    '#....#..#..#....#',
    '#...............#',
    '#################',
  ];

  function makePacman(ctx, rand) {
    const T = 20, COLS = 17, ROWS = MAZE.length, W = COLS * T, H = ROWS * T + 40;
    const DIRS = [[0, -1], [-1, 0], [0, 1], [1, 0]];
    const GCOL = ['#ff3b3b', '#ffb8de', '#4de1ff', '#ffb347'];
    let pel, left, score = 0, lives = 3, level = 1, over = false, t = 0, pause = 0, fright = 0, chain = 0, mouth = 0;
    let pac, want, ghosts, face = 0;

    const wall = (x, y, door) => {
      if (y < 0 || y >= ROWS) return true;
      if (x < 0 || x >= COLS) return false;             // the tunnel wraps around
      const c = MAZE[y][x]; return c === '#' || (c === '-' && !door);
    };
    function resetPellets() {
      pel = MAZE.map(r => [...r].map(c => c === '.' ? 1 : c === 'o' ? 2 : 0));
      pel[16][8] = 0; left = pel.flat().filter(Boolean).length;
    }
    function resetActors() {
      pac = { tx: 8, ty: 16, dx: 0, dy: 0, prog: 0 }; want = [0, 0];
      ghosts = [
        { id: 0, tx: 8, ty: 7, dx: 0, dy: 0, prog: 0, mode: 'chase', timer: 0 },
        { id: 1, tx: 7, ty: 9, dx: 0, dy: 0, prog: 0, mode: 'house', timer: 3 },
        { id: 2, tx: 9, ty: 9, dx: 0, dy: 0, prog: 0, mode: 'house', timer: 7 },
        { id: 3, tx: 8, ty: 9, dx: 0, dy: 0, prog: 0, mode: 'house', timer: 11 },
      ];
      fright = 0; chain = 0;
    }
    resetPellets(); resetActors();

    // distance maps (door open) so 'eyes' always find the way home and ghosts always find the exit
    const distMap = (sx, sy) => {
      const d = MAZE.map(r => [...r].map(() => 1e9)); d[sy][sx] = 0; const q = [[sx, sy]];
      for (let i = 0; i < q.length; i++) {
        const [x, y] = q[i];
        for (const [dx, dy] of DIRS) {
          const nx = (x + dx + COLS) % COLS, ny = y + dy;
          if (ny < 0 || ny >= ROWS || MAZE[ny][nx] === '#' || d[ny][nx] < 1e9) continue;
          d[ny][nx] = d[y][x] + 1; q.push([nx, ny]);
        }
      }
      return d;
    };
    const HOME = distMap(8, 9), EXIT = distMap(8, 7);

    const pos = e => ({ x: e.tx + e.dx * e.prog, y: e.ty + e.dy * e.prog });
    function advance(e, speed, dt, choose) {
      if (!e.dx && !e.dy) { choose(e); if (!e.dx && !e.dy) return; }
      e.prog += speed * dt;
      while (e.prog >= 1) {
        e.tx = (e.tx + e.dx + COLS) % COLS; e.ty += e.dy; e.prog -= 1;
        choose(e);
        if (!e.dx && !e.dy) { e.prog = 0; break; }
      }
    }
    function reverse(e) {
      if (!e.dx && !e.dy) return;
      e.tx = (e.tx + e.dx + COLS) % COLS; e.ty += e.dy; e.dx = -e.dx; e.dy = -e.dy; e.prog = 1 - e.prog;
    }
    function choosePac(e) {
      if (pel[e.ty] && pel[e.ty][e.tx]) {
        if (pel[e.ty][e.tx] === 2) { score += 50; fright = Math.max(3, 7 - level * 0.5); chain = 0; ghosts.forEach(g => { if (g.mode === 'chase') reverse(g); }); }
        else score += 10;
        pel[e.ty][e.tx] = 0; left--;
      }
      if (!wall(e.tx + want[0], e.ty + want[1], false)) { e.dx = want[0]; e.dy = want[1]; }
      else if (wall(e.tx + e.dx, e.ty + e.dy, false)) { e.dx = 0; e.dy = 0; }
    }
    function chooseGhost(g) {
      const door = g.mode === 'exit' || g.mode === 'eyes';
      let opts = DIRS.filter(([dx, dy]) => !wall(g.tx + dx, g.ty + dy, door));
      const back = opts.filter(([dx, dy]) => !(dx === -g.dx && dy === -g.dy));
      if (back.length) opts = back;
      if (!opts.length) { g.dx = 0; g.dy = 0; return; }
      let target;
      if (g.mode === 'eyes' || g.mode === 'exit') {
        const map = g.mode === 'eyes' ? HOME : EXIT;
        const best = opts.reduce((a, o) => (map[g.ty + o[1]][(g.tx + o[0] + COLS) % COLS] < map[g.ty + a[1]][(g.tx + a[0] + COLS) % COLS] ? o : a));
        g.dx = best[0]; g.dy = best[1];
        if (g.mode === 'exit' && g.ty <= 7) g.mode = 'chase';
        if (g.mode === 'eyes' && g.tx === 8 && g.ty === 9) { g.mode = 'house'; g.timer = 1.5; g.dx = g.dy = 0; }
        return;
      }
      else if (fright > 0) target = null;
      else if (g.id === 0) target = [pac.tx, pac.ty];
      else if (g.id === 1) target = [pac.tx + pac.dx * 4, pac.ty + pac.dy * 4];
      else if (g.id === 2) target = rand() < 0.5 ? [pac.tx, pac.ty] : null;
      else target = Math.abs(pac.tx - g.tx) + Math.abs(pac.ty - g.ty) > 6 ? [pac.tx, pac.ty] : [1, 16];
      let best;
      if (!target) best = opts[Math.floor(rand() * opts.length)];
      else {
        let bd = 1e9;
        for (const o of opts) {
          const d = (g.tx + o[0] - target[0]) ** 2 + (g.ty + o[1] - target[1]) ** 2;
          if (d < bd) { bd = d; best = o; }
        }
      }
      g.dx = best[0]; g.dy = best[1];
    }
    function die() {
      lives--; pause = 1.2;
      if (lives <= 0) { over = true; return; }
      resetActors();
    }

    return {
      W, H,
      get score() { return score }, get over() { return over },
      get info() { return { lives, level } },
      update(dt) {
        t += dt; mouth += dt * 9;
        if (over) return;
        if (pause > 0) { pause -= dt; return; }
        fright = Math.max(0, fright - dt);
        advance(pac, 6.4 + level * 0.15, dt, choosePac);
        for (const g of ghosts) {
          if (g.mode === 'house') {
            g.timer -= dt;
            if (g.timer <= 0) { g.mode = 'exit'; g.dx = g.dy = 0; g.prog = 0; }
            continue;
          }
          const speed = g.mode === 'eyes' ? 11 : g.mode === 'exit' ? 4.5 : fright > 0 ? 3.4 : 5.2 + level * 0.25;
          advance(g, speed, dt, chooseGhost);
        }
        const p = pos(pac);
        for (const g of ghosts) {
          if (g.mode === 'house' || g.mode === 'eyes') continue;
          const q = pos(g);
          if ((p.x - q.x) ** 2 + (p.y - q.y) ** 2 < 0.4) {
            if (fright > 0 && g.mode === 'chase') { chain++; score += 100 * 2 ** chain; g.mode = 'eyes'; }
            else { die(); break; }
          }
        }
        if (!over && left <= 0) { level++; score += 500; resetPellets(); resetActors(); pause = 1; }
      },
      key(k, d) {
        if (!d) return;
        const m = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] }[k];
        if (!m) return;
        want = m;
        if (pac.prog > 0 && (pac.dx === -m[0] && pac.dy === -m[1]) && (m[0] || m[1])) reverse(pac);
      },
      draw() {
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
          const c = MAZE[y][x];
          if (c === '#') { ctx.fillStyle = '#16239a'; ctx.fillRect(x * T, y * T, T, T); ctx.fillStyle = '#000'; ctx.fillRect(x * T + 3, y * T + 3, T - 6, T - 6); ctx.fillStyle = '#16239a'; ctx.fillRect(x * T + 6, y * T + 6, T - 12, T - 12); }
          else if (c === '-') { ctx.fillStyle = '#ffb8de'; ctx.fillRect(x * T, y * T + 8, T, 4); }
          const v = pel[y][x];
          if (v === 1) { ctx.fillStyle = '#ffd9a8'; ctx.fillRect(x * T + 8, y * T + 8, 4, 4); }
          else if (v === 2 && Math.floor(t * 4) % 2 === 0) { ctx.fillStyle = '#ffd9a8'; ctx.beginPath(); ctx.arc(x * T + 10, y * T + 10, 6, 0, 7); ctx.fill(); }
        }
        // ghosts
        for (const g of ghosts) {
          const q = pos(g), cx = q.x * T + 10, cy = q.y * T + 10;
          const scared = fright > 0 && g.mode === 'chase';
          if (g.mode !== 'eyes') {
            ctx.fillStyle = scared ? (fright < 2 && Math.floor(t * 6) % 2 ? '#fff' : '#2233ff') : GCOL[g.id];
            ctx.beginPath(); ctx.arc(cx, cy - 1, 8, Math.PI, 0); ctx.lineTo(cx + 8, cy + 8);
            for (let i = 0; i < 4; i++) ctx.lineTo(cx + 8 - (i + 0.5) * 4, cy + (i % 2 ? 8 : 5));
            ctx.lineTo(cx - 8, cy + 8); ctx.closePath(); ctx.fill();
          }
          ctx.fillStyle = '#fff'; ctx.fillRect(cx - 6, cy - 4, 4, 5); ctx.fillRect(cx + 2, cy - 4, 4, 5);
          ctx.fillStyle = scared ? '#f33' : '#1a2cff';
          ctx.fillRect(cx - 5 + g.dx * 1.5, cy - 2 + g.dy * 1.5, 2, 3); ctx.fillRect(cx + 3 + g.dx * 1.5, cy - 2 + g.dy * 1.5, 2, 3);
        }
        // pac-man
        const p = pos(pac), px = p.x * T + 10, py = p.y * T + 10;
        if (pac.dx || pac.dy) face = Math.atan2(pac.dy, pac.dx);
        const open = (pac.dx || pac.dy) ? Math.abs(Math.sin(mouth)) * 0.65 : 0.1;
        ctx.fillStyle = '#ffe000'; ctx.beginPath(); ctx.moveTo(px, py);
        ctx.arc(px, py, 8.5, face + open, face + Math.PI * 2 - open); ctx.closePath(); ctx.fill();
        // HUD
        text(ctx, 'SCORE ' + score, 10, H - 14, 16);
        text(ctx, 'LEVEL ' + level, W / 2 + 20, H - 14, 13, '#8b97b8', 'center');
        for (let i = 0; i < lives; i++) { ctx.fillStyle = '#ffe000'; ctx.beginPath(); ctx.moveTo(W - 20 - i * 22, H - 20); ctx.arc(W - 20 - i * 22, H - 20, 8, 0.6, Math.PI * 2 - 0.6); ctx.fill(); }
      },
    };
  }

  /* ============================================================
     RIVER RAID
     ============================================================ */
  function makeRiver(ctx, rand) {
    const W = 360, H = 480, RH = 8, N = H / RH + 3, PY = H - 70;
    let dist = 0, bonus = 0, lives = 3, fuel = 100, over = false;
    let px = W / 2, hold = { left: false, right: false, up: false, down: false };
    let bullets = [], objs = [], rows = [], base = 0, spawnAt = 150, dead = 0, invuln = 0, boom = [];
    const gen = { cx: W / 2, w: 230, tcx: W / 2, tw: 230, next: 25, island: 0, iw: 0 };

    function genRow() {
      if (--gen.next <= 0) {
        gen.next = 10 + Math.floor(rand() * 22);
        gen.tcx = 90 + rand() * (W - 180);
        gen.tw = 140 + rand() * 120;
        if (!gen.island && rand() < 0.4) { gen.island = 12 + Math.floor(rand() * 20); gen.iw = 24 + rand() * 20; }
      }
      if (gen.island) gen.tw = Math.max(gen.tw, 210);
      gen.cx += clamp(gen.tcx - gen.cx, -2.5, 2.5);
      gen.w += clamp(gen.tw - gen.w, -2, 2);
      const half = Math.min(gen.w / 2, W / 2 - 14);
      const cx = clamp(gen.cx, half + 14, W - half - 14);
      const row = { l: cx - half, r: cx + half, isl: null };
      if (gen.island) { gen.island--; row.isl = [cx - gen.iw / 2, cx + gen.iw / 2]; }
      return row;
    }
    for (let i = 0; i < N; i++) rows.push(i < 28 ? { l: 70, r: W - 70, isl: null } : genRow());

    const frac = () => dist - base * RH;
    const rowAtY = y => rows[clamp(Math.floor((H + frac() - y) / RH), 0, N - 1)];
    const wy2sy = wy => H - (wy - dist);
    const hit = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    const SIZE = { ship: [38, 14], heli: [30, 16], jet: [28, 10], fuel: [22, 34] };
    const PTS = { ship: 30, heli: 60, jet: 100, fuel: 80 };

    function spawn() {
      const wy = dist + H + 30;
      const row = rows[N - 1];
      const roll = rand();
      let type = roll < 0.28 ? 'fuel' : roll < 0.6 ? 'ship' : roll < 0.85 ? 'heli' : 'jet';
      if (type === 'jet' && dist < 1500) type = 'heli';
      let x;
      if (type === 'jet') { const f = rand() < 0.5; x = f ? -30 : W + 30; objs.push({ type, x, wy, v: (f ? 1 : -1) * 190 }); return; }
      const free = [[row.l + 14, row.isl ? row.isl[0] - 14 : row.r - 14]];
      if (row.isl) free.push([row.isl[1] + 14, row.r - 14]);
      const valid = free.filter(sg => sg[1] - sg[0] > 20);
      const seg = valid.length ? valid[Math.floor(rand() * valid.length)] : free[0];
      x = seg[0] + rand() * Math.max(0, seg[1] - seg[0]);
      objs.push({ type, x, wy, v: type === 'ship' ? (rand() < .5 ? 40 : -40) : (rand() < .5 ? 70 : -70) });
    }
    function crash() {
      boom.push({ x: px, y: PY, t: 0.7 });
      lives--;
      if (lives <= 0) { over = true; return; }
      dead = 1.2; invuln = 2; fuel = 100;
      objs = objs.filter(o => Math.abs(wy2sy(o.wy) - PY) > 140);
    }

    return {
      W, H,
      get score() { return bonus + Math.floor(dist / 20) }, get over() { return over },
      get info() { return { lives, fuel: Math.round(fuel) } },
      update(dt) {
        boom = boom.filter(b => (b.t -= dt) > 0);
        if (over) return;
        if (dead > 0) {
          dead -= dt;
          if (dead <= 0) { const r = rowAtY(PY); px = (r.l + r.r) / 2; if (r.isl) px = r.l + (r.isl[0] - r.l) / 2; }
          return;
        }
        invuln = Math.max(0, invuln - dt);
        const speed = hold.up ? 175 : hold.down ? 62 : 110;
        dist += speed * dt;
        while (dist - base * RH >= RH) { base++; rows.shift(); rows.push(genRow()); }
        px = clamp(px + ((hold.right ? 1 : 0) - (hold.left ? 1 : 0)) * 150 * dt, 8, W - 8);
        fuel -= (1.7 + (speed - 110) / 110 * 0.6) * dt;
        if (fuel <= 0) { fuel = 0; crash(); return; }

        spawnAt -= speed * dt;
        if (spawnAt <= 0) { spawn(); spawnAt = Math.max(70, 170 - dist / 80) + rand() * 90; }

        for (const o of objs) {
          o.x += o.v * dt;
          if (o.type === 'ship' || o.type === 'heli') {
            const r = rowAtY(wy2sy(o.wy));
            const blocked = o.x < r.l + 20 || o.x > r.r - 20 || (r.isl && o.x > r.isl[0] - 22 && o.x < r.isl[1] + 22);
            if (blocked) { o.v = -o.v; o.x += o.v * dt * 2; }
          }
        }
        objs = objs.filter(o => wy2sy(o.wy) < H + 60 && o.x > -60 && o.x < W + 60);

        bullets.forEach(b => { b.y -= 430 * dt; });
        bullets = bullets.filter(b => b.y > -10);
        for (const b of bullets) {
          const br = { x: b.x - 2, y: b.y, w: 4, h: 10 };
          for (const o of objs) {
            const [w, h] = SIZE[o.type], sy = wy2sy(o.wy);
            if (!o.dead && hit(br, { x: o.x - w / 2, y: sy - h / 2, w, h })) { o.dead = true; b.dead = true; bonus += PTS[o.type]; boom.push({ x: o.x, y: sy, t: 0.3 }); break; }
          }
        }
        objs = objs.filter(o => !o.dead); bullets = bullets.filter(b => !b.dead);

        const me = { x: px - 11, y: PY - 10, w: 22, h: 20 };
        for (const o of objs) {
          const [w, h] = SIZE[o.type], sy = wy2sy(o.wy);
          if (!hit(me, { x: o.x - w / 2, y: sy - h / 2, w, h })) continue;
          if (o.type === 'fuel') fuel = Math.min(100, fuel + 70 * dt);
          else if (!invuln) { crash(); return; }
        }
        if (!invuln) {
          for (const y of [PY - 9, PY, PY + 9]) {
            const r = rowAtY(y);
            if (px - 11 < r.l || px + 11 > r.r || (r.isl && px + 10 > r.isl[0] && px - 10 < r.isl[1])) { crash(); return; }
          }
        }
      },
      key(k, d) {
        if (k in hold) hold[k] = d;
        else if (k === 'a' && d && !over && dead <= 0 && bullets.length < 2) bullets.push({ x: px, y: PY - 14 });
      },
      draw() {
        ctx.fillStyle = '#2b8a3e'; ctx.fillRect(0, 0, W, H);
        const f = frac();
        for (let k = 0; k < N; k++) {
          const r = rows[k], y1 = H - (k + 1) * RH + f;
          ctx.fillStyle = '#1d6fd1'; ctx.fillRect(r.l, y1, r.r - r.l, RH + 0.6);
          ctx.fillStyle = '#7fd1ff'; ctx.fillRect(r.l, y1, 2, RH + .6); ctx.fillRect(r.r - 2, y1, 2, RH + .6);
          if (r.isl) { ctx.fillStyle = '#2b8a3e'; ctx.fillRect(r.isl[0], y1, r.isl[1] - r.isl[0], RH + .6); }
        }
        for (const o of objs) {
          const sy = wy2sy(o.wy), [w, h] = SIZE[o.type];
          if (o.type === 'ship') { ctx.fillStyle = '#555'; ctx.fillRect(o.x - w / 2, sy - 2, w, 8); ctx.fillStyle = '#b33'; ctx.fillRect(o.x - 8, sy - 8, 16, 8); }
          else if (o.type === 'heli') { ctx.fillStyle = '#9b3dff'; ctx.fillRect(o.x - 9, sy - 4, 18, 10); ctx.fillRect(o.x - 15, sy - 1, 8, 3); ctx.fillStyle = '#ddd'; ctx.fillRect(o.x - 14, sy - 8, 28, 2); }
          else if (o.type === 'jet') { ctx.fillStyle = '#ff7a1a'; ctx.beginPath(); ctx.moveTo(o.x + (o.v > 0 ? 14 : -14), sy); ctx.lineTo(o.x - (o.v > 0 ? 14 : -14), sy - 6); ctx.lineTo(o.x - (o.v > 0 ? 14 : -14), sy + 6); ctx.fill(); }
          else { ctx.fillStyle = '#ff3b3b'; ctx.fillRect(o.x - 11, sy - 17, 22, 34); ctx.fillStyle = '#fff'; for (let i = 0; i < 3; i++) ctx.fillRect(o.x - 11, sy - 12 + i * 11, 22, 5); text(ctx, 'F', o.x, sy + 4, 11, '#222', 'center'); }
        }
        ctx.fillStyle = '#fff'; bullets.forEach(b => ctx.fillRect(b.x - 2, b.y, 4, 10));
        if (dead <= 0 && !over && (Math.floor(invuln * 10) % 2 === 0)) {
          ctx.fillStyle = '#ffe24a'; ctx.beginPath(); ctx.moveTo(px, PY - 14); ctx.lineTo(px + 12, PY + 10); ctx.lineTo(px, PY + 5); ctx.lineTo(px - 12, PY + 10); ctx.closePath(); ctx.fill();
          ctx.fillStyle = '#c33'; ctx.fillRect(px - 2, PY - 6, 4, 8);
        }
        boom.forEach(b => { ctx.fillStyle = 'rgba(255,170,40,.9)'; ctx.beginPath(); ctx.arc(b.x, b.y, 8 + (0.7 - b.t) * 30, 0, 7); ctx.fill(); });
        ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, H - 30, W, 30);
        text(ctx, 'FUEL', 10, H - 11, 12, '#fff');
        ctx.fillStyle = '#333'; ctx.fillRect(52, H - 22, 120, 12);
        ctx.fillStyle = fuel > 25 ? '#3ddc6b' : '#ff4d4d'; ctx.fillRect(52, H - 22, 120 * fuel / 100, 12);
        text(ctx, '♥'.repeat(Math.max(0, lives)), W - 10, H - 9, 16, '#ff6b81', 'right');
        text(ctx, String(bonus + Math.floor(dist / 20)), W / 2 + 40, H - 9, 16);
      },
    };
  }

  /* ============================================================
     registry + runner
     ============================================================ */
  const META = {
    tetris:    { title: 'Tetris', emoji: '🧱', make: makeTetris, W: 360, H: 480,
                 hint: '← → move · ↑ rotate · ↓ soft drop · Space hard drop',
                 pad: { up: '⟳', down: '▼', left: '◀', right: '▶', a: 'DROP' } },
    pacman:    { title: 'Pac-Man', emoji: '🟡', make: makePacman, W: 340, H: 400,
                 hint: 'Arrow keys to steer · eat every dot, grab the big ones to chase ghosts',
                 pad: { up: '▲', down: '▼', left: '◀', right: '▶' } },
    riverraid: { title: 'River Raid', emoji: '✈️', make: makeRiver, W: 360, H: 480,
                 hint: '← → steer · ↑ faster · ↓ slower · Space fire · fly over F for fuel',
                 pad: { up: '▲', down: '▼', left: '◀', right: '▶', a: '🔫' } },
    invaders:  { title: 'Space Invaders', emoji: '👾', make: makeInvaders, W: 360, H: 480,
                 hint: '← → move · Space fire',
                 pad: { left: '◀', right: '▶', a: '🔫' } },
  };

  function create(id, canvas, seed, hooks = {}) {
    const meta = META[id];
    canvas.width = meta.W; canvas.height = meta.H;
    const ctx = canvas.getContext('2d');
    const g = meta.make(ctx, rngFrom(seed));
    let raf = 0, last = 0, running = false, lastScore = -1, overSent = false;
    const tick = () => {
      if (g.score !== lastScore) { lastScore = g.score; hooks.score && hooks.score(g.score); }
      if (g.over && !overSent) { overSent = true; hooks.over && hooks.over(g.score); }
    };
    const frame = now => {
      if (!running) return;
      const dt = Math.min(0.05, (now - last) / 1000 || 0.016); last = now;
      g.update(dt); g.draw(); tick();
      raf = requestAnimationFrame(frame);
    };
    g.draw();
    return {
      game: g, meta,
      start() { running = true; last = performance.now(); raf = requestAnimationFrame(frame); },
      stop() { running = false; cancelAnimationFrame(raf); },
      step(dt) { g.update(dt); g.draw(); tick(); },      // used by tests
      key: (k, d) => g.key(k, d),
    };
  }

  window.PingGames = { META, create, rngFrom };
})();
