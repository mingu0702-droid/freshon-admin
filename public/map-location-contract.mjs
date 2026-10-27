// Administrative address region is independent of the FreshOn dispatch center.
export function addressRegion(address){
 const prefix=String(address||'').normalize('NFKC').trim().split(/\s/)[0];
 for(const [region,names]of Object.entries({수도권:['서울','서울시','서울특별시','인천','인천시','인천광역시','경기','경기도'],강원권:['강원','강원도','강원특별자치도'],충청권:['충북','충청북도','충남','충청남도','대전','대전시','대전광역시','세종','세종시','세종특별자치시'],호남권:['전북','전라북도','전북특별자치도','전남','전라남도','광주','광주시','광주광역시'],영남권:['경북','경상북도','경남','경상남도','부산','부산시','부산광역시','대구','대구시','대구광역시','울산','울산시','울산광역시'],제주권:['제주','제주도','제주특별자치도']}))if(names.includes(prefix))return region;
 return '주소 권역 미확인';
}
export function dispatchCenter(row={}){
 const code=({osan:'011',yeongnam:'012',honam:'013','011':'011','012':'012','013':'013'})[row.baseVehicleGroup||row.dispatchCenterCode];
 const sourceVerified=row.baseVehicleSource==='FIXED_DISPATCH_PRIMARY'&&/^[a-f0-9]{64}$/.test(row.baseVehicleVersion||'')&&['VERIFIED_MASTER','UNASSIGNED'].includes(row.baseVehicleState);
 if(!sourceVerified||!code)return {code:null,name:'담당 센터 미확인',state:'UNCONFIRMED',label:'담당 센터 미확인'};
 const name=({'011':'오산','012':'영남','013':'호남'})[code],latest=row.baseVehicleStale===false;
 return {code,name,state:latest?'LATEST_VERIFIED':'PREVIOUS_VERIFIED',checkedAt:row.baseVehicleCheckedAt||null,label:code+' '+name+' · '+(latest?'최신 검증값':String(row.baseVehicleCheckedAt||'').slice(0,10)+' 이전 확인값 · 최신 미검증')};
}

// Targets come from current rows/manual records, never a fixed historical list.
export function manualPinTargetCodes(rows, records = [], previous = []) {
 const stores=new Map((rows||[]).filter(r=>/^[A-Z]\d+$/.test(r?.customerCode||'')).map(r=>[r.customerCode,r]));
 const codes=new Set(previous);
 for(const row of stores.values())if(!Number.isFinite(row.lat)||!Number.isFinite(row.lng)||row.coordinateStatus==='CONFLICT')codes.add(row.customerCode);
 for(const record of records||[])if(record?.customerCode)codes.add(record.customerCode);
 return [...codes].filter(code=>stores.has(code)).sort((a,b)=>a.localeCompare(b,'en',{numeric:true}));
}
