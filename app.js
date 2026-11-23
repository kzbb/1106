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
  arrow: 0,                  // これから描く直線の矢印。0 なし、1 片矢印（終点側）、2 両矢印
  selMode: 'rect',           // 選択の囲み方。rect = 四角で囲む、lasso = 投げ縄
  colors: { pen: '#d00000', marker: '#d00000', shape: '#d00000' },   // 道具ごとに覚えている色。color はいま選んでいる道具の色
  widths: { pen: 'm', marker: 'm', shape: 'm', eraser: 'm' },         // 道具ごとに覚えている太さ（消しゴムは大きさ）。width はいま選んでいる道具の太さ
  annots: {},                // ページ番号 -> 項目の配列（配列の後ろほど手前に描かれる）
};
/* 項目の種類:
   {t:'s', c, w, a, p:[x,y,...]}        手書きの線。点列を二次ベジェでなめらかに結ぶ
   {t:'s', ..., l:1}                    折れ線（点列を直線で結ぶ）。消しゴムで切り分けた残りはこの形になる
   {t:'g', id, k, c, w, x0, y0, x1, y1} 図形。k = line | ellipse | tri | rect | star。(x0,y0)→(x1,y1) はドラッグした範囲
   {t:'g', ..., f}                      塗りつぶした図形。f は濃さ（不透明度 0〜1）。輪郭線は引かず、面全体を1色で塗る
   {t:'f', c, f, r:[[x,y,...],...]}     塗った面。塗りつぶした図形を消しゴムで削った残り。r は外周と穴の輪の並び
   {t:'i', id, a, x, y, w, h}           画像。a は assets のID
   どの項目にも付くことがあるもの（古いデータにはなく、なくても読める）:
     id   選択したときに振る識別子
     gid  グループの識別子。同じページで同じ gid をもつ項目が1つのグループ（項目そのものは個別に残る）
   {t:'g'|'i', ..., r}  回転（ラジアン、時計回り）。外接長方形の中心のまわりに回す。直線・手書きの線・塗った面は
                        点の座標そのものを回すので r をもたない（t:'f' の r は輪の並びで、回転ではない）
   {t:'g', k:'line', ..., ar}  矢印。1 = 終点 (x1,y1) 側、2 = 両端 */
let assets = {};             // 画像ID -> dataURL（表示中のPDFの分だけ）
let docs = [];               // 開いているPDFの一覧 [{id, name, k}]。k はIndexedDBのキーの接頭辞
let D = null;                // 表示中のPDF（docs の要素）
const hist = {};             // PDFのID -> {undo, redo}。取り消し履歴はPDFごとに分ける
let busy = false;            // PDFの追加・切り替え・削除の最中
let pdf = null, pdfBytes = null, sizes = [];
let sheets = [], view = { tx: 0, ty: 0, z: 1 }, base = { s: 1, w: 0, h: 0 };
let undo = [], redo = [], renderedZ = 1;
let sel = null;              // 選択中の項目 {page, ids:[...]}。選択は1ページの中だけ
let addMode = false;         // 「追加選択」: オンの間は、選んだものを選択に足す（選択済みのものは外す）
let clip = null;             // コピーした項目 {items, assets, doc, page, last}。画像のデータも持つので、元のPDFを閉じても貼れる
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

let saveTimer = 0, dirty = false, assetsDirty = false, saveAlerted = false;
function touch() {
  dirty = true;
  $('status').textContent = '未保存';
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
    $('status').textContent = '保存済み';
    $('status').classList.remove('err');
    saveAlerted = false;
    return true;
  }, e => {
    console.error(e);
    if (d === D) { dirty = true; if (as) assetsDirty = true; }   // 次の保存で書き直す
    $('status').textContent = '保存失敗';
    $('status').classList.add('err');
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
    $('status').textContent = '保存済み';
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
    $('status').textContent = '保存済み';
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
// 楕円以外の図形の頂点 [x,y,...]。直線は2点、ほかは閉じた多角形
function shapePts(it) {
  if (it.k === 'line') return [it.x0, it.y0, it.x1, it.y1];
  const o = [];
  for (const [u, v] of SHAPE_UV[it.k] || SHAPE_UV.rect) o.push(r2(it.x0 + u * (it.x1 - it.x0)), r2(it.y0 + v * (it.y1 - it.y0)));
  return o;
}
const filled = it => it.t === 'g' && !!it.f && it.k !== 'line';
const ellipseOf = it => ({ cx: (it.x0 + it.x1) / 2, cy: (it.y0 + it.y1) / 2, rx: Math.abs(it.x1 - it.x0) / 2, ry: Math.abs(it.y1 - it.y0) / 2 });
// 点列 q を (cx,cy) のまわりに r ラジアン回す（画面上で時計回り）
function rotPts(q, cx, cy, r) {
  if (!r) return q;
  const c = Math.cos(r), s = Math.sin(r), o = new Array(q.length);
  for (let i = 0; i < q.length; i += 2) {
    const dx = q[i] - cx, dy = q[i + 1] - cy;
    o[i] = cx + dx * c - dy * s; o[i + 1] = cy + dx * s + dy * c;
  }
  return o;
}
// 直線の矢じり。先端を頂点とする「く」の字の折れ線を、矢印のある端ごとに1本返す
function arrowHeads(it) {
  if (!it.ar) return [];
  const len = Math.hypot(it.x1 - it.x0, it.y1 - it.y0);
  if (len < 0.5) return [];
  const L = Math.min(6 + 4 * it.w, len * 0.45), a = Math.atan2(it.y1 - it.y0, it.x1 - it.x0), w = 0.48;   // w: 開きの半角（約27度）
  const head = (x, y, d) => [x - L * Math.cos(d - w), y - L * Math.sin(d - w), x, y, x - L * Math.cos(d + w), y - L * Math.sin(d + w)];
  const o = [head(it.x1, it.y1, a)];
  if (it.ar === 2) o.push(head(it.x0, it.y0, a + Math.PI));
  return o;
}
// 楕円以外の図形の、回転をかけたあとの折れ線。直線は軸と矢じり、ほかは閉じた多角形1つ（終点は始点に戻していない）
function shapePolys(it) {
  if (it.k === 'line') return [[it.x0, it.y0, it.x1, it.y1], ...arrowHeads(it)];
  return [rotPts(shapePts(it), (it.x0 + it.x1) / 2, (it.y0 + it.y1) / 2, it.r)];
}
function shapeTrace(ctx, it) {
  if (it.k === 'ellipse') {
    const e = ellipseOf(it);
    ctx.ellipse(e.cx, e.cy, e.rx, e.ry, it.r || 0, 0, Math.PI * 2);
    ctx.closePath();
    return;
  }
  for (const q of shapePolys(it)) {
    ctx.moveTo(q[0], q[1]);
    for (let i = 2; i < q.length; i += 2) ctx.lineTo(q[i], q[i + 1]);
    if (it.k !== 'line') ctx.closePath();
  }
}
// 線・図形をSVGのパスにする（PDF書き出し用。画面の描画と同じ形になるようにしてある）
function svgPath(it) {
  const f = v => r2(v);
  if (it.t === 'f') {
    return it.r.map(q => { let d = `M ${q[0]} ${q[1]}`; for (let i = 2; i < q.length; i += 2) d += ` L ${q[i]} ${q[i + 1]}`; return d + ' Z'; }).join(' ');
  }
  if (it.t === 'g') {
    if (it.k === 'ellipse') {
      const { cx, cy, rx, ry } = ellipseOf(it), kx = rx * 0.5522847498, ky = ry * 0.5522847498;
      const q = rotPts([cx + rx, cy, cx + rx, cy + ky, cx + kx, cy + ry, cx, cy + ry, cx - kx, cy + ry, cx - rx, cy + ky, cx - rx, cy,
        cx - rx, cy - ky, cx - kx, cy - ry, cx, cy - ry, cx + kx, cy - ry, cx + rx, cy - ky, cx + rx, cy], cx, cy, it.r).map(f);
      let d = `M ${q[0]} ${q[1]}`;
      for (let i = 2; i < q.length; i += 6) d += ` C ${q.slice(i, i + 6).join(' ')}`;
      return d + ' Z';
    }
    return shapePolys(it).map(q => {
      let d = `M ${f(q[0])} ${f(q[1])}`;
      for (let i = 2; i < q.length; i += 2) d += ` L ${f(q[i])} ${f(q[i + 1])}`;
      return it.k === 'line' ? d : d + ' Z';
    }).join(' ');
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
  for (const it of S.annots[sh.page] || []) {
    if (it.t !== 'i') strokePath(ctx, it);
    else {
      const img = getImg(it.a, () => { if (sheets.includes(sh)) drawAnn(sh); });
      if (img) drawImg(ctx, img, it);
    }
  }
}
function drawImg(ctx, img, it) {
  if (!it.r) { ctx.drawImage(img, it.x, it.y, it.w, it.h); return; }
  ctx.save();
  ctx.translate(it.x + it.w / 2, it.y + it.h / 2); ctx.rotate(it.r);
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
  if (g && g.mq) {                           // 囲んでいる途中の範囲
    const t = sheetXform(g.sh), q = regionOf(g.mq);
    ctx.setTransform(t.k * dpr, 0, 0, t.k * dpr, t.ox * dpr, t.oy * dpr);
    ctx.beginPath(); ctx.moveTo(q[0], q[1]);
    for (let i = 2; i < q.length; i += 2) ctx.lineTo(q[i], q[i + 1]);
    ctx.closePath();
    ctx.fillStyle = '#0a66d81a'; ctx.fill();
    ctx.strokeStyle = '#0a66d8'; ctx.lineWidth = 1.5 / t.k; ctx.setLineDash([5 / t.k, 4 / t.k]); ctx.stroke();
    ctx.setLineDash([]);
  }
  const its = selItems();
  if (its.length) {                          // 選択の枠と、拡大縮小（右下）・回転（上）の取っ手
    const sh = sheets.find(s => s.page === sel.page);
    const q = frameGeo(g && g.frame || selFrame(its), sh);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.strokeStyle = '#0a66d8'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.beginPath();
    q.pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]));
    ctx.closePath(); ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(q.stem[0], q.stem[1]); ctx.lineTo(q.rot[0], q.rot[1]); ctx.stroke();
    ctx.fillStyle = '#0a66d8';
    ctx.beginPath(); ctx.arc(q.size[0], q.size[1], 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(q.rot[0], q.rot[1], 9, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
}
// 選択中の項目（重なりの順）。選択したページが表示されていなければ空
function selItems() {
  if (!sel || !sheets.some(s => s.page === sel.page)) return [];
  const ids = new Set(sel.ids);
  return (S.annots[sel.page] || []).filter(i => i.id && ids.has(i.id));
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
  if (!pdf || busy || e.target.closest('#empty, #selBar')) return;
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
  if (S.tool === 'select' && startHandle(e, isTouch)) return;   // 取っ手はページの外へはみ出すことがあるので先に調べる
  const h = locate(e);
  if (!h) {
    if (S.tool === 'select' && sel && !addMode) { sel = null; syncUI(); drawOverlay(); }
    return;
  }
  g = { tool: S.tool, id: e.pointerId, touch: isTouch, sh: h.sh, k: h.k, r: h.r };
  if (S.tool === 'pen' || S.tool === 'marker') {
    const mk = S.tool === 'marker';
    g.stroke = { t: 's', c: S.color, w: WIDTHS[S.width] * (mk ? 6 : 1), a: mk ? 0.35 : 1, p: [r2(h.x), r2(h.y)] };
    queueOverlay();
  } else if (S.tool === 'shape') {
    const x = r2(h.x), y = r2(h.y);
    g.stroke = { t: 'g', id: uid(), k: S.shape, c: S.color, w: WIDTHS[S.width], x0: x, y0: y, x1: x, y1: y };
    if (S.fillA && S.shape !== 'line') g.stroke.f = S.fillA;
    if (S.arrow && S.shape === 'line') g.stroke.ar = S.arrow;
  } else if (S.tool === 'eraser') {
    eraseTo(g, h.x, h.y);
  } else startSelect(h);
}

/* ---------- 消しゴム（部分消去） ----------
   線や図形を、画面に描かれるとおりの形の折れ線に直し、消しゴムが通った範囲だけを切り取る。
   残った部分はそれぞれ独立した折れ線になるので、切れ目がつながり直すことはない。 */
const FLAT_TOL = 0.05;       // 曲線を折れ線に直すときの許容誤差（PDFポイント）
const flatCache = new WeakMap(), boxCache = new WeakMap(), outCache = new WeakMap();   // 項目は確定後に書き換えないので使い回せる
// 手書きの線を、画面に描かれるとおりの折れ線にする
function flatten(it) {
  if (it.l || it.p.length <= 4) return it.p;
  let o = flatCache.get(it);
  if (o) return o;
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
  flatCache.set(it, o);
  return o;
}
/* 項目の輪郭を、ページ座標の折れ線の配列で返す（回転をかけたあとの形）。消しゴム・選択の当たり判定・外接長方形で共用する。
   手書きの線は1本。直線は軸と矢じり。ほかの図形・画像・塗った面は閉じた折れ線（終点を始点に戻してある）。 */
function outline(it) {
  let o = outCache.get(it);
  if (o) return o;
  const close = q => q.concat(q[0], q[1]);
  if (it.t === 's') o = [flatten(it)];
  else if (it.t === 'f') o = it.r.map(close);
  else if (it.t === 'i') o = [close(rotPts([it.x, it.y, it.x + it.w, it.y, it.x + it.w, it.y + it.h, it.x, it.y + it.h], it.x + it.w / 2, it.y + it.h / 2, it.r))];
  else if (it.k === 'ellipse') {
    const { cx, cy, rx, ry } = ellipseOf(it), r = Math.max(rx, ry, 0.01);
    const n = clamp(Math.ceil(Math.PI / Math.acos(Math.max(0, 1 - FLAT_TOL / r))), 16, 720), q = [];
    for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; q.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a)); }
    o = [close(rotPts(q, cx, cy, it.r))];
  } else o = it.k === 'line' ? shapePolys(it) : shapePolys(it).map(close);
  outCache.set(it, o);
  return o;
}
const isArea = it => it.t === 'i' || it.t === 'f' || filled(it);   // 面として扱うもの（ほかは線）
function boxOf(it) {
  let b = boxCache.get(it);
  if (b) return b;
  b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of outline(it)) for (let i = 0; i < p.length; i += 2) {
    if (p[i] < b[0]) b[0] = p[i]; if (p[i] > b[2]) b[2] = p[i];
    if (p[i + 1] < b[1]) b[1] = p[i + 1]; if (p[i + 1] > b[3]) b[3] = p[i + 1];
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
    const subj = it.t === 'f' ? it.r.map(toClip) : [toClip(outline(it)[0].slice(0, -2))];
    const c = new C.Clipper();
    c.AddPaths(subj, C.PolyType.ptSubject, true);
    c.AddPath(capsulePath(ax, ay, bx, by, R), C.PolyType.ptClip, true);
    let sol = new C.Paths();
    c.Execute(C.ClipType.ctDifference, sol, C.PolyFillType.pftEvenOdd, C.PolyFillType.pftNonZero);
    if (Math.abs(ringsArea(sol) - ringsArea(subj)) < 2) return null;         // 面積が変わらない = 触れていない
    sol = C.Clipper.CleanPolygons(sol, 2).filter(p => p.length >= 3 && Math.abs(C.Clipper.Area(p)) > 0.2 * CS * CS);
    if (!sol.length) return [];
    const o = { t: 'f', c: it.c, f: it.f, r: sol.map(p => { const q = []; for (const v of p) q.push(v.X / CS, v.Y / CS); return q; }) };
    if (it.gid) o.gid = it.gid;              // グループの一部を削っても、残りは同じグループに残す
    return [o];
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
const inRings = (polys, x, y) => polys.reduce((c, q) => c !== inPoly(q, x, y), false);   // 輪の並び（穴あり）の内側か
// 1点での当たり判定。画像と塗った面は面、線と図形の輪郭はその近く（塗りつぶした図形は面も）
function hitItem(a, x, y, tol) {
  const polys = outline(a);
  if (isArea(a) && inRings(polys, x, y)) return true;
  if (a.t === 'i' || a.t === 'f') return false;
  return polys.some(q => cutPoly(q, x, y, x, y, tol + a.w / 2) !== null);
}
// 消しゴムを (x,y) まで動かす。前回の位置からの通り道にかかった部分を消す
function eraseTo(g, x, y) {
  const ax = g.ex === undefined ? x : g.ex, ay = g.ex === undefined ? y : g.ey;
  g.ex = x; g.ey = y;
  queueOverlay();
  const page = g.sh.page, arr = S.annots[page];
  if (!arr) return;
  const rad = ERASER_PX[S.width] / g.k;
  const x0 = Math.min(ax, x), x1 = Math.max(ax, x), y0 = Math.min(ay, y), y1 = Math.max(ay, y);
  let out = null;
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    let parts = null;
    const area = it.t === 'f' || filled(it);   // 塗った面は面として削る。線と輪郭は線として切る
    if (it.t !== 'i') {                      // 画像は消しゴムでは消さない
      const R = area ? rad : rad + it.w / 2, b = boxOf(it);
      if (b[0] <= x1 + R && b[2] >= x0 - R && b[1] <= y1 + R && b[3] >= y0 - R) {
        if (area) parts = cutFill(it, ax, ay, x, y, R);
        else {                               // 矢印つきの直線は軸と矢じりの折れ線に分かれる。どれかに当たったら、当たらなかった折れ線もそのまま残す
          const res = [];
          let any = false;
          for (const q of outline(it)) {
            const c = cutPoly(q, ax, ay, x, y, R);
            if (c) { any = true; res.push(...c); } else res.push(q);
          }
          if (any) parts = res;
        }
      }
    }
    if (!parts) { if (out) out.push(it); continue; }
    if (!out) out = arr.slice(0, i);
    if (area) out.push(...parts);
    else for (const q of parts) {
      const o = { t: 's', c: it.c, w: it.w, a: it.a || 1, l: 1, p: q.map(r2) };
      if (it.gid) o.gid = it.gid;            // グループの一部を消しても、残りは同じグループに残す
      out.push(o);
    }
  }
  if (!out) return;
  if (!g.pushed) { pushUndo(page); g.pushed = true; }      // 1回のなぞりを1回の「取り消す」で戻せるようにする
  S.annots[page] = out;
  drawAnn(g.sh); touch();
}

/* ---------- 選択と変形 ----------
   選択は1ページの中の項目の集まり（sel）。移動・拡大縮小・回転は、どれも「相似変換」T を各項目にかける1つの処理
   (xform) で行う。グループは同じ gid をもつ項目の集まりで、選ぶときにまとめて選ばれるだけなので、グループの移動・
   拡大縮小・回転・コピー・削除は複数選択とまったく同じ処理になる。項目は書き換えずに新しい項目へ置き換える
   （取り消し履歴が古い項目を指しているため）。 */
// 相似変換 T: (x,y) → (a·x − b·y + tx, b·x + a·y + ty)。s は倍率、th は回転角（時計回り）
const xfMove = (dx, dy) => ({ a: 1, b: 0, tx: dx, ty: dy, s: 1, th: 0 });
const xfScale = (px, py, k) => ({ a: k, b: 0, tx: px * (1 - k), ty: py * (1 - k), s: k, th: 0 });
function xfRot(px, py, th) {
  const a = Math.cos(th), b = Math.sin(th);
  return { a, b, tx: px - a * px + b * py, ty: py - b * px - a * py, s: 1, th };
}
// 項目に T をかけた新しい項目を返す。線の太さも倍率に合わせる
function xform(it, T) {
  const map = p => {
    const o = new Array(p.length);
    for (let i = 0; i < p.length; i += 2) { o[i] = r2(T.a * p[i] - T.b * p[i + 1] + T.tx); o[i + 1] = r2(T.b * p[i] + T.a * p[i + 1] + T.ty); }
    return o;
  };
  const c = { ...it };
  if (it.t !== 'i' && it.w && T.s !== 1) c.w = Math.max(0.1, r2(it.w * T.s));
  if (it.t === 's') c.p = map(it.p);
  else if (it.t === 'f') c.r = it.r.map(map);
  else if (it.t === 'g' && it.k === 'line') [c.x0, c.y0, c.x1, c.y1] = map([it.x0, it.y0, it.x1, it.y1]);
  else {                                     // 図形と画像: 外接長方形の中心を移し、大きさと回転角を変える
    const sh = it.t === 'g', w = sh ? it.x1 - it.x0 : it.w, h = sh ? it.y1 - it.y0 : it.h;
    const ox = (sh ? it.x0 : it.x) + w / 2, oy = (sh ? it.y0 : it.y) + h / 2;
    const cx = T.a * ox - T.b * oy + T.tx, cy = T.b * ox + T.a * oy + T.ty, hw = w * T.s / 2, hh = h * T.s / 2;
    if (sh) { c.x0 = r2(cx - hw); c.x1 = r2(cx + hw); c.y0 = r2(cy - hh); c.y1 = r2(cy + hh); }
    else { c.x = r2(cx - hw); c.y = r2(cy - hh); c.w = r2(w * T.s); c.h = r2(h * T.s); }
    const r = (it.r || 0) + T.th, n = Math.atan2(Math.sin(r), Math.cos(r));
    if (Math.abs(n) < 1e-4) delete c.r; else c.r = Math.round(n * 1e4) / 1e4;
  }
  return c;
}
// 図形1つを右下の取っ手で変形する（縦横比は自由）。回転した図形では、図形の向きに沿って伸び縮みし、左上の角は動かない
function boxResize(o, dx, dy) {
  const r = o.r || 0, c = Math.cos(r), s = Math.sin(r), min = o.k === 'line' ? 0 : 2;
  const w = Math.max(min, Math.abs(o.x1 - o.x0) + dx * c + dy * s), h = Math.max(min, Math.abs(o.y1 - o.y0) - dx * s + dy * c);
  const ocx = (o.x0 + o.x1) / 2, ocy = (o.y0 + o.y1) / 2;
  const mx = Math.min(o.x0, o.x1) + w / 2 - ocx, my = Math.min(o.y0, o.y1) + h / 2 - ocy;   // 新しい中心（図形の向きで測った位置）
  const cx = ocx + mx * c - my * s, cy = ocy + mx * s + my * c, it = { ...o };
  [it.x0, it.x1] = o.x1 >= o.x0 ? [r2(cx - w / 2), r2(cx + w / 2)] : [r2(cx + w / 2), r2(cx - w / 2)];
  [it.y0, it.y1] = o.y1 >= o.y0 ? [r2(cy - h / 2), r2(cy + h / 2)] : [r2(cy + h / 2), r2(cy - h / 2)];
  return it;
}
function unionBox(its) {
  const b = [Infinity, Infinity, -Infinity, -Infinity];
  for (const it of its) {
    const q = boxOf(it);
    if (q[0] < b[0]) b[0] = q[0]; if (q[1] < b[1]) b[1] = q[1]; if (q[2] > b[2]) b[2] = q[2]; if (q[3] > b[3]) b[3] = q[3];
  }
  return b;
}
// 選択の枠 {cx, cy, hw, hh, r}。画像1つ・図形1つのときはその向きに合わせた枠、それ以外は全体を囲む水平な枠
function selFrame(its) {
  if (its.length === 1) {
    const it = its[0];
    if (it.t === 'i') return { cx: it.x + it.w / 2, cy: it.y + it.h / 2, hw: it.w / 2, hh: it.h / 2, r: it.r || 0 };
    if (it.t === 'g' && it.k !== 'line') return { cx: (it.x0 + it.x1) / 2, cy: (it.y0 + it.y1) / 2, hw: Math.abs(it.x1 - it.x0) / 2, hh: Math.abs(it.y1 - it.y0) / 2, r: it.r || 0 };
  }
  const b = unionBox(its);
  return { cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, hw: (b[2] - b[0]) / 2, hh: (b[3] - b[1]) / 2, r: 0 };
}
const xfFrame = (f, T) => ({ cx: T.a * f.cx - T.b * f.cy + T.tx, cy: T.b * f.cx + T.a * f.cy + T.ty, hw: f.hw * T.s, hh: f.hh * T.s, r: f.r + T.th });
const FRAME_PAD = 6;         // 枠は中身より少し外側に描く（画面上のピクセル）
// 枠と取っ手の位置（表示領域の座標）。回転の取っ手は枠の上に出し、画面の上端からはみ出すときは下に出す
function frameGeo(f, sh) {
  const t = sheetXform(sh), c = Math.cos(f.r), s = Math.sin(f.r);
  const ox = t.ox + f.cx * t.k, oy = t.oy + f.cy * t.k, hw = f.hw * t.k + FRAME_PAD, hh = f.hh * t.k + FRAME_PAD;
  const P = (x, y) => [ox + x * c - y * s, oy + x * s + y * c];
  let rot = P(0, -hh - 30), stem = P(0, -hh);
  if (rot[1] < 14) { rot = P(0, hh + 30); stem = P(0, hh); }
  return { pts: [P(-hw, -hh), P(hw, -hh), P(hw, hh), P(-hw, hh)], size: P(hw, hh), rot, stem };
}
function inFrame(f, x, y, pad) {
  const dx = x - f.cx, dy = y - f.cy, c = Math.cos(f.r), s = Math.sin(f.r);
  return Math.abs(dx * c + dy * s) <= f.hw + pad && Math.abs(-dx * s + dy * c) <= f.hh + pad;
}
// 同じグループの項目を加えたもの（重なりの順）
function withGroups(page, items) {
  const set = new Set(items), gids = new Set(items.map(i => i.gid).filter(Boolean));
  return (S.annots[page] || []).filter(a => set.has(a) || (a.gid && gids.has(a.gid)));
}
function setSel(page, items) {
  items = withGroups(page, items);
  for (const it of items) if (!it.id) it.id = uid();
  sel = items.length ? { page, ids: items.map(i => i.id) } : null;
  syncUI(); drawOverlay();
}
// 囲んだ範囲（閉じた多角形。終点は始点に戻していない）
const regionOf = mq => mq.lasso ? mq.pts : [mq.x0, mq.y0, mq.x1, mq.y0, mq.x1, mq.y1, mq.x0, mq.y1];
function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const o = (px, py, qx, qy, rx, ry) => (qx - px) * (ry - py) - (qy - py) * (rx - px) > 0;
  return o(ax, ay, bx, by, cx, cy) !== o(ax, ay, bx, by, dx, dy) && o(cx, cy, dx, dy, ax, ay) !== o(cx, cy, dx, dy, bx, by);
}
// 項目が範囲に少しでもかかっているか。かかっていれば項目の全体を選ぶ（部分的に消す消しゴムとは別の扱い）
function touchesRegion(it, reg, rb) {
  const b = boxOf(it);
  if (b[0] > rb[2] || b[2] < rb[0] || b[1] > rb[3] || b[3] < rb[1]) return false;
  const polys = outline(it);
  for (const q of polys) for (let i = 0; i < q.length; i += 2) if (inPoly(reg, q[i], q[i + 1])) return true;
  for (const q of polys) for (let i = 0; i + 3 < q.length; i += 2) {
    for (let j = 0, k = reg.length - 2; j < reg.length; k = j, j += 2) {
      if (segCross(q[i], q[i + 1], q[i + 2], q[i + 3], reg[k], reg[k + 1], reg[j], reg[j + 1])) return true;
    }
  }
  return isArea(it) && inRings(polys, reg[0], reg[1]);      // 画像や塗った面の内側だけを囲んだ場合
}
function finishMarquee() {
  const page = g.sh.page, reg = regionOf(g.mq), rb = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < reg.length; i += 2) {
    rb[0] = Math.min(rb[0], reg[i]); rb[2] = Math.max(rb[2], reg[i]); rb[1] = Math.min(rb[1], reg[i + 1]); rb[3] = Math.max(rb[3], reg[i + 1]);
  }
  if (reg.length < 6 || Math.hypot(rb[2] - rb[0], rb[3] - rb[1]) * g.k < 4) return;     // 押しただけ
  let hits = (S.annots[page] || []).filter(it => touchesRegion(it, reg, rb));
  if (addMode && sel && sel.page === page) hits = [...selItems(), ...hits];
  if (hits.length || !addMode) setSel(page, hits);
}
function beginXf(mode, its, x, y) {
  Object.assign(g, { mode, o: its, f0: selFrame(its), x0: x, y0: y });
}
// 選択の取っ手（回転・拡大縮小）を押したなら、その操作を始めて true を返す
function startHandle(e, isTouch) {
  const its = selItems();
  if (!its.length) return false;
  const sh = sheets.find(s => s.page === sel.page), q = frameGeo(selFrame(its), sh);
  const sr = stage.getBoundingClientRect(), px = e.clientX - sr.left, py = e.clientY - sr.top;
  const near = p => Math.hypot(px - p[0], py - p[1]) < 24;
  const mode = near(q.rot) ? 'rotate' : near(q.size) ? 'resize' : '';
  if (!mode) return false;
  const r = sh.el.getBoundingClientRect();
  g = { tool: 'select', id: e.pointerId, touch: isTouch, sh, k: r.width / sh.W, r };
  const [x, y] = pt(g, e);
  beginXf(mode, its, x, y);
  return true;
}
/* 選択の道具でページを押したとき:
   - 選択中のもの、または選択の枠の中 → 選択全体を動かす
   - 選択していないもの → それ（グループなら全体）を選んで動かす
   - 何もないところ → 四角または投げ縄で囲んで選ぶ
   「追加選択」がオンの間は動かさず、押したものを選択に足し（選択済みなら外し）、囲んだものを選択に足す。 */
function startSelect(h) {
  const page = h.sh.page, arr = S.annots[page] || [];
  const its = sel && sel.page === page ? selItems() : [];
  let hit = null;
  for (let i = arr.length - 1; i >= 0; i--) {              // 手前にあるものから探す
    if (hitItem(arr[i], h.x, h.y, 12 / h.k)) { hit = arr[i]; break; }
  }
  const picked = !!hit && its.includes(hit);
  const mq = () => ({ lasso: S.selMode === 'lasso', x0: h.x, y0: h.y, x1: h.x, y1: h.y, pts: [h.x, h.y] });
  if (addMode) {
    if (hit) {
      const grp = withGroups(page, [hit]);
      setSel(page, picked ? its.filter(i => !grp.includes(i)) : [...its, ...grp]);
      g = null;
    } else g.mq = mq();
  } else if (picked || (its.length && inFrame(selFrame(its), h.x, h.y, FRAME_PAD / h.k))) {
    beginXf('move', its, h.x, h.y);
    if (!picked) g.tap = hit;                // 動かさずに離したら: 押したものを選び直す。何もなければ選択を解く
  } else if (hit) {
    setSel(page, [hit]);
    beginXf('move', selItems(), h.x, h.y);
  } else {
    if (sel) setSel(page, []);
    g.mq = mq();
  }
}
// 選択を動かす・拡大縮小する・回す（ドラッグ中）
function dragSel(e) {
  let [x, y] = pt(g, e);
  if (!g.pushed) {                             // 動かし始めたときに履歴へ積む
    if (Math.hypot(x - g.x0, y - g.y0) * g.k < 3) return;
    pushUndo(g.sh.page); g.pushed = true;
  }
  const f = g.f0;
  let T = null, items = null;
  if (g.mode === 'move') {                     // 見開きの隣のページの上まで動かしたら、そのページへ移す
    const h = locate(e);
    if (h && h.sh !== g.sh) { moveToSheet(g, h.sh); [x, y] = pt(g, e); }
    T = xfMove(x - g.x0, y - g.y0);
  } else if (g.mode === 'rotate') {            // 枠の中心のまわりに回す。45度きざみの向きの近くでは、その向きに合わせる
    let th = Math.atan2(y - f.cy, x - f.cx) - Math.atan2(g.y0 - f.cy, g.x0 - f.cx);
    const tot = f.r + th, snap = Math.round(tot / (Math.PI / 4)) * (Math.PI / 4);
    if (Math.abs(tot - snap) < 0.05) th = snap - f.r;
    T = xfRot(f.cx, f.cy, th);
  } else if (g.o.length === 1 && g.o[0].t === 'g') {
    items = [boxResize(g.o[0], x - g.x0, y - g.y0)];
  } else {                                     // 縦横比を保って拡大縮小する。枠の左上の角は動かない
    const c = Math.cos(f.r), s = Math.sin(f.r);
    const vx = 2 * (f.hw * c - f.hh * s), vy = 2 * (f.hw * s + f.hh * c), d2 = vx * vx + vy * vy;   // 左上の角から右下の角へ
    if (d2 < 1e-6) return;
    const k = Math.max(((vx + x - g.x0) * vx + (vy + y - g.y0) * vy) / d2, Math.min(1, 6 / Math.sqrt(d2)));
    T = xfScale(f.cx - vx / 2, f.cy - vy / 2, k);
  }
  if (T) items = g.o.map(it => xform(it, T));
  const m = new Map(items.map(it => [it.id, it])), page = g.sh.page;
  S.annots[page] = S.annots[page].map(a => m.get(a.id) || a);
  g.frame = T ? xfFrame(f, T) : selFrame(items);
  drawAnn(g.sh); drawOverlay(); touch();
}
// 選択中の項目を書き換える（fn が別の項目を返したものだけ置き換える）。1回の「取り消す」で戻せる
function editSel(fn) {
  const its = selItems(), m = new Map();
  for (const it of its) { const n = fn(it); if (n && n !== it) m.set(it.id, n); }
  if (!m.size) return;
  const page = sel.page;
  pushUndo(page);
  S.annots[page] = S.annots[page].map(a => m.get(a.id) || a);
  redraw(page);
}
function redraw(page) {
  const sh = sheets.find(s => s.page === page);
  if (sh) drawAnn(sh);
  drawOverlay(); syncUI(); touch();
}
const without = (o, k) => { const c = { ...o }; delete c[k]; return c; };
const isLine = it => it.t === 'g' && it.k === 'line';
// 描いたあとの属性の変更。対象にならない種類の項目（色なら画像など）は変えない
const SEL_EDIT = {
  color: v => it => it.t !== 'i' && it.c !== v ? { ...it, c: v } : null,
  width: v => it => it.t === 's' || it.t === 'g' ? { ...it, w: v } : null,
  alpha: v => it => it.t === 's' || (it.t === 'g' && !filled(it)) ? { ...it, a: v } : null,           // 線の不透明度
  fill: v => it => it.t === 'f' ? (v ? { ...it, f: v } : null)                                          // 塗りの濃さ。0 は塗りなし
    : it.t === 'g' && !isLine(it) ? (v ? { ...it, f: v } : without(it, 'f')) : null,
  arrow: v => it => isLine(it) ? (v ? { ...it, ar: v } : without(it, 'ar')) : null,
};
function groupSel() {
  const gid = uid();
  editSel(it => ({ ...it, gid }));
}
function ungroupSel() {
  editSel(it => it.gid ? without(it, 'gid') : null);
}

/* ---------- コピーと貼り付け ----------
   コピーした項目はアプリの中に持つ（clip）。画像のデータも一緒に持つので、別のPDFへ貼れて、元のPDFを閉じても残る。
   座標は各ページの左上を原点とするPDFポイントなので、貼り付け先のページの大きさが違っても、寸法（ポイント = 実寸）と
   左上からの位置をそのまま使う。貼り付け先のページ（枠外領域を含む）からはみ出すときは、収まる位置まで寄せる
   （ページより大きいときは左上を合わせる）。大きさは変えない。 */
function copySel() {
  const its = selItems();
  if (!its.length) return;
  const as = {};
  for (const it of its) if (it.t === 'i' && assets[it.a]) as[it.a] = assets[it.a];
  clip = { items: its, assets: as, doc: D.id, page: sel.page, last: null };
  syncUI();
  $('status').textContent = 'コピーしました';
}
// 画面の中央に近いページ
function centerSheet() {
  const sr = stage.getBoundingClientRect(), cx = sr.left + sr.width / 2;
  let sh = sheets[0], best = Infinity;
  for (const s of sheets) {
    const r = s.el.getBoundingClientRect(), d = Math.abs((r.left + r.right) / 2 - cx);
    if (d < best) { best = d; sh = s; }
  }
  return sh;
}
function pasteClip() {
  if (!clip || !pdf || busy || !sheets.length) return;
  // コピー元のページが表示されていればそのページへ、なければ画面の中央に近いページへ貼る
  const sh = (clip.doc === D.id && sheets.find(s => s.page === clip.page)) || centerSheet();
  const key = D.id + ':' + sh.page, same = clip.doc === D.id && sh.page === clip.page;
  // 同じ場所に重ねて貼ると見分けられないので、コピー元のページへ貼るときと、続けて貼るときは少しずつずらす
  const n = clip.last && clip.last.key === key ? clip.last.n + 1 : same ? 1 : 0;
  clip.last = { key, n };
  const b = unionBox(clip.items), m = sh.H * S.marginSize;
  let dx = 12 * n, dy = 12 * n;
  if (b[2] + dx > sh.W) dx = sh.W - b[2];
  if (b[0] + dx < 0) dx = -b[0];
  if (b[3] + dy > sh.H + m) dy = sh.H + m - b[3];
  if (b[1] + dy < -m) dy = -m - b[1];
  const T = xfMove(dx, dy), gids = {};
  const items = clip.items.map(it => {         // 識別子とグループの識別子は振り直す（グループのまとまりは保つ）
    const c = xform(it, T);
    c.id = uid();
    if (it.gid) c.gid = gids[it.gid] || (gids[it.gid] = uid());
    return c;
  });
  for (const id in clip.assets) if (!assets[id]) { assets[id] = clip.assets[id]; assetsDirty = true; }
  pushUndo(sh.page);
  S.annots[sh.page] = [...(S.annots[sh.page] || []), ...items];
  S.tool = 'select';
  sel = { page: sh.page, ids: items.map(i => i.id) };
  redraw(sh.page);
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

// ドラッグ中の選択を別のページへ移す。画面上の位置が変わらないように座標を付け替える
function moveToSheet(g, nsh) {
  const osh = g.sh, ro = osh.el.getBoundingClientRect(), rn = nsh.el.getBoundingClientRect(), k = rn.width / nsh.W;
  const dx = (ro.left - rn.left) / k, dy = (ro.top - rn.top) / k + osh.m - nsh.m;
  const top = undo[undo.length - 1];
  if (top.page !== nsh.page && !(top.also || []).some(e => e.page === nsh.page)) {   // 移る先のページも同じ1回の取り消しで戻す
    (top.also = top.also || []).push({ page: nsh.page, items: (S.annots[nsh.page] || []).slice() });
  }
  const ids = new Set(sel.ids), moving = S.annots[osh.page].filter(a => ids.has(a.id));
  S.annots[osh.page] = S.annots[osh.page].filter(a => !ids.has(a.id));
  S.annots[nsh.page] = [...(S.annots[nsh.page] || []), ...moving];
  const T = xfMove(dx, dy);
  g.o = g.o.map(it => xform(it, T)); g.f0 = xfFrame(g.f0, T);
  g.x0 += dx; g.y0 += dy;
  g.sh = nsh; g.k = k; g.r = rn;
  sel = { page: nsh.page, ids: sel.ids };
  drawAnn(osh);
}
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
  } else if (g.mq) {
    const [x, y] = pt(g, e), q = g.mq.pts;
    g.mq.x1 = x; g.mq.y1 = y;
    if (g.mq.lasso && Math.hypot(x - q[q.length - 2], y - q[q.length - 1]) * g.k >= 3) q.push(x, y);
    queueOverlay();
  } else if (g.mode) dragSel(e);
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
    const up = e.type === 'pointerup', wasSelect = g.tool === 'select';
    if (g.mq && up) finishMarquee();
    else if (g.mode === 'move' && !g.pushed && up && g.tap !== undefined) setSel(g.sh.page, g.tap ? [g.tap] : []);
    g = null;
    drawOverlay();
    if (wasSelect) syncUI();
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
async function addImage(blob) {
  if (!pdf || busy || !blob) return;
  const doc = pdf;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('画像を読み込めません')); img.src = url; });
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
    const sh = centerSheet();
    const r = sh.el.getBoundingClientRect(), kk = r.width / sh.W;
    const w = sh.W * 0.4, h = w * c.height / c.width;
    const px = clamp((cx - r.left) / kk, w / 2, sh.W - w / 2);
    const py = clamp((cy - r.top) / kk - sh.m, -sh.m + h / 2, sh.H + sh.m - h / 2);
    const it = { t: 'i', id: uid(), a: id, x: r2(px - w / 2), y: r2(py - h / 2), w: r2(w), h: r2(h) };
    pushUndo(sh.page);
    (S.annots[sh.page] = S.annots[sh.page] || []).push(it);
    S.tool = 'select'; sel = { page: sh.page, ids: [it.id] };
    drawAnn(sh); drawOverlay(); syncUI(); touch();
  } catch (e) {
    alert(e.message);
  } finally { URL.revokeObjectURL(url); }
}
document.addEventListener('paste', e => {
  const f = [...(e.clipboardData ? e.clipboardData.files : [])].find(f => f.type.startsWith('image/'));
  if (f) { e.preventDefault(); addImage(f); }
  else if (clip) { e.preventDefault(); pasteClip(); }
});
async function pasteFromClipboard() {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find(t => t.startsWith('image/'));
      if (type) return addImage(await it.getType(type));
    }
    alert('クリップボードに画像がありません');
  } catch (e) {
    alert('クリップボードを読めませんでした。「画像」ボタンからファイルを選んでください。\n(' + e.message + ')');
  }
}
// 選択中のものを、そのページの書き込みの最前面または最背面へ移す。選択したものどうしの重なりの順は変えない。
// PDF本体は書き込みより常に奥にある
function reorderSel(front) {
  const its = selItems();
  if (!its.length) return;
  const page = sel.page, arr = S.annots[page], set = new Set(its), rest = arr.filter(x => !set.has(x));
  const next = front ? [...rest, ...its] : [...its, ...rest];
  if (next.every((x, i) => x === arr[i])) return;
  pushUndo(page);
  S.annots[page] = next;
  redraw(page);
}
function deleteSel() {
  const its = selItems();
  if (!its.length) return;
  const page = sel.page, set = new Set(its);
  pushUndo(page);
  S.annots[page] = S.annots[page].filter(i => !set.has(i));
  sel = null;
  redraw(page);
}

/* ---------- PDF書き出し ---------- */
async function buildPdf(withMargins) {
  const { PDFDocument, rgb, degrees, radians, LineCapStyle, LineJoinStyle, setLineJoin } = PDFLib;
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
    for (const it of annots[i] || []) {
      if (filled(it) || it.t === 'f') {
        page.drawSvgPath(svgPath(it), { x: 0, y: top, color: hex(it.c), opacity: it.f });
      } else if (it.t !== 'i') {
        page.drawSvgPath(svgPath(it), { x: 0, y: top, borderColor: hex(it.c), borderWidth: it.w, borderOpacity: it.a || 1, borderLineCap: LineCapStyle.Round });
      } else if (imgs[it.a]) {
        const data = imgs[it.a];
        const im = emb[it.a] || (emb[it.a] = await (data.startsWith('data:image/jpeg') ? out.embedJpg(data) : out.embedPng(data)));
        // PDFは下が原点で、回転は左下の角のまわりに反時計回り。画面では中心のまわりに時計回りなので付け替える
        const th = -(it.r || 0), c = Math.cos(th), sn = Math.sin(th), cx = it.x + it.w / 2, cy = top - it.y - it.h / 2;
        page.drawImage(im, { x: cx - it.w / 2 * c + it.h / 2 * sn, y: cy - it.w / 2 * sn - it.h / 2 * c, width: it.w, height: it.h, rotate: radians(th) });
      }
    }
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
  $('status').textContent = '書き出し中';
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
    $('status').textContent = '保存済み';
  } catch (e) {
    console.error(e);
    $('dlg').close();
    $('status').textContent = '';
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
  document.querySelectorAll('[data-tool]').forEach(b => on(b, toolOf(b)));
  document.querySelectorAll('[data-color]').forEach(b => on(b, b.dataset.color === S.color));
  document.querySelectorAll('[data-width]').forEach(b => on(b, b.dataset.width === S.width));
  $('bUndo').disabled = !undo.length; $('bRedo').disabled = !redo.length;
  syncSel();
  $('sFillA').value = String(S.fillA);
  $('sArrow').value = String(S.arrow);
  // 塗りありの間は、図形のボタンも塗った形で見せる
  document.querySelectorAll('[data-icon]').forEach(b => { b.textContent = b.dataset.icon[S.fillA ? 1 : 0]; });
  syncDocs();
  for (const id of ['bClose', 'bExport', 'bImage', 'bPaste', 'bLeft', 'bRight', 'bPage', 'bFit']) $(id).disabled = !pdf;
  $('bPasteObj').hidden = !clip;            // 何かをコピーしてある間だけ出す
  $('bPasteObj').disabled = !pdf;
  if (pdf) {
    const pg = spreadOf(S.cur);
    $('bPage').textContent = (pg.length > 1 ? `${pg[0] + 1}-${pg[1] + 1}` : `${pg[0] + 1}`) + ` / ${pdf.numPages}`;
  }
}
// ボタン b が、いま選んでいる道具（図形の種類・選択の囲み方も含む）か
const toolOf = b => b.dataset.tool === S.tool && (!b.dataset.shape || b.dataset.shape === S.shape) && (!b.dataset.sel || b.dataset.sel === S.selMode);
// 選択中だけ出る操作。選んだものの種類に合わせて、使える項目だけを出す
function syncSel() {
  const its = selItems();
  $('selBar').hidden = !its.length;
  if (!its.length) { addMode = false; return; }
  const show = (id, v) => { $(id).hidden = !v; };
  const stroked = its.filter(it => it.t === 's' || (it.t === 'g' && !filled(it)));
  const fills = its.filter(it => it.t === 'f' || (it.t === 'g' && !isLine(it)));
  const lines = its.filter(isLine), colored = its.filter(it => it.t !== 'i');
  // 選んだものすべてに共通する値。そろっていなければ ''
  const common = (arr, fn) => arr.length && arr.every(i => fn(i) === fn(arr[0])) ? String(fn(arr[0])) : '';
  const setVal = (id, arr, fn) => {
    const el = $(id), v = common(arr, fn);
    el.hidden = !arr.length;
    el.value = [...el.options].some(o => o.value === v) ? v : '';
  };
  show('selCols', colored.length);
  const c = common(colored, i => i.c);
  document.querySelectorAll('[data-selcolor]').forEach(b => b.classList.toggle('on', b.dataset.selcolor === c));
  setVal('sSelW', stroked, i => r2(i.w));
  setVal('sSelA', stroked, i => i.a || 1);
  setVal('sSelF', fills, i => i.f || 0);
  setVal('sSelAr', lines, i => i.ar || 0);
  const gids = new Set(its.map(i => i.gid || ''));
  show('bGroup', its.length > 1 && (gids.size > 1 || gids.has('')));
  show('bUngroup', its.some(i => i.gid));
  $('bAddSel').classList.toggle('on', addMode);
  $('selInfo').textContent = its.length + '個';
  // 選んだものが画面の下のほうにあるときは、操作の列を上に出して隠さないようにする
  const sh = sheets.find(s => s.page === sel.page), f = selFrame(its), t = sheetXform(sh);
  $('selBar').classList.toggle('top', t.oy + f.cy * t.k > stage.clientHeight * 0.6);
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
$('sArrow').onchange = e => setOpt(() => { S.arrow = +e.target.value; });
document.querySelectorAll('[data-selcolor]').forEach(b => b.onclick = () => editSel(SEL_EDIT.color(b.dataset.selcolor)));
for (const [id, kind] of [['sSelW', 'width'], ['sSelA', 'alpha'], ['sSelF', 'fill'], ['sSelAr', 'arrow']]) {
  $(id).onchange = e => { if (e.target.value !== '') editSel(SEL_EDIT[kind](+e.target.value)); syncUI(); };
}
$('bAddSel').onclick = () => { addMode = !addMode; syncUI(); };
$('bGroup').onclick = groupSel;
$('bUngroup').onclick = ungroupSel;
$('bCopy').onclick = copySel;
$('bPasteObj').onclick = pasteClip;
$('bFront').onclick = () => reorderSel(true);
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
  const same = toolOf(b);
  S.tool = same ? '' : b.dataset.tool;
  if (b.dataset.shape) S.shape = b.dataset.shape;
  if (b.dataset.sel) S.selMode = b.dataset.sel;
  if (S.colors[S.tool]) S.color = S.colors[S.tool];      // その道具で最後に使った色と太さに戻す
  if (S.widths[S.tool]) S.width = S.widths[S.tool];
  if (S.tool !== 'select') sel = null;
  drawOverlay();
}));
document.querySelectorAll('[data-color]').forEach(b => b.onclick = () => setOpt(() => {
  S.color = b.dataset.color;
  if (S.tool !== 'pen' && S.tool !== 'marker' && S.tool !== 'shape') S.tool = 'pen';
  S.colors[S.tool] = S.color;
}));
document.querySelectorAll('[data-width]').forEach(b => b.onclick = () => setOpt(() => {
  S.width = b.dataset.width;
  S.widths[S.widths[S.tool] ? S.tool : 'pen'] = S.width;   // 選択・無選択のときはペンの太さとして覚える
}));
$('bUndo').onclick = () => stepHistory(undo, redo);
$('bRedo').onclick = () => stepHistory(redo, undo);
$('bImage').onclick = () => $('fImg').click();
$('fImg').onchange = e => { addImage(e.target.files[0]); e.target.value = ''; };
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
  const net = $('net');
  const showUpdate = () => { $('bUpdate').hidden = false; };
  const watch = w => w && w.addEventListener('statechange', () => {
    if (w.state === 'installed' && sw.controller) showUpdate();
    if (w.state === 'redundant' && !sw.controller) net.textContent = '';   // 取り込み失敗。次回の起動で再試行
  });

  if (!sw.controller) net.textContent = 'オフライン準備中';
  sw.ready.then(() => { net.textContent = 'オフライン可'; });

  sw.register('sw.js').then(r => {
    reg = r;
    if (r.waiting && sw.controller) showUpdate();
    watch(r.installing);
    r.addEventListener('updatefound', () => watch(r.installing));
  }).catch(e => { console.error(e); net.textContent = ''; });

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
        try { await activate(d.id); $('status').textContent = '復元済み'; break; }
        catch (e) { console.error(e); }
      }
    } catch (e) { console.error(e); }
  });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
})();
