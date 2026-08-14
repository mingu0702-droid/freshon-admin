# 운영지도 Phase 2 실행 계획

## 순서
1. Hub에 v1 계약과 Customer 어댑터를 구현하고 계약 테스트를 고정한다.
2. 운영지도에 `MAP_DATA_SOURCE=embedded|shadow|hub` 기능 플래그를 추가한다.
3. `shadow`에서 기존 결과를 화면에 사용하고 Hub 결과는 비교 로그만 남긴다.
4. 최소 2주간 날짜·센터·권역·bounds별 고객 수, 좌표, 호차, 기사, 최신일을 비교한다.
5. 승인 기준 통과 후 `hub`로 전환하되 vehicle-data/customer-master/new-area-data는 즉시 삭제하지 않는다.
6. 안정화 기간 후 정적 내장 데이터 제거를 별도 배포한다.

## 전환 승인 기준
- 고객 수 100% 일치, 최신 데이터 기준일 100% 일치.
- 좌표 보유율 99.5% 이상 또는 기존 기준 이상이며 중요 고객 누락 0건.
- 호차 불일치 0.1% 이하, 고정기사 불일치 0건.
- Customer 장애, Hub 장애, stale 캐시, 빈 캐시 503 시나리오 검증 완료.
- 전체권역/호차/검색/신규권역/카드/WMS/운영데이터 회귀 PASS 및 원복 리허설 완료.

## 관측·원복
- Hub는 요청 수, p50/p95, cache hit, stale 반환, Customer 오류, 결과 건수를 기록한다.
- 운영지도는 schemaVersion/dataAsOf/stale을 표시하고 직접 Customer 호출을 차단한다.
- 이상 시 기능 플래그를 `embedded`로 즉시 되돌린다. 내장 파일 제거는 2주 검증과 원복 승인 후에만 수행한다.
