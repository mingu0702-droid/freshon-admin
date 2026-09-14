import crypto from 'node:crypto';
import { groupPeriodRows, validatePeriod } from './mapPeriod.js';

const date = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(v).toISOString().slice(0,10) === v;
const hash = v => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail = code => { throw new Error(code); };
const historyFields = ['deliveryDate','customerCode','deliveryId','vehicle','driverName','driverPhone','kind','sourceVersion','updatedAt'];
const periodFields = ['deliveryDate','customerCode','vehicle','driverName','driverKey','driverIdentity'];

// Only the explicitly approved minimal lookup lives in memory. No raw payload,
// filesystem persistence, public response cache, or Google request on UI reads.
export function createStageReadModel({ secret, now = Date.now } = {}) {
  let live = null, pending = null, lastStatus = { phase: 'WAITING', complete: false };
  const nonces = new Map();
  function ingest(body, signature) {
    if (!secret || secret.length < 32) fail('MODEL_AUTH');
    const text = JSON.stringify(body);
    if (!/^\d+$/.test(String(body?.timestamp)) || Math.abs(now()-Number(body.timestamp))>300000
      || !/^[a-zA-Z0-9_-]{16,80}$/.test(body.nonce||'')) fail('MODEL_AUTH');
    const expected=crypto.createHmac('sha256',secret).update(text).digest('hex');
    if(!/^[a-f0-9]{64}$/.test(signature||'') || !crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected))) fail('MODEL_AUTH');
    for(const [key,until] of nonces) if(until<now())nonces.delete(key);
    if(nonces.has(body.nonce))fail('MODEL_REPLAY');
    nonces.set(body.nonce,now()+300000);
    const m=body.message;
    if(m?.type==='status') { lastStatus={phase:String(m.phase),complete:false,scanned:Number(m.scanned)||0,total:Number(m.total)||0,updatedAt:new Date(now()).toISOString()};return; }
    if(!Number.isSafeInteger(m?.generation)||m.generation<1)fail('MODEL_CONTRACT');
    if(m.type==='begin') {
      if((live&&m.generation<live.generation)||(pending&&m.generation<pending.generation))fail('MODEL_OLD_GENERATION');
      if(!pending||pending.generation!==m.generation)pending={generation:m.generation,shards:new Map()};
      lastStatus={phase:'HYDRATING',complete:false,updatedAt:new Date(now()).toISOString()};return;
    }
    if(m.type==='commit' && live?.generation===m.generation) {pending=null;return;} // Lost ACK is safe.
    if(!pending||m.generation!==pending.generation)fail('MODEL_BEGIN_REQUIRED');
    if(m.type==='shard') {
      if(!['history','period'].includes(m.kind)||!date(m.date)||!Array.isArray(m.rows)||m.rows.length>8000)fail('MODEL_SHARD');
      const fields=m.kind==='history'?historyFields:periodFields,seen=new Set();
      for(const row of m.rows){
        if(!row||Object.keys(row).some(k=>!fields.includes(k))||row.deliveryDate!==m.date||! /^[A-Z]\d+$/.test(row.customerCode||''))fail('MODEL_ROW');
        if(fields.some(k=>typeof row[k]!=='string')||Object.values(row).some(v=>typeof v!=='string'||v.length>300))fail('MODEL_ROW');
        const key=m.kind==='history'?row.customerCode+'|'+row.deliveryId:JSON.stringify([row.customerCode,row.vehicle,row.driverKey]);
        if(m.kind==='history'&&!row.deliveryId||seen.has(key))fail('MODEL_DUPLICATE');seen.add(key);
      }
      if(hash(m.rows)!==m.hash)fail('MODEL_HASH');
      if(pending.shards.size>=180&&!pending.shards.has(m.kind+':'+m.date))fail('MODEL_CAPACITY');
      pending.shards.set(m.kind+':'+m.date,{rows:m.rows,hash:m.hash});return;
    }
    if(m.type!=='commit'||!date(m.startDate)||!date(m.endDate)||!Array.isArray(m.manifest)||m.manifest.length>180)fail('MODEL_COMMIT');
    validatePeriod(m.startDate,m.endDate);
    const history=new Map(),period=[],seen=new Set();
    for(const entry of m.manifest){
      const shard=pending.shards.get(entry.key);
      if(!shard||shard.hash!==entry.hash||shard.rows.length!==entry.count||seen.has(entry.key))fail('MODEL_INCOMPLETE');
      seen.add(entry.key);
      for(const row of shard.rows){
        if(row.deliveryDate<m.startDate||row.deliveryDate>m.endDate)fail('MODEL_DATE');
        if(entry.key.startsWith('history:')){if(!history.has(row.customerCode))history.set(row.customerCode,[]);history.get(row.customerCode).push(row);}
        else period.push(row);
      }
    }
    for(const rows of history.values())rows.sort((a,b)=>b.deliveryDate.localeCompare(a.deliveryDate)||a.deliveryId.localeCompare(b.deliveryId));
    const historyDates=m.manifest.filter(e=>e.key.startsWith('history:')&&e.count>0).map(e=>e.key.slice(8)).sort();
    const periodDates=m.manifest.filter(e=>e.key.startsWith('period:')&&e.count>0).map(e=>e.key.slice(7)).sort();
    live={generation:m.generation,history,period,historyLatest:historyDates.at(-1)||null,periodLatest:periodDates.at(-1)||null,startDate:m.startDate,endDate:m.endDate,updatedAt:new Date(now()).toISOString()};
    pending=null;lastStatus={phase:'DONE',complete:true,updatedAt:live.updatedAt};
  }
  function status(){return {...lastStatus,progress:lastStatus.complete?100:0,ready:!!live,source:'Hub.StageReadModel',generation:live?.generation||null,startDate:live?.startDate||null,endDate:live?.endDate||null,historyLatest:live?.historyLatest||null,periodLatest:live?.periodLatest||null,historyRows:live?[...live.history.values()].reduce((n,r)=>n+r.length,0):0,periodRows:live?.period.length||0};}
  function ready(start,end){validatePeriod(start,end);if(!live)fail('READ_MODEL_NOT_READY');if(start<live.startDate||end>live.endDate)fail('READ_MODEL_RANGE_NOT_READY');}
  function history({customerCode,startDate,endDate}){
    ready(startDate,endDate);
    return (live.history.get(customerCode)||[]).filter(r=>r.deliveryDate>=startDate&&r.deliveryDate<=endDate).map(({sourceVersion,updatedAt,...row})=>({...row,sourceKey:row.deliveryDate+'|'+row.deliveryId+'|'+row.customerCode}));
  }
  function period(startDate,endDate){
    ready(startDate,endDate);
    return {ok:true,data:groupPeriodRows(live.period.filter(r=>r.deliveryDate>=startDate&&r.deliveryDate<=endDate).map(r=>({...r,lastDeliveryDate:r.deliveryDate}))),meta:{...status(),complete:true,phase:'DONE',startDate,endDate,source:'Customer.daily_routes via Hub.StageReadModel',coverageComplete:false}};
  }
  return {ingest,status,history,period};
}
