import {createHash} from 'node:crypto';

export const transferVersion = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Reuse the encoded representation for the same installed rows and metadata.
export function createSnapshotTransfer() {
  const projections=new WeakMap();
  return function snapshotTransfer(rows,meta,project=values=>values) {
    const stamp=JSON.stringify(meta);
    let current=projections.get(rows);
    if(current?.stamp!==stamp) {
      const body=Buffer.from(JSON.stringify({ok:true,data:project(rows),meta,error:null}));
      const version=createHash('sha256').update(body).digest('hex');
      current={stamp,body,version};
      projections.set(rows,current);
    }
    return current;
  };
}

export function sendSnapshotTransfer(req,res,projection,meta) {
  res.set('Cache-Control','private, no-store').vary('Cookie')
    .set('X-Opsmap-Transfer-Version',projection.version);
  if(req.get('X-Opsmap-Known-Snapshot')===projection.version) return res.json({ok:true,notModified:true,meta});
  return res.type('application/json').send(projection.body);
}
