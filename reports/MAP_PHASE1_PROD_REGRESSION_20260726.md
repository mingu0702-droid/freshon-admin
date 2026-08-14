# 운영지도 Phase 1 실환경 회귀 결과

| 항목 | 결과 | 실환경 확인 |
|---|---|---|
| Render Build/Deploy | PASS | 커밋 `a87377c` Live |
| Health/API | PASS | health 200, runtime-metrics 200 |
| 카카오 지도 | PASS | 지도 타일과 축척 표시 |
| 전체권역 ON/OFF | PASS | ON 권역선 표시, OFF 광역 호차 라벨 제거 |
| 날짜+호차 동선 | PASS | 2026-06-11 / 110호 / 20착 표시 |
| 고객코드 검색 | PASS | `S222538`, 221호 및 주소 표시 |
| 일반주소 검색 | PASS | 세종대로 110, 171호, 반경 500m 7곳 |
| 신규권역 판단 | PASS | 1건 판단, O 1건, 가까운 배송처 표시 |
| 핀/카드 | PASS | 선택 핀과 상세 카드 표시 |
| WMS | PASS | WMS, 지도, 업로드 영역 표시 |
| 운영데이터 | PASS | 44,370행, 매출 8,599,126,624원 표시 |
| Playwright Queue | PASS | active 0, queued 0, limit 1 |
| OOM/Memory leak | PASS | 최종 배포 후 OOM 0, 지속 증가 없음 |

## 판정
- Customer 변경 0건, Hub 변경 0건, 운영 데이터 변경 0건입니다.
- 실환경 관찰 48시간 이상과 필수 회귀를 통과하여 **Phase 1 Completed**로 판정합니다.
