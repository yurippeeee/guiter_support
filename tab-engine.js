'use strict';

// ============================================================
// フレーズ→TAB 自動運指エンジン（DOM非依存）
//
// 入力: 音符 [{ t: 開始(16分単位), dur: 長さ, midi: 実音 }]
// 出力: 各発音タイミング（イベント）ごとの「どの弦の何フレットを、どの指・奏法で弾くか」
//
// 手順:
//  1. 同時に鳴り始める音を1イベント（和音）にまとめる
//  2. 各イベントの押さえ方候補を列挙（弦の重複なし・手の届く範囲に全部収まる・指の割り当てが可能）
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
    dropDup: 3,       // 和音から省略した音（同じ音名がほかにあるので響きは変わらない）
    reverse: 0.5,     // 低い弦ほど3フレット以上遠くなる逆向きの形（2フレットまでは C・G などの普通の形）
    fingerOff: 0.4,   // フレット位置どおりの指（人差し指=手の位置）からずれる1本あたり
    split: 0.2,       // 同じフレットを別々の指で押さえる（Gコードの6弦と1弦など）
    barre: 1.0,       // セーハ
    stringSkip: 0.4,  // 和音で間の弦をミュート
    handHeight: 0.03, // ハイポジションほど少し不利
    highFret: 0.25,   // 12フレットより上を押さえる（1フレットあたり。ネックの付け根は押さえにくい）
    shiftBase: 2.5,   // ポジション移動の基本コスト（手が動くこと自体が弾きにくい）
    shiftPer: 0.6,    // 1フレット移動あたり
    shiftFree: 0.6,   // 休符や開放弦の間に動ける移動は少し楽（倍率）
    crossing: 0.12,   // 単音の弦移動
    legato: -0.3,     // 速い同弦フレーズ（レガート可能）への優遇
    tap: 40,          // タッピング（ほかに弾き方がないときだけ使う）
    tapSlow: 3,       // ゆっくりな箇所でのタッピング
    tapCross: 1.0,    // 別の弦へのタッピング
    capoBase: 1.5,    // カポを付ける手間（なるべくカポ無しを優先）
    capo: 0.3,        // カポ1フレットあたり
    // チューニングを変える手間 = 種類ごとの基本（tier: なじみの薄いものほど大きい）＋弦ごとの量
    tunePer: 0.2,     // 1弦1半音あたり
    tuneUp: 0.8,      // 上げる（弦が張る）1半音あたりの上乗せ
    tuneCustom: 10,   // 名前のない（一般的でない）チューニングの基本
    tuneKeep: -2.0,   // 今のチューニングのまま（少しの差で入れ替わらないように）
    tuneMargin: 0.08, // レギュラーから変えるのは、弾きやすさがこの割合以上よくなるときだけ
    tuneShow: 12,     // 最良からこの差までの候補は最後まで計算する（候補として差を見せるため）
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
  // dupInChord: 同じ音名の音が和音の中にほかにある
  function noteOptions(note, open, capo, allowDrop, dupInChord) {
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
    if (allowDrop) opts.push({ drop: true, midi: note.midi, cost: dupInChord ? W.dropDup : W.drop });
    return opts;
  }

  // 手の届く範囲（フレット数）。4 = 人差し指〜小指で1フレット1本、3 = 小指を使わない（手が小さめ）
  let REACH = 4;

  // 押さえるフレット群に対する左手位置（人差し指のフレット）の候補とコスト
  // 押さえる音はすべて手の範囲（h 〜 h+REACH-1）に収める。はみ出す（ストレッチ）くらいなら手を動かす
  function handOptions(frets, capo) {
    const lo = capo + 1;
    const hi = MAX_FRET - 3;
    if (!frets.length) {
      // 開放弦だけ: 手はどこにあってもよい
      const out = [];
      for (let h = lo; h <= Math.min(hi, capo + 12); h++) out.push({ hand: h, cost: 0 });
      return out;
    }
    const distinct = [...new Set(frets)];
    const minF = Math.min(...distinct);
    const maxF = Math.max(...distinct);
    if (maxF - minF > REACH - 1 || distinct.length > REACH) return [];
    let base = 0;
    if (frets.length > 4) {
      // 5音以上はセーハ前提: 最低フレット以外が3指で押さえられること
      if (frets.filter(f => f !== minF).length > 3) return [];
      base += W.barre;
    }
    // 押さえにくさは指板上の実際の位置で決まる（カポを付けても同じ）
    const high12 = distinct.reduce((a, f) => a + Math.max(0, f - 12), 0);
    const out = [];
    for (let h = Math.max(lo, maxF - REACH + 1); h <= Math.min(hi, minF); h++) {
      out.push({ hand: h, cost: base + W.handHeight * h + W.highFret * high12 });
    }
    return out;
  }

  // 指の割り当て（人差し指=1〜小指=4）。押さえられなければ null
  //   同じフレットの音は、人差し指でまとめる（セーハ）か、別々の指で押さえる。中指・薬指・小指は1本の弦だけ
  //   指はフレットが低い方から順に（同じフレットを別々の指なら6弦側から）。手の位置 hand のフレットが人差し指の基本
  //   セーハの間の弦で開放弦は鳴らせない
  function assignFingers(sounded, hand, capo) {
    const fr = sounded.filter(p => p.f > capo);
    const fingers = new Map();
    if (!fr.length) return { cost: 0, fingers };
    const byFret = new Map();
    for (const p of fr) {
      if (!byFret.has(p.f)) byFret.set(p.f, []);
      byFret.get(p.f).push(p);
    }
    const groups = [...byFret.keys()].sort((a, b) => a - b).map(f => ({ f, items: byFret.get(f).sort((a, b) => a.s - b.s) }));
    let best = null;
    for (let mask = 0; mask < (1 << groups.length); mask++) {
      let prev = 0;
      let cost = 0;
      let ok = true;
      const fm = new Map();
      for (let g = 0; g < groups.length && ok; g++) {
        const { f, items } = groups[g];
        const natural = f - hand + 1;
        const split = (mask >> g) & 1;
        if (split && items.length < 2) { ok = false; break; }
        if (!split) {
          if (items.length > 1) {
            const ss = items.map(p => p.s);
            const lo = Math.min(...ss);
            const hi = Math.max(...ss);
            if (hi - lo + 1 !== ss.length) {
              // 離れた弦を1本の指で押さえるのはセーハ（一番低いフレット）だけ。間で開放弦は鳴らせない
              if (g !== 0 || sounded.some(p => p.f <= capo && p.s > lo && p.s < hi)) { ok = false; break; }
            }
          }
          const fg = Math.max(prev + 1, natural);
          if (fg > REACH) { ok = false; break; }
          // 複数の弦をまとめて押さえる（セーハ）のは人差し指だけ。中指・薬指・小指は1本の弦だけ
          if (items.length > 1 && fg !== 1) { ok = false; break; }
          cost += (fg - natural) * W.fingerOff;
          for (const p of items) fm.set(p.note, fg);
          prev = fg;
        } else {
          for (const p of items) {
            const fg = Math.max(prev + 1, natural);
            if (fg > REACH) { ok = false; break; }
            cost += (fg - natural) * W.fingerOff;
            fm.set(p.note, fg);
            prev = fg;
          }
          cost += W.split * (items.length - 1);
        }
      }
      if (ok && (!best || cost < best.cost)) best = { cost, fingers: fm };
    }
    return best;
  }

  // イベントの押さえ方候補（状態）を列挙
  function eventStates(ev, open, capo) {
    const multi = ev.notes.length > 1;
    const pcs = ev.notes.map(n => ((n.midi % 12) + 12) % 12);
    const optsPer = ev.notes.map((n, i) => noteOptions(n, open, capo, multi, pcs.some((pc, j) => j !== i && pc === pcs[i])));
    const assigns = [];
    const cur = [];
    const used = new Set();
    const usedMidi = new Map(); // 鳴らす実音 → 回数（近似で同じ音が重なるのを防ぐ）
    (function rec(i, cost) {
      if (assigns.length > 4000) return;
      if (i === optsPer.length) {
        assigns.push({ picks: cur.slice(), cost });
        return;
      }
      for (const o of optsPer[i]) {
        if (!o.drop && used.has(o.s)) continue;
        if (!o.drop && o.approx && usedMidi.get(o.midi)) continue;
        if (!o.drop) {
          used.add(o.s);
          usedMidi.set(o.midi, (usedMidi.get(o.midi) || 0) + 1);
        }
        cur.push({ ...o, note: i });
        rec(i + 1, cost + o.cost);
        cur.pop();
        if (!o.drop) {
          used.delete(o.s);
          usedMidi.set(o.midi, usedMidi.get(o.midi) - 1);
        }
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
      // 低い弦（6弦側）ほど遠いフレットを押さえる形は、指が逆向きに開くので押さえにくい
      const fp = sounded.filter(p => p.f > capo);
      for (let x = 0; x < fp.length; x++) {
        for (let y = 0; y < fp.length; y++) {
          const df = fp[y].f - fp[x].f;
          if (df >= 3 && fp[y].s < fp[x].s) extra += W.reverse * (df - 2);
        }
      }
      for (const h of handOptions(fretted, capo)) {
        const fa = assignFingers(sounded, h.hand, capo);
        if (!fa) continue;
        states.push({ picks: a.picks, sounded, hand: h.hand, tap: false, openOnly: !fretted.length, fingers: fa.fingers, cost: a.cost + extra + h.cost + fa.cost });
      }
    }
    // タッピング候補（単音のみ）: 左手はそのまま、右手で遠いフレットを叩く
    if (!multi) {
      for (const o of optsPer[0]) {
        if (o.drop || o.approx || o.f <= capo) continue;
        const picks = [{ ...o, note: 0 }];
        for (let h = Math.max(capo + 1, o.f - 12); h <= o.f - 5; h++) {
          states.push({ picks, sounded: picks, hand: h, tap: true, cost: W.tap });
        }
      }
    }
    states.sort((a, b) => a.cost - b.cost);
    return states.slice(0, MAX_STATES);
  }

  const soundedOf = st => st.sounded || st.picks.filter(p => !p.drop);

  // 状態間の移動コスト
  // free: 前の音が休符で終わっている・開放弦だけ、など左手が空いている間に動ける
  function transition(prev, cur, dtSec, free) {
    // 速いほど移動は難しい。ゆっくりでも移動そのものはタダにしない（下限1）
    const speed = clamp(0.25 / Math.max(dtSec, 0.01), 1, 4);
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
    const handFree = free || prev.openOnly; // 開放弦だけを鳴らしている間は左手が空いている
    let c = shift ? (W.shiftBase + shift * W.shiftPer) * speed * (handFree ? W.shiftFree : 1) : 0;
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

  // bound: これより悪くなることが確定したら打ち切る（チューニング探索の高速化）
  function solveWithCapo(events, open, capo, stepSec, bound = Infinity) {
    if (!events.length) return { capo, cost: capoCost(capo), path: [] };
    // 同じ音の組み合わせ（くり返す和音など）の候補は使い回す
    const memo = new Map();
    const layers = events.map(ev => {
      const key = ev.notes.map(n => n.midi).join(',');
      if (!memo.has(key)) memo.set(key, eventStates(ev, open, capo));
      return memo.get(key);
    });
    let dp = layers[0].map(s => s.cost);
    const back = [layers[0].map(() => -1)];
    for (let i = 1; i < events.length; i++) {
      const dtSec = (events[i].t - events[i - 1].t) * stepSec;
      const free = events[i - 1].t + events[i - 1].dur < events[i].t; // 前の音のあとに休符がある
      const prevLayer = layers[i - 1];
      const curLayer = layers[i];
      const nd = new Array(curLayer.length);
      const nb = new Array(curLayer.length);
      // 高速化：単音→単音以外の移動コストは「手の位置」と「開放弦だけか」だけで決まるので、
      // 前の候補をその組ごとにまとめ（一番小さい dp と、その最初の番号）、まとめて比べる。結果は全部比べた場合と同じ
      const groups = new Map(); // key → { rep, dp, j }（単音以外の候補）
      const singleGroups = new Map(); // 単音の候補（今が和音のとき用）
      const singles = []; // 単音の候補（今も単音のときは1つずつ比べる）
      for (let j = 0; j < prevLayer.length; j++) {
        if (dp[j] === Infinity) continue;
        const pv = prevLayer[j];
        const isSingle = soundedOf(pv).length === 1;
        const key = pv.hand * 2 + (pv.openOnly ? 1 : 0);
        const g = isSingle ? singleGroups : groups;
        const cur = g.get(key);
        if (!cur || dp[j] < cur.dp) g.set(key, { rep: pv, dp: dp[j], j });
        if (isSingle) singles.push(j);
      }
      // 単音→単音以外の部分は今の候補の手の位置だけで決まるので、手の位置ごとに1回だけ計算する
      const groupList = [...groups.values()];
      const allGroupList = groupList.concat([...singleGroups.values()]);
      const cacheMulti = new Map();
      const cacheBase = new Map();
      const bestOver = (list, cur) => {
        let b = Infinity;
        let a = -1;
        for (let k = 0; k < list.length; k++) {
          const g = list[k];
          const v = g.dp + transition(g.rep, cur, dtSec, free);
          if (v < b || (v === b && g.j < a)) { b = v; a = g.j; }
        }
        return { b, a };
      };
      for (let c = 0; c < curLayer.length; c++) {
        const cur = curLayer[c];
        let best = Infinity;
        let arg = -1;
        if (cur.tap) {
          for (let j = 0; j < prevLayer.length; j++) {
            if (dp[j] === Infinity) continue;
            const v = dp[j] + transition(prevLayer[j], cur, dtSec, free);
            if (v < best || (v === best && j < arg)) { best = v; arg = j; }
          }
        } else if (soundedOf(cur).length === 1) {
          let r = cacheBase.get(cur.hand);
          if (!r) cacheBase.set(cur.hand, (r = bestOver(groupList, cur)));
          best = r.b;
          arg = r.a;
          for (let k = 0; k < singles.length; k++) {
            const j = singles[k];
            const v = dp[j] + transition(prevLayer[j], cur, dtSec, free);
            if (v < best || (v === best && j < arg)) { best = v; arg = j; }
          }
        } else {
          let r = cacheMulti.get(cur.hand);
          if (!r) cacheMulti.set(cur.hand, (r = bestOver(allGroupList, cur)));
          best = r.b;
          arg = r.a;
        }
        nd[c] = best + cur.cost;
        nb[c] = arg;
      }
      dp = nd;
      back.push(nb);
      if (bound < Infinity) {
        // 残りのイベントで下がりうるのはレガートの優遇だけ
        let m = Infinity;
        for (const v of nd) if (v < m) m = v;
        if (m + capoCost(capo) + W.legato * (events.length - 1 - i) > bound) return { capo, cost: Infinity, path: null };
      }
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
    if (st.fingers && st.fingers.has(p.note)) return st.fingers.get(p.note);
    return clamp(p.f - st.hand + 1, 1, 4);
  }

  // メイン: notes と設定から最適な運指を求める
  // opts: { open: 6弦→1弦の開放弦MIDI, stepSec: 16分1つの秒数, capo: 'auto' | 数値, reach: 3 | 4（手の届くフレット数） }
  function solve(notes, opts) {
    REACH = opts.reach === 3 ? 3 : 4;
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

  // ------------------------------------------------------------
  // チューニング（弦ごと）
  // off: 6弦→1弦の、レギュラー（E A D G B E）からの半音差
  // ------------------------------------------------------------
  const STANDARD = [40, 45, 50, 55, 59, 64];
  const TUNE_MIN = [-4, -4, -4, -4, -4, -4];
  const TUNE_MAX = [2, 2, 2, 2, 2, 1]; // 上げすぎると弦が切れる（1弦は半音まで）
  const TUNING_PRESETS = [
    { name: 'レギュラー', off: [0, 0, 0, 0, 0, 0], tier: 0 },
    { name: 'ドロップD', off: [-2, 0, 0, 0, 0, 0], tier: 3 },
    { name: '半音下げ', off: [-1, -1, -1, -1, -1, -1], tier: 4 },
    { name: '全音下げ', off: [-2, -2, -2, -2, -2, -2], tier: 5 },
    { name: '1音半下げ', off: [-3, -3, -3, -3, -3, -3], tier: 6 },
    { name: 'ダブルドロップD', off: [-2, 0, 0, 0, 0, -2], tier: 6 },
    { name: 'ドロップC#', off: [-3, -1, -1, -1, -1, -1], tier: 6 },
    { name: 'ドロップC', off: [-4, -2, -2, -2, -2, -2], tier: 6 },
    { name: 'DADGAD', off: [-2, 0, 0, 0, -2, -2], tier: 6 },
    { name: 'オープンD', off: [-2, 0, 0, -1, -2, -2], tier: 6 },
    { name: 'オープンDm', off: [-2, 0, 0, -2, -2, -2], tier: 6 },
    { name: 'オープンG', off: [-2, -2, 0, 0, 0, -2], tier: 6 },
    { name: 'オープンC', off: [-4, -2, -2, 0, 1, 0], tier: 8 },
    { name: 'オープンE', off: [0, 2, 2, 1, 0, 0], tier: 8 },
    { name: 'オープンA', off: [0, 0, 2, 2, 2, 0], tier: 8 },
    { name: '4度チューニング', off: [0, 0, 0, 0, 1, 1], tier: 9 },
  ];
  const sameOff = (a, b) => a.every((x, i) => x === b[i]);
  const presetOf = off => TUNING_PRESETS.find(p => sameOff(p.off, off)) || null;
  const tuningOpen = off => STANDARD.map((m, i) => m + off[i]);
  const validOff = off => Array.isArray(off) && off.length === 6 && off.every((x, i) => Number.isInteger(x) && x >= TUNE_MIN[i] && x <= TUNE_MAX[i]);

  // チューニングを変える手間（弾きやすさのコストと同じ単位）
  function tuningCost(off) {
    if (off.every(x => x === 0)) return 0;
    const p = presetOf(off);
    let c = p ? p.tier : W.tuneCustom;
    for (const x of off) c += Math.abs(x) * W.tunePer + Math.max(0, x) * W.tuneUp;
    return c;
  }

  // 最適なチューニングを探す（少しずつ計算して進み具合を返すジェネレーター。最後に結果を return）
  // opts: solve と同じ（open は使わない）＋ prefer: 今のチューニング（少し優先して、わずかな差では変えない）
  // 1. よく使うチューニングを全部試す（カポも含めて）
  // 2. 一番よいものから、1本ずつ弦を ±1〜2 半音動かして良くなれば採用（名前のないチューニングも見つける）
  function* searchTuning(notes, opts) {
    REACH = opts.reach === 3 ? 3 : 4;
    const events = groupEvents(notes);
    const capos = opts.capo === 'auto' ? [...Array(CAPO_MAX + 1).keys()] : [opts.capo];
    const prefer = validOff(opts.prefer) ? opts.prefer : null;
    const seen = new Map(); // チューニング＋カポの範囲 → 評価
    let margin = 0;
    let bestTotal = Infinity;
    const total = TUNING_PRESETS.length * capos.length + 2 * 18;
    let done = 0;
    // 1つのチューニングを評価（カポごとに解いて一番よいもの）。1回解くごとに進み具合を返す
    function* evaluate(off, cs) {
      const k = off.join(',') + '|' + cs.join(',');
      if (seen.has(k)) return seen.get(k);
      const tune = tuningCost(off);
      const extra = tune + (prefer && sameOff(prefer, off) ? W.tuneKeep : 0) + (off.some(x => x) ? margin : 0);
      let best = null;
      for (const c of cs) {
        // すでに見つかっている最良より確実に悪くなる途中で打ち切る
        const r = solveWithCapo(events, tuningOpen(off), c, opts.stepSec, bestTotal + W.tuneShow - extra);
        if (!best || r.cost < best.cost) best = r;
        yield { done: Math.min(total - 1, ++done), total };
      }
      const res = { off: off.slice(), capo: best.capo, play: best.cost, tune, cost: best.cost + extra, full: cs.length === capos.length };
      seen.set(k, res);
      if (res.full && res.cost < bestTotal) bestTotal = res.cost;
      return res;
    }
    const all = () => [...seen.values()].filter(r => r.full && Number.isFinite(r.cost));
    // 1. よく使うチューニング（最初にレギュラーを解いて、変える価値の基準 margin を決める）
    for (const p of TUNING_PRESETS) {
      const r = yield* evaluate(p.off, capos);
      if (p.tier === 0 && Number.isFinite(r.play)) margin = W.tuneMargin * r.play;
    }
    if (prefer && !presetOf(prefer)) yield* evaluate(prefer, capos);
    // 2. 一番よいものから、弦を1本ずつ下げる（-1・-2）／半音上げる。元の形から動かす弦は2本まで
    let cur = all().reduce((a, b) => (b.cost < a.cost ? b : a));
    const base = cur.off.slice();
    for (let iter = 0; iter < 2 && events.length; iter++) {
      let bestN = null;
      for (let st = 0; st < 6; st++) {
        for (const d of [-2, -1, 1]) {
          const off = cur.off.slice();
          off[st] += d;
          if (off[st] < TUNE_MIN[st] || off[st] > TUNE_MAX[st]) continue;
          if (off[st] - base[st] > 1 || off[st] - base[st] < -2) continue;
          if (off.filter((x, i) => x !== base[i]).length > 2) continue;
          const r = yield* evaluate(off, [cur.capo]);
          if (Number.isFinite(r.cost) && (!bestN || r.cost < bestN.cost)) bestN = r;
        }
      }
      if (!bestN || bestN.cost >= cur.cost) break;
      const full = yield* evaluate(bestN.off, capos);
      if (!(full.cost < cur.cost)) break;
      cur = full;
    }
    const ranked = all().sort((a, b) => a.cost - b.cost);
    return {
      off: ranked[0].off,
      capo: ranked[0].capo,
      candidates: ranked.map(r => ({ off: r.off, name: tuningName(r.off), capo: r.capo, cost: r.cost, play: r.play, tune: r.tune })),
    };
  }

  // 全部まとめて計算する（テスト・Node 用）
  function bestTuning(notes, opts) {
    const it = searchTuning(notes, opts);
    let r = it.next();
    while (!r.done) r = it.next();
    return r.value;
  }

  const tuningName = off => (presetOf(off) || { name: 'カスタム' }).name;

  return {
    solve, MAX_FRET, CAPO_MAX,
    STANDARD, TUNING_PRESETS, TUNE_MIN, TUNE_MAX,
    presetOf, tuningName, tuningOpen, tuningCost, validOff, searchTuning, bestTuning,
  };
})();

if (typeof module !== 'undefined') module.exports = TabEngine;
