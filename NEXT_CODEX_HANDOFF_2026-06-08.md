# Freshon Admin 인수인계 메모 - 2026-06-08

## 프로젝트 위치

작업 폴더:

`C:\Users\SFN\Documents\Codex\2026-05-21\new-chat-2\freshon-admin-package\extract\freshon-admin-main`

Render 서비스:

`freshon-admin-1.onrender.com`

사용자는 이 프로젝트에서 운영지도, WMS 배차 검토, 일일동선, 모바일 데일리 상차 리포트를 같이 발전시키고 있다. 현재 사용자는 기존 UI가 답답하고 비슷한 틀에 갇혀 있다고 느끼고 있으니, 다음 Codex는 UI를 새로 설계할 때 기존 레이아웃을 그대로 답습하지 말고 먼저 시안을 보여주는 방식이 좋다.

## 절대 지우면 안 되는 모바일 검색 API

사용자가 별도로 강조한 보호 대상이다. 새 버전으로 작업하더라도 GitHub main/Render 배포 기준으로 유지해야 한다.

서버 파일:

`src/server.js`

유지해야 하는 이름:

- `vehicleAreaSourceUrl`
- `normalizeSearchValue`
- `customerSearchScore`
- `pushCustomerSearchItem`
- `buildCustomerSearchItems`
- `app.get("/api/mobile/customer-search", ...)`

API:

`GET /api/mobile/customer-search?q=매장명`

용도:

전표 OCR로 읽은 매장명으로 고객을 검색해서 모바일 리포트 앱에 고객코드, 매장명, 호차/노선, 착순을 넘기는 용도다.

중요한 검색 우선순위:

1. `public/customer-master-20260604.json` 고객 마스터를 먼저 검색
2. 운영지도 `vehicle-data.js`는 보조
3. 저장된 고정배차 캐시도 보조

운영지도 API 의존은 기본 흐름에서 빼거나 보조로만 둔다.

## 모바일 데일리 상차 리포트 산출물

아래 파일들은 이미 freshon-admin 프로젝트에 반영해뒀다. 삭제하지 말 것.

- `public/mobile-report-prototype.html`
- `public/customer-master-20260604.json`
- `public/mockups/`
- `customer-data-sync-plan.md`
- `report-history-storage-plan.md`
- `public/mobile-report-manifest.json`
- `public/mobile-report-sw.js`
- `MOBILE_REPORT_NOTES.md`

관리자 페이지에 진입 링크도 추가되어 있다.

- `public/admin.html`
- 링크: `/mobile-report-prototype.html`

참고 이미지:

`public/mockups/daily-report-app-flow.png`

이 이미지는 최종 UI 방향 참고용이다. 단, 사용자는 “시안이 기대보다 너무 안 바뀐다”고 여러 번 말했으니 이 이미지를 그대로 베끼기보다, 기능 흐름을 유지하면서 더 실무적인 모바일 앱 UI로 다시 짜는 것이 좋다.

## 모바일 리포트 기능 목표

사용자가 원하는 최종 흐름:

1. 전표 사진 촬영
2. OCR로 매장명 추출
3. 고객 마스터에서 고객 검색
4. S 고객코드, 매장명, 호차/착순 확인
5. 적재함 사진 정리
6. 전표 + 미상차 사진을 한 세트로 저장
7. 카톡 복사용 문구 생성
8. 전체 기록은 별도 페이지에서 검색

사진 저장 규칙:

- 적재함 사진은 호차당 1장
- 전표와 미상차 사진은 한 세트
- 미상차 사진은 여러 장 가능
- 전체 사용자 기록 저장을 위해 추후 서버 DB와 사진 저장소가 필요함

현재 프로토타입은 localStorage 기반이다. 실사용을 위해서는 서버 저장 API와 이미지 저장소가 필요하다.

## 최근 수정한 검색 관련 사항

사용자가 `고객사정보현황_20260604.xlsx`를 저장했는데 주소/고객코드 검색이 제대로 안 된다고 했다. 원인은 운영지도 화면의 고객 검색이 좌표 있는 고객만 검색 대상으로 삼았기 때문이다.

수정 내용:

- `GET /api/fixed-dispatch/customer-search?q=...` 추가
- `public/daily-routes.html` 검색창에서 기존 지도 데이터 + 저장자료 검색 결과를 같이 보여줌
- 좌표가 없으면 `좌표 없음`으로 표시하되 검색 결과에는 나오게 함

주의:

지도에 핀을 찍는 것은 좌표가 필요하지만, 고객코드/주소/매장명 검색은 좌표가 없어도 되어야 한다. 이 원칙은 앞으로도 유지할 것.

## WMS / 운영지도 관련 사용자 피드백

사용자는 WMS 화면 UI에 많이 불만이 있었다.

핵심 피드백:

- 기존 UI가 너무 구림
- 같은 틀에 갇히지 말 것
- 다른 WMS/물류 운영툴 UI를 참고해서 새로 시안부터 보여줄 것
- WMS는 지도보다 표/착지 리스트가 중심이어야 함
- WMS에서 지도는 작고 보조적인 미니맵이어도 됨
- 일일동선은 지도가 메인이어야 함
- WMS와 일일동선 UI 톤은 통일하되, 화면 목적은 다르게 가져갈 것
- 새 UI를 바로 구현하지 말고 먼저 이미지/시안으로 보여주면 좋음

WMS 기능 관련 사용자가 원한 것:

- 상세 배차 파일 + 차량톤수 요약 파일 2개 업로드
- 두 파일을 합산하지 말고, 상세 파일은 착지/금액, 요약 파일은 톤수/호차 메타로 사용
- 톤수별 금액 기준:
  - 1.0톤: 6,100,000원
  - 1.2톤: 9,600,000원
  - 1.4톤: 10,500,000원
  - 2.5톤: 13,600,000원
  - 3.5톤: 14,600,000원
- 금액 초과 차량은 용차 후보 지역 묶음을 제안
- 기존 호차에 붙이는 게 아니라, 튀는 지역구 물량을 새 용차로 빼는 방식
- 초과/과밀/보통/여유를 누르면 해당 호차 리스트가 필터링되어야 함
- 표 헤더 안에서 정렬/필터를 하고 싶어함
- 고객코드/고객명/주소 검색은 반드시 있어야 함

## 일일동선 관련 현재 문제

일일동선은 계속 실패가 있었다.

현재까지 나온 문제:

- 딜리버리 어드민 직접 조회는 느리고 불안정
- Freshon 직접 조회로 바꾸자는 방향
- Freshon 경로:
  - 물류관리
  - 배차관리
  - 일일배차관리
  - 물류센터 선택
  - 입고요청일 선택
  - 배차구분 야간배송
  - 호차 검색
  - 조회
- 조회 결과에서 톤수, 주문금액, 고객 목록을 가져와 운영지도 주소와 매칭해서 일일동선을 만들고 싶어함

주의:

사용자는 “캐시로 들어가지 말고 프레시온 직접 조회가 낫다”고 했다. 하지만 Render에서 외부 조회가 느리면 타임아웃이 나므로 API 호출/세션/페이지 크기 제한을 신중하게 잡아야 한다.

## Render 관련 이슈

과거 Render 로그에서 다음 문제가 있었다.

- `npm error signal SIGTERM`
- `Port scan timeout reached, no open ports detected`
- GitHub cache write 409
- 대용량 엑셀 처리 중 HTTP 502/503/524
- Node heap out of memory

주의:

- 대용량 엑셀은 한 번에 메모리에 크게 올리면 안 됨
- `/tmp`는 임시 저장소라 재배포/인스턴스 교체 시 사라질 수 있음
- 영구 저장은 GitHub cache 또는 Render persistent disk/DB가 필요
- GitHub cache는 현재 사용자가 만든 `mingu0702-droid/freshon-cache` 저장소를 사용한 이력이 있음

## 현재 검증 상태

최근 모바일 반영 때 확인한 것:

- `src/server.js` 문법 검사 통과
- `public/mobile-report-prototype.html` 내부 스크립트 파싱 통과
- `public/customer-master-20260604.json` 15,592건 파싱 확인
- 한글 검색 데이터 예시 `할맥` 정상 확인
- 정적 요청으로 `/mobile-report-prototype.html`, `/customer-master-20260604.json` 200 확인

로컬 Express 서버는 이 폴더에 `node_modules`가 없어서 바로 실행되지 않았다.

에러:

`Cannot find package 'express'`

필요하면 `npm install` 후 확인해야 한다.

## 다음 Codex에게 권장하는 진행 순서

1. 먼저 이 인수인계 문서와 `MOBILE_REPORT_NOTES.md`를 읽는다.
2. `src/server.js`의 모바일 검색 API 보호 대상이 살아있는지 확인한다.
3. 모바일 리포트 UI는 바로 구현하지 말고 새 시안을 먼저 만든다.
4. 시안은 WMS/일일동선과 분리해서, 모바일 현장 작업자 입장에서 설계한다.
5. 고객 검색은 `customer-master-20260604.json` 우선 원칙을 지킨다.
6. 사진 저장은 현재 localStorage/브라우저 파일 객체 한계가 있으므로 DB/스토리지 설계를 같이 제안한다.
7. Render 배포 전에는 대용량 파일 처리와 GitHub cache 409 방지를 점검한다.

## 사용자 성향 메모

사용자는 실무 흐름에 맞지 않는 UI에 매우 민감하다. “예쁘기만 한 UI”보다 빠르게 판단하고 복붙/카톡 공유/호차 조정에 바로 쓸 수 있는 화면을 선호한다.

답변할 때는:

- 두루뭉술하게 말하지 말 것
- “가능합니다”만 말하지 말고 실제 파일/경로/동작을 명확히 말할 것
- UI 작업은 가능하면 시안부터 보여줄 것
- 이전 요구사항을 잊지 말 것
- 같은 실수를 반복하지 말 것

특히 다음 요구는 계속 유지해야 한다.

- 고객 검색은 주소가 있으면 좌표가 없어도 검색되어야 함
- 모바일 고객 검색 API 삭제 금지
- `customer-master-20260604.json` 삭제 금지
- `mockups/daily-report-app-flow.png` 삭제 금지
- 전표와 미상차 사진은 한 세트
- 적재함 사진은 호차당 1장
