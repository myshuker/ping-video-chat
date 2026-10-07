/* ============================================================
   Ping camera filters (Snapchat-style)

   The camera goes into a hidden <video>, each frame is drawn onto a
   canvas with the filter applied, and the canvas becomes the video
   track that is sent to everyone in the call (and shown in your own
   picture). So everybody sees the filtered picture.

   - Simple filters: colours, blur, pixels, beauty. Instant, no download.
   - Face effects: ears, nose, shades, crown... they follow your face using
     MediaPipe Face Landmarker, downloaded only the first time you pick one.
   ============================================================ */
(function () {
  "use strict";

  // rounded rectangles (older browsers don't have this)
  if (
    typeof CanvasRenderingContext2D !== "undefined" &&
    !CanvasRenderingContext2D.prototype.roundRect
  ) {
    CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
      r = Math.min(r || 0, w / 2, h / 2);
      this.moveTo(x + r, y);
      this.arcTo(x + w, y, x + w, y + h, r);
      this.arcTo(x + w, y + h, x, y + h, r);
      this.arcTo(x, y + h, x, y, r);
      this.arcTo(x, y, x + w, y, r);
      this.closePath();
    };
  }

  /* ---------------- filter catalogue ---------------- */
  // Colour matrices (3 rows x [r g b offset]) that reproduce the CSS filters below, for browsers without ctx.filter (Safari).
  const I3 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const mix = (A, B, t) => A.map((v, k) => v * (1 - t) + B[k] * t);
  const then = (A, B) => {
    // apply A first, then B
    const out = [];
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++)
        out.push(
          B[r * 4] * A[c] + B[r * 4 + 1] * A[4 + c] + B[r * 4 + 2] * A[8 + c],
        );
      out.push(
        B[r * 4] * A[3] +
          B[r * 4 + 1] * A[7] +
          B[r * 4 + 2] * A[11] +
          B[r * 4 + 3],
      );
    }
    return [
      out[0],
      out[1],
      out[2],
      out[3],
      out[4],
      out[5],
      out[6],
      out[7],
      out[8],
      out[9],
      out[10],
      out[11],
    ];
  };
  const chain = (...ms) => ms.reduce((a, b) => then(a, b));
  const M = {
    gray: [
      0.2126, 0.7152, 0.0722, 0, 0.2126, 0.7152, 0.0722, 0, 0.2126, 0.7152,
      0.0722, 0,
    ],
    sat: (s) =>
      mix(
        [
          0.2126, 0.7152, 0.0722, 0, 0.2126, 0.7152, 0.0722, 0, 0.2126, 0.7152,
          0.0722, 0,
        ],
        I3,
        s,
      ),
    sepia: (a) =>
      mix(
        I3,
        [
          0.393, 0.769, 0.189, 0, 0.349, 0.686, 0.168, 0, 0.272, 0.534, 0.131,
          0,
        ],
        a,
      ),
    bright: (b) => [b, 0, 0, 0, 0, b, 0, 0, 0, 0, b, 0],
    contrast: (c) => [
      c,
      0,
      0,
      128 * (1 - c),
      0,
      c,
      0,
      128 * (1 - c),
      0,
      0,
      c,
      128 * (1 - c),
    ],
    invert: [-1, 0, 0, 255, 0, -1, 0, 255, 0, 0, -1, 255],
  };

  // css = fast GPU filter. m = the same look as a colour matrix (fallback). tint = colour laid over the picture.
  const SIMPLE = [
    { id: "none", name: "None", icon: "⭕" },
    {
      id: "bw",
      name: "B&W",
      icon: "⚫",
      css: "grayscale(1) contrast(1.1)",
      m: chain(M.gray, M.contrast(1.1)),
    },
    {
      id: "warm",
      name: "Warm",
      icon: "🔥",
      css: "saturate(1.15) brightness(1.04)",
      m: chain(M.sat(1.15), M.bright(1.04)),
      tint: "rgba(255,140,40,0.24)",
    },
    {
      id: "cool",
      name: "Cool",
      icon: "🧊",
      css: "saturate(1.1) brightness(1.02)",
      m: chain(M.sat(1.1), M.bright(1.02)),
      tint: "rgba(60,120,255,0.26)",
    },
    {
      id: "vintage",
      name: "Vintage",
      icon: "📻",
      css: "sepia(0.7) contrast(1.05) saturate(1.2)",
      m: chain(M.sepia(0.7), M.contrast(1.05), M.sat(1.2)),
    },
    {
      id: "vivid",
      name: "Vivid",
      icon: "🌈",
      css: "saturate(1.8) contrast(1.08)",
      m: chain(M.sat(1.8), M.contrast(1.08)),
    },
    {
      id: "bright",
      name: "Bright",
      icon: "☀️",
      css: "brightness(1.35) contrast(0.95)",
      m: chain(M.bright(1.35), M.contrast(0.95)),
    },
    {
      id: "dark",
      name: "Dark",
      icon: "🌙",
      css: "brightness(0.65) contrast(1.1)",
      m: chain(M.bright(0.65), M.contrast(1.1)),
    },
    { id: "invert", name: "Invert", icon: "🔄", css: "invert(1)", m: M.invert },
    { id: "beauty", name: "Beauty", icon: "✨", special: "beauty" },
    { id: "blur", name: "Blur", icon: "👻", special: "blur" },
    { id: "pixels", name: "Pixels", icon: "🟦", special: "pixels" },
  ];
  const FANCY = [
    { id: "dog", name: "Puppy", icon: "🐶", face: true },
    { id: "cat", name: "Kitty", icon: "🐱", face: true },
    { id: "bunny", name: "Bunny", icon: "🐰", face: true },
    { id: "clown", name: "Clown", icon: "🤡", face: true },
    { id: "shades", name: "Shades", icon: "😎", face: true },
    { id: "crown", name: "Crown", icon: "👑", face: true },
    { id: "devil", name: "Devil", icon: "😈", face: true },
    { id: "halo", name: "Halo", icon: "😇", face: true },
    { id: "hearts", name: "Love", icon: "😍", face: true },
    { id: "party", name: "Party", icon: "🥳", face: true },
    { id: "pirate", name: "Pirate", icon: "🏴\u200d☠️", face: true },
    { id: "santa", name: "Santa", icon: "🎅", face: true },
    { id: "alien", name: "Alien", icon: "👽", face: true },
    { id: "flower", name: "Flowers", icon: "🌸", face: true },
    { id: "viking", name: "Viking", icon: "⚔️", face: true },
    { id: "spy", name: "Disguise", icon: "🥸", face: true },
    { id: "bear", name: "Bear", icon: "🐻", face: true },
    { id: "fox", name: "Fox", icon: "🦊", face: true },
    { id: "tiger", name: "Tiger", icon: "🐯", face: true },
    { id: "pig", name: "Piggy", icon: "🐷", face: true },
    { id: "unicorn", name: "Unicorn", icon: "🦄", face: true },
    { id: "robot", name: "Robot", icon: "🤖", face: true },
    { id: "skull", name: "Skull", icon: "💀", face: true },
    { id: "wolf", name: "Werewolf", icon: "🐺", face: true },
    { id: "hero", name: "Hero", icon: "🦸", face: true },
    { id: "cowboy", name: "Cowboy", icon: "🤠", face: true },
    { id: "chef", name: "Chef", icon: "👨‍🍳", face: true },
    { id: "beanie", name: "Winter Hat", icon: "🧣", face: true },
    { id: "heartshades", name: "Heart Shades", icon: "💗", face: true },
    { id: "pixelshades", name: "Pixel Shades", icon: "🕶️", face: true },
    { id: "crying", name: "Crying", icon: "😭", face: true },
    { id: "sleepy", name: "Sleepy", icon: "😴", face: true },
    { id: "kisses", name: "Kisses", icon: "💋", face: true },
    { id: "afro", name: "Rainbow Afro", icon: "💈", face: true },
  ];
  const ALL = [...SIMPLE, ...FANCY];
  const get = (id) => ALL.find((f) => f.id === id);

  const canCss = () =>
    !PF._forceMatrix &&
    typeof CanvasRenderingContext2D !== "undefined" &&
    "filter" in CanvasRenderingContext2D.prototype;

  /* ---------------- face tracking (MediaPipe, loaded on demand) ---------------- */
  const MP = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14";
  const MP_MODEL =
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
  let trackerPromise = null;

  function withTimeout(promise, ms, msg) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms)),
    ]);
  }

  async function loadMediaPipeTracker() {
    const { FaceLandmarker, FilesetResolver } = await import(
      `${MP}/vision_bundle.mjs`
    );
    const fileset = await FilesetResolver.forVisionTasks(`${MP}/wasm`);
    let lm;
    for (const delegate of ["GPU", "CPU"]) {
      // fast path first, fall back if the phone refuses
      try {
        lm = await FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MP_MODEL, delegate },
          runningMode: "VIDEO",
          numFaces: 1,
        });
        break;
      } catch (err) {
        if (delegate === "CPU") throw err;
      }
    }
    return {
      detect: (video, ts) =>
        lm.detectForVideo(video, ts).faceLandmarks?.[0] || null,
    };
  }

  // PF.trackerFactory can be replaced (used by the tests)
  function getTracker() {
    if (!trackerPromise) {
      trackerPromise = withTimeout(
        (PF.trackerFactory || loadMediaPipeTracker)(),
        45000,
        "Face tracking took too long to load",
      ).catch((err) => {
        trackerPromise = null;
        throw err;
      });
    }
    return trackerPromise;
  }

  /* ---------------- the engine ---------------- */
  class Engine {
    constructor() {
      this.canvas = document.createElement("canvas");
      this.canvas.width = 640;
      this.canvas.height = 480;
      this.ctx = this.canvas.getContext("2d");
      this.tiny = document.createElement("canvas");
      this.tctx = this.tiny.getContext("2d");
      this.video = document.createElement("video");
      this.video.muted = true;
      this.video.playsInline = true;
      this.video.autoplay = true;
      // kept in the page (invisible) because some phones won't decode a detached video
      this.video.style.cssText =
        "position:fixed;left:0;top:0;width:2px;height:2px;opacity:0;pointer-events:none;";
      document.body.appendChild(this.video);
      this.stream = this.canvas.captureStream(30);
      this.track = this.stream.getVideoTracks()[0];
      this.def = null;
      this.timer = null;
      this.running = false;
      this.tracker = null;
      this.frame = 0;
      this.pts = null;
      this.lost = 0;
    }

    setSource(track) {
      // the real camera track
      if (this.src === track) return;
      this.src = track;
      this.video.srcObject = new MediaStream([track]);
      this.video.play().catch(() => {});
    }
    async loadFaceTracking() {
      this.tracker = await getTracker();
      return true;
    }
    setFilter(id) {
      this.def = get(id) || null;
      this.pts = null;
      this.lost = 0;
    }

    start() {
      if (this.running) return;
      this.running = true;
      const tick = () => {
        if (!this.running) return;
        const t0 = performance.now();
        try {
          this.draw();
        } catch (e) {
          console.warn("filter frame failed", e);
        }
        this.timer = setTimeout(
          tick,
          Math.max(0, 33 - (performance.now() - t0)),
        );
      };
      tick();
    }
    stop() {
      this.running = false;
      clearTimeout(this.timer);
    }
    destroy() {
      this.stop();
      this.track.stop();
      this.video.srcObject = null;
      this.video.remove();
    }

    draw() {
      const v = this.video,
        c = this.canvas,
        ctx = this.ctx;
      if (v.readyState < 2 || !v.videoWidth) return;
      if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
        c.width = v.videoWidth;
        c.height = v.videoHeight;
      }
      const W = c.width,
        H = c.height,
        def = this.def;
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      ctx.filter = "none";
      if (!def || def.id === "none") {
        ctx.drawImage(v, 0, 0, W, H);
        return;
      }
      if (def.face) {
        ctx.drawImage(v, 0, 0, W, H);
        this.drawFace(W, H);
        return;
      }
      this.drawSimple(def, W, H);
    }

    /* ----- colour filters ----- */
    soften(W, H, divisor, alpha) {
      // low-res copy scaled back up = cheap blur (works everywhere)
      const t = this.tiny,
        tw = Math.max(1, Math.round(W / divisor)),
        th = Math.max(1, Math.round(H / divisor));
      t.width = tw;
      t.height = th;
      this.tctx.drawImage(this.video, 0, 0, tw, th);
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.globalAlpha = alpha;
      this.ctx.drawImage(t, 0, 0, tw, th, 0, 0, W, H);
      this.ctx.globalAlpha = 1;
    }

    drawSimple(def, W, H) {
      const ctx = this.ctx,
        v = this.video;
      if (def.special === "pixels") {
        const s = Math.max(4, Math.round(W / 56));
        const tw = Math.ceil(W / s),
          th = Math.ceil(H / s);
        this.tiny.width = tw;
        this.tiny.height = th;
        this.tctx.drawImage(v, 0, 0, tw, th);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.tiny, 0, 0, tw, th, 0, 0, W, H);
        ctx.imageSmoothingEnabled = true;
        return;
      }
      if (def.special === "blur") {
        if (canCss()) {
          ctx.filter = `blur(${Math.round(W / 90)}px)`;
          ctx.drawImage(v, 0, 0, W, H);
          ctx.filter = "none";
        } else this.soften(W, H, 10, 1);
        return;
      }
      if (def.special === "beauty") {
        // soft, slightly brighter skin
        ctx.drawImage(v, 0, 0, W, H);
        if (canCss()) {
          ctx.globalAlpha = 0.55;
          ctx.filter = `blur(${Math.max(2, Math.round(W / 160))}px) brightness(1.07) saturate(1.08)`;
          ctx.drawImage(v, 0, 0, W, H);
          ctx.filter = "none";
          ctx.globalAlpha = 1;
        } else this.soften(W, H, 4, 0.55);
        return;
      }
      if (canCss() && def.css) {
        ctx.filter = def.css;
        ctx.drawImage(v, 0, 0, W, H);
        ctx.filter = "none";
      } else {
        ctx.drawImage(v, 0, 0, W, H);
        if (def.m) matrixPass(ctx, W, H, def.m);
      }
      if (def.tint) {
        ctx.globalCompositeOperation = "overlay";
        ctx.fillStyle = def.tint;
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = "source-over";
      }
    }

    /* ----- face effects ----- */
    drawFace(W, H) {
      if (!this.tracker) return;
      if (this.frame++ % 2 === 0) {
        // look for the face every 2nd frame, draw every frame
        const lm = this.tracker.detect(this.video, performance.now());
        if (lm) {
          this.lost = 0;
          this.pts = this.follow(lm, W, H);
        } else if (++this.lost > 8) this.pts = null; // face gone for a moment: keep the effect, then drop it
      }
      if (!this.pts) return;
      const g = geometry(this.pts);
      const ctx = this.ctx;
      ctx.save();
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      EFFECTS[this.def.id]?.(ctx, g);
      ctx.restore();
    }

    follow(lm, W, H) {
      // read the points we need and smooth the shaking
      const out = {};
      for (const i of USED) {
        const p = lm[i];
        if (!p) continue;
        const x = p.x * W,
          y = p.y * H,
          old = this.pts?.[i];
        out[i] = old
          ? { x: old.x + (x - old.x) * 0.6, y: old.y + (y - old.y) * 0.6 }
          : { x, y };
      }
      return out;
    }
  }

  function matrixPass(ctx, W, H, m) {
    const img = ctx.getImageData(0, 0, W, H),
      d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i],
        g = d[i + 1],
        b = d[i + 2];
      d[i] = m[0] * r + m[1] * g + m[2] * b + m[3];
      d[i + 1] = m[4] * r + m[5] * g + m[6] * b + m[7];
      d[i + 2] = m[8] * r + m[9] * g + m[10] * b + m[11];
    }
    ctx.putImageData(img, 0, 0);
  }

  /* ---------------- face geometry ---------------- */
  // MediaPipe landmark numbers: 1 nose tip, 10 forehead, 152 chin, 33/263 outer eye corners,
  // 13/14 inner lips, 61/291 mouth corners, 234/454 sides of the face, 205/425 cheeks
  const USED = [1, 10, 13, 14, 33, 61, 152, 205, 234, 263, 291, 425, 454];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function geometry(P) {
    const u = dist(P[234], P[454]); // face width = the scale for everything
    return {
      u,
      roll: Math.atan2(P[263].y - P[33].y, P[263].x - P[33].x),
      top: P[10],
      chin: P[152],
      nose: P[1],
      eyes: { x: (P[33].x + P[263].x) / 2, y: (P[33].y + P[263].y) / 2 },
      cheekL: P[205],
      cheekR: P[425],
      mouthOpen: Math.max(
        0,
        dist(P[13], P[14]) / Math.max(1, dist(P[10], P[152])),
      ),
      mouth: { x: (P[13].x + P[14].x) / 2, y: (P[13].y + P[14].y) / 2 },
    };
  }

  // draw something in the head's own coordinates: origin at (x, y), x along the face, y towards the chin
  function atHead(ctx, g, x, y, fn) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(g.roll);
    fn(g.u);
    ctx.restore();
  }
  const ellipse = (ctx, x, y, rx, ry, rot, fill) => {
    ctx.beginPath();
    ctx.ellipse(x, y, Math.max(1, rx), Math.max(1, ry), rot, 0, Math.PI * 2);
    ctx.fillStyle = fill;
    ctx.fill();
  };
  const noseDot = (ctx, g, color, r) =>
    atHead(ctx, g, g.nose.x, g.nose.y, (u) => {
      ellipse(ctx, 0, 0, u * r, u * r * 0.82, 0, color);
      ellipse(
        ctx,
        -u * r * 0.3,
        -u * r * 0.3,
        u * r * 0.28,
        u * r * 0.2,
        0,
        "rgba(255,255,255,.55)",
      );
    });
  const blush = (ctx, g, a) => {
    for (const c of [g.cheekL, g.cheekR])
      atHead(ctx, g, c.x, c.y, (u) =>
        ellipse(ctx, 0, 0, u * 0.1, u * 0.07, 0, `rgba(255,90,120,${a})`),
      );
  };
  const heart = (ctx, x, y, s, color) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.fillStyle = color;
    const r = s * 0.32;
    ctx.beginPath();
    ctx.arc(-r * 0.62, -r * 0.42, r * 0.62, 0, Math.PI * 2);
    ctx.arc(r * 0.62, -r * 0.42, r * 0.62, 0, Math.PI * 2);
    ctx.moveTo(-r * 1.18, -r * 0.12);
    ctx.lineTo(0, r * 1.15);
    ctx.lineTo(r * 1.18, -r * 0.12);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  // skin colour sampled from the frame (for lids that must match the face)
  let sleepSkin = null,
    sleepSkinAt = 0;

  const EFFECTS = {
    dog(ctx, g) {
      for (const s of [-1, 1])
        atHead(ctx, g, g.top.x + s * g.u * 0.34, g.top.y + g.u * 0.02, (u) => {
          ctx.rotate(s * 0.5);
          ellipse(ctx, 0, u * 0.17, u * 0.13, u * 0.27, 0, "#7a4a25");
          ellipse(ctx, 0, u * 0.2, u * 0.07, u * 0.19, 0, "#b9824f");
        });
      noseDot(ctx, g, "#1a1412", 0.075);
      if (g.mouthOpen > 0.04)
        atHead(ctx, g, g.mouth.x, g.mouth.y, (u) => {
          // tongue only when the mouth opens
          const len = u * Math.min(0.42, 0.14 + g.mouthOpen * 3.2);
          ctx.fillStyle = "#ff6f91";
          ctx.beginPath();
          ctx.roundRect(-u * 0.085, 0, u * 0.17, len, u * 0.085);
          ctx.fill();
          ctx.strokeStyle = "rgba(160,30,60,.55)";
          ctx.lineWidth = Math.max(1, u * 0.012);
          ctx.beginPath();
          ctx.moveTo(0, u * 0.02);
          ctx.lineTo(0, len * 0.7);
          ctx.stroke();
        });
      blush(ctx, g, 0.25);
    },
    cat(ctx, g) {
      for (const s of [-1, 1])
        atHead(ctx, g, g.top.x + s * g.u * 0.32, g.top.y + g.u * 0.06, (u) => {
          ctx.rotate(s * 0.28);
          ctx.fillStyle = "#2b2b33";
          ctx.beginPath();
          ctx.moveTo(-u * 0.15, 0);
          ctx.lineTo(0, -u * 0.34);
          ctx.lineTo(u * 0.15, 0);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "#ff9fbd";
          ctx.beginPath();
          ctx.moveTo(-u * 0.08, -u * 0.02);
          ctx.lineTo(0, -u * 0.22);
          ctx.lineTo(u * 0.08, -u * 0.02);
          ctx.closePath();
          ctx.fill();
        });
      noseDot(ctx, g, "#ff7fa6", 0.045);
      ctx.strokeStyle = "rgba(255,255,255,.92)";
      ctx.lineWidth = Math.max(1.5, g.u * 0.012);
      for (const [c, s] of [
        [g.cheekL, -1],
        [g.cheekR, 1],
      ])
        atHead(ctx, g, c.x, c.y, (u) => {
          // whiskers
          for (const a of [-0.22, 0, 0.22]) {
            ctx.beginPath();
            ctx.moveTo(s * u * 0.05, 0);
            ctx.lineTo(s * u * 0.34, u * a * 0.55 + u * 0.02);
            ctx.stroke();
          }
        });
    },
    bunny(ctx, g) {
      for (const s of [-1, 1])
        atHead(ctx, g, g.top.x + s * g.u * 0.2, g.top.y + g.u * 0.04, (u) => {
          ctx.rotate(s * 0.14);
          ellipse(ctx, 0, -u * 0.42, u * 0.11, u * 0.46, 0, "#f4f1f6");
          ellipse(ctx, 0, -u * 0.42, u * 0.055, u * 0.36, 0, "#ffb3c8");
        });
      noseDot(ctx, g, "#ff8fb0", 0.05);
      blush(ctx, g, 0.3);
    },
    clown(ctx, g) {
      noseDot(ctx, g, "#ee1c25", 0.1);
      blush(ctx, g, 0.55);
      for (const s of [-1, 1])
        atHead(ctx, g, g.top.x + s * g.u * 0.4, g.top.y + g.u * 0.16, (u) => {
          // curly hair puffs
          for (const [x, y, r, col] of [
            [0, 0, 0.17, "#ff4d6d"],
            [s * 0.1, -0.12, 0.13, "#ffb703"],
            [s * 0.02, 0.2, 0.12, "#3a86ff"],
          ])
            ellipse(ctx, x * u, y * u, r * u, r * u, 0, col);
        });
    },
    shades(ctx, g) {
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        const lw = u * 0.4,
          lh = u * 0.25,
          gap = u * 0.24;
        ctx.fillStyle = "rgba(8,8,14,.93)";
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.roundRect(s * gap - lw / 2, -lh / 2, lw, lh, u * 0.07);
          ctx.fill();
        }
        ctx.strokeStyle = "#0b0b10";
        ctx.lineWidth = u * 0.03;
        ctx.beginPath();
        ctx.moveTo(-gap + lw / 2, -lh * 0.15);
        ctx.lineTo(gap - lw / 2, -lh * 0.15);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(-gap - lw / 2, -lh * 0.1);
        ctx.lineTo(-u * 0.52, -lh * 0.2);
        ctx.moveTo(gap + lw / 2, -lh * 0.1);
        ctx.lineTo(u * 0.52, -lh * 0.2);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,255,255,.28)";
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.roundRect(
            s * gap - lw * 0.38,
            -lh * 0.38,
            lw * 0.28,
            lh * 0.18,
            u * 0.02,
          );
          ctx.fill();
        }
      });
    },
    crown(ctx, g) {
      atHead(ctx, g, g.top.x, g.top.y, (u) => {
        const w = u * 0.62,
          h = u * 0.36;
        ctx.translate(0, -u * 0.06);
        ctx.fillStyle = "#ffc928";
        ctx.strokeStyle = "#b8860b";
        ctx.lineWidth = Math.max(1.5, u * 0.018);
        ctx.beginPath();
        ctx.moveTo(-w / 2, 0);
        ctx.lineTo(-w / 2, -h * 0.7);
        ctx.lineTo(-w / 4, -h * 0.35);
        ctx.lineTo(0, -h);
        ctx.lineTo(w / 4, -h * 0.35);
        ctx.lineTo(w / 2, -h * 0.7);
        ctx.lineTo(w / 2, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        for (const [x, col] of [
          [-w / 2, "#ff4d6d"],
          [0, "#3a86ff"],
          [w / 2, "#2ecc71"],
        ])
          ellipse(ctx, x, x === 0 ? -h : -h * 0.7, u * 0.04, u * 0.04, 0, col);
        ellipse(ctx, 0, -h * 0.28, u * 0.05, u * 0.05, 0, "#ff4d6d");
      });
    },

    devil(ctx, g) {
      for (const s of [-1, 1])
        atHead(ctx, g, g.top.x + s * g.u * 0.3, g.top.y + g.u * 0.05, (u) => {
          ctx.rotate(s * 0.35);
          ctx.fillStyle = "#d21f3c";
          ctx.beginPath();
          ctx.moveTo(-u * 0.09, 0);
          ctx.quadraticCurveTo(-u * 0.13, -u * 0.28, 0, -u * 0.44);
          ctx.quadraticCurveTo(u * 0.13, -u * 0.28, u * 0.09, 0);
          ctx.closePath();
          ctx.fill();
        });
      ctx.strokeStyle = "#5a1010";
      ctx.lineWidth = Math.max(2, g.u * 0.035);
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * u * 0.11, -u * 0.19);
          ctx.lineTo(s * u * 0.35, -u * 0.12);
          ctx.stroke();
        }
      });
    },
    halo(ctx, g) {
      atHead(ctx, g, g.top.x, g.top.y - g.u * 0.3, (u) => {
        ctx.strokeStyle = "rgba(255,214,79,.95)";
        ctx.lineWidth = Math.max(2, u * 0.045);
        ctx.beginPath();
        ctx.ellipse(0, 0, u * 0.27, u * 0.095, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = "rgba(255,255,255,.6)";
        ctx.lineWidth = Math.max(1, u * 0.014);
        ctx.beginPath();
        ctx.ellipse(0, 0, u * 0.21, u * 0.065, 0, Math.PI, Math.PI * 1.8);
        ctx.stroke();
      });
    },
    hearts(ctx, g) {
      for (const s of [-1, 1]) {
        ctx.save();
        ctx.translate(g.eyes.x + s * g.u * 0.24, g.eyes.y);
        ctx.rotate(g.roll + s * 0.12);
        heart(ctx, 0, 0, g.u * 0.3, "#ff4d6d");
        ctx.restore();
      }
      blush(ctx, g, 0.3);
    },
    party(ctx, g) {
      atHead(ctx, g, g.top.x, g.top.y, (u) => {
        const w = u * 0.34,
          h = u * 0.6;
        ctx.translate(0, -u * 0.03);
        ctx.fillStyle = "#3a86ff";
        ctx.beginPath();
        ctx.moveTo(-w, 0);
        ctx.lineTo(0, -h);
        ctx.lineTo(w, 0);
        ctx.closePath();
        ctx.fill();
        ctx.save();
        ctx.clip();
        ctx.fillStyle = "#ff4d6d";
        ctx.fillRect(-w, -h * 0.66, w * 2, h * 0.22);
        ctx.fillStyle = "#ffb703";
        ctx.fillRect(-w, -h * 0.38, w * 2, h * 0.16);
        ctx.restore();
        ellipse(ctx, 0, -h, u * 0.09, u * 0.09, 0, "#ffffff");
      });
      const cols = ["#ff4d6d", "#ffb703", "#3a86ff", "#2ecc71"];
      let seed = 7;
      const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
      for (let i = 0; i < 10; i++) {
        const a = rnd() * Math.PI * 2,
          r = g.u * (0.66 + rnd() * 0.3);
        ctx.save();
        ctx.translate(
          g.top.x + Math.cos(a) * r,
          g.top.y + Math.sin(a) * r * 0.85 - g.u * 0.15,
        );
        ctx.rotate(rnd() * Math.PI);
        ctx.fillStyle = cols[i % 4];
        ctx.fillRect(-g.u * 0.032, -g.u * 0.014, g.u * 0.064, g.u * 0.028);
        ctx.restore();
      }
    },
    pirate(ctx, g) {
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        ctx.strokeStyle = "#17110b";
        ctx.lineWidth = Math.max(2, u * 0.034);
        ctx.beginPath();
        ctx.moveTo(-u * 0.52, -u * 0.18);
        ctx.quadraticCurveTo(0, -u * 0.3, u * 0.52, -u * 0.2);
        ctx.stroke();
        ellipse(ctx, -u * 0.24, -u * 0.02, u * 0.19, u * 0.21, 0, "#17110b");
        ctx.strokeStyle = "rgba(255,255,255,.16)";
        ctx.lineWidth = u * 0.013;
        ctx.beginPath();
        ctx.ellipse(
          -u * 0.27,
          -u * 0.08,
          u * 0.1,
          u * 0.05,
          -0.5,
          Math.PI,
          Math.PI * 1.9,
        );
        ctx.stroke();
      });
    },
    santa(ctx, g) {
      atHead(ctx, g, g.top.x, g.top.y, (u) => {
        ctx.translate(0, -u * 0.03);
        ctx.rotate(-0.2);
        ctx.fillStyle = "#d90429";
        ctx.beginPath();
        ctx.moveTo(-u * 0.38, 0);
        ctx.quadraticCurveTo(-u * 0.12, -u * 0.72, u * 0.3, -u * 0.5);
        ctx.quadraticCurveTo(u * 0.5, -u * 0.4, u * 0.42, -u * 0.18);
        ctx.quadraticCurveTo(u * 0.12, -u * 0.28, -u * 0.36, u * 0.05);
        ctx.closePath();
        ctx.fill();
        ellipse(ctx, -u * 0.02, 0, u * 0.42, u * 0.1, 0, "#ffffff");
        ellipse(ctx, u * 0.42, -u * 0.16, u * 0.1, u * 0.1, 0, "#ffffff");
      });
    },
    alien(ctx, g) {
      ctx.save();
      ctx.globalAlpha = 0.28;
      ellipse(
        ctx,
        g.nose.x,
        (g.top.y + g.chin.y) / 2,
        g.u * 0.6,
        g.u * 0.8,
        g.roll,
        "#39ff88",
      );
      ctx.restore();
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        for (const s of [-1, 1]) {
          ctx.save();
          ctx.translate(s * u * 0.24, -u * 0.02);
          ctx.rotate(s * 0.32);
          ellipse(ctx, 0, 0, u * 0.15, u * 0.23, 0, "#090f09");
          ellipse(
            ctx,
            -u * 0.03,
            -u * 0.08,
            u * 0.045,
            u * 0.026,
            0,
            "rgba(150,255,190,.75)",
          );
          ctx.restore();
        }
      });
    },
    flower(ctx, g) {
      const cols = ["#ff8fb0", "#ffd166", "#c8b6ff", "#ff6f91", "#8affd1"];
      for (let i = -2; i <= 2; i++) {
        atHead(
          ctx,
          g,
          g.top.x + i * g.u * 0.2,
          g.top.y - Math.abs(i) * g.u * 0.04 + g.u * 0.02,
          (u) => {
            const col = cols[(i + 2) % 5];
            for (let p = 0; p < 5; p++) {
              const a = (p * Math.PI * 2) / 5;
              ellipse(
                ctx,
                Math.cos(a) * u * 0.055,
                Math.sin(a) * u * 0.055 - u * 0.03,
                u * 0.048,
                u * 0.048,
                0,
                col,
              );
            }
            ellipse(ctx, 0, -u * 0.03, u * 0.032, u * 0.032, 0, "#fff7ae");
          },
        );
      }
    },
    viking(ctx, g) {
      atHead(ctx, g, g.top.x, g.top.y, (u) => {
        const w = u * 0.52;
        ctx.fillStyle = "#a4adbb";
        ctx.strokeStyle = "#6b7382";
        ctx.lineWidth = Math.max(1.5, u * 0.02);
        ctx.beginPath();
        ctx.arc(0, 0, w * 0.6, Math.PI, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        for (const s of [-1, 1]) {
          ctx.fillStyle = "#f1e3c8";
          ctx.beginPath();
          ctx.moveTo(s * w * 0.42, -u * 0.02);
          ctx.quadraticCurveTo(s * w * 1.0, -u * 0.2, s * w * 0.88, -u * 0.5);
          ctx.quadraticCurveTo(s * w * 0.66, -u * 0.28, s * w * 0.3, -u * 0.16);
          ctx.closePath();
          ctx.fill();
        }
        ellipse(ctx, 0, -u * 0.18, u * 0.045, u * 0.045, 0, "#5b6472");
      });
    },
    spy(ctx, g) {
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        ctx.strokeStyle = "#3b2f23";
        ctx.lineWidth = u * 0.026;
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.arc(s * u * 0.24, 0, u * 0.17, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.moveTo(-u * 0.07, -u * 0.02);
        ctx.lineTo(u * 0.07, -u * 0.02);
        ctx.stroke();
      });
      atHead(ctx, g, g.mouth.x, g.mouth.y - g.u * 0.09, (u) => {
        ctx.fillStyle = "#2b211a";
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.quadraticCurveTo(s * u * 0.2, -u * 0.13, s * u * 0.32, -u * 0.02);
          ctx.quadraticCurveTo(s * u * 0.18, u * 0.07, 0, u * 0.045);
          ctx.closePath();
          ctx.fill();
        }
      });
    },

    /* ----- added face filters ----- */
    bear(ctx, g) {
      for (const s of [-1, 1])
        atHead(ctx, g, g.top.x + s * g.u * 0.33, g.top.y + g.u * 0.04, (u) => {
          ellipse(ctx, 0, 0, u * 0.17, u * 0.17, 0, "#7a4a25");
          ellipse(ctx, 0, 0, u * 0.1, u * 0.1, 0, "#c98d5c");
        });
      atHead(ctx, g, g.nose.x, g.nose.y + g.u * 0.05, (u) =>
        ellipse(ctx, 0, 0, u * 0.18, u * 0.12, 0, "#e6bd90"),
      );
      noseDot(ctx, g, "#3b2417", 0.07);
      blush(ctx, g, 0.25);
    },
    fox(ctx, g) {
      for (const s of [-1, 1])
        atHead(ctx, g, g.top.x + s * g.u * 0.31, g.top.y + g.u * 0.05, (u) => {
          ctx.rotate(s * 0.35);
          ctx.fillStyle = "#f07830";
          ctx.beginPath();
          ctx.moveTo(-u * 0.16, 0);
          ctx.lineTo(0, -u * 0.36);
          ctx.lineTo(u * 0.16, 0);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "#2c1c12";
          ctx.beginPath();
          ctx.moveTo(-u * 0.08, -u * 0.03);
          ctx.lineTo(0, -u * 0.22);
          ctx.lineTo(u * 0.08, -u * 0.03);
          ctx.closePath();
          ctx.fill();
        });
      atHead(ctx, g, g.nose.x, g.nose.y + g.u * 0.07, (u) =>
        ellipse(ctx, 0, 0, u * 0.24, u * 0.14, 0, "rgba(255,252,248,.92)"),
      );
      noseDot(ctx, g, "#1e130c", 0.06);
      ctx.strokeStyle = "#2c1c12";
      ctx.lineWidth = Math.max(1.5, g.u * 0.022);
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * u * 0.38, u * 0.02);
          ctx.lineTo(s * u * 0.5, -u * 0.08);
          ctx.stroke();
        }
      });
    },
    tiger(ctx, g) {
      for (const s of [-1, 1])
        atHead(ctx, g, g.top.x + s * g.u * 0.3, g.top.y + g.u * 0.05, (u) => {
          ctx.rotate(s * 0.3);
          ellipse(ctx, 0, 0, u * 0.15, u * 0.14, 0, "#f59331");
          ellipse(ctx, 0, u * 0.01, u * 0.08, u * 0.07, 0, "#ffe0b8");
        });
      atHead(ctx, g, g.nose.x, g.nose.y + g.u * 0.05, (u) =>
        ellipse(ctx, 0, 0, u * 0.2, u * 0.13, 0, "rgba(255,247,235,.92)"),
      );
      noseDot(ctx, g, "#e07b39", 0.05);
      ctx.strokeStyle = "#211a14";
      ctx.lineWidth = Math.max(2, g.u * 0.032);
      atHead(ctx, g, g.top.x, g.top.y + g.u * 0.26, (u) => {
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * u * 0.05, -u * 0.16);
          ctx.lineTo(s * u * 0.11, u * 0.06);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(s * u * 0.22, -u * 0.12);
          ctx.lineTo(s * u * 0.28, u * 0.02);
          ctx.stroke();
        }
      });
      for (const [c, s] of [
        [g.cheekL, -1],
        [g.cheekR, 1],
      ])
        atHead(ctx, g, c.x, c.y, (u) => {
          for (const i of [-1, 0, 1]) {
            ctx.beginPath();
            ctx.moveTo(s * u * 0.02, i * u * 0.11);
            ctx.lineTo(s * u * 0.2, i * u * 0.13 - u * 0.03);
            ctx.stroke();
          }
        });
    },
    pig(ctx, g) {
      for (const s of [-1, 1])
        atHead(ctx, g, g.top.x + s * g.u * 0.3, g.top.y + g.u * 0.06, (u) => {
          ctx.rotate(s * 0.5);
          ellipse(ctx, 0, -u * 0.02, u * 0.15, u * 0.1, 0, "#f6a6c1");
          ellipse(ctx, 0, -u * 0.01, u * 0.08, u * 0.05, 0, "#e07fa3");
        });
      atHead(ctx, g, g.nose.x, g.nose.y, (u) => {
        ellipse(ctx, 0, 0, u * 0.14, u * 0.1, 0, "#f393b6");
        for (const s of [-1, 1])
          ellipse(ctx, s * u * 0.055, 0, u * 0.024, u * 0.034, 0, "#c25e85");
      });
      blush(ctx, g, 0.45);
    },
    unicorn(ctx, g) {
      atHead(ctx, g, g.top.x, g.top.y, (u) => {
        ctx.fillStyle = "#ffd873";
        ctx.beginPath();
        ctx.moveTo(-u * 0.11, u * 0.02);
        ctx.lineTo(u * 0.11, u * 0.02);
        ctx.lineTo(0, -u * 0.58);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "#e0a02f";
        ctx.lineWidth = Math.max(1.5, u * 0.022);
        for (let i = 1; i <= 4; i++) {
          const f = i / 5;
          const y = u * 0.02 - f * u * 0.6;
          const w = u * 0.11 * (1 - f);
          if (w <= 0) continue;
          ctx.beginPath();
          ctx.moveTo(-w, y);
          ctx.lineTo(w, y);
          ctx.stroke();
        }
      });
      const cols = ["#ff5d8f", "#ffb703", "#8affc1", "#5bc0ff", "#b388ff"];
      for (let i = 0; i < 5; i++) {
        const f = i / 4;
        atHead(ctx, g, g.top.x, g.top.y + f * g.u * 0.5 + g.u * 0.08, (u) => {
          for (const s of [-1, 1])
            ellipse(
              ctx,
              s * u * (0.46 + f * 0.05),
              0,
              u * 0.12,
              u * 0.11,
              0,
              cols[i],
            );
        });
      }
      noseDot(ctx, g, "#ff9ec4", 0.05);
      blush(ctx, g, 0.3);
    },
    robot(ctx, g) {
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        ctx.fillStyle = "#1b2434";
        ctx.beginPath();
        ctx.roundRect(-u * 0.5, -u * 0.22, u, u * 0.44, u * 0.09);
        ctx.fill();
        ctx.strokeStyle = "#7d8aa0";
        ctx.lineWidth = Math.max(1.5, u * 0.02);
        ctx.beginPath();
        ctx.roundRect(-u * 0.5, -u * 0.22, u, u * 0.44, u * 0.09);
        ctx.stroke();
        for (const s of [-1, 1]) {
          ellipse(ctx, s * u * 0.24, 0, u * 0.1, u * 0.1, 0, "#41f0d8");
          ellipse(
            ctx,
            s * u * 0.24 - u * 0.03,
            -u * 0.03,
            u * 0.03,
            u * 0.025,
            0,
            "rgba(255,255,255,.75)",
          );
        }
      });
      atHead(ctx, g, g.top.x, g.top.y, (u) => {
        ctx.strokeStyle = "#8f9bb0";
        ctx.lineWidth = Math.max(2, u * 0.035);
        ctx.beginPath();
        ctx.moveTo(0, -u * 0.02);
        ctx.quadraticCurveTo(u * 0.06, -u * 0.3, 0, -u * 0.46);
        ctx.stroke();
        ellipse(ctx, 0, -u * 0.5, u * 0.07, u * 0.07, 0, "#ff4d6d");
        ellipse(
          ctx,
          -u * 0.02,
          -u * 0.53,
          u * 0.025,
          u * 0.02,
          0,
          "rgba(255,255,255,.7)",
        );
      });
      atHead(ctx, g, g.mouth.x, g.mouth.y, (u) => {
        ctx.fillStyle = "#93a1b6";
        ctx.beginPath();
        ctx.roundRect(-u * 0.24, -u * 0.1, u * 0.48, u * 0.2, u * 0.05);
        ctx.fill();
        ctx.strokeStyle = "#4c5666";
        ctx.lineWidth = Math.max(1.5, u * 0.022);
        for (const x of [-0.12, 0, 0.12]) {
          ctx.beginPath();
          ctx.moveTo(u * x, -u * 0.07);
          ctx.lineTo(u * x, u * 0.07);
          ctx.stroke();
        }
      });
    },
    skull(ctx, g) {
      ellipse(
        ctx,
        g.nose.x,
        (g.top.y + g.chin.y) / 2,
        g.u * 0.47,
        Math.max(g.u * 0.3, ((g.chin.y - g.top.y) / 2) * 0.97),
        g.roll,
        "rgba(238,237,231,.42)",
      );
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        for (const s of [-1, 1])
          ellipse(
            ctx,
            s * u * 0.24,
            -u * 0.02,
            u * 0.17,
            u * 0.2,
            s * 0.12,
            "rgba(6,6,10,.92)",
          );
      });
      atHead(ctx, g, g.nose.x, g.nose.y, (u) => {
        ctx.fillStyle = "rgba(6,6,10,.92)";
        ctx.beginPath();
        ctx.moveTo(0, -u * 0.07);
        ctx.lineTo(u * 0.06, u * 0.06);
        ctx.lineTo(-u * 0.06, u * 0.06);
        ctx.closePath();
        ctx.fill();
      });
      atHead(ctx, g, g.mouth.x, g.mouth.y, (u) => {
        ctx.fillStyle = "#f6f4ec";
        ctx.beginPath();
        ctx.roundRect(-u * 0.27, -u * 0.1, u * 0.54, u * 0.2, u * 0.05);
        ctx.fill();
        ctx.strokeStyle = "rgba(10,10,14,.85)";
        ctx.lineWidth = Math.max(1.5, u * 0.02);
        for (const x of [-0.2, -0.1, 0, 0.1, 0.2]) {
          ctx.beginPath();
          ctx.moveTo(u * x, -u * 0.1);
          ctx.lineTo(u * x, u * 0.1);
          ctx.stroke();
        }
      });
    },
    wolf(ctx, g) {
      for (const s of [-1, 1])
        atHead(ctx, g, g.top.x + s * g.u * 0.34, g.top.y + g.u * 0.04, (u) => {
          ctx.rotate(s * 0.4);
          ctx.fillStyle = "#6b5844";
          ctx.beginPath();
          ctx.moveTo(-u * 0.14, 0);
          ctx.lineTo(0, -u * 0.34);
          ctx.lineTo(u * 0.14, 0);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "#c9a887";
          ctx.beginPath();
          ctx.moveTo(-u * 0.07, -u * 0.02);
          ctx.lineTo(0, -u * 0.2);
          ctx.lineTo(u * 0.07, -u * 0.02);
          ctx.closePath();
          ctx.fill();
        });
      ctx.strokeStyle = "#4a3626";
      ctx.lineWidth = Math.max(2, g.u * 0.045);
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * u * 0.4, -u * 0.2);
          ctx.lineTo(s * u * 0.1, -u * 0.1);
          ctx.stroke();
        }
      });
      atHead(ctx, g, g.mouth.x, g.mouth.y, (u) => {
        ctx.fillStyle = "#fdfdf6";
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * u * 0.05, -u * 0.06);
          ctx.lineTo(s * u * 0.15, -u * 0.06);
          ctx.lineTo(s * u * 0.1, u * 0.16);
          ctx.closePath();
          ctx.fill();
        }
      });
      ctx.strokeStyle = "#6b5844";
      ctx.lineWidth = Math.max(1.5, g.u * 0.03);
      for (const [c, s] of [
        [g.cheekL, -1],
        [g.cheekR, 1],
      ])
        atHead(ctx, g, c.x, c.y, (u) => {
          for (const i of [-1, 0, 1]) {
            ctx.beginPath();
            ctx.moveTo(s * u * 0.02, i * u * 0.12);
            ctx.lineTo(s * u * 0.2, i * u * 0.15);
            ctx.stroke();
          }
        });
    },
    hero(ctx, g) {
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        ctx.fillStyle = "#d92b4b";
        ctx.beginPath();
        ctx.moveTo(-u * 0.54, -u * 0.3);
        ctx.quadraticCurveTo(0, -u * 0.4, u * 0.54, -u * 0.3);
        ctx.lineTo(u * 0.58, u * 0.06);
        ctx.lineTo(u * 0.46, u * 0.1);
        ctx.quadraticCurveTo(0, u * 0.02, -u * 0.46, u * 0.1);
        ctx.lineTo(-u * 0.58, u * 0.06);
        ctx.closePath();
        for (const s of [-1, 1]) {
          ctx.moveTo(s * u * 0.24 + u * 0.14, -u * 0.07);
          ctx.ellipse(
            s * u * 0.24,
            -u * 0.07,
            u * 0.14,
            u * 0.1,
            0,
            0,
            Math.PI * 2,
          );
        }
        ctx.fill("evenodd");
      });
    },
    cowboy(ctx, g) {
      atHead(ctx, g, g.top.x, g.top.y, (u) => {
        ctx.fillStyle = "#a06a35";
        ctx.beginPath();
        ctx.moveTo(-u * 0.28, -u * 0.06);
        ctx.lineTo(-u * 0.24, -u * 0.44);
        ctx.quadraticCurveTo(0, -u * 0.54, u * 0.24, -u * 0.44);
        ctx.lineTo(u * 0.28, -u * 0.06);
        ctx.closePath();
        ctx.fill();
        ellipse(ctx, 0, -u * 0.04, u * 0.6, u * 0.15, 0, "#8b5a2b");
        ctx.fillStyle = "#5e3a1e";
        ctx.beginPath();
        ctx.roundRect(-u * 0.3, -u * 0.18, u * 0.6, u * 0.08, u * 0.02);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,230,180,.5)";
        ctx.lineWidth = Math.max(1, u * 0.015);
        ctx.beginPath();
        ctx.roundRect(-u * 0.26, -u * 0.42, u * 0.52, u * 0.2, u * 0.04);
        ctx.stroke();
      });
    },
    chef(ctx, g) {
      atHead(ctx, g, g.top.x, g.top.y, (u) => {
        ctx.fillStyle = "#fbfbfd";
        ctx.strokeStyle = "#c9cddc";
        ctx.lineWidth = Math.max(1.5, u * 0.02);
        for (const [x, y, r] of [
          [-u * 0.26, -u * 0.3, u * 0.2],
          [0, -u * 0.4, u * 0.24],
          [u * 0.26, -u * 0.3, u * 0.2],
        ]) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        ctx.beginPath();
        ctx.roundRect(-u * 0.3, -u * 0.2, u * 0.6, u * 0.18, u * 0.05);
        ctx.fill();
        ctx.stroke();
      });
    },
    beanie(ctx, g) {
      atHead(ctx, g, g.top.x, g.top.y, (u) => {
        ctx.fillStyle = "#e63946";
        ctx.beginPath();
        ctx.moveTo(-u * 0.47, u * 0.04);
        ctx.quadraticCurveTo(-u * 0.5, -u * 0.62, 0, -u * 0.64);
        ctx.quadraticCurveTo(u * 0.5, -u * 0.62, u * 0.47, u * 0.04);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = "rgba(120,20,35,.5)";
        ctx.lineWidth = Math.max(1.5, u * 0.02);
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * u * 0.24, u * 0.02);
          ctx.quadraticCurveTo(s * u * 0.3, -u * 0.35, s * u * 0.1, -u * 0.6);
          ctx.stroke();
        }
        ctx.fillStyle = "#f4536a";
        ctx.beginPath();
        ctx.roundRect(-u * 0.49, -u * 0.1, u * 0.98, u * 0.16, u * 0.05);
        ctx.fill();
        ctx.strokeStyle = "rgba(120,20,35,.45)";
        ctx.stroke();
        ellipse(ctx, 0, -u * 0.7, u * 0.12, u * 0.12, 0, "#ffffff");
        ellipse(
          ctx,
          -u * 0.03,
          -u * 0.73,
          u * 0.05,
          u * 0.04,
          0,
          "rgba(210,215,235,.85)",
        );
      });
    },
    heartshades(ctx, g) {
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        ctx.strokeStyle = "#ff2e63";
        ctx.lineWidth = Math.max(2, u * 0.035);
        ctx.beginPath();
        ctx.moveTo(-u * 0.1, -u * 0.04);
        ctx.lineTo(u * 0.1, -u * 0.04);
        ctx.moveTo(-u * 0.46, -u * 0.06);
        ctx.lineTo(-u * 0.58, -u * 0.14);
        ctx.moveTo(u * 0.46, -u * 0.06);
        ctx.lineTo(u * 0.58, -u * 0.14);
        ctx.stroke();
        heart(ctx, -u * 0.26, -u * 0.03, u * 0.44, "rgba(255,60,110,.88)");
        heart(ctx, u * 0.26, -u * 0.03, u * 0.44, "rgba(255,60,110,.88)");
      });
    },
    pixelshades(ctx, g) {
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        ctx.fillStyle = "#0a0a10";
        ctx.fillRect(-u * 0.55, -u * 0.18, u * 1.1, u * 0.34);
        ctx.fillRect(-u * 0.64, -u * 0.13, u * 0.09, u * 0.24);
        ctx.fillRect(u * 0.55, -u * 0.13, u * 0.09, u * 0.24);
        ctx.fillRect(-u * 0.7, -u * 0.08, u * 0.06, u * 0.14);
        ctx.fillRect(u * 0.64, -u * 0.08, u * 0.06, u * 0.14);
        ctx.fillRect(-u * 0.06, -u * 0.26, u * 0.12, u * 0.08);
        ctx.fillStyle = "rgba(255,255,255,.32)";
        const p = u * 0.05;
        ctx.fillRect(-u * 0.4, -u * 0.12, p * 2, p);
        ctx.fillRect(-u * 0.4 + p * 2, -u * 0.12 + p, p, p);
        ctx.fillRect(u * 0.2, -u * 0.12, p * 2, p);
        ctx.fillRect(u * 0.2 + p * 2, -u * 0.12 + p, p, p);
      });
    },
    crying(ctx, g) {
      const t = performance.now() / 1100;
      ctx.strokeStyle = "#4b3a2f";
      ctx.lineWidth = Math.max(2, g.u * 0.04);
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(s * u * 0.42, -u * 0.14);
          ctx.lineTo(s * u * 0.1, -u * 0.26);
          ctx.stroke();
        }
      });
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        for (const s of [-1, 1]) {
          const ex = s * u * 0.24;
          ellipse(ctx, ex, u * 0.12, u * 0.15, u * 0.07, 0, "rgba(130,200,255,.5)");
          const p = (t + (s > 0 ? 0.5 : 0)) % 1;
          const fade = p > 0.85 ? (1 - p) / 0.15 : 1;
          const len = u * (0.15 + p * 0.45);
          ctx.strokeStyle = `rgba(130,200,255,${(0.55 * (1 - p * 0.5) * fade).toFixed(3)})`;
          ctx.lineWidth = u * 0.07;
          ctx.beginPath();
          ctx.moveTo(ex + s * u * 0.03, u * 0.14);
          ctx.quadraticCurveTo(
            ex + s * u * 0.07,
            u * 0.14 + len * 0.6,
            ex + s * u * 0.02,
            u * 0.14 + len,
          );
          ctx.stroke();
          const dx = ex + s * u * 0.02,
            dy = u * 0.14 + len;
          ctx.fillStyle = `rgba(150,210,255,${(0.75 * fade).toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(dx, dy - u * 0.1);
          ctx.quadraticCurveTo(dx + u * 0.06, dy, dx, dy + u * 0.06);
          ctx.quadraticCurveTo(dx - u * 0.06, dy, dx, dy - u * 0.1);
          ctx.fill();
        }
      });
    },
    sleepy(ctx, g) {
      // sample the forehead once in a while so the closed lids match the real skin
      const now = performance.now();
      if (!sleepSkin || now - sleepSkinAt > 1500) {
        try {
          const d = ctx.getImageData(
            Math.max(0, Math.round(g.eyes.x)),
            Math.max(0, Math.round(g.eyes.y - g.u * 0.25)),
            1,
            1,
          )?.data;
          if (d && d[3]) {
            sleepSkin = `rgb(${d[0]},${d[1]},${d[2]})`;
            sleepSkinAt = now;
          }
        } catch (e) {
          sleepSkin = sleepSkin || "rgba(232,178,140,.95)";
        }
      }
      const lid = sleepSkin || "rgba(232,178,140,.95)";
      atHead(ctx, g, g.eyes.x, g.eyes.y, (u) => {
        ctx.strokeStyle = "#26262e";
        ctx.lineWidth = Math.max(2.5, u * 0.045);
        for (const s of [-1, 1]) {
          ellipse(ctx, s * u * 0.24, -u * 0.01, u * 0.16, u * 0.12, 0, lid);
          ctx.beginPath();
          ctx.arc(s * u * 0.24, -u * 0.02, u * 0.14, Math.PI * 1.12, Math.PI * 1.88);
          ctx.stroke();
        }
      });
      const t = (performance.now() / 2200) % 1;
      for (let i = 0; i < 3; i++) {
        const p = (t + i / 3) % 1;
        const sz = g.u * (0.1 + p * 0.16);
        const x = g.top.x + g.u * (0.34 + p * 0.34);
        const y = g.top.y - g.u * (0.02 + p * 0.55);
        atHead(ctx, g, x, y, (u) => {
          ctx.globalAlpha = Math.min(1, (1 - p) * 2);
          ctx.lineCap = "round";
          ctx.strokeStyle = "rgba(20,30,60,.85)";
          ctx.lineWidth = sz * 0.34;
          ctx.beginPath();
          ctx.moveTo(-sz / 2, -sz / 2);
          ctx.lineTo(sz / 2, -sz / 2);
          ctx.lineTo(-sz / 2, sz / 2);
          ctx.lineTo(sz / 2, sz / 2);
          ctx.stroke();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = sz * 0.16;
          ctx.stroke();
        });
      }
    },
    kisses(ctx, g) {
      atHead(ctx, g, g.mouth.x, g.mouth.y, (u) => {
        ctx.fillStyle = "#e6396b";
        ctx.beginPath();
        ctx.moveTo(-u * 0.24, 0);
        ctx.quadraticCurveTo(-u * 0.14, -u * 0.15, 0, -u * 0.05);
        ctx.quadraticCurveTo(u * 0.14, -u * 0.15, u * 0.24, 0);
        ctx.quadraticCurveTo(u * 0.12, u * 0.17, 0, u * 0.17);
        ctx.quadraticCurveTo(-u * 0.12, u * 0.17, -u * 0.24, 0);
        ctx.closePath();
        ctx.fill();
        ellipse(ctx, -u * 0.06, u * 0.07, u * 0.07, u * 0.03, -0.3, "rgba(255,255,255,.4)");
      });
      for (const c of [g.cheekL, g.cheekR])
        atHead(ctx, g, c.x, c.y, (u) => heart(ctx, 0, 0, u * 0.18, "#ff2e63"));
    },
    afro(ctx, g) {
      const cols = ["#ff4d6d", "#ffb703", "#4ade80", "#38bdf8", "#a78bfa", "#f472b6"];
      atHead(ctx, g, g.top.x, g.top.y, (u) => {
        for (let i = 0; i <= 10; i++) {
          const a = Math.PI * (0.9 + (1.2 * i) / 10);
          const x = Math.cos(a) * u * 0.44;
          const y = Math.sin(a) * u * 0.44 * 0.8 + u * 0.1;
          ellipse(ctx, x, y, u * 0.2, u * 0.18, 0, cols[i % cols.length]);
        }
        ellipse(ctx, 0, -u * 0.24, u * 0.26, u * 0.2, 0, "#ff4d6d");
      });
    },
  };

  const PF = {
    SIMPLE,
    FANCY,
    get,
    Engine,
    geometry,
    EFFECTS,
    canCss,
    _forceMatrix: false,
    trackerFactory: null,
  };
  window.PingFilters = PF;
})();
