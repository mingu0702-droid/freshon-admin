# Freshon 고정배차 관리자

Freshon MIS의 `물류관리 -> 기준정보 관리 -> 고정배차 정보 관리` 데이터를 읽어 캐시하고, 다른 사람이 볼 수 있는 웹 화면으로 보여주는 관리자 페이지입니다.

## 보안 원칙

- Freshon ID/PASSWORD는 GitHub에 올리지 않습니다.
- Render 환경변수에만 입력합니다.
- 공개 화면은 캐시된 조회 결과만 보여줍니다.
- `데이터 갱신` API는 `ADMIN_TOKEN`이 있어야 실행됩니다.
- Freshon 원본 데이터는 수정하지 않고 조회만 합니다.

이미 채팅에 비밀번호가 노출되었으므로, 실제 배포 전 비밀번호 변경을 권장합니다.

## 기능

- 고정배차 정보 캐시 조회
- 관리 토큰으로 수동 데이터 갱신
- 기본 갱신 기간: 전일자 기준 3개월
- CSV 다운로드
- Render 배포용 `render.yaml` 포함

## 로컬 실행

```bash
npm install
copy .env.example .env
npm start
```

`.env`에 아래 값을 입력합니다.

```env
FRESHON_ID=your-id
FRESHON_PASSWORD=your-password
ADMIN_TOKEN=long-random-token
PUBLIC_VIEW=true
```

브라우저에서 `http://localhost:3000`을 엽니다.

## Render 배포

1. 이 폴더를 GitHub 저장소로 올립니다.
2. Render에서 `New -> Web Service`를 선택합니다.
3. GitHub 저장소를 연결합니다.
4. `render.yaml`을 사용하거나 아래 값을 직접 설정합니다.
5. Environment Variables에 입력:
   - `FRESHON_ID`
   - `FRESHON_PASSWORD`
   - `ADMIN_TOKEN`
   - `PUBLIC_VIEW=true`

## GitHub에 올리면 안 되는 것

- `.env`
- Freshon ID/PASSWORD가 적힌 문서
- `data/*.json` 캐시 파일

## 참고

Freshon 화면의 실제 HTML 구조가 바뀌거나 로그인 방식이 다르면 `src/scraper/freshonFixedDispatch.js`의 selector 조정이 필요할 수 있습니다. 첫 배포 후 `데이터 갱신`이 실패하면 오류 메시지를 보고 로그인/조회 버튼/테이블 selector를 맞추면 됩니다.
