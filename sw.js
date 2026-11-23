const SHELL_PREFIX = 'quiet-shell-';
const SHELL_CACHE = SHELL_PREFIX + '4fab9f0e85d42263';
const SHELL = [["/","sha256-op7gRnP0kGf/lT+IvdXUTWTvmawVd0M5uNLokEZfTrg="],["/address-search.js","sha256-T0uGAoUtNrxV4NH2BZMkR/BSF0m6iJD4dF92gMenHYY="],["/app.css","sha256-KnYHj7Dgg1y9bbxL+0sU36CgaHFsZFbLELiWTVlwwCM="],["/archive-protection.js","sha256-3H7Qge2PNXIE/5GhUXj9W5Bea9jV4rFxCeagLgGFSjY="],["/calculator.js","sha256-yowsyzzq4TTZ0ppbuZmhblwYeyoYxjDKnIaoQo9TYPE="],["/data/contours.json","sha256-xQbNsgH7ZF7TgFMCu0pzNw5kXA8cPBL0k7F8i81JbCc="],["/data/detail.json","sha256-5pA8QJ/GJi2PHEc2k0bqqy1HBakiHlI6Pw/4Tfo1lI0="],["/data/field-geography.json","sha256-ipyYMBSIgvmliT3865tgyHXckHsX2LHWhCFUqSe+QFM="],["/data/field-ways.json","sha256-eysxUuLj8wqMrRVxqrpKAToTVKDWyzGA6Sqc6Yniam0="],["/data/forest.json","sha256-BmJfP0e8pNy71fdhevnOstOvwSkYGeKTSxAhBmH6v0g="],["/data/murmansk.json","sha256-wrhHLcn0cE8nLPgLNn3nTS4cWGjuu+lZ3XHDRPZtzhE="],["/data/navigation.json","sha256-BQvxKOCvgaXdk0o2AuK5rJS9huY4q+SgcrxnukBdPsQ="],["/data/preview.pmtiles","sha256-hz2tSzPuFSS9D9J8mFH4uAsfQy2MN3Y90R8UCbzhJ2c="],["/data/satellite.json","sha256-HO9hOnBQX/gCp6KY9lTwjokMaJqH51fycSMQbBsDq2M="],["/data/terrain.json","sha256-jhYa6yz0HHCTX9bn8eKTom31UPajviObcnpM9j57csc="],["/data/walking.json","sha256-jV5u6dxtLbqCqcoOdc6hZSX95UJCcuwtB+4cMaC+L9E="],["/field-db.js","sha256-/EBNU4q0Qp8BHlMlchrH6+hWyQ8kf3BqIabUeXZPyQE="],["/field-journal-data.js","sha256-S6NaOU7u2icwfNBtyM1fu7C5pFu2d07YSjUTE73rpns="],["/field-journal.css","sha256-H4AuBWMKWktvpO2+zL9lEcQZPPBz04a8bhNJKgAWFJQ="],["/field-panel.js","sha256-ALLudz7ffQdP3WKttjPfsJ0yLrzFlyrMcGh8u7JWXnw="],["/field-safety.css","sha256-qrMsm0uzS87/jtK5nQ6wVaCZEZ9PEAhv0/wRy2PfMW8="],["/field-safety.js","sha256-c1vdUqvbaXexld2F1/CGM748R9wthdEbcsL5rGbRCWk="],["/field-security.js","sha256-IZFA8mFYfZV5l8zKtu94SvznEvm6oUJRd9uQME/FEqQ="],["/forestry-core.js","sha256-ihvJHp0E8lo6KE+MU3+eqRydFdVwcjH3uEDcgkjnGro="],["/forestry-store.js","sha256-v/gDbFUFIX6i/cxWYIXecySgUn73Yj8E1CSs84Hpm00="],["/forestry-tools.css","sha256-XdXcuOXglfO7ZDDmLEfkHszGfZNjn0XkqjK/cX/sQuA="],["/forestry-tools.js","sha256-8udaZATmBXiloibJIGkL5C4+xlN4oLmKB/FsQ7ps34s="],["/icons/app-180.png","sha256-CVEDUGQC8c5iIJU4jPR+F3CXGmxIRvGAI3qNyoXrGFs="],["/icons/app-192.png","sha256-N+Cl/rpaZhdu+YJPxPUlKRv6vhjKc58OU+Cn38duoCM="],["/icons/app-512.png","sha256-bYmyNC1OPSw5+uM+4bfndbmJ4X1aOrBEbX7MYYw5YzQ="],["/icons/calculator-192.png","sha256-RuPNULaqvz3TFZzGyNmnj61y39ez2KM8EK2uQOis+/A="],["/icons/calculator-512.png","sha256-7j2Eq5UCT90aYTYJN81CjfHVIvTnosyQAj6+5Nj5deg="],["/layer-panel.js","sha256-qL+SV/JCgkIKgdfUyxm+OdO80jynCjVqg897Q4uSIk4="],["/manifest.webmanifest","sha256-ktjELQL1VSbzRxFq6WC5mcxNUOxWLabFuYmnyyKqXRs="],["/map-engine.js","sha256-z8A7ZGUDYOJpnmU1N7XRj+q1K9bjG93xMnbfe/HbiJM="],["/map-layers-style.js","sha256-jQwg6oodWch+MXXLCcu0y2rWAsc0eoIq3mqGpABV31U="],["/map-style.js","sha256-jmRYuk6Nlnt6OSsdHJyIH2hnlIGmEd2DIkUN4AucgoE="],["/mobile-maps.css","sha256-zBAh+Ztu8RB8mE8LXNJApHyq5P5eZzWN6b1dgqv4D3Q="],["/navigation-client.js","sha256-+nJfv0o9puGn59j69ukA4sN7BN4KUimINguQI+MPmus="],["/navigation-ui.js","sha256-pGTAivHDiCZcDsz8O3GICrR8CV39b39B52CJVcVpcB4="],["/navigation-worker.js","sha256-1wCYA1Qxm8/qvK9wotJexuMFS5+eSPC3lDxBeIHXukU="],["/position-data.js","sha256-dHa3sS6sCWOgzsmiSeLn7UepbQPVi8movkGtlUMordk="],["/privacy-lock.css","sha256-5kkRF2btxD7SXnBH1P0Ur89YsPLzBOIZ2ST8X6NFxdM="],["/privacy-lock.js","sha256-4Qn7UESoEqZF4BHgATRXGSu2NcHhzFpKb5sBbNlZbyY="],["/readiness-state.js","sha256-KGLG4J9S74wzvNYYFrPcxTNU6JKDc9kQGd7UdUfXcrY="],["/region-app.js","sha256-CEhcgoD3OEYTfgR0+k2TbPG4ezGj+r7z2YYjmlzO1Do="],["/region-storage.js","sha256-HC51FfFV433Th2XSWAcYLgP9LlDu3d4a5k6KzRtRhlQ="],["/routing-engine.js","sha256-OfNVuQkJAn/5GUkSQ+mU1LrrC18wTYsUA12chRcRfhY="],["/track-geometry.js","sha256-hhynzYM5v0IangMHFQxihymMru5AHCA917aUB5v28D4="],["/track-map.js","sha256-wEg+UGUW/N2eg9RhHbthAQjG5sq6VMLrRLmMX4gIDFk="],["/track-panel.js","sha256-Y2Cm/PFSnczIOyduUYxIJugkSLI5L2ksMONpqdKki1c="],["/track-store.js","sha256-AQk5AKqyLZPgdM858Xf3LblrsGMc0orGWmaU3raE8Uk="],["/vault-crypto.js","sha256-VGKI17yDyza5Oxk2Gjy9x4ZBKbHyOY5IYgcw+gLOpKM="],["/vault-store.js","sha256-0BsFqESNqiEJN2WlozJiwbO5haPJG5v6AsWzMSduN5Q="],["/vault.css","sha256-/dhxU86Sx5qtTvSpTkYCEpxF7gFdZWzGTyA4c+TilPY="],["/vault.js","sha256-BjbJKn4oN40kkAnUU+a3WXEBEWJk0qHzQ1SxLfrmQWU="],["/vault/","sha256-2jpUwOa/FKeRTtcZmNiY+JOctwl44St798zHm0t62T8="],["/vendor/maplibre-gl-shared.mjs","sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="],["/vendor/maplibre-gl-worker.mjs","sha256-gGknlVCC4NW1yXDM7yt8BZ9/lVOXq3ghKNYzNJDDTKo="],["/vendor/maplibre-gl.css","sha256-qQeYoZUwF3kOWQ9+G9Nf8QOopCY5cstHKQt4rfhvjCA="],["/vendor/maplibre-gl.mjs","sha256-wyVdSrTQ4eGC09uJVU1bBxCMpjkxEmvu64+hPFVZ+B4="],["/vendor/pmtiles.js","sha256-zbdLANOU2Y00tJ6A3kLEC0QzBRuyTeSpY7WN5BSqWPc="]];
const PATHS = new Set(SHELL.map(([path]) => path));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    try {
      // Limit simultaneous responses and distinguish real assets from sign-in pages.
      for (let index = 0; index < SHELL.length; index += 4) {
        await Promise.all(SHELL.slice(index, index + 4).map(async ([path, integrity]) => {
          const response = await fetch(path, {cache:'reload', redirect:'error', integrity});
          if (!response.ok) {
            throw new Error('Could not cache application asset: ' + path);
          }
          await cache.put(path, response);
        }));
      }
    } catch (error) {
      await caches.delete(SHELL_CACHE);
      throw error;
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const oldCaches = (await caches.keys()).filter(name => name.startsWith(SHELL_PREFIX) && name !== SHELL_CACHE);
    await Promise.all(oldCaches.map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const path = url.pathname === '/index.html' ? '/' :
    ['/vault', '/vault.html', '/vault/index.html'].includes(url.pathname) ? '/vault/' : url.pathname;
  if (!PATHS.has(path)) return;
  event.respondWith((async () => {
    const saved = await (await caches.open(SHELL_CACHE)).match(path);
    if (saved) return saved;
    if (path.startsWith('/vault')) {
      return new Response('Файлы фотосейфа отсутствуют. Открой карты с интернетом, чтобы восстановить приложение.', {
        status:503,headers:{'Content-Type':'text/plain; charset=utf-8'},
      });
    }
    return fetch(event.request);
  })());
});
