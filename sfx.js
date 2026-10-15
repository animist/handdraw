// 効果音（Web Audio）
// 空中で描くと手応えがないので、描き始め／終わりのクリック音と、描画中の音で補う。

const PENTA = [0, 2, 4, 7, 9];

export class Sfx {
  constructor() { this.ctx = null; this.mode = "full"; this.volume = 0.6; this.scale = true; }

  // ブラウザの自動再生制限のため、ユーザー操作（ボタン押下）の中で呼ぶ
  init() {
    if (this.ctx) return;
    try {
      const c = (this.ctx = new AudioContext());
      this.master = c.createGain(); this.master.connect(c.destination);
      // 描画音：三角波 → ローパス
      this.osc = c.createOscillator(); this.osc.type = "triangle";
      this.filt = c.createBiquadFilter(); this.filt.type = "lowpass"; this.filt.frequency.value = 1500;
      this.vg = c.createGain(); this.vg.gain.value = 0;
      this.osc.connect(this.filt).connect(this.vg).connect(this.master); this.osc.start();
      // 消しゴム音：ノイズ → バンドパス（「シャッ」という擦れる音）
      const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      this.noise = c.createBufferSource(); this.noise.buffer = buf; this.noise.loop = true;
      this.nf = c.createBiquadFilter(); this.nf.type = "bandpass"; this.nf.frequency.value = 2200; this.nf.Q.value = 0.7;
      this.ng = c.createGain(); this.ng.gain.value = 0;
      this.noise.connect(this.nf).connect(this.ng).connect(this.master); this.noise.start();
    } catch (e) { console.warn("audio unavailable", e); this.ctx = null; }
  }

  get on() { return this.ctx && this.mode !== "off"; }

  blip(f0, f1, dur, gain, type = "sine") {
    if (!this.on) return;
    const c = this.ctx, t = c.currentTime;
    const o = c.createOscillator(), e = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    e.gain.setValueAtTime(0, t);
    e.gain.linearRampToValueAtTime(gain * this.volume, t + 0.004);
    e.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(e).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  penDown() { this.blip(1500, 700, 0.07, 0.35); }
  penUp() { this.blip(620, 420, 0.06, 0.18); }
  eraseDown() { this.blip(320, 140, 0.09, 0.3, "triangle"); }
  select() { this.blip(1900, 1900, 0.04, 0.12, "square"); this.blip(2600, 2600, 0.05, 0.08); }

  // s: { drawing, erasing, y (0=上 1=下), speed (0..1), pressure (0..1) }
  update(s) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, full = this.on && this.mode === "full";
    let g = 0, ng = 0;
    if (full && s.drawing) {
      const h = 1 - s.y;  // 画面の上ほど高い音
      let freq;
      if (this.scale) {
        const idx = Math.max(0, Math.min(14, Math.floor(h * 15)));
        freq = 220 * Math.pow(2, (Math.floor(idx / 5) * 12 + PENTA[idx % 5]) / 12);
      } else freq = 220 * Math.pow(2, h * 3);
      this.osc.frequency.setTargetAtTime(freq, t, 0.03);
      this.filt.frequency.setTargetAtTime(600 + 3400 * s.pressure, t, 0.05);
      g = (0.04 + 0.32 * s.speed) * this.volume;
    }
    if (full && s.erasing) ng = 0.25 * s.speed * this.volume;
    this.vg.gain.setTargetAtTime(g, t, 0.04);
    this.ng.gain.setTargetAtTime(ng, t, 0.05);
  }
}
