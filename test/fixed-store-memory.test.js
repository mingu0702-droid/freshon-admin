import test from 'node:test';import assert from 'node:assert/strict';import crypto from 'node:crypto';
import {fixedEnvelope,validateFixedEnvelope,fixedTupleData} from '../src/fixedVehicleStore.js';
const row={customerCode:'S99731',baseVehicle:'221',baseVehicleGroup:'osan',baseVehicleState:'VERIFIED_MASTER',weekdays:{Mon:'221',Tue:'',Wed:'221',Thu:'',Fri:'221',Sat:'',Sun:''}};
const fixture=()=>fixedEnvelope([row],new Date().toISOString());
const rehash=v=>{v.version=crypto.createHash('sha256').update(JSON.stringify({schema:v.schema,checkedAt:v.checkedAt,rows:v.rows}),'utf8').digest('hex');return v;};
test('compact validation reuses verified tuple tree without full projection allocation',()=>{const v=fixture(),r=validateFixedEnvelope(v,{materialize:false});assert.equal(r.envelope,v);assert.equal('data' in r,false);assert.deepEqual(fixedTupleData(v.rows[0]),validateFixedEnvelope(v).data[0]);});
test('compact validation rejects duplicates/order violation even with matching checksum',()=>{const v=fixture();v.rows.push([...v.rows[0]]);v.count++;assert.throws(()=>validateFixedEnvelope(rehash(v),{materialize:false}));});
test('compact validation retains strict fields, canonical time and weekday contract',()=>{for(const mutate of [v=>v.rows[0][4][0]=221,v=>v.rows[0][0]='99731',v=>v.rows[0][3]='UNASSIGNED',v=>v.extra='unapproved',v=>v.checkedAt='2026-09-29']){const v=fixture();mutate(v);assert.throws(()=>validateFixedEnvelope(rehash(v),{materialize:false}));}});
