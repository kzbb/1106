'use strict';
/* 緊急用: Service Worker を取り除くための sw.js。
   配信した sw.js に重大な不具合があり、オフライン対応ごと取り消したいときだけ使う。
   このファイルを sw.js として配信すると、利用者の端末がオンラインで更新を確認したとき、
   保存済みのアプリ一式を削除してSWの登録を解除する。次回の起動からはサーバー上のファイルで動く。
   作業データ（IndexedDB）には触れない。fetch を処理しないので、切り替わった時点で通信はすべてサーバーへ行く。
   ここでページを再読み込みさせないこと: app.js が sw.js を登録し続けている間は再登録→解除→再読み込みの無限ループになる。
   完全に外すなら、app.js の setupSW() の呼び出しも消して配信すること。 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('daihon-')) await caches.delete(k);
    await self.registration.unregister();
  })());
});
