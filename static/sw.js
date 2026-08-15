/* Strategy Lab Web Push service worker.
 * Must stay small and deterministic: Safari requires every received push to
 * become user-visible immediately or it may revoke the site's permission.
 */
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {
    data = { body: event.data ? event.data.text() : "Сработал ценовой алерт." };
  }
  const title = data.title || "Strategy Lab";
  const options = {
    body: data.body || "Сработал ценовой алерт.",
    tag: data.tag || "strategy-lab-alert",
    renotify: true,
    data: { url: data.url || "/", symbol: data.symbol || "" },
  };
  event.waitUntil((async () => {
    await self.registration.showNotification(title, options);
    if (self.registration.setAppBadge) {
      try { await self.registration.setAppBadge(); } catch (_) {}
    }
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (client.url.startsWith(self.location.origin)) {
        await client.focus();
        if ("navigate" in client) await client.navigate(target);
        return;
      }
    }
    if (clients.openWindow) await clients.openWindow(target);
  })());
});
