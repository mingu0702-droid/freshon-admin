(function(root){
  'use strict';

  const cellSize = 8;
  const hitRadius = 6;
  const cellKey = (x,y) => Math.floor(x/cellSize)+':'+Math.floor(y/cellSize);

  function createDots(map, container){
    const canvas = document.createElement('canvas');
    canvas.className = 'newAreaViewportDots';
    canvas.setAttribute('aria-hidden','true');
    const context = canvas.getContext('2d');
    let overlay, position, bins = new Map();

    function draw(rows, positionFor, selectedCode){
      const width = container.clientWidth, height = container.clientHeight;
      if(!width || !height || !context){ clear(); return 0; }
      const scale = Math.min(root.devicePixelRatio || 1, 2);
      if(canvas.width !== Math.ceil(width*scale)) canvas.width = Math.ceil(width*scale);
      if(canvas.height !== Math.ceil(height*scale)) canvas.height = Math.ceil(height*scale);
      canvas.style.width = width+'px';
      canvas.style.height = height+'px';
      context.setTransform(scale,0,0,scale,0,0);
      context.clearRect(0,0,width,height);
      context.fillStyle = '#22588d';
      bins.clear();
      const projection = map.getProjection();
      let count = 0, selected;
      for(const row of rows){
        const {x,y} = projection.containerPointFromCoords(positionFor(row));
        if(!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const key = cellKey(x,y);
        let bin = bins.get(key);
        if(!bin){ bin=[]; bins.set(key,bin); }
        bin.push({x,y,row});
        context.fillRect(x-1.5,y-1.5,3,3);
        if(row.customerCode===selectedCode) selected={x,y};
        count++;
      }
      if(selected){
        context.fillStyle='#fff'; context.fillRect(selected.x-5,selected.y-5,10,10);
        context.fillStyle='#1b4380'; context.fillRect(selected.x-3,selected.y-3,6,6);
      }
      const center = map.getCenter();
      const pixel = projection.containerPointFromCoords(center);
      canvas.style.translate = `${-pixel.x}px ${-pixel.y}px`;
      if(!overlay){
        overlay = new root.kakao.maps.CustomOverlay({content:canvas,position:center,xAnchor:0,yAnchor:0,zIndex:0});
        overlay.setMap(map);
        if(canvas.parentElement&&canvas.parentElement!==container)canvas.parentElement.style.pointerEvents='none';
      }else if(position?.getLat()!==center.getLat() || position?.getLng()!==center.getLng()) overlay.setPosition(center);
      position=center;
      return count;
    }

    function hit(latLng){
      if(!overlay || !latLng) return [];
      const {x,y} = map.getProjection().containerPointFromCoords(latLng);
      const left=Math.floor((x-hitRadius)/cellSize), right=Math.floor((x+hitRadius)/cellSize);
      const top=Math.floor((y-hitRadius)/cellSize), bottom=Math.floor((y+hitRadius)/cellSize);
      const found=[];
      for(let col=left;col<=right;col++){
        for(let line=top;line<=bottom;line++){
          for(const point of bins.get(col+':'+line)||[]){
            const distance=(x-point.x)**2+(y-point.y)**2;
            if(distance<=hitRadius**2) found.push({row:point.row,distance});
          }
        }
      }
      return found.sort((a,b)=>a.distance-b.distance||a.row.customerCode.localeCompare(b.row.customerCode)).map(item=>item.row);
    }

    function clear(){
      overlay?.setMap(null);
      overlay=position=null;
      bins.clear();
      canvas.width=canvas.height=0;
    }

    return {draw,hit,clear};
  }

  root.MapNewAreaViewport=Object.freeze({createDots});
})(typeof window==='object'?window:globalThis);
