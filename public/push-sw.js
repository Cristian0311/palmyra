/* Push handlers imported by the existing Workbox-generated service worker.
   Keep this file small and dependency-free so offline caching remains managed by Workbox. */
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch { payload = { title: 'PALMYRA tiene un aviso', body: event.data ? event.data.text() : 'Abre PALMYRA para ver los detalles.' }; }
  const title = payload.title || 'PALMYRA · ¡Ey, jefe!';
  const options = {
    body: payload.body || 'Hay novedades esperándote. Entra a PALMYRA y échales un ojo. 😂',
    icon: '/pwa-192.svg',
    badge: '/pwa-192.svg',
    tag: payload.tag || payload.notification_id || 'palmyra-notification',
    renotify: Boolean(payload.renotify),
    data: { url: payload.url || '/notifications', notification_id: payload.notification_id || null },
    timestamp: payload.timestamp || Date.now(),
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/notifications', self.location.origin).href;
  event.waitUntil((async () => {
    const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clientsList) {
      if (client.url.startsWith(self.location.origin) && 'focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
