const official='https://www.data.go.kr/data/15129688/fileData.do';
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k);
export function prepareAdminBoundaries(data){
 const m=data?.metadata;
 if(data?.type!=='FeatureCollection'||!Array.isArray(data.features)||!data.features.length||data.features.length>4000||m?.sourceUrl!==official||m.boundaryType!=='ADMINISTRATIVE_EMD'||m.codeSystem!=='SGIS_ADM_8'||m.crs!=='EPSG:4326'||m.sourceCrs!=='EPSG:5179'||m.baseDate!=='2025-06-30'||m.license!=='PUBLIC_DATA_UNRESTRICTED')throw Error('ADMIN_BOUNDARIES_INVALID');
 let vertices=0;const seen=new Set();
 const features=data.features.map(f=>{
  const code=f?.properties?.adm_cd,geometry=f?.geometry;
  if(f?.type!=='Feature'||typeof code!=='string'||!/^\d{8}$/.test(code)||seen.has(code)||!['Polygon','MultiPolygon'].includes(geometry?.type))throw Error('ADMIN_BOUNDARIES_INVALID');
  seen.add(code);const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates,bbox=[Infinity,Infinity,-Infinity,-Infinity];
  if(!Array.isArray(polygons)||!polygons.length)throw Error('ADMIN_BOUNDARIES_INVALID');
  for(const polygon of polygons){
   if(!Array.isArray(polygon)||!polygon.length)throw Error('ADMIN_BOUNDARIES_INVALID');
   for(const ring of polygon){
    if(!Array.isArray(ring)||ring.length<4)throw Error('ADMIN_BOUNDARIES_INVALID');
    for(const p of ring){if(!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)||p[0]<124||p[0]>132||p[1]<33||p[1]>39.5||++vertices>9000000)throw Error('ADMIN_BOUNDARIES_INVALID');bbox[0]=Math.min(bbox[0],p[0]);bbox[1]=Math.min(bbox[1],p[1]);bbox[2]=Math.max(bbox[2],p[0]);bbox[3]=Math.max(bbox[3],p[1]);}
    if(ring[0][0]!==ring.at(-1)[0]||ring[0][1]!==ring.at(-1)[1])throw Error('ADMIN_BOUNDARIES_INVALID');
   }
  }
  return {feature:f,bbox,code};
 });
 return {metadata:m,features};
}
// Ring interiors and their edges are distinguished so a lake/hole never becomes land.
function ringLocation([x,y],ring){
 let inside=false;
 for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const [ax,ay]=ring[j],[bx,by]=ring[i],dx=bx-ax,dy=by-ay;
  if((dx!==0||dy!==0)&&Math.abs((x-ax)*dy-(y-ay)*dx)<=1e-12&&x>=Math.min(ax,bx)-1e-12&&x<=Math.max(ax,bx)+1e-12&&y>=Math.min(ay,by)-1e-12&&y<=Math.max(ay,by)+1e-12)return 0;
  if((ay>y)!==(by>y)&&x<(bx-ax)*(y-ay)/(by-ay)+ax)inside=!inside;
 }
 return inside?1:-1;
}
export function pointInGeometry(point,geometry){
 const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.type==='MultiPolygon'?geometry.coordinates:[];
 return polygons.some(rings=>ringLocation(point,rings[0])>=0&&!rings.slice(1).some(ring=>ringLocation(point,ring)>=0));
}
export function matchingAdminFeatures(point,prepared){
 if(!prepared||!Number.isFinite(point?.lat)||!Number.isFinite(point?.lng))return [];
 return prepared.features.filter(({bbox,feature})=>point.lng>=bbox[0]&&point.lng<=bbox[2]&&point.lat>=bbox[1]&&point.lat<=bbox[3]&&pointInGeometry([point.lng,point.lat],feature.geometry)).map(row=>row.feature);
}
