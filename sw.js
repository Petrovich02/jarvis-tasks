"use strict";

const cacheName = "jarvis-tasks-shell-v2";
const files = ["./", "./index.html", "./style.css", "./app.js", "./manifest.webmanifest", "./icon.png"];
const assetUrls = new Set(files.map(path => new URL(path, self.registration.scope).href));

self.addEventListener("install", event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(files)));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys
    .filter(key => key.startsWith("jarvis-tasks-shell-") && key !== cacheName)
    .map(key => caches.delete(key)))));
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET" || !assetUrls.has(event.request.url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    try {
      const response = await fetch(event.request);
      if (response.ok && !response.redirected) {
        await cache.put(event.request, response.clone()).catch(() => {});
        return response;
      }
      return await cache.match(event.request) || response;
    } catch {
      return await cache.match(event.request) || Response.error();
    }
  })());
});
