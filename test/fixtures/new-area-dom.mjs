export function batchDomNode() {
  let html='';
  const children=[];
  return {value:'',textContent:'',disabled:false,children,setAttribute(){},removeAttribute(){},
    classList:{add(){},remove(){}},
    get innerHTML(){return html+children.map(child=>child.html).join('');},
    set innerHTML(value){html=value;children.length=0;},
    replaceChildren(){this.innerHTML='';},
    insertBefore(child,next){children.splice(next?children.indexOf(next):children.length,0,child);child.remove=()=>children.splice(children.indexOf(child),1);},
    querySelectorAll(){return children;}};
}
export function batchDomTemplate() {
  return {content:{},set innerHTML(html){this.content.firstElementChild={html,dataset:{judged:/data-judged="(\d+)"/.exec(html)[1]}};}};
}
