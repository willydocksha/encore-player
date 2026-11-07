// keeps the app itself available offline (network first, cached copy as fallback).
// drive audio is cached separately by the page in 'encore-audio-v1', the encore app serves breakdown itself.
const SHELL = 'encore-shell-v22';
const FILES = ['/', '/app/styles.css', '/app/core.js', '/app/playlist.js', '/app/bass.js', '/app/score.js', '/app/getapp.js', '/app/aimode.js', '/app/sync.js', '/app/config.js', '/app/tour.js', '/app/ear.js', '/app/tuner.js', '/app/spectrum.js', '/app/main.js', '/app/uiupdate.js', '/app/appupdate.js', '/app/pitch.js', '/app/pitch-worklet.js',
  '/manifest.webmanifest', '/icon-180.png', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    // also frees the ai models the old in-browser breakdown cached (~240 mb)
    .then(keys => Promise.all(keys.filter(k => (k.startsWith('encore-shell-') && k !== SHELL) || k.startsWith('encore-models-')).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || /^\/(drive|title|api|models)\b/.test(url.pathname)) return;
  const key = e.request.mode === 'navigate' ? '/' : e.request;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(key, copy)); }
      return res;
    }).catch(() => caches.match(key, { ignoreSearch: true }).then(r => r || caches.match('/')))
  );
});
