# 운영지도 B 음영권역 3종 시안

기준 커밋 `ec9ae9a4041096a5580b39d5cb071140e0491cce`의 독립 시안입니다. `h3`, `admin`, `postal` 중 하나를 지정해 로컬에서 실행합니다. 기존 운영지도에 연결하는 진입점이 없으며 브라우저는 루프백 서버에서 도형과 집계만 읽습니다.

## 로컬 실행

저장소 루트에서 Node 24와 기존 `h3-js` 및 Playwright 의존성을 사용합니다. `OPSMAP_PROTOTYPE_SNAPSHOT`에는 승인된 `generation-6043` 폴더의 절대 경로를, `OPSMAP_PROTOTYPE_STATUS`에는 기존 `opsmap-stage-freshon-delivery-status.json.gz.b64`의 절대 경로를 지정합니다. 입력은 작업 트리 밖에 두고 2026-11-07 보존본의 세대와 SHA-256을 유지합니다.

```powershell
node --max-old-space-size=320 prototypes/shadow-coverage/server.mjs h3
```

출력된 루프백 URL을 엽니다. 읍면동은 명령의 마지막 인자를 `admin`으로, 우편번호는 `postal`로 바꿉니다. 다른 시안을 실행하기 전에 기존 서버를 종료합니다.

우편번호 시안은 변환한 공식 도형 경로를 `OPSMAP_POSTAL_BOUNDARIES`로 받습니다. 서울시 공개 WFS의 전국 레이어를 재현하려면 Python에 `pyshp`, `pyproj`, `shapely>=2.1`을 준비하고 아래 각 경로를 작업 트리 밖의 새 폴더로 지정합니다.

```powershell
python prototypes/shadow-coverage/fetch-postal-wfs.py $postalSourceDir
python prototypes/shadow-coverage/prepare-postal.py --origin SEOUL_WFS --wfs-source $postalSourceDir --output $postalBoundaryDir
$env:OPSMAP_POSTAL_BOUNDARIES = $postalBoundaryDir
node --max-old-space-size=320 prototypes/shadow-coverage/server.mjs postal
```

## 검증

`OPSMAP_PROTOTYPE_RESULTS`에 작업 트리 밖의 출력 폴더를 지정합니다. 각 명령은 서버와 Chromium을 띄워 PC·390px 화면을 캡처한 뒤 모두 종료합니다. 종료 코드를 확인한 다음 다음 안을 실행합니다.

```powershell
node prototypes/shadow-coverage/verify.mjs h3
node prototypes/shadow-coverage/verify.mjs admin
node prototypes/shadow-coverage/verify.mjs postal
node --test prototypes/shadow-coverage/postal.test.mjs
```

## 자료 기준

- 동일한 등록 매장 6,043곳과 2026-08-10~11-07 보존본을 사용합니다. 해시를 확인한 고객코드·주소 해시·배송 ID로 관측 완료 88,136건을 중복 검사하고, 위치가 확인된 87,983건을 표시합니다. 미연결 153건과 미확인 14일은 별도 기록합니다.
- 파랑은 관측 배송, 주황은 관측기간 미배송 후보, 회색은 자료 부족입니다. 주황색은 관측 센터에서 등록 매장을 확인했고 미연결 배송이 없는 구역에서만 사용합니다. 배송 밀도 경계는 15·100·500건/km²로 통일합니다.
- 기존 오산신규 979곳의 활성 756곳과 미확인 223곳 및 오산보류 이력 6곳을 유지합니다. 상세 확대의 점은 원천 좌표에 표시합니다.
- 읍면동의 배치 판정은 공식 원본 해상도 경계를 사용합니다. 속도 비교 화면에는 화면 크기에 맞춘 표시본을 사용합니다. [국가데이터처 2025-06-30 읍면동 경계](https://www.data.go.kr/data/15129688/fileData.do)
- 우편번호 검증본은 배포 기준일이 공개되지 않은 서울시 공식 WFS 국가기초구역 레이어입니다. [WFS 레이어 목록](https://energyinfo.seoul.go.kr/gis/wfs?service=WFS&version=2.0.0&request=GetCapabilities)
- 지도 바탕은 해안선과 지명으로 구성합니다. 도로 타일과 외부 주소·지도 API를 사용하지 않습니다. [Natural Earth](https://www.naturalearthdata.com/downloads/50m-physical-vectors/)

측정값은 로컬 Node 프로세스 RSS, Chromium 렌더러 JavaScript 힙 및 Chromium 프로세스 RSS 합계입니다. Chromium 합계에 공유 페이지가 중복될 수 있습니다. 동일한 Node 힙 한도와 서버 프로세스 512MiB 기준으로 비교하며 Render 배포 계측은 별도입니다.
