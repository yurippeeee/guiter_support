'use strict';

// ============================================================
// 状態管理
// ============================================================
const STORAGE_KEY = 'guitar-support-state';

// エフェクトのデフォルト設定
const FX_DEFAULTS = {
  od:     { on: false, drive: 40 },
  chorus: { on: false, depth: 50 },
  delay:  { on: false, time: 320, feedback: 35, mix: 35 },
  reverb: { on: false, mix: 30 },
};

// 部分指定をデフォルトにマージして完全なfx設定を作る
function mergedFx(partial) {
  const out = {};
  for (const k in FX_DEFAULTS) out[k] = Object.assign({}, FX_DEFAULTS[k], (partial || {})[k]);
  return out;
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (s && typeof s.key === 'number' && typeof s.quality === 'string') {
      if (typeof s.tuning !== 'number' || !TUNINGS[s.tuning]) s.tuning = 0;
      s.fx = mergedFx(s.fx);
      s.progression = (Array.isArray(s.progression) ? s.progression : [])
        .filter(p => p && typeof p.degree === 'number' && typeof p.quality === 'string')
        .map(p => ({ ...p, beats: validBeats(p.beats) }));
      if (typeof s.bpm !== 'number') s.bpm = 90;
      s.loop = !!s.loop;
      if (typeof s.pattern !== 'string') s.pattern = 'simple';
      if (!s.scale || typeof s.scale.root !== 'number' || !SCALES.some(x => x.id === s.scale.type)) {
        s.scale = { on: false, root: 9, type: 'minor-penta' };
      }
      s.scale.on = !!s.scale.on;
      if (!s.melody || typeof s.melody !== 'object') s.melody = { on: false, sound: true, notes: [] };
      s.melody.on = !!s.melody.on;
      s.melody.sound = s.melody.sound !== false;
      s.melody.notes = validMelodyNotes(s.melody.notes);
      if (s.melody.timbre !== 'guitar') s.melody.timbre = 'voice';
      s.melody.solo = !!s.melody.solo;
      if (!s.backing || typeof s.backing !== 'object') s.backing = { on: false, notes: [] };
      s.backing.on = !!s.backing.on;
      s.backing.notes = validBackingNotes(s.backing.notes);
      return s;
    }
  } catch (e) { /* 破損時は初期値 */ }
  return null;
}

// 拍数の検証: 0.5拍（8分音符）刻みで0.5〜16拍（境界ドラッグで半端な拍数になれる）
function validBeats(b) {
  return (typeof b === 'number' && b >= 0.5 && b <= 16 && Number.isInteger(b * 2)) ? b : 4;
}

// バッキングノートの検証: { t: 8分位置, dur: 長さ, s: 弦0(6弦)..5(1弦) }
function validBackingNotes(a) {
  return (Array.isArray(a) ? a : []).filter(n =>
    n && Number.isInteger(n.t) && n.t >= 0 &&
    Number.isInteger(n.dur) && n.dur >= 1 &&
    Number.isInteger(n.s) && n.s >= 0 && n.s <= 5
  ).map(n => ({ t: n.t, dur: n.dur, s: n.s }));
}

// メロディーノートの検証: { t: 8分位置, dur: 長さ, d: スケール行0..14 }
function validMelodyNotes(a) {
  return (Array.isArray(a) ? a : []).filter(n =>
    n && Number.isInteger(n.t) && n.t >= 0 &&
    Number.isInteger(n.dur) && n.dur >= 1 &&
    Number.isInteger(n.d) && n.d >= 0 && n.d <= 14
  ).map(n => ({ t: n.t, dur: n.dur, d: n.d }));
}

const state = loadState() || {
  key: 0, capo: 0, degree: 0, quality: '', voicing: 0, tuning: 0,
  fx: mergedFx(null), progression: [], bpm: 90, loop: false, pattern: 'simple',
  scale: { on: false, root: 9, type: 'minor-penta' },
  melody: { on: false, sound: true, notes: [], timbre: 'voice', solo: false },
  backing: { on: false, notes: [] },
};

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ユーザー登録コードの読み書き（chords.jsのUSER_SHAPESを実体として使う）
const USER_SHAPES_KEY = 'guitar-support-user-shapes';

function loadUserShapes() {
  try {
    const a = JSON.parse(localStorage.getItem(USER_SHAPES_KEY));
    if (Array.isArray(a)) {
      for (const s of a) {
        if (s && typeof s.root === 'number' && typeof s.quality === 'string' &&
            Array.isArray(s.frets) && s.frets.length === 6) {
          USER_SHAPES.push(s);
        }
      }
    }
  } catch (e) { /* 破損時は無視 */ }
}

function saveUserShapes() {
  localStorage.setItem(USER_SHAPES_KEY, JSON.stringify(USER_SHAPES));
}

function removeUserShape(id) {
  const i = USER_SHAPES.findIndex(s => s.id === id);
  if (i >= 0) {
    USER_SHAPES.splice(i, 1);
    saveUserShapes();
    update(false);
  }
}

function currentRootPc() {
  return (state.key + DEGREES[state.degree].pc) % 12;
}

function currentVoicings() {
  return getVoicings(currentRootPc(), state.quality);
}

function chordLabel() {
  return DEGREES[state.degree].label + state.quality;
}

// ============================================================
// オーディオ（Karplus-Strong 弦シミュレーション）
// ============================================================
let actx = null;
let master = null;
let fx = null; // エフェクトチェーンのノード群

function audio() {
  if (!actx) {
    actx = new (window.AudioContext || window.webkitAudioContext)();
    master = actx.createGain();
    master.gain.value = 0.5;
    fx = buildFxChain(actx, master);
    applyFx();
  }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}

function makeDriveCurve(k) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(k * x);
  }
  return curve;
}

function makeImpulse(c, seconds, decay) {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

// master → オーバードライブ → コーラス → ディレイ → リバーブ → トーン/リミッター → 出力
function buildFxChain(c, input) {
  const n = {};

  // オーバードライブ（tanhソフトクリップ）
  n.odDry = c.createGain();
  n.odWet = c.createGain();
  n.odPre = c.createGain();
  n.odPost = c.createGain();
  n.shaper = c.createWaveShaper();
  n.shaper.oversample = '4x';
  n.shaper.curve = makeDriveCurve(1);
  const odOut = c.createGain();
  input.connect(n.odDry); n.odDry.connect(odOut);
  input.connect(n.odPre); n.odPre.connect(n.shaper);
  n.shaper.connect(n.odPost); n.odPost.connect(n.odWet); n.odWet.connect(odOut);

  // コーラス（LFOで揺らした短いディレイを混ぜる）
  n.chWet = c.createGain();
  n.chDry = c.createGain();
  n.chDelay = c.createDelay(0.06);
  n.chDelay.delayTime.value = 0.018;
  n.lfoGain = c.createGain();
  n.lfoGain.gain.value = 0.004;
  const lfo = c.createOscillator();
  lfo.frequency.value = 0.8;
  lfo.connect(n.lfoGain); n.lfoGain.connect(n.chDelay.delayTime);
  lfo.start();
  const chOut = c.createGain();
  odOut.connect(n.chDry); n.chDry.connect(chOut);
  odOut.connect(n.chDelay); n.chDelay.connect(n.chWet); n.chWet.connect(chOut);

  // ディレイ（フィードバックループ付き）
  n.dlDry = c.createGain();
  n.dlWet = c.createGain();
  n.delay = c.createDelay(1.2);
  n.fb = c.createGain();
  n.fb.gain.value = 0;
  const dlOut = c.createGain();
  chOut.connect(n.dlDry); n.dlDry.connect(dlOut);
  chOut.connect(n.delay); n.delay.connect(n.dlWet); n.dlWet.connect(dlOut);
  n.delay.connect(n.fb); n.fb.connect(n.delay);

  // リバーブ（生成したインパルス応答のコンボルバー）
  n.rvDry = c.createGain();
  n.rvWet = c.createGain();
  n.conv = c.createConvolver();
  n.conv.buffer = makeImpulse(c, 2.2, 2.8);
  const rvOut = c.createGain();
  dlOut.connect(n.rvDry); n.rvDry.connect(rvOut);
  dlOut.connect(n.conv); n.conv.connect(n.rvWet); n.rvWet.connect(rvOut);

  // トーン調整 + リミッター
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 5200;
  const comp = c.createDynamicsCompressor();
  rvOut.connect(lp); lp.connect(comp); comp.connect(c.destination);

  return n;
}

function applyFx() {
  if (!fx) return;
  const f = state.fx;
  const t = actx.currentTime;
  const set = (param, v) => param.setTargetAtTime(v, t, 0.02);

  const k = 1 + f.od.drive * 0.25;
  fx.shaper.curve = makeDriveCurve(k);
  set(fx.odPost.gain, 0.8 / Math.tanh(Math.min(3, k * 0.6)));
  set(fx.odDry.gain, f.od.on ? 0 : 1);
  set(fx.odWet.gain, f.od.on ? 1 : 0);

  set(fx.lfoGain.gain, 0.002 + (f.chorus.depth / 100) * 0.004);
  set(fx.chDry.gain, 1);
  set(fx.chWet.gain, f.chorus.on ? 0.35 + (f.chorus.depth / 100) * 0.3 : 0);

  set(fx.delay.delayTime, f.delay.time / 1000);
  set(fx.fb.gain, f.delay.on ? Math.min(0.85, f.delay.feedback / 100) : 0);
  set(fx.dlDry.gain, 1);
  set(fx.dlWet.gain, f.delay.on ? (f.delay.mix / 100) * 0.9 : 0);

  set(fx.rvDry.gain, 1);
  set(fx.rvWet.gain, f.reverb.on ? (f.reverb.mix / 100) * 0.9 : 0);
}

function pluck(midi, when, vol = 0.9) {
  const c = audio();
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const dur = 2.8;
  const sr = c.sampleRate;
  const N = Math.max(2, Math.round(sr / freq));
  const buf = c.createBuffer(1, Math.floor(sr * dur), sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < N; i++) d[i] = Math.random() * 2 - 1;
  for (let i = N; i < d.length; i++) d[i] = (d[i - N] + d[i - N + 1]) * 0.4985;
  const src = c.createBufferSource();
  src.buffer = buf;
  const g = c.createGain();
  g.gain.value = vol;
  src.connect(g);
  g.connect(master);
  src.start(when);
  return src;
}

// 実音 = 開放弦MIDI + チューニング + カポ + カポからの相対フレット
function stringMidi(stringIdx, relFret) {
  return OPEN_MIDI[stringIdx] + TUNINGS[state.tuning].offset + state.capo + relFret;
}

// 声っぽい持続音（フォルマント合成＋ビブラート）。メロディー用
function sing(midi, when, durSec, vol = 2.6) {
  const c = audio();
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.value = freq;
  // 少し遅れてかかるビブラート
  const vib = c.createOscillator();
  vib.frequency.value = 5.2;
  const vibGain = c.createGain();
  vibGain.gain.setValueAtTime(0, when);
  vibGain.gain.linearRampToValueAtTime(freq * 0.012, when + 0.25);
  vib.connect(vibGain);
  vibGain.connect(osc.frequency);
  // エンベロープ（アタック・サステイン・リリース）
  const env = c.createGain();
  env.gain.setValueAtTime(0, when);
  env.gain.linearRampToValueAtTime(vol, when + 0.05);
  env.gain.setValueAtTime(vol, when + Math.max(0.05, durSec - 0.08));
  env.gain.linearRampToValueAtTime(0, when + durSec);
  // 母音「アー」のフォルマント
  const formants = [[700, 8, 1.0], [1100, 10, 0.45], [2500, 12, 0.3]];
  for (const [f, q, g] of formants) {
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f;
    bp.Q.value = q;
    const fg = c.createGain();
    fg.gain.value = g;
    osc.connect(bp);
    bp.connect(fg);
    fg.connect(env);
  }
  env.connect(master);
  osc.start(when);
  vib.start(when);
  osc.stop(when + durSec + 0.05);
  vib.stop(when + durSec + 0.05);
  return [osc, vib];
}

// 指定時刻にストローク。down=低音弦から全弦、up=高音側4本を逆順で軽く
function strumAt(v, when, { gap = 0.045, dir = 'down', vol = 0.85 } = {}) {
  const sounded = [];
  for (let i = 0; i < 6; i++) if (v.frets[i] >= 0) sounded.push(i);
  const order = dir === 'down' ? sounded : sounded.slice(-4).reverse();
  const sources = [];
  let t = when;
  for (const i of order) {
    sources.push(pluck(stringMidi(i, v.frets[i]), t, vol));
    t += gap;
  }
  return sources;
}

function playVoicing(v, gap) {
  strumAt(v, audio().currentTime + 0.05, { gap });
}

function playString(v, i) {
  if (v.frets[i] >= 0) pluck(stringMidi(i, v.frets[i]), audio().currentTime + 0.02, 0.9);
}

// ============================================================
// メインフレットボード描画（横向きSVG、1弦が上）
// ============================================================
const NUT_X = 46;
const STRING_TOP = 34;
const STRING_GAP = 27;
const BOARD_H = STRING_TOP + STRING_GAP * 5 + 44;

function fretX(f, scale) {
  return NUT_X + scale * (1 - Math.pow(2, -f / 12));
}

function renderBoard(v) {
  const capo = state.capo;
  let maxAbs = capo + 3;
  if (v) {
    const played = v.frets.filter(f => f >= 0);
    if (played.length) maxAbs = Math.max(maxAbs, capo + Math.max(...played));
  }
  const total = Math.max(12, maxAbs + 2);
  const scale = 118 * total; // フレットが進むほど間隔が狭くなる実寸風スケール
  const W = fretX(total, scale) + 24;

  const yOf = i => STRING_TOP + (5 - i) * STRING_GAP; // i=0が6弦(下)
  const fretCenter = f => (fretX(f - 1, scale) + fretX(f, scale)) / 2;

  let s = `<svg id="board" width="${W}" height="${BOARD_H}" viewBox="0 0 ${W} ${BOARD_H}" xmlns="http://www.w3.org/2000/svg">`;

  // 指板
  s += `<rect x="${NUT_X}" y="${STRING_TOP - 14}" width="${fretX(total, scale) - NUT_X}" height="${STRING_GAP * 5 + 28}" rx="4" fill="#3b2a20"/>`;
  // ナット
  s += `<rect x="${NUT_X - 7}" y="${STRING_TOP - 14}" width="7" height="${STRING_GAP * 5 + 28}" fill="#d8cfa8" rx="2"/>`;

  // フレット線とポジションマーク
  for (let f = 1; f <= total; f++) {
    const x = fretX(f, scale);
    s += `<line x1="${x}" y1="${STRING_TOP - 14}" x2="${x}" y2="${STRING_TOP + STRING_GAP * 5 + 14}" stroke="#8a8378" stroke-width="2.4"/>`;
    const cy = STRING_TOP + STRING_GAP * 2.5;
    if ([3, 5, 7, 9, 15, 17, 19, 21].includes(f)) {
      s += `<circle cx="${fretCenter(f)}" cy="${cy}" r="5.5" fill="#5c4736"/>`;
    } else if (f === 12) {
      s += `<circle cx="${fretCenter(f)}" cy="${cy - STRING_GAP * 1.5}" r="5.5" fill="#5c4736"/>`;
      s += `<circle cx="${fretCenter(f)}" cy="${cy + STRING_GAP * 1.5}" r="5.5" fill="#5c4736"/>`;
    }
    if ([3, 5, 7, 9, 12, 15, 17, 19, 21].includes(f)) {
      s += `<text x="${fretCenter(f)}" y="${BOARD_H - 8}" text-anchor="middle" class="fret-num">${f}</text>`;
    }
  }

  // 弦
  for (let i = 0; i < 6; i++) {
    const w = 3.0 - i * 0.42;
    s += `<line x1="${NUT_X - 7}" y1="${yOf(i)}" x2="${fretX(total, scale)}" y2="${yOf(i)}" stroke="#c9c2b4" stroke-width="${Math.max(0.8, w)}"/>`;
  }

  // カポ
  if (capo > 0) {
    const x = fretX(capo, scale) - 13;
    s += `<rect x="${x}" y="${STRING_TOP - 22}" width="13" height="${STRING_GAP * 5 + 44}" rx="6" fill="#2f3d55" stroke="#5b779f" stroke-width="1.5"/>`;
    s += `<text x="${x + 6.5}" y="${STRING_TOP - 27}" text-anchor="middle" class="capo-label">カポ</text>`;
  }

  if (v) {
    // バレー
    if (v.barre) {
      const F = capo + v.barre.fret;
      const cx = fretCenter(F);
      const y1 = yOf(5) - 11;
      const y2 = yOf(v.barre.from) + 11;
      s += `<rect x="${cx - 8}" y="${y1}" width="16" height="${y2 - y1}" rx="8" fill="#e2a44a" opacity="0.92"/>`;
    }
    // 各弦のマーク
    for (let i = 0; i < 6; i++) {
      const f = v.frets[i];
      const y = yOf(i);
      if (f < 0) {
        s += `<text x="${NUT_X - 26}" y="${y + 5}" text-anchor="middle" class="mute-mark">✕</text>`;
      } else if (f === 0) {
        if (capo === 0) {
          s += `<circle cx="${NUT_X - 24}" cy="${y}" r="7" fill="none" stroke="#7ec8a3" stroke-width="2.2"/>`;
        }
        // カポあり時の開放はカポが押さえるのでマーク不要
      } else {
        const F = capo + f;
        const covered = v.barre && f === v.barre.fret && i >= v.barre.from;
        if (!covered) {
          s += `<circle cx="${fretCenter(F)}" cy="${y}" r="9.5" fill="#e2a44a"/>`;
        }
      }
    }
    // クリックで単弦再生する透明レイヤー
    for (let i = 0; i < 6; i++) {
      s += `<rect class="string-hit" data-string="${i}" x="0" y="${yOf(i) - STRING_GAP / 2}" width="${W}" height="${STRING_GAP}" fill="transparent"/>`;
    }
  }

  s += '</svg>';

  const wrap = document.getElementById('board-wrap');
  wrap.innerHTML = s;
  wrap.querySelectorAll('.string-hit').forEach(el => {
    el.addEventListener('click', () => playString(v, Number(el.dataset.string)));
  });
}

// ============================================================
// ミニダイアグラム（縦型コード表）
// ============================================================
function miniDiagram(v) {
  const W = 100, TOP = 26, LEFT = 22, SGAP = 12.4, FGAP = 19;
  const played = v.frets.filter(f => f > 0);
  const maxF = played.length ? Math.max(...played) : 0;
  const minF = played.length ? Math.min(...played) : 0;
  const start = maxF <= 4 ? 0 : minF - 1; // startフレットの次から表示
  const rows = Math.max(4, maxF - start);
  const H = TOP + rows * FGAP + 10;
  const xOf = i => LEFT + i * SGAP; // i=0が6弦(左)

  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;

  // フレット横線
  for (let r = 0; r <= rows; r++) {
    const y = TOP + r * FGAP;
    s += `<line x1="${xOf(0)}" y1="${y}" x2="${xOf(5)}" y2="${y}" stroke="var(--diagram-line)" stroke-width="1"/>`;
  }
  if (start === 0) {
    s += `<rect x="${xOf(0) - 1}" y="${TOP - 3.5}" width="${xOf(5) - xOf(0) + 2}" height="3.5" fill="var(--diagram-line)"/>`;
  } else {
    s += `<text x="${xOf(0) - 5}" y="${TOP + FGAP * 0.66}" text-anchor="end" class="mini-frnum">${start + 1}</text>`;
  }
  // 縦線（弦）
  for (let i = 0; i < 6; i++) {
    s += `<line x1="${xOf(i)}" y1="${TOP}" x2="${xOf(i)}" y2="${TOP + rows * FGAP}" stroke="var(--diagram-line)" stroke-width="1"/>`;
  }
  // バレー
  if (v.barre && v.barre.fret > start) {
    const y = TOP + (v.barre.fret - start - 0.5) * FGAP;
    s += `<rect x="${xOf(v.barre.from) - 4.5}" y="${y - 4.5}" width="${xOf(5) - xOf(v.barre.from) + 9}" height="9" rx="4.5" fill="#e2a44a"/>`;
  }
  // マーク
  for (let i = 0; i < 6; i++) {
    const f = v.frets[i];
    const x = xOf(i);
    if (f < 0) {
      s += `<text x="${x}" y="${TOP - 8}" text-anchor="middle" class="mini-open">✕</text>`;
    } else if (f === 0) {
      s += `<circle cx="${x}" cy="${TOP - 11}" r="3.6" fill="none" stroke="#7ec8a3" stroke-width="1.6"/>`;
    } else {
      const covered = v.barre && f === v.barre.fret;
      if (!covered) {
        s += `<circle cx="${x}" cy="${TOP + (f - start - 0.5) * FGAP}" r="5" fill="#e2a44a"/>`;
      }
    }
  }
  s += '</svg>';
  return s;
}

// ============================================================
// UI描画
// ============================================================
function el(id) { return document.getElementById(id); }

function renderHeader() {
  const keySel = el('key-select');
  const capoSel = el('capo-select');
  const tuneSel = el('tuning-select');
  if (!keySel.options.length) {
    KEY_NAMES.forEach((n, i) => keySel.add(new Option(n, i)));
    for (let c = 0; c <= 8; c++) capoSel.add(new Option(c === 0 ? 'なし' : `${c}フレット`, c));
    TUNINGS.forEach((t, i) => tuneSel.add(new Option(t.label, i)));
  }
  keySel.value = state.key;
  capoSel.value = state.capo;
  tuneSel.value = state.tuning;
  const soundingPc = ((state.key + state.capo + TUNINGS[state.tuning].offset) % 12 + 12) % 12;
  el('sounding-key').textContent = `実音キー: ${KEY_NAMES[soundingPc]}`;
}

function renderDegrees() {
  const box = el('degrees');
  box.innerHTML = '';
  DEGREES.forEach((d, i) => {
    const btn = document.createElement('button');
    const diatonic = d.pc in DIATONIC_QUALITY;
    btn.className = 'degree-btn' + (diatonic ? ' diatonic' : '') + (i === state.degree ? ' active' : '');
    btn.textContent = diatonic ? d.label + DIATONIC_QUALITY[d.pc] : d.label;
    btn.addEventListener('click', () => {
      state.degree = i;
      state.quality = DIATONIC_QUALITY[d.pc] !== undefined ? DIATONIC_QUALITY[d.pc] : '';
      state.voicing = 0;
      update(true);
    });
    box.appendChild(btn);
  });
}

function renderQualities() {
  const box = el('qualities');
  box.innerHTML = '';
  // ユーザー登録コードにしかないクオリティ（汎用ネーミング産）もボタンとして出す
  const extra = [...new Set(USER_SHAPES.map(s => s.quality))].filter(q => !QUALITIES.includes(q));
  [...QUALITIES, ...extra].forEach(q => {
    const btn = document.createElement('button');
    btn.className = 'quality-btn' + (q === state.quality ? ' active' : '');
    btn.textContent = QUALITY_LABELS[q] || q;
    btn.addEventListener('click', () => {
      state.quality = q;
      state.voicing = 0;
      update(true);
    });
    box.appendChild(btn);
  });
}

function renderVoicings(voicings) {
  const box = el('voicings');
  box.innerHTML = '';
  if (!voicings.length) {
    box.innerHTML = '<p class="empty">このコードの押さえ方は未登録です</p>';
    return;
  }
  voicings.forEach((v, i) => {
    const card = document.createElement('div');
    card.className = 'voicing-card' + (i === state.voicing ? ' active' : '') + (v.user ? ' user' : '');
    card.innerHTML = miniDiagram(v) + `<div class="voicing-name">${v.name}</div>`;
    if (v.user) {
      const del = document.createElement('button');
      del.className = 'del-btn';
      del.textContent = '✕';
      del.title = '登録を削除';
      del.addEventListener('click', e => {
        e.stopPropagation();
        removeUserShape(v.id);
      });
      card.appendChild(del);
    }
    card.addEventListener('click', () => {
      state.voicing = i;
      update(false);
      playVoicing(v, 0.045);
    });
    box.appendChild(card);
  });
}

function update(playSound) {
  if (state.voicing >= currentVoicings().length) state.voicing = 0;
  const voicings = currentVoicings();
  const v = voicings[state.voicing] || null;

  renderHeader();
  renderDegrees();
  renderQualities();
  el('chord-name').textContent = chordLabel();
  el('voicing-label').textContent = v ? v.name : '';
  renderBoard(v);
  renderVoicings(voicings);
  renderProgression();
  renderScaleBoard(); // 進行再生中はここでコードトーン強調が切り替わる
  renderMelody();
  renderBacking();
  renderEditor();   // カポ表示・絶対フレット番号を追従させる
  renderAnalysis(); // キーが変わるとディグリー表記も変わるので解析結果も更新
  saveState();
  if (playSound && v) playVoicing(v, 0.045);
}

// ============================================================
// コード進行プレイヤー
// ============================================================
let progPlaying = false;
let progPos = -1;
let progTimers = [];
let progSources = []; // スケジュール済みの発音（停止時にキャンセルする）

// ストロークパターン（t=拍オフセット、4拍を1単位として繰り返す）
const STRUM_PATTERNS = [
  { id: 'simple', name: 'シンプル（1・3拍）', events: [
    { t: 0, dir: 'down', vol: 0.85 }, { t: 2, dir: 'down', vol: 0.6 },
  ] },
  { id: 'whole', name: '1回だけ', events: [
    { t: 0, dir: 'down', vol: 0.85 },
  ] },
  { id: 'four', name: '4つ打ち', events: [
    { t: 0, dir: 'down', vol: 0.85 }, { t: 1, dir: 'down', vol: 0.55 },
    { t: 2, dir: 'down', vol: 0.7 },  { t: 3, dir: 'down', vol: 0.55 },
  ] },
  { id: 'eight', name: '8ビート', events: [
    { t: 0, dir: 'down', vol: 0.85 }, { t: 1, dir: 'down', vol: 0.55 },
    { t: 1.5, dir: 'up', vol: 0.4 },  { t: 2.5, dir: 'up', vol: 0.4 },
    { t: 3, dir: 'down', vol: 0.6 },  { t: 3.5, dir: 'up', vol: 0.4 },
  ] },
  { id: 'arp', name: 'アルペジオ', arpeggio: true },
  { id: 'custom', name: 'ピアノロール（バッキング）', custom: true },
];

function scheduleChordPattern(v, beats, beatSec) {
  const pat = STRUM_PATTERNS.find(p => p.id === state.pattern) || STRUM_PATTERNS[0];
  const base = audio().currentTime + 0.05;
  if (pat.custom) return; // バッキング・ピアノロールは progStep 側でスケジュールする
  if (pat.arpeggio) {
    const sounded = [];
    for (let i = 0; i < 6; i++) if (v.frets[i] >= 0) sounded.push(i);
    if (!sounded.length) return;
    const steps = Math.round(beats * 2); // 8分音符で低音弦から順に爪弾く
    for (let k = 0; k < steps; k++) {
      const i = sounded[k % sounded.length];
      progSources.push(pluck(stringMidi(i, v.frets[i]), base + (k * beatSec) / 2, 0.8));
    }
  } else {
    for (let rep = 0; rep < beats; rep += 4) {
      const remain = beats - rep;
      for (const ev of pat.events) {
        if (ev.t >= remain) continue;
        progSources.push(...strumAt(v, base + (rep + ev.t) * beatSec, {
          dir: ev.dir, vol: ev.vol, gap: ev.dir === 'down' ? 0.02 : 0.014,
        }));
      }
    }
  }
}

function progLabel(p) {
  return DEGREES[p.degree].label + p.quality;
}

function stopProgression() {
  progTimers.forEach(clearTimeout);
  progTimers = [];
  progSources.forEach(s => { try { s.stop(); } catch (e) { /* 停止済みは無視 */ } });
  progSources = [];
  progPlaying = false;
  progPos = -1;
  el('btn-prog-play').textContent = '▶ 再生';
  if (playheadTimer) { clearInterval(playheadTimer); playheadTimer = null; }
  for (const id of ['melody-playhead', 'backing-playhead']) {
    const ph = document.getElementById(id);
    if (ph) ph.setAttribute('visibility', 'hidden');
  }
  renderProgression();
}

function startProgression() {
  if (!state.progression.length) return;
  stopProgression();
  progPlaying = true;
  el('btn-prog-play').textContent = '■ 停止';
  progStep(0);
  playheadTimer = setInterval(updateMelodyPlayhead, 40);
}

function progStep(pos) {
  const item = state.progression[pos];
  if (!item) { stopProgression(); return; }
  progPos = pos;
  // 表示を再生中のコードに追従させる
  state.degree = item.degree;
  state.quality = item.quality;
  state.voicing = item.voicing || 0;
  update(false);
  const vs = currentVoicings();
  const v = vs[state.voicing] || vs[0];
  const beatSec = 60 / state.bpm;
  const beats = item.beats || 4;
  if (!state.melody.solo) { // ボーカルのみモード時はバッキングを消音
    if (state.pattern === 'custom') scheduleBackingForStep(pos, beatSec);
    else if (v) scheduleChordPattern(v, beats, beatSec);
  }
  progClock = { pos, startTime: audio().currentTime + 0.05, beatSec };
  if (state.melody.sound) scheduleMelodyForStep(pos, beatSec);
  progTimers.push(setTimeout(() => {
    let next = pos + 1;
    if (next >= state.progression.length) {
      if (state.loop) next = 0;
      else { stopProgression(); return; }
    }
    progStep(next);
  }, beats * beatSec * 1000));
}

function renderProgression() {
  const box = el('prog-list');
  box.innerHTML = '';
  if (!state.progression.length) {
    box.innerHTML = '<span class="empty">コードを選んで「＋ 今のコードを追加」で進行を作れます</span>';
    return;
  }
  state.progression.forEach((p, i) => {
    const chip = document.createElement('div');
    chip.className = 'prog-chip' + (i === progPos && progPlaying ? ' playing' : '');
    const label = document.createElement('span');
    label.textContent = `${i + 1}. ${progLabel(p)}`;
    chip.appendChild(label);
    const beatsBtn = document.createElement('button');
    beatsBtn.className = 'chip-beats';
    beatsBtn.textContent = `${p.beats || 4}拍`;
    beatsBtn.title = 'クリックで拍数を変更（1→2→4→8）';
    beatsBtn.addEventListener('click', e => {
      e.stopPropagation();
      const cyc = [1, 2, 4, 8];
      p.beats = cyc[(cyc.indexOf(p.beats || 4) + 1) % cyc.length];
      update(false);
    });
    chip.appendChild(beatsBtn);
    const del = document.createElement('button');
    del.className = 'chip-del';
    del.textContent = '✕';
    del.title = '進行から削除';
    del.addEventListener('click', e => {
      e.stopPropagation();
      state.progression.splice(i, 1);
      if (!state.progression.length) stopProgression();
      update(false);
    });
    chip.appendChild(del);
    chip.addEventListener('click', () => {
      state.degree = p.degree;
      state.quality = p.quality;
      state.voicing = p.voicing || 0;
      update(true);
    });
    box.appendChild(chip);
  });
}

// ============================================================
// 進行の複数保存（名前付き）
// ============================================================
const PROGS_KEY = 'guitar-support-progressions';
let savedProgs = [];

function loadSavedProgs() {
  try {
    const a = JSON.parse(localStorage.getItem(PROGS_KEY));
    if (Array.isArray(a)) {
      savedProgs = a.filter(p => p && typeof p.name === 'string' && Array.isArray(p.items));
    }
  } catch (e) { /* 破損時は無視 */ }
}

function persistSavedProgs() {
  localStorage.setItem(PROGS_KEY, JSON.stringify(savedProgs));
}

function saveCurrentProgression() {
  if (!state.progression.length) return;
  const name = el('prog-name').value.trim() || `進行${savedProgs.length + 1}`;
  const data = {
    id: Date.now(),
    name,
    items: JSON.parse(JSON.stringify(state.progression)),
    bpm: state.bpm,
    pattern: state.pattern,
    melody: JSON.parse(JSON.stringify(state.melody.notes)),
    backing: JSON.parse(JSON.stringify(state.backing.notes)),
  };
  const i = savedProgs.findIndex(p => p.name === name);
  if (i >= 0) savedProgs[i] = data; // 同名は上書き
  else savedProgs.push(data);
  persistSavedProgs();
  el('prog-name').value = '';
  renderSavedProgs();
}

function loadProgression(p) {
  stopProgression();
  state.progression = JSON.parse(JSON.stringify(p.items));
  state.melody.notes = validMelodyNotes(p.melody);
  state.backing.notes = validBackingNotes(p.backing);
  if (typeof p.bpm === 'number') state.bpm = p.bpm;
  if (typeof p.pattern === 'string' && STRUM_PATTERNS.some(x => x.id === p.pattern)) state.pattern = p.pattern;
  el('prog-bpm').value = state.bpm;
  el('prog-pattern').value = state.pattern;
  update(false);
}

function renderSavedProgs() {
  const box = el('saved-progs');
  box.innerHTML = '';
  if (!savedProgs.length) {
    box.innerHTML = '<span class="empty">保存した進行はまだありません</span>';
    return;
  }
  savedProgs.forEach(p => {
    const chip = document.createElement('div');
    chip.className = 'prog-chip saved';
    const label = document.createElement('span');
    label.textContent = `${p.name}（${p.items.length}コード）`;
    chip.appendChild(label);
    const del = document.createElement('button');
    del.className = 'chip-del';
    del.textContent = '✕';
    del.title = '保存した進行を削除';
    del.addEventListener('click', e => {
      e.stopPropagation();
      savedProgs = savedProgs.filter(x => x.id !== p.id);
      persistSavedProgs();
      renderSavedProgs();
    });
    chip.appendChild(del);
    chip.addEventListener('click', () => loadProgression(p));
    box.appendChild(chip);
  });
}

// ============================================================
// ソロ練習: スケールボード
// ============================================================
const SB = { nut: 46, fw: 50, top: 26, gap: 26, frets: 15 };

function renderScaleBoard() {
  const wrap = el('scale-wrap');
  if (!state.scale.on) {
    wrap.innerHTML = '';
    return;
  }
  const capo = state.capo;
  const W = SB.nut + SB.fw * SB.frets + 12;
  const H = SB.top + SB.gap * 5 + 34;
  const yOf = i => SB.top + (5 - i) * SB.gap;
  const xOf = f => SB.nut + f * SB.fw;

  // スケール音（カポ相対のピッチクラス）
  const scaleRootPc = (state.key + state.scale.root) % 12;
  const scaleDef = SCALES.find(x => x.id === state.scale.type) || SCALES[0];
  const scalePcs = new Set(scaleDef.intervals.map(i => (scaleRootPc + i) % 12));

  // 今のコードの構成音。表に無いクオリティ（登録コードの汎用ネーミング等）は
  // 選択中ボイシングが実際に鳴らす音から拾う
  const chordFormula = CHORD_INTERVALS[state.quality];
  let chordPcs;
  if (chordFormula) {
    chordPcs = new Set(chordFormula.map(i => (currentRootPc() + i) % 12));
  } else {
    chordPcs = new Set();
    const vs = currentVoicings();
    const v = vs[state.voicing] || vs[0];
    if (v) {
      for (let i = 0; i < 6; i++) {
        if (v.frets[i] >= 0) chordPcs.add((OPEN_MIDI[i] + v.frets[i]) % 12);
      }
    }
  }

  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  s += `<rect x="${SB.nut}" y="${SB.top - 13}" width="${SB.fw * SB.frets}" height="${SB.gap * 5 + 26}" rx="4" fill="#33261d"/>`;
  if (capo > 0) {
    s += `<rect x="${SB.nut - 11}" y="${SB.top - 17}" width="11" height="${SB.gap * 5 + 34}" rx="5" fill="#2f3d55" stroke="#5b779f" stroke-width="1.5"/>`;
    s += `<text x="${SB.nut - 5}" y="${H - 8}" text-anchor="middle" class="capo-label">カポ${capo}</text>`;
  } else {
    s += `<rect x="${SB.nut - 6}" y="${SB.top - 13}" width="6" height="${SB.gap * 5 + 26}" fill="#d8cfa8" rx="2"/>`;
  }
  for (let f = 1; f <= SB.frets; f++) {
    s += `<line x1="${xOf(f)}" y1="${SB.top - 13}" x2="${xOf(f)}" y2="${SB.top + SB.gap * 5 + 13}" stroke="#7c7568" stroke-width="2"/>`;
    if ([3, 5, 7, 9, 12, 15, 17, 19].includes(capo + f)) {
      s += `<text x="${xOf(f) - SB.fw / 2}" y="${H - 8}" text-anchor="middle" class="fret-num">${capo + f}</text>`;
    }
  }
  for (let i = 0; i < 6; i++) {
    s += `<line x1="${SB.nut - 6}" y1="${yOf(i)}" x2="${xOf(SB.frets)}" y2="${yOf(i)}" stroke="#c9c2b4" stroke-width="${Math.max(0.8, 2.8 - i * 0.4)}"/>`;
  }

  // 音の配置（0=開放/カポ位置も含む）
  for (let i = 0; i < 6; i++) {
    for (let f = 0; f <= SB.frets; f++) {
      const pc = (OPEN_MIDI[i] + f) % 12;
      const inScale = scalePcs.has(pc);
      const inChord = chordPcs.has(pc);
      if (!inScale && !inChord) continue;
      const cx = f === 0 ? SB.nut - 24 : xOf(f) - SB.fw / 2;
      const cy = yOf(i);
      const interval = (pc - scaleRootPc + 12) % 12;
      let cls, fill;
      if (interval === 0) { cls = 'sc-root'; fill = 'var(--accent)'; }
      else if (inChord)   { cls = 'sc-chord'; fill = 'var(--accent-2)'; }
      else                { cls = 'sc-note'; fill = '#565e6e'; }
      s += `<g class="sc-dot ${cls}" data-s="${i}" data-f="${f}">`;
      s += `<circle cx="${cx}" cy="${cy}" r="10" fill="${fill}"/>`;
      s += `<text x="${cx}" y="${cy + 3.5}" text-anchor="middle" class="sc-label">${INTERVAL_LABELS[interval]}</text>`;
      s += `</g>`;
    }
  }
  s += '</svg>';

  wrap.innerHTML = s;
  wrap.querySelectorAll('.sc-dot').forEach(g => {
    g.addEventListener('click', () => {
      pluck(stringMidi(Number(g.dataset.s), Number(g.dataset.f)), audio().currentTime + 0.02, 0.9);
    });
  });
}

// ============================================================
// 作曲: ディグリー・ピアノロール
// ============================================================
const MR = { left: 34, top: 26, cw: 26, rh: 22, rows: 15 };
const MAJOR_SEMIS = [0, 2, 4, 5, 7, 9, 11];

function melodySemi(d) {
  return 12 * Math.floor(d / 7) + MAJOR_SEMIS[d % 7];
}

// 実音MIDI（バッキングと同じくカポ・チューニング込み）
function melodyMidi(d) {
  return 48 + state.key + melodySemi(d) + state.capo + TUNINGS[state.tuning].offset;
}

// タイムライン: 進行の各コードを8分ステップ列に展開
function melodyTimeline() {
  const segs = [];
  let acc = 0;
  for (const p of state.progression) {
    const steps = (p.beats || 4) * 2;
    segs.push({ start: acc, steps, item: p });
    acc += steps;
  }
  if (!segs.length) {
    segs.push({ start: 0, steps: 32, item: null });
    acc = 32;
  }
  return { segs, total: acc };
}

// セグメント（コード）の構成音pc集合。表に無いクオリティはボイシングの実音から
function segChordPcs(item) {
  if (!item) return new Set();
  const rootPc = (state.key + DEGREES[item.degree].pc) % 12;
  const formula = CHORD_INTERVALS[item.quality];
  if (formula) return new Set(formula.map(i => (rootPc + i) % 12));
  const vs = getVoicings(rootPc, item.quality);
  const v = vs[item.voicing || 0] || vs[0];
  const set = new Set();
  if (v) for (let i = 0; i < 6; i++) if (v.frets[i] >= 0) set.add((OPEN_MIDI[i] + v.frets[i]) % 12);
  return set;
}

function melodyNoteAt(t, d) {
  return state.melody.notes.find(n => n.d === d && t >= n.t && t < n.t + n.dur);
}

// モノフォニック: keepと時間が重なる他のノートを消す
function removeMelodyOverlaps(keep) {
  state.melody.notes = state.melody.notes.filter(n =>
    n === keep || n.t + n.dur <= keep.t || n.t >= keep.t + keep.dur);
}

function renderMelody() {
  const wrap = el('melody-wrap');
  if (!state.melody.on) {
    wrap.innerHTML = '';
    el('melody-count').textContent = '';
    return;
  }
  const { segs, total } = melodyTimeline();
  const W = MR.left + total * MR.cw + 8;
  const H = MR.top + MR.rows * MR.rh + 8;
  const yOf = d => MR.top + (14 - d) * MR.rh;
  const xOf = t => MR.left + t * MR.cw;

  let s = `<svg id="melody-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  // ルート行（1度）の背景を強調
  for (let d = 0; d < MR.rows; d++) {
    if (d % 7 === 0) {
      s += `<rect x="${MR.left}" y="${yOf(d)}" width="${total * MR.cw}" height="${MR.rh}" fill="rgba(226,164,74,0.07)"/>`;
    }
  }
  // コードレーン
  for (const seg of segs) {
    s += `<rect x="${xOf(seg.start)}" y="2" width="${seg.steps * MR.cw - 2}" height="${MR.top - 6}" rx="4" fill="#2a3040"/>`;
    if (seg.item) {
      s += `<text x="${xOf(seg.start) + 6}" y="${MR.top - 10}" class="mel-chord-label">${progLabel(seg.item)}</text>`;
    }
  }
  // コード境界のドラッグハンドル（8分単位で境界を前後に動かせる）
  segs.forEach((seg, i) => {
    if (i === 0 || !seg.item) return;
    s += `<rect class="seg-handle" data-b="${i - 1}" x="${xOf(seg.start) - 5}" y="0" width="11" height="${MR.top - 2}" fill="transparent"/>`;
  });
  // 縦線（8分・拍・コード境界）
  for (let t = 0; t <= total; t++) {
    const isChord = t === total || segs.some(sg => sg.start === t);
    const isBeat = t % 2 === 0;
    s += `<line x1="${xOf(t)}" y1="${MR.top}" x2="${xOf(t)}" y2="${H - 8}" stroke="${isChord ? '#69769a' : isBeat ? '#3d4657' : '#2c3340'}" stroke-width="${isChord ? 2 : 1}"/>`;
  }
  // 横線と行ラベル
  for (let r = 0; r <= MR.rows; r++) {
    s += `<line x1="${MR.left}" y1="${MR.top + r * MR.rh}" x2="${xOf(total)}" y2="${MR.top + r * MR.rh}" stroke="#2c3340" stroke-width="1"/>`;
  }
  for (let d = 0; d < MR.rows; d++) {
    s += `<text x="${MR.left - 6}" y="${yOf(d) + MR.rh / 2 + 4}" text-anchor="end" class="mel-row-label ${d >= 7 ? 'hi' : 'lo'}">${(d % 7) + 1}</text>`;
  }
  // ノート（コードトーンなら緑）
  state.melody.notes.forEach(n => {
    const seg = segs.find(sg => n.t >= sg.start && n.t < sg.start + sg.steps);
    const ct = seg ? segChordPcs(seg.item).has((state.key + melodySemi(n.d)) % 12) : false;
    s += `<rect class="mel-note${ct ? ' ct' : ''}" x="${xOf(n.t) + 1.5}" y="${yOf(n.d) + 2.5}" width="${n.dur * MR.cw - 3}" height="${MR.rh - 5}" rx="5"/>`;
  });
  // 再生ヘッド
  s += `<line id="melody-playhead" x1="-10" y1="${MR.top}" x2="-10" y2="${H - 8}" stroke="#ff7b6b" stroke-width="2" visibility="hidden"/>`;
  s += '</svg>';

  wrap.innerHTML = s;
  el('melody-count').textContent = state.melody.notes.length ? `${state.melody.notes.length}音` : '';
  attachMelodyMousedown(wrap.querySelector('svg'));
}

// コード境界ドラッグ（両ロール共通）
let bdDrag = null;

function tryStartBoundaryDrag(e) {
  if (!(e.target.classList && e.target.classList.contains('seg-handle'))) return false;
  const i = Number(e.target.dataset.b);
  if (!state.progression[i] || !state.progression[i + 1]) return false;
  e.preventDefault();
  bdDrag = {
    i,
    startX: e.clientX,
    origPrev: state.progression[i].beats || 4,
    origNext: state.progression[i + 1].beats || 4,
  };
  return true;
}

document.addEventListener('mousemove', e => {
  if (!bdDrag) return;
  const delta = Math.round((e.clientX - bdDrag.startX) / MR.cw) / 2; // 0.5拍(8分)刻み
  const prev = state.progression[bdDrag.i];
  const next = state.progression[bdDrag.i + 1];
  if (!prev || !next) return;
  const newPrev = bdDrag.origPrev + delta;
  const newNext = bdDrag.origNext - delta;
  if (newPrev < 0.5 || newNext < 0.5) return;
  if (prev.beats !== newPrev) {
    prev.beats = newPrev;
    next.beats = newNext;
    renderMelody();
    renderBacking();
    renderProgression();
  }
});

document.addEventListener('mouseup', () => {
  if (!bdDrag) return;
  bdDrag = null;
  update(false); // 保存も含めて全体を確定
});

// マウス操作: クリック=置く/消す、右方向ドラッグ=伸ばす
let melDrag = null;

function attachMelodyMousedown(svg) {
  svg.addEventListener('mousedown', e => {
    if (tryStartBoundaryDrag(e)) return;
    const r = svg.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const t = Math.floor((x - MR.left) / MR.cw);
    const d = 14 - Math.floor((y - MR.top) / MR.rh);
    const { total } = melodyTimeline();
    if (t < 0 || t >= total || d < 0 || d > 14 || y < MR.top) return;
    e.preventDefault();
    const hit = melodyNoteAt(t, d);
    if (hit) {
      melDrag = { note: hit, del: true, moved: false };
    } else {
      const note = { t, dur: 1, d };
      state.melody.notes.push(note);
      removeMelodyOverlaps(note);
      if (state.melody.timbre === 'guitar') pluck(melodyMidi(d), audio().currentTime + 0.02, 1.0);
      else sing(melodyMidi(d), audio().currentTime + 0.02, 0.45);
      melDrag = { note, del: false, moved: false };
      renderMelody();
      saveState();
    }
  });
}

document.addEventListener('mousemove', e => {
  if (!melDrag) return;
  const svg = document.getElementById('melody-svg');
  if (!svg) { melDrag = null; return; }
  const x = e.clientX - svg.getBoundingClientRect().left;
  const t = Math.floor((x - MR.left) / MR.cw);
  const n = melDrag.note;
  const newDur = Math.max(1, Math.min(t - n.t + 1, melodyTimeline().total - n.t));
  if (newDur !== n.dur) {
    n.dur = newDur;
    melDrag.moved = true;
    melDrag.del = false;
    removeMelodyOverlaps(n);
    renderMelody();
  }
});

document.addEventListener('mouseup', () => {
  if (!melDrag) return;
  if (melDrag.del && !melDrag.moved) {
    state.melody.notes = state.melody.notes.filter(n => n !== melDrag.note);
    renderMelody();
  }
  saveState();
  melDrag = null;
});

// 同じ行で直前のノートと隙間なく繋がっている（＝レガートの続き）か
function isMelodyContinuation(n) {
  return state.melody.notes.some(o => o !== n && o.d === n.d && o.t + o.dur === n.t);
}

// 同じ行で隙間なく連なるノートを1つの音として数えた合計ステップ数
function melodyChainSteps(n) {
  let end = n.t + n.dur;
  for (;;) {
    const next = state.melody.notes.find(o => o.d === n.d && o.t === end);
    if (!next) break;
    end = next.t + next.dur;
  }
  return end - n.t;
}

// 再生スケジュール: そのコードの時間窓に入るノートを絶対時刻で発音
function scheduleMelodyForStep(pos, beatSec) {
  const { segs } = melodyTimeline();
  const seg = segs[pos];
  if (!seg) return;
  const base = audio().currentTime + 0.05;
  for (const n of state.melody.notes) {
    if (n.t >= seg.start && n.t < seg.start + seg.steps) {
      const when = base + (n.t - seg.start) * beatSec / 2;
      if (state.melody.timbre === 'guitar') {
        progSources.push(pluck(melodyMidi(n.d), when, 1.0));
      } else {
        // 声: 横に隣接するノートは再アタックせず1つの伸ばした音として歌う
        if (isMelodyContinuation(n)) continue;
        const durSec = Math.max(0.25, melodyChainSteps(n) * beatSec / 2 * 0.95);
        progSources.push(...sing(melodyMidi(n.d), when, durSec));
      }
    }
  }
}

// ============================================================
// 作曲: バッキング・ピアノロール
// 縦6行＝ギターの6弦。各コード区間では鳴る弦（押さえ方でミュートでない弦）
// だけ背景が色付き＆選択可能。縦に複数＝和音。音の高さはコードの押さえ方が決める
// ============================================================
const BK_ROWS = 6;

// セグメントのコードのボイシング（押さえ方）
function segVoicing(item) {
  if (!item) return null;
  const rootPc = (state.key + DEGREES[item.degree].pc) % 12;
  const vs = getVoicings(rootPc, item.quality);
  return vs[item.voicing || 0] || vs[0] || null;
}

function backingNoteAt(t, s) {
  return state.backing.notes.find(n => n.s === s && t >= n.t && t < n.t + n.dur);
}

function backingSegAt(t) {
  return melodyTimeline().segs.find(sg => t >= sg.start && t < sg.start + sg.steps);
}

// 伸ばせる上限: コード境界と同じ弦の次のノートまで
function backingMaxDur(n) {
  const seg = backingSegAt(n.t);
  let max = seg ? seg.start + seg.steps - n.t : 1;
  for (const o of state.backing.notes) {
    if (o !== n && o.s === n.s && o.t > n.t) max = Math.min(max, o.t - n.t);
  }
  return Math.max(1, max);
}

function renderBacking() {
  const wrap = el('backing-wrap');
  if (!state.backing.on) {
    wrap.innerHTML = '';
    el('backing-count').textContent = '';
    return;
  }
  const { segs, total } = melodyTimeline();
  const W = MR.left + total * MR.cw + 8;
  const H = MR.top + BK_ROWS * MR.rh + 8;
  const yOf = s => MR.top + (5 - s) * MR.rh; // s=5(1弦)が最上段
  const xOf = t => MR.left + t * MR.cw;

  let s = `<svg id="backing-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  // 選択可能セル（そのコードで鳴る弦）の背景
  for (const seg of segs) {
    const v = segVoicing(seg.item);
    if (!v) continue;
    for (let si = 0; si < 6; si++) {
      if (v.frets[si] >= 0) {
        s += `<rect x="${xOf(seg.start)}" y="${yOf(si)}" width="${seg.steps * MR.cw}" height="${MR.rh}" fill="rgba(126,200,163,0.14)"/>`;
      }
    }
  }
  // コードレーン
  for (const seg of segs) {
    s += `<rect x="${xOf(seg.start)}" y="2" width="${seg.steps * MR.cw - 2}" height="${MR.top - 6}" rx="4" fill="#2a3040"/>`;
    if (seg.item) {
      s += `<text x="${xOf(seg.start) + 6}" y="${MR.top - 10}" class="mel-chord-label">${progLabel(seg.item)}</text>`;
    }
  }
  // コード境界のドラッグハンドル（8分単位で境界を前後に動かせる）
  segs.forEach((seg, i) => {
    if (i === 0 || !seg.item) return;
    s += `<rect class="seg-handle" data-b="${i - 1}" x="${xOf(seg.start) - 5}" y="0" width="11" height="${MR.top - 2}" fill="transparent"/>`;
  });
  // 縦線・横線・行ラベル（弦）
  for (let t = 0; t <= total; t++) {
    const isChord = t === total || segs.some(sg => sg.start === t);
    const isBeat = t % 2 === 0;
    s += `<line x1="${xOf(t)}" y1="${MR.top}" x2="${xOf(t)}" y2="${H - 8}" stroke="${isChord ? '#69769a' : isBeat ? '#3d4657' : '#2c3340'}" stroke-width="${isChord ? 2 : 1}"/>`;
  }
  for (let r = 0; r <= BK_ROWS; r++) {
    s += `<line x1="${MR.left}" y1="${MR.top + r * MR.rh}" x2="${xOf(total)}" y2="${MR.top + r * MR.rh}" stroke="#2c3340" stroke-width="1"/>`;
  }
  for (let si = 0; si < 6; si++) {
    s += `<text x="${MR.left - 6}" y="${yOf(si) + MR.rh / 2 + 4}" text-anchor="end" class="mel-row-label hi">${6 - si}弦</text>`;
  }
  // ノート
  state.backing.notes.forEach(n => {
    s += `<rect class="bk-note" x="${xOf(n.t) + 1.5}" y="${yOf(n.s) + 2.5}" width="${n.dur * MR.cw - 3}" height="${MR.rh - 5}" rx="5"/>`;
  });
  // 再生ヘッド
  s += `<line id="backing-playhead" x1="-10" y1="${MR.top}" x2="-10" y2="${H - 8}" stroke="#ff7b6b" stroke-width="2" visibility="hidden"/>`;
  s += '</svg>';

  wrap.innerHTML = s;
  el('backing-count').textContent = state.backing.notes.length ? `${state.backing.notes.length}音` : '';
  attachBackingMousedown(wrap.querySelector('svg'));
}

let bkDrag = null;

function attachBackingMousedown(svg) {
  svg.addEventListener('mousedown', e => {
    if (tryStartBoundaryDrag(e)) return;
    const r = svg.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    const t = Math.floor((x - MR.left) / MR.cw);
    const si = 5 - Math.floor((y - MR.top) / MR.rh);
    const { total } = melodyTimeline();
    if (t < 0 || t >= total || si < 0 || si > 5 || y < MR.top) return;
    e.preventDefault();
    const hit = backingNoteAt(t, si);
    if (hit) {
      bkDrag = { note: hit, del: true, moved: false, stack: [hit] };
    } else {
      const seg = backingSegAt(t);
      const v = seg ? segVoicing(seg.item) : null;
      if (!v || v.frets[si] < 0) return; // そのコードで鳴らない弦には置けない
      const note = { t, dur: 1, s: si };
      state.backing.notes.push(note);
      pluck(stringMidi(si, v.frets[si]), audio().currentTime + 0.02, 0.85);
      bkDrag = { note, del: false, moved: false, stack: [note] };
      renderBacking();
      saveState();
    }
  });
}

document.addEventListener('mousemove', e => {
  if (!bkDrag) return;
  const svg = document.getElementById('backing-svg');
  if (!svg) { bkDrag = null; return; }
  const r = svg.getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  const t2 = Math.floor((x - MR.left) / MR.cw);
  const s2 = Math.max(0, Math.min(5, 5 - Math.floor((y - MR.top) / MR.rh)));
  const n = bkDrag.note;
  let changed = false;

  // 縦方向: アンカー〜現在行の間の「鳴る弦」にノートを積む（＝和音の複数選択）
  const lo = Math.min(n.s, s2);
  const hi = Math.max(n.s, s2);
  const seg = backingSegAt(n.t);
  const v = seg ? segVoicing(seg.item) : null;
  // ドラッグ範囲から外れた積みノートを外す
  const keep = [];
  for (const o of bkDrag.stack) {
    if (o !== n && (o.s < lo || o.s > hi)) {
      state.backing.notes = state.backing.notes.filter(x2 => x2 !== o);
      changed = true;
    } else {
      keep.push(o);
    }
  }
  bkDrag.stack = keep;
  // 範囲内の鳴る弦に追加
  if (v) {
    for (let row = lo; row <= hi; row++) {
      if (row === n.s || v.frets[row] < 0) continue;
      if (backingNoteAt(n.t, row)) continue;
      const note2 = { t: n.t, dur: n.dur, s: row };
      state.backing.notes.push(note2);
      bkDrag.stack.push(note2);
      pluck(stringMidi(row, v.frets[row]), audio().currentTime + 0.02, 0.7);
      changed = true;
    }
  }

  // 横方向: スタック全体の長さを伸縮
  const newDur = Math.max(1, t2 - n.t + 1);
  if (newDur !== n.dur) {
    for (const o of bkDrag.stack) {
      o.dur = Math.max(1, Math.min(newDur, backingMaxDur(o)));
    }
    changed = true;
  }

  if (changed) {
    bkDrag.moved = true;
    bkDrag.del = false;
    renderBacking();
  }
});

document.addEventListener('mouseup', () => {
  if (!bkDrag) return;
  if (bkDrag.del && !bkDrag.moved) {
    state.backing.notes = state.backing.notes.filter(n => n !== bkDrag.note);
    renderBacking();
  }
  saveState();
  bkDrag = null;
});

// バッキングの再生スケジュール（ストローク「ピアノロール」選択時に使われる）
// 音の高さはそのコードの押さえ方から決まる
function scheduleBackingForStep(pos, beatSec) {
  const { segs } = melodyTimeline();
  const seg = segs[pos];
  if (!seg) return;
  const v = segVoicing(seg.item);
  if (!v) return;
  const base = audio().currentTime + 0.05;
  for (const n of state.backing.notes) {
    if (n.t >= seg.start && n.t < seg.start + seg.steps && v.frets[n.s] >= 0) {
      progSources.push(pluck(stringMidi(n.s, v.frets[n.s]), base + (n.t - seg.start) * beatSec / 2, 0.85));
    }
  }
}

// 再生ヘッドのアニメーション（バックグラウンドでも動くようsetInterval駆動）
let progClock = null;
let playheadTimer = null;

function updateMelodyPlayhead() {
  if (!progClock || !actx) return;
  const { segs } = melodyTimeline();
  const seg = segs[progClock.pos];
  if (!seg) return;
  const stepFloat = seg.start + Math.max(0, actx.currentTime - progClock.startTime) / (progClock.beatSec / 2);
  const x = MR.left + Math.min(stepFloat, seg.start + seg.steps) * MR.cw;
  for (const id of ['melody-playhead', 'backing-playhead']) {
    const line = document.getElementById(id);
    if (!line) continue;
    line.setAttribute('x1', x);
    line.setAttribute('x2', x);
    line.setAttribute('visibility', 'visible');
  }
}

// ============================================================
// インポート / エクスポート
// ============================================================
function setShareStatus(msg, isError) {
  const s = el('share-status');
  s.textContent = msg;
  s.classList.toggle('error', !!isError);
}

function exportData() {
  const data = {
    app: 'guitar-chord-support',
    version: 1,
    exported: new Date().toISOString(),
    userShapes: USER_SHAPES,
    progressions: savedProgs,
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  a.download = `guitar-chords-${stamp}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  setShareStatus(`エクスポートしました（コード${USER_SHAPES.length}件・進行${savedProgs.length}件）`);
}

function importData(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    setShareStatus('読み込めませんでした（JSONファイルではありません）', true);
    return;
  }
  if (!data || (!Array.isArray(data.userShapes) && !Array.isArray(data.progressions))) {
    setShareStatus('このアプリのエクスポートファイルではないようです', true);
    return;
  }

  // コードのマージ（同一の押さえ方はスキップ）
  let addedShapes = 0, skipped = 0;
  const shapeKey = s => `${s.root}|${s.quality}|${s.frets.join(',')}`;
  const existingShapes = new Set(USER_SHAPES.map(shapeKey));
  for (const s of (data.userShapes || [])) {
    if (!(s && typeof s.root === 'number' && typeof s.quality === 'string' &&
          Array.isArray(s.frets) && s.frets.length === 6)) continue;
    const shape = { root: s.root, quality: s.quality, frets: s.frets.map(Number), name: String(s.name || 'インポートコード') };
    if (existingShapes.has(shapeKey(shape))) { skipped++; continue; }
    shape.id = Date.now() + Math.random();
    USER_SHAPES.push(shape);
    existingShapes.add(shapeKey(shape));
    addedShapes++;
  }

  // 進行のマージ（同名・同内容はスキップ、同名で別内容は連番リネーム）
  let addedProgs = 0;
  const names = new Set(savedProgs.map(p => p.name));
  for (const p of (data.progressions || [])) {
    if (!(p && typeof p.name === 'string' && Array.isArray(p.items))) continue;
    const items = p.items
      .filter(it => it && typeof it.degree === 'number' && typeof it.quality === 'string')
      .map(it => ({
        degree: it.degree,
        quality: it.quality,
        voicing: typeof it.voicing === 'number' ? it.voicing : 0,
        beats: validBeats(it.beats),
      }));
    if (!items.length) continue;
    const melody = validMelodyNotes(p.melody);
    const backing = validBackingNotes(p.backing);
    // 同じ内容（コード＋メロディー＋バッキング）の進行が既にあれば名前にかかわらずスキップ
    const contentJson = JSON.stringify({ items, melody, backing });
    if (savedProgs.some(x => JSON.stringify({
      items: x.items, melody: validMelodyNotes(x.melody), backing: validBackingNotes(x.backing),
    }) === contentJson)) {
      skipped++;
      continue;
    }
    let name = p.name;
    for (let n = 2; names.has(name); n++) name = `${p.name}（${n}）`;
    savedProgs.push({
      id: Date.now() + Math.random(),
      name,
      items,
      bpm: typeof p.bpm === 'number' ? p.bpm : 90,
      pattern: typeof p.pattern === 'string' ? p.pattern : 'simple',
      melody,
      backing,
    });
    names.add(name);
    addedProgs++;
  }

  saveUserShapes();
  persistSavedProgs();
  renderSavedProgs();
  update(false);
  setShareStatus(`読み込みました: コード${addedShapes}件・進行${addedProgs}件を追加` +
    (skipped ? `（重複${skipped}件はスキップ）` : ''));
}

// ============================================================
// コード登録エディタ
// ============================================================
let editFrets = [0, 0, 0, 0, 0, 0]; // 未指定の弦は開放のまま鳴る
let editCandidates = [];
let editSelected = 0;

const ED = { nut: 46, fw: 54, top: 26, gap: 24, frets: 12 };

function degreeLabelOf(pc) {
  return DEGREES[(pc - state.key + 12) % 12].label;
}

function renderEditor() {
  const capo = state.capo;
  const W = ED.nut + ED.fw * ED.frets + 12;
  const H = ED.top + ED.gap * 5 + 34;
  const yOf = i => ED.top + (5 - i) * ED.gap;
  const xOf = f => ED.nut + f * ED.fw;

  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  s += `<rect x="${ED.nut}" y="${ED.top - 12}" width="${ED.fw * ED.frets}" height="${ED.gap * 5 + 24}" rx="4" fill="#33261d"/>`;
  // 左端＝カポ位置（カポなしなら通常のナット）
  if (capo > 0) {
    s += `<rect x="${ED.nut - 11}" y="${ED.top - 16}" width="11" height="${ED.gap * 5 + 32}" rx="5" fill="#2f3d55" stroke="#5b779f" stroke-width="1.5"/>`;
    s += `<text x="${ED.nut - 5}" y="${H - 8}" text-anchor="middle" class="capo-label">カポ${capo}</text>`;
  } else {
    s += `<rect x="${ED.nut - 6}" y="${ED.top - 12}" width="6" height="${ED.gap * 5 + 24}" fill="#d8cfa8" rx="2"/>`;
  }
  // フレット番号は実機と同じ絶対表記（カポ位置＋n）
  for (let f = 1; f <= ED.frets; f++) {
    s += `<line x1="${xOf(f)}" y1="${ED.top - 12}" x2="${xOf(f)}" y2="${ED.top + ED.gap * 5 + 12}" stroke="#7c7568" stroke-width="2"/>`;
    if ([3, 5, 7, 9, 12, 15, 17, 19].includes(capo + f)) {
      s += `<text x="${xOf(f) - ED.fw / 2}" y="${H - 8}" text-anchor="middle" class="fret-num">${capo + f}</text>`;
    }
  }
  for (let i = 0; i < 6; i++) {
    s += `<line x1="${ED.nut - 6}" y1="${yOf(i)}" x2="${xOf(ED.frets)}" y2="${yOf(i)}" stroke="#c9c2b4" stroke-width="${Math.max(0.8, 2.8 - i * 0.4)}"/>`;
  }
  // 押さえ位置と開放/ミュートマーク
  for (let i = 0; i < 6; i++) {
    const f = editFrets[i];
    const y = yOf(i);
    if (f === -1) {
      s += `<text x="${ED.nut - 26}" y="${y + 5}" text-anchor="middle" class="mute-mark">✕</text>`;
    } else if (f === 0) {
      s += `<circle cx="${ED.nut - 24}" cy="${y}" r="7" fill="none" stroke="#7ec8a3" stroke-width="2.2"/>`;
    } else {
      s += `<circle cx="${xOf(f) - ED.fw / 2}" cy="${y}" r="9" fill="#e2a44a"/>`;
    }
  }
  // クリック領域
  for (let i = 0; i < 6; i++) {
    s += `<rect class="ed-hit" data-s="${i}" data-f="0" x="0" y="${yOf(i) - ED.gap / 2}" width="${ED.nut}" height="${ED.gap}" fill="transparent"/>`;
    for (let f = 1; f <= ED.frets; f++) {
      s += `<rect class="ed-hit" data-s="${i}" data-f="${f}" x="${xOf(f - 1)}" y="${yOf(i) - ED.gap / 2}" width="${ED.fw}" height="${ED.gap}" fill="transparent"/>`;
    }
  }
  s += '</svg>';

  const wrap = el('editor-wrap');
  wrap.innerHTML = s;
  wrap.querySelectorAll('.ed-hit').forEach(r => {
    r.addEventListener('click', () => {
      const i = Number(r.dataset.s);
      const f = Number(r.dataset.f);
      if (f === 0) {
        editFrets[i] = editFrets[i] === -1 ? 0 : -1; // ナット左: 開放⇔ミュート
      } else {
        editFrets[i] = editFrets[i] === f ? 0 : f;   // 同じ場所を再クリックで解除
      }
      refreshEditor();
    });
  });
}

function renderAnalysis() {
  const box = el('candidates');
  box.innerHTML = '';
  if (!editCandidates.length) {
    box.innerHTML = '<span class="empty">すべての弦がミュートです。鳴らす弦を指定してください</span>';
    el('btn-register').disabled = true;
    return;
  }
  el('btn-register').disabled = false;
  editCandidates.forEach((c, i) => {
    const btn = document.createElement('button');
    btn.className = 'quality-btn' + (i === editSelected ? ' active' : '');
    let label = degreeLabelOf(c.root) + c.quality;
    if (!c.rootInBass) label += ` (on ${degreeLabelOf(c.bass)})`;
    if (!c.exact) label += '・5度省略';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      editSelected = i;
      renderAnalysis();
    });
    box.appendChild(btn);
  });
}

function refreshEditor() {
  renderEditor();
  editCandidates = analyzeShape(editFrets);
  editSelected = 0;
  renderAnalysis();
}

function registerShape() {
  const c = editCandidates[editSelected];
  if (!c) return;
  const name = el('shape-name').value.trim() || `マイコード${USER_SHAPES.length + 1}`;
  const shape = { id: Date.now(), root: c.root, quality: c.quality, frets: editFrets.slice(), name };
  USER_SHAPES.push(shape);
  saveUserShapes();
  el('shape-name').value = '';
  // 登録したコードを選択状態にして表示・試聴
  state.degree = (c.root - state.key + 12) % 12;
  state.quality = c.quality;
  update(false);
  const idx = currentVoicings().findIndex(v => v.id === shape.id);
  state.voicing = Math.max(0, idx);
  update(true);
}

// ============================================================
// エフェクトパネルUI
// ============================================================
const FX_DEFS = [
  { key: 'od',     name: 'オーバードライブ', params: [{ k: 'drive', label: 'ドライブ', min: 0, max: 100, unit: '' }] },
  { key: 'chorus', name: 'コーラス',        params: [{ k: 'depth', label: '深さ', min: 0, max: 100, unit: '' }] },
  { key: 'delay',  name: 'ディレイ',        params: [
    { k: 'time',     label: 'タイム',       min: 80, max: 800, unit: 'ms' },
    { k: 'feedback', label: 'フィードバック', min: 0,  max: 80,  unit: '%' },
    { k: 'mix',      label: 'ミックス',     min: 0,  max: 100, unit: '%' },
  ] },
  { key: 'reverb', name: 'リバーブ',        params: [{ k: 'mix', label: '量', min: 0, max: 100, unit: '%' }] },
];

const FX_PRESETS = [
  { name: 'クリーン',     fx: {} },
  { name: 'クランチ',     fx: { od: { on: true, drive: 30 }, reverb: { on: true, mix: 15 } } },
  { name: 'リード',       fx: { od: { on: true, drive: 70 }, delay: { on: true, time: 340, feedback: 30, mix: 30 }, reverb: { on: true, mix: 20 } } },
  { name: 'アンビエント', fx: { chorus: { on: true, depth: 60 }, delay: { on: true, time: 460, feedback: 45, mix: 45 }, reverb: { on: true, mix: 65 } } },
];

function buildFxPanel() {
  const panel = el('fx-panel');
  panel.innerHTML = '';
  for (const def of FX_DEFS) {
    const s = state.fx[def.key];
    const card = document.createElement('div');
    card.className = 'fx-card' + (s.on ? ' on' : '');

    const head = document.createElement('label');
    head.className = 'fx-head';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.on;
    cb.addEventListener('change', () => {
      s.on = cb.checked;
      card.classList.toggle('on', s.on);
      applyFx();
      saveState();
    });
    head.appendChild(cb);
    head.appendChild(document.createTextNode(def.name));
    card.appendChild(head);

    for (const p of def.params) {
      const row = document.createElement('div');
      row.className = 'fx-param';
      const lab = document.createElement('span');
      lab.className = 'fx-label';
      lab.textContent = p.label;
      const range = document.createElement('input');
      range.type = 'range';
      range.min = p.min;
      range.max = p.max;
      range.value = s[p.k];
      const val = document.createElement('span');
      val.className = 'fx-value';
      const show = () => { val.textContent = s[p.k] + p.unit; };
      range.addEventListener('input', () => {
        s[p.k] = Number(range.value);
        show();
        applyFx();
        saveState();
      });
      show();
      row.appendChild(lab);
      row.appendChild(range);
      row.appendChild(val);
      card.appendChild(row);
    }
    panel.appendChild(card);
  }
}

function buildFxPresets() {
  const box = el('fx-presets');
  box.innerHTML = '';
  for (const p of FX_PRESETS) {
    const btn = document.createElement('button');
    btn.className = 'quality-btn';
    btn.textContent = p.name;
    btn.addEventListener('click', () => {
      state.fx = mergedFx(p.fx);
      buildFxPanel();
      audio(); // クリック起点でオーディオを初期化してから反映
      applyFx();
      saveState();
      const v = currentVoicings()[state.voicing];
      if (v) playVoicing(v, 0.045); // 試聴
    });
    box.appendChild(btn);
  }
}

// ============================================================
// 初期化
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  el('key-select').addEventListener('change', e => {
    state.key = Number(e.target.value);
    update(false);
  });
  el('capo-select').addEventListener('change', e => {
    state.capo = Number(e.target.value);
    update(false);
  });
  el('tuning-select').addEventListener('change', e => {
    state.tuning = Number(e.target.value);
    update(false);
  });
  el('btn-strum').addEventListener('click', () => {
    const v = currentVoicings()[state.voicing];
    if (v) playVoicing(v, 0.045);
  });
  el('btn-arpeggio').addEventListener('click', () => {
    const v = currentVoicings()[state.voicing];
    if (v) playVoicing(v, 0.24);
  });
  el('btn-prog-add').addEventListener('click', () => {
    state.progression.push({ degree: state.degree, quality: state.quality, voicing: state.voicing, beats: 4 });
    update(false);
  });
  el('btn-prog-play').addEventListener('click', () => {
    if (progPlaying) stopProgression();
    else startProgression();
  });
  el('btn-prog-clear').addEventListener('click', () => {
    stopProgression();
    state.progression = [];
    update(false);
  });
  el('prog-bpm').addEventListener('change', e => {
    state.bpm = Math.min(220, Math.max(40, Number(e.target.value) || 90));
    e.target.value = state.bpm;
    saveState();
  });
  el('prog-loop').addEventListener('change', e => {
    state.loop = e.target.checked;
    saveState();
  });
  const patSel = el('prog-pattern');
  STRUM_PATTERNS.forEach(p => patSel.add(new Option(p.name, p.id)));
  patSel.value = state.pattern;
  patSel.addEventListener('change', e => {
    state.pattern = e.target.value;
    saveState();
  });
  el('btn-prog-save').addEventListener('click', saveCurrentProgression);
  loadSavedProgs();
  renderSavedProgs();
  el('melody-on').addEventListener('change', e => {
    state.melody.on = e.target.checked;
    update(false);
  });
  el('melody-sound').addEventListener('change', e => {
    state.melody.sound = e.target.checked;
    saveState();
  });
  el('melody-timbre').addEventListener('change', e => {
    state.melody.timbre = e.target.value;
    saveState();
  });
  el('melody-timbre').value = state.melody.timbre;
  el('melody-solo').addEventListener('change', e => {
    state.melody.solo = e.target.checked;
    saveState();
  });
  el('melody-solo').checked = state.melody.solo;
  el('backing-on').addEventListener('change', e => {
    state.backing.on = e.target.checked;
    update(false);
  });
  el('btn-backing-clear').addEventListener('click', () => {
    state.backing.notes = [];
    renderBacking();
    saveState();
  });
  el('backing-on').checked = state.backing.on;
  el('btn-melody-clear').addEventListener('click', () => {
    state.melody.notes = [];
    renderMelody();
    saveState();
  });
  el('melody-on').checked = state.melody.on;
  el('melody-sound').checked = state.melody.sound;
  const scOn = el('scale-on');
  const scRoot = el('scale-root');
  const scType = el('scale-type');
  DEGREES.forEach((d, i) => scRoot.add(new Option(d.label, i)));
  SCALES.forEach(sc => scType.add(new Option(sc.name, sc.id)));
  scOn.checked = state.scale.on;
  scRoot.value = state.scale.root;
  scType.value = state.scale.type;
  scOn.addEventListener('change', () => { state.scale.on = scOn.checked; update(false); });
  scRoot.addEventListener('change', () => { state.scale.root = Number(scRoot.value); update(false); });
  scType.addEventListener('change', () => { state.scale.type = scType.value; update(false); });
  el('btn-export').addEventListener('click', exportData);
  el('btn-import').addEventListener('click', () => el('import-file').click());
  el('import-file').addEventListener('change', e => {
    const f = e.target.files[0];
    if (f) f.text().then(importData);
    e.target.value = '';
  });
  const zone = el('share-zone');
  ['dragover', 'dragenter'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault();
    zone.classList.add('dragging');
  }));
  zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('dragging');
    const f = e.dataTransfer.files[0];
    if (f) f.text().then(importData);
  });
  el('prog-bpm').value = state.bpm;
  el('prog-loop').checked = state.loop;
  el('btn-edit-play').addEventListener('click', () => playVoicing({ frets: editFrets }, 0.045));
  el('btn-edit-clear').addEventListener('click', () => {
    editFrets = [0, 0, 0, 0, 0, 0];
    refreshEditor();
  });
  el('btn-register').addEventListener('click', registerShape);
  loadUserShapes();
  buildFxPresets();
  buildFxPanel();
  refreshEditor();
  update(false);
});
