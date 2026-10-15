// 光の筆レンダラー（WebGL2）
// 前フレームの絵を「ずらし・滲ませ・薄めて」から新しい線を加算で足すフィードバック描画。
// 色は HDR（上限なし）で蓄積し、最後にブルームとトーンマップで表示用に圧縮する。

const FULL_VS = `#version 300 es
out vec2 uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
in vec2 uv;
out vec4 o;
`;

const NOISE = `
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p), u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) { return noise(p) * 0.6 + noise(p * 2.1 + 5.2) * 0.3 + noise(p * 4.3 + 9.7) * 0.1; }
// スカラー場の回転（curl）は発散ゼロの流れになるので、煙のように渦を巻いて流れる
vec2 curl(vec2 p) {
  float e = 0.02;
  float a = fbm(p + vec2(0, e)), b = fbm(p - vec2(0, e));
  float c = fbm(p + vec2(e, 0)), d = fbm(p - vec2(e, 0));
  return vec2(a - b, -(c - d)) / (2.0 * e);
}`;

const SHADERS = {
  inkAdvect: HEADER + NOISE + `
uniform sampler2D ink, vel;
uniform vec2 texel, vtexel;
uniform float decay, eps, spread, flowAmt, time, mode, dt, aspect;
void main() {
  vec2 d = vec2(0.0);
  if (mode > 0.5 && mode < 1.5) {
    vec2 q = vec2(uv.x * aspect, uv.y) * 2.2;
    d = curl(q + vec2(time * 0.07, time * 0.05)) * flowAmt * 0.06 * dt;
    d.y += flowAmt * 0.015 * dt;               // ほんの少し上昇（煙っぽさ）
  } else if (mode > 1.5) {
    d = texture(vel, uv).xy * vtexel * dt;
  }
  vec2 p = uv - d;
  vec4 c = texture(ink, p);
  vec4 b = (texture(ink, p + vec2(texel.x, 0)) + texture(ink, p - vec2(texel.x, 0)) +
            texture(ink, p + vec2(0, texel.y)) + texture(ink, p - vec2(0, texel.y))) * 0.25;
  c = mix(c, b, spread);
  o = max(c * decay - eps, 0.0);
}`,
  velSplat: HEADER + `
uniform sampler2D src;
uniform vec2 point, force;
uniform float radius, aspect;
void main() {
  vec2 d = uv - point; d.x *= aspect;
  float g = exp(-dot(d, d) / radius);
  o = vec4(texture(src, uv).xy + force * g, 0.0, 1.0);
}`,
  advect: HEADER + `
uniform sampler2D vel, src;
uniform vec2 vtexel;
uniform float dt, dissipation;
void main() {
  vec2 p = uv - texture(vel, uv).xy * vtexel * dt;
  o = texture(src, p) * dissipation;
}`,
  divergence: HEADER + `
uniform sampler2D vel;
uniform vec2 texel;
void main() {
  float L = texture(vel, uv - vec2(texel.x, 0)).x, R = texture(vel, uv + vec2(texel.x, 0)).x;
  float B = texture(vel, uv - vec2(0, texel.y)).y, T = texture(vel, uv + vec2(0, texel.y)).y;
  o = vec4(0.5 * (R - L + T - B), 0, 0, 1);
}`,
  pressure: HEADER + `
uniform sampler2D prs, dv;
uniform vec2 texel;
void main() {
  float L = texture(prs, uv - vec2(texel.x, 0)).x, R = texture(prs, uv + vec2(texel.x, 0)).x;
  float B = texture(prs, uv - vec2(0, texel.y)).x, T = texture(prs, uv + vec2(0, texel.y)).x;
  o = vec4((L + R + B + T - texture(dv, uv).x) * 0.25, 0, 0, 1);
}`,
  gradient: HEADER + `
uniform sampler2D prs, vel;
uniform vec2 texel;
void main() {
  float L = texture(prs, uv - vec2(texel.x, 0)).x, R = texture(prs, uv + vec2(texel.x, 0)).x;
  float B = texture(prs, uv - vec2(0, texel.y)).x, T = texture(prs, uv + vec2(0, texel.y)).x;
  o = vec4(texture(vel, uv).xy - 0.5 * vec2(R - L, T - B), 0, 1);
}`,
  scale: HEADER + `
uniform sampler2D src;
uniform float k;
void main() { o = texture(src, uv) * k; }`,
  down: HEADER + `
uniform sampler2D src;
uniform vec2 texel;
void main() {
  vec2 h = texel * 0.5;
  o = (texture(src, uv + vec2(-h.x, -h.y)) + texture(src, uv + vec2(h.x, -h.y)) +
       texture(src, uv + vec2(-h.x, h.y)) + texture(src, uv + vec2(h.x, h.y))) * 0.25;
}`,
  blur: HEADER + `
uniform sampler2D src;
uniform vec2 dir;
void main() {
  vec4 c = texture(src, uv) * 0.227027;
  c += (texture(src, uv + dir * 1.3846) + texture(src, uv - dir * 1.3846)) * 0.3162162;
  c += (texture(src, uv + dir * 3.2308) + texture(src, uv - dir * 3.2308)) * 0.0702703;
  o = c;
}`,
  composite: HEADER + `
uniform sampler2D ink, b1, b2, b3;
uniform float bloom;
void main() {
  vec3 c = texture(ink, uv).rgb;
  c += bloom * (texture(b1, uv).rgb * 0.6 + texture(b2, uv).rgb * 0.5 + texture(b3, uv).rgb * 0.4);
  c = vec3(1.0) - exp(-c * 1.2);   // トーンマップ：重なるほど明るくなるが、白飛びはなめらか
  o = vec4(c, 1.0);
}`,
};

const SEG_VS = `#version 300 es
in vec2 pos; in vec2 A; in vec2 B; in vec2 Wd; in vec3 C0; in vec3 C1; in vec2 I; in float Cap;
uniform vec2 res;
out vec2 px;
flat out vec2 a; flat out vec2 b; flat out vec2 wd; flat out vec3 c0; flat out vec3 c1; flat out vec2 ii; flat out float cap;
void main() {
  px = pos; a = A; b = B; wd = Wd; c0 = C0; c1 = C1; ii = I; cap = Cap;
  gl_Position = vec4(pos.x / res.x * 2.0 - 1.0, 1.0 - pos.y / res.y * 2.0, 0.0, 1.0);
}`;
const SEG_FS = `#version 300 es
precision highp float;
in vec2 px;
flat in vec2 a; flat in vec2 b; flat in vec2 wd; flat in vec3 c0; flat in vec3 c1; flat in vec2 ii; flat in float cap;
uniform float erase;
out vec4 o;
void main() {
  vec2 ba = b - a;
  float L2 = max(dot(ba, ba), 1e-4);
  float t = dot(px - a, ba) / L2;
  // 線分の本体だけを塗る（端の丸を塗ると、つなぎ目が加算で二重になり数珠状になる）
  if (t >= 1.0 || (t < 0.0 && cap < 0.5)) discard;
  float tc = clamp(t, 0.0, 1.0);
  float d = length(px - a - ba * tc);
  float hw = mix(wd.x, wd.y, tc) * 0.5;
  float m = 1.0 - smoothstep(hw * 0.35, hw, d);
  if (m <= 0.0) discard;
  vec3 col = mix(c0, c1, tc) * mix(ii.x, ii.y, tc);
  o = erase > 0.5 ? vec4(0, 0, 0, m) : vec4(col * m, m);
}`;
const FLOATS_PER_VERT = 17;

export class Glow {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = (this.gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true, antialias: false, alpha: false }));
    if (!gl) throw new Error("WebGL2 に対応していません");
    this.hdr = !!gl.getExtension("EXT_color_buffer_float");
    gl.getExtension("OES_texture_float_linear");
    this.fmt = this.hdr ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
    this.P = {};
    for (const [k, fs] of Object.entries(SHADERS)) this.P[k] = this.program(FULL_VS, fs);
    this.P.seg = this.program(SEG_VS, SEG_FS);
    this.segBuf = gl.createBuffer();
    this.segVao = gl.createVertexArray();
    gl.bindVertexArray(this.segVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    let off = 0;
    for (const [name, size] of [["pos", 2], ["A", 2], ["B", 2], ["Wd", 2], ["C0", 3], ["C1", 3], ["I", 2], ["Cap", 1]]) {
      const loc = gl.getAttribLocation(this.P.seg.p, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, FLOATS_PER_VERT * 4, off * 4);
      off += size;
    }
    gl.bindVertexArray(null);
    this.emptyVao = gl.createVertexArray();
    this.adds = []; this.erases = []; this.splats = [];
    this.time = 0;
  }

  program(vsSrc, fsSrc) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  target(w, h) {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.fmt.internal, w, h, 0, gl.RGBA, this.fmt.type, null);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]])
      gl.texParameteri(gl.TEXTURE_2D, k, v);
    const f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f, w, h };
  }
  pair(w, h) {
    const p = { r: this.target(w, h), w: this.target(w, h) };
    p.swap = () => { [p.r, p.w] = [p.w, p.r]; };
    return p;
  }

  resize(w, h) {
    this.w = w; this.h = h;
    this.canvas.width = w; this.canvas.height = h;
    this.ink = this.pair(w, h);
    this.fw = Math.max(32, Math.round(w / 4)); this.fh = Math.max(24, Math.round(h / 4));
    this.vel = this.pair(this.fw, this.fh);
    this.prs = this.pair(this.fw, this.fh);
    this.dv = this.target(this.fw, this.fh);
    this.bl = [2, 4, 8].map((s) => this.pair(Math.max(1, Math.round(w / s)), Math.max(1, Math.round(h / s))));
    this.clear();
  }

  clear() {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 0);
    for (const t of [this.ink.r, this.ink.w, this.vel.r, this.vel.w, this.prs.r, this.prs.w]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.f); gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  run(P, target, uniforms) {
    const gl = this.gl;
    gl.useProgram(P.p);
    let unit = 0;
    for (const [k, v] of Object.entries(uniforms)) {
      const loc = P.u[k];
      if (loc == null) continue;
      if (v && v.t) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, v.t); gl.uniform1i(loc, unit++); }
      else if (typeof v === "number") gl.uniform1f(loc, v);
      else if (v.length === 2) gl.uniform2f(loc, v[0], v[1]);
      else if (v.length === 3) gl.uniform3f(loc, v[0], v[1], v[2]);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.f : null);
    gl.viewport(0, 0, target ? target.w : this.w, target ? target.h : this.h);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // 線分を追加（座標はこのレンダラーのピクセル座標、y 下向き）
  segment(s) {
    const pad = Math.max(s.w0, s.w1) * 0.5 + 2;
    const x0 = Math.min(s.a.x, s.b.x) - pad, x1 = Math.max(s.a.x, s.b.x) + pad;
    const y0 = Math.min(s.a.y, s.b.y) - pad, y1 = Math.max(s.a.y, s.b.y) + pad;
    const list = s.erase ? this.erases : this.adds;
    for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y0], [x1, y1], [x0, y1]]) {
      list.push(x, y, s.a.x, s.a.y, s.b.x, s.b.y, s.w0, s.w1, ...s.c0, ...s.c1, s.i0, s.i1, s.cap ? 1 : 0);
    }
  }
  // 流体に力を加える（point: 0..1 の uv、force: 流体テクセル/秒）
  splat(point, force) { this.splats.push({ point, force }); }

  drawSegments(list, erase) {
    if (!list.length) return;
    const gl = this.gl;
    gl.useProgram(this.P.seg.p);
    gl.uniform2f(this.P.seg.u.res, this.w, this.h);
    gl.uniform1f(this.P.seg.u.erase, erase ? 1 : 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.ink.r.f);
    gl.viewport(0, 0, this.w, this.h);
    gl.enable(gl.BLEND);
    if (erase) gl.blendFuncSeparate(gl.ZERO, gl.ONE_MINUS_SRC_ALPHA, gl.ZERO, gl.ONE_MINUS_SRC_ALPHA);
    else gl.blendFunc(gl.ONE, gl.ONE);   // 加算合成
    gl.bindVertexArray(this.segVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(list), gl.DYNAMIC_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, list.length / FLOATS_PER_VERT);
    gl.disable(gl.BLEND);
    list.length = 0;
  }

  fluidStep(dt, p) {
    const vt = [1 / this.fw, 1 / this.fh], aspect = this.w / this.h;
    for (const s of this.splats) {
      this.run(this.P.velSplat, this.vel.w, { src: this.vel.r, point: s.point, force: s.force, radius: 0.0025, aspect });
      this.vel.swap();
    }
    this.splats.length = 0;
    this.run(this.P.advect, this.vel.w, { vel: this.vel.r, src: this.vel.r, vtexel: vt, dt, dissipation: Math.exp(-dt * 0.8) });
    this.vel.swap();
    this.run(this.P.divergence, this.dv, { vel: this.vel.r, texel: vt });
    this.run(this.P.scale, this.prs.w, { src: this.prs.r, k: 0.8 });
    this.prs.swap();
    for (let i = 0; i < 20; i++) {
      this.run(this.P.pressure, this.prs.w, { prs: this.prs.r, dv: this.dv, texel: vt });
      this.prs.swap();
    }
    this.run(this.P.gradient, this.vel.w, { prs: this.prs.r, vel: this.vel.r, texel: vt });
    this.vel.swap();
  }

  // p: { life(秒, Infinity 可), flow(0 滲む / 1 ノイズ / 2 流体), flowAmt, spread, bloom }
  frame(dt, p) {
    const gl = this.gl;
    this.time += dt;
    gl.disable(gl.BLEND);
    if (p.flow === 2) this.fluidStep(dt, p); else this.splats.length = 0;

    // 寿命 life 秒で明るさがおよそ 1/30 になる減衰
    const decay = Number.isFinite(p.life) ? Math.exp(-dt * Math.log(30) / p.life) : 1;
    const eps = Number.isFinite(p.life) ? (this.hdr ? 0.0004 : 1.5 / 255) : 0;
    this.run(this.P.inkAdvect, this.ink.w, {
      ink: this.ink.r, vel: this.vel.r, texel: [1 / this.w, 1 / this.h], vtexel: [1 / this.fw, 1 / this.fh],
      decay, eps, spread: Math.min(1, p.spread * dt * 20), flowAmt: p.flowAmt, time: this.time, mode: p.flow, dt, aspect: this.w / this.h,
    });
    this.ink.swap();

    this.drawSegments(this.erases, true);
    this.drawSegments(this.adds, false);

    // ブルーム：縮小しながらぼかした像を 3 段重ねる
    let src = this.ink.r;
    for (const lv of this.bl) {
      this.run(this.P.down, lv.r, { src, texel: [1 / src.w, 1 / src.h] });
      this.run(this.P.blur, lv.w, { src: lv.r, dir: [1 / lv.r.w, 0] });
      this.run(this.P.blur, lv.r, { src: lv.w, dir: [0, 1 / lv.r.h] });
      src = lv.r;
    }
    this.run(this.P.composite, null, { ink: this.ink.r, b1: this.bl[0].r, b2: this.bl[1].r, b3: this.bl[2].r, bloom: p.bloom });
  }
}
