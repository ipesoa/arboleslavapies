import {
  aliasExists, createPendingIdentity, getLocalIdentity, login, logout,
  registrationPayload, renameRejectedIdentity, syncLocalIdentity
} from './auth.js';

const cfg = window.APP_CONFIG;
const $ = s => document.querySelector(s);
const map = L.map('map', {zoomControl:false, preferCanvas:true, maxZoom:cfg.maxZoom || 19}).setView(cfg.center, cfg.zoom);
L.control.zoom({position:'bottomright'}).addTo(map);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxNativeZoom:19,
  maxZoom:cfg.maxZoom || 19,
  attribution:'&copy; OpenStreetMap contributors'
}).addTo(map);

const treeLayer = L.layerGroup().addTo(map);
const communityLayer = L.layerGroup().addTo(map);
let trees = [], events = [], photos = [], places = [], meta = {};
let pinMode = false, pendingLatLng = null, pendingMarker = null, showingNeeds = false;
let lastNominatimAt = 0;
let currentTreeFeature = null, currentWeekOffset = 0;
let actionContext = null, photoPlaceId = null;
let commitmentDates = [];
const addressCache = new Map();

function setupBrand(){
  const brand=$('#brand'); if(!brand)return;
  const text=brand.textContent; brand.textContent='';
  [...text].forEach((ch,i)=>{
    const span=document.createElement('span');
    span.className='brand-letter';
    span.textContent=ch===' '?'\u00a0':ch;
    span.style.setProperty('--delay',`${Math.min(i*0.032,.42)}s`);
    brand.appendChild(span);
  });

  let resetTimer=null;
  const play=()=>{
    brand.classList.remove('brand-party');
    void brand.offsetWidth;
    brand.classList.add('brand-party');
    clearTimeout(resetTimer);
    resetTimer=setTimeout(()=>brand.classList.remove('brand-party'),3600);
  };
  brand.addEventListener('pointerenter',play);
  brand.addEventListener('pointerdown',play);
  brand.addEventListener('focus',play);
  setTimeout(play,180);
}
setupBrand();

const drawer = $('#drawer');
const drawerContent = $('#drawerContent');
const identityDialog = $('#identityDialog');
const secretDialog = $('#secretDialog');
const addDialog = $('#addDialog');
const actionDialog = $('#actionDialog');
const photoDialog = $('#photoDialog');
const suggestDialog = $('#suggestDialog');

function showStatus(text, ms=3400){
  const el=$('#status'); el.textContent=text; el.classList.remove('hidden');
  clearTimeout(showStatus.t); showStatus.t=setTimeout(()=>el.classList.add('hidden'),ms);
}
function esc(s=''){return String(s).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
function idLabel(props){return props.community_id || `MAD-${props.assetnum || props.ASSETNUM || '?'}`;}
function currentEventsFor(id){return events.filter(e=>e.place_id===id || e.tree_id===id).sort((a,b)=>String(b.date).localeCompare(String(a.date)));}
function photosFor(id){return photos.filter(p=>p.place_id===id).sort((a,b)=>String(b.date).localeCompare(String(a.date)));}
function eventLabel(type){return ({watering:'Riego',commitment:'Compromiso',comment:'Comentario',issue:'Incidencia'})[type] || type;}
function fmtDate(value){if(!value)return '—'; try{return new Intl.DateTimeFormat('es-ES',{day:'numeric',month:'short',year:'numeric'}).format(new Date(value));}catch{return value;}}
function fmtDateTime(value){if(!value)return 'pendiente'; try{return new Intl.DateTimeFormat('es-ES',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(new Date(value));}catch{return value;}}
function wateringState(id){
  const last=currentEventsFor(id).find(e=>e.type==='watering');
  if(!last) return {name:'Sin datos vecinales',cls:'unknown'};
  const days=(Date.now()-new Date(last.date).getTime())/86400000;
  if(days<=3)return {name:'Atendido recientemente',cls:'ok'};
  if(days<=6)return {name:'Conviene revisar',cls:'warn'};
  return {name:'Sin riego reciente registrado',cls:'danger'};
}
function markerStyle(cls){
  const fill={ok:'#2f6d42',warn:'#9b6a00',danger:'#932f2a',unknown:'#7a8078'}[cls]||'#7a8078';
  return {radius:map.getZoom()>=18?5:map.getZoom()>=16?3.8:2.8,weight:1.2,color:'#fff',fillColor:fill,fillOpacity:.9};
}
function submissionId(){if(crypto.randomUUID)return `s_${crypto.randomUUID()}`;const b=new Uint32Array(4);crypto.getRandomValues(b);return `s_${Date.now()}_${[...b].join('')}`;}
function ensureSubmissionMeta(payload){if(!payload.submission_id)payload.submission_id=submissionId();return payload;}
function downloadBlob(blob,filename){const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1500);}
function downloadSubmission(payload,name='solicitud'){downloadBlob(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),`${name}-${Date.now()}.json`);}
function deliverSubmission(payload,name='solicitud',extraText=''){
  payload=ensureSubmissionMeta(payload);
  if(cfg.projectEmail){
    const subject=`[Árboles Lavapiés] ${payload.type} · ${payload.alias || 'Anónimo'}`;
    const body=[
      'Aportación para Árboles Lavapiés.',extraText,'No hace falta modificar el bloque siguiente:','',
      '---ARBOLES_LAVAPIES_JSON---',JSON.stringify(payload,null,2),'---FIN_ARBOLES_LAVAPIES_JSON---'
    ].filter(Boolean).join('\n');
    window.location.href=`mailto:${encodeURIComponent(cfg.projectEmail)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    showStatus('Se ha abierto tu correo. Pulsa Enviar para terminar.',5500);
  }else{
    downloadSubmission(payload,name);
    showStatus('Solicitud guardada como JSON. Falta configurar el correo del proyecto.',5000);
  }
}

async function nominatimFetch(url){
  const wait=Math.max(0,1100-(Date.now()-lastNominatimAt)); if(wait)await new Promise(r=>setTimeout(r,wait));
  lastNominatimAt=Date.now(); const r=await fetch(url,{headers:{'Accept-Language':'es'}}); if(!r.ok)throw new Error('nominatim'); return r.json();
}
async function nearestAddress(feature){
  const p=feature.properties||{}; if(p.near_address)return p.near_address; const id=idLabel(p); if(addressCache.has(id))return addressCache.get(id);
  const [lon,lat]=feature.geometry.coordinates;
  try{
    const r=await nominatimFetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=18&addressdetails=1&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`);
    const a=r.address||{}; const street=a.road||a.pedestrian||a.residential||a.footway||a.square||a.neighbourhood;
    const label=street?`${street}${a.house_number?` ${a.house_number}`:''} · ubicación aproximada`:'Embajadores · ubicación aproximada'; addressCache.set(id,label); return label;
  }catch{return p.barrio||'Embajadores';}
}

function weekBounds(offset=0){
  const d=new Date(); d.setHours(0,0,0,0); const weekday=(d.getDay()+6)%7; d.setDate(d.getDate()-weekday+(offset*7));
  const days=[]; for(let i=0;i<7;i++){const x=new Date(d);x.setDate(d.getDate()+i);days.push(x);} return days;
}
function renderWeek(id,offset=0){
  const days=weekBounds(offset); const names=['L','M','X','J','V','S','D'];
  const cells=days.map((d,i)=>{
    const start=new Date(d), end=new Date(d); end.setDate(end.getDate()+1);
    const ev=currentEventsFor(id).filter(e=>{const x=new Date(e.planned_for||e.date);return x>=start&&x<end;});
    const icons=[ev.some(e=>e.type==='watering')?'💧':'',ev.some(e=>e.type==='commitment')?'○':'',ev.some(e=>e.type==='issue')?'!':''].join('');
    return `<div class="week-cell"><b>${names[i]}</b><span>${d.getDate()}</span><em>${icons||'·'}</em></div>`;
  }).join('');
  const label=offset===0?'Esta semana':offset===-1?'Semana anterior':offset===1?'Semana siguiente':`${fmtDate(days[0])}–${fmtDate(days[6])}`;
  return `<div class="week-head"><button id="prevWeek" class="tiny-btn">←</button><strong class="ui-type">${esc(label)}</strong><button id="nextWeek" class="tiny-btn">→</button></div><div class="week-grid">${cells}</div>`;
}
function renderComments(id){
  const cs=currentEventsFor(id).filter(e=>e.type==='comment').sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  if(!cs.length)return '<p class="muted">Todavía no hay comentarios.</p>';
  const tops=cs.filter(c=>!c.reply_to);
  const one=c=>`<div class="comment ${c.reply_to?'reply':''}"><strong>${esc(c.alias||'Anónimo')}</strong><small>${esc(fmtDateTime(c.date))}</small><p>${esc(c.note||'')}</p><button class="tiny-btn reply-btn" data-reply="${esc(c.id)}">Responder</button></div>`;
  return tops.map(c=>one(c)+cs.filter(r=>r.reply_to===c.id).map(one).join('')).join('');
}
function renderPhotoAlbum(id){
  const ps=photosFor(id); if(!ps.length)return '<p class="muted">Todavía no hay fotografías publicadas.</p>';
  return `<div class="photo-grid">${ps.slice(0,12).map(p=>`<a href="${esc(p.file)}" target="_blank" rel="noopener"><img src="${esc(p.thumb||p.file)}" alt="${esc(p.caption||'Fotografía del árbol')}" loading="lazy"></a>`).join('')}</div>`;
}

function renderTreeDrawer(){
  if(!currentTreeFeature)return; const feature=currentTreeFeature,p=feature.properties||{},id=idLabel(p),state=wateringState(id),ev=currentEventsFor(id).filter(e=>e.type!=='comment').slice(0,8);
  drawerContent.innerHTML=`
    <div class="eyebrow">${esc(p.source==='community'?'Alta vecinal':'Inventario municipal')}</div>
    <h1 class="tree-title ui-type">${esc(id)}</h1>
    <p class="tree-meta"><span id="treeAddress">${esc(p.near_address||p.barrio||'Buscando ubicación cercana…')}</span><br>${esc(p.species||p.ESPECIE||'Especie sin identificar')}</p>
    <span class="pill">${esc(state.name)}</span>${p.height?`<span class="pill">${esc(p.height)} m</span>`:''}
    <div class="action-grid">
      <button data-action="watering" class="ui-type">💧 He regado</button><button data-action="commitment" class="ui-type">📅 Me encargo</button>
      <button data-action="comment" class="ui-type">💬 Comentar</button><button data-action="issue" class="ui-type">⚠ Incidencia</button>
      <button id="addPhotoBtn" class="ui-type">📷 Añadir foto</button>
    </div>
    <section class="timeline"><div class="eyebrow">Semana</div><div id="weekBlock">${renderWeek(id,currentWeekOffset)}</div></section>
    <section class="timeline"><div class="eyebrow">Actividad reciente</div>${ev.length?ev.map(e=>`<div class="event"><strong>${esc(eventLabel(e.type))}</strong>${e.issue_category?` <span class="pill">${esc(issueCategoryLabel(e.issue_category))}</span>`:''}<small>${esc(e.alias||'Anónimo')} · ${esc(fmtDateTime(e.planned_for||e.date))}</small>${e.note?`<div>${esc(e.note)}</div>`:''}</div>`).join(''):'<p class="muted">Todavía no hay actividad vecinal registrada.</p>'}</section>
    <section class="timeline"><div class="eyebrow">Comentarios</div>${renderComments(id)}</section>
    <section class="timeline"><div class="eyebrow">Archivo fotográfico</div>${renderPhotoAlbum(id)}</section>`;
  drawer.classList.add('open');
  drawerContent.querySelectorAll('[data-action]').forEach(btn=>btn.onclick=()=>openActionDialog(id,btn.dataset.action));
  drawerContent.querySelectorAll('.reply-btn').forEach(btn=>btn.onclick=()=>openActionDialog(id,'comment',btn.dataset.reply));
  $('#addPhotoBtn').onclick=()=>openPhotoDialog(id);
  $('#prevWeek').onclick=()=>{currentWeekOffset--;$('#weekBlock').innerHTML=renderWeek(id,currentWeekOffset);wireWeekNav(id);};
  $('#nextWeek').onclick=()=>{currentWeekOffset++;$('#weekBlock').innerHTML=renderWeek(id,currentWeekOffset);wireWeekNav(id);};
  nearestAddress(feature).then(address=>{const el=$('#treeAddress');if(el)el.textContent=address;});
}
function wireWeekNav(id){
  $('#prevWeek').onclick=()=>{currentWeekOffset--;$('#weekBlock').innerHTML=renderWeek(id,currentWeekOffset);wireWeekNav(id);};
  $('#nextWeek').onclick=()=>{currentWeekOffset++;$('#weekBlock').innerHTML=renderWeek(id,currentWeekOffset);wireWeekNav(id);};
}
function openTree(feature){currentTreeFeature=feature;currentWeekOffset=0;renderTreeDrawer();}

function renderCommitmentDates(){
  const box=$('#commitmentDates'); if(!box)return;
  box.innerHTML=commitmentDates.map(d=>`<span class="date-chip"><span>${esc(fmtDate(d))}</span><button type="button" data-remove-date="${esc(d)}" aria-label="Quitar ${esc(fmtDate(d))}">×</button></span>`).join('');
  box.querySelectorAll('[data-remove-date]').forEach(b=>b.onclick=()=>{commitmentDates=commitmentDates.filter(d=>d!==b.dataset.removeDate);renderCommitmentDates();});
}
function addCommitmentDate(value){
  if(!value)return; if(!commitmentDates.includes(value))commitmentDates.push(value); commitmentDates.sort(); renderCommitmentDates();
}
function openActionDialog(id,type,replyTo=null){
  actionContext={id,type,replyTo};
  const labels={watering:'Registrar riego',commitment:'Me comprometo a regar',comment:replyTo?'Responder comentario':'Escribir comentario',issue:'Registrar incidencia'};
  $('#actionEyebrow').textContent=id; $('#actionTitle').textContent=labels[type]||'Aportación'; $('#actionNote').value='';
  $('#commitmentFields').classList.toggle('hidden',type!=='commitment'); $('#issueFields').classList.toggle('hidden',type!=='issue');
  $('#actionNoteLabel').firstChild.textContent=type==='watering'?'Nota opcional':type==='issue'?'Descripción':'Mensaje';
  if(type==='commitment'){
    const today=new Date(); const tomorrow=new Date(today); tomorrow.setDate(today.getDate()+1);
    const min=today.toISOString().slice(0,10), first=tomorrow.toISOString().slice(0,10);
    $('#commitmentDate').min=min; $('#commitmentDate').value=first; commitmentDates=[first]; renderCommitmentDates();
  }else{commitmentDates=[];}
  actionDialog.showModal();
}
$('#addCommitmentDateBtn').onclick=()=>addCommitmentDate($('#commitmentDate').value);
$('#sendActionBtn').onclick=async()=>{
  if(!actionContext)return; const identity=await syncLocalIdentity();
  if(identity?.state==='rejected'){actionDialog.close();await refreshIdentityDialog();identityDialog.showModal();return;}
  const {id,type,replyTo}=actionContext; const note=$('#actionNote').value.trim();
  if(type==='comment'&&!note)return showStatus('Escribe el comentario.');
  const payload={type,place_id:id,date:new Date().toISOString(),note,alias:identity?.alias||'Anónimo'};
  if(type==='commitment'){
    if(!commitmentDates.length)addCommitmentDate($('#commitmentDate').value);
    if(!commitmentDates.length)return showStatus('Elige al menos un día.');
    payload.planned_for_dates=[...commitmentDates];
    if(commitmentDates.length===1)payload.planned_for=commitmentDates[0];
  }
  if(type==='issue')payload.issue_category=$('#issueCategory').value;
  if(replyTo)payload.reply_to=replyTo;
  if(identity?.secret)payload.identity_code=identity.secret;
  deliverSubmission(payload,`${type}-${id}`); actionDialog.close();
};

function openPhotoDialog(id){photoPlaceId=id;$('#photoInput').value='';$('#photoCaption').value='';$('#photoPreviewWrap').classList.add('hidden');$('#sendPhotoBtn').disabled=true;photoDialog.showModal();}
$('#photoInput').onchange=()=>{const f=$('#photoInput').files?.[0];if(!f){$('#sendPhotoBtn').disabled=true;return;}const url=URL.createObjectURL(f);$('#photoPreview').src=url;$('#photoPreviewWrap').classList.remove('hidden');$('#sendPhotoBtn').disabled=false;};
async function compressPhoto(file,maxSide=1600,quality=.78){
  const bmp=await createImageBitmap(file); const scale=Math.min(1,maxSide/Math.max(bmp.width,bmp.height)); const w=Math.max(1,Math.round(bmp.width*scale)),h=Math.max(1,Math.round(bmp.height*scale));
  const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;const ctx=canvas.getContext('2d');ctx.drawImage(bmp,0,0,w,h);bmp.close?.();
  const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('No se pudo comprimir la foto.')),'image/webp',quality)); return blob;
}
$('#sendPhotoBtn').onclick=async()=>{
  const file=$('#photoInput').files?.[0];if(!file||!photoPlaceId)return;
  const identity=await syncLocalIdentity(); if(identity?.state==='rejected'){photoDialog.close();await refreshIdentityDialog();identityDialog.showModal();return;}
  try{
    showStatus('Comprimiendo foto…',8000); const blob=await compressPhoto(file); const filename=`${photoPlaceId.replace(/[^a-z0-9_-]/gi,'_')}-${Date.now()}.webp`; downloadBlob(blob,filename);
    const payload={type:'photo',place_id:photoPlaceId,date:new Date().toISOString(),caption:$('#photoCaption').value.trim(),photo_filename:filename,alias:identity?.alias||'Anónimo'};
    if(identity?.secret)payload.identity_code=identity.secret;
    deliverSubmission(payload,`foto-${photoPlaceId}`,'La foto comprimida se ha descargado en tu dispositivo. ADJÚNTALA a este correo antes de enviarlo.');
    photoDialog.close(); showStatus(cfg.projectEmail?'Adjunta al correo la foto WebP que acaba de descargarse.':'Foto y solicitud descargadas para pruebas.',7000);
  }catch(e){showStatus(e.message||'No se pudo preparar la foto.',5000);}
};

function issueCategoryLabel(x){return ({dry:'Necesita agua',damaged:'Daño',missing:'Ausente / tocón',pit:'Alcorque',pest:'Plaga / enfermedad',map_error:'Error de mapa',danger:'Posible peligro',other:'Otra'})[x]||'Sin clasificar';}
function issuePriority(x){return ({danger:0,dry:1,damaged:2,pest:3,pit:4,missing:5,map_error:6,other:7})[x]??8;}
function openIssues(){
  const list=events.filter(e=>e.type==='issue'&&e.status!=='resolved').sort((a,b)=>issuePriority(a.issue_category)-issuePriority(b.issue_category)||String(b.date).localeCompare(String(a.date)));
  drawerContent.innerHTML=`<div class="eyebrow">Mapa vivo</div><h1 class="tree-title ui-type">Incidencias</h1><p>Observaciones que conviene revisar.</p>${list.length?list.map(e=>`<button type="button" class="issue-list-item issue-go" data-place="${esc(e.place_id||'')}"><span class="pill ${e.issue_category==='danger'?'issue-danger':e.issue_category==='dry'?'issue-warn':''}">${esc(issueCategoryLabel(e.issue_category))}</span><h3 class="ui-type">${esc(e.place_id||'Lugar')}</h3><small>${esc(fmtDate(e.date))}</small></button>`).join(''):'<div class="empty-block">No hay incidencias publicadas todavía.</div>'}`;
  drawer.classList.add('open'); drawerContent.querySelectorAll('.issue-go').forEach(b=>b.onclick=()=>{const place=b.dataset.place;drawer.classList.remove('open');goToPlace(place);});
}
function goToPlace(id){const f=trees.find(x=>idLabel(x.properties||{})===id)||places.find(x=>idLabel(x.properties||{})===id);if(!f)return showStatus('No encuentro ese lugar en el mapa.');const [lon,lat]=f.geometry.coordinates;map.flyTo([lat,lon],18);openTree(f);}

function openInfoMenu(){
  drawerContent.innerHTML=`<div class="eyebrow">Árboles Lavapiés</div><h1 class="tree-title ui-type">Información</h1><div class="info-menu"><button id="infoAbout" class="ui-type">¿Qué es?</button><button id="infoGuide" class="ui-type">Guía de jardinero urbano</button><button id="infoSuggest" class="ui-type">Buzón de sugerencias</button></div>`;
  drawer.classList.add('open'); $('#infoAbout').onclick=openAbout; $('#infoGuide').onclick=openGuide; $('#infoSuggest').onclick=()=>suggestDialog.showModal();
}
function openAbout(){
  const version=cfg.version||meta.version||'0.4.0';
  const lastReview=cfg.lastReview||meta.last_review;
  drawerContent.innerHTML=`<div class="eyebrow">Proyecto vecinal</div><h1 class="tree-title ui-type">¿Qué es?</h1>
  <p><strong>Árboles Lavapiés</strong> es un mapa vecinal para documentar y cuidar el arbolado y los espacios verdes del barrio, coordinar riegos y construir una memoria colectiva.</p>
  <p>Los datos iniciales se han obtenido del inventario municipal del Ayuntamiento de Madrid. Pueden contener errores, omisiones o información desactualizada: la idea es ir corrigiendo y ampliando el mapa entre todxs.</p>
  <p>Las aportaciones no aparecen necesariamente al instante. El archivo se consolida normalmente una vez al día y los cambios del mapa pasan por revisión antes de publicarse.</p>
  <div class="meta-card"><strong class="ui-type">Versión ${esc(version)}</strong><br>Última actualización de datos: ${esc(fmtDateTime(meta.last_update))}<br>Última revisión de esta versión: ${esc(fmtDateTime(lastReview))}<br>Inventario municipal: actualización ${esc(fmtDate(meta.tree_source?.dataset_updated||'2026-07-27'))}</div>
  <p class="muted">Fuente inicial: <a class="source-link" href="https://datos.madrid.es/dataset/300761-0-arbolado-especies" target="_blank" rel="noopener">Datos Abiertos del Ayuntamiento de Madrid · Arbolado en parques y zonas verdes de Madrid (detalle)</a>. Los datos oficiales son el punto de partida, no una descripción infalible del barrio.</p>
  <p>La intención de este proyecto es crecer con el barrio y, si resulta útil, adaptarse a otros distintos.</p>
  <div class="credit">Página creada por <a href="${esc(cfg.creatorUrl||'https://www.instagram.com/ipesoa/')}" target="_blank" rel="noopener"><strong>${esc(cfg.creatorName||'iPesoa editorial')}</strong></a>.</div>`;
  drawer.classList.add('open');
}
function openGuide(){
  drawerContent.innerHTML=`<div class="eyebrow">En construcción colectiva</div><h1 class="tree-title ui-type">Guía de jardinero urbano</h1><p>Esta guía está empezando. Queremos escribirla entre los vecinos y, cuando haga falta, contrastarla con fuentes técnicas fiables.</p><div class="empty-block"><strong>Ideas para desarrollar:</strong><ul class="guide-list"><li>cómo observar si un árbol puede necesitar agua;</li><li>cuándo regar y qué prácticas evitar;</li><li>árbol joven frente a árbol adulto;</li><li>alcorques, suelo y plantas acompañantes;</li><li>qué hacer durante una ola de calor;</li><li>cómo documentar problemas sin dañar el árbol;</li><li>recursos, semillas, actividades y encuentros del barrio.</li></ul></div><p>¿Sabes del tema, quieres corregir algo o proponer una actividad? Usa el <button id="guideSuggest" class="tiny-btn">buzón de sugerencias</button>.</p>`;
  drawer.classList.add('open');$('#guideSuggest').onclick=()=>suggestDialog.showModal();
}


function openSpread(){
  drawerContent.innerHTML=`<div class="eyebrow">Hazlo circular</div><h1 class="tree-title ui-type">Difunde</h1>
  <p>Si te apetece, puedes imprimir este cartel y colocarlo cerca de un árbol para que más vecinxs encuentren el mapa.</p>
  <div class="spread-card">
    <img src="assets/qr-arboles-lavapies.png?v=0.4.2" alt="QR de Árboles Lavapiés" />
    <div><strong class="ui-type">Cartel A4</strong><p class="muted">¿Puedes regar este árbol? Estamos tejiendo una red de apoyo a los árboles de Lavapiés.</p></div>
  </div>
  <a class="download-poster ui-type" href="assets/cartel-arboles-lavapies-a4.pdf" download>Descargar PDF A4</a>`;
  drawer.classList.add('open');
}

async function locateMe(){
  if(!('geolocation' in navigator)){
    showStatus('Tu navegador no ofrece ubicación. Puedes buscar tu calle arriba.',5200);
    return;
  }
  showStatus('Buscando tu ubicación…',9000);
  navigator.geolocation.getCurrentPosition(
    pos=>{map.flyTo([pos.coords.latitude,pos.coords.longitude],18);showStatus('Mostrando tu zona aproximada.');},
    err=>{
      const msg=err?.code===1
        ? 'La ubicación está bloqueada. Activa el permiso de ubicación para esta página o busca tu calle arriba.'
        : err?.code===3
          ? 'La ubicación está tardando demasiado. Prueba otra vez o busca tu calle arriba.'
          : 'No se pudo obtener tu ubicación. Puedes buscar tu calle arriba.';
      showStatus(msg,6500);
    },
    {enableHighAccuracy:false,timeout:10000,maximumAge:60000}
  );
}

function bindButton(id,handler){
  const el=document.getElementById(id);
  if(!el){console.warn(`[Árboles Lavapiés] falta #${id}`);return;}
  el.addEventListener('click',handler);
}

async function refreshIdentityNav(){
  const id=await syncLocalIdentity(); const btn=$('#profileBtn');
  if(!id){btn.innerHTML='Identidad';return;}
  const cls=id.state==='rejected'?'rejected':id.state==='pending'?'pending':'';btn.innerHTML=`<span class="online-dot ${cls}" title="Identidad activa en este navegador"></span>${esc(id.alias)}`;
}
function matchesUser(e,id){if(!id)return false;if(id.id&&e.user_id)return e.user_id===id.id;return String(e.alias||'').toLocaleLowerCase('es-ES')===String(id.alias||'').toLocaleLowerCase('es-ES');}
async function refreshIdentityDialog(){
  const box=$('#identityCurrent'),create=$('#identityCreate'),id=await syncLocalIdentity();await refreshIdentityNav();
  if(!id){box.classList.add('hidden');create.classList.remove('hidden');return;}
  box.classList.remove('hidden');create.classList.add('hidden');
  if(id.state==='rejected'&&id.rejection_reason==='alias_taken'){
    box.innerHTML=`<div class="identity-warning"><div class="eyebrow">Actualización diaria</div><h3 class="ui-type">Necesitamos cambiar tu nombre</h3><p>Lo sentimos: mientras tu identidad esperaba la actualización, otra persona registró <strong>${esc(id.alias)}</strong> antes. Tu código sigue siendo válido; sólo tienes que elegir otro alias.</p></div><label>Nuevo alias<input id="renameAlias" maxlength="28" placeholder="${esc(id.alias)}_2"></label><button id="renameBtn" type="button" class="primary full ui-type">Usar este nombre</button><button id="logoutBtn" type="button" class="full ui-type">Crear una identidad distinta</button>`;
    $('#renameBtn').onclick=async()=>{try{const updated=await renameRejectedIdentity($('#renameAlias').value);deliverSubmission(registrationPayload(updated),`registro-${updated.alias}`);await refreshIdentityDialog();}catch(e){showStatus(e.message,4500);}};
    $('#logoutBtn').onclick=()=>{logout();refreshIdentityDialog();refreshIdentityNav();}; return;
  }
  const mine=events.filter(e=>matchesUser(e,id));
  const counts={}; mine.filter(e=>e.type==='watering').forEach(e=>counts[e.place_id]=(counts[e.place_id]||0)+1);
  const habitual=Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,6);
  const today=new Date().toISOString().slice(0,10); const pending=mine.filter(e=>e.type==='commitment'&&e.planned_for&&e.planned_for>=today).sort((a,b)=>String(a.planned_for).localeCompare(String(b.planned_for))).slice(0,8);
  const secretHtml=id.secret?`<div class="identity-secret-small"><span>Código</span><code>${esc(id.secret)}</code><button id="copyIdentityCode" type="button">Copiar</button></div>`:'';
  box.innerHTML=`<div class="identity-head"><span class="online-dot" title="Identidad activa en este navegador"></span><strong class="ui-type">${esc(id.alias)}</strong></div>${secretHtml}<div class="drawer-section"><div class="eyebrow">Árboles habituales</div><p class="profile-help">Los árboles que normalmente riego.</p>${habitual.length?`<ul class="profile-list">${habitual.map(([place])=>`<li><button type="button" data-goto="${esc(place)}">${esc(place)}</button></li>`).join('')}</ul>`:'<div class="profile-blank"></div>'}</div><div class="drawer-section"><div class="eyebrow">Pendientes / compromisos</div>${pending.length?`<ul class="profile-list">${pending.map(e=>`<li><button type="button" data-goto="${esc(e.place_id)}">${esc(e.place_id)}</button><br><span class="muted">${esc(fmtDate(e.planned_for))}${e.note?` · ${esc(e.note)}`:''}</span></li>`).join('')}</ul>`:'<div class="profile-blank"></div>'}</div><button id="logoutBtn" type="button" class="full ui-type">Salir de esta identidad</button>`;
  box.querySelectorAll('[data-goto]').forEach(b=>b.onclick=()=>{identityDialog.close();goToPlace(b.dataset.goto);});
  const copyBtn=$('#copyIdentityCode'); if(copyBtn)copyBtn.onclick=async()=>{await navigator.clipboard.writeText(id.secret);showStatus('Código copiado.');};
  $('#logoutBtn').onclick=()=>{logout();refreshIdentityDialog();refreshIdentityNav();};
}

async function loadData(){
  const stamp=encodeURIComponent(cfg.version||String(Date.now()));
  const getJson=async(path,fallback)=>{
    try{
      const sep=path.includes('?')?'&':'?';
      const r=await fetch(`${path}${sep}v=${stamp}`,{cache:'no-store'});
      if(!r.ok)throw new Error(`${path}: HTTP ${r.status}`);
      return await r.json();
    }catch(e){
      console.error('[Árboles Lavapiés]',e);
      return fallback;
    }
  };
  const [tr,er,pr,phr,mr]=await Promise.all([
    getJson('./data/trees.geojson',{type:'FeatureCollection',features:[]}),
    getJson('./data/events.json',[]),
    getJson('./data/places.geojson',{type:'FeatureCollection',features:[]}),
    getJson('./data/photos.json',[]),
    getJson('./data/meta.json',{})
  ]);
  trees=Array.isArray(tr?.features)?tr.features:[];
  events=Array.isArray(er)?er:[];
  places=Array.isArray(pr?.features)?pr.features:[];
  photos=Array.isArray(phr)?phr:[];
  meta=mr||{};
  renderTrees(trees);renderCommunity(places);updateCounter(trees.length);await refreshIdentityNav();
  if(trees.length){
    showStatus(`${trees.length.toLocaleString('es-ES')} árboles cargados`,4200);
  }else{
    showStatus('El inventario de árboles no se ha cargado todavía. Hay que volver a actualizar los datos del mapa.',7000);
  }
}
function renderTrees(features){
  treeLayer.clearLayers(); for(const f of features){if(!f.geometry||f.geometry.type!=='Point')continue;const [lon,lat]=f.geometry.coordinates,id=idLabel(f.properties||{}),st=wateringState(id);L.circleMarker([lat,lon],markerStyle(st.cls)).bindTooltip(id,{direction:'top',opacity:.8}).on('click',()=>openTree(f)).addTo(treeLayer);}
}
function renderCommunity(features){communityLayer.clearLayers();for(const f of features){if(!f.geometry)continue;const [lon,lat]=f.geometry.coordinates;L.circleMarker([lat,lon],{radius:6,weight:2,color:'#315f82',fillColor:'#315f82',fillOpacity:.7}).on('click',()=>openTree(f)).addTo(communityLayer);}}
function updateCounter(n){const el=$('#mapCounter');if(!n){el.classList.add('hidden');return;}el.textContent=`${n.toLocaleString('es-ES')} árboles · Embajadores`;el.classList.remove('hidden');}
map.on('zoomend',()=>{treeLayer.eachLayer(l=>{if(l.setRadius)l.setRadius(map.getZoom()>=18?5:map.getZoom()>=16?3.8:2.8);});});

async function geocode(query){const q=query.includes('Madrid')?query:`${query}, ${cfg.defaultSearchSuffix}`;return nominatimFetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&countrycodes=es&q=${encodeURIComponent(q)}`);}
async function doSearch(){const q=$('#searchInput').value.trim();if(!q)return;const local=trees.find(f=>idLabel(f.properties||{}).toLowerCase()===q.toLowerCase());if(local){const [lon,lat]=local.geometry.coordinates;map.flyTo([lat,lon],19);openTree(local);return;}showStatus('Buscando…',5000);try{const rs=await geocode(q);if(!rs.length)return showStatus('No encuentro esa dirección.');map.flyTo([+rs[0].lat,+rs[0].lon],18);showStatus(rs[0].display_name);}catch{showStatus('La búsqueda de direcciones no está disponible ahora.');}}

bindButton('searchBtn',doSearch);
$('#searchInput')?.addEventListener('keydown',e=>{if(e.key==='Enter')doSearch();});
bindButton('nearBtn',locateMe);
bindButton('drawerClose',()=>drawer.classList.remove('open'));
bindButton('profileBtn',async()=>{await refreshIdentityDialog();identityDialog.showModal();});
bindButton('addPlaceBtn',()=>addDialog.showModal());
bindButton('issuesBtn',openIssues);
bindButton('guideBtn',openGuide);
bindButton('suggestBtn',()=>suggestDialog.showModal());
bindButton('aboutBtn',openAbout);
bindButton('spreadBtn',openSpread);
$('#needsBtn').onclick=()=>{showingNeeds=!showingNeeds;if(showingNeeds){const needy=trees.filter(f=>wateringState(idLabel(f.properties||{})).cls==='danger');renderTrees(needy);updateCounter(needy.length);showStatus(needy.length?`${needy.length} árboles con riego antiguo registrado.`:'Todavía no hay árboles marcados como atrasados; los que no tienen historial siguen en gris.');$('#needsBtn').textContent='Mostrar todos';}else{renderTrees(trees);updateCounter(trees.length);showStatus('Mostrando todos los árboles.');$('#needsBtn').textContent='Necesitan agua';}};

$('#createIdentityBtn').onclick=async()=>{const alias=$('#aliasInput').value.trim();try{if(await aliasExists(alias))throw new Error('Ese alias ya está publicado. Elige otro.');const id=await createPendingIdentity(alias);$('#secretAlias').textContent=id.alias;$('#secretCode').textContent=id.secret;identityDialog.close();secretDialog.showModal();deliverSubmission(registrationPayload(id),`registro-${id.alias}`);await refreshIdentityNav();}catch(e){showStatus(e.message,4500);}};
$('#loginBtn').onclick=async()=>{try{await login($('#loginAlias').value,$('#loginCode').value);identityDialog.close();await refreshIdentityNav();showStatus(`Has entrado como ${getLocalIdentity().alias}`);}catch(e){showStatus(e.message,4000);}};
$('#copySecretBtn').onclick=async()=>{await navigator.clipboard.writeText($('#secretCode').textContent);showStatus('Código copiado.');};$('#secretDoneBtn').onclick=async()=>{secretDialog.close();await refreshIdentityDialog();showStatus('Identidad guardada en este navegador.');};

$('#startPinBtn').onclick=()=>{addDialog.close();pinMode=true;showStatus('Toca el mapa donde está el lugar.',5000);};
map.on('click',e=>{if(!pinMode)return;pinMode=false;pendingLatLng=e.latlng;if(pendingMarker)pendingMarker.remove();pendingMarker=L.marker(e.latlng,{draggable:true}).addTo(map);pendingMarker.on('dragend',ev=>{pendingLatLng=ev.target.getLatLng();updateCoords();});updateCoords();addDialog.showModal();});
function updateCoords(){$('#placeCoords').textContent=pendingLatLng?`${pendingLatLng.lat.toFixed(6)}, ${pendingLatLng.lng.toFixed(6)}`:'Sin ubicación todavía';$('#preparePlaceBtn').disabled=!pendingLatLng;}
$('#preparePlaceBtn').onclick=async()=>{if(!pendingLatLng)return;const id=await syncLocalIdentity();if(id?.state==='rejected'){addDialog.close();await refreshIdentityDialog();identityDialog.showModal();return;}const payload={type:'new_place',place_type:$('#placeType').value,lat:pendingLatLng.lat,lon:pendingLatLng.lng,note:$('#placeNote').value.trim(),date:new Date().toISOString(),alias:id?.alias||'Anónimo'};if(id?.secret)payload.identity_code=id.secret;deliverSubmission(payload,'nuevo-lugar');addDialog.close();showStatus('Alta preparada. Queda pendiente de revisión y actualización.');};

$('#sendSuggestBtn').onclick=async()=>{const text=$('#suggestText').value.trim();if(!text)return showStatus('Escribe la sugerencia.');const id=await syncLocalIdentity();const payload={type:'suggestion',category:$('#suggestCategory').value,note:text,date:new Date().toISOString(),alias:id?.alias||'Anónimo'};if(id?.secret)payload.identity_code=id.secret;deliverSubmission(payload,'sugerencia');suggestDialog.close();$('#suggestText').value='';};

syncLocalIdentity().finally(loadData);
