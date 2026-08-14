# 운영지도 Hub API 계약 (v1)

## 원칙
- Customer는 Source of Truth, Hub는 조회·가공·제한적 TTL 캐시, 운영지도는 Hub만 호출한다.
- Hub는 Customer 전체 원천 데이터를 영구 복제하지 않는다. 모든 응답에 `schemaVersion`, `dataAsOf`, `stale`을 포함한다.
- 목록은 cursor 기반이며 `limit` 기본 500, 최대 2000이다. 오류 형식은 `{code,message,retryable,requestId}`이다.

## API
### GET /v1/map/markers
입력: `date, center, area, bounds=minLng,minLat,maxLng,maxLat, cursor, limit`

응답:
```json
{"schemaVersion":"1.0","dataAsOf":"2026-07-24T00:00:00Z","stale":false,"items":[{"customerCode":"S1","vehicle":"101","lat":37.1,"lng":127.1,"label":"101호","updatedAt":"2026-07-24T00:00:00Z"}],"nextCursor":null}
```

### GET /v1/customers/{customerCode}
핀 클릭 시 lazy load한다. 반환: `customerCode,customerName,address,detailAddress,phone,brand,center,area,vehicle,driverName,driverPhone,deliveryPattern,memo,updatedAt,schemaVersion,dataAsOf,stale`.

### GET /v1/routes/stops
입력: `date, vehicle, cursor, limit`. 반환: `customerCode,sequence,vehicle,lat,lng,label,dailyAmount,updatedAt` 및 공통 메타데이터.

### GET /v1/vehicles/search
입력: `q,date,center,cursor,limit`. 반환: `vehicle,driverName,driverPhone,center,area,updatedAt`.

### GET /v1/admin/geocodes/missing
관리자 권한 전용. 입력: `cursor,limit,center`. 반환: `customerCode,address,reason,updatedAt`.

## 캐시·fallback
| API | TTL | 키 | stale fallback |
|---|---:|---|---|
| map/markers | 120초 | schema+date+center+area+정규화 bounds+cursor | 최대 24시간, `stale=true`와 기준일 표시 |
| customers/{code} | 300초 | schema+customerCode | 최대 24시간 |
| routes/stops | 120초 | schema+date+vehicle+cursor | 최대 24시간 |
| vehicles/search | 60초 | schema+q+date+center+cursor | 최대 1시간 |
| admin/geocodes/missing | 30초 | schema+center+cursor | stale 미사용 |

Hub는 Customer 장애 시 마지막 정상 캐시만 반환하며, 캐시도 없으면 503을 반환한다. 운영지도는 Customer URL/자격증명을 보유하지 않는다.
