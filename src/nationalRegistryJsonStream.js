// ciList returns whole customer records, including fields the registry never uses.
// Validate the JSON envelope without keeping more than one source value in memory.
export function nationalRegistryEnvelope(rowsKey, totalField, acceptRow) {
  let state='start', key, token=null, declared, rowCount=0, hasRows=false, hasTotal=false;
  const invalid=()=>{throw new SyntaxError('NATIONAL_REGISTRY_SOURCE_CONTRACT');};
  const space=c=>c===' '||c==='\t'||c==='\r'||c==='\n';
  const startToken=(delimiters,accept)=>{token={delimiters,accept,parts:[],depth:0,string:false,escaped:false};};
  const afterRows=()=>{state=rowsKey===null?'end':'afterRows';};
  function write(text) {
    let offset=0;
    while(offset<text.length) {
      if(token) {
        const part=token, start=offset;
        while(offset<text.length) {
          const c=text[offset];
          if(part.string) {
            if(part.escaped)part.escaped=false;
            else if(c==='\\')part.escaped=true;
            else if(c==='"')part.string=false;
          }else if(part.depth===0&&part.delimiters.includes(c))break;
          else if(c==='"')part.string=true;
          else if(c==='{'||c==='[')part.depth++;
          else if((c==='}'||c===']')&&--part.depth<0)invalid();
          offset++;
        }
        if(offset>start)part.parts.push(text.slice(start,offset));
        if(offset===text.length)return;
        const delimiter=text[offset++];
        token=null;
        part.accept(JSON.parse(part.parts.length===1?part.parts[0]:part.parts.join('')),delimiter);
        continue;
      }
      const c=text[offset];
      if(space(c)){offset++;continue;}
      if(state==='start') {
        if(rowsKey===null&&c==='['){hasRows=true;state='firstRow';}
        else if(rowsKey!==null&&c==='{')state='firstKey';
        else invalid();
        offset++;
      }else if(state==='firstKey'&&c==='}'){
        state='end';offset++;
      }else if(state==='firstKey'||state==='key'){
        if(c!=='"')invalid();
        startToken(':',value=>{
          if(typeof value!=='string')invalid();
          key=value;state='value';
        });
      }else if(state==='value'){
        if(key===rowsKey){
          if(hasRows||c!=='[')invalid();
          hasRows=true;state='firstRow';offset++;
        }else startToken(',}',(value,delimiter)=>{
          if(key===totalField){
            if(hasTotal)invalid();
            hasTotal=true;declared=value;
          }
          state=delimiter===','?'key':'end';
        });
      }else if(state==='firstRow'&&c===']'){
        afterRows();offset++;
      }else if(state==='firstRow'||state==='row'){
        startToken(',]',(value,delimiter)=>{
          acceptRow(value,rowCount++);
          if(delimiter===']')afterRows();
          else state='row';
        });
      }else if(state==='afterRows'&&(c===','||c==='}')){
        state=c===','?'key':'end';offset++;
      }else invalid();
    }
  }
  return {
    write,
    finish(){
      if(state!=='end'||token||!hasRows)invalid();
      return rowsKey===null&&totalField==='length'?rowCount:declared;
    }
  };
}
