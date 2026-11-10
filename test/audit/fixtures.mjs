import {createHash} from 'node:crypto';
import {officialAddressKey,createOfficialAddressLookup} from '../../src/opsmapOfficialAddressLookup.js';
export const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
export const now=()=>Date.parse('2026-11-10T05:00:00Z');
export const address=n=>'경기도 오산시 합성로 '+n;
export function emptyLedger(){const body={schema:'opsmap-fixed-store-coordinates-v1',revision:0,records:{}};return {...body,sha256:hash(body)};}
export function store(code='T990001',n=10,extra={}){return {code,name:'합성 매장',address:address(n),center:'osan',registered:true,lat:null,lng:null,...extra};}
export function index(entries){
 const rows=entries.map(([addr,lat=37.15,lng=127.05,bldg='b'.repeat(64)])=>({addressSha256:hash(officialAddressKey(addr)),buildingSha256:bldg,lat,lng}));
 const body={schema:'opsmap-official-address-index-v1',source:'https://www.data.go.kr/data/15083033/fileData.do',date:'2026-11-01',datasetSha256:'a'.repeat(64),rows};
 const bytes=Buffer.from(JSON.stringify(body));return createOfficialAddressLookup(bytes,{sha256:hash(bytes.toString())});
}
