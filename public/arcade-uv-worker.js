importScripts("/uv/uv.bundle.js", "/arcade-uv-config.js", "/uv/uv.sw.js");

const ultraviolet = new UVServiceWorker();
self.addEventListener("fetch", event => {
    if (ultraviolet.route(event)) event.respondWith(ultraviolet.fetch(event));
});
