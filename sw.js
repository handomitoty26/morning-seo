// sw.js - 서현관아침점호v1 Service Worker
// 공통 서비스 워커(원본: ROSA scripts/dorm-pwa/sw-template.js, 고치려면 원본을 고쳐 적용기로 다시 만든다)
// 같은 주소(handomitoty26.github.io)의 기숙사 앱들은 캐시 저장소를 함께 쓴다 — 이 앱 캐시만 지우고, 지워졌으면 스스로 다시 채운다.
const CACHE_NAME = 'pwa-morning-seo-v3';
const ASSETS = [
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js'
];
// 이 앱 캐시 판정: 지금 이름이 아니고, 이 앱 접두어(새 이름·옛 이름 계열)로 시작하며 바로 뒤가 숫자
const OWN_PREFIXES = ['pwa-morning-seo-v', 'seohyeon-morning-v'];
function isOwnCache(key) {
  if (key === CACHE_NAME) return false;
  return OWN_PREFIXES.some(p => key.startsWith(p) && /^[0-9]/.test(key.slice(p.length)));
}
// 다시 채워도 되는 요청: 이 앱 범위 안 주소 또는 ASSETS의 정확한 주소, 인증·부분 요청 아님(드라이브 API·구글 로그인 등은 그대로 통과)
const ASSET_URLS = ASSETS.map(u => new URL(u, self.location.href).href);
function storable(req) {
  if (req.method !== 'GET' || req.headers.has('Authorization') || req.headers.has('Range')) return false;
  return req.url.startsWith(self.registration.scope) || ASSET_URLS.includes(req.url);
}

// 설치: 핵심 파일 캐싱(브라우저 HTTP 캐시를 거치지 않고 새로 받는다)
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
  );
  self.skipWaiting();
});

// 활성화: 이 앱의 옛 캐시만 삭제
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(isOwnCache).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

// 다른 출처 ASSETS(엑셀 라이브러리 CDN): <script> 태그 요청은 opaque 응답이라 저장할 수 없어 CORS로 받는다(실패하면 원래 요청 그대로)
function fromNetwork(req) {
  if (req.url.startsWith(self.location.origin + '/') || !ASSET_URLS.includes(req.url)) return fetch(req);
  return fetch(new Request(req.url, { mode: 'cors' })).catch(() => fetch(req));
}

// 패치: 다시 채워도 되는 요청만 이 앱 캐시 우선, 없으면 네트워크 — 받아 온 것은 저장이 끝난 뒤 돌려준다(캐시 실패는 무시)
// 그 밖의 요청(드라이브 API·구글 로그인·인증·부분 요청·다른 앱 경로)은 어느 캐시도 보지 않고 브라우저가 그대로 보낸다
self.addEventListener('fetch', event => {
  const req = event.request;
  if (!storable(req)) return;
  event.respondWith(
    caches.open(CACHE_NAME).then(cache => cache.match(req)).catch(() => undefined).then(cached => {
      if (cached) return cached;
      return fromNetwork(req).then(async res => {
        if (res.ok && (res.type === 'basic' || res.type === 'cors')) {
          const copy = res.clone();
          try {
            const cache = await caches.open(CACHE_NAME);
            await cache.put(req, copy);
          } catch (e) {}
        }
        return res;
      }).catch(() => {
        if (req.destination === 'document') {
          return caches.open(CACHE_NAME).then(cache => cache.match('./index.html'));
        }
      });
    })
  );
});
