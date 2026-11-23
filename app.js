'use strict';
/* 台本ノート: PDFに手書きと画像を載せるスクリプター用ビューア
   座標系: 各ページの左上を原点とするPDFポイント。上の枠外は y<0、下の枠外は y>ページ高さ。 */

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';

const $ = id => document.getElementById(id);
const stage = $('stage'), world = $('world'), overlay = $('overlay');
const MAX_PX = 5e6;          // キャンバス1枚の画素数の上限（iPadのメモリ対策）
const MAX_Z = 6;
const WIDTHS = { s: 0.8, m: 1.6, l: 3.2 };
const ERASER_PX = { s: 5, m: 10, l: 20 };   // 消しゴムの半径（画面上のピクセル。細・中・太で選ぶ。ズームしても見かけの大きさは同じ）
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r2 = v => Math.round(v * 100) / 100;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// 保存される状態。DOC_KEYS はPDFごと、PREF_KEYS はアプリ全体で1つ
const DOC_KEYS = ['name', 'cur', 'mode', 'rtl', 'cover', 'margins', 'marginSize', 'annots'];
const PREF_KEYS = ['tool', 'color', 'colors', 'widths', 'width', 'fingerDraw', 'shape', 'fillA', 'arrow', 'selMode'];
let S = {
  name: '', cur: 0, mode: 'spread', rtl: true, cover: true,
  margins: true, marginSize: 0.2,
  tool: 'pen', color: '#d00000', width: 'm', fingerDraw: false, shape: 'line', fillA: 0,   // fillA: 図形の塗りの濃さ。0 は塗りなし
  arrow: 0,                  // これから描く直線の矢印（項目の ar と同じ値）
  selMode: 'rect',           // 選択の道具で何もないところをなぞったとき: rect = 長方形で囲む、lasso = 投げ縄
  colors: { pen: '#d00000', marker: '#d00000', shape: '#d00000' },   // 道具ごとに覚えている色。color はいま選んでいる道具の色
  widths: { pen: 'm', marker: 'm', shape: 'm', eraser: 'm' },         // 道具ごとに覚えている太さ（消しゴムは大きさ）。width はいま選んでいる道具の太さ
  annots: {},                // ページ番号 -> 項目の配列（配列の後ろほど手前に描かれる）
};
/* 項目の種類:
   {t:'s', id, c, w, a, p:[x,y,...]}    手書きの線。点列を二次ベジェでなめらかに結ぶ。a は不透明度
   {t:'s', ..., l:1}                    折れ線（点列を直線で結ぶ）。消しゴムで切り分けた残りはこの形になる
   {t:'g', id, k, c, w, x0, y0, x1, y1} 図形。k = line | ellipse | tri | rect | star。(x0,y0)→(x1,y1) はドラッグした範囲
   {t:'g', ..., f}                      塗りつぶした図形。f は濃さ（不透明度 0〜1）。輪郭線は引かず、面全体を1色で塗る
   {t:'g', ..., rot}                    回転した図形。rot はラジアン（時計回り）で、範囲の中心まわりに回す。直線には使わない
   {t:'g', ..., a}                      輪郭線の不透明度（なければ1）
   {t:'g', k:'line', ..., ar}           矢印つきの直線。ar = 1 終点に矢印 / 2 両端 / 3 始点に矢印
   {t:'f', id, c, f, r:[[x,y,...],...]} 塗った面。塗りつぶした図形を消しゴムで削った残り。r は外周と穴の輪の並び
   {t:'i', id, a, x, y, w, h, rot}      画像。a は assets のID。rot は中心まわりの回転（なければ0）
   {t:'G', id, ch:[...], rot}           グループ。ch は中の項目（重なり順）。中の項目はページの座標のまま持ち、
                                        グループを動かすと中の項目の座標を直接書き換える。rot は選択枠の向きにだけ使う
   旧版のデータの線・面には id がないので、読み込んだときに付ける。項目は確定後に書き換えず、変えるときは複製を作る
   （取り消しの履歴が同じ項目を共有しているため）。 */
let assets = {};             // 画像ID -> dataURL（表示中のPDFの分だけ）
let docs = [];               // 開いているPDFの一覧 [{id, name, k}]。k はIndexedDBのキーの接頭辞
let D = null;                // 表示中のPDF（docs の要素）
const hist = {};             // PDFのID -> {undo, redo}。取り消し履歴はPDFごとに分ける
let busy = false;            // PDFの追加・切り替え・削除の最中
let pdf = null, pdfBytes = null, sizes = [];
let sheets = [], view = { tx: 0, ty: 0, z: 1 }, base = { s: 1, w: 0, h: 0 };
let undo = [], redo = [], sel = null, renderedZ = 1;
let addMode = false;          // 「追加選択」: オンの間は、押したものや囲んだものを選択に足す（選択済みのものを押すと外す）
const pick = (o, keys) => { const r = {}; for (const k of keys) if (k in o) r[k] = o[k]; return r; };

/* ---------- IndexedDB ---------- */
// iPadではバックグラウンドから戻ったときにDBへの接続が切れることがあるため、
// 接続は使い回しつつ、切れたら開き直す。
let dbp = null;
function openDb() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('daihon-note', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => {
        const d = r.result;
        d.onclose = () => { if (dbp === p) dbp = null; };           // OSに接続を切られた
        d.onversionchange = () => { d.close(); if (dbp === p) dbp = null; };
        res(d);
      };
      r.onerror = () => rej(r.error);
    });
    const p = dbp;
    p.catch(() => { if (dbp === p) dbp = null; });
  }
  return dbp;
}
async function idbRun(mode, fn) {
  for (let i = 0; ; i++) {
    const p = openDb();
    try {
      const d = await p;
      return await new Promise((res, rej) => {
        const tx = d.transaction('kv', mode);
        const r = fn(tx.objectStore('kv'));
        tx.oncomplete = () => res(r && r.result);
        tx.onerror = tx.onabort = () => rej(tx.error || new Error('IndexedDB transaction aborted'));
      });
    } catch (e) {
      if (i) throw e;
      console.warn('IndexedDB: 接続を開き直して再試行します', e);
      if (dbp === p) dbp = null;
      p.then(d => d.close(), () => {});
    }
  }
}
const idbGet = k => idbRun('readonly', s => s.get(k));
const idbSet = (k, v) => idbRun('readwrite', s => s.put(v, k));

/* 保存の形式（ストア 'kv'）:
     meta              {v:2, docs:[{id,name,k}], active, prefs}
     <k>pdf            PDFのバイト列
     <k>state          そのPDFの状態（DOC_KEYS）
     <k>assets         そのPDFに貼った画像
   k は 'd:<id>:'。ただし旧版（PDFが1件だけ）から引き継いだPDFは k が '' で、
   旧版と同じキー 'pdf' 'state' 'assets' をそのまま使い続ける（複製も削除もしない）。 */
const metaObj = () => ({ v: 2, docs: docs.map(d => ({ ...d })), active: D ? D.id : null, prefs: pick(S, PREF_KEYS) });
const saveErrText = e => (e && e.name === 'QuotaExceededError'
  ? '端末の保存容量が足りません。使わないPDFを「閉じる」で減らすか、端末の空き容量を増やしてください。'
  : '念のため「書き出し」でPDFを保存し、アプリを再起動してください。') + '\n(' + (e && e.message || e) + ')';

/* ---------- 状態の通知 ----------
   保存とオフラインの状態はツールバーに常に出さず、変わったときだけ右上に短く出して消す。
   保存の失敗（赤）とオフライン準備の失敗（橙）は、解決するか一覧で見るまで出したままにする。
   通知を押すと状態の一覧を開く。
   stat.save: saved / dirty（保存待ち）/ error、stat.off: none（使えない）/ preparing / ready / failed
   stat.note: 直前の操作で起きた問題と解決策 {title, body, steps}。一覧で見るまで橙の通知に出す */
const stat = { save: 'saved', saveErr: '', off: 'none', offSeen: false, note: null, noteSeen: false };
let toastTimer = 0;
function showToast(text, level) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'show' + (level ? ' ' + level : '');
}
// 消えずに残す通知。保存の失敗を優先する
function stickyToast() {
  if (stat.save === 'error') return ['保存できませんでした', 'err'];
  if (stat.note && !stat.noteSeen) return [stat.note.title + '（押すと対処法）', 'warn'];
  if (stat.off === 'failed' && !stat.offSeen) return ['オフラインの準備に失敗しました', 'warn'];
  return null;
}
function setNote(note) {
  stat.note = note; stat.noteSeen = false;
  restToast();
}
// 短い通知を出す。ms が 0 なら次の通知まで出したままにする
function notify(text, level = '', ms = 1500) {
  clearTimeout(toastTimer);
  showToast(text, level);
  if (ms) toastTimer = setTimeout(restToast, ms);
}
// 短い通知のあと: 解決していない異常があればそれを出し、なければ隠す
function restToast() {
  clearTimeout(toastTimer);
  const s = stickyToast();
  if (s) showToast(...s); else $('toast').className = '';
  syncStatePanel();
}
function syncStatePanel() {
  if ($('stPanel').hidden) return;
  const n = stat.note;
  $('stNote').hidden = !n;
  if (n) {
    $('stNoteT').textContent = n.title; $('stNoteB').textContent = n.body;
    $('stNoteL').replaceChildren(...n.steps.map(s => Object.assign(document.createElement('li'), { textContent: s })));
  }
  const put = (id, text, level, msgId, msg) => {
    $(id).textContent = text; $(id).className = level || '';
    $(msgId).textContent = msg || ''; $(msgId).hidden = !msg;
  };
  const sv = {
    saved: ['端末に保存済み'], dirty: ['保存待ち', '', '書き込みのあと、まもなく保存します。'],
    error: ['保存できませんでした', 'err', stat.saveErr],
  }[stat.save];
  put('stSave', sv[0], sv[1], 'stSaveMsg', sv[2]);
  const of = {
    ready: ['使える', '', 'アプリ一式を端末に保存してあります。'],
    preparing: ['準備中', 'warn', 'アプリ一式を端末に保存しています。終わるまでオンラインのままにしてください。'],
    failed: ['準備に失敗しました', 'warn', '次にオンラインで起動したときに、もう一度保存します。'],
    none: ['使えない', 'warn', 'https で開いていないか、このブラウザが対応していません。'],
  }[stat.off];
  put('stOff', of[0], of[1], 'stOffMsg', of[2]);
}
function openStatePanel() {
  $('stPanel').hidden = false;
  stat.offSeen = stat.noteSeen = true;       // 一覧で見た問題は、通知に出し続けない
  restToast();
}
$('toast').onclick = openStatePanel;
$('bState').onclick = openStatePanel;
$('bStClose').onclick = () => { $('stPanel').hidden = true; };
// 一覧の外を押したら閉じる。閉じるために押しただけなので、ページには何も描かない
document.addEventListener('pointerdown', e => {
  if ($('stPanel').hidden || e.target.closest('#stPanel, #toast, #bState, #bMenu')) return;
  $('stPanel').hidden = true;
  if (e.target.closest('#stage')) e.stopPropagation();
}, true);

let saveTimer = 0, dirty = false, assetsDirty = false, saveAlerted = false;
function touch() {
  dirty = true;
  if (stat.save !== 'error') stat.save = 'dirty';   // 失敗中は、保存できるまで失敗の表示を残す
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}
// 保存する内容は呼ばれた時点で確定させる。書き込みを待つ間にPDFが切り替わっても、別のPDFの内容が混ざらない。
// 成功すれば true。
function save() {
  clearTimeout(saveTimer);
  if (!dirty && !assetsDirty) return Promise.resolve(true);
  const d = D, st = d && pick(S, DOC_KEYS), as = d && assetsDirty ? assets : null, meta = metaObj();
  dirty = false; assetsDirty = false;
  return idbRun('readwrite', s => {
    if (d) { s.put(st, d.k + 'state'); if (as) s.put(as, d.k + 'assets'); }
    return s.put(meta, 'meta');
  }).then(() => {
    const wasErr = stat.save === 'error';
    stat.save = dirty ? 'dirty' : 'saved'; stat.saveErr = '';
    notify(wasErr ? '保存できました' : '保存済み');
    saveAlerted = false;
    return true;
  }, e => {
    console.error(e);
    if (d === D) { dirty = true; if (as) assetsDirty = true; }   // 次の保存で書き直す
    stat.save = 'error'; stat.saveErr = saveErrText(e);
    restToast();
    if (!saveAlerted && !document.hidden) {       // 失敗が続いている間は1回だけ知らせる
      saveAlerted = true;
      alert('作業内容を端末に保存できませんでした。\n' + saveErrText(e));
    }
    return false;
  });
}
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
addEventListener('pagehide', save);

/* ---------- PDFの追加・切り替え・削除 ---------- */
function loadDoc(buf) {
  return pdfjsLib.getDocument({
    data: new Uint8Array(buf.slice(0)),
    cMapUrl: new URL('vendor/pdfjs/cmaps/', location.href).href, cMapPacked: true,
    standardFontDataUrl: new URL('vendor/pdfjs/standard_fonts/', location.href).href,
    // cMapとフォントはワーカーではなくページ側で読む。ページの通信は確実にService Worker
    // を通るため、オフラインでも端末に保存済みのファイルが使われる
    useWorkerFetch: false,
  }).promise;
}
// 表示中のPDFの描画データ（pdf.jsの文書、キャンバス、画像）を手放す。iPadのメモリ対策
function leaveDoc() {
  showTok++;
  g = null; sel = null; touches.clear();
  freeSheets();
  for (const id in imgCache) { imgCache[id].img.onload = null; imgCache[id].cbs.length = 0; delete imgCache[id]; }
  if (pdf) pdf.destroy().catch(() => {});
  pdf = null; pdfBytes = null; sizes = []; assets = {};
}
// 表示するPDFを入れ替える。S・assets・履歴・pdf はここで同時に（途中に await を挟まずに）入れ替える
function enterDoc(entry, st, as, buf, doc) {
  save();                                   // 前のPDFに未保存の変更が残っていれば、入れ替える前の内容で書き出す
  leaveDoc();
  D = entry;
  Object.assign(S, pick(st, DOC_KEYS));
  S.annots = st.annots || {};
  for (const p in S.annots) S.annots[p].forEach(ensureId);
  assets = as || {};
  pdf = doc; pdfBytes = buf;
  const h = hist[entry.id] || (hist[entry.id] = { undo: [], redo: [] });
  undo = h.undo; redo = h.redo;
  S.cur = clamp(S.cur | 0, 0, pdf.numPages - 1);
  $('empty').hidden = true;
  syncUI();
  return show();
}
function showEmpty() {
  leaveDoc();
  D = null; S.annots = {}; S.name = ''; undo = []; redo = [];
  $('empty').hidden = false;
  drawOverlay(); syncUI();
}
async function op(fn) {                     // 文書の操作は1つずつ。終わるまで画面の操作を受け付けない
  if (busy) return;
  busy = true; $('busy').hidden = false;
  try { return await fn(); }
  finally { busy = false; $('busy').hidden = true; syncUI(); }
}

async function activate(id) {
  const entry = docs.find(d => d.id === id);
  if (!entry || entry === D) return;
  if (!(await save())) throw new Error('表示中のPDFの書き込みを保存できないため、切り替えを中止しました');
  const [st, buf, as] = await Promise.all([idbGet(entry.k + 'state'), idbGet(entry.k + 'pdf'), idbGet(entry.k + 'assets')]);
  if (!st || !buf) throw Object.assign(new Error('保存データが見つかりません'), { missing: true });
  const doc = await loadDoc(buf);
  await enterDoc(entry, st, as, buf, doc);
  dirty = true; save();                     // どのPDFを表示中かを記録する
}
function switchDoc(id) {
  return op(async () => {
    try { await activate(id); }
    catch (e) {
      console.error(e);
      const entry = docs.find(d => d.id === id);
      if (e.missing && entry && confirm(`「${entry.name}」の保存データが見つかりません。一覧から外しますか？`)) {
        docs = docs.filter(d => d !== entry); delete hist[id];
        dirty = true; save();
      } else alert('PDFを切り替えられませんでした: ' + e.message);
    }
  });
}

/* 作業データのファイル（バックアップ）: PDF本体・書き込み・貼り付けた画像を1つにまとめたもの。
   形式: 目印8バイト + JSONの長さ(4バイト, リトルエンディアン) + JSON {v, name, state, assets} + PDFのバイト列 */
const BK_MAGIC = [0x44, 0x41, 0x49, 0x48, 0x4f, 0x4e, 0x01, 0x0a];   // "DAIHON" 0x01 "\n"
function buildBackup() {
  const json = new TextEncoder().encode(JSON.stringify({ v: 1, name: S.name, state: pick(S, DOC_KEYS), assets }));
  const len = new Uint8Array(4);
  new DataView(len.buffer).setUint32(0, json.length, true);
  return new File([new Uint8Array(BK_MAGIC), len, json, pdfBytes], (S.name || 'script').replace(/\.pdf$/i, '') + '_作業データ.daihon', { type: 'application/octet-stream' });
}
// 作業データのファイルでなければ null
function parseBackup(buf) {
  const u = new Uint8Array(buf);
  if (u.length < 12 || !BK_MAGIC.every((v, i) => u[i] === v)) return null;
  try {
    const n = new DataView(buf).getUint32(8, true);
    if (12 + n >= u.length) throw 0;
    const h = JSON.parse(new TextDecoder().decode(u.subarray(12, 12 + n)));
    if (!h || typeof h.state !== 'object' || !h.state) throw 0;
    const st = pick(h.state, DOC_KEYS);
    if (!st.annots || typeof st.annots !== 'object') st.annots = {};
    return { name: String(h.name || st.name || ''), state: st, assets: h.assets && typeof h.assets === 'object' ? h.assets : {}, pdf: buf.slice(12 + n) };
  } catch (e) {
    throw new Error('作業データのファイルが壊れています');
  }
}

// PDF、または作業データのファイルを、新しいPDFとして一覧に加えて表示する（開いているPDFは上書きしない）
async function addPdf(file) {
  let doc = null;
  try {
    let buf = await file.arrayBuffer(), name = file.name, as = {};
    const bk = parseBackup(buf);
    if (bk) { buf = bk.pdf; name = bk.name || name; as = bk.assets; }
    doc = await loadDoc(buf);               // 保存する前に、開けるPDFかどうかを確かめる
    if (!(await save())) throw new Error('表示中のPDFの書き込みを保存できないため、追加を中止しました');
    const id = uid(), entry = { id, name, k: `d:${id}:` };
    // 綴じ方向などの表示設定は、作業データにあればそれを、なければいま表示中のPDFのものを引き継ぐ
    const st = bk ? { ...pick(S, DOC_KEYS), ...bk.state, name } : { ...pick(S, DOC_KEYS), name, cur: 0, annots: {} };
    const meta = { ...metaObj(), docs: [...docs, entry].map(d => ({ ...d })), active: id };
    try {                                   // PDF本体と一覧を1つのトランザクションで書く。失敗したら何も変わらない
      await idbRun('readwrite', s => {
        s.put(buf, entry.k + 'pdf'); s.put(st, entry.k + 'state'); s.put(as, entry.k + 'assets');
        return s.put(meta, 'meta');
      });
    } catch (e) {
      throw new Error('端末に保存できませんでした。\n' + saveErrText(e));
    }
    docs = [...docs, entry];
    const d = doc; doc = null;
    await enterDoc(entry, st, as, buf, d);
    notify('保存済み');
  } catch (e) {
    console.error(e);
    if (doc) doc.destroy().catch(() => {});
    alert(`「${file.name}」を開けませんでした: ${e.message}`);
  }
}
async function pickPdfs(files) {
  for (const f of [...files]) await op(() => addPdf(f));
}

function closeDoc() {
  const entry = D;
  if (!entry || busy) return;
  if (!confirm(`「${entry.name}」を閉じると、このPDFへの書き込みと貼り付けた画像も端末から削除されます。\n必要なら先に「書き出し」で保存してください。閉じますか？`)) return;
  return op(async () => {
    const rest = docs.filter(d => d !== entry);
    const next = rest[Math.min(docs.indexOf(entry), rest.length - 1)];
    clearTimeout(saveTimer);
    try {
      await idbRun('readwrite', s => {
        for (const part of ['pdf', 'state', 'assets']) s.delete(entry.k + part);
        return s.put({ ...metaObj(), docs: rest.map(d => ({ ...d })), active: next ? next.id : null }, 'meta');
      });
    } catch (e) {
      console.error(e);
      dirty = true; touch();
      alert('閉じられませんでした。\n(' + e.message + ')');
      return;
    }
    dirty = false; assetsDirty = false;      // 消したPDFの内容を書き戻さない
    docs = rest; delete hist[entry.id];
    showEmpty();
    if (next) {
      try { await activate(next.id); }
      catch (e) { console.error(e); alert('PDFを切り替えられませんでした: ' + e.message); }
    }
    notify('保存済み');
  });
}

// 保存データに一覧(meta)がないとき: 旧版のデータ、または一覧だけが欠けたデータから一覧を作る。
// 旧版のPDF・書き込み・画像には手を加えない（同じキーのまま1件目のPDFとして使い続ける）ので、
// ここで失敗しても旧データは残り、次の起動でやり直せる。
async function migrate() {
  const keys = (await idbRun('readonly', s => s.getAllKeys())).filter(k => typeof k === 'string');
  const list = [];
  let prefs = {};
  if (keys.includes('pdf') && keys.includes('state')) {
    const st = await idbGet('state');
    if (st) { list.push({ id: uid(), name: st.name || 'PDF', k: '' }); prefs = pick(st, PREF_KEYS); }
  }
  for (const k of keys) {
    const m = /^d:(.+):pdf$/.exec(k);
    if (!m) continue;
    const st = await idbGet(`d:${m[1]}:state`);
    if (st) list.push({ id: m[1], name: st.name || 'PDF', k: `d:${m[1]}:` });
  }
  const meta = { v: 2, docs: list, active: list.length ? list[0].id : null, prefs };
  if (list.length) await idbSet('meta', meta).catch(e => console.error('一覧を保存できませんでした（次回の起動でやり直します）', e));
  return meta;
}

/* ---------- ページ構成 ---------- */
function spreadOf(p) {
  const n = pdf.numPages;
  if (S.mode === 'single') return [p];
  let a;
  if (S.cover) { if (p === 0) return [0]; a = p % 2 === 1 ? p : p - 1; }
  else a = p - p % 2;
  return a + 1 < n ? [a, a + 1] : [a];
}
function turn(dir) {
  if (!pdf) return;
  const pages = spreadOf(S.cur);
  if (dir > 0) {
    const nx = pages[pages.length - 1] + 1;
    if (nx >= pdf.numPages) return;
    S.cur = nx;
  } else {
    if (pages[0] === 0) return;
    S.cur = spreadOf(pages[0] - 1)[0];
  }
  sel = null;
  show(); touch();
}

let showTok = 0;
async function show() {
  const tok = ++showTok, doc = pdf;
  if (!doc) return;
  const pages = spreadOf(S.cur);
  try {
    for (const p of pages) {
      if (!sizes[p]) {
        const vp = (await doc.getPage(p + 1)).getViewport({ scale: 1 });
        if (doc !== pdf) return;               // 待っている間に別のPDFへ切り替わった
        sizes[p] = { w: vp.width, h: vp.height };
      }
    }
  } catch (e) {
    if (doc === pdf) console.error(e);
    return;
  }
  if (tok !== showTok || doc !== pdf) return;
  freeSheets();
  const order = S.rtl ? pages.slice().reverse() : pages;
  sheets = order.map(p => {
    const { w, h } = sizes[p];
    const el = document.createElement('div'); el.className = 'sheet';
    const pdfC = document.createElement('canvas'); pdfC.className = 'pdf';
    const ann = document.createElement('canvas'); ann.className = 'ann';
    el.append(pdfC, ann); world.append(el);
    return { page: p, W: w, H: h, m: S.margins ? h * S.marginSize : 0, el, pdfC, ann, r: 1, tok: 0, task: null };
  });
  fit();
  view = { tx: 0, ty: 0, z: 1 };
  clampView(); applyView(); renderAll(); syncUI();
}

// 表示中のページのキャンバスを破棄する。幅と高さを0にすると、iPadでも画素のメモリがすぐに返される
function freeSheets() {
  for (const s of sheets) {
    s.tok++;
    if (s.task) s.task.cancel();
    s.pdfC.width = s.pdfC.height = 0;
    s.ann.width = s.ann.height = 0;
  }
  sheets = [];
  world.textContent = '';
}
function placePdfCanvas(sh, c) {
  c.style.top = sh.m * base.s + 'px';
  c.style.width = sh.W * base.s + 'px';
  c.style.height = sh.H * base.s + 'px';
}
function fit() {
  if (!sheets.length) return;
  const pad = 12;
  const tw = sheets.reduce((a, s) => a + s.W, 0);
  const mh = Math.max(...sheets.map(s => s.H + 2 * s.m));
  const s = Math.min((stage.clientWidth - pad) / tw, (stage.clientHeight - pad) / mh);
  base = { s, w: tw * s, h: mh * s };
  world.style.width = base.w + 'px'; world.style.height = base.h + 'px';
  for (const sh of sheets) {
    sh.el.style.width = sh.W * s + 'px';
    sh.el.style.height = (sh.H + 2 * sh.m) * s + 'px';
    placePdfCanvas(sh, sh.pdfC);
  }
}

function clampView() {
  const sw = stage.clientWidth, sh = stage.clientHeight;
  const cw = base.w * view.z, ch = base.h * view.z;
  view.tx = cw <= sw ? (sw - cw) / 2 : clamp(view.tx, sw - cw, 0);
  view.ty = ch <= sh ? (sh - ch) / 2 : clamp(view.ty, sh - ch, 0);
}
let rerenderTimer = 0;
function applyView() {
  world.style.transform = `translate(${view.tx}px,${view.ty}px) scale(${view.z})`;
  drawOverlay();
  if (view.z !== renderedZ) {          // ズームが止まったら高解像度で描き直す
    clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(renderAll, 250);
  }
}

/* ---------- 描画 ---------- */
function renderAll() {
  clearTimeout(rerenderTimer);
  const dpr = devicePixelRatio || 1;
  for (const sh of sheets) {
    const want = base.s * view.z * dpr;
    sh.r = Math.min(want, Math.sqrt(MAX_PX / (sh.W * (sh.H + 2 * sh.m))));
    sh.ann.width = Math.round(sh.W * sh.r);
    sh.ann.height = Math.round((sh.H + 2 * sh.m) * sh.r);
    drawAnn(sh);
    renderPdf(sh);
  }
  renderedZ = view.z;
  drawOverlay();
}
async function renderPdf(sh) {
  const tok = ++sh.tok, doc = pdf;
  if (sh.task) sh.task.cancel();
  const c = document.createElement('canvas');
  c.className = 'pdf';
  c.width = Math.round(sh.W * sh.r); c.height = Math.round(sh.H * sh.r);
  // 描き終えるまでにページ送りやPDFの切り替えがあったら、結果は捨てる
  const stale = () => tok !== sh.tok || doc !== pdf || !sheets.includes(sh);
  try {
    const pg = await doc.getPage(sh.page + 1);
    if (stale()) { c.width = c.height = 0; return; }
    const task = pg.render({ canvasContext: c.getContext('2d'), viewport: pg.getViewport({ scale: sh.r }) });
    sh.task = task;
    await task.promise;
    if (stale()) { c.width = c.height = 0; return; }
    placePdfCanvas(sh, c);
    const old = sh.pdfC;
    old.replaceWith(c); sh.pdfC = c;
    old.width = old.height = 0;
  } catch (e) {
    c.width = c.height = 0;
    if (!stale() && e && e.name !== 'RenderingCancelledException') console.error(e);
  }
}

function strokePath(ctx, it) {
  if (it.t === 'f') {                        // 削られた面: 輪をまとめて1回で塗る（穴は抜ける）
    ctx.save();
    ctx.fillStyle = it.c; ctx.globalAlpha = it.f;
    ctx.beginPath();
    for (const q of it.r) {
      ctx.moveTo(q[0], q[1]);
      for (let i = 2; i < q.length; i += 2) ctx.lineTo(q[i], q[i + 1]);
      ctx.closePath();
    }
    ctx.fill('evenodd');
    ctx.restore();
    return;
  }
  const p = it.p, n = p ? p.length / 2 : 0;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = it.c; ctx.lineWidth = it.w; ctx.globalAlpha = it.a || 1;
  ctx.beginPath();
  if (it.t === 'g' && it.k === 'line' && it.ar) {   // 矢印つきの直線: 線を矢じりの中まで引き、矢じりを塗る
    const a = arrowGeom(it);
    ctx.moveTo(a.line[0], a.line[1]); ctx.lineTo(a.line[2], a.line[3]); ctx.stroke();
    ctx.fillStyle = it.c;
    for (const h of a.heads) { ctx.beginPath(); ctx.moveTo(h[0], h[1]); ctx.lineTo(h[2], h[3]); ctx.lineTo(h[4], h[5]); ctx.closePath(); ctx.fill(); }
    ctx.restore();
    return;
  }
  if (it.t === 'g') {
    shapeTrace(ctx, it);
    // 塗りつぶした図形は面だけを塗る。輪郭線を重ねると、半透明のとき縁だけ濃くなって色がそろわない
    if (filled(it)) { ctx.fillStyle = it.c; ctx.globalAlpha = it.f; ctx.fill(); ctx.restore(); return; }
  } else {
    ctx.moveTo(p[0], p[1]);
    if (n === 1) ctx.lineTo(p[0] + 0.01, p[1]);
    if (it.l) for (let i = 1; i < n - 1; i++) ctx.lineTo(p[2 * i], p[2 * i + 1]);
    else for (let i = 1; i < n - 1; i++) {
      ctx.quadraticCurveTo(p[2 * i], p[2 * i + 1], (p[2 * i] + p[2 * i + 2]) / 2, (p[2 * i + 1] + p[2 * i + 3]) / 2);
    }
    if (n > 1) ctx.lineTo(p[2 * n - 2], p[2 * n - 1]);
  }
  ctx.stroke();
  ctx.restore();
}

/* 図形の形。ドラッグした範囲 (x0,y0)-(x1,y1) を単位正方形 (u,v) に見立てて頂点を置く。
   v=0 がドラッグの始点側なので、下から上へドラッグすると三角形と星は上下が逆になる。 */
const STAR_UV = (() => {
  const o = [];
  for (let i = 0; i < 10; i++) {
    const a = (-90 + 36 * i) * Math.PI / 180, r = i % 2 ? 0.381966 : 1;
    o.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const xs = o.map(q => q[0]), ys = o.map(q => q[1]);
  const x0 = Math.min(...xs), w = Math.max(...xs) - x0, y0 = Math.min(...ys), h = Math.max(...ys) - y0;
  return o.map(q => [(q[0] - x0) / w, (q[1] - y0) / h]);
})();
const SHAPE_UV = { tri: [[0.5, 0], [1, 1], [0, 1]], rect: [[0, 0], [1, 0], [1, 1], [0, 1]], star: STAR_UV };
// (x,y) を (cx,cy) のまわりに a ラジアン回す（画面では時計回り）
const rotP = (x, y, cx, cy, a) => {
  const c = Math.cos(a), s = Math.sin(a), dx = x - cx, dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
};
// 画像と、直線以外の図形の中心（回転の中心）
const centerOf = it => it.t === 'i' ? [it.x + it.w / 2, it.y + it.h / 2] : [(it.x0 + it.x1) / 2, (it.y0 + it.y1) / 2];
// 楕円以外の図形の頂点 [x,y,...]。直線は2点、ほかは閉じた多角形（回転を反映したもの）
function shapePts(it) {
  if (it.k === 'line') return [it.x0, it.y0, it.x1, it.y1];
  const o = [], a = it.rot || 0, [cx, cy] = centerOf(it);
  for (const [u, v] of SHAPE_UV[it.k] || SHAPE_UV.rect) {
    let x = it.x0 + u * (it.x1 - it.x0), y = it.y0 + v * (it.y1 - it.y0);
    if (a) [x, y] = rotP(x, y, cx, cy, a);
    o.push(r2(x), r2(y));
  }
  return o;
}
const filled = it => it.t === 'g' && !!it.f && it.k !== 'line';
const isLine = it => it.t === 'g' && it.k === 'line';
const isMarker = it => it.t === 's' && it.w > 3.3;     // マーカーの線は WIDTHS の6倍（4.8以上）、ペンは3.2以下
/* 直線の矢じり。ar = 1 終点 / 2 両端 / 3 始点。矢じりは塗った三角形で、大きさは線の太さに応じる。
   線は矢じりの内側まで引く（先端の丸い端が矢じりからはみ出さないよう、先端から長さの7割だけ短くする） */
function arrowGeom(it) {
  let x0 = it.x0, y0 = it.y0, x1 = it.x1, y1 = it.y1;
  const ar = it.ar | 0, L = Math.hypot(x1 - x0, y1 - y0);
  if (!ar || L < 1e-6) return { line: [x0, y0, x1, y1], heads: [] };
  const len = Math.min(5 + it.w * 3, L * (ar === 2 ? 0.45 : 0.9)), hw = len * 0.45;
  const ux = (x1 - x0) / L, uy = (y1 - y0) / L, heads = [];
  const head = (tx, ty, dx, dy) => {
    const bx = tx - dx * len, by = ty - dy * len;
    return [tx, ty, bx - dy * hw, by + dx * hw, bx + dy * hw, by - dx * hw].map(r2);
  };
  if (ar === 1 || ar === 2) { heads.push(head(x1, y1, ux, uy)); x1 -= ux * len * 0.7; y1 -= uy * len * 0.7; }
  if (ar === 2 || ar === 3) { heads.push(head(x0, y0, -ux, -uy)); x0 += ux * len * 0.7; y0 += uy * len * 0.7; }
  return { line: [x0, y0, x1, y1].map(r2), heads };
}
const ellipseOf = it => ({ cx: (it.x0 + it.x1) / 2, cy: (it.y0 + it.y1) / 2, rx: Math.abs(it.x1 - it.x0) / 2, ry: Math.abs(it.y1 - it.y0) / 2 });
function shapeTrace(ctx, it) {
  if (it.k === 'ellipse') {
    const e = ellipseOf(it);
    ctx.ellipse(e.cx, e.cy, e.rx, e.ry, it.rot || 0, 0, Math.PI * 2);
    ctx.closePath();
    return;
  }
  const q = shapePts(it);
  ctx.moveTo(q[0], q[1]);
  for (let i = 2; i < q.length; i += 2) ctx.lineTo(q[i], q[i + 1]);
  if (it.k !== 'line') ctx.closePath();
}
// 線・図形をSVGのパスにする（PDF書き出し用。画面の描画と同じ形になるようにしてある）
function svgPath(it) {
  const f = v => r2(v);
  if (it.t === 'f') {
    return it.r.map(q => { let d = `M ${q[0]} ${q[1]}`; for (let i = 2; i < q.length; i += 2) d += ` L ${q[i]} ${q[i + 1]}`; return d + ' Z'; }).join(' ');
  }
  if (it.t === 'g') {
    if (it.k === 'ellipse') {             // 4本の三次ベジェで近似し、回転していれば制御点ごと回す
      const { cx, cy, rx, ry } = ellipseOf(it), kx = rx * 0.5522847498, ky = ry * 0.5522847498, a = it.rot || 0;
      const P = (x, y) => { const p = a ? rotP(x, y, cx, cy, a) : [x, y]; return `${f(p[0])} ${f(p[1])}`; };
      return `M ${P(cx + rx, cy)} C ${P(cx + rx, cy + ky)} ${P(cx + kx, cy + ry)} ${P(cx, cy + ry)}`
        + ` C ${P(cx - kx, cy + ry)} ${P(cx - rx, cy + ky)} ${P(cx - rx, cy)}`
        + ` C ${P(cx - rx, cy - ky)} ${P(cx - kx, cy - ry)} ${P(cx, cy - ry)}`
        + ` C ${P(cx + kx, cy - ry)} ${P(cx + rx, cy - ky)} ${P(cx + rx, cy)} Z`;
    }
    const q = it.k === 'line' && it.ar ? arrowGeom(it).line : shapePts(it);
    let d = `M ${q[0]} ${q[1]}`;
    for (let i = 2; i < q.length; i += 2) d += ` L ${q[i]} ${q[i + 1]}`;
    return it.k === 'line' ? d : d + ' Z';
  }
  const p = it.p, n = p.length / 2;
  let d = `M ${p[0]} ${p[1]}`;
  if (n === 1) d += ` L ${p[0] + 0.01} ${p[1]}`;
  if (it.l) for (let j = 1; j < n - 1; j++) d += ` L ${p[2 * j]} ${p[2 * j + 1]}`;
  else for (let j = 1; j < n - 1; j++) d += ` Q ${p[2 * j]} ${p[2 * j + 1]} ${f((p[2 * j] + p[2 * j + 2]) / 2)} ${f((p[2 * j + 1] + p[2 * j + 3]) / 2)}`;
  if (n > 1) d += ` L ${p[2 * n - 2]} ${p[2 * n - 1]}`;
  return d;
}
const imgCache = {};
function getImg(id, onload) {
  let c = imgCache[id];
  if (!c) {
    c = imgCache[id] = { img: new Image(), ok: false, cbs: [] };
    c.img.onload = () => { c.ok = true; c.cbs.splice(0).forEach(f => f()); };
    c.img.src = assets[id] || '';
  }
  if (c.ok) return c.img;
  c.cbs.push(onload);
  return null;
}
function annCtx(sh) {
  const ctx = sh.ann.getContext('2d');
  ctx.setTransform(sh.r, 0, 0, sh.r, 0, sh.m * sh.r);
  return ctx;
}
function drawAnn(sh) {
  const ctx = sh.ann.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, sh.ann.width, sh.ann.height);
  annCtx(sh);
  const again = () => { if (sheets.includes(sh)) drawAnn(sh); };   // 画像の読み込みが終わったら描き直す
  for (const it of S.annots[sh.page] || []) drawItem(ctx, it, again);
}
function drawItem(ctx, it, again) {
  if (it.t === 'G') { for (const c of it.ch) drawItem(ctx, c, again); return; }
  if (it.t !== 'i') { strokePath(ctx, it); return; }
  const img = getImg(it.a, again);
  if (!img) return;
  if (!it.rot) { ctx.drawImage(img, it.x, it.y, it.w, it.h); return; }
  const [cx, cy] = centerOf(it);
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(it.rot);
  ctx.drawImage(img, -it.w / 2, -it.h / 2, it.w, it.h);
  ctx.restore();
}

function sheetXform(sh) {
  const r = sh.el.getBoundingClientRect(), sr = stage.getBoundingClientRect();
  const k = r.width / sh.W;
  return { k, ox: r.left - sr.left, oy: r.top - sr.top + sh.m * k };
}
function sizeOverlay() {
  const dpr = devicePixelRatio || 1;
  stageW = stage.clientWidth; stageH = stage.clientHeight;
  overlay.width = Math.round(stage.clientWidth * dpr);
  overlay.height = Math.round(stage.clientHeight * dpr);
}
let overlayQueued = false;
function queueOverlay() {
  if (overlayQueued) return;
  overlayQueued = true;
  requestAnimationFrame(() => { overlayQueued = false; drawOverlay(); });
}
function drawOverlay() {
  const dpr = devicePixelRatio || 1;
  const ctx = overlay.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  if (g && g.stroke) {                       // 書いている途中の線・図形
    const t = sheetXform(g.sh);
    ctx.setTransform(t.k * dpr, 0, 0, t.k * dpr, t.ox * dpr, t.oy * dpr);
    strokePath(ctx, g.stroke);
  }
  if (g && g.tool === 'eraser' && g.ex !== undefined) {   // 消しゴムの当たる範囲
    const t = sheetXform(g.sh);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath(); ctx.arc(t.ox + g.ex * t.k, t.oy + g.ey * t.k, ERASER_PX[S.width], 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff66'; ctx.fill();
    ctx.strokeStyle = '#333'; ctx.lineWidth = 1; ctx.stroke();
  }
  if (g && g.mode === 'region' && g.pts.length >= 4) {   // なぞっている途中の選択範囲
    const t = sheetXform(g.sh), q = regionPoly(g);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.beginPath();
    for (let i = 0; i < q.length; i += 2) ctx.lineTo(t.ox + q[i] * t.k, t.oy + q[i + 1] * t.k);
    ctx.closePath();
    ctx.fillStyle = '#0a66d81a'; ctx.fill();
    ctx.strokeStyle = '#0a66d8'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); ctx.stroke(); ctx.setLineDash([]);
  }
  const sg = selGeom();
  const bar = $('selBar');
  if (!sg) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.strokeStyle = '#0a66d8'; ctx.fillStyle = '#0a66d8'; ctx.lineWidth = 2;
  const dot = (p, r) => { ctx.beginPath(); ctx.arc(p[0], p[1], r, 0, Math.PI * 2); ctx.fill(); };
  if (sg.ends) {                             // 直線1本: 両端の取っ手で向きと長さを変える
    ctx.setLineDash([6, 4]);
    ctx.beginPath(); ctx.moveTo(...sg.ends[0]); ctx.lineTo(...sg.ends[1]); ctx.stroke();
    ctx.setLineDash([]);
    sg.ends.forEach(p => dot(p, 9));
  } else {
    if (sg.items.length > 1) {               // 複数のときは、どれが選ばれているかを薄い枠で示す
      ctx.strokeStyle = '#0a66d880'; ctx.lineWidth = 1;
      for (const it of sg.items) {
        const b = bboxAll(it);
        ctx.strokeRect(sg.t.ox + b[0] * sg.t.k, sg.t.oy + b[1] * sg.t.k, (b[2] - b[0]) * sg.t.k, (b[3] - b[1]) * sg.t.k);
      }
      ctx.strokeStyle = '#0a66d8'; ctx.lineWidth = 2;
    }
    ctx.setLineDash(sg.group ? [2, 3] : [6, 4]);
    ctx.beginPath(); sg.corners.forEach(p => ctx.lineTo(p[0], p[1])); ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(...sg.topMid); ctx.lineTo(...sg.rot); ctx.stroke();
    dot(sg.corners[2], 9);                   // 右下: 大きさ
    dot(sg.rot, 9);                          // 上: 回転
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(sg.rot[0], sg.rot[1], 4.5, -Math.PI * 0.9, Math.PI * 0.5); ctx.stroke();
  }
  // 選択したものが画面の下のほうにあるときは、操作の帯を上に出して隠さないようにする
  const ys = sg.ends ? sg.ends.map(p => p[1]) : sg.corners.map(p => p[1]);
  bar.classList.toggle('top', Math.max(...ys) > stageH - bar.offsetHeight - 30 && Math.min(...ys) > bar.offsetHeight + 30);
}

/* ---------- 取り消し ---------- */
function pushUndo(page) {
  undo.push({ page, items: (S.annots[page] || []).slice() });
  if (undo.length > 200) undo.shift();
  redo.length = 0;
  syncUI();
}
function stepHistory(from, to) {
  const u = from.pop();
  if (!u) return;
  // 1回の操作が2ページにまたがることがある（画像・図形を隣のページへ動かしたとき）。also がもう一方のページ
  const all = [u, ...(u.also || [])];
  const now = all.map(e => ({ page: e.page, items: (S.annots[e.page] || []).slice() }));
  to.push({ ...now[0], also: now.slice(1) });
  for (const e of all) S.annots[e.page] = e.items;
  sel = null;
  if (sheets.some(s => s.page === u.page)) {
    for (const e of all) { const sh = sheets.find(s => s.page === e.page); if (sh) drawAnn(sh); }
    drawOverlay(); syncUI();
  } else { S.cur = u.page; show(); }
  touch();
}

/* ---------- ポインタ操作 ---------- */
const touches = new Map();
let g = null;   // 進行中の操作

function locate(e) {
  for (const sh of sheets) {
    const r = sh.el.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      const k = r.width / sh.W;
      return { sh, k, r, x: (e.clientX - r.left) / k, y: (e.clientY - r.top) / k - sh.m };
    }
  }
  return null;
}
const pt = (g, e) => [(e.clientX - g.r.left) / g.k, (e.clientY - g.r.top) / g.k - g.sh.m];

function startPinch() {
  const [a, b] = [...touches.values()];
  const sr = stage.getBoundingClientRect();
  return {
    type: 'pinch', d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
    mx: (a.x + b.x) / 2 - sr.left, my: (a.y + b.y) / 2 - sr.top, v: { ...view },
  };
}

stage.addEventListener('pointerdown', e => {
  if (!pdf || busy || e.target.closest('#empty, #selBar, #toast, #stPanel')) return;
  e.preventDefault();
  const isTouch = e.pointerType === 'touch';
  if (isTouch) {
    if (g && g.tool && !g.touch) return;            // ペンで操作中は手のひらを無視する
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.setPointerCapture(e.pointerId);
    if (touches.size === 2) { g = startPinch(); drawOverlay(); return; }
    if (touches.size > 2) return;
    if (!S.fingerDraw) { g = { type: 'pan', x: e.clientX, y: e.clientY, v: { ...view } }; return; }
  } else if (e.pointerType === 'mouse' && e.button !== 0) return;
  stage.setPointerCapture(e.pointerId);
  // 道具を何も選んでいないときは、ペンも指と同じく移動とページ送りになる
  if (!S.tool) { g = { type: 'pan', x: e.clientX, y: e.clientY, v: { ...view } }; return; }
  startTool(e, isTouch);
});

function startTool(e, isTouch) {
  if (S.tool === 'select') return startSelect(e, isTouch);
  const h = locate(e);
  if (!h) return;
  g = { tool: S.tool, id: e.pointerId, touch: isTouch, sh: h.sh, k: h.k, r: h.r };
  if (S.tool === 'pen' || S.tool === 'marker') {
    const mk = S.tool === 'marker';
    g.stroke = { t: 's', id: uid(), c: S.color, w: WIDTHS[S.width] * (mk ? 6 : 1), a: mk ? 0.35 : 1, p: [r2(h.x), r2(h.y)] };
    queueOverlay();
  } else if (S.tool === 'shape') {
    const x = r2(h.x), y = r2(h.y);
    g.stroke = { t: 'g', id: uid(), k: S.shape, c: S.color, w: WIDTHS[S.width], x0: x, y0: y, x1: x, y1: y };
    if (S.fillA && S.shape !== 'line') g.stroke.f = S.fillA;
    if (S.arrow && S.shape === 'line') g.stroke.ar = S.arrow;
  } else if (S.tool === 'eraser') {
    eraseTo(g, h.x, h.y);
  }
}

/* ---------- 消しゴム（部分消去） ----------
   線や図形を、画面に描かれるとおりの形の折れ線に直し、消しゴムが通った範囲だけを切り取る。
   残った部分はそれぞれ独立した折れ線になるので、切れ目がつながり直すことはない。 */
const FLAT_TOL = 0.05;       // 曲線を折れ線に直すときの許容誤差（PDFポイント）
const flatCache = new WeakMap(), boxCache = new WeakMap();   // 項目は確定後に書き換えないので使い回せる
function flatten(it) {
  if (it.t === 's' && (it.l || it.p.length <= 4)) return it.p;
  let o = flatCache.get(it);
  if (o) return o;
  if (it.t === 'g') {
    if (it.k === 'ellipse') {
      const { cx, cy, rx, ry } = ellipseOf(it), r = Math.max(rx, ry, 0.01), rot = it.rot || 0;
      const n = clamp(Math.ceil(Math.PI / Math.acos(Math.max(0, 1 - FLAT_TOL / r))), 16, 720);
      o = [];
      for (let i = 0; i < n; i++) {
        const a = 2 * Math.PI * i / n;
        o.push(...rotP(cx + rx * Math.cos(a), cy + ry * Math.sin(a), cx, cy, rot));
      }
      o.push(o[0], o[1]);
    } else {
      o = shapePts(it);
      if (it.k !== 'line') o.push(o[0], o[1]);
    }
  } else {
    // strokePath と同じ曲線: 各点を制御点、隣り合う点の中点を端点とする二次ベジェの連なり
    const p = it.p, n = p.length / 2;
    o = [p[0], p[1]];
    let ax = p[0], ay = p[1];
    for (let i = 1; i < n - 1; i++) {
      const cx = p[2 * i], cy = p[2 * i + 1], bx = (cx + p[2 * i + 2]) / 2, by = (cy + p[2 * i + 3]) / 2;
      const dev = Math.hypot(ax - 2 * cx + bx, ay - 2 * cy + by) / 4;      // 弦からの最大のずれ
      const m = clamp(Math.ceil(Math.sqrt(dev / FLAT_TOL)), 1, 24);
      for (let j = 1; j <= m; j++) {
        const t = j / m, u = 1 - t;
        o.push(u * u * ax + 2 * u * t * cx + t * t * bx, u * u * ay + 2 * u * t * cy + t * t * by);
      }
      ax = bx; ay = by;
    }
    o.push(p[2 * n - 2], p[2 * n - 1]);
  }
  flatCache.set(it, o);
  return o;
}
function boxOf(it) {
  let b = boxCache.get(it);
  if (b) return b;
  if (it.t === 'g' && !it.rot) b = [Math.min(it.x0, it.x1), Math.min(it.y0, it.y1), Math.max(it.x0, it.x1), Math.max(it.y0, it.y1)];
  else {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of it.t === 'f' ? it.r : [it.t === 'g' ? flatten(it) : it.p]) for (let i = 0; i < p.length; i += 2) {
      if (p[i] < b[0]) b[0] = p[i]; if (p[i] > b[2]) b[2] = p[i];
      if (p[i + 1] < b[1]) b[1] = p[i + 1]; if (p[i + 1] > b[3]) b[3] = p[i + 1];
    }
  }
  boxCache.set(it, b);
  return b;
}
// 線分 P→Q のうち、消しゴムの通り道（線分 A→B を半径 R で太らせた範囲）に入る区間 [t0,t1] を返す。なければ null。
// 通り道は「Aの円」「Bの円」「その間の長方形」を合わせた凸な形なので、入る区間は1つにまとまる。
function clipSeg(px, py, qx, qy, ax, ay, bx, by, R) {
  const dx = qx - px, dy = qy - py;
  let lo = Infinity, hi = -Infinity;
  const add = (a, b) => { if (a < 0) a = 0; if (b > 1) b = 1; if (a <= b) { if (a < lo) lo = a; if (b > hi) hi = b; } };
  const disc = (cx, cy) => {
    const fx = px - cx, fy = py - cy, A = dx * dx + dy * dy, C = fx * fx + fy * fy - R * R;
    if (A < 1e-18) { if (C <= 0) add(0, 1); return; }
    const B = fx * dx + fy * dy, q = B * B - A * C;
    if (q < 0) return;
    const s = Math.sqrt(q);
    add((-B - s) / A, (-B + s) / A);
  };
  disc(ax, ay);
  const ex = bx - ax, ey = by - ay, L = Math.hypot(ex, ey);
  if (L > 1e-9) {
    disc(bx, by);
    const ux = ex / L, uy = ey / L;
    const pu = (px - ax) * ux + (py - ay) * uy, pv = (py - ay) * ux - (px - ax) * uy;
    const du = dx * ux + dy * uy, dv = dy * ux - dx * uy;
    let t0 = 0, t1 = 1;
    const slab = (p0, d, mn, mx) => {
      if (Math.abs(d) < 1e-12) { if (p0 < mn || p0 > mx) t1 = -1; return; }
      let a = (mn - p0) / d, b = (mx - p0) / d;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a; if (b < t1) t1 = b;
    };
    slab(pu, du, 0, L); slab(pv, dv, -R, R);
    if (t0 <= t1) add(t0, t1);
  }
  return lo <= hi ? [lo, hi] : null;
}
// 折れ線 q から通り道に入った部分を切り取り、残りを折れ線の配列で返す。当たっていなければ null
function cutPoly(q, ax, ay, bx, by, R) {
  if (q.length === 2) {                      // 点だけの線
    const ex = bx - ax, ey = by - ay, L = ex * ex + ey * ey;
    const t = L ? clamp(((q[0] - ax) * ex + (q[1] - ay) * ey) / L, 0, 1) : 0;
    return Math.hypot(ax + t * ex - q[0], ay + t * ey - q[1]) <= R ? [] : null;
  }
  const out = [];
  let cur = [q[0], q[1]], len = 0, hit = false;
  const flush = () => { if (cur.length >= 4 && len > 0.05) out.push(cur); };
  const push = (x, y) => { len += Math.hypot(x - cur[cur.length - 2], y - cur[cur.length - 1]); cur.push(x, y); };
  for (let i = 0; i + 3 < q.length; i += 2) {
    const px = q[i], py = q[i + 1], qx = q[i + 2], qy = q[i + 3];
    const iv = clipSeg(px, py, qx, qy, ax, ay, bx, by, R);
    if (!iv) { push(qx, qy); continue; }
    hit = true;
    if (iv[0] > 1e-9) push(px + (qx - px) * iv[0], py + (qy - py) * iv[0]);
    flush();
    len = 0;
    if (iv[1] < 1 - 1e-9) { cur = [px + (qx - px) * iv[1], py + (qy - py) * iv[1]]; push(qx, qy); }
    else cur = [qx, qy];
  }
  if (!hit) return null;
  flush();
  return out;
}
/* 塗った面の部分消去。面から消しゴムの通り道を切り抜く。途中で2つに分かれたり穴があいたりするので、
   多角形どうしの差を求める Clipper (vendor/clipper.js) を使う。Clipper は整数で計算するため 0.01pt 単位に直す。 */
const CS = 100;
const toClip = q => { const o = []; for (let i = 0; i + 1 < q.length; i += 2) o.push({ X: Math.round(q[i] * CS), Y: Math.round(q[i + 1] * CS) }); return o; };
const ringsArea = ps => Math.abs(ps.reduce((s, p) => s + ClipperLib.Clipper.Area(p), 0));
function capsulePath(ax, ay, bx, by, R) {   // 通り道（両端が半円の帯）を多角形にする
  const a0 = Math.atan2(by - ay, bx - ax), n = 10, rr = R / Math.cos(Math.PI / (2 * n)), o = [];
  for (let i = 0; i <= n; i++) { const a = a0 + Math.PI / 2 + Math.PI * i / n; o.push(ax + rr * Math.cos(a), ay + rr * Math.sin(a)); }
  for (let i = 0; i <= n; i++) { const a = a0 - Math.PI / 2 + Math.PI * i / n; o.push(bx + rr * Math.cos(a), by + rr * Math.sin(a)); }
  return toClip(o);
}
// 当たっていなければ null。当たっていれば、残った面（なければ空）を項目の配列で返す
function cutFill(it, ax, ay, bx, by, R) {
  try {
    const C = ClipperLib;
    const subj = it.t === 'f' ? it.r.map(toClip) : [toClip(flatten(it).slice(0, -2))];
    const c = new C.Clipper();
    c.AddPaths(subj, C.PolyType.ptSubject, true);
    c.AddPath(capsulePath(ax, ay, bx, by, R), C.PolyType.ptClip, true);
    let sol = new C.Paths();
    c.Execute(C.ClipType.ctDifference, sol, C.PolyFillType.pftEvenOdd, C.PolyFillType.pftNonZero);
    if (Math.abs(ringsArea(sol) - ringsArea(subj)) < 2) return null;         // 面積が変わらない = 触れていない
    sol = C.Clipper.CleanPolygons(sol, 2).filter(p => p.length >= 3 && Math.abs(C.Clipper.Area(p)) > 0.2 * CS * CS);
    if (!sol.length) return [];
    return [{ t: 'f', id: uid(), c: it.c, f: it.f, r: sol.map(p => { const q = []; for (const v of p) q.push(v.X / CS, v.Y / CS); return q; }) }];
  } catch (e) {
    console.error(e);
    return null;
  }
}
function inPoly(q, x, y) {                   // 閉じた折れ線 q の内側か
  let c = false;
  for (let i = 0, j = q.length - 2; i < q.length; j = i, i += 2) {
    if ((q[i + 1] > y) !== (q[j + 1] > y) && x < (q[j] - q[i]) * (y - q[i + 1]) / (q[j + 1] - q[i + 1]) + q[i]) c = !c;
  }
  return c;
}
// タップでの選択の当たり判定。画像と塗った面は面、線と図形は線の近く（塗りつぶした図形は面も）。グループは中のどれかに当たれば当たり
function hitItem(a, x, y, tol) {
  if (a.t === 'G') return a.ch.some(c => hitItem(c, x, y, tol));
  if (a.t === 'i') {
    const [cx, cy] = centerOf(a), [u, v] = rotP(x, y, cx, cy, -(a.rot || 0));
    return u >= a.x && u <= a.x + a.w && v >= a.y && v <= a.y + a.h;
  }
  if (a.t === 'f') return a.r.reduce((n, q) => n ^ inPoly(q, x, y), false) === 1;
  const q = flatten(a);
  return (filled(a) && inPoly(q, x, y)) || cutPoly(q, x, y, x, y, tol + a.w / 2) !== null;
}
// 消しゴムの通り道にかかった部分を項目の並び arr から消す。変わらなければ null、変われば新しい並びを返す。
// グループの中の線や図形も消す（中が空になったグループはなくなる）。画像は消しゴムでは消さない
function eraseList(arr, ax, ay, x, y, rad) {
  const x0 = Math.min(ax, x), x1 = Math.max(ax, x), y0 = Math.min(ay, y), y1 = Math.max(ay, y);
  let out = null;
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    let rep = null;                          // この項目と置き換える項目の並び
    if (it.t === 'G') {
      const ch = eraseList(it.ch, ax, ay, x, y, rad);
      if (ch) rep = ch.length ? [{ ...it, ch }] : [];
    } else if (it.t !== 'i') {
      const area = it.t === 'f' || filled(it);   // 塗った面は面として削る。線と輪郭は線として切る
      const R = area ? rad : rad + it.w / 2, b = boxOf(it);
      if (b[0] <= x1 + R && b[2] >= x0 - R && b[1] <= y1 + R && b[3] >= y0 - R) {
        const parts = area ? cutFill(it, ax, ay, x, y, R) : cutPoly(flatten(it), ax, ay, x, y, R);
        if (parts) rep = area ? parts : parts.map(q => ({ t: 's', id: uid(), c: it.c, w: it.w, a: it.a || 1, l: 1, p: q.map(r2) }));
      }
    }
    if (!rep) { if (out) out.push(it); continue; }
    if (!out) out = arr.slice(0, i);
    out.push(...rep);
  }
  return out;
}
// 消しゴムを (x,y) まで動かす。前回の位置からの通り道にかかった部分を消す
function eraseTo(g, x, y) {
  const ax = g.ex === undefined ? x : g.ex, ay = g.ex === undefined ? y : g.ey;
  g.ex = x; g.ey = y;
  queueOverlay();
  const page = g.sh.page, arr = S.annots[page];
  if (!arr) return;
  const out = eraseList(arr, ax, ay, x, y, ERASER_PX[S.width] / g.k);
  if (!out) return;
  if (!g.pushed) { pushUndo(page); g.pushed = true; }      // 1回のなぞりを1回の「取り消す」で戻せるようにする
  S.annots[page] = out;
  drawAnn(g.sh); touch();
}

/* ---------- 選択と変形 ----------
   選択は1つのページの中の項目の集まり sel = {page, ids, rot}。rot は選択枠の向き（1つだけ選んだときはその項目の回転）。
   移動・拡大縮小・回転は、1つでも複数でもグループでも xformItem（相似変換）で行う。コピーの位置合わせも同じ関数を使う。
   変形の途中は、動かし始めたときの項目（g.orig）から毎回計算し直すので、丸めの誤差がたまらない。 */
const HANDLE_PX = 24;        // 取っ手の当たりの半径（画面上のピクセル）
const ROT_STEM_PX = 30;      // 回転の取っ手を枠の上辺からどれだけ離すか（画面上のピクセル）

function ensureId(it) {
  if (!it.id) it.id = uid();
  if (it.t === 'G') it.ch.forEach(ensureId);
}
// 角度を -π〜π にそろえる
const normA = a => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return Math.round((a - Math.PI) * 1e4) / 1e4; };
// 45度ごとの角度の近く（±3度）では吸い付ける。まっすぐに戻しやすくするため
const snapA = a => { const st = Math.PI / 4, n = Math.round(a / st); return Math.abs(a - n * st) < 0.052 ? n * st : a; };
const boxItem = it => it.t === 'i' || (it.t === 'g' && it.k !== 'line');   // 縦横を別々に変えられる項目

function imgCorners(it) {
  const [cx, cy] = centerOf(it), a = it.rot || 0, o = [];
  for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) o.push(...rotP(it.x + u * it.w, it.y + v * it.h, cx, cy, a));
  return o;
}
// 項目の形を折れ線の集まりで表す（範囲選択の当たり判定と選択枠の計算に使う）。
// q は折れ線 [x,y,...]、area は内側も当たりにするか、w は線の太さ
function outlines(it, out = []) {
  if (it.t === 'G') for (const c of it.ch) outlines(c, out);
  else if (it.t === 'i') { const q = imgCorners(it); out.push({ q: [...q, q[0], q[1]], area: true, w: 0 }); }
  else if (it.t === 'f') for (const r of it.r) out.push({ q: [...r, r[0], r[1]], area: true, w: 0 });
  else out.push({ q: flatten(it), area: filled(it), w: filled(it) ? 0 : it.w });
  return out;
}
const bbCache = new WeakMap();
// 線の太さを含めた外接長方形 [x0,y0,x1,y1]
function bboxAll(it) {
  let b = bbCache.get(it);
  if (b) return b;
  b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const o of outlines(it)) {
    const h = o.w / 2, q = o.q;
    for (let i = 0; i < q.length; i += 2) {
      if (q[i] - h < b[0]) b[0] = q[i] - h; if (q[i] + h > b[2]) b[2] = q[i] + h;
      if (q[i + 1] - h < b[1]) b[1] = q[i + 1] - h; if (q[i + 1] + h > b[3]) b[3] = q[i + 1] + h;
    }
  }
  bbCache.set(it, b);
  return b;
}
const unionBox = items => items.map(bboxAll).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])],
  [Infinity, Infinity, -Infinity, -Infinity]);

function segX(ax, ay, bx, by, cx, cy, dx, dy) {   // 線分 AB と CD が交わるか
  const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax), d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  if ((d1 > 0) === (d2 > 0)) return false;
  const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx), d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  return (d3 > 0) !== (d4 > 0);
}
// 範囲（閉じた多角形 poly、外接長方形 pb）に項目の一部でもかかっているか。
// 線は一部でも入っていれば線全体を選ぶ（消しゴムのように切り分けない）
function regionHit(it, poly, pb) {
  const b = bboxAll(it);
  if (b[0] > pb[2] || b[2] < pb[0] || b[1] > pb[3] || b[3] < pb[1]) return false;
  for (const o of outlines(it)) {
    const q = o.q;
    for (let i = 0; i < q.length; i += 2) if (inPoly(poly, q[i], q[i + 1])) return true;
    if (o.area && inPoly(q, poly[0], poly[1])) return true;     // 範囲がまるごと画像や面の内側にある
    for (let i = 0; i + 3 < q.length; i += 2) {
      for (let j = 0, k = poly.length - 2; j < poly.length; k = j, j += 2) {
        if (segX(q[i], q[i + 1], q[i + 2], q[i + 3], poly[k], poly[k + 1], poly[j], poly[j + 1])) return true;
      }
    }
  }
  return false;
}
// なぞった範囲の多角形。投げ縄はなぞった点の並び、長方形は始点と今の点を対角とする
function regionPoly(g) {
  const p = g.pts;
  if (g.lasso) return p;
  const x0 = p[0], y0 = p[1], x1 = p[p.length - 2], y1 = p[p.length - 1];
  return [x0, y0, x1, y0, x1, y1, x0, y1];
}

/* 相似変換 T = {px, py, s, a, dx, dy}: 点 (px,py) を中心に s 倍して a ラジアン回し、(dx,dy) だけ動かす。
   xformItem は変換した複製を返す（id はそのまま）。線の太さは変えない。
   線・面は点を直接動かし、図形・画像は中心を動かして大きさと rot を変える。グループは中の項目を同じように変換する。 */
function mapPt(T, x, y) {
  const c = Math.cos(T.a), s = Math.sin(T.a), ux = (x - T.px) * T.s, uy = (y - T.py) * T.s;
  return [r2(T.px + ux * c - uy * s + T.dx), r2(T.py + ux * s + uy * c + T.dy)];
}
const moveT = (dx, dy) => ({ px: 0, py: 0, s: 1, a: 0, dx, dy });
function xformItem(it, T) {
  const o = { ...it };
  const mp = q => { const r = new Array(q.length); for (let i = 0; i < q.length; i += 2) [r[i], r[i + 1]] = mapPt(T, q[i], q[i + 1]); return r; };
  const spin = () => { const a = normA((it.rot || 0) + T.a); if (a) o.rot = a; else delete o.rot; };
  if (it.t === 'G') { o.ch = it.ch.map(c => xformItem(c, T)); if (T.a) spin(); }
  else if (it.t === 's') o.p = mp(it.p);
  else if (it.t === 'f') o.r = it.r.map(mp);
  else if (isLine(it)) [o.x0, o.y0, o.x1, o.y1] = mp([it.x0, it.y0, it.x1, it.y1]);
  else {
    const [cx, cy] = centerOf(it), [nx, ny] = mapPt(T, cx, cy);
    if (it.t === 'i') { o.w = r2(it.w * T.s); o.h = r2(it.h * T.s); o.x = r2(nx - o.w / 2); o.y = r2(ny - o.h / 2); }
    else {
      o.x0 = r2(nx + (it.x0 - cx) * T.s); o.x1 = r2(nx + (it.x1 - cx) * T.s);
      o.y0 = r2(ny + (it.y0 - cy) * T.s); o.y1 = r2(ny + (it.y1 - cy) * T.s);
    }
    if (T.a) spin();
  }
  return o;
}
// 図形・画像1つを右下の取っ手で大きさを変える。回転していても、その向きのまま左上の角を止めて右辺と下辺を動かす。
// 図形は縦横比が自由、画像は縦横比を保つ
function resizeBox(o, dx, dy) {
  const img = o.t === 'i', a = o.rot || 0, [cx, cy] = centerOf(o);
  const bx = img ? o.x : Math.min(o.x0, o.x1), by = img ? o.y : Math.min(o.y0, o.y1);
  const w0 = img ? o.w : Math.abs(o.x1 - o.x0), h0 = img ? o.h : Math.abs(o.y1 - o.y0);
  const F = rotP(bx, by, cx, cy, a);                         // 止める角
  const [lx, ly] = rotP(dx, dy, 0, 0, -a);                   // 動かした量を図形の向きで見る
  const min = img ? 12 : 2;
  const w = Math.max(min, w0 + lx), h = img ? w * o.h / o.w : Math.max(min, h0 + ly);
  const [ncx, ncy] = rotP(F[0] + w / 2, F[1] + h / 2, F[0], F[1], a);
  const n = { ...o };
  if (img) { n.w = r2(w); n.h = r2(h); n.x = r2(ncx - w / 2); n.y = r2(ncy - h / 2); }
  else {                                     // 始点と終点の向き（三角形・星の上下）は保つ
    const sx = o.x1 >= o.x0 ? 1 : -1, sy = o.y1 >= o.y0 ? 1 : -1;
    n.x0 = r2(ncx - sx * w / 2); n.x1 = r2(ncx + sx * w / 2); n.y0 = r2(ncy - sy * h / 2); n.y1 = r2(ncy + sy * h / 2);
  }
  return n;
}

// 選択中の項目（重なり順）。選んだページが表示されていなければ空
function selItems() {
  if (!sel || !sheets.some(s => s.page === sel.page)) return [];
  const ids = new Set(sel.ids);
  return (S.annots[sel.page] || []).filter(i => ids.has(i.id));
}
function setSel(page, items) {
  sel = items.length ? { page, ids: items.map(i => i.id), rot: items.length === 1 && !isLine(items[0]) ? items[0].rot || 0 : 0 } : null;
}
// 選択枠: 向き a で見たときの外接長方形 {cx, cy, w, h, rot}
let frameMemo = null;
function selFrame(items, a) {
  const m = frameMemo;
  if (m && m.a === a && m.items.length === items.length && m.items.every((x, i) => x === items[i])) return m.f;
  const c = Math.cos(a), s = Math.sin(a);
  let u0 = Infinity, v0 = Infinity, u1 = -Infinity, v1 = -Infinity;
  for (const it of items) for (const o of outlines(it)) {
    const h = o.w / 2, q = o.q;
    for (let i = 0; i < q.length; i += 2) {
      const u = q[i] * c + q[i + 1] * s, v = q[i + 1] * c - q[i] * s;   // -a だけ回した座標
      if (u - h < u0) u0 = u - h; if (u + h > u1) u1 = u + h;
      if (v - h < v0) v0 = v - h; if (v + h > v1) v1 = v + h;
    }
  }
  const um = (u0 + u1) / 2, vm = (v0 + v1) / 2;
  const f = { cx: um * c - vm * s, cy: um * s + vm * c, w: u1 - u0, h: v1 - v0, rot: a };
  frameMemo = { items, a, f };
  return f;
}
// 枠の中心から枠の向きで (lx,ly) の位置
const frameP = (f, lx, ly) => [f.cx + lx * Math.cos(f.rot) - ly * Math.sin(f.rot), f.cy + lx * Math.sin(f.rot) + ly * Math.cos(f.rot)];
// 選択枠と取っ手の画面上の位置（ステージ左上が原点のピクセル）。描画と当たり判定で共通に使う
function selGeom() {
  const items = selItems();
  if (!items.length) return null;
  const sh = sheets.find(s => s.page === sel.page), t = sheetXform(sh);
  const P = p => [t.ox + p[0] * t.k, t.oy + p[1] * t.k];
  const r = { items, sh, t };
  if (items.length === 1 && isLine(items[0])) {
    const it = items[0];
    r.ends = [P([it.x0, it.y0]), P([it.x1, it.y1])];
    return r;
  }
  const f = selFrame(items, sel.rot || 0), pad = 6 / t.k, hw = f.w / 2 + pad, hh = f.h / 2 + pad;
  Object.assign(r, {
    f, hw, hh, group: items.length === 1 && items[0].t === 'G',
    corners: [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([a, b]) => P(frameP(f, a, b))),
    topMid: P(frameP(f, 0, -hh)),
    rot: P(frameP(f, 0, -hh - ROT_STEM_PX / t.k)),
  });
  return r;
}
// 押した位置が選択中のものの取っ手・枠の内側なら、その操作を返す
function selHandleAt(e) {
  const sg = selGeom();
  if (!sg) return null;
  const sr = stage.getBoundingClientRect(), x = e.clientX - sr.left, y = e.clientY - sr.top;
  const near = p => Math.hypot(p[0] - x, p[1] - y) < HANDLE_PX;
  const px = (x - sg.t.ox) / sg.t.k, py = (y - sg.t.oy) / sg.t.k;
  if (sg.ends) {
    if (near(sg.ends[1])) return { sg, mode: 'end1' };
    if (near(sg.ends[0])) return { sg, mode: 'end0' };
    return hitItem(sg.items[0], px, py, 14 / sg.t.k) ? { sg, mode: 'move' } : null;
  }
  if (near(sg.rot)) return { sg, mode: 'rot' };
  if (near(sg.corners[2])) return { sg, mode: sg.items.length === 1 && boxItem(sg.items[0]) ? 'resize' : 'scale' };
  const f = sg.f, [u, v] = rotP(px, py, f.cx, f.cy, -f.rot);
  return Math.abs(u - f.cx) <= sg.hw && Math.abs(v - f.cy) <= sg.hh ? { sg, mode: 'move' } : null;
}

/* 選択の道具での操作:
   選択中のものの取っ手 → 回転・拡大縮小（直線は両端）。選択枠の内側 → まとめて移動。
   何かに触れた → それだけを選んで移動。何もないところ → なぞった範囲（長方形または投げ縄）で選ぶ
   追加選択がオンの間は、取っ手は同じように使えるが、枠の内側を押しても移動せず、
   触れたものを選択に足す（選択済みなら外す）。なぞった範囲で選んだものも選択に足す */
function startSelect(e, isTouch) {
  const base = { tool: 'select', id: e.pointerId, touch: isTouch, pushed: false };
  const hd = selHandleAt(e);
  if (hd && !(addMode && hd.mode === 'move')) {
    const sh = hd.sg.sh, r = sh.el.getBoundingClientRect();
    g = { ...base, sh, r, k: r.width / sh.W, mode: hd.mode, orig: hd.sg.items, f0: hd.sg.f };
    [g.x0, g.y0] = pt(g, e);
    return;
  }
  const h = locate(e);
  if (!h) { if (sel && !addMode) { sel = null; syncUI(); drawOverlay(); } return; }
  g = { ...base, sh: h.sh, k: h.k, r: h.r, x0: h.x, y0: h.y };
  const arr = S.annots[h.sh.page] || [];
  let it = null;
  for (let i = arr.length - 1; i >= 0 && !it; i--) if (hitItem(arr[i], h.x, h.y, 12 / h.k)) it = arr[i];   // 手前にあるものから探す
  if (it && addMode) {                       // 追加選択: 押したものを足す。選択済みなら外す
    const ids = new Set(sel && sel.page === h.sh.page ? sel.ids : []);
    if (ids.has(it.id)) ids.delete(it.id); else ids.add(it.id);
    setSel(h.sh.page, arr.filter(i => ids.has(i.id)));
    g = null;
  } else if (it) {
    setSel(h.sh.page, [it]);
    Object.assign(g, { mode: 'move', orig: [it] });
  } else {
    if (!addMode) sel = null;
    Object.assign(g, { mode: 'region', lasso: S.selMode === 'lasso', pts: [r2(h.x), r2(h.y)] });
  }
  syncUI(); drawOverlay();
}
function replaceItems(page, next) {
  const m = new Map(next.map(i => [i.id, i]));
  S.annots[page] = (S.annots[page] || []).map(i => m.get(i.id) || i);
}
// 移動中の選択を見開きの隣のページへ移す。画面上の位置が変わらないように座標を付け替える
function moveSelToSheet(nsh) {
  const osh = g.sh, ro = osh.el.getBoundingClientRect(), rn = nsh.el.getBoundingClientRect(), k = rn.width / nsh.W;
  const dx = (ro.left - rn.left) / k, dy = (ro.top - rn.top) / k + osh.m - nsh.m;
  const top = undo[undo.length - 1];
  if (top.page !== nsh.page && !(top.also || []).some(e => e.page === nsh.page)) {   // 移る先のページも同じ1回の取り消しで戻す
    (top.also = top.also || []).push({ page: nsh.page, items: (S.annots[nsh.page] || []).slice() });
  }
  const ids = new Set(sel.ids), arr = S.annots[osh.page];
  S.annots[osh.page] = arr.filter(a => !ids.has(a.id));
  S.annots[nsh.page] = [...(S.annots[nsh.page] || []), ...arr.filter(a => ids.has(a.id))];
  g.orig = g.orig.map(o => xformItem(o, moveT(dx, dy)));
  g.x0 += dx; g.y0 += dy;
  g.sh = nsh; g.k = k; g.r = rn;
  sel.page = nsh.page;
  drawAnn(osh);
}
function selDrag(e) {
  let [x, y] = pt(g, e);
  if (g.mode === 'region') {
    const p = g.pts;
    if (!g.lasso) g.pts = [p[0], p[1], r2(x), r2(y)];
    else {
      const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
      for (const ev of evs.length ? evs : [e]) {
        const [qx, qy] = pt(g, ev);
        if (Math.hypot(qx - p[p.length - 2], qy - p[p.length - 1]) * g.k >= 3) p.push(r2(qx), r2(qy));
      }
    }
    queueOverlay();
    return;
  }
  if (!g.pushed) {                           // 動かし始めたときに履歴へ積む
    if (Math.hypot(x - g.x0, y - g.y0) * g.k < 3) return;
    pushUndo(g.sh.page); g.pushed = true;
  }
  if (g.mode === 'move') {                   // 見開きの隣のページの上まで動かしたら、そのページへ移す
    const h = locate(e);
    if (h && h.sh !== g.sh) { moveSelToSheet(h.sh); [x, y] = pt(g, e); }
  }
  const dx = x - g.x0, dy = y - g.y0, f = g.f0;
  let next;
  if (g.mode === 'move') next = g.orig.map(o => xformItem(o, moveT(dx, dy)));
  else if (g.mode === 'rot') {               // 枠の中心まわりに、取っ手を動かした角度だけ回す
    const a = snapA(f.rot + Math.atan2(y - f.cy, x - f.cx) - Math.atan2(g.y0 - f.cy, g.x0 - f.cx)) - f.rot;
    next = g.orig.map(o => xformItem(o, { px: f.cx, py: f.cy, s: 1, a, dx: 0, dy: 0 }));
    sel.rot = normA(f.rot + a);
  } else if (g.mode === 'scale') {           // 左上の角を止め、縦横の比率を保って拡大縮小する
    const A = frameP(f, -f.w / 2, -f.h / 2), H = frameP(f, f.w / 2, f.h / 2);
    const vx = H[0] - A[0], vy = H[1] - A[1], L2 = vx * vx + vy * vy;
    const s = L2 < 1e-6 ? 1 : Math.max(1 + (dx * vx + dy * vy) / L2, 4 / Math.sqrt(L2), 0.02);
    next = g.orig.map(o => xformItem(o, { px: A[0], py: A[1], s, a: 0, dx: 0, dy: 0 }));
  } else if (g.mode === 'resize') next = [resizeBox(g.orig[0], dx, dy)];
  else {                                     // 直線の端を動かす
    const o = g.orig[0], n = { ...o };
    if (g.mode === 'end0') { n.x0 = r2(o.x0 + dx); n.y0 = r2(o.y0 + dy); } else { n.x1 = r2(o.x1 + dx); n.y1 = r2(o.y1 + dy); }
    next = [n];
  }
  replaceItems(g.sh.page, next);
  drawAnn(g.sh); drawOverlay(); touch();
}
function finishSelect() {
  if (g.mode === 'region') {
    const poly = regionPoly(g), page = g.sh.page;
    const xs = poly.filter((_, i) => i % 2 === 0), ys = poly.filter((_, i) => i % 2 === 1);
    const pb = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const big = (pb[2] - pb[0]) * g.k >= 4 || (pb[3] - pb[1]) * g.k >= 4;    // 小さすぎる範囲はただのタップとみなす
    const arr = S.annots[page] || [], hits = big ? arr.filter(it => regionHit(it, poly, pb)) : [];
    if (!addMode) setSel(page, hits);
    else if (hits.length) {                  // 追加選択: 囲んだものを今の選択に足す（何も囲まなければ選択はそのまま）
      const ids = new Set([...(sel && sel.page === page ? sel.ids : []), ...hits.map(i => i.id)]);
      setSel(page, arr.filter(i => ids.has(i.id)));
    }
  }
  g = null;
  syncUI(); drawOverlay();
}

stage.addEventListener('pointermove', e => {
  if (!g) return;
  if (e.pointerType === 'touch' && touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (g.type === 'pinch') {
    if (touches.size < 2) return;
    const [a, b] = [...touches.values()];
    const sr = stage.getBoundingClientRect();
    const mx = (a.x + b.x) / 2 - sr.left, my = (a.y + b.y) / 2 - sr.top;
    const z = clamp(g.v.z * Math.hypot(a.x - b.x, a.y - b.y) / g.d, 1, MAX_Z);
    view.z = z;
    view.tx = mx - (g.mx - g.v.tx) * z / g.v.z;
    view.ty = my - (g.my - g.v.ty) * z / g.v.z;
    clampView(); applyView();
  } else if (g.type === 'pan') {
    if (g.v.z > 1.01) {
      view.tx = g.v.tx + e.clientX - g.x; view.ty = g.v.ty + e.clientY - g.y;
      clampView(); applyView();
    }
  } else if (g.tool && e.pointerId === g.id) moveTool(e);
});

function moveTool(e) {
  if (g.stroke && g.stroke.t === 'g') {
    const [x, y] = pt(g, e);
    g.stroke.x1 = r2(x); g.stroke.y1 = r2(y);
    queueOverlay();
  } else if (g.stroke) {
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    const p = g.stroke.p;
    for (const ev of evs.length ? evs : [e]) {
      const [x, y] = pt(g, ev);
      if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) * g.k >= 0.7) p.push(r2(x), r2(y));
    }
    queueOverlay();
  } else if (g.tool === 'eraser') {
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    for (const ev of evs.length ? evs : [e]) { const [x, y] = pt(g, ev); eraseTo(g, x, y); }
  } else if (g.mode) selDrag(e);
}

function onUp(e) {
  touches.delete(e.pointerId);
  if (!g) return;
  if (g.type === 'pinch' || g.type === 'idle') {
    g = touches.size ? { type: 'idle' } : null;      // 指が全部離れるまで他の操作を始めない
  } else if (g.type === 'pan') {
    const dx = e.clientX - g.x, dy = e.clientY - g.y;
    if (g.v.z <= 1.01 && e.type === 'pointerup' && Math.abs(dx) > 60 && Math.abs(dx) > 2 * Math.abs(dy)) {
      turn((dx > 0) === S.rtl ? 1 : -1);             // 右綴じでは右へ払うと次のページ
    }
    g = null;
  } else if (g.tool === 'select' && e.pointerId === g.id) {
    finishSelect();
  } else if (g.tool && e.pointerId === g.id) {
    const st = g.stroke;
    // 図形は、ほとんど動かさずに離したら描かない
    if (st && (st.t !== 'g' || Math.hypot(st.x1 - st.x0, st.y1 - st.y0) * g.k >= 3)) {
      const page = g.sh.page;
      pushUndo(page);
      (S.annots[page] = S.annots[page] || []).push(g.stroke);
      if (sheets.includes(g.sh)) strokePath(annCtx(g.sh), g.stroke);
      touch();
    }
    g = null;
    drawOverlay();
  }
}
stage.addEventListener('pointerup', onUp);
stage.addEventListener('pointercancel', onUp);

stage.addEventListener('wheel', e => {          // パソコンでの確認用: Ctrl+ホイール（トラックパッドのピンチ）でズーム
  if (!pdf) return;
  e.preventDefault();
  const sr = stage.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) {
    const mx = e.clientX - sr.left, my = e.clientY - sr.top;
    const z = clamp(view.z * Math.exp(-e.deltaY * 0.01), 1, MAX_Z);
    view.tx = mx - (mx - view.tx) * z / view.z;
    view.ty = my - (my - view.ty) * z / view.z;
    view.z = z;
  } else { view.tx -= e.deltaX; view.ty -= e.deltaY; }
  clampView(); applyView();
}, { passive: false });
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, e => e.preventDefault());
document.addEventListener('contextmenu', e => e.preventDefault());

/* ---------- 画像 ---------- */
// 写真を受け取れなかったとき（空のファイル、読めないファイル、オフラインで何も届かない）の説明と解決策。
// iCloud写真で「ストレージを最適化」にしていると、オリジナルが端末にない写真はオフラインでは届かない
function photoFail() {
  const on = navigator.onLine;
  setNote({
    photo: true,
    title: '写真を読み込めませんでした',
    body: on
      ? 'この画像の形式を読み込めないか、写真のダウンロードに失敗しました。次のどれかで貼れます。'
      : 'iCloud写真で「iPadのストレージを最適化」にしていると、オリジナルが端末にない写真は、オフラインでは読み込めません。次のどれかで貼れます。',
    steps: [
      ...(on ? [] : ['オンラインにしてから、もう一度「画像」で選ぶ']),
      'スクリーンショットを撮り、左下に出る縮小画面を押して範囲を切り取り、「完了」→「コピーして削除」を選んでから、このアプリの「貼り付け」で貼る（オフラインでも使える）',
      '前もって「ファイル」アプリの「このiPad内」に保存した画像を、「画像」→「ファイルを選択」から選ぶ',
      '設定 →「写真」で「ダウンロードしてオリジナルを保持」にしておく（端末の空き容量が必要）',
    ],
  });
}
async function addImage(blob) {
  if (!pdf || busy) return;
  if (!blob || !blob.size) { photoFail(); return; }
  const doc = pdf;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(Object.assign(new Error('画像を読み込めません'), { photo: true })); img.src = url; });
    if (stat.note && stat.note.photo) stat.note = null;   // 前に読み込めなかったときの説明は、読み込めたら片付ける
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    if (doc !== pdf) return;                   // 読み込み中に別のPDFへ切り替わった
    const jpg = blob.type === 'image/jpeg';
    const id = uid();
    assets[id] = jpg ? c.toDataURL('image/jpeg', 0.85) : c.toDataURL('image/png');
    assetsDirty = true;

    // 画面の中央に近いページへ、見えている範囲の中央に置く
    const sr = stage.getBoundingClientRect();
    const cx = sr.left + sr.width / 2, cy = sr.top + sr.height / 2;
    let sh = sheets[0], best = Infinity;
    for (const s of sheets) {
      const r = s.el.getBoundingClientRect();
      const d = Math.abs((r.left + r.right) / 2 - cx);
      if (d < best) { best = d; sh = s; }
    }
    const r = sh.el.getBoundingClientRect(), kk = r.width / sh.W;
    const w = sh.W * 0.4, h = w * c.height / c.width;
    const px = clamp((cx - r.left) / kk, w / 2, sh.W - w / 2);
    const py = clamp((cy - r.top) / kk - sh.m, -sh.m + h / 2, sh.H + sh.m - h / 2);
    const it = { t: 'i', id: uid(), a: id, x: r2(px - w / 2), y: r2(py - h / 2), w: r2(w), h: r2(h) };
    pushUndo(sh.page);
    (S.annots[sh.page] = S.annots[sh.page] || []).push(it);
    S.tool = 'select'; setSel(sh.page, [it]);
    drawAnn(sh); drawOverlay(); syncUI(); touch();
  } catch (e) {
    if (e.photo) photoFail(); else alert(e.message);
  } finally { URL.revokeObjectURL(url); }
}
/* 貼り付け（ボタンとキーボードの ⌘V で共通）。端末のクリップボードに最後に入れたものを貼る。
   1. このアプリで「コピー」したときの目印 → アプリ内でコピーした書き込み
   2. 画像 → 画像（ほかのアプリでコピーしたもの）
   3. それ以外（ほかのアプリの文字など）→ アプリ内でコピーした書き込みがあればそれ
   クリップボードを読めないときも、アプリ内でコピーした書き込みがあればそれを貼る */
const NOTHING_TO_PASTE = '貼れるものがありません。ほかのアプリで画像をコピーするか、このアプリで書き込みを選んで「コピー」してください。';
document.addEventListener('paste', e => {
  const cd = e.clipboardData;
  const f = [...(cd ? cd.files : [])].find(f => f.type.startsWith('image/'));
  const text = cd ? cd.getData('text/plain') : '';
  if (clip && text === clip.tag) { e.preventDefault(); pasteClip(); }
  else if (f) { e.preventDefault(); addImage(f); }
  else if (clip) { e.preventDefault(); pasteClip(); }
});
async function pasteFromClipboard() {
  let items;
  try { items = await navigator.clipboard.read(); }
  catch (e) {
    if (clip) return pasteClip();
    alert('クリップボードを読めませんでした。「画像」ボタンからファイルを選んでください。\n(' + e.message + ')');
    return;
  }
  if (clip) {
    for (const it of items) {
      if (!it.types.includes('text/plain')) continue;
      const text = await (await it.getType('text/plain')).text().catch(() => '');
      if (text === clip.tag) return pasteClip();
    }
  }
  for (const it of items) {
    const type = it.types.find(t => t.startsWith('image/'));
    if (type) return addImage(await it.getType(type));
  }
  if (clip) return pasteClip();
  alert(NOTHING_TO_PASTE);
}
/* ---------- 選択したものへの操作 ---------- */
// 選択中のページの並びを fn(arr, ids, items) で作り直す。fn が null を返したら何もしない（履歴にも積まない）
function selEdit(fn) {
  const items = selItems();
  if (!items.length) return;
  const page = sel.page, arr = S.annots[page], ids = new Set(sel.ids);
  const next = fn(arr, ids, items);
  if (!next) return;
  pushUndo(page);
  S.annots[page] = next;
  const sh = sheets.find(s => s.page === page);
  if (sh) drawAnn(sh);
  drawOverlay(); syncUI(); touch();
}
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
// 選択したものを、そのページの書き込みの最前面または最背面へ移す。選択したもの同士の重なり順は保つ。
// PDF本体は書き込みより常に奥にある
function reorderSel(front) {
  selEdit((arr, ids) => {
    const mv = arr.filter(i => ids.has(i.id)), rest = arr.filter(i => !ids.has(i.id));
    const next = front ? [...rest, ...mv] : [...mv, ...rest];
    return sameList(next, arr) ? null : next;
  });
}
function deleteSel() {
  selEdit((arr, ids) => { sel = null; return arr.filter(i => !ids.has(i.id)); });
}
// グループは、選んだもののうち一番手前のものの位置に入る
function groupSel() {
  selEdit((arr, ids, items) => {
    if (items.length < 2) return null;
    const grp = { t: 'G', id: uid(), ch: items }, last = items[items.length - 1];
    sel = { page: sel.page, ids: [grp.id], rot: 0 };
    return arr.flatMap(i => i === last ? [grp] : ids.has(i.id) ? [] : [i]);
  });
}
// グループを解除して、中の項目を元の重なり順のまま並びに戻す（1段だけ）。解除したものは選んだままにする
function ungroupSel() {
  selEdit((arr, ids, items) => {
    if (!items.some(i => i.t === 'G')) return null;
    setSel(sel.page, items.flatMap(i => i.t === 'G' ? i.ch : [i]));
    return arr.flatMap(i => ids.has(i.id) && i.t === 'G' ? i.ch : [i]);
  });
}

/* 属性の変更。グループは中の項目に適用する。手書きの線は一部だけ範囲に入っていても線全体が変わる。
   c 色 / w 太さ（s m l）/ a 線の不透明度 / f 塗りの濃さ（0 は塗りなし）/ ar 直線の矢印 */
const leaves = items => items.flatMap(i => i.t === 'G' ? leaves(i.ch) : [i]);
const ATTR_OK = {
  c: it => it.t !== 'i',
  w: it => it.t === 's' || (it.t === 'g' && !filled(it)),
  a: it => it.t === 's' || (it.t === 'g' && !filled(it)),
  f: it => it.t === 'f' || (it.t === 'g' && it.k !== 'line'),
  ar: isLine,
};
function attrVal(it, key) {
  if (key === 'w') return Object.keys(WIDTHS).find(k => Math.abs(WIDTHS[k] * (isMarker(it) ? 6 : 1) - it.w) < 0.01) || '';
  if (key === 'a') return String(it.a || 1);
  if (key === 'f') return String(it.f || 0);
  if (key === 'ar') return String(it.ar | 0);
  return it.c;
}
function withAttr(it, key, v) {
  if (it.t === 'G') {
    const ch = it.ch.map(c => withAttr(c, key, v));
    return sameList(ch, it.ch) ? it : { ...it, ch };
  }
  if (!ATTR_OK[key](it) || attrVal(it, key) === v) return it;
  if (key === 'f' && it.t === 'f' && !+v) return it;   // 消しゴムで削った面は塗りをなくせない（輪郭線を持たないため）
  const o = { ...it };
  if (key === 'c') o.c = v;
  else if (key === 'w') o.w = WIDTHS[v] * (isMarker(it) ? 6 : 1);
  else if (key === 'a') { if (+v === 1 && it.t === 'g') delete o.a; else o.a = +v; }
  else if (key === 'f') { if (+v) o.f = +v; else delete o.f; }
  else if (key === 'ar') { if (+v) o.ar = +v; else delete o.ar; }
  return o;
}
function setSelAttr(key, v) {
  selEdit((arr, ids) => {
    const next = arr.map(i => ids.has(i.id) ? withAttr(i, key, v) : i);
    return sameList(next, arr) ? null : next;
  });
}

/* コピーと貼り付け（アプリの中だけのクリップボード）。
   コピーした時点で項目の複製と、含まれる画像のデータを持っておくので、元のPDFを閉じたり切り替えたりしても貼れる。
   貼った画像は貼り先のPDFの画像として保存される。
   位置: 座標はページ左上を原点とするPDFポイント（1pt = 1/72インチ）なので、大きさは変えずに実寸のまま、
   元と同じ位置に貼る。元と同じページに貼るときだけ、重ならないように右下へ少しずつずらす。
   貼り先のページが小さくてはみ出すときは、ページ（表示中の枠外領域を含む）の内側に収まるよう平行に移す。 */
let clip = null;             // {items, assets, doc, page, n, tag}
const CLIP_TAG = 'daihon-note-copy:';
function copySel() {
  const items = selItems();
  if (!items.length) return;
  const as = {};
  for (const it of leaves(items)) if (it.t === 'i' && assets[it.a]) as[it.a] = assets[it.a];
  clip = { items: JSON.parse(JSON.stringify(items)), assets: as, doc: D.id, page: sel.page, n: 0, tag: CLIP_TAG + uid() };
  // 端末のクリップボードにも目印を書いておく。「貼り付け」で、最後にコピーしたのがこのアプリの書き込みか、
  // ほかのアプリの画像かを見分けるため（書けなかったときは、画像がなければアプリ内のコピーを貼る）
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(clip.tag).catch(() => {});
  notify(items.length > 1 ? `${items.length}個をコピー` : 'コピーしました');
  syncUI();
}
function pasteClip() {
  if (!clip || !pdf || busy || !sheets.length) return;
  const same = clip.doc === D.id;
  // 貼る先: 選択中のページ → 元のページ（表示中なら）→ 見開きの同じ側のページ → 最初のページ
  const sh = (sel && sheets.find(s => s.page === sel.page)) || (same && sheets.find(s => s.page === clip.page))
    || sheets.find(s => s.page % 2 === clip.page % 2) || sheets[0];
  const reid = it => { const o = { ...it, id: uid() }; if (o.t === 'G') o.ch = o.ch.map(reid); return o; };
  let items = JSON.parse(JSON.stringify(clip.items)).map(reid);
  let dx = 0, dy = 0;
  if (same && sh.page === clip.page) { clip.n++; dx = dy = 12 * clip.n; }
  const b = unionBox(items), y0 = -sh.m, y1 = sh.H + sh.m;
  if (b[2] + dx > sh.W) dx = sh.W - b[2];
  if (b[0] + dx < 0) dx = -b[0];
  if (b[3] + dy > y1) dy = y1 - b[3];
  if (b[1] + dy < y0) dy = y0 - b[1];
  if (dx || dy) items = items.map(i => xformItem(i, moveT(dx, dy)));
  for (const id in clip.assets) if (!assets[id]) { assets[id] = clip.assets[id]; assetsDirty = true; }
  pushUndo(sh.page);
  S.annots[sh.page] = [...(S.annots[sh.page] || []), ...items];
  S.tool = 'select'; setSel(sh.page, items);
  drawAnn(sh); drawOverlay(); syncUI(); touch();
}

/* ---------- PDF書き出し ---------- */
async function buildPdf(withMargins) {
  const { PDFDocument, rgb, degrees, LineCapStyle, LineJoinStyle, setLineJoin } = PDFLib;
  const annots = S.annots, marginSize = S.marginSize, imgs = assets;   // 書き出す対象は表示中のPDF
  const src = await PDFDocument.load(pdfBytes, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const emb = {};
  const hex = c => rgb(parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255);
  const srcPages = src.getPages();
  for (let i = 0; i < srcPages.length; i++) {
    const sp = srcPages[i];
    const cb = sp.getCropBox();
    const rot = ((sp.getRotation().angle % 360) + 360) % 360;
    const W = rot % 180 ? cb.height : cb.width, H = rot % 180 ? cb.width : cb.height;
    const m = withMargins ? H * marginSize : 0;
    const page = out.addPage([W, H + 2 * m]);
    const ep = await out.embedPage(sp, { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height });
    // 回転つきのページは、表示と同じ向きになるように置く
    const pos = { 0: [0, m, 0], 90: [0, m + cb.width, -90], 180: [cb.width, m + cb.height, 180], 270: [cb.height, m, 90] }[rot] || [0, m, 0];
    page.drawPage(ep, { x: pos[0], y: pos[1], rotate: degrees(pos[2]) });
    const top = m + H;                       // ページ上端のy（PDFは下が原点）
    page.pushOperators(setLineJoin(LineJoinStyle.Round));
    const drawIt = async it => {
      if (it.t === 'G') { for (const c of it.ch) await drawIt(c); return; }
      if (filled(it) || it.t === 'f') {
        page.drawSvgPath(svgPath(it), { x: 0, y: top, color: hex(it.c), opacity: it.f });
      } else if (it.t !== 'i') {
        page.drawSvgPath(svgPath(it), { x: 0, y: top, borderColor: hex(it.c), borderWidth: it.w, borderOpacity: it.a || 1, borderLineCap: LineCapStyle.Round });
        if (isLine(it) && it.ar) for (const h of arrowGeom(it).heads) {
          page.drawSvgPath(`M ${h[0]} ${h[1]} L ${h[2]} ${h[3]} L ${h[4]} ${h[5]} Z`, { x: 0, y: top, color: hex(it.c), opacity: it.a || 1 });
        }
      } else if (imgs[it.a]) {
        const data = imgs[it.a];
        const im = emb[it.a] || (emb[it.a] = await (data.startsWith('data:image/jpeg') ? out.embedJpg(data) : out.embedPng(data)));
        // pdf-lib は画像の左下の角を (x,y) に置き、そこを中心に反時計回りに回す。画面の時計回り rot は PDF では -rot
        const [cx, cy] = centerOf(it), [bx, by] = rotP(it.x, it.y + it.h, cx, cy, it.rot || 0);
        page.drawImage(im, { x: bx, y: top - by, width: it.w, height: it.h, rotate: degrees(-(it.rot || 0) * 180 / Math.PI) });
      }
    };
    for (const it of annots[i] || []) await drawIt(it);
  }
  return out.save();
}
// ホーム画面から起動したiPadでは<a download>が動かないことがあるため、共有シート（「ファイルに保存」など）を使う。
// ブラウザで開いているときは従来どおりダウンロードする。
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function shareFiles() {
  try {
    return standalone && typeof navigator.canShare === 'function'
      && navigator.canShare({ files: [new File([''], 'a.pdf', { type: 'application/pdf' })] });
  } catch (e) { return false; }
}
let exportFile = null;
function openExport() {
  exportFile = null;
  $('expChoose').hidden = false; $('expReady').hidden = true;
  $('expMsg').textContent = 'PDFを書き出します';
  $('bExpWith').disabled = $('bExpWithout').disabled = $('bExpData').disabled = false;
  $('dlg').showModal();
}
function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
// kind: true = 枠外領域つきのPDF、false = 枠外領域なしのPDF、'data' = 作業データ（あとで読み込んで続きを編集できる）
async function exportPdf(kind) {
  const viaShare = shareFiles();
  if (viaShare) {
    // 共有シートはボタンを押した直後にしか開けないので、作成後に「保存・共有」をもう一度押してもらう
    $('expMsg').textContent = 'ファイルを作成しています…';
    $('bExpWith').disabled = $('bExpWithout').disabled = $('bExpData').disabled = true;
  } else $('dlg').close();
  notify('書き出し中…', '', 0);
  try {
    const file = kind === 'data' ? buildBackup()
      : new File([await buildPdf(kind)], (S.name || 'script').replace(/\.pdf$/i, '') + '_書き込み.pdf', { type: 'application/pdf' });
    if (viaShare && navigator.canShare({ files: [file] })) {
      exportFile = file;
      $('expChoose').hidden = true; $('expReady').hidden = false;
    } else {
      $('dlg').close();
      download(file);
    }
    notify(viaShare ? 'ファイルを作成しました' : '書き出しました');
  } catch (e) {
    console.error(e);
    $('dlg').close();
    restToast();
    alert('書き出しに失敗しました: ' + e.message);
  }
}
async function shareExport() {
  if (!exportFile) return;
  try {
    await navigator.share({ files: [exportFile] });
    $('dlg').close();
  } catch (e) {
    if (e.name !== 'AbortError') alert('保存・共有できませんでした: ' + e.message);   // AbortError は利用者が閉じただけ
  }
}

/* ---------- 画面の部品 ---------- */
function syncUI() {
  const on = (el, v) => el.classList.toggle('on', !!v);
  $('bMode').textContent = S.mode === 'spread' ? '見開き' : '1ページ';
  $('bDir').textContent = S.rtl ? '右綴じ ←' : '左綴じ →';
  on($('bCover'), S.cover); $('bCover').disabled = S.mode !== 'spread';
  on($('bMargin'), S.margins);
  $('sMargin').value = String(S.marginSize);
  on($('bFinger'), !S.fingerDraw);          // 画面の表記は「Pencilを使う」。オンのとき指は描かない（fingerDraw の逆）
  document.querySelectorAll('[data-tool]').forEach(b => on(b, toolIs(b)));
  document.querySelectorAll('[data-color]').forEach(b => on(b, b.dataset.color === S.color));
  document.querySelectorAll('[data-width]').forEach(b => on(b, b.dataset.width === S.width));
  $('bUndo').disabled = !undo.length; $('bRedo').disabled = !redo.length;
  syncSelBar();
  $('sFillA').value = String(S.fillA);
  $('sArrow').value = String(S.arrow);
  // 直線を選んでいる間は塗りの代わりに矢印の設定を出す（同じ幅なので並びは動かない）
  const ln = S.tool === 'shape' && S.shape === 'line';
  $('sFillA').hidden = ln; $('sArrow').hidden = !ln;
  // 塗りありの間は、図形のボタンも塗った形で見せる
  document.querySelectorAll('[data-icon]').forEach(b => { b.textContent = b.dataset.icon[S.fillA ? 1 : 0]; });
  syncDocs();
  for (const id of ['bClose', 'bExport', 'bImage', 'bPaste', 'bLeft', 'bRight', 'bPage', 'bFit']) $(id).disabled = !pdf;
  if (pdf) {
    const pg = spreadOf(S.cur);
    $('bPage').textContent = (pg.length > 1 ? `${pg[0] + 1}-${pg[1] + 1}` : `${pg[0] + 1}`) + ` / ${pdf.numPages}`;
    // 先頭・末尾では、それ以上進めない側のボタンを無効にする（綴じ方向で左右が入れ替わる。turn() と同じ条件）
    const atFirst = pg[0] === 0, atLast = pg[pg.length - 1] + 1 >= pdf.numPages;
    $(S.rtl ? 'bRight' : 'bLeft').disabled = atFirst;
    $(S.rtl ? 'bLeft' : 'bRight').disabled = atLast;
  }
}
// 道具のボタンが今の道具か。図形と選択は、同じ道具の中の種類（data-shape / data-smode）まで見る
const toolIs = b => b.dataset.tool === S.tool && (!b.dataset.shape || b.dataset.shape === S.shape) && (!b.dataset.smode || b.dataset.smode === S.selMode);
// 選択中のものに応じて、操作の帯に出す項目を決める。複数の種類を選んでいるときは、どれかに使える属性を出し、
// 使える項目にだけ適用する。値がそろっていなければ「—」を表示する
function syncSelBar() {
  const items = selItems(), bar = $('selBar');
  bar.hidden = !items.length;
  if (!items.length) addMode = false;        // 選択がなくなったら追加選択も終える
  $('bAddSel').classList.toggle('on', addMode);
  if (!items.length) return;
  const one = items.length === 1 && items[0];
  $('selInfo').textContent = one ? { s: '手書き', g: isLine(one) ? '直線' : '図形', f: '塗り', i: '画像', G: 'グループ' }[one.t] : `${items.length}個`;
  const lv = leaves(items);
  const vals = key => new Set(lv.filter(ATTR_OK[key]).map(i => attrVal(i, key)));
  const vc = vals('c'), vw = vals('w');
  $('sgColor').hidden = !vc.size; $('sgWidth').hidden = !vw.size;
  bar.querySelectorAll('[data-scolor]').forEach(b => b.classList.toggle('on', vc.size === 1 && vc.has(b.dataset.scolor)));
  bar.querySelectorAll('[data-swidth]').forEach(b => b.classList.toggle('on', vw.size === 1 && vw.has(b.dataset.swidth)));
  for (const [id, key] of [['sSelAlpha', 'a'], ['sSelFill', 'f'], ['sSelArrow', 'ar']]) {
    const el = $(id), v = [...vals(key)];
    el.hidden = !v.length;
    el.value = v.length === 1 && [...el.options].some(o => o.value === v[0]) ? v[0] : '';
  }
  $('bGroup').hidden = items.length < 2;
  $('bUngroup').hidden = !items.some(i => i.t === 'G');
}
let docsSig = null;
function syncDocs() {                        // 開いているPDFの一覧（プルダウン）
  const el = $('sDoc');
  const sig = JSON.stringify([docs.map(d => [d.id, d.name]), !D]);
  if (sig !== docsSig) {
    docsSig = sig;
    el.textContent = '';
    if (!D) el.append(new Option('PDFを選ぶ', ''));
    const seen = {};
    for (const d of docs) {                  // 同じ名前のPDFは番号を付けて見分ける
      const n = seen[d.name] = (seen[d.name] || 0) + 1;
      el.append(new Option(n > 1 ? `${d.name} (${n})` : d.name, d.id));
    }
  }
  el.hidden = !docs.length;
  el.value = D ? D.id : '';
}
function setOpt(fn, relayout) {
  fn(); syncUI(); touch();
  if (pdf && relayout) show();
}

$('bOpen').onclick = $('bOpen2').onclick = () => $('fPdf').click();
$('fPdf').onchange = $('fData').onchange = e => { pickPdfs(e.target.files); e.target.value = ''; };
$('bImport').onclick = () => { closeMenu(); $('fData').click(); };

// メニュー（表示の設定など、たまにしか使わないもの）。外側を押すと閉じる
function closeMenu() { $('menu').hidden = true; $('bMenu').classList.remove('on'); }
$('bMenu').onclick = () => {
  const m = $('menu'), b = $('bMenu');
  if (!m.hidden) return closeMenu();
  m.hidden = false; b.classList.add('on');
  m.style.top = b.offsetTop + b.offsetHeight + 6 + 'px';
  m.style.left = Math.max(8, Math.min(b.offsetLeft, $('bar').clientWidth - m.offsetWidth - 8)) + 'px';
};
$('menu').addEventListener('click', e => { if (e.target.closest('.mclose')) closeMenu(); });   // PDFの操作は押したら閉じる
document.addEventListener('pointerdown', e => {
  if ($('menu').hidden || e.target.closest('#menu, #bMenu')) return;
  closeMenu();
  if (e.target.closest('#stage')) e.stopPropagation();     // 閉じるために押しただけなので、ページには何も描かない
}, true);
$('sDoc').onchange = e => { const id = e.target.value; syncUI(); if (id) switchDoc(id); };
$('bClose').onclick = closeDoc;
$('sFillA').onchange = e => setOpt(() => { S.fillA = +e.target.value; });
$('bFront').onclick = () => reorderSel(true);
$('bAddSel').onclick = () => { addMode = !addMode; syncUI(); };
$('bGroup').onclick = groupSel;
$('bUngroup').onclick = ungroupSel;
$('bCopy').onclick = copySel;
$('sArrow').onchange = e => setOpt(() => { S.arrow = +e.target.value; });
document.querySelectorAll('[data-scolor]').forEach(b => b.onclick = () => setSelAttr('c', b.dataset.scolor));
document.querySelectorAll('[data-swidth]').forEach(b => b.onclick = () => setSelAttr('w', b.dataset.swidth));
for (const [id, key] of [['sSelAlpha', 'a'], ['sSelFill', 'f'], ['sSelArrow', 'ar']]) $(id).onchange = e => { if (e.target.value !== '') setSelAttr(key, e.target.value); };
$('bBack').onclick = () => reorderSel(false);
$('bExport').onclick = openExport;
$('bExpWith').onclick = () => exportPdf(true);
$('bExpWithout').onclick = () => exportPdf(false);
$('bExpData').onclick = () => exportPdf('data');
$('bExpShare').onclick = shareExport;
$('bExpCancel').onclick = () => $('dlg').close();
$('bMode').onclick = () => setOpt(() => { S.mode = S.mode === 'spread' ? 'single' : 'spread'; }, true);
$('bDir').onclick = () => setOpt(() => { S.rtl = !S.rtl; }, true);
$('bCover').onclick = () => setOpt(() => { S.cover = !S.cover; }, true);
$('bMargin').onclick = () => setOpt(() => { S.margins = !S.margins; }, true);
$('sMargin').onchange = e => setOpt(() => { S.marginSize = +e.target.value; S.margins = true; }, true);
$('bFit').onclick = () => { view = { tx: 0, ty: 0, z: 1 }; clampView(); applyView(); };
$('bFinger').onclick = () => setOpt(() => { S.fingerDraw = !S.fingerDraw; });
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setOpt(() => {
  // 選択中の道具をもう一度押すと、何も選んでいない状態になる
  const same = toolIs(b);
  S.tool = same ? '' : b.dataset.tool;
  if (b.dataset.shape) S.shape = b.dataset.shape;
  if (b.dataset.smode) S.selMode = b.dataset.smode;
  if (S.colors[S.tool]) S.color = S.colors[S.tool];      // その道具で最後に使った色と太さに戻す
  if (S.widths[S.tool]) S.width = S.widths[S.tool];
  if (S.tool !== 'select') sel = null;
  drawOverlay();
}));
document.querySelectorAll('[data-color]').forEach(b => b.onclick = () => setOpt(() => {
  S.color = b.dataset.color;
  if (S.tool !== 'pen' && S.tool !== 'marker' && S.tool !== 'shape') { S.tool = 'pen'; sel = null; drawOverlay(); }
  S.colors[S.tool] = S.color;
}));
document.querySelectorAll('[data-width]').forEach(b => b.onclick = () => setOpt(() => {
  S.width = b.dataset.width;
  S.widths[S.widths[S.tool] ? S.tool : 'pen'] = S.width;   // 選択・無選択のときはペンの太さとして覚える
}));
$('bUndo').onclick = () => stepHistory(undo, redo);
$('bRedo').onclick = () => stepHistory(redo, undo);
// 写真を選ぶ。オフラインでは、iCloudにしかない写真を選ぶと何も届かないことがあるので、
// 選ぶ画面が閉じたのに何も届かなければ説明を出す（オンラインなら、選ぶのをやめただけとみなす）
let imgPending = false;
const imgNone = () => {
  if (!imgPending) return;
  imgPending = false;
  if (!navigator.onLine) photoFail();
};
$('bImage').onclick = () => { imgPending = true; $('fImg').click(); };
$('fImg').onchange = e => { imgPending = false; addImage(e.target.files[0]); e.target.value = ''; };
$('fImg').addEventListener('cancel', imgNone);
// cancel を出さないブラウザ向け: 画面に戻ってから少し待っても届かなければ、何も届かなかったとみなす
window.addEventListener('focus', () => { if (imgPending) setTimeout(imgNone, 1500); });
$('bPaste').onclick = pasteFromClipboard;
$('bDelete').onclick = deleteSel;
$('bLeft').onclick = () => turn(S.rtl ? 1 : -1);
$('bRight').onclick = () => turn(S.rtl ? -1 : 1);
$('bPage').onclick = () => {
  const v = parseInt(prompt(`移動先のページ番号 (1〜${pdf.numPages})`, S.cur + 1), 10);
  if (v >= 1 && v <= pdf.numPages) { S.cur = spreadOf(v - 1)[0]; sel = null; show(); touch(); }
};
addEventListener('keydown', e => {
  if (!pdf || busy || $('dlg').open) return;
  if (e.key === 'ArrowLeft') turn(S.rtl ? 1 : -1);
  else if (e.key === 'ArrowRight') turn(S.rtl ? -1 : 1);
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? stepHistory(redo, undo) : stepHistory(undo, redo); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { e.preventDefault(); deleteSel(); }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && sel) { e.preventDefault(); copySel(); }
  else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g' && sel) { e.preventDefault(); e.shiftKey ? ungroupSel() : groupSel(); }
  else if (e.key === 'Escape' && sel) { sel = null; syncUI(); drawOverlay(); }
});
stage.addEventListener('dragover', e => e.preventDefault());
stage.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (!f) return;
  if (f.type.startsWith('image/')) addImage(f); else pickPdfs([f]);
});
// 画面の回転やウィンドウの変更のほか、ツールバーの段数が変わって表示領域の高さが変わったときも合わせ直す
let resizeTimer = 0, stageW = 0, stageH = 0;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (stage.clientWidth === stageW && stage.clientHeight === stageH) return;
    sizeOverlay();
    if (!pdf) return;
    fit(); clampView(); applyView(); renderAll();
  }, 100);
}
addEventListener('resize', onResize);
if (window.ResizeObserver) new ResizeObserver(onResize).observe(stage);

/* ---------- オフライン対応 (Service Worker) ---------- */
// アプリ一式を端末に保存し、オフラインでも起動できるようにする。新しい版は自動では切り替えず、
// 「更新」ボタンを押したときに作業内容を保存してから読み込み直す。
function setupSW() {
  const sw = navigator.serviceWorker;
  if (!sw || !isSecureContext) return;      // HTTPSでない場合は従来どおりオンラインのみで動く
  let reg = null, hadController = !!sw.controller, reloading = false;
  const showUpdate = () => { $('bUpdate').hidden = false; };
  const failed = () => { stat.off = 'failed'; stat.offSeen = false; restToast(); };   // 次回の起動で再試行
  const watch = w => w && w.addEventListener('statechange', () => {
    if (w.state === 'installed' && sw.controller) showUpdate();
    if (w.state === 'redundant' && !sw.controller) failed();
  });

  // 初めての取り込みのときだけ、始まりと終わりを知らせる。取り込み済みなら何も出さない
  if (sw.controller) stat.off = 'ready';
  else { stat.off = 'preparing'; notify('オフラインの準備中…', '', 2500); }
  sw.ready.then(() => {
    const first = stat.off !== 'ready';
    stat.off = 'ready';
    if (first) notify('オフラインで使えるようになりました', '', 2500); else syncStatePanel();
  });

  sw.register('sw.js').then(r => {
    reg = r;
    if (r.waiting && sw.controller) showUpdate();
    watch(r.installing);
    r.addEventListener('updatefound', () => watch(r.installing));
  }).catch(e => { console.error(e); failed(); });

  // ホーム画面のアプリは切り替えて戻っても再読み込みされないので、表に出るたびに更新を確認する
  const check = () => { if (reg && navigator.onLine) reg.update().catch(() => {}); };
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  addEventListener('online', check);

  $('bUpdate').onclick = async () => {
    const w = reg && reg.waiting;
    if (!w) { $('bUpdate').hidden = true; return; }
    $('bUpdate').disabled = true;
    await save();
    w.postMessage('SKIP_WAITING');
  };
  sw.addEventListener('controllerchange', async () => {
    if (!hadController) { hadController = true; return; }   // 初回の取り込み完了。読み込み直す必要はない
    if (reloading) return;
    reloading = true;
    await save();                                            // 別のタブで更新された場合もここで保存してから切り替わる
    location.reload();
  });
}

/* ---------- 起動: 前回の続きを復元 ---------- */
(async function init() {
  sizeOverlay(); syncUI(); setupSW();
  await op(async () => {
    try {
      let meta = await idbGet('meta');
      if (!meta || !Array.isArray(meta.docs)) meta = await migrate();
      docs = meta.docs;
      Object.assign(S, pick(meta.prefs || {}, PREF_KEYS));
      // 色を道具ごとに覚える前の版の設定: それまで使っていた色を3つの道具すべての色にする
      if (!meta.prefs || !meta.prefs.colors) S.colors = { pen: S.color, marker: S.color, shape: S.color };
      else S.colors = { ...S.colors, ...meta.prefs.colors };
      if (!meta.prefs || !meta.prefs.widths) S.widths = { pen: S.width, marker: S.width, shape: S.width, eraser: S.width };
      else S.widths = { ...S.widths, ...meta.prefs.widths };
      if (meta.prefs && meta.prefs.fill === false) S.fillA = 0;   // 塗りのオン・オフが別のボタンだった版の設定
      // 前回表示していたPDFから順に試し、最初に開けたものを表示する
      const first = docs.find(d => d.id === meta.active);
      for (const d of first ? [first, ...docs.filter(x => x !== first)] : docs) {
        try { await activate(d.id); notify('復元済み'); break; }
        catch (e) { console.error(e); }
      }
    } catch (e) { console.error(e); }
  });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
})();
