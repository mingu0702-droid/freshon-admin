import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {decodePostalTile,POSTAL_TILE_LIMIT} from '../../public/opsmap/postal-geometry.mjs';
import {boundedRead} from './coverageFiles.js';
import {createStagePostalAssets} from './stagePostalAssets.js';

const invalid=()=>Error('POSTAL_REGISTRATION_REFRESH_GEOMETRY');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const boundedCode=/^[A-Z]\d{1,20}$/;
const validBox=box=>Array.isArray(box)&&box.length===4&&box.every(Number.isFinite)&&box[0]<box[2]&&box[1]<box[3];

export async function createStageCurrentPostalProjectInputs({env,fetchImpl=fetch,log=()=>{}}) {
  const temporary=await mkdtemp(join(tmpdir(),'opsmap-postal-refresh-'));
  let asset;
  try{asset=createStagePostalAssets({env,fetchImpl,tempRoot:temporary,log});}
  catch(error){await rm(temporary,{recursive:true,force:true});throw error;}
  if(!asset){await rm(temporary,{recursive:true,force:true});throw invalid();}
  const {boundary,release}=asset.config;
  let base;
  const openBase=()=>base??=asset.base();
  return {
    binding:{boundary,release},
    async readLegacyRegistration(){
      const {directory}=await openBase();
      const packed=await boundedRead(join(directory,'postal-release.json.gz'),1024*1024);
      if(sha(packed)!==release)throw invalid();
      const value=JSON.parse(gunzipSync(packed,{maxOutputLength:8*1024*1024}));
      if(value?.boundary!==boundary||value.generation!==asset.config.generation||
          value.schema!=='opsmap-postal-release-v1'||!Array.isArray(value.stores)||value.stores.length>15000)throw invalid();
      const codes=new Set(),seen=new Set();
      for(const entry of value.stores){
        if(!Array.isArray(entry)||entry.length!==4)throw invalid();
        const [code,,registered]=entry;
        if(typeof code!=='string'||!boundedCode.test(code)||seen.has(code)||typeof registered!=='boolean')throw invalid();
        seen.add(code);
        if(registered)codes.add(code);
      }
      return codes;
    },
    async *readDetailTiles(candidates){
      const {geometry}=await openBase();
      const bytes=await boundedRead(join(geometry,'manifest.json'),1024*1024);
      if(sha(bytes)!==boundary)throw invalid();
      const manifest=JSON.parse(bytes),tiles=manifest.tiers?.detail;
      if(manifest.schema!=='opsmap-postal-geometry-v1'||!Array.isArray(tiles)||!tiles.length||tiles.length>4096)throw invalid();
      const seen=new Set();let count=0;
      for(const tile of tiles){
        if(!/^detail-\d{1,3}-\d{1,3}-\d{1,2}$/.test(tile.id)||seen.has(tile.id)||!validBox(tile.box)||
            !Number.isSafeInteger(tile.count)||tile.count<1||tile.count>10000||
            !Number.isSafeInteger(tile.bytes)||tile.bytes<1||tile.bytes>POSTAL_TILE_LIMIT||
            !Number.isSafeInteger(tile.rawBytes)||tile.rawBytes<1||tile.rawBytes>POSTAL_TILE_LIMIT||
            !/^[a-f0-9]{64}$/.test(tile.sha256))throw invalid();
        seen.add(tile.id);count+=tile.count;
      }
      if(count!==manifest.count)throw invalid();
      const relevant=tiles.filter(({box:[west,south,east,north]})=>candidates.some(({verifiedLocation:{lat,lng}})=>
        west<=lng&&lng<=east&&south<=lat&&lat<=north));
      if(!relevant.length)return;
      const folder=await asset.tiles('detail');
      for(const tile of relevant){
        const packed=await boundedRead(join(folder,tile.id+'.gz'),tile.bytes);
        if(packed.length!==tile.bytes||sha(packed)!==tile.sha256)throw invalid();
        const raw=gunzipSync(packed,{maxOutputLength:tile.rawBytes});
        if(raw.length!==tile.rawBytes)throw invalid();
        const zones=decodePostalTile(raw);
        if(zones.length!==tile.count)throw invalid();
        yield {box:tile.box,zones};
      }
    },
    async dispose(){await rm(temporary,{recursive:true,force:true});}
  };
}
