/* Service worker электронного дневника: показывает push-уведомления.
   Сервер шлёт пустой push; текст уведомления забираем у нашего сервера. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  event.waitUntil((async () => {
    let item = null;
    try {
      const sub = await self.registration.pushManager.getSubscription();
      if (sub) {
        const r = await fetch('/api/push/pending', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: sub.endpoint }), cache: 'no-store'
        });
        if (r.ok) item = (await r.json()).item || null;
      }
    } catch (e) { /* нет сети — покажем общее уведомление */ }
    // Браузеры требуют показать уведомление на каждый push, даже если очередь пуста.
    await self.registration.showNotification(item ? item.title : 'Электронный дневник', {
      body: item ? item.body : 'Есть обновления — откройте дневник.',
      tag: item ? item.id : undefined,
      icon: '/icon-192.png', badge: '/icon-192.png',
      data: { url: (item && item.url) || '/diary.html' }
    });
  })());
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/diary.html';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).pathname === url && 'focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});
