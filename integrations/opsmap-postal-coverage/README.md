# 운영지도 음영권역 우편번호 후보

## 적용 범위

기존 세 번째 탭의 배송 음영권역을 우편번호 5자리 기준으로 표시합니다. 매장·권역 지도와 일자별 운행은 같은 화면을 사용합니다. 우편번호 모드는 하나의 경계 해상도만 조회합니다. 기존 H3 모드와 자료는 롤백에 사용할 수 있습니다.

## 경계 및 집계 확인

- 확인한 경계는 서울시 공개 WFS `2.0.0`의 `magok:tl_kodis_bas` 34,525구역입니다. 2026-11-14 06:05 KST에 받은 파일의 공식 배포 기준일은 미공개이며 속성의 최신 변경일은 2020-12-16입니다. 유효하지 않은 도형 1개는 변환 과정에서 형상을 검증해 복구했습니다. [서울시 WFS](https://energyinfo.seoul.go.kr/gis/wfs?service=WFS&version=2.0.0&request=GetCapabilities)
- 2026-10-13 시행 우정사업본부 고시의 34,403개와 개수가 다릅니다. 새 공식 경계의 배포일과 코드·형상이 일치하는지 확인한 뒤 운영 반영을 결정합니다. 행정안전부에서 최신 도형을 받고 재검증할 때는 기존 승인 계정으로 도형 제공을 신청합니다. [우정사업본부 고시](https://www.law.go.kr/LSW/admRulInfoP.do?admRulSeq=2100000286886) · [행정안전부 자료 경로](https://www.data.go.kr/data/15050416/fileData.do)
- 등록 고객코드 6,043곳은 고객코드나 주소를 합치지 않고 원본 해상도 국가기초구역에 대조했습니다. 경계 미연결·모호 각 0곳입니다. 좌표와 배송 당시 주소 해시가 일치해야 위치에 반영합니다.
- 배송 밀도는 **선택 기간에 위치가 확인된 고유 완료 배송 ID 수 ÷ 공식 구역의 EPSG:5179 투영 면적(km²)**입니다. 100 이상은 진한 파랑, 0 초과 100 미만은 옅은 파랑입니다. 위치가 확인된 등록 매장이 있고 관측 근거와 코드별 위치 연결을 점검한 구역의 관측 배송이 0이면 주황 후보입니다. 나머지는 회색 자료 미확인입니다.
- 범위가 미확인인 날·센터는 0건으로 표시하지 않습니다. 범례의 미배송 후보는 해당 기간 전체의 미배송 확정이나 신규 배차 가능 판정으로 사용하지 않습니다.

| 기간 | 오산 관측 / 미확인 | 전체 관측 완료 | 좌표 연결 배송 | 오산신규 배송 확인 / 미확인 | 오산보류 이력 |
|---|---:|---:|---:|---:|---:|
| 30일 | 26 / 4 | 30,368 | 30,279 | 488 / 491 | 6 |
| 60일 | 50 / 10 | 58,253 | 58,125 | 624 / 355 | 6 |
| 90일 | 76 / 14 | 88,136 | 87,983 | 756 / 223 | 6 |

배송 기준일은 2026-11-07입니다. 90일 위치 미연결 153건은 원천 합계에는 포함하며 경계에 임의 배정하지 않습니다.

## 승인 후 C 연결

1. B의 최종 커밋 한 개만 적용합니다. 공통 연결부는 `src/shadowCoverage/routes.js`, `src/stageVerificationEntry.js`, `public/opsmap/shadow-coverage-tab.mjs`입니다. 기존 데이터 복원과 직원 인증을 유지합니다. 시안 비교용 A·B 커밋은 필요하지 않습니다.
2. 기존 B의 공식 경계 변환기로 날짜가 확인된 전국 자료를 정리합니다. 검증된 원장 세대, 주소 해시·배송 ID 원천, 오산신규·보류 이력과 함께 작업 트리 밖에 새 디렉터리를 생성합니다.

```powershell
node --max-old-space-size=320 scripts/prepare-opsmap-postal.mjs $preparedBoundaries $boundaryInputSha $committedSnapshot $storeStatusFile $statusSha $newPrivatePackage
```

3. 생성된 `geometry/`와 `postal-release.json.gz`를 승인된 방식으로 같은 서버 내부 경로에 읽기 전용으로 연결합니다. 키는 `OPSMAP_SHADOW_POSTAL_DIR`, `OPSMAP_SHADOW_POSTAL_BOUNDARY_SHA256`, `OPSMAP_SHADOW_POSTAL_RELEASE_SHA256`입니다. 이 3개가 확인되면 격리 검증에서 `OPSMAP_SHADOW_COVERAGE_FORMAT=postal`을 설정합니다. 기존 H3 원본, H3 플래그 및 운영 원장 파일은 이 패키지에 포함하지 않습니다.
4. 새 원장 세대가 발행될 때 같은 명령으로 새 우편번호 묶음을 만듭니다. 사전 집계와 읽기 승인 포인터의 원장 세대가 다르면 API는 503을 반환합니다. 브라우저의 동일 세션은 앞선 정상 화면과 자료 기준일을 표시합니다. 묶음에는 고객코드와 집계가 있어 비공개로 보관합니다.
5. 실제 Render에서 전체 앱 메모리와 배율별 첫 화면을 확인합니다. 연결을 되돌릴 때는 `OPSMAP_SHADOW_COVERAGE_FORMAT`의 `postal` 설정을 해제해 기존 H3를 선택합니다.

## 재현

```powershell
node --test test/shadow-coverage.test.mjs test/postal-coverage.test.mjs
node test/postal-coverage-browser.mjs postal $committedSnapshot $storeStatusFile $newPrivatePackage $buildAudit $results live-sdk
node test/postal-coverage-browser.mjs h3 $committedSnapshot $storeStatusFile $newPrivatePackage $buildAudit $results live-sdk
```

브라우저 시험은 서버를 하나씩 열고, 로컬 전체 Stage 앱의 실제 보존본과 별도의 검증용 세션을 사용합니다. Playwright가 Chrome DevTools Protocol의 성능 추적 및 GC 뒤 JS Heap을 기록합니다. SDK 자원만 네트워크에서 읽으며 원장·Stage의 설정이나 배포를 변경하지 않습니다.

도형 읽기 캐시는 서버 압축 바이트 4MiB, 브라우저 도형 추정 16MiB입니다. 브라우저는 동일 배율·카메라·기간·센터의 캔버스 최대 2장만 보관합니다. PC와 390px 모두 지도·필터 상태를 해제할 때 캐시를 비웁니다.
