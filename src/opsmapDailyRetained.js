import fs from 'node:fs/promises';
import path from 'node:path';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';

const maxBytes=3*1024*1024, maxAge=14*86400000, maxFiles=14;
const safeDate=value=>/^\d{4}-\d{2}-\d{2}$/.test(value);
const allowed=['customerCode','customerName','vehicle','confirmedVehicle','deliveryDate','lastDeliveryDate','address','lat','lng',
  'coordinateSource','coordinateAccuracy','coordinateStatus','coordinateEvidence','originalAddressHash','dispatchCenterCode',
  'status','order','sequence','actualDeliveryEvent','actualDeliveryEvents','driverKey','driverIdentity'];
export function createDailyRetainedStore({directory,secret,now=Date.now}={}) {
  if(typeof directory!=='string'||!path.isAbsolute(directory)||typeof secret!=='string'||secret.length<32)return null;
  const key=createHash('sha256').update('opsmap-daily-retained-v1\0').update(secret).digest();
  const filename=date=>path.join(directory,'opsmap-daily-'+date+'.sealed');
  const aad=date=>Buffer.from('opsmap-daily-v1:'+date);
  let writes=Promise.resolve();
  async function read(date) {
    if(!safeDate(date))return null;
    try {
      const f=await fs.open(filename(date),'r');
      let encrypted;
      try{
        const st=await f.stat();
        if(!st.isFile()||st.size<29||st.size>maxBytes)return null;
        encrypted=Buffer.alloc(st.size);
        if((await f.read(encrypted,0,encrypted.length,0)).bytesRead!==encrypted.length)return null;
      }finally{await f.close();}
      const decipher=createDecipheriv('aes-256-gcm',key,encrypted.subarray(0,12));
      decipher.setAAD(aad(date));decipher.setAuthTag(encrypted.subarray(12,28));
      const {savedAt,value}=JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(28)),decipher.final()]));
      return savedAt<=now()&&now()-savedAt<=maxAge&&value?.ok===true&&value.meta?.complete===true&&value.meta.date===date&&
        Array.isArray(value.data)&&value.meta.rowCount===value.data.length?value:null;
    }catch{return null;}
  }
  async function write(value) {
    const date=value?.meta?.date;
    if(value?.ok!==true||value.meta.complete!==true||value.meta.reviewOnly||value.meta.retained||
      !safeDate(date)||!Array.isArray(value.data)||value.data.length!==value.meta.rowCount)return;
    const work=async()=>{
      await fs.mkdir(directory,{recursive:true,mode:0o700});
      const data=value.data.map(row=>Object.fromEntries(allowed.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]])));
      const payload=Buffer.from(JSON.stringify({savedAt:now(),value:{...value,data}}));
      if(payload.length+28>maxBytes)return;
      const nonce=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,nonce);
      cipher.setAAD(aad(date));
      const encrypted=Buffer.concat([cipher.update(payload),cipher.final()]);
      const temporary=filename(date)+'.'+randomBytes(8).toString('hex')+'.tmp';
      try{
        await fs.writeFile(temporary,Buffer.concat([nonce,cipher.getAuthTag(),encrypted]),{mode:0o600,flag:'wx'});
        await fs.rename(temporary,filename(date));
      }finally{await fs.unlink(temporary).catch(()=>{});}
      const files=await fs.readdir(directory,{withFileTypes:true});
      const cached=await Promise.all(files.filter(f=>f.isFile()&&/^opsmap-daily-\d{4}-\d{2}-\d{2}\.sealed$/.test(f.name)).map(async f=>{
        const file=path.join(directory,f.name);
        return {file,mtime:(await fs.stat(file).catch(()=>null))?.mtimeMs||0};
      }));
      cached.sort((a,b)=>b.mtime-a.mtime);
      await Promise.all(cached.slice(maxFiles).map(({file})=>fs.unlink(file).catch(()=>{})));
    };
    const pending=writes.then(work);writes=pending.catch(()=>{});return pending;
  }
  return {read,write};
}
