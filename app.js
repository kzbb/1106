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
const PREF_KEYS = ['tool', 'color', 'colors', 'width', 'fingerDraw', 'shape', 'fillA'];
let S = {
  name: '', cur: 0, mode: 'spread', rtl: true, cover: true,
  margins: true, marginSize: 0.2,
  tool: 'pen', color: '#d00000', width: 'm', fingerDraw: false, shape: 'line', fillA: 0,   // fillA: 図形の塗りの濃さ。0 は塗りなし
  colors: { pen: '#d00000', marker: '#d00000', shape: '#d00000' },   // 道具ごとに覚えている色。color はいま選んでいる道具の色
  annots: {},                // ページ番号 -> 項目の配列（配列の後ろほど手前に描かれる）
};
/* 項目の種類:
   {t:'s', c, w, a, p:[x,y,...]}        手書きの線。点列を二次ベジェでなめらかに結ぶ
   {t:'s', ..., l:1}                    折れ線（点列を直線で結ぶ）。消しゴムで切り分けた残りはこの形になる
   {t:'g', id, k, c, w, x0, y0, x1, y1} 図形。k = line | ellipse | tri | rect | star。(x0,y0)→(x1,y1) はドラッグした範囲
   {t:'g', ..., f}                      塗りつぶした図形。f は濃さ（不透明度 0〜1）。輪郭線は引かず、面全体を1色で塗る
   {t:'f', c, f, r:[[x,y,...],...]}     塗った面。塗りつぶした図形を消しゴムで削った残り。r は外周と穴の輪の並び
   {t:'i', id, a, x, y, w, h}           画像。a は assets のID */
let assets = {};             // 画像ID -> dataURL（表示中のPDFの分だけ）
let docs = [];               // 開いているPDFの一覧 [{id, name, k}]。k はIndexedDBのキーの接頭辞
let D = null;                // 表示中のPDF（docs の要素）
const hist = {};             // PDFのID -> {undo, redo}。取り消し履歴はPDFごとに分ける
let busy = false;            // PDFの追加・切り替え・削除の最中
let pdf = null, pdfBytes = null, sizes = [];
let sheets = [], view = { tx: 0, ty: 0, z: 1 }, base = { s: 1, w: 0, h: 0 };
let undo = [], redo = [], sel = null, renderedZ = 1;
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

async function addPdf(file) {
  let doc = null;
  try {
    const buf = await file.arrayBuffer();
    doc = await loadDoc(buf);               // 保存する前に、開けるPDFかどうかを確かめる
    if (!(await save())) throw new Error('表示中のPDFの書き込みを保存できないため、追加を中止しました');
    const id = uid(), entry = { id, name: file.name, k: `d:${id}:` };
    // 綴じ方向などの表示設定は、いま表示中のPDFのものを引き継ぐ
    const st = { ...pick(S, DOC_KEYS), name: file.name, cur: 0, annots: {} };
    const meta = { ...metaObj(), docs: [...docs, entry].map(d => ({ ...d })), active: id };
    try {                                   // PDF本体と一覧を1つのトランザクションで書く。失敗したら何も変わらない
      await idbRun('readwrite', s => {
        s.put(buf, entry.k + 'pdf'); s.put(st, entry.k + 'state'); s.put({}, entry.k + 'assets');
        return s.put(meta, 'meta');
      });
    } catch (e) {
      throw new Error('端末に保存できませんでした。\n' + saveErrText(e));
    }
    docs = [...docs, entry];
    const d = doc; doc = null;
    await enterDoc(entry, st, {}, buf, d);
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
// 選択枠に使う外接長方形
const frameOf = it => it.t === 'g'
  ? { x: Math.min(it.x0, it.x1), y: Math.min(it.y0, it.y1), w: Math.abs(it.x1 - it.x0), h: Math.abs(it.y1 - it.y0) }
  : { x: it.x, y: it.y, w: it.w, h: it.h };
const ellipseOf = it => ({ cx: (it.x0 + it.x1) / 2, cy: (it.y0 + it.y1) / 2, rx: Math.abs(it.x1 - it.x0) / 2, ry: Math.abs(it.y1 - it.y0) / 2 });
function shapeTrace(ctx, it) {
  if (it.k === 'ellipse') {
    const e = ellipseOf(it);
    ctx.ellipse(e.cx, e.cy, e.rx, e.ry, 0, 0, Math.PI * 2);
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
    if (it.k === 'ellipse') {
      const { cx, cy, rx, ry } = ellipseOf(it), kx = rx * 0.5522847498, ky = ry * 0.5522847498;
      return `M ${f(cx + rx)} ${f(cy)} C ${f(cx + rx)} ${f(cy + ky)} ${f(cx + kx)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)}`
        + ` C ${f(cx - kx)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ky)} ${f(cx - rx)} ${f(cy)}`
        + ` C ${f(cx - rx)} ${f(cy - ky)} ${f(cx - kx)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)}`
        + ` C ${f(cx + kx)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ky)} ${f(cx + rx)} ${f(cy)} Z`;
    }
    const q = shapePts(it);
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
  for (const it of S.annots[sh.page] || []) {
    if (it.t !== 'i') strokePath(ctx, it);
    else {
      const img = getImg(it.a, () => { if (sheets.includes(sh)) drawAnn(sh); });
      if (img) ctx.drawImage(img, it.x, it.y, it.w, it.h);
    }
  }
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
  const it = selItem();
  if (it) {                                  // 選択中の画像・図形の枠とリサイズ用の取っ手
    const sh = sheets.find(s => s.page === sel.page);
    const t = sheetXform(sh);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const f = frameOf(it);
    const x = t.ox + f.x * t.k, y = t.oy + f.y * t.k, w = f.w * t.k, h = f.h * t.k;
    ctx.strokeStyle = '#0a66d8'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
    ctx.fillStyle = '#0a66d8';
    ctx.beginPath(); ctx.arc(x + w, y + h, 9, 0, Math.PI * 2); ctx.fill();
  }
}
function selItem() {
  if (!sel || !sheets.some(s => s.page === sel.page)) return null;
  return (S.annots[sel.page] || []).find(i => i.id === sel.id) || null;
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
  to.push({ page: u.page, items: (S.annots[u.page] || []).slice() });
  S.annots[u.page] = u.items;
  sel = null;
  const sh = sheets.find(s => s.page === u.page);
  if (sh) { drawAnn(sh); drawOverlay(); syncUI(); }
  else { S.cur = u.page; show(); }
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
  const h = locate(e);
  if (!h) {
    if (S.tool === 'select' && sel) { sel = null; syncUI(); drawOverlay(); }
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
  } else if (S.tool === 'eraser') {
    eraseTo(g, h.x, h.y);
  } else {
    const arr = S.annots[h.sh.page] || [];
    const cur = sel && sel.page === h.sh.page && arr.find(i => i.id === sel.id);
    let it = null, mode = 'move';
    const f = cur && frameOf(cur);
    if (f && Math.hypot(h.x - (f.x + f.w), h.y - (f.y + f.h)) < 24 / h.k) { it = cur; mode = 'resize'; }
    else for (let i = arr.length - 1; i >= 0; i--) {         // 手前にあるものから探す
      if (hitItem(arr[i], h.x, h.y, 12 / h.k)) { it = arr[i]; break; }
    }
    if (!it) { sel = null; g = null; }
    else { if (!it.id) it.id = uid(); sel = { page: h.sh.page, id: it.id }; Object.assign(g, { mode, it, x0: h.x, y0: h.y, o: { ...it } }); }
    syncUI(); drawOverlay();
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
      const { cx, cy, rx, ry } = ellipseOf(it), r = Math.max(rx, ry, 0.01);
      const n = clamp(Math.ceil(Math.PI / Math.acos(Math.max(0, 1 - FLAT_TOL / r))), 16, 720);
      o = [];
      for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; o.push(cx + rx * Math.cos(a), cy + ry * Math.sin(a)); }
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
  if (it.t === 'g') b = [Math.min(it.x0, it.x1), Math.min(it.y0, it.y1), Math.max(it.x0, it.x1), Math.max(it.y0, it.y1)];
  else {
    b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of it.t === 'f' ? it.r : [it.p]) for (let i = 0; i < p.length; i += 2) {
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
    return [{ t: 'f', c: it.c, f: it.f, r: sol.map(p => { const q = []; for (const v of p) q.push(v.X / CS, v.Y / CS); return q; }) }];
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
// 選択の当たり判定。画像は面、図形は輪郭の近く（塗りつぶした図形は面も）。手書きの線は選択できない
function hitItem(a, x, y, tol) {
  if (a.t === 'i') return x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h;
  if (a.t !== 'g') return false;
  const q = flatten(a);
  return (filled(a) && inPoly(q, x, y)) || cutPoly(q, x, y, x, y, tol + a.w / 2) !== null;
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
        parts = area ? cutFill(it, ax, ay, x, y, R) : cutPoly(flatten(it), ax, ay, x, y, R);
      }
    }
    if (!parts) { if (out) out.push(it); continue; }
    if (!out) out = arr.slice(0, i);
    if (area) out.push(...parts);
    else for (const q of parts) out.push({ t: 's', c: it.c, w: it.w, a: it.a || 1, l: 1, p: q.map(r2) });
  }
  if (!out) return;
  if (!g.pushed) { pushUndo(page); g.pushed = true; }      // 1回のなぞりを1回の「取り消す」で戻せるようにする
  S.annots[page] = out;
  drawAnn(g.sh); touch();
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
  } else if (g.it) {
    const [x, y] = pt(g, e), page = g.sh.page;
    if (!g.pushed) {                           // 動かし始めたときに履歴へ積み、複製を動かす
      if (Math.hypot(x - g.x0, y - g.y0) * g.k < 3) return;
      pushUndo(page); g.pushed = true;
      const arr = S.annots[page], c = { ...g.it };
      arr[arr.indexOf(g.it)] = c; g.it = c;
    }
    const it = g.it, o = g.o;
    const dx = x - g.x0, dy = y - g.y0;
    if (it.t === 'g') {
      if (g.mode === 'move') { it.x0 = r2(o.x0 + dx); it.x1 = r2(o.x1 + dx); it.y0 = r2(o.y0 + dy); it.y1 = r2(o.y1 + dy); }
      else {                                   // 右下の取っ手: 右端と下端にある側の座標を動かす（縦横比は自由）
        const min = it.k === 'line' ? 0 : 2;
        const [xa, xb] = o.x1 >= o.x0 ? ['x1', 'x0'] : ['x0', 'x1'], [ya, yb] = o.y1 >= o.y0 ? ['y1', 'y0'] : ['y0', 'y1'];
        it[xa] = r2(Math.max(o[xb] + min, o[xa] + dx)); it[ya] = r2(Math.max(o[yb] + min, o[ya] + dy));
      }
    }
    else if (g.mode === 'move') { it.x = r2(o.x + x - g.x0); it.y = r2(o.y + y - g.y0); }
    else { it.w = r2(Math.max(12, o.w + x - g.x0)); it.h = r2(it.w * o.h / o.w); }
    drawAnn(g.sh); drawOverlay(); touch();
  }
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
    S.tool = 'select'; sel = { page: sh.page, id: it.id };
    drawAnn(sh); drawOverlay(); syncUI(); touch();
  } catch (e) {
    alert(e.message);
  } finally { URL.revokeObjectURL(url); }
}
document.addEventListener('paste', e => {
  const f = [...(e.clipboardData ? e.clipboardData.files : [])].find(f => f.type.startsWith('image/'));
  if (f) { e.preventDefault(); addImage(f); }
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
// 選択中の画像・図形を、そのページの書き込みの最前面または最背面へ移す。PDF本体は書き込みより常に奥にある
function reorderSel(front) {
  const it = selItem();
  if (!it) return;
  const page = sel.page, arr = S.annots[page], i = arr.indexOf(it);
  if (i === (front ? arr.length - 1 : 0)) return;
  pushUndo(page);
  const rest = arr.filter(x => x !== it);
  S.annots[page] = front ? [...rest, it] : [it, ...rest];
  const sh = sheets.find(s => s.page === page);
  if (sh) drawAnn(sh);
  drawOverlay(); syncUI(); touch();
}
function deleteSel() {
  const it = selItem();
  if (!it) return;
  pushUndo(sel.page);
  S.annots[sel.page] = S.annots[sel.page].filter(i => i !== it);
  const sh = sheets.find(s => s.page === sel.page);
  sel = null;
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
    for (const it of annots[i] || []) {
      if (filled(it) || it.t === 'f') {
        page.drawSvgPath(svgPath(it), { x: 0, y: top, color: hex(it.c), opacity: it.f });
      } else if (it.t !== 'i') {
        page.drawSvgPath(svgPath(it), { x: 0, y: top, borderColor: hex(it.c), borderWidth: it.w, borderOpacity: it.a || 1, borderLineCap: LineCapStyle.Round });
      } else if (imgs[it.a]) {
        const data = imgs[it.a];
        const im = emb[it.a] || (emb[it.a] = await (data.startsWith('data:image/jpeg') ? out.embedJpg(data) : out.embedPng(data)));
        page.drawImage(im, { x: it.x, y: top - it.y - it.h, width: it.w, height: it.h });
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
  $('bExpWith').disabled = $('bExpWithout').disabled = false;
  $('dlg').showModal();
}
function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
}
async function exportPdf(withMargins) {
  const viaShare = shareFiles();
  if (viaShare) {
    // 共有シートはボタンを押した直後にしか開けないので、作成後に「保存・共有」をもう一度押してもらう
    $('expMsg').textContent = 'PDFを作成しています…';
    $('bExpWith').disabled = $('bExpWithout').disabled = true;
  } else $('dlg').close();
  $('status').textContent = '書き出し中';
  try {
    const bytes = await buildPdf(withMargins);
    const file = new File([bytes], (S.name || 'script').replace(/\.pdf$/i, '') + '_書き込み.pdf', { type: 'application/pdf' });
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
  on($('bFinger'), S.fingerDraw);
  document.querySelectorAll('[data-tool]').forEach(b => on(b, b.dataset.tool === S.tool && (!b.dataset.shape || b.dataset.shape === S.shape)));
  document.querySelectorAll('[data-color]').forEach(b => on(b, b.dataset.color === S.color));
  document.querySelectorAll('[data-width]').forEach(b => on(b, b.dataset.width === S.width));
  $('bUndo').disabled = !undo.length; $('bRedo').disabled = !redo.length;
  $('selBar').hidden = !selItem();
  $('sFillA').value = String(S.fillA);
  // 塗りありの間は、図形のボタンも塗った形で見せる
  document.querySelectorAll('[data-icon]').forEach(b => { b.textContent = b.dataset.icon[S.fillA ? 1 : 0]; });
  syncDocs();
  for (const id of ['bClose', 'bExport', 'bImage', 'bPaste', 'bLeft', 'bRight', 'bPage', 'bFit']) $(id).disabled = !pdf;
  if (pdf) {
    const pg = spreadOf(S.cur);
    $('bPage').textContent = (pg.length > 1 ? `${pg[0] + 1}-${pg[1] + 1}` : `${pg[0] + 1}`) + ` / ${pdf.numPages}`;
  }
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
$('fPdf').onchange = e => { pickPdfs(e.target.files); e.target.value = ''; };
$('sDoc').onchange = e => { const id = e.target.value; syncUI(); if (id) switchDoc(id); };
$('bClose').onclick = closeDoc;
$('sFillA').onchange = e => setOpt(() => { S.fillA = +e.target.value; });
$('bFront').onclick = () => reorderSel(true);
$('bBack').onclick = () => reorderSel(false);
$('bExport').onclick = openExport;
$('bExpWith').onclick = () => exportPdf(true);
$('bExpWithout').onclick = () => exportPdf(false);
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
  const same = b.dataset.tool === S.tool && (!b.dataset.shape || b.dataset.shape === S.shape);
  S.tool = same ? '' : b.dataset.tool;
  if (b.dataset.shape) S.shape = b.dataset.shape;
  if (S.colors[S.tool]) S.color = S.colors[S.tool];      // その道具で最後に使った色に戻す
  if (S.tool !== 'select') sel = null;
  drawOverlay();
}));
document.querySelectorAll('[data-color]').forEach(b => b.onclick = () => setOpt(() => {
  S.color = b.dataset.color;
  if (S.tool !== 'pen' && S.tool !== 'marker' && S.tool !== 'shape') S.tool = 'pen';
  S.colors[S.tool] = S.color;
}));
document.querySelectorAll('[data-width]').forEach(b => b.onclick = () => setOpt(() => { S.width = b.dataset.width; }));
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
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selItem()) { e.preventDefault(); deleteSel(); }
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
