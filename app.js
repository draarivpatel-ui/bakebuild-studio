/* Canvas-based CPU triangle renderer: rotate, zoom, depth-sort, shaded mesh. */
'use strict';
const CAD = globalThis.BakeBuildCAD;
(() => {
  const canvas=document.getElementById('preview'), ctx=canvas.getContext('2d');
  const select=document.getElementById('design');
  let model, yaw=-0.55, pitch=-0.75, zoom=1, dragging=null;
  for (const d of CAD.DESIGNS) { const option=document.createElement('option'); option.value=d.id; option.textContent=d.name; select.append(option); }
  function transform(p) {
    const center=model.bounds.min.map((v,i)=>(v+model.bounds.max[i])/2);
    const [x,y,z]=p.map((v,i)=>v-center[i]);
    const a=x*Math.cos(yaw)-y*Math.sin(yaw), b=x*Math.sin(yaw)+y*Math.cos(yaw);
    return [a,b*Math.cos(pitch)-z*Math.sin(pitch),b*Math.sin(pitch)+z*Math.cos(pitch)];
  }
  function render() {
    if (!model||!ctx) return;
    const box=canvas.getBoundingClientRect(), dpr=window.devicePixelRatio||1;
    canvas.width=Math.max(1,Math.round(box.width*dpr)); canvas.height=Math.max(1,Math.round(box.height*dpr)); ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.fillStyle='#111b26'; ctx.fillRect(0,0,box.width,box.height);
    const scale=Math.min(box.width,box.height)/Math.max(...model.dimensions)*0.72*zoom;
    const triangles=CAD.depthSort(model.triangles.map(t=>t.map(transform)));
    for (const t of triangles) {
      const u=t[1].map((v,i)=>v-t[0][i]),v=t[2].map((v,i)=>v-t[0][i]);
      const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
      const light=0.4+0.6*Math.abs((n[0]*0.3+n[1]*-0.5+n[2]*0.8)/(Math.hypot(...n)||1));
      ctx.beginPath(); t.forEach((p,i)=>ctx[i?'lineTo':'moveTo'](box.width/2+p[0]*scale,box.height/2-p[1]*scale)); ctx.closePath();
      ctx.fillStyle=`hsl(168 58% ${Math.min(75,25+light*42)}%)`; ctx.fill(); ctx.strokeStyle='rgba(9,30,35,0.16)'; ctx.lineWidth=0.5; ctx.stroke();
    }
  }
  function choose() {
    model=CAD.generate(select.value); document.getElementById('model-name').textContent=model.name;
    document.getElementById('dimensions').textContent=model.dimensions.map(n=>n.toFixed(2)).join(' × ')+' mm';
    const status=document.getElementById('status'); status.textContent=model.validation.pass?'All geometry rules pass':'Rule check failed'; status.className=model.validation.pass?'pass':'fail';
    const list=document.getElementById('checks'); list.replaceChildren();
    for (const check of model.validation.checks) { const li=document.createElement('li'); li.textContent=(check.pass?'✓ ':'✕ ')+check.rule; li.className=check.pass?'pass':'fail'; list.append(li); }
    render();
  }
  function download(extension) { const contents=extension==='step'?CAD.toSTEP(model):CAD.toSTL(model); const url=URL.createObjectURL(new Blob([contents],{type:'text/plain;charset=utf-8'})); const a=document.createElement('a'); a.href=url; a.download=model.id+'.'+extension; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000); }
  select.addEventListener('change',choose);
  document.getElementById('reset').addEventListener('click',()=>{yaw=-0.55;pitch=-0.75;zoom=1;render();});
  for (const ext of ['step','stl']) document.getElementById(ext).addEventListener('click',()=>download(ext));
  canvas.addEventListener('pointerdown',e=>{dragging=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId);});
  canvas.addEventListener('pointermove',e=>{if(!dragging)return;yaw+=(e.clientX-dragging[0])*0.01;pitch+=(e.clientY-dragging[1])*0.01;dragging=[e.clientX,e.clientY];render();});
  for (const event of ['pointerup','pointercancel','lostpointercapture']) canvas.addEventListener(event,()=>dragging=null);
  canvas.addEventListener('wheel',e=>{e.preventDefault();zoom=Math.max(0.4,Math.min(3,zoom*Math.exp(-e.deltaY*0.001)));render();},{passive:false});
  canvas.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-'].includes(e.key))return;e.preventDefault();if(e.key==='ArrowLeft')yaw-=0.1;if(e.key==='ArrowRight')yaw+=0.1;if(e.key==='ArrowUp')pitch-=0.1;if(e.key==='ArrowDown')pitch+=0.1;if(e.key==='+'||e.key==='=')zoom=Math.min(3,zoom+0.1);if(e.key==='-')zoom=Math.max(0.4,zoom-0.1);render();});
  window.addEventListener('resize',render); choose();
  const labSection=document.getElementById('lab'), LAB=globalThis.BakeBuildLab;
  if (labSection) { if (!LAB) labSection.hidden=true; else initLab(); }
  function fire(el,type) { if (typeof el.dispatchEvent==='function') el.dispatchEvent(new Event(type)); else if (typeof el.dispatch==='function') el.dispatch(type); }
  function initLab() {
    labSection.hidden=false;
    const nozzleSel=document.getElementById('lab-nozzle'), matSel=document.getElementById('lab-material');
    const probeIn=document.getElementById('lab-probe'), probeLabel=document.getElementById('lab-probe-label');
    const tbody=document.getElementById('lab-tbody'), massCol=document.getElementById('lab-mass-col');
    const xsec=document.getElementById('lab-xsec'), xsecCap=document.getElementById('lab-xsec-cap');
    const chart=document.getElementById('lab-ratio'), ratioCap=document.getElementById('lab-ratio-cap');
    const digestEl=document.getElementById('lab-digest'), statusEl=document.getElementById('lab-status');
    const shareField=document.getElementById('lab-share-url');
    const testCount=document.getElementById('lab-test-count'), testList=document.getElementById('lab-test-list');
    const SVGNS='http://www.w3.org/2000/svg';
    const se=tag=>typeof document.createElementNS==='function'?document.createElementNS(SVGNS,tag):document.createElement(tag);
    const addSvg=(parent,tag,attrs)=>{const el=se(tag);for(const k of Object.keys(attrs))el.setAttribute(k,attrs[k]);parent.append(el);return el;};
    const state={model:select.value||CAD.DESIGNS[0].id,nozzle:0.4,material:'PLA',probe:0.8};
    const reports=LAB.compareModels();
    const designOf=id=>CAD.DESIGNS.find(d=>d.id===id)||CAD.DESIGNS[0];
    const probeDefault=()=>designOf(state.model).type==='cutter'?CAD.RULES.lip:CAD.RULES.holeDiameter;
    state.probe=probeDefault();
    for (const n of LAB.NOZZLES) { const o=document.createElement('option'); o.value=String(n); o.textContent=n.toFixed(1)+' mm nozzle'; nozzleSel.append(o); }
    for (const k of Object.keys(LAB.MATERIALS)) { const o=document.createElement('option'); o.value=k; o.textContent=k; matSel.append(o); }
    nozzleSel.value=String(state.nozzle); matSel.value=state.material;
    function syncProbeMeta() {
      const cutter=designOf(state.model).type==='cutter';
      probeLabel.textContent=cutter?'Lip offset probe (mm)':'Hole diameter probe (mm)';
      probeIn.min=cutter?'0.1':'1'; probeIn.max=cutter?'8':'20'; probeIn.step=cutter?'0.1':'0.5';
    }
    function cell(tr,text) { const td=document.createElement('td'); td.textContent=text; tr.append(td); return td; }
    function renderTable() {
      tbody.replaceChildren();
      massCol.textContent='Mass '+state.material+' (g)';
      for (const r of reports) {
        const tr=document.createElement('tr');
        if (r.id===state.model) tr.className='sel';
        cell(tr,r.name);
        cell(tr,r.dimensions.map(n=>n.toFixed(2)).join(' × '));
        cell(tr,r.volume.toFixed(1));
        cell(tr,r.surfaceArea.toFixed(0));
        cell(tr,r.topo.chi+' / '+r.topo.boundary+' / '+r.topo.nonManifold);
        cell(tr,r.step.entities+' / '+r.step.bytes);
        cell(tr,r.stl.facets+' / '+r.stl.bytes);
        cell(tr,r.mass[state.material].toFixed(2));
        const td=cell(tr,'');
        const b=document.createElement('button');
        b.type='button'; b.textContent='Inspect';
        b.setAttribute('aria-label','Inspect '+r.name+' in the 3D viewport');
        b.addEventListener('click',()=>{select.value=r.id;fire(select,'change');if(typeof canvas.focus==='function')canvas.focus();if(typeof canvas.scrollIntoView==='function')canvas.scrollIntoView({block:'center'});});
        td.append(b); tbody.append(tr);
      }
    }
    const path2=pts=>'M'+pts.map(p=>p[0].toFixed(3)+','+(-p[1]).toFixed(3)).join('L')+'Z';
    function probeContour(data) {
      if (data.type==='cutter') return CAD.offset(data.outer,state.probe);
      const n=designOf(state.model).sectors, r=(state.probe/2)/Math.cos(Math.PI/n);
      return Array.from({length:n},(_,i)=>[r*Math.cos(2*Math.PI*i/n),r*Math.sin(2*Math.PI*i/n)]);
    }
    function renderXsec() {
      const data=LAB.contourData(state.model);
      const probe=LAB.probeResult(state.model,state.nozzle,state.probe);
      const E=data.extent*1.12;
      xsec.setAttribute('viewBox',(-E)+' '+(-E)+' '+(2*E)+' '+(2*E));
      xsec.replaceChildren();
      addSvg(xsec,'path',{d:path2(data.outer),'class':'contour','aria-label':'model outline'});
      for (const band of data.offsets)
        addSvg(xsec,'path',{d:path2(band.points),'class':'band '+band.label,role:'img','aria-label':band.label+' offset '+band.width+' mm'});
      if (data.hole) {
        addSvg(xsec,'path',{d:path2(data.hole.points),'class':'holeline',role:'img','aria-label':'hole boundary polygon'});
        addSvg(xsec,'circle',{cx:0,cy:0,r:data.hole.clearRadius,'class':'clear',role:'img','aria-label':'clear '+data.hole.clearRadius*2+' mm hole circle'});
      }
      addSvg(xsec,'path',{d:path2(probeContour(data)),'class':'probe-line',role:'img','aria-label':'probe '+state.probe+' mm, ratio '+probe.ratio});
      addSvg(xsec,'circle',{cx:data.outer[0][0],cy:-data.outer[0][1],r:E*0.02,'class':'marker',role:'img','aria-label':'model outline vertex marker'});
      xsecCap.textContent=data.type==='cutter'
        ?'Offsets: lip 0.8 mm, wall 2.0 mm, rim 5.0 mm. Dashed trace is the '+state.probe+' mm probe at nozzle ratio '+probe.ratio+'. True mm scale.'
        :'Clear '+data.hole.clearRadius*2+' mm hole circle inside its polygon. Dashed trace is the '+state.probe+' mm probe with '+probe.minRing+' mm minimum ring. True mm scale.';
    }
    function renderRatio() {
      const sweep=LAB.sweepForModel(state.model,state.nozzle), rows=sweep.rows;
      const W=360,H=170,pad=26,maxR=Math.max(3,...rows.map(r=>r.ratio||0));
      const bw=(W-2*pad)/rows.length, yv=v=>H-pad-(v/maxR)*(H-2*pad);
      chart.replaceChildren();
      addSvg(chart,'line',{x1:pad,x2:W-pad,y1:yv(LAB.MIN_WALL_RATIO),y2:yv(LAB.MIN_WALL_RATIO),'class':'thresh'});
      addSvg(chart,'line',{x1:pad,x2:pad,y1:pad*0.5,y2:H-pad,'class':'axis'});
      addSvg(chart,'line',{x1:pad,x2:W-pad,y1:H-pad,y2:H-pad,'class':'axis'});
      const label=addSvg(chart,'text',{x:pad+4,y:yv(LAB.MIN_WALL_RATIO)-3});
      label.textContent=LAB.MIN_WALL_RATIO+' printable threshold';
      rows.forEach((r,i)=>{
        if (r.ratio==null) return;
        addSvg(chart,'rect',{x:(pad+i*bw+1.5).toFixed(2),y:yv(r.ratio).toFixed(2),width:Math.max(1,bw-3).toFixed(2),height:(H-pad-yv(r.ratio)).toFixed(2),'class':'bar '+(r.printable?'ok':'warn')+(r.x===state.probe?' cur':''),role:'img','aria-label':(sweep.kind==='lip'?'lip ':'hole ')+r.x+' mm: ratio '+r.ratio+(r.printable?', printable':', below threshold')});
      });
      ratioCap.textContent='Sweep of '+(sweep.kind==='lip'?'lip width':'hole diameter')+' on a '+state.nozzle.toFixed(1)+' mm nozzle; the probed row is outlined.';
    }
    function shareLink() {
      const hash=LAB.encodeHash(state)||'';
      let base='';
      try { const loc=window.location; if (loc&&loc.href) base=String(loc.href).split('#')[0]; } catch (e) {}
      return base+hash;
    }
    function refreshAudit() {
      const st=LAB.auditPayload(state);
      digestEl.textContent=st?st.digest.slice(0,16)+'…':'unavailable';
      digestEl.setAttribute('data-digest',st?st.digest:'');
      shareField.value=shareLink();
    }
    function renderAll() { renderTable(); renderXsec(); renderRatio(); refreshAudit(); }
    function applyHash() {
      let h='';
      try { const loc=window.location; h=(loc&&loc.hash)||''; } catch (e) {}
      if (!h) return false;
      const s=LAB.decodeHash(h);
      if (!s) return false;
      state.model=s.model; select.value=s.model; fire(select,'change');
      state.nozzle=s.nozzle; state.material=s.material; state.probe=s.probe;
      nozzleSel.value=String(s.nozzle); matSel.value=s.material; probeIn.value=String(s.probe);
      syncProbeMeta(); renderAll();
      return true;
    }
    select.addEventListener('change',()=>{state.model=select.value;state.probe=probeDefault();probeIn.value=String(state.probe);syncProbeMeta();renderAll();});
    nozzleSel.addEventListener('change',()=>{state.nozzle=Number(nozzleSel.value);renderAll();});
    matSel.addEventListener('change',()=>{state.material=matSel.value;renderAll();});
    probeIn.addEventListener('input',()=>{const v=Number(probeIn.value);if(Number.isFinite(v)&&v>0&&v<=50){state.probe=v;renderAll();}});
    probeIn.addEventListener('change',()=>{state.probe=LAB.normalizeProbe(state.model,Number(probeIn.value));probeIn.value=String(state.probe);renderAll();});
    function dl(name,text,mime) {
      if (!text) return false;
      const url=URL.createObjectURL(new Blob([text],{type:mime}));
      const a=document.createElement('a'); a.href=url; a.download=name; document.body.append(a); a.click(); a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      return true;
    }
    function exportClick(id,name,mime,fn) {
      document.getElementById(id).addEventListener('click',()=>{
        statusEl.textContent=dl(name,fn(),mime)?'Audit file downloaded. Digest '+(LAB.auditDigest(state)||'').slice(0,16)+'…':'Nothing to export: invalid lab state.';
      });
    }
    exportClick('lab-json','bakebuild-audit.json','application/json',()=>LAB.exportJSON(state));
    exportClick('lab-csv','bakebuild-audit.csv','text/csv',()=>LAB.exportCSV(state));
    exportClick('lab-md','bakebuild-audit.md','text/markdown',()=>LAB.exportMarkdown(state));
    document.getElementById('lab-share').addEventListener('click',()=>{
      const link=shareLink(); shareField.value=link;
      let done=false;
      try { if (globalThis.navigator&&navigator.clipboard&&navigator.clipboard.writeText) { navigator.clipboard.writeText(link); done=true; } } catch (e) {}
      statusEl.textContent=done?'Share link copied to clipboard.':'Share link placed in the field below; copy it from there.';
    });
    document.getElementById('lab-verify').addEventListener('click',()=>{
      const st=LAB.auditPayload(state);
      statusEl.textContent=st&&LAB.verifyDigest(st.payload,st.digest)?'Digest verified: the payload recomputes to the stamped SHA-256.':'Digest check failed.';
    });
    document.getElementById('lab-tamper').addEventListener('click',()=>{
      const st=LAB.auditPayload(state);
      if (!st) { statusEl.textContent='No audit payload to tamper with.'; return; }
      statusEl.textContent=!LAB.verifyDigest(LAB.tamperPayload(st.payload),st.digest)?'Tamper detected: a one-millimetre volume change no longer matches the digest.':'Tamper demo failed to flag the change.';
    });
    document.getElementById('lab-run-tests').addEventListener('click',()=>{
      const results=LAB.runSelfTests();
      testList.replaceChildren();
      let pass=0;
      for (const r of results) {
        if (r.pass) pass++;
        const li=document.createElement('li');
        li.textContent=(r.pass?'✓ ':'✕ ')+r.name+(r.detail?' ('+r.detail+')':'');
        li.className=r.pass?'pass':'fail';
        testList.append(li);
      }
      testCount.textContent=pass+'/'+results.length+' passing';
    });
    if (typeof window.addEventListener==='function') window.addEventListener('hashchange',applyHash);
    syncProbeMeta();
    if (!applyHash()) { probeIn.value=String(state.probe); renderAll(); }
  }
})();
