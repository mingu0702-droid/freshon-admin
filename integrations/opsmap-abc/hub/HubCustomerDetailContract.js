/* Shared pure contract: Apps Script V8 and Node. Contains no credentials or IO. */
(function(root){
  'use strict';
  const FIELDS=Object.freeze(['customerName','address','detailAddress','accessInfo','password','securityKey','generalKey','specialRemark','deliveryPattern']);
  const own=(o,k)=>Object.prototype.hasOwnProperty.call(o||{},k);
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  const code=v=>typeof v==='string'&&/^[A-Z]\d{1,20}$/.test(v);
  const copy=v=>JSON.parse(JSON.stringify(v));
  function instant(v){
    if(v instanceof Date)v=v.toISOString();
    if(typeof v!=='string')return null;
    // Collector timestamps without an offset are Korea time, never server-local time.
    if(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(v))v=v.replace(' ','T')+'+09:00';
    if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)||!Number.isFinite(Date.parse(v)))return null;
    const calendar=v.slice(0,10);if(new Date(calendar).toISOString().slice(0,10)!==calendar)return null;
    return new Date(v).toISOString();
  }
  function safeText(v,max){
    if(typeof v!=='string')return null;
    const t=v.replace(/\r/g,'').trim();
    if(!t||t.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(t))return null;
    // Never publish source-auth secrets, owner contacts or complaints as a note.
    if(/(?:bearer\s|cookie\s*[:=]|token\s*[:=]|secret\s*[:=]|api[_ -]?key\s*[:=]|클레임|claim|고객\s*불만|(?:점주|점장|사장|대표).{0,8}(?:전화|연락처|휴대폰))/i.test(t))return null;
    return t.replace(/(?:01[016789]|0\d{1,2})[- ]?\d{3,4}[- ]?\d{4}/g,'').trim()||null;
  }
  function location(v){const t=safeText(v,500);return t&&!/[\r\n]|비밀번호|비번|출입|도어락|보안키|password|token|secret/i.test(t)?t:null;}
  function keyFlag(v){if(v===true||v===false)return v;if(v===1||v==='1'||v==='Y'||v==='예'||v==='있음')return true;if(v===0||v==='0'||v==='N'||v==='아니오'||v==='없음')return false;return null;}
  function normalize(field,value){
    if(field==='securityKey'||field==='generalKey')return keyFlag(value);
    if(['customerName','address','detailAddress'].includes(field))return location(value);
    if(field==='password')return typeof value==='string'&&/^[A-Za-z0-9#*\/_-]{2,100}$/.test(value.trim())?value.trim():null;
    return safeText(value,2000);
  }
  function memoFields(value){
    const out={},conflicted=new Set();let unknown=false;
    if(value==null||value==='')return {fields:out,unknown};
    if(typeof value!=='string'||value.length>16000)return {fields:out,unknown:true};
    const lines=value.replace(/\r/g,'').split(/\n|[;；]|\/(?=\s*(?:출입방법|배송위치|특이사항|배송요일|보안키|일반키|비밀번호)\s*[:：])|(?=(?:출입방법|배송위치|특이사항|배송요일|보안키|일반키|비밀번호)\s*[:：])/u);
    for(let line of lines){
      line=line.replace(/^[\s*•]+/,'').trim();if(!line)continue;
      const m=line.match(/^(출입방법|출입정보|배송위치|비밀번호|비번|번호키|도어락\s*비밀번호|특이사항|배송요일|보안키|일반키)\s*[:：]\s*(.*)$/u);
      if(!m){unknown=true;continue;}
      const field=/비밀번호|비번|번호키/.test(m[1])?'password':m[1]==='보안키'?'securityKey':m[1]==='일반키'?'generalKey':m[1]==='특이사항'?'specialRemark':m[1]==='배송요일'?'deliveryPattern':'accessInfo';
      const v=normalize(field,m[2]);if(v===null){unknown=true;continue;}
      if(conflicted.has(field))continue;if(own(out,field)&&out[field]!==v){delete out[field];conflicted.add(field);unknown=true;}else out[field]=v;
    }
    return {fields:out,unknown};
  }
  function observation(row,meta){
    if(!row||!code(row.customerCode)||!meta||!['CUSTOMER','DELIVERY_STORED'].includes(meta.source)||typeof meta.sourceVersion!=='string'||!meta.sourceVersion||meta.sourceVersion.length>200)fail('DETAIL_OBSERVATION_CONTRACT');
    const observedAt=instant(meta.observedAt),effectiveAt=instant(meta.modifiedAt||row.updatedAt||row.modifiedAt);
    if(!observedAt)fail('DETAIL_OBSERVATION_TIME');
    if(effectiveAt&&Date.parse(effectiveAt)>Date.parse(observedAt)+300000)fail('DETAIL_SOURCE_TIME_FUTURE');
    const parsed=memoFields(row.accessMemo),values={},invalid=[];
    const aliases={address:['customerAddress','address'],detailAddress:['detailAddress','addressDetail'],deliveryPattern:['deliveryPattern','deliveryPatternText','deliveryDays'],securityKey:['securityKey','hasSecurityKey'],generalKey:['generalKey','hasGeneralKey','hasKey']};
    for(const field of FIELDS){const keys=aliases[field]||[field],key=keys.find(k=>own(row,k));let v=key===undefined?parsed.fields[field]:row[key];
      if(v===undefined||v===null||typeof v==='string'&&!v.trim())continue;
      const normalized=normalize(field,v);if(normalized!==null)values[field]=normalized;else invalid.push(field);
    }
    const clears=Array.isArray(meta.clearedFields)?meta.clearedFields:[];
    if(clears.some(f=>!FIELDS.includes(f))||clears.length&&!(meta.correctionVerified===true)||meta.deleted===true&&!(meta.correctionVerified===true))fail('DETAIL_CLEAR_PROOF_REQUIRED');
    if((clears.length||meta.deleted===true)&&!effectiveAt)fail('DETAIL_CLEAR_TIME_REQUIRED');
    return {customerCode:row.customerCode,values,clearedFields:[...new Set(clears)],deleted:meta.deleted===true,effectiveAt,observedAt,source:meta.source,sourceVersion:meta.sourceVersion,sourceRecordDate:typeof meta.sourceRecordDate==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(meta.sourceRecordDate)&&Number.isFinite(Date.parse(meta.sourceRecordDate))&&new Date(meta.sourceRecordDate).toISOString().slice(0,10)===meta.sourceRecordDate?meta.sourceRecordDate:null,unparsedMemo:parsed.unknown||invalid.length>0,invalidFields:invalid};
  }
  function merge(previous,input){
    if(!input||!code(input.customerCode)||!instant(input.observedAt)||!input.values)fail('DETAIL_MERGE_CONTRACT');
    if(previous&&previous.customerCode!==input.customerCode)fail('DETAIL_CUSTOMER_MISMATCH');
    const out=previous?copy(previous):{schema:1,customerCode:input.customerCode,fields:{},revision:0,audit:[],deletedAt:null,unparsedMemo:false};
    const changed=[],conflicts=[];out.unparsedMemo=out.unparsedMemo||input.unparsedMemo===true;
    if(out.deletedAt&&(!input.effectiveAt||input.effectiveAt<=out.deletedAt))return {record:out,changed:false,changedFields:[],conflicts:[]};
    for(const field of FIELDS){
      const clear=input.deleted||input.clearedFields.includes(field),has=clear||own(input.values,field);if(!has)continue;
      const value=clear?null:input.values[field],old=out.fields[field];
      // Untimestamped rows can seed a field, never replace a dated value.
      if(old){
        if(!input.effectiveAt&&old.effectiveAt||input.effectiveAt&&old.effectiveAt&&input.effectiveAt<old.effectiveAt)continue;
        if(old.conflict&&(input.effectiveAt||null)===(old.effectiveAt||null)){conflicts.push(field);continue;}
        if((input.effectiveAt||null)===(old.effectiveAt||null)&&old.value!==value){
          if(!old.conflict){out.fields[field]={...old,conflict:true};changed.push(field);}conflicts.push(field);continue;
        }
        if(old.value===value&&!old.conflict&&(input.effectiveAt||null)===(old.effectiveAt||null))continue;
      }
      out.fields[field]={value,effectiveAt:input.effectiveAt,observedAt:input.observedAt,source:input.source,sourceVersion:input.sourceVersion,sourceRecordDate:input.sourceRecordDate,cleared:clear,conflict:false};changed.push(field);
    }
    const newest=Object.values(out.fields).reduce((t,f)=>f.effectiveAt&&f.effectiveAt>t?f.effectiveAt:t,'');
    if(input.deleted&&input.effectiveAt>=newest&&(!out.deletedAt||input.effectiveAt>out.deletedAt))out.deletedAt=input.effectiveAt;
    else if(out.deletedAt&&input.effectiveAt>out.deletedAt&&Object.keys(input.values).length)out.deletedAt=null;
    if(changed.length){out.revision++;out.observedAt=input.observedAt;out.audit=[...(out.audit||[]),{revision:out.revision,observedAt:input.observedAt,effectiveAt:input.effectiveAt,source:input.source,fields:[...new Set(changed)],conflicts:[...new Set(conflicts)]}].slice(-12);}
    return {record:out,changed:changed.length>0,changedFields:[...new Set(changed)],conflicts};
  }
  function project(record,{view='notes',requestedDate=null,currentness='UNCONFIRMED',version=null,checkedAt=null}={}){
    if(!record||!code(record.customerCode)||!record.fields)fail('DETAIL_RECORD_CONTRACT');
    const fields=view==='store'?['customerName','address','detailAddress','deliveryPattern']:['accessInfo','password','securityKey','generalKey','specialRemark','deliveryPattern'];
    const data={customerCode:record.customerCode},fieldState={},fieldMeta={};
    for(const field of fields){const item=record.fields[field];data[field]=item&&!item.conflict&&!record.deletedAt?item.value:null;
      fieldState[field]=record.deletedAt?'DELETED':!item?'UNOBSERVED':item.conflict?'CONFLICT':item.cleared?'CLEARED':item.effectiveAt?'PRESENT':'TIME_UNCONFIRMED';
      fieldMeta[field]=item?{effectiveAt:item.effectiveAt,source:item.source,sourceVersion:item.sourceVersion,sourceRecordDate:item.sourceRecordDate}:null;
    }
    data.fieldState=fieldState;data.fieldMeta=fieldMeta;data.source='Customer 저장자료';
    if(view==='store'){data.detailDate=requestedDate;data.detailAddressState=fieldState.detailAddress==='PRESENT'?'PRESENT':fieldState.detailAddress==='CLEARED'?'EMPTY':fieldState.detailAddress;data.businessCoverageVerified=false;}
    else {data.memoDate=requestedDate;data.memoState=record.deletedAt?'DELETED':Object.values(fieldState).includes('CONFLICT')||record.unparsedMemo?'NEEDS_CONFIRMATION':fields.some(f=>data[f]!==null)?'REGISTERED':Object.values(fieldState).some(s=>s==='UNOBSERVED')?'NEEDS_CONFIRMATION':'UNREGISTERED';}
    return {data,meta:{version,currentness,checkedAt,revision:record.revision,source:'CUSTOMER_PRIVATE_PREPARED',sourceCompletenessVerified:false,stale:currentness!=='SOURCE_UNCHANGED'}};
  }
  root.OpsmapCustomerDetailContract=Object.freeze({FIELDS,instant,normalize,memoFields,observation,merge,project});
})(typeof globalThis!=='undefined'?globalThis:this);
