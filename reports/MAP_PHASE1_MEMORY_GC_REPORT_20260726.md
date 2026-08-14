# 운영지도 Phase 1 메모리·GC 보고서

## 원인과 조치
- OOM 원인은 41.47MB 고정배차 JSON과 17.81MB 월 요약 JSON을 같은 요청에서 중복 파싱·직렬화한 것이었습니다.
- `store.js`에 파일 mtime 기반 파싱 캐시와 동시 읽기 공유를 적용했습니다.
- 월 요약은 로컬 캐시를 우선 사용하고 응답은 gzip 압축합니다.
- Playwright는 FIFO 1개로 제한해 active browser와 context가 동시에 늘지 않게 했습니다.
- Node heap 제한은 Render 512MB에서 브라우저/native 여유를 남기도록 약 320MB로 유지했습니다.

## 최종 실환경 계측
- 측정 시각: 2026-07-26 21:23:34 KST
- RSS: 292,990,976 B
- Heap Used / Total: 61,769,048 / 63,524,864 B
- Heap limit: 338,690,048 B
- Old Space: 44,886,640 B
- Young Space: 280,192 B
- External: 7,944,958 B
- GC: 434회, 누적 3,231.80ms
- Minor / Major / Incremental: 358 / 38 / 38회
- Event-loop P95 / P99: 20.27 / 21.81ms
- Playwright active / queue: 0 / 0, limit 1

## 안정성
- 최종 배포 후 48시간 이상 Render 이벤트를 확인했고 OOM 0건, 장애 재시작 0건입니다.
- 회귀 부하 직후 RSS 281.51MB, 30초 후 281.64MB였고 heap은 68.93MB에서 68.68MB로 감소해 지속 증가가 없었습니다.
- 프로덕션 heap snapshot은 512MB 환경에서 snapshot 생성 자체가 OOM을 유발할 수 있어 실행하지 않았고 V8 space·GC·시간축 계측으로 대체했습니다.
- 측정 원본: `phase1-runtime-post-regression-20260724.json`, `phase1-runtime-idle30-20260724.json`, `phase1-runtime-final-20260726.json`
