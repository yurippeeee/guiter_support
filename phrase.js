'use strict';

// ============================================================
// フレーズ→TAB（独立機能）
// ピアノロールで入力したフレーズに、TabEngine が押さえる位置・指・奏法・カポを割り当てる。
// キー・チューニング・カポ・テンポはこの機能だけのもの（他タブの設定とは連動しない）
// チューニングは弦ごとに変えられる（レギュラーからの半音差）。「自動」は弾きやすさから最適なチューニングを探す
// 依存: chords.js（KEY_NAMES, OPEN_MIDI, TUNINGS）/ app.js（el, audio, pluck）/ tab-engine.js
// ============================================================
const PH_KEY = 'guitar-support-phrase';
const PH_ROWS = 43;                      // 3.5オクターブ
const PH_STEPS_PER_BAR = 16;             // 16分音符グリッド
const PH_MAJOR = [0, 2, 4, 5, 7, 9, 11]; // 白鍵＝キーのメジャースケール
const PR = { left: 58, cw: 16, rh: 13 }; // ピアノロール
const TB = { top: 30, gap: 15 };          // TAB譜
const FB = { nut: 74, fw: 38, top: 26, gap: 24, frets: 22 }; // 指板

const TECH_INFO = {
  pick:      { cls: 't-pick',   mark: '',   name: 'ピッキング' },
  hammer:    { cls: 't-legato', mark: 'h',  name: 'ハンマリング' },
  pull:      { cls: 't-legato', mark: 'p',  name: 'プリング' },
  slideUp:   { cls: 't-slide',  mark: '/',  name: 'スライド（上）' },
  slideDown: { cls: 't-slide',  mark: '\\', name: 'スライド（下）' },
  tap:       { cls: 't-tap',    mark: 'T',  name: 'タッピング' },
  chord:     { cls: 't-chord',  mark: '',   name: '和音（ダウンストローク）' },
};

// 保存されていたチューニング → 'auto' か 6弦→1弦の半音差の配列（以前は全弦一律の番号）
function phTuningFrom(v) {
  if (v === 'auto') return 'auto';
  if (TabEngine.validOff(v)) return v.slice();
  if (Number.isInteger(v) && TUNINGS[v]) return Array(6).fill(TUNINGS[v].offset);
  return [0, 0, 0, 0, 0, 0];
}

function loadPhrase() {
  const def = { key: 0, tuning: [0, 0, 0, 0, 0, 0], autoTuning: null, bpm: 100, bars: 4, capo: 'auto', reach: 4, loop: false, notes: [] };
  try {
    const s = JSON.parse(localStorage.getItem(PH_KEY));
    if (!s || typeof s !== 'object') return def;
    return {
      key: Number.isInteger(s.key) && s.key >= 0 && s.key < 12 ? s.key : 0,
      tuning: phTuningFrom(s.tuning),
      autoTuning: TabEngine.validOff(s.autoTuning) ? s.autoTuning : null,
      bpm: typeof s.bpm === 'number' ? Math.min(240, Math.max(40, s.bpm)) : 100,
      bars: [1, 2, 4, 8, 16].includes(s.bars) ? s.bars : 4,
      capo: s.capo === 'auto' || (Number.isInteger(s.capo) && s.capo >= 0 && s.capo <= TabEngine.CAPO_MAX) ? s.capo : 'auto',
      reach: s.reach === 3 ? 3 : 4,
      loop: !!s.loop,
      notes: (Array.isArray(s.notes) ? s.notes : []).filter(n =>
        n && Number.isInteger(n.t) && n.t >= 0 && Number.isInteger(n.dur) && n.dur >= 1 &&
        Number.isInteger(n.r) && n.r >= 0 && n.r < PH_ROWS
      ).map(n => ({ t: n.t, dur: n.dur, r: n.r })),
    };
  } catch (e) {
    return def;
  }
}

const ph = loadPhrase();
let phResult = null;   // TabEngine.solve の結果
let phNoteInfo = new Map(); // 入力ノート → { tech, approx, drop }
let phCursor = 0;      // 再生・表示位置（16分単位）
let phShownEvent = -2; // 指板に表示中のイベント番号
let phPlay = null;     // 再生中の情報
let phDrag = null;
let phLastDur = 2;     // 新しく置く音の長さ（直前に伸ばした長さを引き継ぐ）

function savePhrase() {
  try { localStorage.setItem(PH_KEY, JSON.stringify(ph)); } catch (e) { /* 保存できなくても動作は継続 */ }
}

const phSteps = () => ph.bars * PH_STEPS_PER_BAR;
const phLow = () => 36 + ph.key; // 一番下の段＝キーの主音（C2〜B2）
const phMidi = r => phLow() + r;
const phStepSec = () => 60 / ph.bpm / 4;
const phNoteName = m => `${KEY_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
const phCapoLabel = c => (c === 0 ? 'なし' : `${c}フレット`);
// 今使うチューニング（自動なら最後に見つけたもの）
const phTuning = () => (ph.tuning === 'auto' ? ph.autoTuning || [0, 0, 0, 0, 0, 0] : ph.tuning);
const phOpen = () => TabEngine.tuningOpen(phTuning());
const phOpenName = s => KEY_NAMES[((phOpen()[s] % 12) + 12) % 12];
const phTuningText = off => {
  const names = TabEngine.tuningOpen(off).map(m => KEY_NAMES[m % 12]).join(' ');
  return `${TabEngine.tuningName(off)}（${names}）`;
};
let phTuneSearch = null; // 自動チューニングの探索 { gen, progress, cands }
let phTuneGen = 0;
let phTuneTimer = null;

// ------------------------------------------------------------
// 最適化
// ------------------------------------------------------------
function solvePhrase() {
  const steps = phSteps();
  const notes = ph.notes.filter(n => n.t < steps).map(n => ({
    t: n.t, dur: Math.min(n.dur, steps - n.t), midi: phMidi(n.r), ref: n,
  }));
  phResult = TabEngine.solve(notes, {
    open: phOpen(),
    stepSec: phStepSec(),
    capo: ph.capo,
    reach: ph.reach,
  });
  phNoteInfo = new Map();
  phResult.events.forEach((ev, i) => {
    const st = phResult.path[i];
    if (!st) return;
    for (const p of st.picks) {
      phNoteInfo.set(ev.notes[p.note].ref, { tech: phResult.techs[i].tech, approx: !!p.approx, drop: !!p.drop });
    }
  });
  phShownEvent = -2;
}

// 左手が同じ位置にいる区間（開放弦だけ・タッピングの音は手が自由なので区間に含める）
function phHandBlock(i) {
  const r = phResult;
  if (!r || i < 0 || !r.path[i]) return null;
  const free = k => r.path[k].openOnly || r.path[k].tap;
  // 開放弦だけの音にいるときは、前後で押さえている位置を基準にする
  let k0 = i;
  while (k0 > 0 && free(k0)) k0--;
  if (free(k0)) { k0 = i; while (k0 < r.events.length - 1 && free(k0)) k0++; }
  const hand = r.path[k0].hand;
  let from = i;
  let to = i;
  while (from > 0 && (free(from - 1) || r.path[from - 1].hand === hand)) from--;
  while (to < r.events.length - 1 && (free(to + 1) || r.path[to + 1].hand === hand)) to++;
  return { from, to, hand };
}

function phEventAt(c) {
  if (!phResult) return -1;
  let idx = -1;
  phResult.events.forEach((ev, i) => { if (ev.t <= c) idx = i; });
  return idx;
}

// ------------------------------------------------------------
// 描画: 概要（カポ・奏法の集計）
// ------------------------------------------------------------
function renderPhSummary() {
  const r = phResult;
  const parts = [
    `チューニング: <b>${phTuningText(phTuning())}</b>${ph.tuning === 'auto' ? '（自動で最適化）' : ''}`,
    `カポ: <b>${phCapoLabel(r.capo)}</b>${ph.capo === 'auto' ? '（自動で最適化）' : ''}`,
  ];
  const count = {};
  r.techs.forEach(t => { count[t.tech] = (count[t.tech] || 0) + 1; });
  const techText = ['hammer', 'pull', 'slideUp', 'slideDown', 'tap', 'chord']
    .filter(k => count[k]).map(k => `${TECH_INFO[k].name}×${count[k]}`).join(' / ');
  if (techText) parts.push(techText);
  if (r.approx) parts.push(`<span class="warn">近似音 ${r.approx}</span>`);
  if (r.dropped) parts.push(`<span class="warn">省略 ${r.dropped}</span>`);
  el('ph-summary').innerHTML = parts.join('　');

  // カポ候補（自動のときだけ）: 弾きやすさの差を表示、クリックでそのカポに固定
  const box = el('ph-capo-cands');
  box.innerHTML = '';
  if (ph.capo !== 'auto' || !r.events.length) return;
  const best = Math.min(...r.candidates.map(c => c.cost));
  const label = document.createElement('span');
  label.className = 'hint';
  label.textContent = 'カポ候補（数字が小さいほど弾きやすい / クリックで固定）:';
  box.appendChild(label);
  for (const c of r.candidates) {
    const b = document.createElement('button');
    b.className = 'ph-cand' + (c.capo === r.capo ? ' best' : '');
    b.textContent = `${phCapoLabel(c.capo)} ${Number.isFinite(c.cost) ? '+' + (c.cost - best).toFixed(1) : '×'}`;
    b.addEventListener('click', () => {
      ph.capo = c.capo;
      el('ph-capo').value = String(c.capo);
      phChanged();
    });
    box.appendChild(b);
  }
}

// ------------------------------------------------------------
// チューニング：弦ごとの調整と、自動のときの探索・候補
// ------------------------------------------------------------
function renderPhTuning() {
  const off = phTuning();
  const sel = el('ph-tuning');
  const preset = TabEngine.presetOf(off);
  sel.querySelector('option[value="custom"]').hidden = ph.tuning === 'auto' || !!preset;
  sel.value = ph.tuning === 'auto' ? 'auto' : preset ? `p${TabEngine.TUNING_PRESETS.indexOf(preset)}` : 'custom';
  const box = el('ph-strings');
  box.innerHTML = '';
  for (let st = 0; st < 6; st++) {
    const m = TabEngine.tuningOpen(off)[st];
    const d = off[st];
    const cell = document.createElement('div');
    cell.className = 'ph-string' + (d ? ' changed' : '');
    cell.innerHTML = `<span class="ph-sname">${6 - st}弦</span>` +
      `<button class="ph-tune-btn" data-d="-1" aria-label="${6 - st}弦を半音下げる"${d <= TabEngine.TUNE_MIN[st] ? ' disabled' : ''}>−</button>` +
      `<b>${phNoteName(m)}</b>` +
      `<button class="ph-tune-btn" data-d="1" aria-label="${6 - st}弦を半音上げる"${d >= TabEngine.TUNE_MAX[st] ? ' disabled' : ''}>＋</button>` +
      `<span class="ph-sdiff">${d ? (d > 0 ? '+' : '') + d : ''}</span>`;
    cell.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
      // 自動で選ばれているチューニングから手で変えたら、そこから固定に切り替える
      const next = phTuning().slice();
      next[st] += Number(b.dataset.d);
      if (next[st] < TabEngine.TUNE_MIN[st] || next[st] > TabEngine.TUNE_MAX[st]) return;
      ph.tuning = next;
      phChanged();
    }));
    box.appendChild(cell);
  }
  renderPhTuneCands();
}

function renderPhTuneCands() {
  const box = el('ph-tune-cands');
  box.innerHTML = '';
  if (ph.tuning !== 'auto') return;
  const t = phTuneSearch;
  if (!t || !t.cands) {
    box.innerHTML = `<span class="hint">最適なチューニングを探しています…${t ? ` ${Math.round(t.progress * 100)}%` : ''}</span>`;
    return;
  }
  const label = document.createElement('span');
  label.className = 'hint';
  label.textContent = 'チューニング候補（チューニングを変える手間も含めて、数字が小さいほど弾きやすい / クリックで固定）:';
  box.appendChild(label);
  const best = t.cands[0].cost;
  for (const c of t.cands.slice(0, 6)) {
    const b = document.createElement('button');
    b.className = 'ph-cand' + (c === t.cands[0] ? ' best' : '');
    b.textContent = `${c.name}${TabEngine.presetOf(c.off) ? '' : `（${TabEngine.tuningOpen(c.off).map(m => KEY_NAMES[m % 12]).join('')}）`} ${c === t.cands[0] ? '最適' : '+' + (c.cost - best).toFixed(1)}`;
    b.title = TabEngine.tuningOpen(c.off).map(m => KEY_NAMES[m % 12]).join(' ') + `・カポ ${phCapoLabel(c.capo)}`;
    b.addEventListener('click', () => {
      ph.tuning = c.off.slice();
      phChanged();
    });
    box.appendChild(b);
  }
}

// 自動のとき：入力が変わるたびに（少し待ってから）最適なチューニングを探し直す。
// 少しずつ計算して画面を止めない。見つかったら、そのチューニングで解き直す
function phScheduleTuneSearch() {
  clearTimeout(phTuneTimer);
  const gen = ++phTuneGen;
  if (ph.tuning !== 'auto') {
    phTuneSearch = null;
    return;
  }
  phTuneSearch = { gen, progress: 0, cands: null };
  renderPhTuneCands();
  phTuneTimer = setTimeout(() => {
    const steps = phSteps();
    const notes = ph.notes.filter(n => n.t < steps).map(n => ({ t: n.t, dur: Math.min(n.dur, steps - n.t), midi: phMidi(n.r) }));
    const it = TabEngine.searchTuning(notes, { stepSec: phStepSec(), capo: ph.capo, reach: ph.reach, prefer: ph.autoTuning || [0, 0, 0, 0, 0, 0] });
    const tick = () => {
      if (gen !== phTuneGen) return; // 入力が変わった：やり直しは新しい探索に任せる
      const t0 = performance.now();
      let r = it.next();
      while (!r.done && performance.now() - t0 < 14) r = it.next();
      if (!r.done) {
        phTuneSearch.progress = r.value.done / r.value.total;
        renderPhTuneCands();
        setTimeout(tick, 0);
        return;
      }
      phTuneSearch.cands = r.value.candidates;
      const prev = phTuning();
      ph.autoTuning = r.value.off;
      if (prev.some((x, i) => x !== r.value.off[i])) {
        savePhrase();
        solvePhrase();
        renderPhrase();
      } else {
        renderPhTuneCands();
      }
    };
    tick();
  }, 300);
}

// ------------------------------------------------------------
// 描画: TAB譜（ピアノロールと横軸を共有）
// ------------------------------------------------------------
function renderPhTab() {
  const steps = phSteps();
  const W = PR.left + steps * PR.cw + 8;
  const H = TB.top + TB.gap * 5 + 26;
  const xOf = t => PR.left + t * PR.cw;
  const yOf = s => TB.top + (5 - s) * TB.gap;
  const r = phResult;
  let s = `<svg id="ph-tab-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  s += `<rect x="0" y="0" width="${W}" height="${H}" fill="transparent"/>`;
  s += `<text x="8" y="${TB.top + TB.gap * 2.5 + 4}" class="ph-tab-label">TAB</text>`;
  for (let i = 0; i < 6; i++) {
    s += `<line x1="${PR.left}" y1="${yOf(i)}" x2="${xOf(steps)}" y2="${yOf(i)}" stroke="#4a5263" stroke-width="1"/>`;
    s += `<text x="${PR.left - 6}" y="${yOf(i) + 3.5}" text-anchor="end" class="ph-str-label">${6 - i}<tspan class="ph-open-name${phTuning()[i] ? ' changed' : ''}" dx="3">${phOpenName(i)}</tspan></text>`;
  }
  for (let b = 0; b <= ph.bars; b++) {
    const x = xOf(b * PH_STEPS_PER_BAR);
    s += `<line x1="${x}" y1="${yOf(5)}" x2="${x}" y2="${yOf(0)}" stroke="#69769a" stroke-width="1.5"/>`;
    if (b < ph.bars) s += `<text x="${x + 3}" y="10" class="ph-bar-num">${b + 1}</text>`;
  }
  r.events.forEach((ev, i) => {
    const st = r.path[i];
    if (!st) return;
    const tech = r.techs[i];
    const cx = xOf(ev.t) + PR.cw / 2;
    const info = TECH_INFO[tech.tech];
    const mark = info.mark || (tech.dir === 'up' ? '↑' : '↓');
    s += `<text x="${cx}" y="22" text-anchor="middle" class="ph-tech-mark ${info.cls}-txt">${mark}</text>`;
    for (const p of st.picks) {
      if (p.drop) continue;
      const rel = p.f - r.capo;
      const txt = (p.approx ? '≈' : '') + rel;
      const w = txt.length * 6.5 + 4;
      s += `<rect x="${cx - w / 2}" y="${yOf(p.s) - 6}" width="${w}" height="12" fill="var(--panel)"/>`;
      s += `<text x="${cx}" y="${yOf(p.s) + 4}" text-anchor="middle" class="ph-fret ${info.cls}-txt${p.approx ? ' approx' : ''}">${txt}</text>`;
    }
  });
  // 左手のポジション：動くところにだけ書く
  let lastHand = null;
  for (let i = 0; i < r.events.length; ) {
    const b = phHandBlock(i);
    if (!b) break;
    if (b.hand !== lastHand) {
      const x = xOf(r.events[b.from].t) + 2;
      s += `<text x="${x}" y="${H - 3}" class="ph-pos-mark">${lastHand == null ? '' : '⇢'}${b.hand - r.capo}f〜</text>`;
      lastHand = b.hand;
    }
    i = b.to + 1;
  }
  s += `<line id="ph-tab-head" x1="0" y1="14" x2="0" y2="${H}" stroke="#ff7b6b" stroke-width="2"/>`;
  s += '</svg>';
  const wrap = el('ph-tab');
  wrap.innerHTML = s;
  // TAB欄のクリックで表示位置を移動
  wrap.querySelector('svg').addEventListener('mousedown', e => {
    const x = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const t = Math.floor((x - PR.left) / PR.cw);
    if (t < 0 || t >= steps) return;
    phSeek(t, true);
  });
}

// ------------------------------------------------------------
// 描画: ピアノロール（行＝半音。白鍵＝キーのスケール音）
// ------------------------------------------------------------
function renderPhRoll() {
  const steps = phSteps();
  const W = PR.left + steps * PR.cw + 8;
  const H = PH_ROWS * PR.rh + 2;
  const xOf = t => PR.left + t * PR.cw;
  const yOf = r => (PH_ROWS - 1 - r) * PR.rh;
  let s = `<svg id="ph-roll-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  for (let r = 0; r < PH_ROWS; r++) {
    const rel = r % 12;
    const white = PH_MAJOR.includes(rel);
    const y = yOf(r);
    s += `<rect x="${PR.left}" y="${y}" width="${steps * PR.cw}" height="${PR.rh}" fill="${rel === 0 ? '#29303d' : white ? '#222731' : '#191c22'}"/>`;
    // 鍵盤（キーに合わせて白鍵の位置がずれる）
    s += `<rect x="2" y="${y + 0.5}" width="${PR.left - 6}" height="${PR.rh - 1}" rx="2" fill="${white ? '#d9d6ce' : '#2a2f3a'}"/>`;
    const name = phNoteName(phMidi(r));
    s += `<text x="${PR.left - 8}" y="${y + PR.rh - 3}" text-anchor="end" class="ph-key-label${white ? ' w' : ''}${rel === 0 ? ' tonic' : ''}">${name}</text>`;
  }
  for (let t = 0; t <= steps; t++) {
    const bar = t % PH_STEPS_PER_BAR === 0;
    const beat = t % 4 === 0;
    s += `<line x1="${xOf(t)}" y1="0" x2="${xOf(t)}" y2="${H}" stroke="${bar ? '#69769a' : beat ? '#3d4657' : '#262b35'}" stroke-width="${bar ? 1.5 : 1}"/>`;
  }
  for (const n of ph.notes) {
    if (n.t >= steps) continue;
    const info = phNoteInfo.get(n);
    const cls = info ? TECH_INFO[info.tech].cls + (info.approx ? ' t-approx' : '') + (info.drop ? ' t-drop' : '') : 't-pick';
    const w = Math.min(n.dur, steps - n.t) * PR.cw - 2;
    s += `<rect class="ph-note ${cls}" x="${xOf(n.t) + 1}" y="${yOf(n.r) + 1}" width="${w}" height="${PR.rh - 2}" rx="3"/>`;
  }
  s += `<line id="ph-roll-head" x1="0" y1="0" x2="0" y2="${H}" stroke="#ff7b6b" stroke-width="2" pointer-events="none"/>`;
  s += '</svg>';
  const wrap = el('ph-roll');
  wrap.innerHTML = s;
  wrap.querySelector('svg').addEventListener('mousedown', phRollMousedown);
}

function phRollPos(e) {
  const svg = document.getElementById('ph-roll-svg');
  const rc = svg.getBoundingClientRect();
  const x = e.clientX - rc.left;
  const y = e.clientY - rc.top;
  return { x, t: Math.floor((x - PR.left) / PR.cw), r: PH_ROWS - 1 - Math.floor(y / PR.rh) };
}

function phNoteAt(t, r) {
  return ph.notes.find(n => n.r === r && t >= n.t && t < n.t + n.dur);
}

// 伸ばせる上限: 同じ段の次の音、または最後まで
function phMaxDur(n) {
  let max = phSteps() - n.t;
  for (const o of ph.notes) if (o !== n && o.r === n.r && o.t > n.t) max = Math.min(max, o.t - n.t);
  return Math.max(1, max);
}

function phPreview(midi) {
  const c = audio();
  const src = pluck(midi, c.currentTime + 0.01, 0.8);
  src.stop(c.currentTime + 0.6);
}

function phRollMousedown(e) {
  const { x, t, r } = phRollPos(e);
  if (r < 0 || r >= PH_ROWS) return;
  if (x < PR.left) { // 鍵盤クリックは試聴のみ
    phPreview(phMidi(r));
    return;
  }
  if (t < 0 || t >= phSteps()) return;
  e.preventDefault();
  const hit = phNoteAt(t, r);
  if (hit) {
    phDrag = { note: hit, del: true };
    return;
  }
  const note = { t, dur: 1, r };
  ph.notes.push(note);
  note.dur = Math.min(phLastDur, phMaxDur(note));
  phPreview(phMidi(r));
  phDrag = { note, del: false };
  renderPhRoll();
}

document.addEventListener('mousemove', e => {
  if (!phDrag) return;
  const { t } = phRollPos(e);
  const n = phDrag.note;
  const dur = Math.max(1, Math.min(t - n.t + 1, phMaxDur(n)));
  if (dur !== n.dur) {
    n.dur = dur;
    phDrag.del = false;
    phLastDur = dur;
    renderPhRoll();
  }
});

document.addEventListener('mouseup', () => {
  if (!phDrag) return;
  if (phDrag.del) ph.notes = ph.notes.filter(n => n !== phDrag.note);
  phDrag = null;
  phChanged();
});

// ------------------------------------------------------------
// 描画: 指板（今のイベントの押さえ方＋次のイベントを薄く）
// ------------------------------------------------------------
function renderPhBoard() {
  const r = phResult;
  const capo = r.capo;
  const W = FB.nut + FB.fw * FB.frets + 14;
  const H = FB.top + FB.gap * 5 + 36;
  const yOf = s => FB.top + (5 - s) * FB.gap;
  const xFret = f => FB.nut + f * FB.fw; // フレット線の位置
  const xNote = f => (f > capo ? FB.nut + (f - 0.5) * FB.fw : (capo ? xFret(capo) - 20 : FB.nut - 18));
  const ci = phEventAt(phCursor);
  const ni = ci + 1 < r.events.length ? ci + 1 : -1;

  let s = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">`;
  s += `<rect x="${FB.nut}" y="${FB.top - 10}" width="${FB.fw * FB.frets}" height="${FB.gap * 5 + 20}" fill="#3a2a1e"/>`;
  // 左手の位置（人差し指〜小指の4フレット分）。同じ位置にいる区間で表示する
  const st = ci >= 0 ? r.path[ci] : null;
  const block = phHandBlock(ci);
  const nextBlock = block && block.to + 1 < r.events.length ? phHandBlock(block.to + 1) : null;
  if (block) {
    const hx = xFret(block.hand - 1);
    const rest = block.to - ci;
    s += `<rect x="${hx}" y="${FB.top - 14}" width="${FB.fw * 4}" height="${FB.gap * 5 + 28}" rx="6" fill="rgba(126,200,163,0.13)" stroke="rgba(126,200,163,0.45)"/>`;
    s += `<text x="${hx + 4}" y="${FB.top - 17}" class="ph-hand-label">左手 ${block.hand - capo}f〜${rest ? `（このまま あと${rest}音）` : ''}</text>`;
    // 次で移動するなら移動先を点線で
    if (nextBlock && block.to === ci && nextBlock.hand !== block.hand) {
      const nx = xFret(nextBlock.hand - 1);
      s += `<rect x="${nx}" y="${FB.top - 14}" width="${FB.fw * 4}" height="${FB.gap * 5 + 28}" rx="6" fill="none" stroke="rgba(255,190,90,0.8)" stroke-width="1.5" stroke-dasharray="5 4"/>`;
      s += `<text x="${nx + 4}" y="${FB.top - 17}" class="ph-hand-next">次: ${nextBlock.hand - capo}f〜へ移動</text>`;
    }
  }
  for (const f of [3, 5, 7, 9, 15, 17, 19, 21]) {
    s += `<circle cx="${FB.nut + (f - 0.5) * FB.fw}" cy="${FB.top + FB.gap * 2.5}" r="4" fill="#6b5640"/>`;
  }
  s += `<circle cx="${FB.nut + 11.5 * FB.fw}" cy="${FB.top + FB.gap * 1.5}" r="4" fill="#6b5640"/>`;
  s += `<circle cx="${FB.nut + 11.5 * FB.fw}" cy="${FB.top + FB.gap * 3.5}" r="4" fill="#6b5640"/>`;
  for (let f = 0; f <= FB.frets; f++) {
    s += `<line x1="${xFret(f)}" y1="${FB.top - 10}" x2="${xFret(f)}" y2="${FB.top + FB.gap * 5 + 10}" stroke="${f === 0 ? '#e8e0c8' : '#9a9486'}" stroke-width="${f === 0 ? 5 : 1.5}"/>`;
    if ([3, 5, 7, 9, 12, 15, 17, 19, 21].includes(f)) {
      s += `<text x="${FB.nut + (f - 0.5) * FB.fw}" y="${H - 4}" text-anchor="middle" class="fret-num">${f}</text>`;
    }
  }
  for (let i = 0; i < 6; i++) {
    s += `<line x1="${FB.nut}" y1="${yOf(i)}" x2="${W - 14}" y2="${yOf(i)}" stroke="#cfc7b0" stroke-width="${0.8 + (5 - i) * 0.28}"/>`;
    s += `<text x="4" y="${yOf(i) + 4}" class="ph-str-label">${6 - i}弦<tspan class="ph-open-name${phTuning()[i] ? ' changed' : ''}" dx="3">${phOpenName(i)}</tspan></text>`;
  }
  if (capo) {
    s += `<rect x="${xFret(capo) - 9}" y="${FB.top - 14}" width="8" height="${FB.gap * 5 + 28}" rx="3" fill="#8fa9d0"/>`;
    s += `<text x="${xFret(capo) - 5}" y="${FB.top - 17}" text-anchor="middle" class="capo-label">カポ</text>`;
  }
  // 印を付けた弦（1本の弦に印は1つだけ）
  const marked = new Set();
  if (st) for (const p of st.picks) if (!p.drop) marked.add(p.s);
  // 押さえたままにできる形を薄く（今鳴らしている音だけ濃く）
  // 左手が同じ位置にいる間で、前後の音のうち「同じ弦で別のフレットにならない」範囲だけ。
  // アルペジオなら押さえておく和音の形、単音の動きなら近くの音だけが出る
  if (block && st) {
    const fretOn = new Map(); // 弦 → フレット
    for (const p of st.picks) if (!p.drop) fretOn.set(p.s, p.f);
    const faint = [];
    const fits = k => r.path[k].picks.every(p => p.drop || !fretOn.has(p.s) || fretOn.get(p.s) === p.f);
    const take = k => {
      for (const p of r.path[k].picks) {
        if (p.drop || fretOn.has(p.s)) continue;
        fretOn.set(p.s, p.f);
        faint.push({ st: r.path[k], p });
      }
    };
    for (let k = ci + 1; k <= block.to && fits(k); k++) take(k);
    for (let k = ci - 1; k >= block.from && fits(k); k--) take(k);
    for (const { st: kst, p } of faint) {
      marked.add(p.s);
      const finger = r.fingerOf(kst, p);
      s += `<circle cx="${xNote(p.f)}" cy="${yOf(p.s)}" r="9" class="ph-dot-faint${finger === 0 ? ' open' : ''}"/>`;
      s += `<text x="${xNote(p.f)}" y="${yOf(p.s) + 4}" text-anchor="middle" class="ph-dot-faint-label">${finger}</text>`;
    }
  }
  // 次のイベント（点線の枠）。1本の弦に印は1つだけ（同じ弦に複数の印があると同時に押さえるように見える）
  if (ni >= 0 && r.path[ni]) {
    for (const p of r.path[ni].picks) {
      if (p.drop || marked.has(p.s)) continue;
      s += `<circle cx="${xNote(p.f)}" cy="${yOf(p.s)}" r="10" fill="none" stroke="#9aa0ab" stroke-width="1.5" stroke-dasharray="3 3"/>`;
    }
  }
  // 今のイベント
  if (st) {
    const cls = TECH_INFO[r.techs[ci].tech].cls;
    for (const p of st.picks) {
      if (p.drop) continue;
      const finger = r.fingerOf(st, p);
      const open = finger === 0;
      s += `<circle cx="${xNote(p.f)}" cy="${yOf(p.s)}" r="11" class="ph-dot ${open ? 'open' : cls}${p.approx ? ' t-approx' : ''}"/>`;
      s += `<text x="${xNote(p.f)}" y="${yOf(p.s) + 4.5}" text-anchor="middle" class="ph-dot-label${open ? ' open' : ''}">${finger}</text>`;
    }
  }
  s += '</svg>';
  el('ph-board').innerHTML = s;
  renderPhInfo(ci);
}

function renderPhInfo(ci) {
  const r = phResult;
  const box = el('ph-info');
  if (!r.events.length) {
    box.textContent = '下のピアノロールにフレーズを入力すると、押さえる位置を自動で割り出します';
    return;
  }
  if (ci < 0) {
    box.textContent = '▶で再生、またはシークバー・「次の音」で押さえ方を確認できます';
    return;
  }
  const ev = r.events[ci];
  const st = r.path[ci];
  const tech = r.techs[ci];
  const bar = Math.floor(ev.t / PH_STEPS_PER_BAR) + 1;
  const beat = (ev.t % PH_STEPS_PER_BAR) / 4 + 1;
  const dir = tech.tech === 'pick' ? (tech.dir === 'up' ? '（アップ↑）' : '（ダウン↓）') : '';
  const parts = st.picks.map(p => {
    const orig = ev.notes[p.note].midi;
    if (p.drop) return `<span class="warn">${phNoteName(orig)} は省略</span>`;
    const finger = r.fingerOf(st, p);
    const fingerTxt = finger === 'T' ? '右手タップ' : finger === 0 ? '開放' : `${finger}指`;
    const approx = p.approx ? ` <span class="warn">≈近似（元の音 ${phNoteName(orig)}）</span>` : '';
    return `<b>${phNoteName(p.midi)}</b> ${6 - p.s}弦 ${p.f - r.capo}f・${fingerTxt}${approx}`;
  });
  const block = phHandBlock(ci);
  const nextBlock = block && block.to + 1 < r.events.length ? phHandBlock(block.to + 1) : null;
  let hand = '';
  if (block && block.to === ci && nextBlock && nextBlock.hand !== block.hand) {
    hand = `<span class="ph-info-move">次の音で左手を ${block.hand - r.capo}f → ${nextBlock.hand - r.capo}f へ移動</span>`;
  } else if (block && block.to > ci) {
    hand = `<span class="ph-info-stay">左手そのまま（あと${block.to - ci}音）</span>`;
  }
  box.innerHTML = `<span class="ph-info-pos">${bar}小節 ${Number.isInteger(beat) ? beat + '拍' : beat.toFixed(2) + '拍'}</span>` +
    `<span class="ph-info-tech ${TECH_INFO[tech.tech].cls}-txt">${TECH_INFO[tech.tech].name}${dir}</span>` + parts.join('　/　') + hand;
}

// ------------------------------------------------------------
// 表示位置（カーソル）と再生
// ------------------------------------------------------------
function phUpdateCursor() {
  const x = PR.left + phCursor * PR.cw;
  for (const id of ['ph-tab-head', 'ph-roll-head']) {
    const line = document.getElementById(id);
    if (line) { line.setAttribute('x1', x); line.setAttribute('x2', x); }
  }
  el('ph-seek').value = Math.floor(phCursor);
  const bar = Math.floor(phCursor / PH_STEPS_PER_BAR) + 1;
  el('ph-pos').textContent = `${bar} / ${ph.bars}小節`;
  const ci = phEventAt(phCursor);
  if (ci !== phShownEvent) {
    phShownEvent = ci;
    renderPhBoard();
  }
  // 再生ヘッドが見えるようにスクロール
  const sc = el('ph-scroll');
  if (x < sc.scrollLeft + PR.left || x > sc.scrollLeft + sc.clientWidth - 40) {
    sc.scrollLeft = Math.max(0, x - PR.left - 40);
  }
}

// 手動で位置を動かす（再生していなければ、その位置の音を試聴）
function phSeek(t, preview) {
  if (phPlay) stopPhrase();
  const before = phEventAt(phCursor);
  phCursor = Math.max(0, Math.min(phSteps() - 1, t));
  phUpdateCursor();
  const ci = phEventAt(phCursor);
  if (preview && ci >= 0 && (ci !== before || phResult.events[ci].t === phCursor)) phPlayEvent(ci, audio().currentTime + 0.02, 0.6);
}

// 1イベント分を鳴らす（和音は低音弦から少しずらす）
function phPlayEvent(i, when, maxSec) {
  const r = phResult;
  const ev = r.events[i];
  const st = r.path[i];
  if (!st) return [];
  const tech = r.techs[i].tech;
  const vol = tech === 'hammer' || tech === 'pull' || tech.startsWith('slide') ? 0.55 : tech === 'tap' ? 0.65 : 0.85;
  const sounded = st.picks.filter(p => !p.drop).sort((a, b) => a.s - b.s);
  return sounded.map((p, k) => {
    const start = when + (sounded.length > 1 ? k * 0.02 : 0);
    const len = Math.min(maxSec, ev.notes[p.note].dur * phStepSec());
    const src = pluck(p.midi, start, vol);
    src.stop(start + len + 0.06);
    return src;
  });
}

function startPhrase() {
  if (!phResult.events.length) return;
  const c = audio();
  const lastT = phResult.events[phResult.events.length - 1].t;
  const from = phCursor > lastT ? 0 : Math.floor(phCursor);
  const start = c.currentTime + 0.08;
  const stepSec = phStepSec();
  const sources = [];
  phResult.events.forEach((ev, i) => {
    if (ev.t >= from) sources.push(...phPlayEvent(i, start + (ev.t - from) * stepSec, 30));
  });
  phPlay = { start, from, sources, timer: null };
  phPlay.timer = setInterval(() => {
    const cur = from + (actx.currentTime - start) / stepSec;
    if (cur >= phSteps()) {
      stopPhrase();
      phCursor = 0;
      phUpdateCursor();
      if (ph.loop) startPhrase();
      return;
    }
    phCursor = Math.max(from, cur);
    phUpdateCursor();
  }, 30);
  el('ph-play').textContent = '■ 停止';
}

function stopPhrase() {
  if (!phPlay) return;
  clearInterval(phPlay.timer);
  phPlay.sources.forEach(s => { try { s.stop(); } catch (e) { /* 停止済み */ } });
  phPlay = null;
  el('ph-play').textContent = '▶ 再生';
}

// ------------------------------------------------------------
// 変更時の再計算・全体描画
// ------------------------------------------------------------
// ------------------------------------------------------------
// Phrase Swipe（スマホ作曲アプリ）の「ギター用に書き出し」から読み込む
// メロディ・伴奏を別々に選んで、このピアノロールに実音のまま入れる（16分単位で同じグリッド）
// ------------------------------------------------------------
let phPsData = null;

function phPsParts(data) {
  const acc = Array.isArray(data.accomp) ? data.accomp : [];
  return {
    melody: Array.isArray(data.melody) ? data.melody : [],
    accomp: acc,
    chords: acc.filter(a => a.inst !== 'bass'),
    bass: acc.filter(a => a.inst === 'bass'),
  };
}

// 読み込むファイルを受け取り、どのパートを入れるか選んでもらう
function phOfferPhraseSwipe(data) {
  phPsData = data;
  const parts = phPsParts(data);
  const bars = Array.isArray(data.bars) ? data.bars.length : 0;
  el('ph-ps-title').textContent = `「${data.name || 'Phrase Swipe'}」${bars}小節: どれを読み込みますか？`;
  el('ph-ps').querySelectorAll('button[data-part]').forEach(b => {
    const list = parts[b.dataset.part];
    if (list) b.disabled = !list.length;
    if (list && !b.dataset.label) b.dataset.label = b.textContent;
    if (list) b.textContent = `${b.dataset.label} ${list.length}音`;
  });
  el('ph-ps').hidden = false;
}

function phImportPart(part) {
  const data = phPsData;
  el('ph-ps').hidden = true;
  phPsData = null;
  if (!data || part === 'cancel') return;
  const src = phPsParts(data)[part] || [];
  const sp = data.stepsPerBar || PH_STEPS_PER_BAR;
  const scale = PH_STEPS_PER_BAR / sp;
  // 小節数は入る中で一番小さい設定（最大16小節。はみ出す分は入らない）
  const total = Array.isArray(data.bars) && data.bars.length ? data.bars.length : 4;
  ph.bars = [1, 2, 4, 8, 16].find(b => b >= total) || 16;
  // マイナーは平行調のメジャーで（白鍵がそのキーの音になる）
  ph.key = ((data.key + (data.scale === 'minor' ? 3 : 0)) % 12 + 12) % 12;
  if (typeof data.bpm === 'number') ph.bpm = Math.min(240, Math.max(40, Math.round(data.bpm)));
  ph.capo = 'auto';
  const steps = phSteps();
  const seen = new Set();
  const notes = [];
  for (const a of src) {
    const t = Math.round(a.s * scale);
    if (t >= steps) continue;
    let r = a.p - phLow();
    while (r < 0) r += 12; // 音域外はオクターブで折り返す
    while (r >= PH_ROWS) r -= 12;
    const k = `${t}|${r}`;
    if (seen.has(k)) continue;
    seen.add(k);
    notes.push({ t, dur: Math.max(1, Math.min(Math.round(a.d * scale), steps - t)), r });
  }
  ph.notes = notes;
  phCursor = 0;
  el('ph-key').value = ph.key;
  el('ph-bpm').value = ph.bpm;
  el('ph-bars').value = ph.bars;
  el('ph-capo').value = 'auto';
  phChanged();
  const cut = total > 16 ? `（17小節目以降は入りません）` : '';
  el('ph-summary').insertAdjacentHTML('afterbegin', `<span class="ph-ps-done">Phrase Swipe から ${notes.length}音を読み込みました${cut}</span>　`);
}

function phChanged() {
  if (phPlay) stopPhrase();
  savePhrase();
  solvePhrase();
  renderPhrase();
  phScheduleTuneSearch();
}

function renderPhrase() {
  renderPhTuning();
  renderPhSummary();
  renderPhTab();
  renderPhRoll();
  el('ph-seek').max = phSteps() - 1;
  if (phCursor >= phSteps()) phCursor = 0;
  phShownEvent = -2;
  phUpdateCursor();
}

document.addEventListener('DOMContentLoaded', () => {
  const keySel = el('ph-key');
  KEY_NAMES.forEach((n, i) => keySel.add(new Option(n, i)));
  keySel.value = ph.key;
  keySel.addEventListener('change', () => { ph.key = Number(keySel.value); phChanged(); });

  const tunSel = el('ph-tuning');
  tunSel.add(new Option('自動（最適化）', 'auto'));
  TabEngine.TUNING_PRESETS.forEach((t, i) => tunSel.add(new Option(`${t.name}（${TabEngine.tuningOpen(t.off).map(m => KEY_NAMES[m % 12]).join(' ')}）`, `p${i}`)));
  tunSel.add(new Option('カスタム（弦ごとに設定）', 'custom'));
  tunSel.addEventListener('change', () => {
    const v = tunSel.value;
    if (v === 'auto') ph.tuning = 'auto';
    else if (v.startsWith('p')) ph.tuning = TabEngine.TUNING_PRESETS[Number(v.slice(1))].off.slice();
    else return;
    phChanged();
  });

  const bpm = el('ph-bpm');
  bpm.value = ph.bpm;
  bpm.addEventListener('change', () => {
    ph.bpm = Math.min(240, Math.max(40, Number(bpm.value) || 100));
    bpm.value = ph.bpm;
    phChanged();
  });

  const bars = el('ph-bars');
  [1, 2, 4, 8, 16].forEach(b => bars.add(new Option(`${b}`, b)));
  bars.value = ph.bars;
  bars.addEventListener('change', () => { ph.bars = Number(bars.value); phChanged(); });

  const capo = el('ph-capo');
  capo.add(new Option('自動（最適化）', 'auto'));
  for (let c = 0; c <= TabEngine.CAPO_MAX; c++) capo.add(new Option(phCapoLabel(c), c));
  capo.value = String(ph.capo);
  capo.addEventListener('change', () => {
    ph.capo = capo.value === 'auto' ? 'auto' : Number(capo.value);
    phChanged();
  });

  const reach = el('ph-reach');
  reach.add(new Option('普通（4フレット）', 4));
  reach.add(new Option('小さめ（3フレット・小指なし）', 3));
  reach.value = ph.reach;
  reach.addEventListener('change', () => { ph.reach = Number(reach.value); phChanged(); });

  el('ph-loop').checked = ph.loop;
  el('ph-loop').addEventListener('change', e => { ph.loop = e.target.checked; savePhrase(); });

  el('ph-clear').addEventListener('click', () => {
    if (ph.notes.length && !confirm('入力したフレーズをすべて消しますか？')) return;
    ph.notes = [];
    phCursor = 0;
    phChanged();
  });

  el('ph-ps-btn').addEventListener('click', () => el('ph-ps-file').click());
  el('ph-ps-file').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    f.text().then(text => {
      let data = null;
      try { data = JSON.parse(text); } catch (err) { /* 下で案内 */ }
      if (data && data.app === 'phrase-swipe') phOfferPhraseSwipe(data);
      else alert('Phrase Swipe の「ギター用に書き出し」で作ったファイルを選んでください');
    });
  });
  el('ph-ps').querySelectorAll('button[data-part]').forEach(b => b.addEventListener('click', () => phImportPart(b.dataset.part)));

  el('ph-play').addEventListener('click', () => (phPlay ? stopPhrase() : startPhrase()));
  el('ph-first').addEventListener('click', () => phSeek(0, false));
  el('ph-prev').addEventListener('click', () => {
    const ci = phEventAt(phCursor);
    const target = phResult.events[Math.max(0, ci - 1)];
    if (target) phSeek(target.t, true);
  });
  el('ph-next').addEventListener('click', () => {
    const target = phResult.events[phEventAt(phCursor) + 1];
    if (target) phSeek(target.t, true);
  });
  el('ph-seek').addEventListener('input', e => phSeek(Number(e.target.value), true));

  solvePhrase();
  renderPhrase();
  phScheduleTuneSearch();
});
