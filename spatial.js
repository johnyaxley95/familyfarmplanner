// spatial.js — Stage 5 merge: terrain analysis + Site Model emission
// Sourced from terrain_lidar.html stages 1–4; map init is lazy (call initSpatialMap()).

const DARLINGTON=[-31.9156,116.0752];
const TERRAIN3D="https://elevation3d.arcgis.com/arcgis/rest/services/WorldElevation3D/Terrain3D/ImageServer";
const MAXPTS_NET=800, MAXPTS_LIDAR=6000, MAXDIM_READ=700;

// CRS registry — renamed PROJ_ZONES to avoid conflict with planner's ZONES (climate zones)
const PROJ_ZONES={
  28349:"+proj=utm +zone=49 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  28350:"+proj=utm +zone=50 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  28351:"+proj=utm +zone=51 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  7849:"+proj=utm +zone=49 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  7850:"+proj=utm +zone=50 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  7851:"+proj=utm +zone=51 +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
  4283:"+proj=longlat +ellps=GRS80 +no_defs",
  4326:"+proj=longlat +datum=WGS84 +no_defs"
};
const ZONE_NAMES={28349:"GDA94 / MGA Z49",28350:"GDA94 / MGA Z50",28351:"GDA94 / MGA Z51",
  7849:"GDA2020 / MGA Z49",7850:"GDA2020 / MGA Z50",7851:"GDA2020 / MGA Z51",
  4283:"GDA94 geographic",4326:"WGS84 geographic"};
Object.entries(PROJ_ZONES).forEach(([k,v])=>proj4.defs("EPSG:"+k,v));
const isGeographic=code=>code==4326||code==4283;

// Map and init state — map created lazily by initSpatialMap()
let map=null, esri=null, osm=null, slip=null;
let spatialInitialized=false;

// Mutable spatial state
let searchMarker=null;
let boundary=null;
const CADASTRE_SVC="https://services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Property_and_Planning/MapServer";
let cadastreLayerId=null, parcelMode=false;
let overlay=null;
let lidar=null, pendingImage=null;
let sampled=null, analysis=null, activeLayer="relief", design=null, vectorLayers=[];

// ---- shared helpers --------------------------------------------------------
function lerp(a,b,t){return a+(b-a)*t;}
function metersBetween(a,b){return turf.distance(a,b,{units:"meters"});}
function minMax(arr){ let mn=Infinity,mx=-Infinity; for(let i=0;i<arr.length;i++){ const v=arr[i]; if(v===null||isNaN(v))continue; if(v<mn)mn=v; if(v>mx)mx=v; } return [mn,mx]; }
function tint(t){
  const stops=[[0,[48,78,40]],[0.5,[150,144,79]],[1,[225,222,208]]];
  let a=stops[0],b=stops[stops.length-1];
  for(let i=0;i<stops.length-1;i++){if(t>=stops[i][0]&&t<=stops[i+1][0]){a=stops[i];b=stops[i+1];break;}}
  const lt=(t-a[0])/((b[0]-a[0])||1);return [0,1,2].map(k=>Math.round(lerp(a[1][k],b[1][k],lt)));
}
function renderRelief(grid,rows,cols,emin,emax,wgsBounds,nullMask){
  let _sum=0,_cnt=0; for(let i=0;i<grid.length;i++){const v=grid[i]; if(v!==null&&!isNaN(v)){_sum+=v;_cnt++;}}
  const _mean=_cnt?_sum/_cnt:0;
  const fv=i=>{const v=grid[i]; return (v===null||isNaN(v))?_mean:v;};
  const cv=document.createElement("canvas"); cv.width=cols; cv.height=rows;
  const ctx=cv.getContext("2d"); const img=ctx.createImageData(cols,rows);
  const range=(emax-emin)||1;
  const az=315*Math.PI/180, zen=(90-45)*Math.PI/180;
  const [w,s,e,n]=wgsBounds;
  const csx=metersBetween([w,s],[e,s])/(cols-1), csy=metersBetween([w,s],[w,n])/(rows-1);
  const z=(r,c)=>{r=Math.max(0,Math.min(rows-1,r));c=Math.max(0,Math.min(cols-1,c));return fv(r*cols+c);};
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
    const dzdx=((z(r,c+1)-z(r,c-1))/(2*csx))||0, dzdy=((z(r+1,c)-z(r-1,c))/(2*csy))||0;
    const slope=Math.atan(Math.sqrt(dzdx*dzdx+dzdy*dzdy));
    const aspect=Math.atan2(dzdy,-dzdx);
    let hs=Math.cos(zen)*Math.cos(slope)+Math.sin(zen)*Math.sin(slope)*Math.cos(az-aspect); hs=Math.max(0,hs);
    const col=tint((fv(r*cols+c)-emin)/range), shade=0.4+0.6*hs, o=(r*cols+c)*4;
    img.data[o]=Math.round(col[0]*shade); img.data[o+1]=Math.round(col[1]*shade); img.data[o+2]=Math.round(col[2]*shade);
    img.data[o+3]=(nullMask&&nullMask[r*cols+c])?140:235;
  }
  ctx.putImageData(img,0,0);
  if(overlay) map.removeLayer(overlay);
  overlay=L.imageOverlay(cv.toDataURL(),[[s,w],[n,e]],{opacity:document.getElementById("sp-opacity").value/100}).addTo(map);
  map.fitBounds([[s,w],[n,e]],{padding:[20,20]});
}

// ---- LiDAR import ----------------------------------------------------------
async function loadLidar(image,code){
  const card=document.getElementById("sp-lidcard");
  card.innerHTML=`<div class="muted">Decoding raster…</div>`;
  const def="EPSG:"+code;
  const W=image.getWidth(),H=image.getHeight();
  const bbox=image.getBoundingBox();
  let nodata=image.getGDALNoData(); if(nodata!==null) nodata=+nodata;
  const midLat=DARLINGTON[0];
  const widthM = isGeographic(code) ? (bbox[2]-bbox[0])*111320*Math.cos(midLat*Math.PI/180) : (bbox[2]-bbox[0]);
  const heightM= isGeographic(code) ? (bbox[3]-bbox[1])*111320 : (bbox[3]-bbox[1]);
  const nativeCellM=widthM/W;
  const scale=Math.min(1,MAXDIM_READ/Math.max(W,H));
  const rw=Math.max(2,Math.round(W*scale)), rh=Math.max(2,Math.round(H*scale));
  const rasters=await image.readRasters({width:rw,height:rh,resampleMethod:"bilinear",interleave:false});
  const band=rasters[0];
  const data=new Float32Array(rw*rh);
  let nulls=0;
  for(let i=0;i<data.length;i++){
    let v=band[i];
    if(v===null||isNaN(v)||(nodata!==null&&Math.abs(v-nodata)<1e-3)||v<-1e6){ data[i]=NaN; nulls++; }
    else data[i]=v;
  }
  const workCellM=widthM/rw;
  lidar={data,cols:rw,rows:rh,bbox,code,def,nodata,workCellM,nativeCellM,nulls,widthM,heightM};
  const cn=[[bbox[0],bbox[3]],[bbox[2],bbox[3]],[bbox[0],bbox[1]],[bbox[2],bbox[1]]]
    .map(p=>proj4(def,"EPSG:4326",p));
  const lons=cn.map(p=>p[0]),lats=cn.map(p=>p[1]);
  lidar.wgs=[Math.min(...lons),Math.min(...lats),Math.max(...lons),Math.max(...lats)];
  const [emin,emax]=minMax(data);
  const nullMask=new Uint8Array(data.length); for(let i=0;i<data.length;i++) nullMask[i]=isNaN(data[i])?1:0;
  renderRelief(data,rh,rw,emin,emax,lidar.wgs,nullMask);
  const opt=document.querySelector('#sp-source option[value="lidar"]');
  opt.disabled=false; opt.textContent=`Imported LiDAR tile — ~${nativeCellM.toFixed(1)} m native`;
  document.getElementById("sp-source").value="lidar";
  card.innerHTML=`
    <div class="kv"><span>CRS</span><span>${ZONE_NAMES[code]||("EPSG:"+code)}</span></div>
    <div class="kv"><span>Native resolution</span><span>${nativeCellM.toFixed(2)} m</span></div>
    <div class="kv"><span>Sampling at (working)</span><span>${workCellM.toFixed(2)} m</span></div>
    <div class="kv"><span>Tile size</span><span>${(widthM).toFixed(0)} × ${(heightM).toFixed(0)} m</span></div>
    <div class="kv"><span>Elevation</span><span>${emin.toFixed(1)} – ${emax.toFixed(1)} m</span></div>
    <div class="kv"><span>Null cells</span><span>${nulls.toLocaleString()}</span></div>
    <div class="kv" id="sp-covrow"><span>Covers boundary</span><span>—</span></div>`;
  checkCoverage();
}

function lidarSample(lon,lat){
  if(!lidar) return null;
  const [X,Y]=proj4("EPSG:4326",lidar.def,[lon,lat]);
  const {bbox,cols,rows,data}=lidar;
  const fx=(X-bbox[0])/(bbox[2]-bbox[0])*cols-0.5;
  const fy=(bbox[3]-Y)/(bbox[3]-bbox[1])*rows-0.5;
  const x0=Math.floor(fx),y0=Math.floor(fy),x1=x0+1,y1=y0+1;
  if(x1<0||y1<0||x0>=cols||y0>=rows) return null;
  const gx=Math.max(0,Math.min(cols-1,x0)),gy=Math.max(0,Math.min(rows-1,y0));
  const gx1=Math.max(0,Math.min(cols-1,x1)),gy1=Math.max(0,Math.min(rows-1,y1));
  const v=[data[gy*cols+gx],data[gy*cols+gx1],data[gy1*cols+gx],data[gy1*cols+gx1]];
  const dx=fx-x0,dy=fy-y0;
  const wt=[(1-dx)*(1-dy),dx*(1-dy),(1-dx)*dy,dx*dy];
  let sw=0,sv=0;
  for(let i=0;i<4;i++){ if(!isNaN(v[i])){ sv+=v[i]*wt[i]; sw+=wt[i]; } }
  return sw>0? sv/sw : null;
}

function checkCoverage(){
  const row=document.getElementById("sp-covrow"); if(!row||!lidar) return;
  const span=row.querySelector("span:last-child");
  if(!boundary){ span.innerHTML='<span class="pill warn">no boundary</span>'; return; }
  const ring=boundary.toGeoJSON().geometry.coordinates[0];
  let inside=0;
  ring.forEach(([lon,lat])=>{ if(lon>=lidar.wgs[0]&&lon<=lidar.wgs[2]&&lat>=lidar.wgs[1]&&lat<=lidar.wgs[3]) inside++; });
  const pct=Math.round(inside/ring.length*100);
  span.innerHTML = pct===100 ? '<span class="pill ok">fully</span>' : (pct>0? `<span class="pill warn">${pct}%</span>` : '<span class="pill bad">outside tile</span>');
}

// ---- search ----------------------------------------------------------------
async function doSearch(){
  const q=document.getElementById("sp-q").value.trim(), note=document.getElementById("sp-searchnote");
  if(!q){note.textContent="Type an address or locality first.";return;}
  note.textContent="Searching…";
  try{
    const r=await fetch("https://nominatim.openstreetmap.org/search?format=json&countrycodes=au&limit=1&q="+encodeURIComponent(q),{headers:{Accept:"application/json"}});
    const j=await r.json();
    if(!j.length){note.textContent="No match — pan manually.";return;}
    map.setView([+j[0].lat,+j[0].lon],16);
    if(searchMarker) map.removeLayer(searchMarker);
    searchMarker=L.circleMarker([+j[0].lat,+j[0].lon],{radius:7,color:"#9cbb57",weight:2,fillOpacity:.3}).addTo(map);
    note.textContent=j[0].display_name.split(",").slice(0,3).join(",");
  }catch(e){note.textContent="Search unavailable — pan manually.";}
}

// ---- click-a-parcel (WA public cadastre) -----------------------------------
async function findCadastreLayer(){
  if(cadastreLayerId!==null) return cadastreLayerId;
  const r=await fetch(CADASTRE_SVC+"/layers?f=json");
  const j=await r.json();
  const lyr=(j.layers||[]).find(l=>/^Cadastre \(No Attributes\)/i.test(l.name)) || (j.layers||[]).find(l=>/cadastre/i.test(l.name)&&l.geometryType==="esriGeometryPolygon");
  cadastreLayerId = lyr? lyr.id : -1;
  return cadastreLayerId;
}
function setParcelMode(on){
  parcelMode=on;
  const btn=document.getElementById("sp-parcelMode");
  btn.classList.toggle("on",on); btn.style.background=on?"var(--accent)":""; btn.style.color=on?"#15170f":"";
  document.getElementById("sp-parcelnote").textContent = on ? "Click your block on the map to load its legal boundary." : "";
  map.getContainer().style.cursor = on ? "crosshair" : "";
}

// ---- elevation fetchers (network) ------------------------------------------
function nearestIndex(loc,points,tolDeg){
  let bi=-1,bd=Infinity;
  for(let i=0;i<points.length;i++){const dx=points[i][0]-loc.x,dy=points[i][1]-loc.y,d=dx*dx+dy*dy; if(d<bd){bd=d;bi=i;}}
  return bd<=tolDeg*tolDeg?bi:-1;
}
async function terrain3d(points,spacingDeg){
  const geom={points:points.map(p=>[p[0],p[1]]),spatialReference:{wkid:4326}};
  const body=new URLSearchParams({geometry:JSON.stringify(geom),geometryType:"esriGeometryMultipoint",returnFirstValueOnly:"true",f:"json"});
  const r=await fetch(TERRAIN3D+"/getSamples",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  const j=await r.json(); if(j.error) throw new Error(j.error.message||"Terrain3D error");
  const out=new Array(points.length).fill(null);
  (j.samples||[]).forEach(s=>{const idx=nearestIndex(s.location,points,spacingDeg*0.6); if(idx>=0){const v=parseFloat(s.value); out[idx]=isNaN(v)?null:v;}});
  return out;
}
async function openmeteo(points){
  const out=new Array(points.length).fill(null);
  for(let i=0;i<points.length;i+=100){
    const chunk=points.slice(i,i+100);
    const lats=chunk.map(p=>p[1].toFixed(6)).join(","),lons=chunk.map(p=>p[0].toFixed(6)).join(",");
    const r=await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`);
    const j=await r.json(); (j.elevation||[]).forEach((v,k)=>{out[i+k]=(v===null||isNaN(v))?null:v;});
    await new Promise(res=>setTimeout(res,120));
  }
  return out;
}

// ---- sample orchestration --------------------------------------------------
async function sampleTerrain(){
  const note=document.getElementById("sp-samplenote");
  if(!boundary){note.textContent="Trace a boundary first.";return;}
  const src=document.getElementById("sp-source").value;
  if(src==="lidar"&&!lidar){note.textContent="Import a LiDAR tile first.";return;}
  const btn=document.getElementById("sp-sample"); btn.disabled=true; const old=btn.textContent; btn.textContent="Sampling…"; note.textContent="";
  try{
    const feat=boundary.toGeoJSON();
    const bufM=Math.max(0,parseFloat(document.getElementById("sp-buffer").value)||0);
    const region=bufM>0?turf.buffer(feat,bufM,{units:"meters"}):feat;
    const bb=turf.bbox(region); const [w,s,e,n]=bb;
    const wM=metersBetween([w,s],[e,s]), hM=metersBetween([w,s],[w,n]);
    const targetSpacing = src==="lidar" ? Math.max(lidar.workCellM, 1) : 30;
    const cap = src==="lidar" ? MAXPTS_LIDAR : MAXPTS_NET;
    let spacing=targetSpacing;
    let cols=Math.max(2,Math.round(wM/spacing)+1), rows=Math.max(2,Math.round(hM/spacing)+1);
    while(cols*rows>cap){ spacing*=1.12; cols=Math.max(2,Math.round(wM/spacing)+1); rows=Math.max(2,Math.round(hM/spacing)+1); }
    const spacingDeg=(e-w)/(cols-1);
    const points=[];
    for(let r=0;r<rows;r++){const lat=lerp(n,s,r/(rows-1)); for(let c=0;c<cols;c++){const lon=lerp(w,e,c/(cols-1)); points.push([lon,lat]);}}
    note.textContent = src==="lidar" ? `Sampling ${points.length} points from the imported tile…` : `Querying ${points.length} points…`;
    let vals;
    if(src==="lidar"){ vals=points.map(p=>lidarSample(p[0],p[1])); }
    else {
      try{ vals = src==="terrain3d" ? await terrain3d(points,spacingDeg) : await openmeteo(points); }
      catch(err){ if(src==="terrain3d"){ note.textContent="Terrain3D failed — falling back to Open-Meteo…"; vals=await openmeteo(points); document.getElementById("sp-source").value="openmeteo"; } else throw err; }
    }
    const nodata=vals.filter(v=>v===null).length;
    const [emin,emax]=minMax(vals);
    if(emin===Infinity){ note.textContent="No elevation returned over this area."+(src==="lidar"?" Does the tile cover your block?":""); btn.disabled=false; btn.textContent=old; return; }
    const pbb=turf.bbox(feat); const pwM=metersBetween([pbb[0],pbb[1]],[pbb[2],pbb[1]]), phM=metersBetween([pbb[0],pbb[1]],[pbb[0],pbb[3]]);
    const cellsAcross=Math.min(pwM,phM)/spacing;
    const nullMask=vals.map(v=>v===null?1:0);
    renderRelief(vals,rows,cols,emin,emax,bb,nullMask);
    showStats({emin,emax,rows,cols,spacing,nsamp:points.length,nodata,cellsAcross,relief:emax-emin,src});
    sampled={vals,rows,cols,w,s,e,n,spacing};
    analysis=null;
    document.getElementById("sp-analysis").style.display="none";
    document.getElementById("sp-analyseWrap").style.display="block";
    document.getElementById("sp-analysenote").textContent="";
    note.textContent = src==="lidar" ? "Sampled from imported LiDAR." : `Sampled via ${document.getElementById("sp-source").value==="terrain3d"?"Terrain3D":"Open-Meteo"}.`;
  }catch(err){ note.textContent="Error: "+(err.message||err); }
  finally{ btn.disabled=false; btn.textContent=old; }
}

function showStats(d){
  document.getElementById("sp-results").style.display="block";
  const set=(id,html)=>document.getElementById(id).innerHTML=html;
  set("sp-emin",d.emin.toFixed(1)+"<small> m</small>"); set("sp-emax",d.emax.toFixed(1)+"<small> m</small>");
  set("sp-erange",d.relief.toFixed(1)+"<small> m</small>");
  document.getElementById("sp-grid").textContent=d.cols+" × "+d.rows;
  set("sp-spacing",d.spacing.toFixed(d.spacing<10?1:0)+"<small> m</small>");
  document.getElementById("sp-nsamp").textContent=d.nsamp;
  document.getElementById("sp-lgmin").textContent=d.emin.toFixed(0)+" m";
  document.getElementById("sp-lgmax").textContent=d.emax.toFixed(0)+" m";
  const V=document.getElementById("sp-verdicts"); V.innerHTML="";
  const add=(cls,html)=>{const el=document.createElement("div");el.className="verdict "+cls;el.innerHTML=html;V.appendChild(el);};
  if(d.src==="lidar") add("info",`<b>High-res source.</b> Sampling at ~${d.spacing.toFixed(1)} m from the imported tile — the 30 m floor no longer applies.`);
  if(d.cellsAcross<4) add("bad",`<b>Too coarse.</b> ~${d.cellsAcross.toFixed(1)} cells across the block. Import a finer tile or paint facets by hand.`);
  else if(d.cellsAcross<12) add("warn",`<b>Coarse but workable.</b> ~${d.cellsAcross.toFixed(0)} cells across. Broad slope/aspect are real; small features won't resolve.`);
  else add("ok",`<b>Good resolution.</b> ~${d.cellsAcross.toFixed(0)} cells across — enough for slope, aspect and flow.`);
  if(d.relief<3) add("warn",`<b>Near-flat (${d.relief.toFixed(1)} m).</b> Aspect/flow/frost-hollows will barely discriminate — expect the flat-site fallback in stage 3.`);
  else if(d.relief<8) add("",`Gentle relief (${d.relief.toFixed(1)} m). Some signal; soft facet boundaries.`);
  if(d.nodata>0) add("warn",`<b>${d.nodata} null cell(s)</b> — kept as holes, never zero.`);
}

// ===== STAGE 3: terrain analysis =====
function clearVectors(){ vectorLayers.forEach(l=>map.removeLayer(l)); vectorLayers=[]; }

class MinHeap{
  constructor(){this.a=[];}
  get size(){return this.a.length;}
  push(p,v){const a=this.a;a.push([p,v]);let i=a.length-1;while(i>0){const j=(i-1)>>1;if(a[j][0]<=a[i][0])break;[a[i],a[j]]=[a[j],a[i]];i=j;}}
  pop(){const a=this.a;const top=a[0];const last=a.pop();if(a.length){a[0]=last;let i=0;for(;;){let l=2*i+1,r=l+1,m=i;if(l<a.length&&a[l][0]<a[m][0])m=l;if(r<a.length&&a[r][0]<a[m][0])m=r;if(m===i)break;[a[i],a[m]]=[a[m],a[i]];i=m;}}return top;}
}
function pip(x,y,ring){let ins=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1];const it=((yi>y)!==(yj>y))&&(x<(xj-xi)*(y-yi)/(yj-yi)+xi);if(it)ins=!ins;}return ins;}

function analyseTerrain(){
  if(!sampled){return;}
  const {vals,rows,cols,w,s,e,n}=sampled;
  const N=rows*cols, idx=(r,c)=>r*cols+c;
  const NB=[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
  let sum=0,cnt=0; for(const v of vals){if(v!==null&&!isNaN(v)){sum+=v;cnt++;}}
  const mean=cnt?sum/cnt:0;
  const Z=new Float64Array(N); let nullCnt=0;
  for(let i=0;i<N;i++){const v=vals[i]; if(v===null||isNaN(v)){Z[i]=mean;nullCnt++;} else Z[i]=v;}
  const csx=metersBetween([w,s],[e,s])/(cols-1), csy=metersBetween([w,s],[w,n])/(rows-1), cell=(csx+csy)/2;
  const F=new Float64Array(N); F.fill(Infinity);
  const closed=new Uint8Array(N); const heap=new MinHeap(); const eps=1e-4;
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){ if(r===0||c===0||r===rows-1||c===cols-1){const i=idx(r,c);F[i]=Z[i];closed[i]=1;heap.push(F[i],i);} }
  while(heap.size){
    const [,i]=heap.pop(); const r=(i/cols)|0,c=i%cols;
    for(const [dr,dc] of NB){ const rr=r+dr,cc=c+dc; if(rr<0||cc<0||rr>=rows||cc>=cols)continue; const j=idx(rr,cc); if(closed[j])continue; F[j]=Math.max(Z[j],F[i]+eps); closed[j]=1; heap.push(F[j],j); }
  }
  const zc=(r,c)=>F[idx(Math.max(0,Math.min(rows-1,r)),Math.max(0,Math.min(cols-1,c)))];
  const slopeDeg=new Float64Array(N), aspect=new Float64Array(N), hs=new Float64Array(N);
  const az=315*Math.PI/180, zen=(90-45)*Math.PI/180;
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
    const dzdx=((zc(r-1,c+1)+2*zc(r,c+1)+zc(r+1,c+1))-(zc(r-1,c-1)+2*zc(r,c-1)+zc(r+1,c-1)))/(8*csx);
    const dzdyN=((zc(r-1,c-1)+2*zc(r-1,c)+zc(r-1,c+1))-(zc(r+1,c-1)+2*zc(r+1,c)+zc(r+1,c+1)))/(8*csy);
    const g=Math.sqrt(dzdx*dzdx+dzdyN*dzdyN), sl=Math.atan(g)*180/Math.PI; const i=idx(r,c);
    slopeDeg[i]=sl;
    aspect[i]=(g<1e-6||sl<0.5)?-1:((Math.atan2(-dzdx,-dzdyN)*180/Math.PI)+360)%360;
    let v=Math.cos(zen)*Math.cos(Math.atan(g))+Math.sin(zen)*Math.sin(Math.atan(g))*Math.cos(az-Math.atan2(dzdyN,-dzdx)); hs[i]=Math.max(0,v);
  }
  const recv=new Int32Array(N).fill(-1);
  const dist=[csy,csy,csx,csx,Math.hypot(csx,csy),Math.hypot(csx,csy),Math.hypot(csx,csy),Math.hypot(csx,csy)];
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){
    const i=idx(r,c); let best=-1,bestDrop=0;
    for(let k=0;k<8;k++){const rr=r+NB[k][0],cc=c+NB[k][1]; if(rr<0||cc<0||rr>=rows||cc>=cols)continue; const j=idx(rr,cc); const drop=(F[i]-F[j])/dist[k]; if(drop>bestDrop){bestDrop=drop;best=j;}}
    recv[i]=best;
  }
  const accum=new Float64Array(N).fill(1);
  const order=Array.from({length:N},(_,i)=>i).sort((a,b)=>F[b]-F[a]);
  for(const i of order){const j=recv[i]; if(j>=0) accum[j]+=accum[i];}
  const depth=new Float64Array(N), twi=new Float64Array(N);
  for(let i=0;i<N;i++){ depth[i]=Math.max(0,F[i]-Z[i]); const a=accum[i]*cell; twi[i]=Math.log(a/Math.tan(Math.max(slopeDeg[i]*Math.PI/180,0.001))); }
  const ring=boundary.toGeoJSON().geometry.coordinates[0];
  const inside=new Uint8Array(N);
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){ inside[idx(r,c)]=pip(lerp(w,e,c/(cols-1)),lerp(n,s,r/(rows-1)),ring)?1:0; }
  analysis={rows,cols,w,s,e,n,csx,csy,cell,Z,F,slopeDeg,aspect,hs,accum,depth,twi,inside,nullCnt,
    chanThresh:Math.max(6,Math.round(N*0.012))};
  design=null; clearVectors();
  document.querySelectorAll("#sp-layerbtns .s4").forEach(b=>b.style.display="none");
  if(activeLayer==="facets"||activeLayer==="waterplan") activeLayer="slope";
  document.getElementById("sp-analysis").style.display="block";
  document.getElementById("sp-designWrap").style.display="block";
  document.getElementById("sp-designnote").textContent="";
  setActiveLayer(activeLayer&&activeLayer!=="relief"?activeLayer:"slope");
  map.fitBounds([[s,w],[n,e]],{padding:[20,20]});
  computeAStats();
}

function slopeColor(d){ if(d<2)return [90,150,70]; if(d<5)return [150,180,70]; if(d<10)return [210,190,70]; if(d<20)return [210,140,60]; return [200,80,60]; }
function aspectColor(a){ if(a<0)return [120,120,120]; if(a>=315||a<45)return [210,120,70]; if(a<135)return [180,200,120]; if(a<225)return [90,120,180]; return [220,170,80]; }
function shade(col,h){const sh=0.45+0.55*h;return [col[0]*sh,col[1]*sh,col[2]*sh];}

function renderLayer(name){
  const A=analysis; if(!A)return;
  clearVectors();
  const {rows,cols,w,s,e,n,inside,slopeDeg,aspect,accum,depth,twi,F,hs,chanThresh}=A; const N=rows*cols;
  let fmin=Infinity,fmax=-Infinity,amax=1,dmax=0,tmin=Infinity,tmax=-Infinity;
  for(let i=0;i<N;i++){ if(F[i]<fmin)fmin=F[i]; if(F[i]>fmax)fmax=F[i]; if(accum[i]>amax)amax=accum[i];
    if(inside[i]){ if(depth[i]>dmax)dmax=depth[i]; if(twi[i]<tmin)tmin=twi[i]; if(twi[i]>tmax)tmax=twi[i]; } }
  const cv=document.createElement("canvas"); cv.width=cols; cv.height=rows;
  const ctx=cv.getContext("2d"); const img=ctx.createImageData(cols,rows);
  const isS4=(name==="facets"||name==="waterplan");
  for(let i=0;i<N;i++){
    let col=null;
    if(name!=="relief"&&!inside[i]){ img.data[i*4+3]=0; continue; }
    if(name==="relief"){ const t=(F[i]-fmin)/((fmax-fmin)||1); const b=tint(t); const sh=0.4+0.6*hs[i]; col=[b[0]*sh,b[1]*sh,b[2]*sh]; img.data[i*4+3]=inside[i]?235:90; }
    else if(name==="slope"){ col=shade(slopeColor(slopeDeg[i]),hs[i]); img.data[i*4+3]=235; }
    else if(name==="aspect"){ col=shade(aspectColor(aspect[i]),hs[i]); img.data[i*4+3]=235; }
    else if(name==="flow"){ const sh=0.45+0.55*hs[i]; col=[70*sh,80*sh,70*sh]; if(accum[i]>=chanThresh){const t=Math.min(1,Math.log(accum[i])/Math.log(amax)); col=[lerp(90,40,t),lerp(150,90,t),lerp(210,170,t)];} img.data[i*4+3]=235; }
    else if(name==="ponding"){ const sh=0.45+0.55*hs[i]; col=[70*sh,80*sh,70*sh]; if(depth[i]>0.05){const t=Math.min(1,depth[i]/(dmax||1)); col=[lerp(120,30,t),lerp(170,80,t),lerp(210,150,t)];} img.data[i*4+3]=235; }
    else if(name==="wetness"){ const t=(twi[i]-tmin)/((tmax-tmin)||1); col=[lerp(200,40,t),lerp(180,110,t),lerp(120,160,t)]; img.data[i*4+3]=235; }
    else if(isS4){ const f=design?design.facet[i]:-1; if(f<0){ img.data[i*4+3]=0; } else { col=shade(ZONES4[f].col,hs[i]); img.data[i*4+3]=name==="waterplan"?140:230; } }
    if(col){ img.data[i*4]=Math.round(col[0]); img.data[i*4+1]=Math.round(col[1]); img.data[i*4+2]=Math.round(col[2]); }
  }
  ctx.putImageData(img,0,0);
  if(overlay) map.removeLayer(overlay);
  overlay=L.imageOverlay(cv.toDataURL(),[[s,w],[n,e]],{opacity:document.getElementById("sp-opacity").value/100}).addTo(map);
  if(name==="waterplan"&&design){
    if(design.swales.length){ const sw=L.polyline(design.swales,{color:"#37c6e8",weight:1.6,opacity:.95}).addTo(map); vectorLayers.push(sw); }
    design.dams.forEach((d,k)=>{ const m=L.circleMarker([d.lat,d.lon],{radius:8,color:"#0a2a3a",weight:2,fillColor:"#37c6e8",fillOpacity:.9}).addTo(map)
      .bindTooltip(`Catchment dam ${k+1}: ${(d.catchM2/10000).toFixed(2)} ha catchment · ~${Math.round(d.yieldKL).toLocaleString()} kL/yr`,{direction:"top"}); vectorLayers.push(m); });
    (design.keyDams||[]).forEach((d,k)=>{ const m=L.circleMarker([d.lat,d.lon],{radius:8,color:"#3a2a0a",weight:2,fillColor:"#e8a437",fillOpacity:.95}).addTo(map)
      .bindTooltip(`Keyline dam ${k+1} (keypoint): ${(d.catchM2/10000).toFixed(2)} ha catchment · ~${Math.round(d.yieldKL).toLocaleString()} kL/yr · high for gravity feed`,{direction:"top"}); vectorLayers.push(m); });
  }
  renderLegend(name);
}

function renderLegend(name){
  const el=document.getElementById("sp-legend");
  const row=(c,t)=>`<div style="display:flex;align-items:center;gap:8px;margin:3px 0;font-size:12px;color:var(--muted);"><span style="width:14px;height:14px;border-radius:3px;background:rgb(${c});display:inline-block;flex:none;"></span><span>${t}</span></div>`;
  let h="";
  if(name==="relief") h=`<div class="muted">Shaded elevation, clipped to your block.</div>`;
  else if(name==="slope") h=row("90,150,70","&lt;2° flat — terraceable, machinery access")+row("150,180,70","2–5° gentle")+row("210,190,70","5–10° moderate — swales, contour beds")+row("210,140,60","10–20° steep — tree crops, no-till")+row("200,80,60","&gt;20° very steep — permanent cover");
  else if(name==="aspect") h=row("210,120,70","North — warm, sun-exposed (heat-lovers)")+row("180,200,120","East — gentle morning sun")+row("220,170,80","West — hot afternoon sun (drought-hardy)")+row("90,120,180","South — cool, shaded, frost-prone")+row("120,120,120","Flat — aspect not meaningful");
  else if(name==="flow") h=row("60,110,190","Channels — where water concentrates")+`<div class="muted" style="margin-top:4px;">Put swales on contour just <b>above</b> the bright lines; valley ends are candidate dam sites.</div>`;
  else if(name==="ponding") h=row("40,90,160","Natural depressions — water already collects")+`<div class="muted" style="margin-top:4px;">Ready-made pond/dam spots; deeper = darker.</div>`;
  else if(name==="wetness") h=row("40,110,160","Wetter — persistently damp (moisture-lovers)")+row("200,180,120","Drier — free-draining (drought-hardy)");
  else if(name==="facets") h=ZONES4.map(z=>row(z.col.join(","),`<b style="color:var(--ink)">${z.name}</b> — ${z.plant}`+(design&&design.facetPct?` <span style="color:var(--faint)">(${design.facetPct[z.id]||0}%)</span>`:""))).join("");
  else if(name==="waterplan"){ const sp=design?design.spacing:null;
    h=row("55,198,232",`Swales — level, on contour, 2–12% slopes`)
      +(sp?`<div class="muted" style="margin-top:4px;">VI ${sp.VI} m (SCS x=${sp.x} rain · y=${sp.y} soil); ~${sp.hiMed} m typical, ${sp.hiSteep}–${sp.hiGentle} m across slopes.</div>`:"")
      +row("55,198,232","● Catchment dam — valley outlet, max harvest")
      +(design&&design.dams.length?design.dams.map((d,k)=>`<div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0;"><span>Catchment ${k+1}</span><span>${(d.catchM2/10000).toFixed(2)} ha → ~${Math.round(d.yieldKL).toLocaleString()} kL/yr</span></div>`).join("")
        :`<div class="muted">No clear catchment node at this resolution.</div>`)
      +row("232,164,55","● Keyline dam — keypoint, high for gravity feed")
      +(design&&design.keyDams&&design.keyDams.length?design.keyDams.map((d,k)=>`<div style="display:flex;justify-content:space-between;font-size:12px;padding:2px 0;"><span>Keyline ${k+1}</span><span>${(d.catchM2/10000).toFixed(2)} ha → ~${Math.round(d.yieldKL).toLocaleString()} kL/yr</span></div>`).join("")
        :`<div class="muted">No clear keypoint (needs a primary valley with a slope break).</div>`); }
  el.innerHTML=h;
}

function computeAStats(){
  const A=analysis; const {rows,cols,inside,slopeDeg,aspect,depth,accum,chanThresh,cell}=A; const N=rows*cols;
  let nIn=0,slSum=0; const band=[0,0,0,0,0]; const asp={N:0,E:0,S:0,W:0,flat:0}; let chan=0,pond=0;
  for(let i=0;i<N;i++){ if(!inside[i])continue; nIn++; const d=slopeDeg[i]; slSum+=d;
    band[d<2?0:d<5?1:d<10?2:d<20?3:4]++;
    const a=aspect[i]; if(a<0)asp.flat++; else if(a>=315||a<45)asp.N++; else if(a<135)asp.E++; else if(a<225)asp.S++; else asp.W++;
    if(accum[i]>=chanThresh)chan++; if(depth[i]>0.05)pond++;
  }
  const pct=x=>nIn?Math.round(x/nIn*100):0;
  document.getElementById("sp-astats").innerHTML=`
    <div class="verdict info" style="margin-top:10px;"><b>On your block</b> — ${nIn} cells, ~${cell.toFixed(1)} m each${A.nullCnt?` · ${A.nullCnt} null filled`:""}</div>
    <div class="lidcard">
      <div class="kv"><span>Mean slope</span><span>${(slSum/Math.max(1,nIn)).toFixed(1)}°</span></div>
      <div class="kv"><span>Flat / gentle / mod / steep+</span><span>${pct(band[0])} / ${pct(band[1])} / ${pct(band[2])} / ${pct(band[3]+band[4])} %</span></div>
      <div class="kv"><span>Sun N / E / W / S / flat</span><span>${pct(asp.N)}/${pct(asp.E)}/${pct(asp.W)}/${pct(asp.S)}/${pct(asp.flat)} %</span></div>
      <div class="kv"><span>Channel cells</span><span>${chan} (${pct(chan)}%)</span></div>
      <div class="kv"><span>Ponding cells</span><span>${pond} (${pct(pond)}%)</span></div>
    </div>`;
}

function setActiveLayer(name){
  activeLayer=name;
  document.querySelectorAll("#sp-layerbtns .lyr").forEach(b=>b.classList.toggle("on",b.dataset.layer===name));
  renderLayer(name);
}

// ===== STAGE 4: facets + water design =====
const ZONES4=[
  {id:0,name:"Drainage line / wet valley",col:[40,150,150],plant:"Ponds &amp; water-lovers; frost-aware (cold air drains here)"},
  {id:1,name:"Frost hollow",col:[140,110,180],plant:"Cold-air pocket — exclude frost-tender; hardy/deciduous only"},
  {id:2,name:"Warm slope (N/E/W)",col:[220,150,70],plant:"Orchard, vines, heat-lovers; W-facing runs hot/dry"},
  {id:3,name:"Cool slope (S)",col:[90,130,180],plant:"Berries, leafy &amp; shade-tolerant, forest/windbreak"},
  {id:4,name:"Steep land",col:[170,80,60],plant:"Permanent cover, forestry, tree crops — no cultivation"},
  {id:5,name:"Flat productive",col:[110,175,80],plant:"Annual beds, market garden, accessible cropping"},
  {id:6,name:"Exposed ridge / top",col:[205,195,120],plant:"Windbreak, hardy species; shelter before production"}
];
function pctile(arr,inside,p){ const v=[]; for(let i=0;i<arr.length;i++) if(inside[i]) v.push(arr[i]); v.sort((a,b)=>a-b); return v.length?v[Math.min(v.length-1,Math.floor(p*v.length))]:0; }
function slopePctFromDeg(d){ return Math.tan(d*Math.PI/180)*100; }

function buildSwales(VI){
  const {rows,cols,w,s,e,n,F,slopeDeg,inside}=analysis; const idx=(r,c)=>r*cols+c;
  let mn=Infinity,mx=-Infinity; for(let i=0;i<rows*cols;i++){ if(inside[i]){ if(F[i]<mn)mn=F[i]; if(F[i]>mx)mx=F[i]; } }
  const xy=(r,c)=>[lerp(w,e,c/(cols-1)),lerp(n,s,r/(rows-1))];
  const cellOk=(r,c)=>{ const ii=[idx(r,c),idx(r,c+1),idx(r+1,c+1),idx(r+1,c)]; if(!ii.every(k=>inside[k]))return false;
    const slDeg=(slopeDeg[ii[0]]+slopeDeg[ii[1]]+slopeDeg[ii[2]]+slopeDeg[ii[3]])/4; const slPct=slopePctFromDeg(slDeg); return slPct>=2&&slPct<=12; };
  const segs=[];
  if(!isFinite(mn)||VI<=0) return segs;
  for(let z=Math.ceil(mn/VI)*VI; z<mx; z+=VI){
    for(let r=0;r<rows-1;r++)for(let c=0;c<cols-1;c++){
      if(!cellOk(r,c))continue;
      const v=[F[idx(r,c)],F[idx(r,c+1)],F[idx(r+1,c+1)],F[idx(r+1,c)]];
      const p=[xy(r,c),xy(r,c+1),xy(r+1,c+1),xy(r+1,c)];
      const cross=[];
      for(let k=0;k<4;k++){ const a=v[k],b=v[(k+1)%4]; if((a<z)!==(b<z)){ const t=(z-a)/(b-a); const pa=p[k],pb=p[(k+1)%4]; cross.push([pa[0]+(pb[0]-pa[0])*t,pa[1]+(pb[1]-pa[1])*t]); } }
      if(cross.length===2) segs.push([[cross[0][1],cross[0][0]],[cross[1][1],cross[1][0]]]);
      else if(cross.length===4){ segs.push([[cross[0][1],cross[0][0]],[cross[1][1],cross[1][0]]]); segs.push([[cross[2][1],cross[2][0]],[cross[3][1],cross[3][0]]]); }
    }
  }
  return segs;
}
function buildDams(rainMM,coeff){
  const {rows,cols,w,s,e,n,accum,inside,cell,chanThresh}=analysis; const N=rows*cols;
  const cellArea=cell*cell; const cand=[];
  for(let i=0;i<N;i++){ if(inside[i]&&accum[i]>=chanThresh) cand.push(i); }
  cand.sort((a,b)=>accum[b]-accum[a]);
  const picked=[], minSep=Math.max(30,cell*8);
  for(const i of cand){
    const r=(i/cols)|0,c=i%cols, lat=lerp(n,s,r/(rows-1)), lon=lerp(w,e,c/(cols-1));
    if(picked.some(p=>metersBetween([lon,lat],[p.lon,p.lat])<minSep)) continue;
    const catchM2=accum[i]*cellArea, yieldKL=catchM2*(rainMM/1000)*coeff;
    picked.push({lat,lon,catchM2,yieldKL}); if(picked.length>=3) break;
  }
  return picked;
}
function buildKeylineDams(rainMM,coeff){
  const {rows,cols,w,s,e,n,accum,F,inside,cell,chanThresh}=analysis; const N=rows*cols, idx=(r,c)=>r*cols+c;
  const NB=[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
  const isChan=i=>accum[i]>=chanThresh;
  const dist=[cell,cell,cell,cell,cell*Math.SQRT2,cell*Math.SQRT2,cell*Math.SQRT2,cell*Math.SQRT2];
  const recv=new Int32Array(N).fill(-1);
  for(let r=0;r<rows;r++)for(let c=0;c<cols;c++){const i=idx(r,c);let best=-1,bd=0;for(let k=0;k<8;k++){const rr=r+NB[k][0],cc=c+NB[k][1];if(rr<0||cc<0||rr>=rows||cc>=cols)continue;const j=idx(rr,cc);const drop=(F[i]-F[j])/dist[k];if(drop>bd){bd=drop;best=j;}}recv[i]=best;}
  const flowsInto=new Uint8Array(N);
  for(let i=0;i<N;i++){ if(isChan(i)&&recv[i]>=0&&isChan(recv[i])) flowsInto[recv[i]]=1; }
  const heads=[]; for(let i=0;i<N;i++){ if(isChan(i)&&!flowsInto[i]) heads.push(i); }
  heads.sort((a,b)=>F[b]-F[a]);
  const used=new Uint8Array(N), keypts=[];
  const xy=i=>[lerp(w,e,(i%cols)/(cols-1)),lerp(n,s,((i/cols)|0)/(rows-1))];
  for(const h of heads){
    if(used[h]) continue;
    const path=[]; let i=h, guard=0;
    while(i>=0 && isChan(i) && guard++<N){ path.push(i); used[i]=1; const j=recv[i]; if(j<0||!isChan(j)) break; i=j; }
    if(path.length<6) continue;
    const d=[0]; for(let k=1;k<path.length;k++){ d.push(d[k-1]+metersBetween(xy(path[k-1]),xy(path[k]))); }
    const z=path.map(p=>F[p]);
    const win=Math.max(2,Math.round(path.length*0.12));
    const slopeAt=k=>{ const a=Math.max(0,k-win), b=Math.min(path.length-1,k+win); const dd=d[b]-d[a]; return dd>0?(z[a]-z[b])/dd:0; };
    let bestK=-1,bestDrop=0;
    for(let k=win;k<path.length-win;k++){ const up=slopeAt(k-win), dn=slopeAt(k+win); if(up>dn && (up-dn)>bestDrop){ bestDrop=up-dn; bestK=k; } }
    if(bestK<0) continue;
    const kp=path[bestK]; if(!inside[kp]) continue;
    const [lon,lat]=xy(kp);
    if(keypts.some(p=>metersBetween([lon,lat],[p.lon,p.lat])<Math.max(30,cell*8))) continue;
    const catchM2=accum[kp]*cell*cell, yieldKL=catchM2*(rainMM/1000)*coeff;
    keypts.push({lat,lon,catchM2,yieldKL}); if(keypts.length>=3) break;
  }
  return keypts;
}
function swaleXY(rainMM, soil){
  const x = Math.max(0.12, Math.min(0.24, 0.24 - (rainMM-300)/(1400-300)*(0.24-0.12)));
  const Y = {sand:1.0,loamy_sand:0.95,sandy_loam:0.8,loam:0.6,clay_loam:0.7,light_clay:0.85,heavy_clay:0.9,gravel:0.8};
  return {x, y:(Y[soil]!=null?Y[soil]:0.6)};
}
function designStage4(){
  if(!analysis) return;
  const {rows,cols,inside,slopeDeg,aspect,accum,depth,twi,F,chanThresh}=analysis; const N=rows*cols;
  const rainMM=Math.max(0,parseFloat(document.getElementById("sp-rain").value)||1100);
  const coeff=Math.max(0.01,parseFloat(document.getElementById("sp-coeff").value)||0.25);
  const soil=document.getElementById("sp-soil").value;
  const hiMax=Math.max(8,parseFloat(document.getElementById("sp-himax").value)||25);
  const twiHi=pctile(twi,inside,0.85), elevHi=pctile(F,inside,0.70), accumLo=pctile(accum,inside,0.40), STEEP=18;
  const facet=new Int8Array(N).fill(-1), counts=new Array(ZONES4.length).fill(0); let nIn=0;
  for(let i=0;i<N;i++){ if(!inside[i])continue; nIn++;
    const sl=slopeDeg[i],a=aspect[i]; let f;
    if(sl>STEEP)f=4; else if(depth[i]>0.15)f=1; else if((accum[i]>=chanThresh||twi[i]>=twiHi)&&sl<6)f=0;
    else if(sl<2)f=5; else if(F[i]>=elevHi&&accum[i]<=accumLo)f=6; else if(a>=135&&a<225)f=3; else f=2;
    facet[i]=f; counts[f]++;
  }
  const facetPct={}; ZONES4.forEach(z=>facetPct[z.id]=nIn?Math.round(counts[z.id]/nIn*100):0);
  const wk=[]; for(let i=0;i<N;i++){ if(!inside[i])continue; const p=slopePctFromDeg(slopeDeg[i]); if(p>=2&&p<=12) wk.push(p); }
  wk.sort((a,b)=>a-b);
  const medS = wk.length? wk[Math.floor(wk.length/2)] : 6;
  const {x,y}=swaleXY(rainMM,soil);
  let VI=x*medS+y, HI=VI*100/medS;
  if(HI>hiMax){ HI=hiMax; VI=HI*medS/100; }
  if(HI<6){ HI=6; VI=HI*medS/100; }
  const swales=buildSwales(VI);
  const spacing={VI:+VI.toFixed(2),x:+x.toFixed(3),y:+y.toFixed(2),medS:+medS.toFixed(1),
    hiMed:Math.round(VI*100/medS),hiGentle:Math.round(VI*100/2),hiSteep:Math.round(VI*100/12),workable:wk.length};
  const dams=buildDams(rainMM,coeff), keyDams=buildKeylineDams(rainMM,coeff);
  design={facet,swales,dams,keyDams,facetPct,spacing,settings:{rainMM,coeff,soil,hiMax}};
  document.querySelectorAll("#sp-layerbtns .s4").forEach(b=>b.style.display="");
  document.getElementById("sp-designnote").innerHTML=
    `Swales: VI ${spacing.VI} m → ~${spacing.hiMed} m typical (${spacing.hiSteep}–${spacing.hiGentle} m across slopes). Dams: ${dams.length} catchment, ${keyDams.length} keyline.`;
  setActiveLayer("facets");
}

// ===== SITE MODEL — one-way handoff to planner =====
// Zone suitability category assignments (data-driven, matches spec Section D)
const ZONE_SUIT=[
  {suitable:["wet-tolerant","all"],        excluded:[]},               // 0 Drainage
  {suitable:["frost-hardy"],               excluded:["warm-season"]},  // 1 Frost hollow
  {suitable:["warm-season","all"],         excluded:[]},               // 2 Warm slope
  {suitable:["cool-season","tree-crop","perennial"], excluded:[]},     // 3 Cool slope
  {suitable:["tree-crop","perennial"],     excluded:["annual"]},       // 4 Steep
  {suitable:["annual","all"],              excluded:["tree-crop"]},    // 5 Flat productive
  {suitable:["drought-hardy","perennial"], excluded:["wet-tolerant"]}, // 6 Ridge
];

function getSiteModel(){
  if(!design||!boundary||!analysis) return null;
  const {rows,cols,w,s,e,n,slopeDeg,aspect,twi,inside,F,cell}=analysis;
  const N=rows*cols;
  const cellHa=cell*cell/10000;
  const zoneCells=new Array(ZONES4.length).fill(0);
  for(let i=0;i<N;i++) if(inside[i]&&design.facet[i]>=0) zoneCells[design.facet[i]]++;
  const feat=boundary.toGeoJSON();
  const areaHa=turf.area(feat)/10000;
  const ring=feat.geometry.coordinates[0];
  const cLon=ring.reduce((t,p)=>t+p[0],0)/ring.length;
  const cLat=ring.reduce((t,p)=>t+p[1],0)/ring.length;

  const zones=ZONES4.map((z,idx)=>{
    const area_ha=zoneCells[idx]*cellHa;
    const cells=[];
    for(let i=0;i<N;i++) if(inside[i]&&design.facet[i]===idx) cells.push(i);
    const medSlope=cells.length?cells.map(i=>slopeDeg[i]).sort((a,b)=>a-b)[cells.length>>1]:0;
    const asp={warm:0,cool:0,neutral:0};
    cells.forEach(i=>{ const a=aspect[i]; if(a<0)asp.neutral++; else if((a>=315||a<45)||(a>=45&&a<135))asp.warm++; else if(a>=135&&a<225)asp.cool++; else asp.neutral++; });
    const sun=asp.warm>asp.cool?"warm":asp.cool>asp.neutral?"cool":"neutral";
    const medTwi=cells.length?cells.map(i=>twi[i]).sort((a,b)=>a-b)[cells.length>>1]:10;
    const wetness=medTwi>12?"wet":medTwi<8?"dry":"mesic";
    return {
      name:z.name, area_ha, slope_pct:Math.tan(medSlope*Math.PI/180)*100,
      sun, wetness, frostRisk:idx===1,
      suitableCategories:ZONE_SUIT[idx].suitable,
      excludedCategories:ZONE_SUIT[idx].excluded,
      layout:null,
    };
  });

  const allDams=[
    ...design.dams.map(d=>({type:"catchment",lat:d.lat,lon:d.lon,catchment_ha:d.catchM2/10000,yield_kL:d.yieldKL})),
    ...(design.keyDams||[]).map(d=>({type:"keyline",lat:d.lat,lon:d.lon,catchment_ha:d.catchM2/10000,yield_kL:d.yieldKL})),
  ];
  const swaleZones=[2,3,4,5];
  const swaleableArea_ha=swaleZones.reduce((sum,zi)=>sum+(zoneCells[zi]||0)*cellHa,0);

  return {
    boundary:feat, area_ha:areaHa, centroid:{lat:cLat,lon:cLon},
    zones, water:{swaleableArea_ha, dams:allDams},
  };
}

function applySiteModelToPlanner(){
  if(typeof state==="undefined") return;
  const sm=getSiteModel();
  if(!sm){ alert("Run stage 4 design first (Generate facets, swales & dams)."); return; }
  state.siteModel=sm;
  state.plan=null;
  if(typeof renderApp==="function") renderApp();
}

// ===== LAZY INIT — call after the spatial panel HTML is in the DOM =====
function initSpatialMap(){
  if(spatialInitialized){ if(map) setTimeout(()=>map.invalidateSize(),50); return; }
  spatialInitialized=true;

  map=L.map("sp-map").setView(DARLINGTON,15);
  esri=L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",{maxZoom:19,attribution:"Esri World Imagery"}).addTo(map);
  osm=L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",{maxZoom:19,attribution:"© OpenStreetMap"});
  try{ slip=L.esri.dynamicMapLayer({url:"https://services.slip.wa.gov.au/public/rest/services/SLIP_Public_Services/Locate/MapServer"}); }catch(e){}
  const bases={"Esri imagery (sharp)":esri,"OpenStreetMap":osm}; if(slip) bases["SLIP WA imagery"]=slip;
  L.control.layers(bases,{},{position:"topright",collapsed:true}).addTo(map);

  map.pm.setGlobalOptions({allowSelfIntersection:false,snappable:true});
  map.pm.addControls({position:"topleft",drawPolygon:true,drawRectangle:true,editMode:true,dragMode:true,removalMode:true,
    drawMarker:false,drawCircle:false,drawCircleMarker:false,drawPolyline:false,drawText:false,cutPolygon:false,rotateMode:false});
  map.on("pm:create",e=>{
    if(e.shape!=="Polygon"&&e.shape!=="Rectangle")return;
    if(boundary) map.removeLayer(boundary);
    boundary=e.layer;
    boundary.setStyle&&boundary.setStyle({color:"#d9e08a",weight:2.5,fillColor:"#9cbb57",fillOpacity:.1});
    if(lidar) checkCoverage();
  });
  map.on("pm:remove",e=>{if(e.layer===boundary)boundary=null;});

  map.on("click",async e=>{
    if(!parcelMode) return;
    const note=document.getElementById("sp-parcelnote"); note.textContent="Looking up parcel…";
    try{
      const id=await findCadastreLayer();
      if(id<0){ note.textContent="Cadastre service unavailable."; return; }
      const {lat,lng}=e.latlng;
      const url=CADASTRE_SVC+"/"+id+"/query?geometry="+lng+","+lat
        +"&geometryType=esriGeometryPoint&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects&returnGeometry=true&outFields=*&f=geojson";
      const r=await fetch(url); const j=await r.json();
      const feat=(j.features||[])[0];
      if(!feat||!feat.geometry){ note.textContent="No parcel here — try clicking inside a freehold lot."; return; }
      if(boundary) map.removeLayer(boundary);
      boundary=L.geoJSON(feat,{style:{color:"#d9e08a",weight:2.5,fillColor:"#9cbb57",fillOpacity:.1}}).getLayers()[0];
      boundary.addTo(map);
      if(boundary.pm) boundary.pm.enable({allowSelfIntersection:false});
      map.fitBounds(boundary.getBounds(),{padding:[30,30]});
      if(lidar) checkCoverage();
      setParcelMode(false);
      note.textContent="Parcel loaded (simplified cadastre — edit vertices to refine).";
    }catch(err){ note.textContent="Lookup failed: "+(err.message||err); }
  });

  document.getElementById("sp-file").addEventListener("change",async e=>{
    const f=e.target.files[0]; if(!f) return;
    const card=document.getElementById("sp-lidcard");
    card.innerHTML=`<div class="muted">Reading ${f.name}…</div>`;
    try{
      const buf=await f.arrayBuffer();
      const tiff=await GeoTIFF.fromArrayBuffer(buf);
      const image=await tiff.getImage();
      pendingImage=image;
      const keys=image.getGeoKeys()||{};
      let code=keys.ProjectedCSTypeGeoKey||keys.GeographicTypeGeoKey||null;
      const ov=document.getElementById("sp-crsOverride");
      if(!code||!PROJ_ZONES[code]){
        document.getElementById("sp-crsOverrideWrap").style.display="block";
        if(ov.value) code=+ov.value;
      } else {
        document.getElementById("sp-crsOverrideWrap").style.display="none";
      }
      if(!code||!PROJ_ZONES[code]){
        card.innerHTML=`<div class="verdict warn"><b>CRS not recognised.</b> Pick the tile's projection above and it'll load.</div>`;
        return;
      }
      await loadLidar(image,+code);
    }catch(err){
      card.innerHTML=`<div class="verdict bad"><b>Couldn't read this file.</b> ${err.message||err}. Make sure it's a GeoTIFF DEM (.tif).</div>`;
    }
  });
  document.getElementById("sp-crsOverride").addEventListener("change",async e=>{
    if(pendingImage&&e.target.value) await loadLidar(pendingImage,+e.target.value);
  });

  document.getElementById("sp-search").addEventListener("click",doSearch);
  document.getElementById("sp-q").addEventListener("keydown",e=>{if(e.key==="Enter")doSearch();});
  document.getElementById("sp-parcelMode").addEventListener("click",()=>setParcelMode(!parcelMode));

  document.getElementById("sp-layerbtns").addEventListener("click",e=>{const b=e.target.closest(".lyr"); if(b&&analysis)setActiveLayer(b.dataset.layer);});
  document.getElementById("sp-analyse").addEventListener("click",()=>{
    const note=document.getElementById("sp-analysenote"); note.textContent="Analysing…";
    setTimeout(()=>{ try{ analyseTerrain(); note.textContent="Done — switch layers above."; }catch(err){ note.textContent="Error: "+(err.message||err); } },20);
  });
  document.getElementById("sp-design").addEventListener("click",()=>{
    const note=document.getElementById("sp-designnote"); note.textContent="Designing…";
    setTimeout(()=>{ try{ designStage4(); note.textContent="Done — see Facets &amp; Water plan."; }catch(err){ note.textContent="Error: "+(err.message||err); } },20);
  });
  document.getElementById("sp-sample").addEventListener("click",sampleTerrain);
  document.getElementById("sp-opacity").addEventListener("input",e=>{ if(overlay) overlay.setOpacity(e.target.value/100); });
  document.getElementById("sp-toggle").addEventListener("click",e=>{
    if(!overlay)return;
    if(map.hasLayer(overlay)){map.removeLayer(overlay);e.target.textContent="Show";}
    else{overlay.addTo(map);e.target.textContent="Hide";}
  });
}
