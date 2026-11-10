"use strict";
/*
 * The 3D scene of the bot film: THE CHAIN.
 *
 * Every chapter of the story (a stretch of trading with no long pause) forges one
 * link of a chain. A link is a ring woven from that chapter's real records, placed
 * around the ring by time: the forge point travels once around while the chapter
 * plays. One thread = one coin the bot watched, or one trade. A trade's thread is
 * gold while the position is open, flashes when it closes, then keeps its result
 * colour. How far a trade sits from the ring's core is its result in percent:
 * winners flare outward, losers sink inward.
 *
 * WebGL2: lines and point sprites drawn additively into a half-float buffer (so
 * dense light keeps its colour instead of clipping to white), 4x MSAA, a 5-level
 * bloom, an anamorphic streak, and a filmic tone map. Falls back to 8-bit buffers
 * when the browser has no float render targets.
 */
// eslint-disable-next-line no-unused-vars
const BotScene = (() => {
  const TAU = Math.PI * 2;
  const RM = 0.3; // tube radius of a link (its ring radius is 1)
  const LINK_GAP = 1.32; // distance between the centres of two linked rings
  const NPT = 64; // points per thread
  const SWEEP = 0.985; // share of the circle one chapter fills
  const FOV = (38 * Math.PI) / 180;

  const hash = (seed, k) => {
    const x = Math.sin(seed * 9301.17 * (k + 1) + k * 49.297) * 43758.5453;
    return x - Math.floor(x);
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  // ---------------------------------------------------------------- geometry

  // point on link k: u around the ring, v around the tube, rho = distance from the tube's core
  function linkPoint(k, u, rho, v, out, o = 0) {
    const R = 1 + rho * Math.cos(v);
    const cy = -k * LINK_GAP;
    if (k % 2 === 0) {
      out[o] = R * Math.cos(u);
      out[o + 1] = cy + R * Math.sin(u);
      out[o + 2] = rho * Math.sin(v);
    } else {
      out[o] = rho * Math.sin(v);
      out[o + 1] = cy + R * Math.sin(u);
      out[o + 2] = R * Math.cos(u);
    }
    return out;
  }
  // where on the ring a moment sits: starts at the top, runs once around
  const angleOf = (f) => Math.PI / 2 - TAU * SWEEP * f;

  // ---------------------------------------------------------------- matrices (column-major)

  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0];
  }
  function lookAt(e, t) {
    let zx = e[0] - t[0];
    let zy = e[1] - t[1];
    let zz = e[2] - t[2];
    let l = Math.hypot(zx, zy, zz);
    zx /= l;
    zy /= l;
    zz /= l;
    let xx = zz; // up(0,1,0) x z
    let xy = 0;
    let xz = -zx;
    l = Math.hypot(xx, xy, xz);
    xx /= l;
    xz /= l;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    return [xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0, -(xx * e[0] + xy * e[1] + xz * e[2]), -(yx * e[0] + yy * e[1] + yz * e[2]), -(zx * e[0] + zy * e[1] + zz * e[2]), 1];
  }
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  // ---------------------------------------------------------------- shaders

  const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec4 aA; // s along the thread, birth, close, kind (0 watched, 1 win, 2 loss)
layout(location=2) in vec3 aB; // seed, weight, link
uniform mat4 uVP;
uniform vec2 uJitter;
uniform float uP, uR, uTime, uBase, uTrade, uFogNear, uFogK;
uniform float uFlashW, uFlashT, uHotClose, uHotGain;
uniform float uLinkBoost[8]; // a link flares for a moment when it is finished
uniform vec3 uColBase, uColTint1, uColTint2, uColWin, uColLoss;
out vec3 vCol;
void main() {
  float s = aA.x, birth = aA.y, close = aA.z, kind = aA.w;
  float age = (uP - birth) * uR;
  vec4 clip = uVP * vec4(aPos, 1.0);
  clip.xy += uJitter * clip.w;
  float grow = clamp(age / 0.55, 0.0, 1.0);
  float shown = step(0.0, age) * step(s, grow + 0.002);
  vec3 col;
  float I;
  if (kind < 0.5) {
    col = aB.x < 0.80 ? uColBase : (aB.x < 0.92 ? uColTint1 : uColTint2);
    I = uBase * (0.55 + 1.4 * aB.y) + uFlashW * exp(-max(age, 0.0) / 0.5);
  } else {
    float cAge = (uP - close) * uR;
    if (cAge < 0.0) {
      col = vec3(1.0, 0.80, 0.38);
      I = uTrade * (1.7 + 0.9 * sin(uTime * 9.0 + aB.x * 30.0));
    } else {
      vec3 res = kind < 1.5 ? uColWin : uColLoss;
      float fl = exp(-cAge / 0.45);
      col = mix(res, vec3(1.0), 0.7 * fl);
      I = uTrade * (kind < 1.5 ? 1.0 : 0.85) + uFlashT * fl;
      // the trade a highlight is about burns brighter than everything around it
      float hot = step(abs(close - uHotClose), 1e-6) * uHotGain;
      I += 7.0 * hot;
      col = mix(col, vec3(1.0), 0.45 * hot);
    }
  }
  // a bead of light running along every thread
  float pulse = 0.5 + 0.5 * sin(s * 20.0 - uTime * 2.2 + aB.x * 50.0);
  I *= 0.7 + 1.0 * pow(pulse, 8.0);
  I *= 1.0 + uLinkBoost[int(clamp(aB.z, 0.0, 7.0))];
  float fog = clamp(1.0 - (clip.w - uFogNear) * uFogK, 0.2, 1.3);
  vCol = col * I * fog * shown;
  gl_Position = clip;
}`;
  const COLOR_FS = `#version 300 es
precision highp float;
in vec3 vCol;
out vec4 o;
void main() { o = vec4(vCol, 1.0); }`;

  const FLAT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aCol;
uniform mat4 uVP;
uniform float uGain, uFogNear, uFogK;
out vec3 vCol;
void main() {
  vec4 clip = uVP * vec4(aPos, 1.0);
  float fog = clamp(1.0 - (clip.w - uFogNear) * uFogK, 0.2, 1.3);
  vCol = aCol * uGain * fog;
  gl_Position = clip;
}`;

  const POINT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aDir;
layout(location=2) in vec4 aC; // birth, seed, kind (0 star, 1 spark, 2 steady glow), size
layout(location=3) in vec3 aCol;
uniform mat4 uVP;
uniform float uP, uR, uTime, uPx, uGain;
out vec3 vCol;
void main() {
  float birth = aC.x, seed = aC.y, kind = aC.z, size = aC.w;
  vec3 pos = aPos;
  float I = 1.0;
  if (kind < 0.5) {
    I = 0.25 + 0.75 * abs(sin(uTime * (0.5 + seed * 1.6) + seed * 40.0));
  } else if (kind < 1.5) {
    float age = (uP - birth) * uR;
    float life = 0.9 + seed * 0.7;
    if (age < 0.0 || age > life) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 1.0;
      vCol = vec3(0.0);
      return;
    }
    float k = age / life;
    pos += aDir * (1.0 - exp(-3.2 * age));
    I = 2.8 * (1.0 - k) * (1.0 - k);
    size *= 1.0 - 0.5 * k;
  }
  vec4 clip = uVP * vec4(pos, 1.0);
  gl_Position = clip;
  gl_PointSize = max(1.0, size * uPx / clip.w);
  vCol = aCol * I * uGain;
}`;
  const POINT_FS = `#version 300 es
precision highp float;
in vec3 vCol;
out vec4 o;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r = dot(d, d);
  if (r > 1.0) discard;
  float a = 1.0 - r;
  o = vec4(vCol * a * a, 1.0);
}`;

  const POST_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;
  const DOWN_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 4.0;
  c += texture(uTex, vUv - uTexel).rgb;
  c += texture(uTex, vUv + uTexel).rgb;
  c += texture(uTex, vUv + vec2(uTexel.x, -uTexel.y)).rgb;
  c += texture(uTex, vUv - vec2(uTexel.x, -uTexel.y)).rgb;
  o = vec4(c / 8.0, 1.0);
}`;
  const UP_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uGain;
in vec2 vUv;
out vec4 o;
void main() {
  vec2 h = uTexel * 0.5;
  vec3 c = texture(uTex, vUv + vec2(-h.x * 2.0, 0.0)).rgb;
  c += texture(uTex, vUv + vec2(-h.x, h.y)).rgb * 2.0;
  c += texture(uTex, vUv + vec2(0.0, h.y * 2.0)).rgb;
  c += texture(uTex, vUv + vec2(h.x, h.y)).rgb * 2.0;
  c += texture(uTex, vUv + vec2(h.x * 2.0, 0.0)).rgb;
  c += texture(uTex, vUv + vec2(h.x, -h.y)).rgb * 2.0;
  c += texture(uTex, vUv + vec2(0.0, -h.y * 2.0)).rgb;
  c += texture(uTex, vUv + vec2(-h.x, -h.y)).rgb * 2.0;
  o = vec4(c / 12.0 * uGain, 1.0);
}`;
  const STREAK_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThresh;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 c = vec3(0.0);
  float ws = 0.0;
  for (int i = -16; i <= 16; i++) {
    float w = exp(-float(i * i) / 70.0);
    vec3 t = texture(uTex, vUv + vec2(float(i) * uTexel.x * 2.4, 0.0)).rgb;
    c += max(t - uThresh, 0.0) * w;
    ws += w;
  }
  o = vec4(c / ws, 1.0);
}`;
  const FINAL_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene, uBloom, uStreak;
uniform float uExposure, uBloomK, uStreakK;
in vec2 vUv;
out vec4 o;
void main() {
  vec3 c = texture(uScene, vUv).rgb;
  c += texture(uBloom, vUv).rgb * uBloomK;
  c += texture(uStreak, vUv).rgb * uStreakK * vec3(0.55, 0.8, 1.0);
  c = 1.0 - exp(-c * uExposure);            // filmic shoulder: bright stays coloured
  c = pow(c, vec3(0.92));
  float m = smoothstep(0.0, 0.07, vUv.y) * smoothstep(1.0, 0.93, vUv.y); // soft top and bottom
  o = vec4(c * m, 1.0);
}`;

  // ---------------------------------------------------------------- scene

  function create({ width, height }) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, preserveDrawingBuffer: true, powerPreference: "high-performance" });
    if (!gl) throw new Error("this browser can't draw the 3D scene (no WebGL2) — open the same link in Google Chrome");
    const hdr = !!gl.getExtension("EXT_color_buffer_float");
    const IFMT = hdr ? gl.RGBA16F : gl.RGBA8;
    const TYPE = hdr ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    function shader(type, src) {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
      return s;
    }
    function program(vs, fs) {
      const p = gl.createProgram();
      gl.attachShader(p, shader(gl.VERTEX_SHADER, vs));
      gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(p)}`);
      const u = {};
      const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
      for (let i = 0; i < n; i++) {
        const name = gl.getActiveUniform(p, i).name;
        u[name] = gl.getUniformLocation(p, name);
      }
      return { p, u };
    }
    const P_LINE = program(LINE_VS, COLOR_FS);
    const P_FLAT = program(FLAT_VS, COLOR_FS);
    const P_POINT = program(POINT_VS, POINT_FS);
    const P_DOWN = program(POST_VS, DOWN_FS);
    const P_UP = program(POST_VS, UP_FS);
    const P_STREAK = program(POST_VS, STREAK_FS);
    const P_FINAL = program(POST_VS, FINAL_FS);

    function target(w, h) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, IFMT, w, h, 0, gl.RGBA, TYPE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      return { tex, fbo, w, h };
    }
    const sceneT = target(width, height);
    // multisampled buffer to draw into (smooth 1px threads), resolved into sceneT
    let msaa = null;
    {
      const samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES));
      const rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, IFMT, width, height);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, rb);
      if (samples > 1 && gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) msaa = { fbo };
    }
    const levels = [];
    for (let i = 1; i <= 5; i++) levels.push(target(Math.max(2, width >> i), Math.max(2, height >> i)));
    const streakT = target(levels[1].w, levels[1].h);
    const postVao = gl.createVertexArray();

    // buffers
    function lineVao(data) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 40, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 40, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 40, 28);
      return { vao, count: data.length / 10 };
    }
    function flatVao(data, usage = gl.STATIC_DRAW) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      return { vao, buf, count: data.length / 6 };
    }
    function pointVao(data, usage = gl.STATIC_DRAW) {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 52, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 52, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 52, 24);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 3, gl.FLOAT, false, 52, 40);
      return { vao, buf, count: data.length / 13 };
    }

    let M = null; // built model
    let VP = new Float32Array(16);
    const hoopData = new Float32Array(2 * 2 * 56 * 2 * 6);
    const hoop = flatVao(hoopData, gl.DYNAMIC_DRAW);

    function writeThread(arr, off, k, uEnd, span, turns, v0, rho, birth, close, kind, seed, w, anchor, ao) {
      const pt = [0, 0, 0];
      let px = 0;
      let py = 0;
      let pz = 0;
      let ps = 0;
      const aj = Math.round((NPT - 1) * 0.8);
      for (let j = 0; j < NPT; j++) {
        const s = j / (NPT - 1);
        linkPoint(k, uEnd + span * (1 - s), rho, v0 + turns * TAU * s, pt);
        if (j === aj && anchor) {
          anchor[ao] = pt[0];
          anchor[ao + 1] = pt[1];
          anchor[ao + 2] = pt[2];
        }
        if (j > 0) {
          arr[off++] = px; arr[off++] = py; arr[off++] = pz; arr[off++] = ps; arr[off++] = birth; arr[off++] = close; arr[off++] = kind; arr[off++] = seed; arr[off++] = w; arr[off++] = k;
          arr[off++] = pt[0]; arr[off++] = pt[1]; arr[off++] = pt[2]; arr[off++] = s; arr[off++] = birth; arr[off++] = close; arr[off++] = kind; arr[off++] = seed; arr[off++] = w; arr[off++] = k;
        }
        px = pt[0];
        py = pt[1];
        pz = pt[2];
        ps = s;
      }
      return off;
    }

    /**
     * model: {
     *   chapters: [{ p0, p1, color:[r,g,b], ticks:[f...] }],
     *   bots: [{ colors:{base,tint1,tint2,win,loss}, lines:[{seed,w}], pAppear, tradeOfLine,
     *            trades:[{line,pnl,pct}], pOpen, pClose }]
     * }
     */
    function build(model) {
      const CH = model.chapters;
      const chapterOf = (p) => {
        for (let k = 0; k < CH.length; k++) if (p <= CH[k].p1 + 1e-9) return k;
        return CH.length - 1;
      };
      const fracIn = (k, p) => clamp((p - CH[k].p0) / Math.max(1e-9, CH[k].p1 - CH[k].p0), 0, 1);
      const VPT = (NPT - 1) * 2 * 10;
      const sparks = [];
      const bots = model.bots.map((B, bi) => {
        // watched coins
        const watched = [];
        for (let i = 0; i < B.lines.length; i++) if (B.tradeOfLine[i] < 0) watched.push(i);
        const wData = new Float32Array(watched.length * VPT);
        const lineAnchor = new Float32Array(B.lines.length * 3);
        let off = 0;
        const perChapter = new Array(CH.length).fill(0);
        for (const i of watched) {
          const s = B.lines[i].seed;
          const p = B.pAppear[i];
          const k = chapterOf(p);
          perChapter[k]++;
          // most threads coil around the tube, some run along it
          const runner = hash(s, 8) < 0.3;
          const span = runner ? 0.8 + 0.8 * hash(s, 2) : 0.3 + 0.55 * hash(s, 2);
          const turns = (hash(s, 3) < 0.5 ? -1 : 1) * (runner ? 0.15 + 0.7 * hash(s, 6) : 1.2 + 2.6 * hash(s, 6));
          const rho = RM * (0.28 + 0.64 * hash(s, 5));
          off = writeThread(wData, off, k, angleOf(fracIn(k, p)), span, turns, hash(s, 4) * TAU, rho, p, 9, 0, hash(s, 7), B.lines[i].w || 0, lineAnchor, i * 3);
        }
        // trades: distance from the core = result in percent, relative to this bot's usual size
        const abs = B.trades.map((t) => (t.pct === null ? null : Math.abs(t.pct))).filter((v) => v !== null).sort((a, b) => a - b);
        const scale = abs.length ? Math.max(1e-6, abs[Math.floor(abs.length * 0.9)]) : 1;
        const tData = new Float32Array(B.trades.length * VPT);
        const tradeAnchor = new Float32Array(B.trades.length * 3);
        off = 0;
        const tPerChapter = new Array(CH.length).fill(0);
        B.trades.forEach((t, ti) => {
          const base = t.line >= 0 && t.line < B.lines.length ? B.lines[t.line].seed : 0.5;
          const s = (base + ti * 0.6180339) % 1;
          const p = B.pOpen[ti];
          const k = chapterOf(p);
          tPerChapter[k]++;
          const z = t.pct === null ? (t.pnl > 0 ? 0.3 : -0.3) : clamp(t.pct / scale, -1, 1);
          const runner = hash(s, 8) < 0.35;
          const span = runner ? 0.9 + 0.7 * hash(s, 2) : 0.5 + 0.5 * hash(s, 2);
          const turns = (hash(s, 3) < 0.5 ? -1 : 1) * (runner ? 0.2 + 0.6 * hash(s, 6) : 1.0 + 1.6 * hash(s, 6));
          const rho = RM * (1.0 + 0.6 * z);
          off = writeThread(tData, off, k, angleOf(fracIn(k, p)), span, turns, hash(s, 4) * TAU, rho, p, B.pClose[ti], t.pnl > 0 ? 1 : 2, hash(s, 7), 0.5, tradeAnchor, ti * 3);
          // sparks thrown off when the trade closes
          const n = t.pnl > 0 ? 9 : 5;
          const col = t.pnl > 0 ? B.colors.win : B.colors.loss;
          const ax = tradeAnchor[ti * 3];
          const ay = tradeAnchor[ti * 3 + 1];
          const az = tradeAnchor[ti * 3 + 2];
          for (let q = 0; q < n; q++) {
            const h1 = hash(s, 20 + q);
            const h2 = hash(s, 40 + q);
            const h3 = hash(s, 60 + q);
            const th = h1 * TAU;
            const ph = Math.acos(2 * h2 - 1);
            const sp = 0.16 + 0.42 * h3;
            sparks.push(ax, ay, az, Math.sin(ph) * Math.cos(th) * sp, Math.cos(ph) * sp, Math.sin(ph) * Math.sin(th) * sp, B.pClose[ti], h3, 1, 0.028 + 0.04 * h1, col[0], col[1], col[2]);
          }
        });
        // threads overlapping at any one place on the ring -> how bright one thread may be
        const density = (counts, meanSpan) => (Math.max(1, ...counts) * meanSpan) / (TAU * SWEEP);
        // threads born per unit of replay, in the busiest chapter -> how hard new ones may flash
        const rate = (counts) => Math.max(1e-9, ...counts.map((n, k) => n / Math.max(1e-6, CH[k].p1 - CH[k].p0)));
        return {
          bi,
          colors: B.colors,
          watched: lineVao(wData),
          trades: lineVao(tData),
          base: clamp(42 / density(perChapter, 0.74), 0.02, 0.6),
          trade: clamp(17 / density(tPerChapter, 0.85), 0.16, 1.2),
          rateW: rate(perChapter),
          rateT: rate(tPerChapter),
          lineAnchor,
          tradeAnchor,
        };
      });

      // scaffold: the bare ring before it is woven, plus a tick for every day of the chapter
      const sc = [];
      const ranges = [];
      const pt = [0, 0, 0];
      const pt2 = [0, 0, 0];
      CH.forEach((c, k) => {
        const start = sc.length / 6;
        const col = c.color;
        for (let ring = 0; ring < 6; ring++) {
          const v = (ring / 6) * TAU;
          for (let j = 0; j < 160; j++) {
            linkPoint(k, (j / 160) * TAU, RM * 1.02, v, pt);
            linkPoint(k, ((j + 1) / 160) * TAU, RM * 1.02, v, pt2);
            sc.push(pt[0], pt[1], pt[2], col[0] * 0.07, col[1] * 0.07, col[2] * 0.07, pt2[0], pt2[1], pt2[2], col[0] * 0.07, col[1] * 0.07, col[2] * 0.07);
          }
        }
        (c.ticks || []).forEach((f, ti) => {
          const u = angleOf(f);
          const long = ti % 7 === 0;
          linkPoint(k, u, RM * 1.75, 0, pt);
          linkPoint(k, u, RM * (long ? 2.15 : 1.95), 0, pt2);
          const g = long ? 0.5 : 0.25;
          sc.push(pt[0], pt[1], pt[2], col[0] * g, col[1] * g, col[2] * g, pt2[0], pt2[1], pt2[2], col[0] * g, col[1] * g, col[2] * g);
        });
        ranges.push([start, sc.length / 6 - start]);
      });
      const scaffold = flatVao(new Float32Array(sc));

      // stars far behind the chain
      const pts = [];
      const midY = (-(CH.length - 1) * LINK_GAP) / 2;
      for (let i = 0; i < 520; i++) {
        const th = hash(i + 1, 1) * TAU;
        const ph = Math.acos(2 * hash(i + 1, 2) - 1);
        const r = 12 + 14 * hash(i + 1, 3);
        const h = hash(i + 1, 4);
        const tint = h < 0.7 ? [0.6, 0.75, 1.0] : h < 0.85 ? [1.0, 0.8, 0.55] : [0.8, 0.7, 1.0];
        pts.push(Math.sin(ph) * Math.cos(th) * r, midY + Math.cos(ph) * r, Math.sin(ph) * Math.sin(th) * r, 0, 0, 0, 0, hash(i + 1, 5), 0, 0.05 + 0.1 * hash(i + 1, 6), tint[0], tint[1], tint[2]);
      }
      const stars = pointVao(new Float32Array(pts));
      const sparkVao = pointVao(new Float32Array(sparks));
      M = { CH, bots, scaffold, ranges, stars, sparks: sparkVao };
      return M;
    }

    function bindTarget(t) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
      gl.viewport(0, 0, t ? t.w : width, t ? t.h : height);
    }

    /**
     * st: { p, sec, R, cam:{target,yaw,pitch,dist}, ox, oy, linkGain:[..],
     *       hoops:[{k,f,gain,color}], hot:{bi,close,gain} | null,
     *       gain: brightness of the threads (lower when the camera is far),
     *       linkBoost:[..] extra brightness per link (the flare when it is finished) }
     */
    function render(st) {
      const c = st.cam;
      const cp = Math.cos(c.pitch);
      const eye = [c.target[0] + c.dist * Math.sin(c.yaw) * cp, c.target[1] + c.dist * Math.sin(c.pitch), c.target[2] + c.dist * Math.cos(c.yaw) * cp];
      VP = mul(perspective(FOV, width / height, 0.1, 120), lookAt(eye, c.target));
      for (let col = 0; col < 4; col++) {
        // shift the picture so the target sits at the centre of the main window
        VP[col * 4] += st.ox * VP[col * 4 + 3];
        VP[col * 4 + 1] += st.oy * VP[col * 4 + 3];
      }
      const fogNear = c.dist - 1.5;
      const fogK = 0.23;
      const uPx = height / 2 / Math.tan(FOV / 2);

      bindTarget(msaa ? { fbo: msaa.fbo, w: width, h: height } : sceneT);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.disable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);

      // stars and sparks
      gl.useProgram(P_POINT.p);
      gl.uniformMatrix4fv(P_POINT.u.uVP, false, VP);
      gl.uniform1f(P_POINT.u.uP, st.p);
      gl.uniform1f(P_POINT.u.uR, st.R);
      gl.uniform1f(P_POINT.u.uTime, st.sec);
      gl.uniform1f(P_POINT.u.uPx, uPx);
      gl.uniform1f(P_POINT.u.uGain, 0.55);
      gl.bindVertexArray(M.stars.vao);
      gl.drawArrays(gl.POINTS, 0, M.stars.count);
      gl.uniform1f(P_POINT.u.uGain, 1.0);
      gl.bindVertexArray(M.sparks.vao);
      gl.drawArrays(gl.POINTS, 0, M.sparks.count);

      // bare rings + day ticks
      gl.useProgram(P_FLAT.p);
      gl.uniformMatrix4fv(P_FLAT.u.uVP, false, VP);
      gl.uniform1f(P_FLAT.u.uFogNear, fogNear);
      gl.uniform1f(P_FLAT.u.uFogK, fogK);
      gl.bindVertexArray(M.scaffold.vao);
      M.ranges.forEach(([start, count], k) => {
        const g = st.linkGain[k] || 0;
        if (g <= 0.002) return;
        gl.uniform1f(P_FLAT.u.uGain, g);
        gl.drawArrays(gl.LINES, start, count);
      });

      // the forge: hoops around the tube where the story is right now
      let n = 0;
      const pt = [0, 0, 0];
      const pt2 = [0, 0, 0];
      for (const h of st.hoops) {
        if (h.gain <= 0.002) continue;
        const u = angleOf(h.f);
        for (let ring = 0; ring < 2; ring++) {
          const rr = RM * (ring ? 1.78 : 1.55);
          const g = h.gain * (ring ? 0.5 : 2.4);
          const col = ring ? h.color : [1, 1, 1];
          for (let j = 0; j < 56; j++) {
            linkPoint(h.k, u, rr, (j / 56) * TAU, pt);
            linkPoint(h.k, u, rr, ((j + 1) / 56) * TAU, pt2);
            hoopData.set([pt[0], pt[1], pt[2], col[0] * g, col[1] * g, col[2] * g, pt2[0], pt2[1], pt2[2], col[0] * g, col[1] * g, col[2] * g], n);
            n += 12;
          }
        }
      }
      if (n) {
        gl.bindVertexArray(hoop.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, hoop.buf);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, hoopData.subarray(0, n));
        gl.uniform1f(P_FLAT.u.uGain, 1);
        gl.drawArrays(gl.LINES, 0, n / 6);
      }

      // the threads
      gl.useProgram(P_LINE.p);
      const U = P_LINE.u;
      gl.uniformMatrix4fv(U.uVP, false, VP);
      gl.uniform1f(U.uP, st.p);
      gl.uniform1f(U.uR, st.R);
      gl.uniform1f(U.uTime, st.sec);
      gl.uniform1f(U.uFogNear, fogNear);
      gl.uniform1f(U.uFogK, fogK);
      const boost = new Float32Array(8);
      (st.linkBoost || []).forEach((v, k) => {
        if (k < 8) boost[k] = v;
      });
      gl.uniform1fv(U["uLinkBoost[0]"], boost);
      for (const B of M.bots) {
        gl.uniform3fv(U.uColBase, B.colors.base);
        gl.uniform3fv(U.uColTint1, B.colors.tint1);
        gl.uniform3fv(U.uColTint2, B.colors.tint2);
        gl.uniform3fv(U.uColWin, B.colors.win);
        gl.uniform3fv(U.uColLoss, B.colors.loss);
        gl.uniform1f(U.uBase, B.base * st.gain);
        gl.uniform1f(U.uTrade, B.trade * st.gain);
        // keep the light at the forge point about the same however busy the bot was
        gl.uniform1f(U.uFlashW, clamp(14 / Math.max(1, (B.rateW * 0.5) / st.R), 0.02, 0.9));
        gl.uniform1f(U.uFlashT, clamp(9 / Math.max(1, (B.rateT * 0.45) / st.R), 0.3, 4.5));
        const hot = st.hot && st.hot.bi === B.bi ? st.hot : null;
        gl.uniform1f(U.uHotClose, hot ? Math.fround(hot.close) : -9);
        gl.uniform1f(U.uHotGain, hot ? hot.gain : 0);
        if (B.watched.count) {
          gl.uniform2f(U.uJitter, 0, 0);
          gl.bindVertexArray(B.watched.vao);
          gl.drawArrays(gl.LINES, 0, B.watched.count);
        }
        if (B.trades.count) {
          gl.bindVertexArray(B.trades.vao);
          // three passes a pixel apart: trade threads read a little thicker than watched coins
          for (const [dx, dy] of [[0, 0], [1.0, 0.55], [-0.55, 1.0]]) {
            gl.uniform2f(U.uJitter, (dx * 2) / width, (dy * 2) / height);
            gl.drawArrays(gl.LINES, 0, B.trades.count);
          }
        }
      }

      // ---- post
      gl.disable(gl.BLEND);
      if (msaa) {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, msaa.fbo);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, sceneT.fbo);
        gl.blitFramebuffer(0, 0, width, height, 0, 0, width, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      }
      gl.bindVertexArray(postVao);
      gl.activeTexture(gl.TEXTURE0);
      // bloom: down the chain...
      gl.useProgram(P_DOWN.p);
      gl.uniform1i(P_DOWN.u.uTex, 0);
      let src = sceneT;
      for (const lv of levels) {
        bindTarget(lv);
        gl.bindTexture(gl.TEXTURE_2D, src.tex);
        gl.uniform2f(P_DOWN.u.uTexel, 1 / src.w, 1 / src.h);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        src = lv;
      }
      // ...the streak from a small level, before the levels are mixed...
      gl.useProgram(P_STREAK.p);
      gl.uniform1i(P_STREAK.u.uTex, 0);
      bindTarget(streakT);
      gl.bindTexture(gl.TEXTURE_2D, levels[1].tex);
      gl.uniform2f(P_STREAK.u.uTexel, 1 / levels[1].w, 1 / levels[1].h);
      gl.uniform1f(P_STREAK.u.uThresh, hdr ? 1.1 : 0.55);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // ...and back up, adding each wider glow onto the next sharper one
      gl.useProgram(P_UP.p);
      gl.uniform1i(P_UP.u.uTex, 0);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      for (let i = levels.length - 1; i > 0; i--) {
        bindTarget(levels[i - 1]);
        gl.bindTexture(gl.TEXTURE_2D, levels[i].tex);
        gl.uniform2f(P_UP.u.uTexel, 1 / levels[i].w, 1 / levels[i].h);
        gl.uniform1f(P_UP.u.uGain, 1.0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      gl.disable(gl.BLEND);
      // final: scene + glow + streak, tone mapped, to the canvas
      bindTarget(null);
      gl.useProgram(P_FINAL.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, sceneT.tex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, levels[0].tex);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, streakT.tex);
      gl.uniform1i(P_FINAL.u.uScene, 0);
      gl.uniform1i(P_FINAL.u.uBloom, 1);
      gl.uniform1i(P_FINAL.u.uStreak, 2);
      gl.uniform1f(P_FINAL.u.uExposure, hdr ? 1.0 : 1.6);
      gl.uniform1f(P_FINAL.u.uBloomK, 0.16);
      gl.uniform1f(P_FINAL.u.uStreakK, 0.5);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindVertexArray(null);
    }

    // world point -> pixel in this canvas (after the last render)
    function project(x, y, z) {
      const w = VP[3] * x + VP[7] * y + VP[11] * z + VP[15];
      const nx = (VP[0] * x + VP[4] * y + VP[8] * z + VP[12]) / w;
      const ny = (VP[1] * x + VP[5] * y + VP[9] * z + VP[13]) / w;
      return { x: (nx * 0.5 + 0.5) * width, y: (1 - (ny * 0.5 + 0.5)) * height, w };
    }

    return {
      canvas,
      hdr,
      msaa: !!msaa,
      build,
      render,
      project,
      // world position of a trade's thread / a watched coin's thread / the forge point
      tradeAnchor: (bi, ti) => M.bots[bi].tradeAnchor.subarray(ti * 3, ti * 3 + 3),
      lineAnchor: (bi, li) => M.bots[bi].lineAnchor.subarray(li * 3, li * 3 + 3),
      forgePoint: (k, f) => linkPoint(k, angleOf(f), 0, 0, [0, 0, 0]),
      pxPerUnit: (dist) => height / 2 / Math.tan(FOV / 2) / dist,
    };
  }

  return { create, RM, LINK_GAP, FOV };
})();
