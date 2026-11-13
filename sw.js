'use strict';
/* 台本ノート Service Worker: アプリ一式を端末に保存し、オフラインでも起動できるようにする。
   VERSION と FILES は tools/build-sw.mjs が生成する。ファイルを変更したら配信前に必ず
     node tools/build-sw.mjs
   を実行すること（VERSION が変わらないと利用者の端末は更新されない）。 */

// @@BUILD_START
const VERSION = '8b5c5259f925';
const FILES = [
  "./",
  "app.js",
  "style.css",
  "manifest.webmanifest",
  "icons/icon-180.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "vendor/pdf-lib.min.js",
  "vendor/pdfjs/cmaps/78-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/78-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/78-H.bcmap",
  "vendor/pdfjs/cmaps/78-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/78-RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/78-V.bcmap",
  "vendor/pdfjs/cmaps/78ms-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/78ms-RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/83pv-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/90ms-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/90ms-RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/90msp-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/90msp-RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/90pv-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/90pv-RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/Add-H.bcmap",
  "vendor/pdfjs/cmaps/Add-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/Add-RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/Add-V.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-0.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-1.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-2.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-3.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-4.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-5.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-6.bcmap",
  "vendor/pdfjs/cmaps/Adobe-CNS1-UCS2.bcmap",
  "vendor/pdfjs/cmaps/Adobe-GB1-0.bcmap",
  "vendor/pdfjs/cmaps/Adobe-GB1-1.bcmap",
  "vendor/pdfjs/cmaps/Adobe-GB1-2.bcmap",
  "vendor/pdfjs/cmaps/Adobe-GB1-3.bcmap",
  "vendor/pdfjs/cmaps/Adobe-GB1-4.bcmap",
  "vendor/pdfjs/cmaps/Adobe-GB1-5.bcmap",
  "vendor/pdfjs/cmaps/Adobe-GB1-UCS2.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-0.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-1.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-2.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-3.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-4.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-5.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-6.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Korea1-0.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Korea1-1.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Korea1-2.bcmap",
  "vendor/pdfjs/cmaps/Adobe-Korea1-UCS2.bcmap",
  "vendor/pdfjs/cmaps/B5-H.bcmap",
  "vendor/pdfjs/cmaps/B5-V.bcmap",
  "vendor/pdfjs/cmaps/B5pc-H.bcmap",
  "vendor/pdfjs/cmaps/B5pc-V.bcmap",
  "vendor/pdfjs/cmaps/CNS-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/CNS-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/CNS1-H.bcmap",
  "vendor/pdfjs/cmaps/CNS1-V.bcmap",
  "vendor/pdfjs/cmaps/CNS2-H.bcmap",
  "vendor/pdfjs/cmaps/CNS2-V.bcmap",
  "vendor/pdfjs/cmaps/ETHK-B5-H.bcmap",
  "vendor/pdfjs/cmaps/ETHK-B5-V.bcmap",
  "vendor/pdfjs/cmaps/ETen-B5-H.bcmap",
  "vendor/pdfjs/cmaps/ETen-B5-V.bcmap",
  "vendor/pdfjs/cmaps/ETenms-B5-H.bcmap",
  "vendor/pdfjs/cmaps/ETenms-B5-V.bcmap",
  "vendor/pdfjs/cmaps/EUC-H.bcmap",
  "vendor/pdfjs/cmaps/EUC-V.bcmap",
  "vendor/pdfjs/cmaps/Ext-H.bcmap",
  "vendor/pdfjs/cmaps/Ext-RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/Ext-RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/Ext-V.bcmap",
  "vendor/pdfjs/cmaps/GB-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/GB-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/GB-H.bcmap",
  "vendor/pdfjs/cmaps/GB-V.bcmap",
  "vendor/pdfjs/cmaps/GBK-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/GBK-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/GBK2K-H.bcmap",
  "vendor/pdfjs/cmaps/GBK2K-V.bcmap",
  "vendor/pdfjs/cmaps/GBKp-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/GBKp-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/GBT-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/GBT-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/GBT-H.bcmap",
  "vendor/pdfjs/cmaps/GBT-V.bcmap",
  "vendor/pdfjs/cmaps/GBTpc-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/GBTpc-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/GBpc-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/GBpc-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/H.bcmap",
  "vendor/pdfjs/cmaps/HKdla-B5-H.bcmap",
  "vendor/pdfjs/cmaps/HKdla-B5-V.bcmap",
  "vendor/pdfjs/cmaps/HKdlb-B5-H.bcmap",
  "vendor/pdfjs/cmaps/HKdlb-B5-V.bcmap",
  "vendor/pdfjs/cmaps/HKgccs-B5-H.bcmap",
  "vendor/pdfjs/cmaps/HKgccs-B5-V.bcmap",
  "vendor/pdfjs/cmaps/HKm314-B5-H.bcmap",
  "vendor/pdfjs/cmaps/HKm314-B5-V.bcmap",
  "vendor/pdfjs/cmaps/HKm471-B5-H.bcmap",
  "vendor/pdfjs/cmaps/HKm471-B5-V.bcmap",
  "vendor/pdfjs/cmaps/HKscs-B5-H.bcmap",
  "vendor/pdfjs/cmaps/HKscs-B5-V.bcmap",
  "vendor/pdfjs/cmaps/Hankaku.bcmap",
  "vendor/pdfjs/cmaps/Hiragana.bcmap",
  "vendor/pdfjs/cmaps/KSC-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/KSC-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/KSC-H.bcmap",
  "vendor/pdfjs/cmaps/KSC-Johab-H.bcmap",
  "vendor/pdfjs/cmaps/KSC-Johab-V.bcmap",
  "vendor/pdfjs/cmaps/KSC-V.bcmap",
  "vendor/pdfjs/cmaps/KSCms-UHC-H.bcmap",
  "vendor/pdfjs/cmaps/KSCms-UHC-HW-H.bcmap",
  "vendor/pdfjs/cmaps/KSCms-UHC-HW-V.bcmap",
  "vendor/pdfjs/cmaps/KSCms-UHC-V.bcmap",
  "vendor/pdfjs/cmaps/KSCpc-EUC-H.bcmap",
  "vendor/pdfjs/cmaps/KSCpc-EUC-V.bcmap",
  "vendor/pdfjs/cmaps/Katakana.bcmap",
  "vendor/pdfjs/cmaps/LICENSE",
  "vendor/pdfjs/cmaps/NWP-H.bcmap",
  "vendor/pdfjs/cmaps/NWP-V.bcmap",
  "vendor/pdfjs/cmaps/RKSJ-H.bcmap",
  "vendor/pdfjs/cmaps/RKSJ-V.bcmap",
  "vendor/pdfjs/cmaps/Roman.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UCS2-H.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UCS2-V.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UTF16-H.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UTF16-V.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UTF32-H.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UTF32-V.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UTF8-H.bcmap",
  "vendor/pdfjs/cmaps/UniCNS-UTF8-V.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UCS2-H.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UCS2-V.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UTF16-H.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UTF16-V.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UTF32-H.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UTF32-V.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UTF8-H.bcmap",
  "vendor/pdfjs/cmaps/UniGB-UTF8-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UCS2-HW-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UCS2-HW-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UCS2-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UTF16-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UTF16-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UTF32-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UTF32-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UTF8-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS-UTF8-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS2004-UTF16-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS2004-UTF16-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS2004-UTF32-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS2004-UTF32-V.bcmap",
  "vendor/pdfjs/cmaps/UniJIS2004-UTF8-H.bcmap",
  "vendor/pdfjs/cmaps/UniJIS2004-UTF8-V.bcmap",
  "vendor/pdfjs/cmaps/UniJISPro-UCS2-HW-V.bcmap",
  "vendor/pdfjs/cmaps/UniJISPro-UCS2-V.bcmap",
  "vendor/pdfjs/cmaps/UniJISPro-UTF8-V.bcmap",
  "vendor/pdfjs/cmaps/UniJISX0213-UTF32-H.bcmap",
  "vendor/pdfjs/cmaps/UniJISX0213-UTF32-V.bcmap",
  "vendor/pdfjs/cmaps/UniJISX02132004-UTF32-H.bcmap",
  "vendor/pdfjs/cmaps/UniJISX02132004-UTF32-V.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UCS2-H.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UCS2-V.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UTF16-H.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UTF16-V.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UTF32-H.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UTF32-V.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UTF8-H.bcmap",
  "vendor/pdfjs/cmaps/UniKS-UTF8-V.bcmap",
  "vendor/pdfjs/cmaps/V.bcmap",
  "vendor/pdfjs/cmaps/WP-Symbol.bcmap",
  "vendor/pdfjs/pdf.min.js",
  "vendor/pdfjs/pdf.worker.min.js",
  "vendor/pdfjs/standard_fonts/FoxitDingbats.pfb",
  "vendor/pdfjs/standard_fonts/FoxitFixed.pfb",
  "vendor/pdfjs/standard_fonts/FoxitFixedBold.pfb",
  "vendor/pdfjs/standard_fonts/FoxitFixedBoldItalic.pfb",
  "vendor/pdfjs/standard_fonts/FoxitFixedItalic.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSerif.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSerifBold.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSerifBoldItalic.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSerifItalic.pfb",
  "vendor/pdfjs/standard_fonts/FoxitSymbol.pfb",
  "vendor/pdfjs/standard_fonts/LICENSE_FOXIT",
  "vendor/pdfjs/standard_fonts/LICENSE_LIBERATION",
  "vendor/pdfjs/standard_fonts/LiberationSans-Bold.ttf",
  "vendor/pdfjs/standard_fonts/LiberationSans-BoldItalic.ttf",
  "vendor/pdfjs/standard_fonts/LiberationSans-Italic.ttf",
  "vendor/pdfjs/standard_fonts/LiberationSans-Regular.ttf"
];
// @@BUILD_END

const PREFIX = 'daihon-';
const CACHE = PREFIX + VERSION;
const SHELL = './';                       // 起動時に返す画面（index.html）
const CONCURRENCY = 8;

self.addEventListener('install', e => {
  // 全ファイルを新しいキャッシュに取り込む。1つでも失敗したらこの版は入れない（古い版で動き続ける）
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const queue = FILES.slice();
    const worker = async () => {
      for (let f; (f = queue.shift()) !== undefined;) {
        const res = await fetch(new Request(f, { cache: 'reload' }));   // HTTPキャッシュの古いファイルを避ける
        if (!res.ok) throw new Error(`${f}: ${res.status}`);
        // リダイレクトを経た応答をページ遷移に返すとSafariがエラーにするため、作り直して保存する
        await cache.put(f, res.redirected ? new Response(await res.blob(), { status: res.status, headers: res.headers }) : res);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith(PREFIX) && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// 新しい版への切り替えは、利用者が「更新」を押したときだけ行う
self.addEventListener('message', e => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

const scopePath = new URL('./', self.location).pathname;

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (req.mode === 'navigate' && (url.pathname === scopePath || url.pathname === scopePath + 'index.html')) {
      const hit = await cache.match(SHELL);
      if (hit) return hit;
    } else {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
    }
    return fetch(req);
  })());
});
