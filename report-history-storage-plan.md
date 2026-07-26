# 리포트 기록 저장 계획

## 목표

- 앱을 쓰는 모든 사람이 저장한 데일리 리포트를 과거 기록으로 볼 수 있게 한다.
- 필요하면 날짜별/호차별/매장별로 검색한다.
- 엑셀에서 열 수 있는 CSV 또는 XLSX로 내려받는다.

## 저장 방식

프로토타입은 브라우저 `localStorage`에 임시 저장한다. 이 방식은 현재 기기에서만 보이므로 실제 앱에서는 아래 서버 저장이 필요하다.

1. 앱에서 `기록 저장`을 누른다.
2. 사진은 서버 스토리지에 업로드한다.
3. 리포트 정보는 서버 DB에 저장한다.
4. 앱의 `과거 기록` 화면은 서버 DB에서 기록을 불러온다.
5. 관리자는 전체 기록을 CSV/XLSX로 내려받는다.

## 추천 DB 구조

### reports

- `id`
- `created_at`
- `created_by`
- `report_date`
- `customer_code`
- `store_name`
- `route`
- `stop_order`
- `reason`
- `transport`
- `message`

### report_photos

- `id`
- `report_id`
- `photo_type`
  - `loaded_truck`
  - `slip`
  - `unloaded`
- `set_no`
- `file_url`
- `created_at`

### customer_overrides

검색이 안 되는 신규 지점을 앱에서 직접 추가했을 때 임시 저장한다.

- `id`
- `customer_code`
- `store_name`
- `address`
- `created_by`
- `created_at`
- `status`
  - `pending`
  - `approved`
  - `rejected`

## 사진 촬영 흐름

적재함 사진은 호차당 1장만 저장한다.

미상차는 아래처럼 한 세트로 저장한다.

1. 전표 촬영
2. 고객 마스터 검색
3. 매장 확인
4. 미상차 사진 촬영
5. 세트 추가

이렇게 저장하면 전표와 미상차 사진이 서로 섞이지 않는다.

## 엑셀 내보내기

앱에서는 우선 CSV 내보내기를 제공한다. CSV는 엑셀에서 바로 열 수 있다.

나중에 관리자 화면을 만들면 아래 방식이 좋다.

- 날짜 범위 선택
- 작성자 선택
- 호차/퀵 선택
- 매장명 검색
- CSV/XLSX 다운로드

## 권한

- 일반 사용자: 본인이 저장한 기록 조회
- 관리자: 전체 사용자 기록 조회 및 엑셀 다운로드
