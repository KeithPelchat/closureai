// public/service-worker.js

// Simple, safe service worker that does NOT interfere with network requests.
// It exists only so browsers are happy for "Add to Home Screen" / PWA prompts.

self.addEventListener("install", (event) => {
  // Activate this version immediately
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  // Take control of all open clients (tabs) immediately
  event.waitUntil(self.clients.claim());
});

// Important: we listen to 'fetch' but DO NOT call event.respondWith.
// This means the browser handles all requests normally (including redirects).
self.addEventListener("fetch", (event) => {
  // Intentionally empty – pass-through
});
