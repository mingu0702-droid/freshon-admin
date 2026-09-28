import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
test('proxy 502/503 is not mislabeled as missing staff configuration',()=>{
 const source=fs.readFileSync(new URL('../public/map-staff.js',import.meta.url),'utf8');
 assert.match(source,/error\.loginCode === 'STAFF_AUTH_NOT_CONFIGURED'/);
 assert.match(source,/error\.status >= 500 \? '일시적인 로그인 서비스 오류/);
 assert.doesNotMatch(source,/error\.status === 503 \? '직원 로그인 설정/);
 assert.match(source,/\['STAFF_AUTH_NOT_CONFIGURED','LOGIN_RETRY_LATER','LOGIN_UNAVAILABLE'\]\.includes\(code\)/);
 assert.match(source,/error\.name !== 'AbortError'/);
});
