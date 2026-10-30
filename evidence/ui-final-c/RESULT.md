# UI 검증 인계

- 기준: d05930c014b8a5634181876f7ab80f80b2fd02db. C UI 변경은 map-phase2b-runtime.js 1개 파일이며 C_MINIMAL.diff에 포함됩니다.
- 실제 Stage: 로그인 후 101호 선택 시 매장 24개, 좌표가 있는 핀 20개. 122호 25개, 202호 28개 목록과 전체 복귀를 확인했습니다. 좌표 미확인 항목에 임의 좌표를 넣지 않았습니다.
- 실제 Stage: 고객코드 검색 결과와 매장 상세 선택, 2026-10-23 일자별 운행의 2,038 방문 표시를 확인했습니다. 실제 Stage 화면은 공개 저장소에 올리지 않았습니다.
- 미검증: 확대·축소와 드래그 반복, 인쇄·Excel, 화면 크기별 실지도 클릭, 전체 기능 3회 반복 및 네트워크 중복 검사. 브라우저 응답 지연으로 완료하지 못했습니다.
- final-1920.jpg 및 final-390.jpg는 모의 지도·모의 매장 자료를 이용한 로컬 화면이며 실지도 검증이 아닙니다. 나머지 크기 캡처는 로컬에 보관합니다.
- 이전 문자열 검사는 메모리 전용 인증을 고정적으로 기대했으나 현재는 설정된 영속 저장소를 사용할 수 있습니다. 메모리 모드 응답을 실제 동작으로 검사하고 기존 영속 저장소 보안 시험을 유지했습니다.
- node --test tests/r6/vehicle-presentation.test.mjs tests/r6/session-lifecycle.test.mjs tests/r6/durable-session.test.mjs tests/r6/async-auth-response-gate.test.mjs tests/coordinate-address-policy.test.mjs: 14 PASS, 0 FAIL, 2 SKIP.
- B 로컬 work/opsmap-final-hub-route-b와 git merge-tree 충돌은 없었습니다. 서로 다른 기준 커밋을 사용하므로 실제 통합 시 A 수동 핀 변경 보존과 B 경로 코드 유지 여부를 다시 확인해야 합니다.
