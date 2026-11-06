import {randomUUID} from 'node:crypto';
import '../../public/opsmap/kakao-directions-adapter.js';

const {coordinate}=globalThis.KakaoDirectionsAdapter;
const pageLimit=32; // Osan plus at most 31 stops, with one extra row to detect overflow.
const error=(code,status=409)=>Object.assign(new Error(code),{code,status});
const text=value=>typeof value==='string'?value.trim():'';
const vehicleId=value=>text(value).replace(/\s+/g,'').replace(/호(?:차)?$/,'');
const validDate=date=>/^\d{4}-\d{2}-\d{2}$/.test(date)&&Number.isFinite(Date.parse(date))&&new Date(date).toISOString().slice(0,10)===date;
const point=(id,{lat,lng})=>({id,lat,lng});

export function createRecordedRoadRouteReader({callHub,readVehicleCenter}){
  return async (input,center)=>{
    const {date,vehicle}=input??{};
    const normalizedVehicle=vehicleId(vehicle);
    if(typeof date!=='string'||!validDate(date)||typeof vehicle!=='string'||vehicle.length>40||
      !/^[0-9A-Za-z가-힣_-]{1,30}$/.test(normalizedVehicle))throw error('INVALID_MANUAL_ROUTE',400);
    let payload;
    try{payload=await callHub('routeStops',{date,vehicle:normalizedVehicle,limit:pageLimit},{useCache:false,privateRead:true,maxResponseBytes:65536,deadline:Date.now()+15000});}
    catch{throw error('ROUTE_SOURCE_UNAVAILABLE',503);}
    const rows=payload?.data,meta=payload?.meta;
    if(payload?.ok!==true||!Array.isArray(rows)||meta?.limit!==pageLimit||!Number.isSafeInteger(meta.total)||
      meta.total<0||meta.returned!==rows.length||rows.length>pageLimit)throw error('ROUTE_SOURCE_UNVERIFIED');
    if(meta.total>=pageLimit||rows.length>=pageLimit)throw error('WAYPOINT_LIMIT',400);
    if(meta.nextCursor!==null||meta.total!==rows.length)throw error('ROUTE_SOURCE_UNVERIFIED');
    const orders=new Set();
    const stops=rows.map(row=>{
      if(row?.deliveryDate!==date||vehicleId(row.confirmedVehicle)!==normalizedVehicle)throw error('ROUTE_IDENTITY_MISMATCH');
      const order=row.sequence,customerCode=text(row.customerCode);
      if(!customerCode||!Number.isSafeInteger(order)||order<1||orders.has(order))throw error('RECORDED_ORDER_REQUIRED');
      orders.add(order);
      const {latitude:lat,longitude:lng}=row;
      try{coordinate({lat,lng});}catch{throw error('STOP_COORDINATES_MISSING');}
      return {customerCode,customerName:text(row.customerName),address:text(row.customerAddress),vehicle,order,lat,lng};
    }).sort((a,b)=>a.order-b.order);
    let origin=null;
    if(stops.length&&center?.id==='osan'&&center.verified===true&&text(center.sourceVersion)){
      try{
        coordinate(center);
        if(await readVehicleCenter?.({date,vehicle:normalizedVehicle})==='osan'){
          origin={...point('CENTER_osan',center),customerCode:'CENTER_osan',customerName:'오산센터',address:center.address};
        }
      }catch{/* The saved order is still usable with an explicitly selected origin. */}
    }
    const data={date,vehicle,origin,stops};
    if(!origin)return {data,draft:null};
    const points=stops.map((stop,index)=>point('stop-'+index,stop));
    const draft={mode:'MANUAL_WAYPOINTS',requestId:randomUUID(),origin:point(origin.id,origin),
      waypoints:points.slice(0,-1).map((p,index)=>({...p,order:index+1})),destination:points.at(-1)};
    return {data,draft};
  };
}
