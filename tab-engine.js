'use strict';

// ============================================================
// フレーズ→TAB 自動運指エンジン（DOM非依存）
//
// 入力: 音符 [{ t: 開始(16分単位), dur: 長さ, midi: 実音 }]
// 出力: 各発音タイミング（イベント）ごとの「どの弦の何フレットを、どの指・奏法で弾くか」
//
// 手順:
//  1. 同時に鳴り始める音を1イベント（和音）にまとめる
//  2. 各イベントの押さえ方候補を列挙（弦の重複なし・手の届く範囲・左手位置）
//     押さえられない音はオクターブ移動で近似、和音で無理な音は省略
//  3. 移動コスト（ポジション移動×速さ、弦移動、ストレッチ…）の合計が最小になる
//     経路を動的計画法（ビタビ）で求める
//  4. カポ位置ごとに 1〜3 を行い、一番弾きやすいカポを選ぶ
//  5. 経路から奏法（ピッキング／ハンマリング／プリング／スライド／タッピング）を判定
// ============================================================
const TabEngine = (() => {
  const MAX_FRET = 22;
  const CAPO_MAX = 7;
  const MAX_STATES = 90; // 1イベントあたりの候補数の上限（計算量の制限）
  const LEGATO_SEC = 0.2; // これより速い同弦の音の動きはレガート（ハンマリング・プリング）で弾く

  // コストの重み（小さいほど弾きやすい）
  const W = {
    approxOct: 12,    // 1オクターブずらした近似音
    drop: 25,         // 和音から省略した音
    stretch: 1.2,     // 4フレットを超える指の開き
    barre: 1.0,       // セーハ
    stringSkip: 0.4,  // 和音で間の弦をミュート
    handHeight: 0.04, // ハイポジションほど少し不利
    shiftBase: 1.0,   // ポジション移動の基本コスト
    shiftPer: 0.5,    // 1フレット移動あたり
    crossing: 0.12,   // 単音の弦移動
    legato: -0.3,     // 速い同弦フレーズ（レガート可能）への優遇
    tap: 2.5,         // タッピング
    tapSlow: 3,       // ゆっくりな箇所でのタッピング
    tapCross: 1.0,    // 別の弦へのタッピング
    capoBase: 1.5,    // カポを付ける手間（なるべくカポ無しを優先）
    capo: 0.3,        // カポ1フレットあたり
  };

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  // 同時に鳴り始める音をまとめる
  function groupEvents(notes) {
    const byT = new Map();
    for (const n of notes) {
      if (!byT.has(n.t)) byT.set(n.t, []);
      byT.get(n.t).push(n);
    }
    return [...byT.keys()].sort((a, b) => a - b).map(t => {
      const ns = byT.get(t).slice().sort((a, b) => b.midi - a.midi);
      return { t, notes: ns, dur: Math.max(...ns.map(n => n.dur)) };
    });
  }

  // ある音を弾ける (弦, 絶対フレット) の一覧
  function directCands(midi, open, capo) {
    const out = [];
    for (let s = 0; s < 6; s++) {
      const f = midi - open[s];
      if (f >= capo && f <= MAX_FRET) out.push({ s, f });
    }
    return out;
  }

  // 1音の選択肢: そのまま / オクターブ近似 / 省略（和音のみ）
  function noteOptions(note, open, capo, allowDrop) {
    let opts = directCands(note.midi, open, capo).map(c => ({ ...c, midi: note.midi, approx: 0, cost: 0 }));
    if (!opts.length) {
      for (const k of [12, 24]) {
        for (const shift of [k, -k]) {
          for (const c of directCands(note.midi + shift, open, capo)) {
            opts.push({ ...c, midi: note.midi + shift, approx: shift, cost: W.approxOct * k / 12 });
          }
        }
        if (opts.length) break;
      }
    }
    if (allowDrop) opts.push({ drop: true, midi: note.midi, cost: W.drop });
    return opts;
  }

  // 押さえるフレット群に対する左手位置（人差し指のフレット）の候補とコスト
  function handOptions(frets, capo) {
    const lo = capo + 1;
    const hi = MAX_FRET - 3;
    if (!frets.length) {
      // 開放弦だけ: 手はどこにあってもよい
      const out = [];
      for (let h = lo; h <= Math.min(hi, capo + 12); h++) out.push({ hand: h, cost: 0 });
      return out;
    }
    const minF = Math.min(...frets);
    const maxF = Math.max(...frets);
    if (maxF - minF > 5) return [];
    let base = 0;
    if (frets.length > 4) {
      // 5音以上はセーハ前提: 最低フレット以外が3指で押さえられること
      if (frets.filter(f => f !== minF).length > 3) return [];
      base += W.barre;
    }
    const out = [];
    for (let h = Math.max(lo, maxF - 4); h <= Math.min(hi, minF + 1); h++) {
      let c = base;
      let ok = true;
      for (const f of frets) {
        if (f >= h && f <= h + 3) continue;
        if (f === h + 4 || f === h - 1) c += W.stretch;
        else { ok = false; break; }
      }
      if (ok) out.push({ hand: h, cost: c + W.handHeight * h });
    }
    return out;
  }

  // イベントの押さえ方候補（状態）を列挙
  function eventStates(ev, open, capo) {
    const multi = ev.notes.length > 1;
    const optsPer = ev.notes.map(n => noteOptions(n, open, capo, multi));
    const assigns = [];
    const cur = [];
    const used = new Set();
    (function rec(i, cost) {
      if (assigns.length > 4000) return;
      if (i === optsPer.length) {
        assigns.push({ picks: cur.slice(), cost });
        return;
      }
      for (const o of optsPer[i]) {
        if (!o.drop && used.has(o.s)) continue;
        if (!o.drop) used.add(o.s);
        cur.push({ ...o, note: i });
        rec(i + 1, cost + o.cost);
        cur.pop();
        if (!o.drop) used.delete(o.s);
      }
    })(0, 0);

    const states = [];
    for (const a of assigns) {
      const sounded = a.picks.filter(p => !p.drop);
      if (!sounded.length && ev.notes.length) continue;
      const fretted = sounded.filter(p => p.f > capo).map(p => p.f);
      let extra = 0;
      if (sounded.length > 1) {
        const ss = sounded.map(p => p.s);
        const lo = Math.min(...ss);
        const hi = Math.max(...ss);
        extra += W.stringSkip * ((hi - lo + 1) - ss.length);
      }
      for (const h of handOptions(fretted, capo)) {
        states.push({ picks: a.picks, hand: h.hand, tap: false, cost: a.cost + extra + h.cost });
      }
    }
    // タッピング候補（単音のみ）: 左手はそのまま、右手で遠いフレットを叩く
    if (!multi) {
      for (const o of optsPer[0]) {
        if (o.drop || o.approx || o.f <= capo) continue;
        for (let h = Math.max(capo + 1, o.f - 12); h <= o.f - 5; h++) {
          states.push({ picks: [{ ...o, note: 0 }], hand: h, tap: true, cost: W.tap });
        }
      }
    }
    states.sort((a, b) => a.cost - b.cost);
    return states.slice(0, MAX_STATES);
  }

  const soundedOf = st => st.picks.filter(p => !p.drop);

  // 状態間の移動コスト
  function transition(prev, cur, dtSec) {
    const speed = clamp(0.25 / Math.max(dtSec, 0.01), 0.4, 5);
    const ps = soundedOf(prev);
    const cs = soundedOf(cur);
    const single = ps.length === 1 && cs.length === 1;
    if (cur.tap) {
      if (prev.hand !== cur.hand) return Infinity;
      let c = 0;
      if (!single || ps[0].s !== cs[0].s) c += W.tapCross;
      if (dtSec > 0.35) c += W.tapSlow;
      return c;
    }
    const shift = Math.abs(cur.hand - prev.hand);
    let c = shift ? (W.shiftBase + shift * W.shiftPer) * speed : 0;
    if (single) {
      c += W.crossing * Math.abs(cs[0].s - ps[0].s);
      const df = Math.abs(cs[0].f - ps[0].f);
      if (cs[0].s === ps[0].s && !shift && dtSec <= LEGATO_SEC && df > 0 && df <= 4 && !cs[0].approx && !ps[0].approx) {
        c += W.legato;
      }
    }
    return c;
  }

  // ビタビ（最小コスト経路）
  function capoCost(capo) {
    return capo ? W.capoBase + capo * W.capo : 0;
  }

  function solveWithCapo(events, open, capo, stepSec) {
    if (!events.length) return { capo, cost: capoCost(capo), path: [] };
    const layers = events.map(ev => eventStates(ev, open, capo));
    let dp = layers[0].map(s => s.cost);
    const back = [layers[0].map(() => -1)];
    for (let i = 1; i < events.length; i++) {
      const dtSec = (events[i].t - events[i - 1].t) * stepSec;
      const nd = [];
      const nb = [];
      for (const cur of layers[i]) {
        let best = Infinity;
        let arg = -1;
        layers[i - 1].forEach((prev, j) => {
          if (dp[j] === Infinity) return;
          const v = dp[j] + transition(prev, cur, dtSec);
          if (v < best) { best = v; arg = j; }
        });
        nd.push(best + cur.cost);
        nb.push(arg);
      }
      dp = nd;
      back.push(nb);
    }
    let bi = -1;
    let bc = Infinity;
    dp.forEach((v, i) => { if (v < bc) { bc = v; bi = i; } });
    if (bi < 0) return { capo, cost: Infinity, path: null };
    const path = new Array(events.length);
    for (let i = events.length - 1; i >= 0; i--) {
      path[i] = layers[i][bi];
      bi = back[i][bi];
    }
    return { capo, cost: bc + capoCost(capo), path };
  }

  // 奏法の判定
  function techniques(events, path, stepSec) {
    const sixteenth = events.some(ev => ev.t % 2 === 1);
    const pickDir = t => (sixteenth ? (t % 2 === 0) : (t % 4 === 0)) ? 'down' : 'up';
    return events.map((ev, i) => {
      const st = path[i];
      const cs = soundedOf(st);
      if (cs.length > 1) return { tech: 'chord', dir: 'down' };
      if (st.tap) return { tech: 'tap' };
      if (i > 0) {
        const pst = path[i - 1];
        const ps = soundedOf(pst);
        const pev = events[i - 1];
        const legatoTime = pev.t + pev.dur >= ev.t && (ev.t - pev.t) * stepSec <= LEGATO_SEC;
        if (ps.length === 1 && cs.length === 1 && ps[0].s === cs[0].s && legatoTime && !ps[0].approx && !cs[0].approx) {
          const df = cs[0].f - ps[0].f;
          const sameHand = pst.hand === st.hand || pst.tap;
          if (df > 0) return { tech: sameHand && df <= 4 ? 'hammer' : 'slideUp' };
          if (df < 0) return { tech: sameHand ? 'pull' : 'slideDown' };
        }
      }
      return { tech: 'pick', dir: pickDir(ev.t) };
    });
  }

  // 押さえる指（1=人差し指〜4=小指、0=開放、T=タッピング）
  function fingerOf(st, p, capo) {
    if (st.tap) return 'T';
    if (p.f <= capo) return 0;
    return clamp(p.f - st.hand + 1, 1, 4);
  }

  // メイン: notes と設定から最適な運指を求める
  // opts: { open: 6弦→1弦の開放弦MIDI, stepSec: 16分1つの秒数, capo: 'auto' | 数値 }
  function solve(notes, opts) {
    const events = groupEvents(notes);
    const capos = opts.capo === 'auto' ? [...Array(CAPO_MAX + 1).keys()] : [opts.capo];
    const results = capos.map(c => solveWithCapo(events, opts.open, c, opts.stepSec));
    const best = results.reduce((a, b) => (b.cost < a.cost ? b : a));
    const path = best.path || [];
    const techs = best.path ? techniques(events, path, opts.stepSec) : [];
    let approx = 0;
    let dropped = 0;
    for (const st of path) {
      for (const p of st.picks) {
        if (p.drop) dropped++;
        else if (p.approx) approx++;
      }
    }
    return {
      capo: best.capo,
      events,
      path,
      techs,
      approx,
      dropped,
      candidates: results.map(r => ({ capo: r.capo, cost: r.cost })),
      fingerOf: (st, p) => fingerOf(st, p, best.capo),
    };
  }

  return { solve, MAX_FRET, CAPO_MAX };
})();

if (typeof module !== 'undefined') module.exports = TabEngine;
