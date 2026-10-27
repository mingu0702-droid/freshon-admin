# 로컬 화면·동작 검증 서버

이 서버는 **합성 자료로 실제 앱의 HTML·JS·CSS를 실행하는 DOM 검증용**입니다. 실제 Kakao 지도 타일, 직원 인증, Customer/Delivery 자료, 자동차 도로 API를 검증하지 않습니다. 경로 버튼의 합성 성공 응답은 입력·상태·폴리라인 렌더링 계약 확인용이며 실제 도로 성공 증거로 사용하면 안 됩니다.

## 실행

프로젝트 루트에서:

```sh
node tests/repair4/preview-server.mjs
```

주소: `http://127.0.0.1:4173/`

포트 변경이 필요한 경우 `OPSMAP_PREVIEW_PORT`를 지정합니다. 기본 바인딩은 `127.0.0.1`입니다. 배포·외부 호출·데이터 쓰기는 없습니다. 서버 종료는 실행 터미널의 `Ctrl+C`입니다.

## 합성 자료와 검증 지점

- 일반지도: 2,036매장.
- 저장 검토일: 2026-10-23, 해당일 이력이 있는 96매장만 반환.
- 기간 상태: `ready:false`, `reviewOnly:true`, `availableReviewDate:'2026-10-23'`.
- `LOCAL_REVIEW_CONFIG.date`를 동일 날짜로 주입합니다. 일반자료를 특정일 자료로 재사용하는 오류를 검출하기 위한 계약입니다.
- `S9901000` / `S9901001`: 같은 건물 좌표, 서로 다른 고객코드.
- `S9901002` / `S9901003`: 다른 위치의 정상 매장.
- `S9901047`: 위치가 없는 매장.
- 101~116호차, 오산·영남·호남 3센터.
- 출입정보의 `DEMO1234` 등 모든 값은 합성 값입니다.

실제 앱 파일은 `public/`에서 읽습니다. 별도 컨트롤러나 UI 복제본을 만들지 않습니다. 반환 HTML에는 검증용 부트스트랩과 고정 안내 배너만 추가하고 외부 XLSX 스크립트를 로컬의 비활성 대역으로 바꿉니다. 실제 Kakao SDK 대신 기존 `tests/patch/kakao-test-double.js`를 사용합니다. 서버는 외부 네트워크 호출 코드를 사용하지 않으며 CSP도 외부 리소스·연결을 차단합니다.

## 점검용 상태

`GET /__fixture/state`는 요청 경로, 경로요청 횟수, 합성 자료 수를 반환합니다. 다음 요청으로 오류 상태와 지연 응답을 재현할 수 있습니다.

```sh
curl -X POST http://127.0.0.1:4173/__fixture/state -H 'content-type: application/json' -d '{"routeMode":"error"}'
curl -X POST http://127.0.0.1:4173/__fixture/state -H 'content-type: application/json' -d '{"routeMode":"synthetic","routeDelayMs":1500}'
```

`routeMode`는 `synthetic` 또는 `error`만 허용합니다. `routeDelayMs`는 0~30,000ms입니다. 외부 도로 API에는 전달하지 않습니다.

## 브라우저 없이 통합 DOM 검증

`dom-flow.mjs`는 jsdom 30.1.3과 esbuild 0.28.2를 사용합니다. 의존성 폴더를 `OPSMAP_DOM_DEPS`에 지정할 수 있으며 기본 경로는 `/tmp/opsmap4-dom-deps`입니다. 검증 서버를 먼저 실행한 뒤 아래 명령을 실행합니다.

```sh
node tests/repair4/dom-flow.mjs
```

실제 `public/` 자산을 로드하고 같은 출처의 로컬 요청만 허용합니다. jsdom에서 모듈 스크립트를 실행하기 위해 실제 모듈 파일을 메모리에서 IIFE로 번들링하며 생산 코드는 변경하지 않습니다. SDK 대역에 고정 DOM 크기를 공급하므로 **레이아웃 픽셀·시각적 완성도·실브라우저·실제 지도·실제 도로 API 성공 검증이 아닙니다.** SDK 대역의 최대 축척은 3개 센터의 합성 좌표가 함께 들어가도록 보정했습니다.

결과는 `reports/repair4/dom-flow.json`에 일반지도 기준호차 담당기사 표시를 포함한 19개의 의미 있는 동작 케이스로 저장됩니다. HTML 직렬화는 `reports/repair4/dom-flow-page.html`에 저장하며 합성 자료만 포함합니다.

현재 실행 중인 검증 서버가 시작 시 SDK 대역 파일을 읽어 보관하므로, 하네스는 `/__fixture/bootstrap.js`의 설정 부분을 그대로 사용하면서 SDK 부분만 최신 `tests/patch/kakao-test-double.js`로 교체합니다. 같은 출처 리소스 인터셉터에서 수행하며, 생산 스크립트의 내용·컨트롤러는 바꾸지 않습니다. 따라서 검증 서버를 재시작하지 않아도 SDK 축척 보정을 동일하게 재현할 수 있습니다.
