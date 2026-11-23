"use strict";

const cacheName = "jarvis-tasks-shell-v6";
const files = ["./", "./index.html", "./style.css", "./app.js", "./manifest.webmanifest", "./icon.png"];
const assetUrls = new Set(files.map(path => new URL(path, self.registration.scope).href));

self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(files.map(path => new Request(
    new URL(path, self.registration.scope), {cache: "reload"})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith("jarvis-tasks-shell-") && key !== cacheName)
    .map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  const home = event.request.mode === "navigate" && url.origin === scope.origin && url.pathname === scope.pathname;
  const key = home ? scope.href : url.href;
  if (!assetUrls.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    try {
      const response = await fetch(event.request, {cache: "reload"});
      if (response.ok && !response.redirected) {
        await cache.put(key, response.clone()).catch(() => {});
        return response;
      }
      return await cache.match(key) || response;
    } catch {
      return await cache.match(key) || Response.error();
    }
  })());
});

self.addEventListener("push", event => {
  let data;
  try { data = event.data?.json(); }
  catch { data = null; }
  const body = data?.test ? "Пробное уведомление Джарвиса."
    : data?.count > 1 ? `Новые напоминания: ${data.count}. Открой задачник, чтобы посмотреть.`
    : "Новое напоминание. Открой задачник, чтобы посмотреть.";
  event.waitUntil(self.registration.showNotification("Джарвис", {
    body, icon: new URL("icon.png", self.registration.scope).href,
    tag: data?.test ? "jarvis-test" : "jarvis-reminders"
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({type: "window", includeUncontrolled: true});
    const app = windows.find(client => client.url.startsWith(self.registration.scope));
    if (app) {
      app.postMessage("open-notices");
      await app.focus();
    } else {
      await self.clients.openWindow(new URL("?view=notices", self.registration.scope).href);
    }
  })());
});
