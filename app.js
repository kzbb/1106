'use strict';
/* 台本ノート: PDFに手書きと画像を載せるスクリプター用ビューア
   座標系: 各ページの左上を原点とするPDFポイント。上の枠外は y<0、下の枠外は y>ページ高さ。 */

pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js';

const $ = id => document.getElementById(id);
const stage = $('stage'), world = $('world'), overlay = $('overlay');
const MAX_PX = 5e6;          // キャンバス1枚の画素数の上限（iPadのメモリ対策）
const MAX_Z = 6;
const WIDTHS = { s: 0.8, m: 1.6, l: 3.2 };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r2 = v => Math.round(v * 100) / 100;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// 保存される状態
let S = {
  name: '', cur: 0, mode: 'spread', rtl: true, cover: true,
  margins: true, marginSize: 0.2,
  tool: 'pen', color: '#d00000', width: 'm', fingerDraw: false,
  annots: {},                // ページ番号 -> 項目の配列
};
let assets = {};             // 画像ID -> dataURL
let pdf = null, pdfBytes = null, sizes = [];
let sheets = [], view = { tx: 0, ty: 0, z: 1 }, base = { s: 1, w: 0, h: 0 };
let undo = [], redo = [], sel = null, renderedZ = 1;

/* ---------- IndexedDB ---------- */
const dbp = new Promise((res, rej) => {
  const r = indexedDB.open('daihon-note', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function idbGet(k) {
  const d = await dbp;
  return new Promise((res, rej) => {
    const r = d.transaction('kv').objectStore('kv').get(k);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function idbSet(k, v) {
  const d = await dbp;
  return new Promise((res, rej) => {
    const tx = d.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(v, k);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}

let saveTimer = 0, assetsDirty = false;
function touch() {
  $('status').textContent = '未保存';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}
async function save() {
  clearTimeout(saveTimer);
  if (!pdf) return;
  try {
    await idbSet('state', S);
    if (assetsDirty) { assetsDirty = false; await idbSet('assets', assets); }
    $('status').textContent = '保存済み';
  } catch (e) {
    console.error(e);
    $('status').textContent = '保存失敗';
  }
}
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });
addEventListener('pagehide', save);

/* ---------- PDFの読み込み ---------- */
async function openPdf(buf, name, restored) {
  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buf.slice(0)),
    // ワーカー側から読まれるため、相対パスではなく絶対URLで渡す
    cMapUrl: new URL('vendor/pdfjs/cmaps/', location.href).href, cMapPacked: true,
    standardFontDataUrl: new URL('vendor/pdfjs/standard_fonts/', location.href).href,
  }).promise;
  pdf = doc; pdfBytes = buf; sizes = []; undo = []; redo = []; sel = null;
  if (!restored) {
    S.name = name; S.cur = 0; S.annots = {}; assets = {};
    await idbSet('pdf', buf);
    assetsDirty = true;
    await save();
  }
  S.cur = clamp(S.cur, 0, pdf.numPages - 1);
  $('empty').hidden = true;
  syncUI();
  await show();
}

async function pickPdf(file) {
  if (!file) return;
  const has = Object.values(S.annots).some(a => a.length);
  if (pdf && has && !confirm('別のPDFを開くと、現在の書き込みは消えます。必要なら先に書き出してください。開きますか？')) return;
  try {
    await openPdf(await file.arrayBuffer(), file.name, false);
  } catch (e) {
    console.error(e);
    alert('PDFを開けませんでした: ' + e.message);
  }
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
  const tok = ++showTok;
  const pages = spreadOf(S.cur);
  for (const p of pages) {
    if (!sizes[p]) {
      const vp = (await pdf.getPage(p + 1)).getViewport({ scale: 1 });
      sizes[p] = { w: vp.width, h: vp.height };
    }
  }
  if (tok !== showTok) return;
  sheets.forEach(s => s.task && s.task.cancel());
  world.textContent = '';
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
  const tok = ++sh.tok;
  if (sh.task) sh.task.cancel();
  const c = document.createElement('canvas');
  c.className = 'pdf';
  c.width = Math.round(sh.W * sh.r); c.height = Math.round(sh.H * sh.r);
  try {
    const pg = await pdf.getPage(sh.page + 1);
    if (tok !== sh.tok) return;
    const task = pg.render({ canvasContext: c.getContext('2d'), viewport: pg.getViewport({ scale: sh.r }) });
    sh.task = task;
    await task.promise;
    if (tok !== sh.tok || !sheets.includes(sh)) return;
    placePdfCanvas(sh, c);
    sh.pdfC.replaceWith(c); sh.pdfC = c;
  } catch (e) {
    if (e && e.name !== 'RenderingCancelledException') console.error(e);
  }
}

function strokePath(ctx, it) {
  const p = it.p, n = p.length / 2;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.strokeStyle = it.c; ctx.lineWidth = it.w; ctx.globalAlpha = it.a || 1;
  ctx.beginPath();
  ctx.moveTo(p[0], p[1]);
  if (n === 1) ctx.lineTo(p[0] + 0.01, p[1]);
  for (let i = 1; i < n - 1; i++) {
    ctx.quadraticCurveTo(p[2 * i], p[2 * i + 1], (p[2 * i] + p[2 * i + 2]) / 2, (p[2 * i + 1] + p[2 * i + 3]) / 2);
  }
  if (n > 1) ctx.lineTo(p[2 * n - 2], p[2 * n - 1]);
  ctx.stroke();
  ctx.restore();
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
    if (it.t === 's') strokePath(ctx, it);
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
  if (g && g.stroke) {                       // 書いている途中の線
    const t = sheetXform(g.sh);
    ctx.setTransform(t.k * dpr, 0, 0, t.k * dpr, t.ox * dpr, t.oy * dpr);
    strokePath(ctx, g.stroke);
  }
  const it = selItem();
  if (it) {                                  // 選択中の画像の枠とリサイズ用の取っ手
    const sh = sheets.find(s => s.page === sel.page);
    const t = sheetXform(sh);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const x = t.ox + it.x * t.k, y = t.oy + it.y * t.k, w = it.w * t.k, h = it.h * t.k;
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
  if (!pdf || e.target.closest('#empty')) return;
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
  } else if (S.tool === 'eraser') {
    eraseAt(g, h.x, h.y);
  } else {
    const arr = S.annots[h.sh.page] || [];
    const cur = sel && sel.page === h.sh.page && arr.find(i => i.id === sel.id);
    let it = null, mode = 'move';
    if (cur && Math.hypot(h.x - (cur.x + cur.w), h.y - (cur.y + cur.h)) < 24 / h.k) { it = cur; mode = 'resize'; }
    else for (let i = arr.length - 1; i >= 0; i--) {
      const a = arr[i];
      if (a.t === 'i' && h.x >= a.x && h.x <= a.x + a.w && h.y >= a.y && h.y <= a.y + a.h) { it = a; break; }
    }
    if (!it) { sel = null; g = null; }
    else { sel = { page: h.sh.page, id: it.id }; Object.assign(g, { mode, it, x0: h.x, y0: h.y, o: { ...it } }); }
    syncUI(); drawOverlay();
  }
}

function hitStroke(it, x, y, rad) {
  const p = it.p;
  if (p.length === 2) return Math.hypot(p[0] - x, p[1] - y) <= rad;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], dx = p[i + 2] - ax, dy = p[i + 3] - ay;
    const L = dx * dx + dy * dy;
    const t = L ? clamp(((x - ax) * dx + (y - ay) * dy) / L, 0, 1) : 0;
    if (Math.hypot(ax + t * dx - x, ay + t * dy - y) <= rad) return true;
  }
  return false;
}
function eraseAt(g, x, y) {
  const page = g.sh.page, arr = S.annots[page];
  if (!arr) return;
  const rad = 10 / g.k;
  const keep = arr.filter(it => it.t !== 's' || !hitStroke(it, x, y, rad + it.w / 2));
  if (keep.length === arr.length) return;
  if (!g.pushed) { pushUndo(page); g.pushed = true; }
  S.annots[page] = keep;
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
  if (g.stroke) {
    const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
    const p = g.stroke.p;
    for (const ev of evs.length ? evs : [e]) {
      const [x, y] = pt(g, ev);
      if (Math.hypot(x - p[p.length - 2], y - p[p.length - 1]) * g.k >= 0.7) p.push(r2(x), r2(y));
    }
    queueOverlay();
  } else if (g.tool === 'eraser') {
    const [x, y] = pt(g, e);
    eraseAt(g, x, y);
  } else if (g.it) {
    const [x, y] = pt(g, e), page = g.sh.page;
    if (!g.pushed) {                           // 動かし始めたときに履歴へ積み、複製を動かす
      if (Math.hypot(x - g.x0, y - g.y0) * g.k < 3) return;
      pushUndo(page); g.pushed = true;
      const arr = S.annots[page], c = { ...g.it };
      arr[arr.indexOf(g.it)] = c; g.it = c;
    }
    const it = g.it, o = g.o;
    if (g.mode === 'move') { it.x = r2(o.x + x - g.x0); it.y = r2(o.y + y - g.y0); }
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
    if (g.stroke) {
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
  if (!pdf || !blob) return;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('画像を読み込めません')); img.src = url; });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
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
    const m = withMargins ? H * S.marginSize : 0;
    const page = out.addPage([W, H + 2 * m]);
    const ep = await out.embedPage(sp, { left: cb.x, bottom: cb.y, right: cb.x + cb.width, top: cb.y + cb.height });
    // 回転つきのページは、表示と同じ向きになるように置く
    const pos = { 0: [0, m, 0], 90: [0, m + cb.width, -90], 180: [cb.width, m + cb.height, 180], 270: [cb.height, m, 90] }[rot] || [0, m, 0];
    page.drawPage(ep, { x: pos[0], y: pos[1], rotate: degrees(pos[2]) });
    const top = m + H;                       // ページ上端のy（PDFは下が原点）
    page.pushOperators(setLineJoin(LineJoinStyle.Round));
    for (const it of S.annots[i] || []) {
      if (it.t === 's') {
        const p = it.p, n = p.length / 2;
        let d = `M ${p[0]} ${p[1]}`;
        if (n === 1) d += ` L ${p[0] + 0.01} ${p[1]}`;
        for (let j = 1; j < n - 1; j++) d += ` Q ${p[2 * j]} ${p[2 * j + 1]} ${r2((p[2 * j] + p[2 * j + 2]) / 2)} ${r2((p[2 * j + 1] + p[2 * j + 3]) / 2)}`;
        if (n > 1) d += ` L ${p[2 * n - 2]} ${p[2 * n - 1]}`;
        page.drawSvgPath(d, { x: 0, y: top, borderColor: hex(it.c), borderWidth: it.w, borderOpacity: it.a || 1, borderLineCap: LineCapStyle.Round });
      } else if (assets[it.a]) {
        const data = assets[it.a];
        const im = emb[it.a] || (emb[it.a] = await (data.startsWith('data:image/jpeg') ? out.embedJpg(data) : out.embedPng(data)));
        page.drawImage(im, { x: it.x, y: top - it.y - it.h, width: it.w, height: it.h });
      }
    }
  }
  return out.save();
}
async function exportPdf(withMargins) {
  $('dlg').close();
  $('status').textContent = '書き出し中';
  try {
    const bytes = await buildPdf(withMargins);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    a.download = (S.name || 'script').replace(/\.pdf$/i, '') + '_書き込み.pdf';
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    $('status').textContent = '保存済み';
  } catch (e) {
    console.error(e);
    $('status').textContent = '';
    alert('書き出しに失敗しました: ' + e.message);
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
  document.querySelectorAll('[data-tool]').forEach(b => on(b, b.dataset.tool === S.tool));
  document.querySelectorAll('[data-color]').forEach(b => on(b, b.dataset.color === S.color));
  document.querySelectorAll('[data-width]').forEach(b => on(b, b.dataset.width === S.width));
  $('bUndo').disabled = !undo.length; $('bRedo').disabled = !redo.length;
  $('bDelete').disabled = !selItem();
  for (const id of ['bExport', 'bImage', 'bPaste', 'bLeft', 'bRight', 'bPage', 'bFit']) $(id).disabled = !pdf;
  if (pdf) {
    const pg = spreadOf(S.cur);
    $('bPage').textContent = (pg.length > 1 ? `${pg[0] + 1}-${pg[1] + 1}` : `${pg[0] + 1}`) + ` / ${pdf.numPages}`;
  }
}
function setOpt(fn, relayout) {
  fn(); syncUI(); touch();
  if (pdf && relayout) show();
}

$('bOpen').onclick = $('bOpen2').onclick = () => $('fPdf').click();
$('fPdf').onchange = e => { pickPdf(e.target.files[0]); e.target.value = ''; };
$('bExport').onclick = () => $('dlg').showModal();
$('bExpWith').onclick = () => exportPdf(true);
$('bExpWithout').onclick = () => exportPdf(false);
$('bExpCancel').onclick = () => $('dlg').close();
$('bMode').onclick = () => setOpt(() => { S.mode = S.mode === 'spread' ? 'single' : 'spread'; }, true);
$('bDir').onclick = () => setOpt(() => { S.rtl = !S.rtl; }, true);
$('bCover').onclick = () => setOpt(() => { S.cover = !S.cover; }, true);
$('bMargin').onclick = () => setOpt(() => { S.margins = !S.margins; }, true);
$('sMargin').onchange = e => setOpt(() => { S.marginSize = +e.target.value; S.margins = true; }, true);
$('bFit').onclick = () => { view = { tx: 0, ty: 0, z: 1 }; clampView(); applyView(); };
$('bFinger').onclick = () => setOpt(() => { S.fingerDraw = !S.fingerDraw; });
document.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setOpt(() => {
  S.tool = b.dataset.tool;
  if (S.tool !== 'select') sel = null;
  drawOverlay();
}));
document.querySelectorAll('[data-color]').forEach(b => b.onclick = () => setOpt(() => {
  S.color = b.dataset.color;
  if (S.tool !== 'pen' && S.tool !== 'marker') S.tool = 'pen';
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
  if (!pdf || $('dlg').open) return;
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
  if (f.type.startsWith('image/')) addImage(f); else pickPdf(f);
});
let resizeTimer = 0;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    sizeOverlay();
    if (!pdf) return;
    fit(); clampView(); applyView(); renderAll();
  }, 100);
});

/* ---------- 起動: 前回の続きを復元 ---------- */
(async function init() {
  sizeOverlay(); syncUI();
  try {
    const [st, buf, as] = await Promise.all([idbGet('state'), idbGet('pdf'), idbGet('assets')]);
    if (st && buf) {
      S = Object.assign(S, st); assets = as || {};
      await openPdf(buf, S.name, true);
      $('status').textContent = '復元済み';
    }
  } catch (e) { console.error(e); }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
})();
