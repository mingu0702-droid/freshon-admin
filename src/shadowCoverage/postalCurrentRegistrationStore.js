import {createHmac,hkdfSync,timingSafeEqual} from 'node:crypto';
import {createPrivateGithubJsonStore} from '../fixedVehicleStore.js';
import {STAGE_ORIGIN,STAGE_SERVICE} from '../stageScope.js';
import {stagePostalReadToken} from './stagePostalAssets.js';

const repo='mingu0702-droid/freshon-cache', branch='stage/opsmap-postal-v1';
const prefix='opsmap-stage/postal-v1';
const headName='current-registration-head-v1.json';
const root='https://api.github.com/repos/'+repo;
const hex40=/^[a-f0-9]{40}$/, hex64=/^[a-f0-9]{64}$/;
const versionName=/^current-registration-object-[a-f0-9]{64}\.json$/;
const headSizeLimit=4096, objectSizeLimit=768*1024;
const binding=Buffer.from('opsmap-current-postal-registration-head-v1');
const error=()=>Error('POSTAL_REGISTRATION_STORE_INVALID');
const validRef=ref=>ref&&['registry','boundary','release','sha256'].every(key=>hex64.test(ref[key]||''));
const objectName=ref=>'current-registration-object-'+ref.sha256+'.json';

export const currentPostalRegistrationFallback=Object.freeze({
  ref:'a0b2746a9b7c7d85e728bf4f303bf02b5631a947',
  sha256:'03195e7bae0dffe989204d7a248c5c42ffdcde13887dca7a196d227c882cea50'
});

function headCodec(key){
  const hk=Buffer.from(hkdfSync('sha256',key,binding,Buffer.from('pointer-authentication'),32));
  const serialize=(current,previous)=>[current,previous].map(ref=>ref&&[ref.registry,ref.boundary,ref.release,ref.sha256]);
  const mac=(current,previous)=>createHmac('sha256',hk).update(JSON.stringify(serialize(current,previous))).digest();
  return {
    seal(current,previous){
      if(!validRef(current)||previous!==null&&!validRef(previous))throw error();
      return {schema:1,current,previous,mac:mac(current,previous).toString('hex')};
    },
    open(value){
      if(value===null)return {current:null,previous:null};
      if(value?.schema!==1||!validRef(value.current)||value.previous!==null&&!validRef(value.previous)||
          !hex64.test(value.mac||'')||!timingSafeEqual(Buffer.from(value.mac,'hex'),mac(value.current,value.previous)))throw error();
      return {current:value.current,previous:value.previous};
    }
  };
}

export function createStageCurrentPostalRefreshStore({env=process.env,fetchImpl=fetch,write=false,now=Date.now}={}) {
  if(env.RENDER_SERVICE_ID!==STAGE_SERVICE||env.RENDER_EXTERNAL_URL!==STAGE_ORIGIN||
      env.OPSMAP_STAGE_SYNC_REMOTE_APPROVED!=='1'||env.OPSMAP_STAGE_CURRENT_POSTAL_REFRESH_APPROVED!=='1'||
      write&&(env.OPSMAP_STAGE_SYNC_PUBLISH_APPROVED!=='1'||env.OPSMAP_STAGE_CURRENT_POSTAL_REFRESH_WRITE_APPROVED!=='1'))return null;
  const encoded=env.OPSMAP_SHADOW_POSTAL_ASSET_KEY_B64||'', key=Buffer.from(encoded,'base64');
  const token=write?env.OPSMAP_STAGE_SYNC_WRITE_TOKEN:stagePostalReadToken(env);
  if(!token||key.length!==32||key.toString('base64')!==encoded)throw error();
  const api=createPrivateGithubJsonStore({now,env:{GITHUB_CACHE_REPO:repo,GITHUB_CACHE_DIR:prefix,GITHUB_CACHE_BRANCH:branch,GITHUB_TOKEN:token},
    fetchImpl(input,options={}){
      const url=new URL(input),address=url.origin+url.pathname,method=options.method||'GET';
      const base=root+'/contents/'+prefix+'/';
      const name=address.startsWith(base)?address.slice(base.length):'';
      const known=name===headName||versionName.test(name);
      const read=method==='GET'&&(address===root&&!url.search||
        known&&url.searchParams.size===1&&url.searchParams.get('ref')===branch);
      const update=write&&method==='PUT'&&known&&!url.search&&JSON.parse(options.body).branch===branch;
      if((!read&&!update)||url.username||url.password||url.hash)throw error();
      return fetchImpl(input,{...options,redirect:'error'});
    }});
  const codec=headCodec(key);
  return {
    key,
    async readHead(){
      if(!write)return codec.open(await api.readRaw(headName,headSizeLimit));
      const {sha,value}=await api.read(headName);
      if(value!==null&&(!hex40.test(sha||'')||Buffer.byteLength(JSON.stringify(value))>headSizeLimit))throw error();
      return {...codec.open(value),etag:sha};
    },
    async readObject(ref){
      if(!validRef(ref))throw error();
      const value=await api.readRaw(objectName(ref),objectSizeLimit);
      if(value?.schema!==1||typeof value.sealed!=='string'||value.sealed.length>objectSizeLimit)throw error();
      const bytes=Buffer.from(value.sealed,'base64');
      if(bytes.toString('base64')!==value.sealed)throw error();
      return bytes;
    },
    ...(write?{
      createObject(ref,bytes){
        if(!validRef(ref)||!Buffer.isBuffer(bytes)||bytes.length>512*1024)throw error();
        return api.write(objectName(ref),{schema:1,sealed:bytes.toString('base64')},null);
      },
      writeHead:(current,previous,etag)=>api.write(headName,codec.seal(current,previous),etag)
    }:{})
  };
}
