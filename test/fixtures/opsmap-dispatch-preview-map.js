/* Local browser fixture for the dispatch preview. It emulates only existing SDK interfaces. */
(() => {
  const layers=new Set();
  const trigger=(target,name,event)=>target.listeners?.get(name)?.forEach(fn=>fn(event));
  class LatLng {
    constructor(lat,lng){this.lat=lat;this.lng=lng;}
    getLat(){return this.lat;}
    getLng(){return this.lng;}
  }
  class LatLngBounds {
    constructor(a,b){this.points=[];if(a)this.extend(a);if(b)this.extend(b);}
    extend(point){this.points.push(point);}
    getSouthWest(){return this.corner(Math.min);}
    getNorthEast(){return this.corner(Math.max);}
    corner(fn){return new LatLng(fn(...this.points.map(p=>p.lat)),fn(...this.points.map(p=>p.lng)));}
  }
  const svg=(name)=>document.createElementNS('http://www.w3.org/2000/svg',name);
  class FixtureMap {
    constructor(element,{center,level}){
      this.el=element;this.center=center;this.level=level;this.listeners=new Map();
      this.outlines=svg('svg');
      Object.assign(this.outlines.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none'});
      this.surface=document.createElement('div');
      Object.assign(this.surface.style,{position:'absolute',inset:'0',backgroundColor:'#edf2f2',
        backgroundImage:'linear-gradient(#dce5e8 1px, transparent 1px),linear-gradient(90deg,#dce5e8 1px,transparent 1px)',
        backgroundSize:'34px 34px',touchAction:'none'});
      this.surface.setAttribute('aria-label','Kakao SDK 테스트 지도');
      element.append(this.surface,this.outlines);
      this.surface.addEventListener('wheel',event=>{
        event.preventDefault();trigger(this,'zoom_start');
        this.setLevel(this.level+Math.sign(event.deltaY));
      },{passive:false});
      let start;
      this.surface.addEventListener('pointerdown',event=>{
        start={x:event.clientX,y:event.clientY,center:this.center,moved:false};
        this.surface.setPointerCapture(event.pointerId);
      });
      this.surface.addEventListener('pointermove',event=>{
        if(!start)return;
        const dx=event.clientX-start.x,dy=event.clientY-start.y;
        if (!start.moved&&Math.hypot(dx,dy)<4) return;
        if(!start.moved)trigger(this,'dragstart');
        start.moved=true;
        this.center=new LatLng(start.center.lat+dy/this.scale(),start.center.lng-dx/this.scale());
        this.relayout();
      });
      this.surface.addEventListener('pointerup',event=>{
        if(!start)return;
        const moved=start.moved;start=null;
        if(moved){trigger(this,'dragend');this.update('center_changed');}
        else trigger(this,'click',{latLng:this.getProjection().coordsFromContainerPoint({
          x:event.offsetX,y:event.offsetY,
        })});
      });
    }
    scale(){return 150000*2**(4-this.level);}
    getCenter(){return this.center;}
    getLevel(){return this.level;}
    setCenter(point){this.center=point;this.update('center_changed');}
    setLevel(level){this.level=Math.min(14,Math.max(1,level));this.update('zoom_changed');}
    panTo(point){this.setCenter(point);}
    panBy(x,y){this.setCenter(new LatLng(this.center.lat-y/this.scale(),this.center.lng+x/this.scale()));}
    setBounds(bounds,top=32,right=32,bottom=32,left=32){
      const sw=bounds.getSouthWest(),ne=bounds.getNorthEast();
      const fit=Math.min((this.el.clientWidth-left-right)/Math.max(.00001,ne.lng-sw.lng),
        (this.el.clientHeight-top-bottom)/Math.max(.00001,ne.lat-sw.lat));
      this.level=Math.min(14,Math.max(1,Math.ceil(4-Math.log2(Math.max(1,fit)/150000))));
      this.setCenter(new LatLng((sw.lat+ne.lat)/2,(sw.lng+ne.lng)/2));
    }
    getBounds(){
      const p=this.getProjection(),{clientWidth:w,clientHeight:h}=this.el;
      return new LatLngBounds(p.coordsFromContainerPoint({x:0,y:h}),p.coordsFromContainerPoint({x:w,y:0}));
    }
    getProjection(){
      const {clientWidth:w,clientHeight:h}=this.el, s=this.scale(), c=this.center;
      const project=p=>({x:w/2+(p.lng-c.lng)*s,y:h/2+(c.lat-p.lat)*s});
      const invert=p=>new LatLng(c.lat+(h/2-p.y)/s,c.lng+(p.x-w/2)/s);
      return {containerPointFromCoords:project,pointFromCoords:project,coordsFromContainerPoint:invert,coordsFromPoint:invert};
    }
    relayout(){for(const layer of layers)if(layer.map===this)layer.draw();}
    update(name){this.relayout();trigger(this,name);trigger(this,'bounds_changed');trigger(this,'idle');}
  }
  class CustomOverlay {
    constructor(options){this.options=options;this.anchor=document.createElement('div');this.anchor.style.position='absolute';this.anchor.append(options.content);}
    setMap(map){
      this.anchor.remove();this.map=map;layers.delete(this);
      if(map){layers.add(this);map.el.append(this.anchor);this.draw();}
    }
    setZIndex(value){this.options.zIndex=value;this.anchor.style.zIndex=value;}
    setPosition(position){this.options.position=position;this.draw();}
    getContent(){return this.options.content;}
    draw(){
      if(!this.map)return;
      const {x,y}=this.map.getProjection().containerPointFromCoords(this.options.position);
      Object.assign(this.anchor.style,{left:x+'px',top:y+'px',zIndex:this.options.zIndex||2,
        transform:'translate('+(-100*(this.options.xAnchor??.5))+'%,'+(-100*(this.options.yAnchor??.5))+'%)'});
    }
  }
  class Vector {
    constructor(options){this.options=options;this.path=svg('path');this.path.setAttribute('fill-rule','evenodd');}
    setMap(map){this.path.remove();this.map=map;layers.delete(this);if(map){layers.add(this);map.outlines.append(this.path);this.draw();}}
    setOptions(options){Object.assign(this.options,options);this.draw();}
    setPath(path){this.setOptions({path});}
    draw(){
      if(!this.map||!this.options.path?.length)return;
      const project=this.map.getProjection().containerPointFromCoords;
      const rings=Array.isArray(this.options.path[0])?this.options.path:[this.options.path];
      this.path.setAttribute('d',rings.map(ring=>ring.map((point,index)=>{
        const {x,y}=project(point);return (index?'L':'M')+x+','+y;
      }).join(' ') + (this.closed?' Z':'')).join(' '));
      this.path.setAttribute('stroke',this.options.strokeColor||'none');
      this.path.setAttribute('stroke-width',this.options.strokeWeight||1);
      this.path.setAttribute('fill',this.options.fillColor||'none');
      this.path.setAttribute('fill-opacity',this.options.fillOpacity||0);
    }
  }
  class Polygon extends Vector {closed=true;}
  class Circle {
    setMap(){}
    getBounds(){return new LatLngBounds();}
  }
  window.kakao={maps:{Map:FixtureMap,LatLng,LatLngBounds,CustomOverlay,Polygon,Polyline:Vector,Circle,
    load:callback=>callback(),event:{
      addListener(target,name,fn){target.listeners??=new Map();if(!target.listeners.has(name))target.listeners.set(name,new Set());target.listeners.get(name).add(fn);},
      removeListener(target,name,fn){target.listeners?.get(name)?.delete(fn);},trigger,preventMap(){},
    }}};
})();
