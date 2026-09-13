// Containment only: keep map geometry/status, never expose operational secrets.
export function redactPublicData(value) {
  if (Array.isArray(value)) return value.map(redactPublicData);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/password|passwd|pwd|rawmemo|message|memo|remark|access|securitykey|door|entrycode|phone|tel(?:ephone)?$|claim|comment|requesttext|detailaddress|비밀번호|비번|출입|보안키|요청사항|메모|특이사항|전화|연락처|클레임/i.test(key.replace(/[_\s-]/g,''))).map(([k,v])=>[k,redactPublicData(v)]));
}
export function generalMapResponse(req,res,next) {
  const detailRequest=req.path==='/detail';
  const json=res.json.bind(res);
  res.setHeader('Cache-Control','no-store');
  res.json=value=>{
    let clean=redactPublicData(value);
    if(detailRequest && clean?.data) clean={...clean,data:Object.fromEntries(['customerCode','customerName','address','vehicle','status'].map(k=>[k,clean.data[k]??null]))};
    return json(clean);
  };
  next();
}
