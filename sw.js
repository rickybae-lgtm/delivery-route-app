// 아주 단순한 서비스워커. 딱히 오프라인 캐싱은 안 하고(경로 계산은 어차피 인터넷이
// 있어야 되는 기능이라 캐싱해봤자 의미가 없음), 크롬이 "이 사이트는 설치 가능한 앱"으로
// 인정하는 데 필요한 최소 조건(서비스워커 등록 + fetch 이벤트 처리)만 채워주는 용도.
self.addEventListener('install', function(event){
  self.skipWaiting();
});

self.addEventListener('activate', function(event){
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function(event){
  // 그냥 평소처럼 인터넷에서 그대로 받아옴(캐시 사용 안 함).
  event.respondWith(fetch(event.request));
});
