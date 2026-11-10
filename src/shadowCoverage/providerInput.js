import path from 'node:path';
import {boundedRead,privateCoverageDirectory} from './coverageFiles.js';
import {MAX_PROVIDER_ROWS,PROVIDERS,parseProviderCoverage,providerDigest,sealProviderCoverage} from './providerCoverage.js';

const INPUT_LIMIT=4*1024*1024;
const DATASET_LIMIT=8*1024*1024;
const sha=/^[a-f0-9]{64}$/;
const columns=new Set(['provider','customerCode','internalCustomerCode','matchApproved','address','pnu','postalCode',
  'lat','lng','h3Cell','scope','status','weekdays','areaType','validFrom','validTo','source']);

function verifyInput(bytes,expectedSha256) {
  if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>INPUT_LIMIT||
      !sha.test(expectedSha256||'')||providerDigest(bytes)!==expectedSha256)throw Error('PROVIDER_INPUT_NOT_APPROVED');
}

export async function importProviderCoverageFile(bytes,{format,sheetName,expectedSha256,...metadata}={}) {
  verifyInput(bytes,expectedSha256);
  if(!['csv','xlsx'].includes(format))throw Error('PROVIDER_INPUT_FORMAT');
  const {default:XLSX}=await import('xlsx');
  let workbook;
  try {
    workbook=XLSX.read(format==='csv'?bytes.toString('utf8'):bytes,{
      type:format==='csv'?'string':'buffer',raw:true,sheetRows:MAX_PROVIDER_ROWS+2,cellFormula:true,
      cellDates:true,dateNF:'yyyy-mm-dd'
    });
  } catch {throw Error('PROVIDER_INPUT_SHEET');}
  const name=sheetName||(workbook.SheetNames.length===1?workbook.SheetNames[0]:null);
  const sheet=name&&workbook.Sheets[name];
  if(!sheet?.['!ref']||Object.values(sheet).some(cell=>cell?.f))throw Error('PROVIDER_INPUT_SHEET');
  const range=XLSX.utils.decode_range(sheet['!fullref']||sheet['!ref']);
  if(range.e.c-range.s.c+1>columns.size||range.e.r-range.s.r>MAX_PROVIDER_ROWS)throw Error('PROVIDER_INPUT_LIMIT');
  const matrix=XLSX.utils.sheet_to_json(sheet,{header:1,raw:false,defval:'',blankrows:true,dateNF:'yyyy-mm-dd'});
  const [headers,...rows]=matrix;
  if(!headers?.length||headers.length>columns.size||new Set(headers).size!==headers.length||
      headers.some(field=>!columns.has(field))||rows.length>MAX_PROVIDER_ROWS||rows.some(row=>row.length>headers.length)) {
    throw Error('PROVIDER_INPUT_COLUMNS');
  }
  return sealProviderCoverage({...metadata,records:rows.flatMap((row,i)=>{
    if(!row.some(Boolean))return [];
    return [Object.fromEntries(headers.map((key,column)=>{
      const cell=sheet[XLSX.utils.encode_cell({r:range.s.r+i+1,c:range.s.c+column})];
      const value=(key==='validFrom'||key==='validTo')&&cell?.t==='d'?cell.v.toISOString().slice(0,10):row[column]||'';
      return [key,value];
    }))];
  })});
}

export async function importProviderCoverageApi({approvedUrl,expectedSha256,headers,fetchImpl=fetch,...metadata}={}) {
  let target;
  try {target=new URL(approvedUrl);}catch{throw Error('PROVIDER_API_NOT_APPROVED');}
  if(target.protocol!=='https:'||target.username||target.password||target.hash||
      !sha.test(expectedSha256||'')||metadata.kind!=='APPROVED')throw Error('PROVIDER_API_NOT_APPROVED');
  let result;
  try {
    result=await fetchImpl(target,{method:'GET',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(12_000),
      headers:{Accept:'application/json',...headers}});
  } catch {throw Error('PROVIDER_API_UNAVAILABLE');}
  if(!result.ok||result.redirected||!result.body||Number(result.headers.get('content-length'))>INPUT_LIMIT||
      !/^application\/json\b/i.test(result.headers.get('content-type')||'')) {
    await result.body?.cancel().catch(()=>{});
    throw Error('PROVIDER_API_RESPONSE');
  }
  const stream=result.body.getReader();
  const chunks=[];
  let size=0;
  try {
    for(;;) {
      const {done,value}=await stream.read();
      if(done)break;
      size+=value.byteLength;
      if(size>INPUT_LIMIT)throw Error('PROVIDER_INPUT_LIMIT');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await stream.cancel().catch(()=>{});
    stream.releaseLock();
  }
  const bytes=Buffer.concat(chunks,size);
  verifyInput(bytes,expectedSha256);
  let payload;
  try {payload=JSON.parse(bytes);}catch{throw Error('PROVIDER_API_RESPONSE');}
  if(!payload||payload.provider!==undefined&&payload.provider!==metadata.provider||
      payload.asOf!==undefined&&payload.asOf!==metadata.asOf)throw Error('PROVIDER_API_RESPONSE');
  return sealProviderCoverage({...metadata,records:payload.records});
}

export function createProviderCoverageReader({directory,expected={},appRoot,now=Date.now}={}) {
  const cache=new Map();
  function read(provider) {
    if(!Object.hasOwn(expected,provider))return {state:'NOT_CONNECTED'};
    const entry=cache.get(provider);
    if(entry?.retryAfter>now())return entry.result;
    const fresh={retryAfter:Infinity};
    fresh.result=(async()=>{
      const pin=expected[provider];
      if(!sha.test(pin||''))throw Error('PROVIDER_FILE_DIGEST');
      const folder=await privateCoverageDirectory(directory,appRoot);
      const bytes=await boundedRead(path.join(folder,provider+'.json'),DATASET_LIMIT);
      return {state:'CONNECTED',dataset:parseProviderCoverage(bytes,pin,provider)};
    })().catch(()=>{
      fresh.retryAfter=now()+60_000;
      return {state:'UNVERIFIED'};
    });
    cache.set(provider,fresh);
    return fresh.result;
  }
  return async()=>Object.fromEntries(await Promise.all(PROVIDERS.map(async provider=>[provider,await read(provider)])));
}
