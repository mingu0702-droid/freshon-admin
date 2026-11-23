(function(root){
  'use strict';

  function records(input, delimiter){
    const result=[];
    let start=0,fieldStart=0,fields=[],value='',quoted=false;
    function addField(end){
      fields.push({start:fieldStart,end,value});
      value='';
    }
    function addRecord(end){
      addField(end);
      result.push({start,end,fields,ambiguous:quoted||fields.length>2});
      fields=[];
    }
    for(let i=0;i<input.length;i++){
      const c=input[i];
      if(c==='"'&&(quoted||!value.trim())){
        if(quoted&&input[i+1]==='"'){value+='"';i++;}
        else quoted=!quoted;
      }else if(!quoted&&c===delimiter){
        addField(i);fieldStart=i+1;
      }else if(!quoted&&(c==='\n'||c==='\r'&&input[i+1]==='\n')){
        addRecord(i);
        if(c==='\r')i++;
        start=fieldStart=i+1;
      }else value+=c;
    }
    if(start<input.length)addRecord(input.length);
    return result;
  }

  function replace(input,index,expectedOriginalInput,changes,{format='tsv'}={}){
    const delimiter=format==='tsv'?'\t':format==='csv'?',':null;
    if(!delimiter||typeof input!=='string'||!Number.isSafeInteger(index)||index<0||
       typeof expectedOriginalInput!=='string'||!changes||typeof changes!=='object')return null;
    const target=records(input,delimiter)[index];
    if(!target||target.ambiguous||input.slice(target.start,target.end)!==expectedOriginalInput)return null;
    const {fields}=target, edits=[];
    for(const [column,key] of ['address','customer'].entries()){
      if(!Object.hasOwn(changes,key))continue;
      const next=changes[key];
      if(typeof next!=='string'||(!column&&!next.trim()))return null;
      const field=fields[column];
      const bom=field?.start===0&&input.charCodeAt(0)===0xfeff?'\ufeff':'';
      if(field?.value.replace(/^\ufeff/,'')===next||!field&&!next)continue;
      const encoded=next.includes(delimiter)||/["\r\n]/.test(next)?'"'+next.replace(/"/g,'""')+'"':next;
      edits.push({start:field?.start??target.end,end:field?.end??target.end,text:field?bom+encoded:delimiter+encoded});
    }
    let originalInput=expectedOriginalInput;
    for(const edit of edits.reverse()){
      const start=edit.start-target.start,end=edit.end-target.start;
      originalInput=originalInput.slice(0,start)+edit.text+originalInput.slice(end);
    }
    return {index, originalInput, input:input.slice(0,target.start)+originalInput+input.slice(target.end)};
  }

  root.MapNewAreaRowEdit=Object.freeze({replace});
})(typeof window==='object'?window:globalThis);
