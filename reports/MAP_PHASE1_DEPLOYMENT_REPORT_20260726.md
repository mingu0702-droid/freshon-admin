# 운영지도 Phase 1 배포 보고서

## 배포 결과
- 서비스: `https://freshon-admin-1.onrender.com`
- Render 서비스 ID: `srv-d87gc5rtqb8s7398t37g`
- 최종 배포 커밋: `a87377c`
- 최종 배포 ID: `dep-d9h9idcm0tmc738dr09g`
- 최종 배포 시각: 2026-07-24 07:44:05 KST
- 2026-07-26 실측: `/api/health` 200, `/api/runtime-metrics` 200, `/daily-routes.html` 200
- 최종 배포 이후 Render 이벤트 기준 OOM 0건, 장애 재시작 0건

## 변경 파일
- `package.json`, `package-lock.json`: gzip 압축 의존성 추가
- `src/runtimeMetrics.js`: RSS, V8 heap space, GC, event-loop, 요청 백분위 계측
- `src/server.js`: 계측 API, 압축, 로컬 캐시 우선, Playwright 동시 실행 제한
- `src/store.js`: 대형 JSON 파싱 결과 캐시 및 동시 읽기 공유
- `public/daily-routes.html`: 중복 내장 데이터 제거, 로딩/검색/빈 결과 UI 개선

## 배포 제외 및 삭제
- 과거 `daily-routes` 백업 11개와 루트 검사 산출물 3개를 배포 컨텍스트에서 제외했습니다.
- 실제 영구 삭제 파일: 0개
- 제외 파일 원본: `C:\Users\SFN\Desktop\코덱스\archive\freshon-phase1-20260724-excluded`
- SHA-256 목록: `outputs/MAP_PHASE1_EXCLUDED_SHA256_20260724.csv`

## 백업 및 원복
- 수정 전 전체 백업: `C:\Users\SFN\Desktop\코덱스\freshon-phase1-before-20260724.zip`
- 백업 SHA-256: `547E5AC034CAD57F013BF95AD1D5935DB1DFAE4D53EE6B2C852A298213CE72CF`
- 원복: Render에서 직전 정상 배포로 Rollback하거나 백업 ZIP을 GitHub에 전체 업로드 후 재배포합니다.

## 데이터 변경
- Customer 변경: 0건
- Hub 변경: 0건
- 운영 데이터 변경: 0건
- 배포 상태: 완료
