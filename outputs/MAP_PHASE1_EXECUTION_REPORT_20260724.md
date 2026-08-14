# 운영지도 경량화 Phase 1 실행 보고

## 범위·백업
- 수정 프로젝트: `freshon-admin-main`만. Customer 변경 0건, Hub 변경 0건, 운영 데이터 레코드 변경 0건.
- 변경 전 전체 ZIP: `C:\Users\SFN\Desktop\코덱스\freshon-phase1-before-20260724.zip`
- ZIP SHA-256: `547E5AC034CAD57F013BF95AD1D5935DB1DFAE4D53EE6B2C852A298213CE72CF`
- 제외 파일 14개는 삭제하지 않고 `C:\Users\SFN\Desktop\코덱스\archive\freshon-phase1-20260724-excluded`로 이동했다. 실제 영구 삭제 0개이며 해시는 `MAP_PHASE1_EXCLUDED_SHA256_20260724.csv`에 기록했다.

## 실제 변경
- `public/daily-routes.html`: `EMBEDDED_DATA` 중복 본문 제거, `vehicle-data.js`를 단일 소스로 유지. 두 원본은 정규화 SHA-256 `130621e1cb3488377360f4df6379086689fd6d9b2e3bedc489085ce6b27e5182`로 동일(155호차/8183고객).
- `src/scraper/browserGate.js`, `freshonDailyRoute.js`, `freshonFixedDispatch.js`: Playwright fallback 작업만 FIFO 1개로 제한, 일반 API 요청은 차단하지 않음.
- `src/store.js`: 1MiB 이상 JSON 직렬화의 bytes/duration/RSS/heap 전후를 `[memory-metric]`으로 기록.
- `Dockerfile`, `render.yaml`: Node heap 1536MB→320MB. Render 512MB에서 Node 외 네이티브/브라우저용 약 192MB를 남기며 로컬 320MB 기동을 검증했다.
- `.dockerignore`: 11개 public 백업 패턴과 3개 루트 검사 산출물을 배포 제외.
- 기존 회귀 수정: 전체권역 전환 시 101 선택 상태 초기화, WMS 탭의 존재하지 않는 `renderWmsResults()` 호출 제거.

## 크기·성능
| 항목 | 변경 전 | 변경 후 | 차이 |
|---|---:|---:|---:|
| 배포 컨텍스트 | 121,168,940 B | 30,602,550 B | -74.75% |
| public | 101,991,873 B | 30,167,577 B | -70.42% |
| daily-routes.html | 6,223,609 B | 2,786,492 B | -55.22% |
| HTML+vehicle-data 최초 전송 | 9,661,131 B | 6,224,014 B | -35.58% |
| 서버 RSS | 140,800,000 B | 75,526,144 B | -46.36% |
- 로컬 320MB heap에서 OOM 없음. HTML 3회 응답은 3,996/1,734/1,629ms였으며 환경 변동이 커 크기 감소를 주 지표로 사용한다.

## 회귀 테스트
| 항목 | 결과 | 확인 내용 |
|---|---|---|
| 카카오 지도 | PASS | localhost 등록 도메인에서 지도 로드 |
| 전체권역 ON/OFF | PASS | 버튼 상태 전환 및 OFF 복귀 |
| 101 자동선택/초기화 | PASS | Enter 선택 후 전체권역에서 입력/선택값 공란 |
| 고객코드 검색 | PASS | S222538 카드 및 주변 12곳 |
| 일반주소 검색 | PASS | 서울 중구 세종대로 110 신규핀/주변 7곳 |
| 신규권역 | PASS | 판단 결과와 인근호차 표시 |
| 핀/카드 | PASS | 검색 결과 카드 표시 |
| WMS | PASS | 화면·지도 로드, JS 오류 수정 |
| 운영데이터 | PASS(데이터 0건) | 화면 로드, 현재 로컬 데이터 원본은 빈 결과 |
| 날짜+호차 동선 | PASS(데이터 없음) | 조회 API 경로 정상, 선택 조건 실제 동선 없음 표시 |
| 서버/API | PASS | health 200, 브라우저 인증 경로 조회 동작 |

## 배포·원복
- 배포: 미실행. 검증 전 배포 금지 요구를 준수했다. Render 512MB OOM 여부는 배포 후 관측 항목이다.
- 검증 완료 업로드 ZIP: `C:\Users\SFN\Desktop\코덱스\freshon-github-upload-20260724-phase1.zip` (최종 외부 체크섬으로 검증).
- 원복: 서비스를 중지하고 변경 후 프로젝트를 보관한 뒤 `freshon-phase1-before-20260724.zip`을 프로젝트 위치에 풀어 덮어쓴다. 필요 시 archive 14개를 원래 상대 경로로 복사하고 기존 Render 환경값/배포 버전을 재배포한다.
