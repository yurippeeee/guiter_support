'use strict';

// ============================================================
// 音楽理論の基礎データ
// ============================================================

// キー名（シェイプキー・実音キーの表示用）
const KEY_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

// 開放弦のMIDIノート番号: 6弦(低E)→1弦(高E) ※レギュラーチューニング基準
const OPEN_MIDI = [40, 45, 50, 55, 59, 64];

// チューニング（全弦一律のオフセットなので押さえ方は変わらず、実音だけが変わる）
const TUNINGS = [
  { label: 'レギュラー', offset: 0 },
  { label: '半音下げ',   offset: -1 },
  { label: '全音下げ',   offset: -2 },
  { label: '1音半下げ',  offset: -3 },
];

// ディグリー（キーのルートからの半音数とラベル）
const DEGREES = [
  { pc: 0,  label: 'I' },
  { pc: 1,  label: '♭II' },
  { pc: 2,  label: 'II' },
  { pc: 3,  label: '♭III' },
  { pc: 4,  label: 'III' },
  { pc: 5,  label: 'IV' },
  { pc: 6,  label: '♯IV' },
  { pc: 7,  label: 'V' },
  { pc: 8,  label: '♭VI' },
  { pc: 9,  label: 'VI' },
  { pc: 10, label: '♭VII' },
  { pc: 11, label: 'VII' },
];

// ダイアトニックコードのデフォルトクオリティ（半音数 → クオリティ）
const DIATONIC_QUALITY = { 0: '', 2: 'm', 4: 'm', 5: '', 7: '', 9: 'm', 11: 'm7♭5' };

const QUALITIES = [
  '', 'm', '7', 'm7', 'maj7', 'sus4', 'sus2', 'add9', '6', 'm6', 'dim7', 'm7♭5', 'aug',
  'dim', 'mM7', '9', 'M9', 'm9', 'madd9', '69', '7sus4', '7♭9', '7♯9', 'm11', '13',
];
const QUALITY_LABELS = {
  '': 'メジャー', 'm': 'マイナー', '7': '7th', 'm7': 'm7', 'maj7': 'M7',
  'sus4': 'sus4', 'sus2': 'sus2', 'add9': 'add9', '6': '6', 'm6': 'm6',
  'dim7': 'dim7', 'm7♭5': 'm7♭5', 'aug': 'aug',
  'dim': 'dim', 'mM7': 'mM7', '9': '9th', 'M9': 'M9', 'm9': 'm9', 'madd9': 'madd9',
  '69': '6/9', '7sus4': '7sus4', '7♭9': '7♭9', '7♯9': '7♯9', 'm11': 'm11', '13': '13th',
};

// ピッチクラス定数
const PC = { C: 0, Db: 1, D: 2, Eb: 3, E: 4, F: 5, Fs: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };

// 各クオリティの構成音（ルートからの半音数）
const CHORD_INTERVALS = {
  '':      [0, 4, 7],
  'm':     [0, 3, 7],
  '7':     [0, 4, 7, 10],
  'm7':    [0, 3, 7, 10],
  'maj7':  [0, 4, 7, 11],
  'sus4':  [0, 5, 7],
  'sus2':  [0, 2, 7],
  'add9':  [0, 2, 4, 7],
  '6':     [0, 4, 7, 9],
  'm6':    [0, 3, 7, 9],
  'dim7':  [0, 3, 6, 9],
  'm7♭5':  [0, 3, 6, 10],
  'aug':   [0, 4, 8],
  'dim':   [0, 3, 6],
  'mM7':   [0, 3, 7, 11],
  '9':     [0, 2, 4, 7, 10],
  'M9':    [0, 2, 4, 7, 11],
  'm9':    [0, 2, 3, 7, 10],
  'madd9': [0, 2, 3, 7],
  '69':    [0, 2, 4, 7, 9],
  '7sus4': [0, 5, 7, 10],
  '7♭9':   [0, 1, 4, 7, 10],
  '7♯9':   [0, 3, 4, 7, 10],
  'm11':   [0, 3, 5, 7, 10],  // 9省略形を標準とする
  '13':    [0, 4, 7, 9, 10],  // 9・11省略形を標準とする
};

// ソロ練習用スケール
const SCALES = [
  { id: 'minor-penta', name: 'マイナーペンタトニック', intervals: [0, 3, 5, 7, 10] },
  { id: 'major-penta', name: 'メジャーペンタトニック', intervals: [0, 2, 4, 7, 9] },
  { id: 'blues',       name: 'ブルーススケール',       intervals: [0, 3, 5, 6, 7, 10] },
  { id: 'major',       name: 'メジャースケール',       intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor',       name: 'ナチュラルマイナー',     intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'dorian',      name: 'ドリアン',               intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'mixo',        name: 'ミクソリディアン',       intervals: [0, 2, 4, 5, 7, 9, 10] },
];

// スケールルートからの半音数 → インターバル表示
const INTERVAL_LABELS = ['R', '♭2', '2', '♭3', '3', '4', '♭5', '5', '♭6', '6', '♭7', '7'];

// ユーザー登録コード（app.jsがlocalStorageから読み書きする）
const USER_SHAPES = [];

// ============================================================
// コードシェイプ・データベース
// frets: 6弦(低E)→1弦(高E)。-1=ミュート, 0=開放(カポ位置), n=カポからnフレット
// ============================================================

// オープンコード（カポ位置をナットとみなした押さえ方）
const OPEN_SHAPES = {
  '': [
    { root: PC.C, frets: [-1, 3, 2, 0, 1, 0], name: 'Cフォーム' },
    { root: PC.A, frets: [-1, 0, 2, 2, 2, 0], name: 'Aフォーム' },
    { root: PC.G, frets: [3, 2, 0, 0, 0, 3],  name: 'Gフォーム' },
    { root: PC.E, frets: [0, 2, 2, 1, 0, 0],  name: 'Eフォーム' },
    { root: PC.D, frets: [-1, -1, 0, 2, 3, 2], name: 'Dフォーム' },
    { root: PC.G, frets: [3, 2, 0, 0, 3, 3],  name: 'Gフォーム(2)' },
  ],
  'm': [
    { root: PC.A, frets: [-1, 0, 2, 2, 1, 0], name: 'Amフォーム' },
    { root: PC.E, frets: [0, 2, 2, 0, 0, 0],  name: 'Emフォーム' },
    { root: PC.D, frets: [-1, -1, 0, 2, 3, 1], name: 'Dmフォーム' },
  ],
  '7': [
    { root: PC.C, frets: [-1, 3, 2, 3, 1, 0], name: 'C7フォーム' },
    { root: PC.A, frets: [-1, 0, 2, 0, 2, 0], name: 'A7フォーム' },
    { root: PC.B, frets: [-1, 2, 1, 2, 0, 2], name: 'B7フォーム' },
    { root: PC.G, frets: [3, 2, 0, 0, 0, 1],  name: 'G7フォーム' },
    { root: PC.E, frets: [0, 2, 0, 1, 0, 0],  name: 'E7フォーム' },
    { root: PC.D, frets: [-1, -1, 0, 2, 1, 2], name: 'D7フォーム' },
    { root: PC.E, frets: [0, 2, 0, 1, 3, 0],  name: 'E7フォーム(2)' },
    { root: PC.A, frets: [-1, 0, 2, 2, 2, 3], name: 'A7フォーム(2)' },
  ],
  'm7': [
    { root: PC.A, frets: [-1, 0, 2, 0, 1, 0], name: 'Am7フォーム' },
    { root: PC.E, frets: [0, 2, 0, 0, 0, 0],  name: 'Em7フォーム' },
    { root: PC.D, frets: [-1, -1, 0, 2, 1, 1], name: 'Dm7フォーム' },
    { root: PC.E, frets: [0, 2, 2, 0, 3, 3],  name: 'Em7フォーム(2)' },
    { root: PC.B, frets: [-1, 2, 0, 2, 0, 2], name: 'Bm7フォーム' },
  ],
  'maj7': [
    { root: PC.C, frets: [-1, 3, 2, 0, 0, 0], name: 'CM7フォーム' },
    { root: PC.A, frets: [-1, 0, 2, 1, 2, 0], name: 'AM7フォーム' },
    { root: PC.G, frets: [3, 2, 0, 0, 0, 2],  name: 'GM7フォーム' },
    { root: PC.E, frets: [0, 2, 1, 1, 0, 0],  name: 'EM7フォーム' },
    { root: PC.D, frets: [-1, -1, 0, 2, 2, 2], name: 'DM7フォーム' },
    { root: PC.F, frets: [-1, -1, 3, 2, 1, 0], name: 'FM7フォーム' },
  ],
  'sus4': [
    { root: PC.A, frets: [-1, 0, 2, 2, 3, 0], name: 'Asus4フォーム' },
    { root: PC.E, frets: [0, 2, 2, 2, 0, 0],  name: 'Esus4フォーム' },
    { root: PC.D, frets: [-1, -1, 0, 2, 3, 3], name: 'Dsus4フォーム' },
  ],
  'sus2': [
    { root: PC.A, frets: [-1, 0, 2, 2, 0, 0], name: 'Asus2フォーム' },
    { root: PC.D, frets: [-1, -1, 0, 2, 3, 0], name: 'Dsus2フォーム' },
  ],
  'add9': [
    { root: PC.C, frets: [-1, 3, 2, 0, 3, 0], name: 'Cadd9フォーム' },
    { root: PC.A, frets: [-1, 0, 2, 4, 2, 0], name: 'Aadd9フォーム' },
    { root: PC.E, frets: [0, 2, 2, 1, 0, 2],  name: 'Eadd9フォーム' },
  ],
  '6': [
    { root: PC.A, frets: [-1, 0, 2, 2, 2, 2], name: 'A6フォーム' },
    { root: PC.D, frets: [-1, -1, 0, 2, 0, 2], name: 'D6フォーム' },
    { root: PC.C, frets: [-1, 3, 2, 2, 1, 0], name: 'C6フォーム' },
  ],
  'm6': [
    { root: PC.A, frets: [-1, 0, 2, 2, 1, 2], name: 'Am6フォーム' },
    { root: PC.E, frets: [0, 2, 2, 0, 2, 0],  name: 'Em6フォーム' },
    { root: PC.D, frets: [-1, -1, 0, 2, 0, 1], name: 'Dm6フォーム' },
  ],
  'dim7': [],
  'm7♭5': [
    { root: PC.D, frets: [-1, -1, 0, 1, 1, 1], name: 'Dm7♭5フォーム' },
  ],
  'aug': [],
  'mM7': [
    { root: PC.A, frets: [-1, 0, 2, 1, 1, 0], name: 'AmM7フォーム' },
  ],
  'M9': [
    { root: PC.C, frets: [-1, 3, 0, 0, 0, 0], name: 'CM9フォーム' },
  ],
  'm9': [
    { root: PC.E, frets: [0, 2, 4, 0, 3, 0], name: 'Em9フォーム' },
  ],
};

// ムーバブルフォーム（バレーコード等、平行移動して任意のルートを作る）
// rootPc: バレー位置0のときのルート音。barreFrom: バレーが始まる弦(0=6弦)、nullはバレーなし
const MOVABLE_SHAPES = {
  '': [
    { rootPc: PC.E, frets: [0, 2, 2, 1, 0, 0],   name: 'Eフォーム・バレー', barreFrom: 0 },
    { rootPc: PC.A, frets: [-1, 0, 2, 2, 2, 0],  name: 'Aフォーム・バレー', barreFrom: 1 },
    { rootPc: PC.C, frets: [-1, 3, 2, 0, 1, 0],  name: 'Cフォーム・バレー', barreFrom: 1 },
    { rootPc: PC.D, frets: [-1, -1, 0, 2, 3, 2], name: 'Dフォーム', barreFrom: null },
  ],
  'm': [
    { rootPc: PC.E, frets: [0, 2, 2, 0, 0, 0],   name: 'Emフォーム・バレー', barreFrom: 0 },
    { rootPc: PC.A, frets: [-1, 0, 2, 2, 1, 0],  name: 'Amフォーム・バレー', barreFrom: 1 },
    { rootPc: PC.D, frets: [-1, -1, 0, 2, 3, 1], name: 'Dmフォーム', barreFrom: null },
  ],
  '7': [
    { rootPc: PC.E, frets: [0, 2, 0, 1, 0, 0],   name: 'E7フォーム・バレー', barreFrom: 0 },
    { rootPc: PC.A, frets: [-1, 0, 2, 0, 2, 0],  name: 'A7フォーム・バレー', barreFrom: 1 },
    { rootPc: PC.C, frets: [-1, 3, 2, 3, 1, 0],  name: 'C7フォーム・バレー', barreFrom: 1 },
    { rootPc: PC.D, frets: [-1, -1, 0, 2, 1, 2], name: 'D7フォーム', barreFrom: null },
  ],
  'm7': [
    { rootPc: PC.E, frets: [0, 2, 0, 0, 0, 0],   name: 'Em7フォーム・バレー', barreFrom: 0 },
    { rootPc: PC.A, frets: [-1, 0, 2, 0, 1, 0],  name: 'Am7フォーム・バレー', barreFrom: 1 },
    { rootPc: PC.D, frets: [-1, -1, 0, 2, 1, 1], name: 'Dm7フォーム', barreFrom: null },
  ],
  'maj7': [
    { rootPc: PC.E, frets: [0, 2, 1, 1, 0, 0],   name: 'EM7フォーム・バレー', barreFrom: 0 },
    { rootPc: PC.A, frets: [-1, 0, 2, 1, 2, 0],  name: 'AM7フォーム・バレー', barreFrom: 1 },
    { rootPc: PC.C, frets: [-1, 3, 2, 0, 0, 0],  name: 'CM7フォーム・バレー', barreFrom: 3 },
    { rootPc: PC.D, frets: [-1, -1, 0, 2, 2, 2], name: 'DM7フォーム', barreFrom: null },
  ],
  'sus4': [
    { rootPc: PC.E, frets: [0, 2, 2, 2, 0, 0],   name: 'Esus4フォーム・バレー', barreFrom: 0 },
    { rootPc: PC.A, frets: [-1, 0, 2, 2, 3, 0],  name: 'Asus4フォーム・バレー', barreFrom: 1 },
    { rootPc: PC.D, frets: [-1, -1, 0, 2, 3, 3], name: 'Dsus4フォーム', barreFrom: null },
  ],
  'sus2': [
    { rootPc: PC.A, frets: [-1, 0, 2, 2, 0, 0],  name: 'Asus2フォーム・バレー', barreFrom: 1 },
  ],
  'add9': [],
  '6': [
    { rootPc: PC.A, frets: [-1, 0, 2, 2, 2, 2],  name: 'A6フォーム・バレー', barreFrom: 1 },
    { rootPc: PC.D, frets: [-1, -1, 0, 2, 0, 2], name: 'D6フォーム', barreFrom: null },
  ],
  'm6': [
    { rootPc: PC.A, frets: [-1, 0, 2, 2, 1, 2],  name: 'Am6フォーム・バレー', barreFrom: 1 },
    { rootPc: PC.D, frets: [-1, -1, 0, 2, 0, 1], name: 'Dm6フォーム', barreFrom: null },
  ],
  'dim7': [
    { rootPc: PC.D, frets: [-1, -1, 0, 1, 0, 1], name: 'dim7フォーム', barreFrom: null },
  ],
  'm7♭5': [
    { rootPc: PC.A, frets: [-1, 0, 1, 0, 1, -1], name: 'm7♭5フォーム(5弦ルート)', barreFrom: null },
    { rootPc: PC.F, frets: [1, -1, 1, 1, 0, -1], name: 'm7♭5フォーム(6弦ルート)', barreFrom: null },
  ],
  'aug': [
    { rootPc: PC.A, frets: [-1, 0, 3, 2, 2, 1],  name: 'augフォーム', barreFrom: null },
  ],
  'dim': [
    { rootPc: PC.D, frets: [-1, -1, 0, 1, 3, 1], name: 'dimフォーム', barreFrom: null },
  ],
  'mM7': [
    { rootPc: PC.A, frets: [-1, 0, 2, 1, 1, 0],  name: 'AmM7フォーム・バレー', barreFrom: 1 },
  ],
  '9': [
    { rootPc: PC.Bb, frets: [-1, 1, 0, 1, 1, 1], name: '9thフォーム(5弦ルート)', barreFrom: null },
  ],
  'm9': [
    { rootPc: PC.B, frets: [-1, 2, 0, 2, 2, 2],  name: 'm9フォーム(5弦ルート)', barreFrom: null },
  ],
  '69': [
    { rootPc: PC.C, frets: [-1, 3, 2, 2, 3, 3],  name: '6/9フォーム(5弦ルート)', barreFrom: null },
  ],
  '7sus4': [
    { rootPc: PC.E, frets: [0, 2, 0, 2, 0, 0],   name: 'E7sus4フォーム・バレー', barreFrom: 0 },
    { rootPc: PC.A, frets: [-1, 0, 2, 0, 3, 0],  name: 'A7sus4フォーム・バレー', barreFrom: 1 },
  ],
  '7♭9': [
    { rootPc: PC.Bb, frets: [-1, 1, 0, 1, 0, -1], name: '7♭9フォーム(5弦ルート)', barreFrom: null },
  ],
  '7♯9': [
    { rootPc: PC.Bb, frets: [-1, 1, 0, 1, 2, -1], name: '7♯9フォーム(5弦ルート)', barreFrom: null },
  ],
  'm11': [
    { rootPc: PC.E, frets: [0, 0, 0, 0, 0, 0],   name: 'm11フォーム(全弦バレー)', barreFrom: 0 },
  ],
  '13': [
    { rootPc: PC.E, frets: [0, 2, 0, 1, 2, 0],   name: '13thフォーム(6弦ルート)', barreFrom: 0 },
  ],
  'madd9': [],
};

// ============================================================
// ボイシング検索
// rootPc: カポ基準のルート音（シェイプキー + ディグリー）
// 返り値の frets はすべてカポからの相対フレット
// ============================================================
// ============================================================
// 押さえ方の解析: fretsから候補コード（ルート＋クオリティ）を推定
// frets はカポからの相対フレット。返り値は確度順の候補リスト
// ============================================================
// 音程構造から名前を組み立てる汎用ネーミング（どんな音の集合でも何かしら名付ける）
function describeGeneric(root, pcs, bassPc) {
  const rel = new Set([...pcs].map(p => (p - root + 12) % 12));
  rel.delete(0);
  const has = x => rel.has(x);
  const used = new Set();
  let score = bassPc === root ? 4 : 0;

  // 3度
  const third = has(4) ? 4 : has(3) ? 3 : null;
  if (third !== null) { used.add(third); score += 2; }

  // 7度
  const seventh = has(10) ? 10 : has(11) ? 11 : null;
  if (seventh !== null) used.add(seventh);

  // 5度（変化5度としての解釈は7度なしのときだけ。7度があれば♯11/♭13のテンション扱い）
  let fifth = null;
  if (has(7)) { fifth = 7; used.add(7); score += 1; }
  else if (third !== null && seventh === null) {
    if (has(6)) { fifth = 6; used.add(6); }
    else if (has(8)) { fifth = 8; used.add(8); }
  }

  // sus（3度がない場合）
  let sus = '';
  if (third === null) {
    if (has(5)) { sus = 'sus4'; used.add(5); }
    else if (has(2)) { sus = 'sus2'; used.add(2); }
  }

  // コア組み立て
  const mm = third === 3 ? 'm' : '';
  let core;
  if (seventh === 10) core = mm + '7';
  else if (seventh === 11) core = third === 3 ? 'mM7' : 'M7';
  else core = mm;

  // 長6度（7度がない場合は6thコード）
  if (seventh === null && has(9) && !used.has(9)) { core += '6'; used.add(9); }

  if (sus) core += sus;

  // 変化5度
  if (fifth === 6) core = core === 'm' ? 'dim' : core + '♭5';
  else if (fifth === 8) core = core === '' ? 'aug' : core + '♯5';

  // 残りの音はテンション表記
  const tens = [];
  for (const x of [...rel].filter(x => !used.has(x)).sort((a, b) => a - b)) {
    if (x === 1)      { tens.push('♭9');  score -= 1.5; }
    else if (x === 2) { tens.push(seventh ? '9' : 'add9');   score -= 0.5; }
    else if (x === 3) { tens.push('♯9');  score -= 1.5; }
    else if (x === 5) { tens.push(seventh ? '11' : 'add11'); score -= 0.5; }
    else if (x === 6) { tens.push('♯11'); score -= 1.5; }
    else if (x === 8) { tens.push('♭13'); score -= 1.5; }
    else if (x === 9) { tens.push('13');  score -= 0.5; }
  }

  let suffix = core + (tens.length ? `(${tens.join(',')})` : '');
  if (suffix === '' && fifth === 7) suffix = '5'; // パワーコード
  return { suffix, score };
}

function analyzeShape(frets) {
  const sounding = [];
  for (let i = 0; i < 6; i++) {
    if (frets[i] >= 0) sounding.push({ pc: (OPEN_MIDI[i] + frets[i]) % 12, midi: OPEN_MIDI[i] + frets[i] });
  }
  if (sounding.length === 0) return [];
  const pcs = new Set(sounding.map(s => s.pc));
  const bassPc = sounding.reduce((a, b) => (a.midi < b.midi ? a : b)).pc;

  // 単音（オクターブ違い含む）
  if (pcs.size === 1) {
    return [{ root: bassPc, quality: '(単音)', bass: bassPc, exact: true, rootInBass: true }];
  }

  const results = [];

  // 1) 既知のコード表との照合（正確な名前を優先）
  for (const root of pcs) {
    const rel = new Set([...pcs].map(p => (p - root + 12) % 12));
    for (const q in CHORD_INTERVALS) {
      const formula = CHORD_INTERVALS[q];
      const full = new Set(formula);
      const omit5 = new Set(formula.filter(x => x !== 7));
      const eq = (a, b) => a.size === b.size && [...a].every(x => b.has(x));
      let exact = null;
      if (eq(rel, full)) exact = true;
      else if (formula.includes(7) && omit5.size >= 3 && eq(rel, omit5)) exact = false; // 5度省略
      if (exact !== null) {
        results.push({
          root, quality: q, bass: bassPc, exact,
          rootInBass: bassPc === root,
          score: 10 + (bassPc === root ? 4 : 0) + (exact ? 2 : 0) + formula.length * 0.3,
        });
      }
    }
  }

  // 2) 表に無い響きは汎用ネーミングで補完（ルート解釈ごとに1つ）
  for (const root of pcs) {
    if (results.some(r => r.root === root)) continue;
    const g = describeGeneric(root, pcs, bassPc);
    results.push({
      root, quality: g.suffix, bass: bassPc, exact: true,
      rootInBass: bassPc === root, generic: true, score: g.score,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 5);
}

function getVoicings(rootPc, quality) {
  const out = [];

  for (const s of (OPEN_SHAPES[quality] || [])) {
    if (s.root === rootPc) {
      out.push({
        frets: s.frets.slice(),
        base: 0,
        barre: null,
        name: `オープン ${s.name}`,
      });
    }
  }

  for (const t of (MOVABLE_SHAPES[quality] || [])) {
    let p = (rootPc - t.rootPc + 12) % 12;
    if (t.barreFrom !== null && p === 0) p = 12; // 開放と重複するので1オクターブ上へ
    if (t.barreFrom === null && p === 0 && out.length > 0) continue;
    out.push({
      frets: t.frets.map(f => (f < 0 ? -1 : f + p)),
      base: p,
      barre: (t.barreFrom !== null && p > 0) ? { fret: p, from: t.barreFrom } : null,
      name: p === 0 ? t.name : `${t.name} (${p}fr)`,
    });
  }

  // ユーザー登録コード
  for (const s of USER_SHAPES) {
    if (s.root === rootPc && s.quality === quality) {
      const pos = s.frets.filter(f => f > 0);
      out.push({
        frets: s.frets.slice(),
        base: pos.length ? Math.min(...pos) : 0,
        barre: null,
        name: s.name,
        user: true,
        id: s.id,
      });
    }
  }

  // dim7は3フレットごと、augは4フレットごとに同じ構成音になるので上のポジションも提示
  const repeat = quality === 'dim7' ? 3 : quality === 'aug' ? 4 : 0;
  if (repeat) {
    const extras = [];
    for (const v of out) {
      if (v.user) continue;
      const maxF = Math.max(...v.frets);
      for (let off = repeat; maxF + off <= 14; off += repeat) {
        extras.push({
          frets: v.frets.map(f => (f < 0 ? -1 : f + off)),
          base: v.base + off,
          barre: null,
          name: v.name.replace(/ \(\d+fr\)$/, '') + ` (${v.base + off}fr)`,
        });
      }
    }
    out.push(...extras);
  }

  out.sort((a, b) => a.base - b.base);
  return out;
}
