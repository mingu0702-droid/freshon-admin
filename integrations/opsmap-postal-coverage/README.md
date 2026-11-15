# 운영지도 음영권역 우편번호 후보

## 적용 범위

기존 세 번째 탭의 배송 음영권역을 우편번호 5자리 기준으로 표시합니다. 매장·권역 지도와 일자별 운행은 같은 화면을 사용합니다. 우편번호 모드는 하나의 경계 해상도만 조회합니다. 기존 H3 모드와 자료는 롤백에 사용할 수 있습니다.

## 경계 및 집계 확인

- 확인한 경계는 서울시 공개 WFS `2.0.0`의 `magok:tl_kodis_bas` 34,525구역입니다. 2026-11-14 06:05 KST에 받은 파일의 공식 배포 기준일은 미공개이며 속성의 최신 변경일은 2020-12-16입니다. 유효하지 않은 도형 1개는 변환 과정에서 형상을 검증해 복구했습니다. [서울시 WFS](https://energyinfo.seoul.go.kr/gis/wfs?service=WFS&version=2.0.0&request=GetCapabilities)
- 우정사업본부 제2026-54호는 2026-11-10 시행이며 11-03 기준 34,403개 번호를 공표했습니다. 보존 WFS와 공통인 코드는 34,131개입니다. 등록 주소의 엄격 대조 결과 5,774곳 일치, 54곳 불일치, 215곳 미확인입니다. [우정사업본부 고시](https://www.koreapost.go.kr/user/bbs/kpost/92/277/bbsDataView/100102427.do)
- 국토교통부 VWorld의 공식 기초구역은 기준 2026-11, 갱신 2026-11-13으로 표시됩니다. 공식 로그인으로 최신 SHP를 확보한 뒤 좌표와 주소를 다시 대조해야 합니다. [VWorld 공식 기초구역 자료](https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?svcCde=MK&dsId=30054)
- 보존 WFS에서는 등록 고객코드 6,043곳이 3,394개 구역에 유일하게 연결됐습니다. 고객코드나 주소를 합치지 않습니다. 좌표와 배송 당시 주소 해시가 일치해야 위치에 반영합니다. 실제 배정이 달라지는 54곳의 공식 도형 대조는 운영 반영 전 검증 대상입니다.
- 배송 밀도는 **선택 기간에 위치가 확인된 고유 완료 배송 관측 건수 ÷ 구역의 EPSG:5179 투영 면적(km²)**입니다. 100 이상은 진한 파랑, 0 초과 100 미만은 옅은 파랑입니다. 위치가 확인된 등록 매장이 있고 관측 근거와 코드별 위치 연결을 점검한 구역의 관측 배송이 0이면 주황 후보입니다. 나머지는 회색 자료 미확인입니다.
- 범위가 미확인인 날·센터는 0건으로 표시하지 않습니다. 범례의 미배송 후보는 해당 기간 전체의 미배송 확정이나 신규 배차 가능 판정으로 사용하지 않습니다.

| 기간 | 오산 관측 / 미확인 | 전체 관측 완료 | 좌표 연결 배송 | 오산신규 배송 확인 / 미확인 | 오산보류 이력 |
|---|---:|---:|---:|---:|---:|
| 30일 | 26 / 4 | 30,368 | 30,279 | 488 / 491 | 6 |
| 60일 | 50 / 10 | 58,253 | 58,125 | 624 / 355 | 6 |
| 90일 | 76 / 14 | 88,136 | 87,983 | 756 / 223 | 6 |

배송 기준일은 2026-11-07입니다. 90일 위치 미연결 153건은 원천 합계에는 포함하며 경계에 임의 배정하지 않습니다.

## 권역별 업장과 배송 이력

- 지도에서 선택한 우편번호와 기간에 해당하는 업장 12곳씩을 조회합니다. 업장을 펼치면 조회한 기간과 센터에 해당하는 관측 배송을 최신 날짜부터 12건씩 읽습니다. 자료의 관측 시각과 상세를 읽은 시각을 따로 표시합니다.
- 배송 당시 확정호차는 보존 이력에서 읽습니다. 현재 기준호차와 배송요일은 기존 직원용 기준호차 리더에서 읽으며 이전 정상 자료이면 시각을 함께 표시합니다.
- 승인된 배송 보존본은 배송 관측일과 배송 요약키를 제공합니다. 실제 주문번호, 주문별 배송 상태, 원본 배송ID 및 개별 실제·예정 배송일은 해당 원천과 연결될 때까지 미연결 또는 미확인으로 남습니다. 원천 연동에는 승인된 주문 원장의 주문번호와 배송 원천의 관계 키가 필요합니다. 영업·휴업 여부도 전용 자료가 필요합니다.

## 승인 후 C 연결

1. C에 우편번호 기반 커밋 `237bd2f67e0d95329b7880a8772b7d4da96a6d7b`가 없으면 먼저 해당 커밋을 적용한 뒤 B의 업장 상세 커밋을 적용합니다. 공통 연결부는 `src/shadowCoverage/routes.js`, `src/stageVerificationEntry.js`, `public/opsmap/shadow-coverage-tab.mjs`입니다. 기존 데이터 복원과 직원 인증을 유지합니다. 비교 전용 시안 커밋은 제외합니다.
2. 기존 B의 공식 경계 변환기로 날짜가 확인된 전국 자료를 정리합니다. 검증된 원장 세대, 주소 해시·배송 ID 원천, 오산신규·보류 이력과 함께 작업 트리 밖에 새 디렉터리를 생성합니다.

```powershell
node --max-old-space-size=320 scripts/prepare-opsmap-postal.mjs $preparedBoundaries $boundaryInputSha $committedSnapshot $storeStatusFile $statusSha $newPrivatePackage
```

3. 생성된 `geometry/`와 `postal-release.json.gz`를 승인된 방식으로 같은 서버 내부 경로에 읽기 전용으로 연결합니다. 설정 키는 `OPSMAP_SHADOW_POSTAL_DIR`, `OPSMAP_SHADOW_POSTAL_BOUNDARY_SHA256`, `OPSMAP_SHADOW_POSTAL_RELEASE_SHA256`입니다. 확인 후 격리 검증에서 `OPSMAP_SHADOW_COVERAGE_FORMAT=postal`을 사용합니다.
4. 같은 원장·경계·우편번호 묶음에서 아래 명령으로 비공개 업장 상세 파일 2개를 생성합니다. `details-index.json.gz`와 `customer-history.bin`을 앱 외부 동일 디렉터리에 함께 두고 `OPSMAP_SHADOW_POSTAL_DETAILS_DIR`에 지정합니다. `OPSMAP_SHADOW_POSTAL_DETAILS_SHA256`에는 인덱스 파일의 SHA-256을 설정합니다. 배송 이력은 읽을 고객의 압축 구간만 SHA-256으로 검증한 뒤 반환합니다.

```powershell
node --max-old-space-size=320 scripts/prepare-opsmap-postal-details.mjs $newPrivatePackage $releaseSha $preparedBoundaries $committedSnapshot $newPrivateDetailsDir
```

5. 새 원장 세대에는 2~4단계를 다시 실행합니다. 원장·경계·집계 세대가 다르면 상세 API는 503을 반환합니다. 화면은 조회 실패 시각과 같은 조회 조건의 이전 정상 시각을 구분합니다. 묶음은 실제 고객코드 및 집계 자료를 포함하므로 비공개로 보관합니다.
6. 실제 Render에서 전체 앱 메모리와 첫 화면을 확인합니다. 이번 후보의 선택 방식은 5자리 우편번호로 유지합니다.

## 불변 전국 표시 인덱스

공식 도형에서 생성한 우편번호 릴리스의 경계 해시를 입력합니다. 스크립트는 봉인된 전국 타일을 검증하고, 투영된 좌표를 델타 인코딩한 별도 표시 묶음을 만듭니다. 정점과 우편번호 ID를 유지합니다. 실제 매장 매칭과 클릭 판정은 기존 상세 경계를 사용합니다.

```powershell
python scripts/prepare-opsmap-postal-overview.py (Join-Path $newPrivatePackage geometry) $boundaryManifestSha $newPrivateOverview
```

앱 외부의 생성 경로와 출력된 인덱스 SHA-256을 `OPSMAP_SHADOW_POSTAL_OVERVIEW_DIR`과 `OPSMAP_SHADOW_POSTAL_OVERVIEW_SHA256`에 함께 지정합니다. 표시 인덱스에는 고객·주문·배송 정보가 없으며 경계 버전에 고정됩니다. 브라우저는 실제 Kakao 투영을 확인한 뒤 현재 화면과 겹치는 타일만 요청하고, 경계 해시별 메모리 캐시를 재사용합니다. 해당 두 설정을 해제하면 같은 5자리 우편번호의 기존 벡터 표시를 사용합니다. [Kakao 지도 좌표 변환 명세](https://apis.map.kakao.com/web/documentation/#MapProjection)

조작 시간은 응답의 `Server-Timing`에서 원천 읽기·집계 준비·화면 범위·점 공간 조인을 확인할 수 있습니다. 브라우저의 `data-postal-geometry`와 `data-postal-draw`에서 경계 다운로드·해제 완료, 타일 파싱 및 지도 그리기를 각각 확인합니다.

## 재현

```powershell
node --test test/shadow-coverage.test.mjs test/postal-coverage.test.mjs test/postal-area-details.test.mjs
node test/postal-coverage-browser.mjs postal $committedSnapshot $storeStatusFile $newPrivatePackage $buildAudit $results live-sdk
node test/postal-coverage-browser.mjs h3 $committedSnapshot $storeStatusFile $newPrivatePackage $buildAudit $results live-sdk
```

브라우저 시험은 서버를 하나씩 열고, 로컬 전체 Stage 앱의 실제 보존본과 별도의 검증용 세션을 사용합니다. Playwright가 Chrome DevTools Protocol의 성능 추적 및 GC 뒤 JS Heap을 기록합니다. SDK 자원만 네트워크에서 읽으며 원장·Stage의 설정이나 배포를 변경하지 않습니다.

도형 읽기 캐시는 서버 압축 바이트 4MiB, 브라우저 도형 추정 16MiB입니다. 브라우저는 동일 배율·카메라·기간·센터의 캔버스 최대 2장만 보관합니다. PC와 390px 모두 지도·필터 상태를 해제할 때 캐시를 비웁니다.
