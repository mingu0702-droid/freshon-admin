# 모바일 상차 리포트 앱 연동 메모

이 프로젝트는 운영지도 서버이며, 모바일 상차 리포트 앱에서 고객/매장 검색 API로 사용할 예정입니다.

## 유지해야 하는 API

`GET /api/mobile/customer-search?q=매장명`

## 용도

- 전표 OCR로 읽은 매장명을 검색
- 운영지도 고객 데이터에서 후보 매장 찾기
- S로 시작하는 고객코드, 매장명, 호차/노선, 착순을 모바일앱에 제공

## 삭제하면 안 되는 서버 코드

- `vehicleAreaSourceUrl`
- `normalizeSearchValue`
- `customerSearchScore`
- `pushCustomerSearchItem`
- `buildCustomerSearchItems`
- `app.get("/api/mobile/customer-search", ...)`

## 주의

- `public/vehicle-data.js` 또는 고객 데이터의 한글 인코딩이 깨지면 매장명 검색이 실패합니다.
- `"할맥"`, `"준코"`, `"치킨플러스"`, `"달떡볶이"` 같은 검색어가 결과를 반환해야 정상입니다.
- 폴더 버전이 새로 생겨도 GitHub `main`에는 이 API를 유지해야 합니다.
- Render 배포도 GitHub `main` 기준으로 다시 올라가야 합니다.

## 모바일앱 목표 흐름

1. 전표 사진 촬영
2. 매장명 OCR
3. 운영지도에서 매장 검색
4. S 고객코드/매장명/호차/착순 확인
5. 적재함 사진/안 실리는 것 사진 정리
6. 카톡 복사용 문구 생성
