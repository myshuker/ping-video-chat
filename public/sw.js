/* Ping service worker: shows a notification even when the app is closed */
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* no payload */ }
  const title = data.title || 'Ping';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.callId || 'ping',
      renotify: true,
      data: { callId: data.callId, type: data.type },
    }),
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const d = event.notification.data || {};
  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => {
        for (const c of list) {
          c.focus();
          return;
        }
        return clients.openWindow('/');
      }),
  );
});
