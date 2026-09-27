/* Sales Dashboard - client-side analytics over data.js payload
   Sources (SAP ECC PRD, duckdb 'sap_prd'):
     fact_ztsd_detail + fact_plant_sales_target + dim_plants + dim_ztso_details.
   All values SAR. sales = SUM(net_value) of Sales/Special lines;
   returns = magnitude of Return lines; qty = qty_in_sku (base units);
   target from fact_plant_sales_target (werks x zmonth).
   sales_office IS the plant key. */
'use strict';

const FONT = "'Segoe UI', Roboto, Arial, sans-serif";
const SEG_ORDER = ['B2B','B2C','HRC','OLN',''];
const SEG_NAME = {B2B:'B2B',B2C:'B2C',HRC:'Horeca',OLN:'Online','':'Unclassified'};
const SEG_COLOR = {B2B:'#4f8cff',B2C:'#22c1a4',HRC:'#f5a623',OLN:'#a78bfa','':'#8a99af'};

let DATA = null;          // window.__SALES__
const state = {
  year:'', month:'', plant:'', segment:'',
  pSortKey:'sales', pSortDir:-1, pPage:1, pPageSize:20,
  prSortKey:'sales', prSortDir:-1, prPage:1, prPageSize:20,
  segSortKey:'sales', segSortDir:-1,
  cSortKey:'sales', cSortDir:-1, cPage:1, cPageSize:20,
  pCols:{},
};
const charts = {};
let CURRENT_THEME = 'dark';

/* ---------- helpers ---------- */
const fmtInt = n => Math.round(n==null?0:n).toLocaleString('en-US',{maximumFractionDigits:0});
const fmtNum = (n,d=2) => (n==null?0:n).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:d});
const fmtSAR = n => 'SAR '+fmtInt(n);
const fmtM = n => fmtNum(n/1e6,2)+'M';
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const strip0 = s => String(s==null?'':s).replace(/^0+/,'')||'0';
function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

/* ---------- theme ---------- */
/* Sun/moon pair for the account-menu theme row. Both stay in the DOM and
   cross-fade, so enter AND exit animate. */
const THEME_ICONS=
  '<span class="icon-stack">'+
  '<svg class="icon icon-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'+
  '<svg class="icon icon-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/></svg>'+
  '</span><span class="theme-item-label"></span>';
function applyTheme(t){
  CURRENT_THEME=t;
  document.documentElement.setAttribute('data-theme',t);
  try{localStorage.setItem('sales-theme',t);}catch(e){}
  const btn=document.getElementById('theme-toggle');
  if(btn){
    // Account-menu row: sun/moon icon + the theme you would switch TO.
    if(!btn.querySelector('.icon-stack')) btn.innerHTML=THEME_ICONS;
    const lab=btn.querySelector('.theme-item-label');
    if(lab) lab.textContent = t==='light' ? 'Dark theme' : 'Light theme';
    btn.setAttribute('aria-label', t==='light' ? 'Switch to dark theme' : 'Switch to light theme');
    btn.title=btn.getAttribute('aria-label');
  }
  Chart.defaults.color = cssVar('--muted') || '#8a99af';
  Chart.defaults.borderColor = t==='light' ? 'rgba(20,30,50,.12)' : 'rgba(42,54,71,.6)';
}
function initTheme(){
  let t='dark';
  try{ t = localStorage.getItem('sales-theme') || 'dark'; }catch(e){}
  applyTheme(t==='light'?'light':'dark');
}
Chart.defaults.font.family=FONT;

/* ---------- plant / target lookups ---------- */
const PLANTS = {};   // werks -> [name, bukrs, regio, city, seg]
function plantInfo(w){ const p=PLANTS[w]; return p?{name:p[0],bukrs:p[1],regio:p[2],city:p[3],seg:p[4]}:{name:w,bukrs:'',regio:'',city:'',seg:''}; }
function plantSegment(w){ const p=PLANTS[w]; return p?p[4]:''; }
const TARGET_DEF = {};  // werks -> {ym: target}

function inRange(ym){
  if(state.year && ym.slice(0,4)!==state.year) return false;
  if(state.month && ym!==state.month) return false;
  return true;
}
function selectedPlants(){
  return state.plant ? [state.plant] : Object.keys(PLANTS);
}

/* filtered analytical rows at ym x plant x segment */
function filteredRows(){
  const out=[];
  for(const r of DATA.rows){
    if(state.plant && r[1]!==state.plant) continue;
    if(state.segment!=='' && r[2]!==state.segment) continue;
    if(!inRange(r[0])) continue;
    out.push(r);
  }
  return out;
}

/* ---------- aggregation ---------- */
function sum(rows,f){ let s=0; for(const r of rows) s+=(f(r)||0); return s; }
function monthSales(rows){
  const m={};
  for(const r of rows){ const k=r[0]; const o=m[k]||(m[k]={sales:0,returns:0,qty:0,inv:0}); o.sales+=r[3]||0; o.returns+=r[4]||0; o.qty+=r[5]||0; o.inv+=r[6]||0; }
  return Object.entries(m).sort((a,b)=>a[0]<b[0]?-1:1);
}
function monthTarget(){
  const t={};
  for(const w of selectedPlants()){
    const def=TARGET_DEF[w]; if(!def) continue;
    for(const ym in def){ if(!inRange(ym)) continue; t[ym]=(t[ym]||0)+def[ym]; }
  }
  return Object.entries(t).sort((a,b)=>a[0]<b[0]?-1:1);
}
function bySegment(rows){
  const g={}; for(const s of SEG_ORDER) g[s]=0;
  for(const r of rows) g[r[2]]=(g[r[2]]||0)+(r[3]||0);
  return g;
}

/* Flagship card: whole filtered scope */
function execTotals(rows){
  return {
    sales:sum(rows,r=>r[3]), returns:sum(rows,r=>r[4]),
    qty:sum(rows,r=>r[5]), inv:sum(rows,r=>r[6]), cogs:sum(rows,r=>r[7]),
  };
}
function targetTotal(){
  let t=0; for(const w of selectedPlants()){ const d=TARGET_DEF[w]; if(!d) continue; for(const ym in d){ if(inRange(ym)) t+=d[ym]; } }
  return t;
}
/* prior equal-length window for the trend badge */
function selectedWindow(){
  const all = [...new Set(DATA.rows.map(r=>r[0]))].sort();
  if(state.month) return {from:state.month, to:state.month};
  if(state.year) return {from:state.year+'01', to:state.year+'12'};
  return {from:all[0], to:all[all.length-1]};
}
function priorWindowTotals(){
  const w = selectedWindow();
  if(!w.from || !w.to || w.from>w.to) return null;
  const span = ymDif(w.to, w.from) + 1;
  const pTo = prevMonth(w.from);
  const pFrom = addMonths(pTo, -(span-1));
  let sales=0, returns=0;
  for(const r of DATA.rows){
    if(state.plant && r[1]!==state.plant) continue;
    if(state.segment!=='' && r[2]!==state.segment) continue;
    if(r[0]>=pFrom && r[0]<=pTo){ sales+=r[3]||0; returns+=r[4]||0; }
  }
  return {sales, returns, from:pFrom, to:pTo};
}
function ymDif(a,b){ return (parseInt(a.slice(0,4),10)-parseInt(b.slice(0,4),10))*12 + (parseInt(a.slice(4,6),10)-parseInt(b.slice(4,6),10)); }
function prevMonth(ym){ const y=parseInt(ym.slice(0,4),10),m=parseInt(ym.slice(4,6),10)-1; return (m===0?(y-1)+'12':y+String(m).padStart(2,'0')); }
function addMonths(ym,n){ let y=parseInt(ym.slice(0,4),10),m=parseInt(ym.slice(4,6),10)-1+n; y+=Math.floor(m/12); m=((m%12)+12)%12; return y+String(m+1).padStart(2,'0'); }

/* ---------- KPI cards ---------- */
function renderKPIs(rows){
  const t=execTotals(rows);
  const target=targetTotal();
  const ach=target>0?t.sales/target*100:0;
  const retPct=t.sales>0?t.returns/t.sales*100:0;
  const margin=t.sales>0?(t.sales-t.cogs)/t.sales*100:0;
    const cogsPct=t.sales>0?t.cogs/t.sales*100:0;
    const gp=t.sales-t.cogs;
    const FOC=factTotal(DATA.foc);
    const DISP=factTotal(DATA.gdrn);
    document.getElementById('kpis').innerHTML=renderSalesPerf(t,target,ach,retPct)
        +renderMetricCard('COGS',t.cogs,prevMetric(cogsFn),metricSeries(cogsFn),'',
                    {invert:true, rows:[
                    {label:'COGS % of sales', sval:fmtNum(cogsPct,2)+'%'},
                      {label:'Free of Goods', value:FOC},{label:'Disposal', value:DISP}]})
      +renderMetricCard('Gross Profit',gp,prevMetric(gpFn),metricSeries(gpFn),fmtNum(margin,1)+'% gross margin');
}

/* Fact totals (foc/gdrn) scoped to the same period/plant/segment filters as the COGS card.
   Array rows: [ym, werks, value]. Segment is a plant attribute -> filter via plantSegment. */
function factTotal(arr){
  if(!arr) return 0;
  let s=0;
  for(const r of arr){
    if(state.plant && r[1]!==state.plant) continue;
    if(state.segment!=='' && plantSegment(r[1])!==state.segment) continue;
    if(!inRange(r[0])) continue;
    s+=r[2]||0;
  }
  return s;
}

/* Generic metric card: MoM comparison + 6-month sparkline */
const cogsFn=r=>r[7]||0;
const gpFn=r=>(r[3]||0)-(r[7]||0);
function metricSeries(fn){
  const all=[...new Set(DATA.rows.map(r=>r[0]))].sort();
  const end=state.month||all[all.length-1];
  const start=addMonths(end,-5);
  const map={};
  for(const r of DATA.rows){
    if(state.plant && r[1]!==state.plant) continue;
    if(state.segment!=='' && r[2]!==state.segment) continue;
    if(r[0]>=start && r[0]<=end) map[r[0]]=(map[r[0]]||0)+fn(r);
  }
  const out=[];
  for(let i=0;i<6;i++){ const ym=addMonths(start,i); out.push({ym,val:map[ym]||0}); }
  return out;
}
function prevMetric(fn){
  if(!state.month) return null;
  const pm=prevMonth(state.month);
  let c=0;
  for(const r of DATA.rows){
    if(state.plant && r[1]!==state.plant) continue;
    if(state.segment!=='' && r[2]!==state.segment) continue;
    if(r[0]===pm) c+=fn(r);
  }
  return c;
}
function metricSpark(series){
  const W=220,H=64,P=9;
  const vals=series.map(s=>s.val);
  const max=Math.max(...vals,1), min=Math.min(...vals);
  const range=(max-min)||1;
  const pts=vals.map((v,i)=>{
    const x=P+(W-2*P)*i/(vals.length-1);
    const y=H-P-(v-min)/range*(H-2*P);
    return [x,y];
  });
  const line=pts.map(p=>p[0].toFixed(1)+','+p[1].toFixed(1)).join(' ');
  const area='M'+pts[0][0].toFixed(1)+','+(H-P)+' L'+line.split(' ').join(' L')+' L'+pts[pts.length-1][0].toFixed(1)+','+(H-P)+' Z';
  return '<svg class="cogs-spark" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'+
    '<defs><linearGradient id="cogsFill" x1="0" y1="0" x2="0" y2="1">'+
    '<stop offset="0%" stop-color="var(--accent)" stop-opacity=".35"/>'+
    '<stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>'+
    '</linearGradient></defs>'+
    '<path d="'+area+'" fill="url(#cogsFill)"/>'+
    '<polyline points="'+line+'" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>'+
    pts.map(p=>'<circle cx="'+p[0].toFixed(1)+'" cy="'+p[1].toFixed(1)+'" r="1.8" fill="var(--accent)"/>').join('')+
    '</svg>';
}
function renderMetricCard(label,cur,prev,series,sub,opts){
  opts=opts||{};
  let trendHtml='';
  if(prev!=null && prev>0){
    const chg=(cur-prev)/prev*100;
    const up = opts.invert ? chg<=0 : chg>=0;   // COGS: down is good -> green on fall
    trendHtml='<div class="sp-trend '+(up?'up':'')+'"><span class="tri">'+
              (chg>=0?'&#9650;':'&#9660;')+'</span> '
      +fmtNum(Math.abs(chg),1)+'% | '+fmtM(cur-prev)+' vs prev</div>';
  } else {
    trendHtml='<div class="sp-trend"><span class="tri">&#8211;</span> vs prev</div>';
  }
  let body='';
  if(opts.rows){
    body='<div class="sp-rows">'+opts.rows.map(r=>
      '<div class="row"><span class="r-label">'+esc(r.label)+'</span><span class="r-val">'+(r.sval!=null?r.sval:fmtSAR(r.value))+'</span></div>'
    ).join('')+'</div>';
  } else {
    body='<div class="cogs-chart">'+metricSpark(series)+'</div>'+
        '<div class="cogs-labels">'+series.map(s=>'<span>'+s.ym.slice(4,6)+'/'+s.ym.slice(0,4)+'</span>').join('')+'</div>';
  }
  return '<div class="kpi k-value cogs-kpi">'+
    '<div class="sp-title-row"><div class="label">'+label+'</div>'+trendHtml+'</div>'+
    '<div class="sp-main">'+fmtInt(cur)+'<small>SAR</small></div>'+
    (sub?'<div class="sub">'+sub+'</div>':'')+
    body+
  '</div>';
}

/* Flagship Sales Performance card (reference image replica) */
function renderSalesPerf(t, target, ach, retPct){
  const toGo = target - t.sales;
  const pct = Math.max(0, Math.min(100, ach));
  const prior = priorWindowTotals();
  let trendHtml='';
  if(prior && prior.sales>0){
    const chg=prior.sales>0?(t.sales-prior.sales)/prior.sales*100:0;
    const up=chg>=0;
    trendHtml='<div class="sp-trend '+(up?'up':'')+'"><span class="tri">'+(up?'\u25B2':'\u25BC')+'</span> '
      +fmtNum(Math.abs(chg),1)+'% | '+fmtM(t.sales-prior.sales)+'M vs prev</div>';
  } else {
    trendHtml='<div class="sp-trend"><span class="tri">\u2013</span> vs prev</div>';
  }
  return '<div class="kpi k-value sp-kpi">'+
    '<div class="sp-title-row"><div class="label">Sales Performance</div>'+trendHtml+'</div>'+
    '<div class="sp-main">'+fmtInt(t.sales)+'<small>SAR</small></div>'+
    '<div class="sp-rows">'+
      '<div class="row"><span class="r-label">Target</span><span class="r-val">'+fmtSAR(target)+'</span></div>'+
      '<div class="row"><span class="r-label">To Go</span><span class="r-val '+(toGo>=0?'good':'risk')+'">'+fmtSAR(toGo)+'</span></div>'+
      '<div class="row"><span class="r-label">Returns</span><span class="r-val risk">'+fmtSAR(t.returns)+'</span></div>'+
    '</div>'+
    '<div class="sp-progress">'+
      '<div class="sp-track">'+
        '<div class="sp-fill" style="width:'+pct+'%"></div>'+
        '<div class="sp-marker" style="left:'+pct+'%"></div>'+
      '</div>'+
      '<div class="sp-pct"><b>'+fmtNum(ach,1)+'% of Target</b></div>'+
    '</div>'+
  '</div>';
}
/* ---------- charts ---------- */
function makeChart(id,cfg){ const ctx=document.getElementById(id); if(!ctx) return; if(charts[id]) charts[id].destroy(); charts[id]=new Chart(ctx,cfg); }
function monthLabels(rows){ return rows.map(e=>e[0].slice(4,6)+'/'+e[0].slice(0,4)); }

function renderTrend(){
  // last 6 months ending at the selected month (or latest in data), respecting plant/segment filters
  const all=[...new Set(DATA.rows.map(r=>r[0]))].sort();
  const end=state.month||all[all.length-1];
  const start=addMonths(end,-5);
  const sales={}, tgt={};
  for(const r of DATA.rows){
    if(state.plant && r[1]!==state.plant) continue;
    if(state.segment!=='' && r[2]!==state.segment) continue;
    if(r[0]>=start && r[0]<=end) sales[r[0]]=(sales[r[0]]||0)+(r[3]||0);
  }
  for(const w of selectedPlants()){
    const def=TARGET_DEF[w]; if(!def) continue;
    for(const ym in def){ if(ym>=start && ym<=end) tgt[ym]=(tgt[ym]||0)+def[ym]; }
  }
  const labels=[];
  for(let i=0;i<6;i++){ const ym=addMonths(start,i); labels.push(ym); }
  makeChart('chart-trend',{type:'bar',data:{labels:labels.map(x=>x.slice(4,6)+'/'+x.slice(0,4)),
    datasets:[
      {label:'Sales',data:labels.map(ym=>sales[ym]||0),backgroundColor:'#4f8cff',borderRadius:4,yAxisID:'y'},
      {label:'Target',data:labels.map(ym=>tgt[ym]||0),type:'line',borderColor:'#22c1a4',backgroundColor:'#22c1a4',tension:.3,pointRadius:3,yAxisID:'y'},
          ]},
                    options:{maintainAspectRatio:false,plugins:{legend:{labels:{usePointStyle:true}},
                      tooltip:{filter:item=>item.datasetIndex===0,displayColors:false,
                        callbacks:{
                          title:items=>items[0].label,
                          label:item=>{
                            const ym=labels[item.dataIndex], s=sales[ym]||0;
                            return 'Sales: '+fmtSAR(s);
                          },
                          afterBody:item=>{
                            const ym=labels[item[0].dataIndex], s=sales[ym]||0, t=tgt[ym]||0;
                            const gap=s-t, pct=t>0?s/t*100:0;
                            return [
                              'Target: '+fmtSAR(t),
                              (gap>=0?'Exceeded by ':'Missed by ')+fmtSAR(Math.abs(gap)),
                              fmtNum(pct,1)+'% of target',
                            ];
                          }
                        }
                      }},
                      scales:{x:{grid:{display:false}},y:{ticks:{callback:v=>fmtM(v)}}}}});
}
function renderSeg(rows){
  // Sales-by-Segment table KPI: sales, gp, gp%, returns, return%, target, target% per segment
  const g={};
  for(const r of rows){ const s=r[2]; const o=g[s]||(g[s]={sales:0,returns:0,cogs:0}); o.sales+=r[3]||0; o.returns+=r[4]||0; o.cogs+=r[7]||0; }
  const tg={};
  for(const w of Object.keys(PLANTS)){
    const seg=plantSegment(w);
    if(!seg) continue;
    const d=TARGET_DEF[w]; if(!d) continue;
    for(const ym in d){ if(inRange(ym)) tg[seg]=(tg[seg]||0)+d[ym]; }
  }
  const segs=SEG_ORDER.filter(s=>(g[s]&&g[s].sales>0)||tg[s]);
  const head=['Segment','Sales','Sales Target','Target %','GP','GP %','Returns','Return %'];
  const tbl=document.getElementById('exec-seg-table');
  if(!tbl) return;
  tbl.querySelector('thead').innerHTML='<tr>'+head.map(h=>'<th class="num">'+esc(h)+'</th>').join('')+'</tr>';
  tbl.querySelector('tbody').innerHTML=segs.map(s=>{
    const o=g[s]||{sales:0,returns:0,cogs:0};
    const gp=o.sales-o.cogs;
    const gppct=o.sales>0?gp/o.sales*100:0;
    const retpct=o.sales>0?o.returns/o.sales*100:0;
    const tgt=tg[s]||0;
    const tgtpct=tgt>0?o.sales/tgt*100:0;
    const achCls=tgtpct>=100?'ach-good':(tgtpct>=90?'ach-warn':'ach-risk');
    return '<tr>'+
      '<td><span class="seg-tag" style="color:'+SEG_COLOR[s]+'">'+esc(SEG_NAME[s]||s)+'</span></td>'+
      '<td class="num" style="font-weight:600">'+fmtSAR(o.sales)+'</td>'+
            '<td class="num">'+fmtSAR(tgt)+'</td>'+
            '<td class="num '+achCls+'">'+fmtNum(tgtpct,1)+'%</td>'+
            '<td class="num">'+fmtSAR(gp)+'</td>'+
            '<td class="num">'+fmtNum(gppct,1)+'%</td>'+
            '<td class="num" style="color:var(--danger)">'+fmtSAR(o.returns)+'</td>'+
            '<td class="num">'+fmtNum(retpct,1)+'%</td>'+
      '</tr>';
  }).join('');
}
function renderExtGrp(){
  // Sales-by-External-Material-Group table: sales, gp, gp%, returns, return% per mat_ext_grp
  const g={};
  for(const r of DATA.ext_grp){
    if(!inRange(r[0])) continue;
    if(state.plant && r[1]!==state.plant) continue;
    if(state.segment!=='' && plantSegment(r[1])!==state.segment) continue;
    const k=r[2];
    const o=g[k]||(g[k]={name:r[3],sales:0,returns:0,cogs:0});
    o.sales+=r[4]||0; o.returns+=r[5]||0; o.cogs+=r[6]||0;
  }
  const entries=Object.keys(g).sort((a,b)=>g[b].sales-g[a].sales);
  const head=['External Material Group','Sales','GP','GP %','Returns','Return %'];
  const tbl=document.getElementById('ext-table');
  if(!tbl) return;
  tbl.querySelector('thead').innerHTML='<tr>'+head.map(h=>'<th class="num">'+esc(h)+'</th>').join('')+'</tr>';
  tbl.querySelector('tbody').innerHTML=entries.map(k=>{
    const o=g[k];
    const gp=o.sales-o.cogs;
    const gppct=o.sales>0?gp/o.sales*100:0;
    const retpct=o.sales>0?o.returns/o.sales*100:0;
    const label=(o.name||'').trim()?o.name:('['+(k||'blank')+']');
    return '<tr>'+
      '<td style="font-weight:600">'+esc(label)+'</td>'+
      '<td class="num" style="font-weight:600">'+fmtSAR(o.sales)+'</td>'+
      '<td class="num">'+fmtSAR(gp)+'</td>'+
      '<td class="num">'+fmtNum(gppct,1)+'%</td>'+
      '<td class="num" style="color:var(--danger)">'+fmtSAR(o.returns)+'</td>'+
      '<td class="num">'+fmtNum(retpct,1)+'%</td>'+
      '</tr>';
  }).join('');
}
const REGION_NAME = {WES:'West',CEN:'Central',EAS:'East',SOU:'South',NOR:'North'};
const REGION_COLOR = {WES:'#4f8cff',CEN:'#22c1a4',EAS:'#a78bfa',SOU:'#f5a623',NOR:'#e5484d'};
function regionName(r){ const n=REGION_NAME[r]; return n?n:(r||'Unknown'); }
function renderRegion(rows){
  const g={};
  for(const r of rows){ const rg=plantInfo(r[1]).regio||''; g[rg]=(g[rg]||0)+(r[3]||0); }
  const entries=Object.keys(g).sort((a,b)=>g[b]-g[a]);
  makeChart('chart-region',{type:'doughnut',data:{labels:entries.map(r=>regionName(r)),
    datasets:[{data:entries.map(r=>g[r]),backgroundColor:entries.map(r=>REGION_COLOR[r]||'#8a99af'),borderRadius:4}]},
    options:{maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{boxWidth:12,font:{size:11}}},
      tooltip:{callbacks:{label:c=>' '+c.label+': '+fmtSAR(c.raw)+' ('+fmtNum(c.raw/sum(rows,r=>r[3])*100,1)+'%)'}}}}});
}

/* ---------- By Region page (image replica cards) ---------- */
const REGION_ORDER = ['CEN','EAS','NOR','SOU','WES'];
function regionPlants(rg){ const out=[]; for(const w of Object.keys(PLANTS)){ if(plantInfo(w).regio===rg) out.push(w); } return out; }
/* monthly sales + cogs per region for a [from..to] window, honoring plant/segment filters */
function regionSeries(rg, from, to){
  const plants=regionPlants(rg), set={}; for(const w of plants) set[w]=1;
  const s={}, c={};
  for(const r of DATA.rows){
    if(!set[r[1]] || r[0]<from || r[0]>to) continue;
    if(state.plant && r[1]!==state.plant) continue;
    if(state.segment!=='' && r[2]!==state.segment) continue;
    s[r[0]]=(s[r[0]]||0)+(r[3]||0); c[r[0]]=(c[r[0]]||0)+(r[7]||0);
  }
  return {s,c};
}
/* monthly target per region for a [from..to] window, honoring plant/segment filters */
function regionTargetSeries(rg, from, to){
  const s={};
  for(const w of regionPlants(rg)){
    if(state.plant && w!==state.plant) continue;
    if(state.segment!=='' && plantSegment(w)!==state.segment) continue;
    const d=TARGET_DEF[w]; if(!d) continue;
    for(const ym in d){ if(ym>=from && ym<=to) s[ym]=(s[ym]||0)+d[ym]; }
  }
  return s;
}
function regionStats(rg){
  const all=[...new Set(DATA.rows.map(r=>r[0]))].sort();
  const m=state.month||all[all.length-1];
  const cs=regionSeries(rg,m,m).s[m]||0, cc=regionSeries(rg,m,m).c[m]||0;
  const pm=prevMonth(m), ps=regionSeries(rg,pm,pm).s[pm]||0;
  let target=0; for(const w of regionPlants(rg)){ const d=TARGET_DEF[w]; if(!d) continue; const tv=d[m]; if(tv!=null) target+=tv; }
  const ach=target>0?cs/target*100:0, toGo=target-cs, gp=cs-cc, margin=cs>0?gp/cs*100:0;
  const chg=ps>0?(cs-ps)/ps*100:null;
  return {rg, m, name:regionName(rg)+' Region', cs, cc, ps, target, ach, toGo, gp, margin, chg,
    up:(chg==null||chg>=0), plants:regionPlants(rg).length};
}
function regionCard(rg){
  const s=regionStats(rg), m=s.m, cs=s.cs, cc=s.cc, ps=s.ps, target=s.target;
  // 6-month spark: sales (region color) vs target (teal)
  const st=addMonths(m,-5);
  const curSix=regionSeries(rg,st,m), tgtSix=regionTargetSeries(rg,st,m);
  const labels=[],curVals=[],tgtVals=[];
  for(let i=0;i<6;i++){ const ym=addMonths(st,i); labels.push(ym); curVals.push(curSix.s[ym]||0); tgtVals.push(tgtSix[ym]||0); }
  const ach=s.ach, toGo=s.toGo, chg=s.chg, up=s.up;
  const sprk=rcSpark(curVals,tgtVals,REGION_COLOR[rg]||'#4f8cff','#ffd166');
  const lbl=labels.map(x=>x.slice(4,6)+'/'+x.slice(0,4));
  const badge=chg==null?('<div class="rc-badge"><span class="tri">&#8211;</span> vs LM</div>')
    :('<div class="rc-badge '+(up?'up':'')+'"><span class="tri">'+(up?'&#9650;':'&#9660;')+'</span> '
      +fmtNum(Math.abs(chg),1)+'% <span class="rc-gap">'+(chg>=0?'+':'')+fmtM(cs-ps)+' vs LM</span></div>');
  const pct=Math.max(0,Math.min(100,ach));
  return '<div class="rc-card">'+
    '<div class="rc-head"><div class="rc-title">'+esc(s.name)+'<small>'+fmtInt(s.plants)+' plants</small></div>'+badge+'</div>'+
    '<div class="rc-main">'+fmtInt(s.cs)+'<small>SAR</small></div>'+
    '<div class="rc-tg"><b>Target</b> '+fmtSAR(target)+' &middot; <span class="togo">To Go '+fmtSAR(toGo)+'</span></div>'+
    '<div class="rc-track"><div class="rc-fill" style="width:'+pct+'%"></div><div class="rc-line" style="left:100%"></div></div>'+
    '<div class="rc-pct"><b>'+fmtNum(ach,1)+'%</b> of Target</div>'+
    '<div class="rc-spark-wrap">'+sprk+
      '<div class="rc-legend"><span class="lg"><span class="sw" style="background:'+(REGION_COLOR[rg]||'#4f8cff')+'"></span>Sales</span><span class="lg"><span class="sw" style="background:#ffd166"></span>Target</span></div>'+
      '<div class="rc-labels2">'+lbl.map(x=>'<span>'+x+'</span>').join('')+'</div>'+
    '</div>'+
  '</div>';
}
/* 6th card: one consolidated regional insight across the 5 regions */
function regionInsightCard(){
  const all=[...new Set(DATA.rows.map(r=>r[0]))].sort();
  const m=state.month||all[all.length-1];
  const stats=REGION_ORDER.map(rg=>regionStats(rg));
  const totalSales=stats.reduce((a,s)=>a+s.cs,0);
  const totalTarget=stats.reduce((a,s)=>a+s.target,0);
  const totalToGo=totalTarget-totalSales;
  const totAch=totalTarget>0?totalSales/totalTarget*100:0;
  const totGP=stats.reduce((a,s)=>a+s.gp,0);
  const totMargin=totalSales>0?totGP/totalSales*100:0;
  const bySales=[...stats].sort((a,b)=>b.cs-a.cs);
  const top=bySales[0];
  const byAch=[...stats].filter(s=>s.target>0).sort((a,b)=>b.ach-a.ach);
  const best=byAch[0];
  const rows=[
    {l:'Top Region', v:esc(top?top.name:''), sub:top?'<b>'+fmtSAR(top.cs)+'</b>':'', c:''},
    {l:'Best vs Target', v:esc(best?best.name:''), sub:best?fmtNum(best.ach,1)+'% of target':'', c:best&&best.ach<100?'warn':'good'},
    {l:'Total Target · To Go', v:fmtSAR(totalTarget), sub:totalToGo>=0?('To Go '+fmtSAR(totalToGo)):('Over by '+fmtSAR(-totalToGo)), c:totalToGo>=0?'':'good'},
  ];
  return '<div class="rc-card rc-insight">'+
    '<div class="rc-head"><div class="rc-title">Regional Insight<small>all '+stats.length+' regions · '+m.slice(4,6)+'/'+m.slice(0,4)+'</small></div>'+
      '<div class="rc-badge '+(totAch>=90?'up':'')+'"><span class="tri">&#9679;</span> '+fmtNum(totAch,1)+'% overall</div></div>'+
    '<div class="rc-main">'+fmtInt(totalSales)+'<small>SAR</small></div>'+
    '<div class="rc-insight-rows">'+rows.map(r=>
      '<div class="row"><div><div class="ri-l">'+r.l+'</div><div class="ri-v '+(r.c||'')+'">'+r.v+'</div></div>'+
      '<div class="ri-sub">'+(r.sub||('')+'')+'</div></div>'
    ).join('')+'</div>'+
    '<div class="rc-summary">Gross profit <b>'+fmtSAR(totGP)+'</b> across regions, <b>'+fmtNum(totMargin,1)+'%</b> blended margin.</div>'+
  '</div>';
}
function rcSpark(sales,target,salesColor,targetColor){
  const W=300,H=70,P=8; const n=sales.length;
  const all=sales.concat(target); const max=Math.max(...all,1),min=Math.min(...all);
  const range=(max-min)||1;
  const pt=(v,i)=>{ const x=P+(W-2*P)*i/(n-1||1); const y=H-P-(v-min)/range*(H-2*P); return [x,y]; };
  const line=(arr,stroke,dash)=>{ const p=arr.map((v,i)=>pt(v,i).map(x=>x.toFixed(1)).join(',')); return '<polyline points="'+p.join(' ')+'" fill="none" stroke="'+stroke+'" stroke-width="2"'+(dash?' stroke-dasharray="5 3"':'')+' stroke-linejoin="round" stroke-linecap="round"/>'; };
  return '<svg class="rc-spark" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'+
    line(sales,salesColor)+line(target,targetColor,true)+'</svg>';
}
function renderRegionPage(){
  const el=document.getElementById('region-grid'); if(!el) return;
  el.innerHTML=regionInsightCard()+REGION_ORDER.map(rg=>regionCard(rg)).join('');
}

/* management attention */
function renderAttention(rows){
  const t=execTotals(rows);
  const target=targetTotal();
  const seg=bySegment(rows);
  const ach=target>0?t.sales/target*100:0;
  const sortedSeg=SEG_ORDER.filter(s=>seg[s]>0).sort((a,b)=>seg[b]-seg[a]);
  const topSeg=sortedSeg[0];
  // by plant
  const pg={};
  for(const r of rows){ const k=r[1]; const o=pg[k]||(pg[k]={sales:0}); o.sales+=r[3]||0; }
  const plantsSorted=Object.entries(pg).sort((a,b)=>b[1].sales-a[1].sales);
  const topPlant=plantsSorted[0];
  // target per plant to find lowest achiever
  let lowAchiever=null;
  for(const [w,o] of plantsSorted){
    const tn=targetForPlant(w);
    if(tn>0){ const pct=o.sales/tn*100; if(pct<100 && (!lowAchiever||pct<lowAchiever.pct)) lowAchiever={w,pct,tn}; }
  }
  const pctBelow = plantsSorted.filter(([w,o])=>{const tn=targetForPlant(w); return tn>0 && o.sales/tn*100<90;}).length;
  const tiles=[
    {l:'Below Target (overall)',v:fmtSAR(Math.max(0,target-t.sales)),s:'to-go gap ('+fmtNum(ach,1)+'% achieved)',c:ach<100?'risk':'good'},
    {l:'Returns',v:fmtSAR(t.returns),s:fmtNum(t.sales>0?t.returns/t.sales*100:0,2)+'% of sales',c:'warn'},
    {l:'Top Segment',v:topSeg?SEG_NAME[topSeg]:'—',s:topSeg?fmtNum(seg[topSeg]/t.sales*100,1)+'% of sales':'',c:''},
    {l:'Top Plant',v:topPlant?esc(plantInfo(topPlant[0]).name):'—',s:topPlant?fmtSAR(topPlant[1].sales):'',c:''},
    {l:'Largest Target Gap Plant',v:lowAchiever?esc(plantInfo(lowAchiever.w).name):'—',s:lowAchiever?fmtNum(lowAchiever.pct,1)+'% of target':'',c:'risk'},
    {l:'Plants <90% of Target',v:fmtInt(pctBelow)+' plants',s:'of '+plantsSorted.length+' active',c:pctBelow>0?'warn':'good'},
    {l:'Sales Quantity',v:fmtInt(t.qty),s:'base units',c:''},
    {l:'Invoices',v:fmtInt(t.inv),s:'billed invoice lines',c:''},
  ];
  document.getElementById('attention').innerHTML=tiles.map(x=>
    '<div class="att"><div class="l">'+x.l+'</div><div class="v '+(x.c||'')+'">'+x.v+'</div><div class="s">'+x.s+'</div></div>').join('');
}
function targetForPlant(w){
  const d=TARGET_DEF[w]; if(!d) return 0;
  let t=0; for(const ym in d){ if(inRange(ym)) t+=d[ym]; }
  return t;
}

/* ---------- plant table ---------- */
const PCOL=[
  {k:'w',t:'Plant',cls:''},{k:'name',t:'Plant Name',cls:''},{k:'bukrs',t:'Company',cls:''},
  {k:'regio',t:'Region',cls:''},{k:'inv',t:'Invoices',cls:'num'},{k:'qty',t:'Qty',cls:'num'},
  {k:'sales',t:'Sales',cls:'num'},{k:'gp',t:'GP',cls:'num'},{k:'gppct',t:'GP %',cls:'num'},
  {k:'returns',t:'Returns',cls:'num'},{k:'retpct',t:'Ret %',cls:'num'},
  {k:'foc',t:'FOC',cls:'num'},{k:'disp',t:'Disposal',cls:'num'},{k:'aov',t:'AOV',cls:'num'},
  {k:'target',t:'Target',cls:'num'},{k:'ach',t:'Ach %',cls:'num'},
];
const PHEAD=['Plant','Plant Name','Company','Region','Invoices','Qty','Sales','GP','GP %','Returns','Ret %','FOC','Disposal','AOV','Target','Ach %'];
/* per-plant fact total (foc/gdrn) scoped to the same period/plant/segment filters */
function factPerPlant(arr){
  const m={}; if(!arr) return m;
  for(const r of arr){
    if(state.plant && r[1]!==state.plant) continue;
    if(state.segment!=='' && plantSegment(r[1])!==state.segment) continue;
    if(!inRange(r[0])) continue;
    m[r[1]]=(m[r[1]]||0)+(r[2]||0);
  }
  return m;
}
function plantRows(rows){
  const g={};
  for(const r of rows){ const k=r[1]; const o=g[k]||(g[k]={sales:0,returns:0,qty:0,inv:0,cogs:0}); o.sales+=r[3]||0; o.returns+=r[4]||0; o.qty+=r[5]||0; o.inv+=r[6]||0; o.cogs+=r[7]||0; }
  const focMap=factPerPlant(DATA.foc), dispMap=factPerPlant(DATA.gdrn);
  return Object.entries(g).map(([w,o])=>{
    const t=targetForPlant(w);
    const gp=o.sales-o.cogs;
    return {w, name:plantInfo(w).name, bukrs:plantInfo(w).bukrs, regio:plantInfo(w).regio,
      inv:o.inv, qty:o.qty, sales:o.sales, returns:o.returns, cogs:o.cogs,
      gp, gppct:o.sales>0?gp/o.sales*100:0, foc:focMap[w]||0, disp:dispMap[w]||0,
      aov:o.inv>0?o.sales/o.inv:0,
      retpct:o.sales>0?o.returns/o.sales*100:0, target:t, ach:t>0?o.sales/t*100:0};
  }).sort((a,b)=>b.sales-a.sales);
}
const PFMT=(c,r)=>{
  if(c.k==='w') return '<td>'+esc(strip0(r.w))+'</td>';
  if(c.k==='name') return '<td>'+esc(r.name)+'</td>';
  if(c.k==='sales') return '<td class="num" style="font-weight:600">'+fmtSAR(r.sales)+'</td>';
  if(c.k==='gp') return '<td class="num" style="font-weight:600">'+fmtSAR(r.gp)+'</td>';
  if(c.k==='gppct') return '<td class="num">'+fmtNum(r.gppct,1)+'%</td>';
  if(c.k==='returns') return '<td class="num" style="color:var(--danger)">'+fmtSAR(r.returns)+'</td>';
  if(c.k==='target') return '<td class="num">'+fmtSAR(r.target)+'</td>';
  if(c.k==='ach') {
    let cls= r.ach>=100?'ach-good':(r.ach>=90?'ach-warn':'ach-risk');
    return '<td class="num '+cls+'">'+fmtNum(r.ach,1)+'%</td>';
  }
  if(c.k==='inv') return '<td class="num">'+fmtInt(r.inv)+'</td>';
  if(c.k==='qty') return '<td class="num">'+fmtInt(r.qty)+'</td>';
  if(c.k==='retpct') return '<td class="num">'+fmtNum(r.retpct,1)+'%</td>';
  if(c.k==='aov') return '<td class="num">'+fmtSAR(r.aov)+'</td>';
  return '<td class="num">'+fmtSAR(r[c.k]||0)+'</td>';
};
/* MoM trend badge for the plant KPI cards (green up / red down) */
function mbadge(prev,cur){
  if(prev==null || prev<=0) return '<span class="mbadge">&#8211; vs prev</span>';
  const chg=(cur-prev)/prev*100, up=chg>=0;
  return '<span class="mbadge '+(up?'up':'down')+'">'+(up?'&#9650;':'&#9660;')+' '+fmtNum(Math.abs(chg),1)+'% vs prev</span>';
}
/* plant-level invoice/sales/cogs totals for a single month, honoring plant/segment filters */
function plantTotalsFor(ym){
  let inv=0, sales=0, cogs=0;
  for(const r of DATA.rows){
    if(state.plant && r[1]!==state.plant) continue;
    if(state.segment!=='' && r[2]!==state.segment) continue;
    if(r[0]!==ym) continue;
    inv+=r[6]||0; sales+=r[3]||0; cogs+=r[7]||0;
  }
  return {inv,sales,cogs};
}
function prevPlantGP(){ if(!state.month) return null; const t=plantTotalsFor(prevMonth(state.month)); return t.sales-t.cogs; }
function prevPlantAOV(){ if(!state.month) return null; const t=plantTotalsFor(prevMonth(state.month)); return t.inv>0?t.sales/t.inv:0; }
function renderKpisPlant(rows){
  const g=plantRows(rows);
  const totSales=g.reduce((s,p)=>s+p.sales,0), totInv=g.reduce((s,p)=>s+p.inv,0);
  const gp=totSales-g.reduce((s,p)=>s+(p.cogs||0),0);
  const aov=totInv>0?totSales/totInv:0;
  const margin=totSales>0?gp/totSales*100:0;
  // target-weighted achievement + share of sales from plants at/above target
  let totTarget=0, aboveSales=0;
  for(const p of g){ totTarget+=p.target||0; if((p.ach||0)>=100) aboveSales+=p.sales; }
  const achW=totTarget>0?totSales/totTarget*100:0;
  const abovePct=totSales>0?aboveSales/totSales*100:0;
  const prevGP=prevPlantGP(), prevAOV=prevPlantAOV();
  const cards=[
    {cls:'k-value',label:'Active Plants',value:fmtInt(g.length),sub:'with sales in scope'},
    {cls:achW>=100?'k-good':(achW>=90?'k-warn':'k-risk'),label:'Target Achievement',value:fmtNum(achW,1)+'%',
      sub:fmtNum(abovePct,1)+'% of sales from plants \u2265 target'},
    {cls:'k-value',label:'Gross Profit',value:fmtSAR(gp),sub:fmtNum(margin,1)+'% margin',badge:mbadge(prevGP,gp)},
    {cls:'k-value',label:'AOV',value:fmtSAR(aov),sub:'avg order value',badge:mbadge(prevAOV,aov)},
  ];
  document.getElementById('kpis-plant').innerHTML=cards.map(c=>
    '<div class="kpi '+c.cls+'"><div class="label">'+c.label+(c.badge||'')+'</div><div class="value">'+c.value+'</div><div class="sub">'+c.sub+'</div></div>').join('');
}
/* column-selector UI for the plant table */
const PCOLS_HIDDEN_DEFAULT=['bukrs','regio','qty'];
function initPlantCols(){
  for(const c of PCOL) state.pCols[c.k]=!PCOLS_HIDDEN_DEFAULT.includes(c.k);
  const btn=document.getElementById('plant-cols-btn'), drop=document.getElementById('plant-cols-drop');
  if(!btn||!drop) return;
  btn.onclick=e=>{ e.stopPropagation(); drop.style.display=drop.style.display==='none'?'flex':'none'; };
  drop.innerHTML=PCOL.map(c=>'<label class="cc"><input type="checkbox" data-k="'+c.k+'" '+((state.pCols[c.k])?'checked':'')+'/><span>'+esc(c.t)+'</span></label>').join('');
  drop.querySelectorAll('input[type="checkbox"]').forEach(ch=>{
    ch.addEventListener('change',()=>{ state.pCols[ch.dataset.k]=ch.checked; refresh(); });
  });
  document.addEventListener('click',()=>{ drop.style.display='none'; });
}

/* ---------- segment table ---------- */
const SCOL=[
  {k:'seg',t:'Segment',cls:''},
  {k:'sales',t:'Sales',cls:'num'},
  {k:'gp',t:'GP',cls:'num'},
  {k:'gppct',t:'GP %',cls:'num'},
  {k:'returns',t:'Returns',cls:'num'},
  {k:'retpct',t:'Ret %',cls:'num'},
  {k:'foc',t:'FOC',cls:'num'},
  {k:'disp',t:'Disposal',cls:'num'},
  {k:'inv',t:'Invoices',cls:'num'},
  {k:'aov',t:'AOV',cls:'num'},
  {k:'target',t:'Target',cls:'num'},
  {k:'tgtpct',t:'Target %',cls:'num'},
  {k:'share',t:'Share',cls:'num'},
];
const SHEAD=['Segment','Sales','GP','GP %','Returns','Ret %','FOC','Disposal','Invoices','AOV','Target','Target %','Share'];
function segRows(rows){
  const g={};
  for(const r of rows){ const k=r[2]; const o=g[k]||(g[k]={sales:0,returns:0,qty:0,inv:0,cogs:0}); o.sales+=r[3]||0; o.returns+=r[4]||0; o.qty+=r[5]||0; o.inv+=r[6]||0; o.cogs+=r[7]||0; }
  const tot=Object.values(g).reduce((s,o)=>s+o.sales,0);
  // per-segment FOC / Disposal (plant attribute -> segment rollup, scoped to the same filters)
  const focMap=factPerPlant(DATA.foc), dispMap=factPerPlant(DATA.gdrn);
  const segFoc={}, segDisp={};
  for(const w of Object.keys(PLANTS)){ const s=plantSegment(w); if(!s)continue; segFoc[s]=(segFoc[s]||0)+(focMap[w]||0); segDisp[s]=(segDisp[s]||0)+(dispMap[w]||0); }
  // per-segment target (respects plant filter)
  const segTgt={};
  for(const w of selectedPlants()){ const s=plantSegment(w); if(!s)continue; const d=TARGET_DEF[w]; if(!d)continue; for(const ym in d){ if(inRange(ym)) segTgt[s]=(segTgt[s]||0)+d[ym]; } }
  return Object.entries(g).map(([k,o])=>{
    const gp=o.sales-o.cogs, tgt=segTgt[k]||0;
    return {seg:k, sales:o.sales, returns:o.returns, qty:o.qty, inv:o.inv, cogs:o.cogs, gp,
      gppct:o.sales>0?gp/o.sales*100:0,
      retpct:o.sales>0?o.returns/o.sales*100:0,
      share:tot>0?o.sales/tot*100:0,
      foc:segFoc[k]||0, disp:segDisp[k]||0,
      target:tgt, tgtpct:tgt>0?o.sales/tgt*100:0,
      aov:o.inv>0?o.sales/o.inv:0};
  }).sort((a,b)=>b.sales-a.sales);
}
const SFMT=(c,r)=>{
  if(c.k==='seg') return '<td><span class="seg-tag" style="color:'+SEG_COLOR[r.seg]+'">'+esc(SEG_NAME[r.seg]||r.seg)+'</span></td>';
  if(c.k==='sales') return '<td class="num" style="font-weight:600">'+fmtSAR(r.sales)+'</td>';
  if(c.k==='gp') return '<td class="num">'+fmtSAR(r.gp)+'</td>';
  if(c.k==='gppct') return '<td class="num">'+fmtNum(r.gppct,1)+'%</td>';
  if(c.k==='returns') return '<td class="num" style="color:var(--danger)">'+fmtSAR(r.returns)+'</td>';
  if(c.k==='retpct') return '<td class="num">'+fmtNum(r.retpct,1)+'%</td>';
  if(c.k==='foc') return '<td class="num">'+fmtSAR(r.foc)+'</td>';
  if(c.k==='disp') return '<td class="num">'+fmtSAR(r.disp)+'</td>';
  if(c.k==='inv') return '<td class="num">'+fmtInt(r.inv)+'</td>';
  if(c.k==='aov') return '<td class="num">'+fmtSAR(r.aov)+'</td>';
  if(c.k==='target') return '<td class="num">'+fmtSAR(r.target)+'</td>';
  if(c.k==='tgtpct'){ if(r.target>0){ const cls=r.tgtpct>=100?'ach-good':(r.tgtpct>=90?'ach-warn':'ach-risk'); return '<td class="num '+cls+'">'+fmtNum(r.tgtpct,1)+'%</td>'; } return '<td class="num" style="color:var(--muted)">\u2014</td>'; }
  if(c.k==='share') return '<td class="num">'+fmtNum(r.share,1)+'%</td>';
  return '<td>'+esc(r[c.k]==null?'':r[c.k])+'</td>';
};
function renderKpisSeg(rows){
  const g=segRows(rows);
  const el=document.getElementById('kpis-seg'); if(!el) return;
  el.innerHTML=g.map(s=>{
    const pct=Math.max(0,Math.min(100,s.tgtpct));
    const pctTxt=s.target>0?fmtNum(s.tgtpct,1)+'% of Target':'No target';
    return '<div class="kpi k-value seg-kpi">'+
      '<div class="sp-title-row"><div class="label" style="text-transform:none;color:'+SEG_COLOR[s.seg]+';font-size:12px;font-weight:700">'+esc(SEG_NAME[s.seg]||s.seg)+'</div>'+
      '<div class="seg-share"><span class="tri">&#9679;</span>'+fmtNum(s.share,1)+'% share</div></div>'+
      '<div class="sp-main">'+fmtInt(s.sales)+'<small>SAR</small></div>'+
      '<div class="sp-rows">'+
        '<div class="row"><span class="r-label">Gross Profit</span><span class="r-val">'+fmtSAR(s.gp)+' <span class="r-muted">('+fmtNum(s.gppct,1)+'%)</span></span></div>'+
        '<div class="row"><span class="r-label">Returns</span><span class="r-val risk">'+fmtSAR(s.returns)+'</span></div>'+
        '<div class="row"><span class="r-label">AOV</span><span class="r-val">'+fmtSAR(s.aov)+'</span></div>'+
      '</div>'+
      '<div class="sp-progress"><div class="sp-track"><div class="sp-fill" style="width:'+pct+'%"></div>'+(s.target>0?'<div class="sp-marker" style="left:'+pct+'%"></div>':'')+'</div>'+
      '<div class="sp-pct"><b>'+pctTxt+'</b></div></div>'+
    '</div>';
  }).join('');
}

/* ---------- product table (top 1,500 materials x month) ----------
   `products` = the top 1,500 materials by total sales, at material x month
   [material, ym, sales, returns, qty, inv, cogs]; `prod_info` = [material, mat_des,
   mat_ext_grp, mat_ext_grp_des] display lookup (one row per material — ZTSD_DETAIL
   carries 2-4 description spellings per material, merged at export); `prod_foc` /
   `prod_disp` / `prod_fcst` = [material, ym, value]. Everything is filtered by the
   SAME period (year/month) as the rest of the dashboard, so the page reconciles —
   but the grain has no plant column, so a Plant/Segment selection does not narrow it.
   prod_fcst only carries the forecast module month (meta.forecast_month), so the
   Forecast column reads '—' in every other month. GP = sales - cogs. */
const PROD_INFO = {};  // material -> [mat_des, mat_ext_grp, mat_ext_grp_des]
let FCST_ON = false;   // true when the selected period contains forecast rows
const TCOL=[{k:'mat',t:'Product',cls:''},{k:'des',t:'Description',cls:''},{k:'grp',t:'Material Group',cls:''},
  {k:'inv',t:'Invoices',cls:'num'},{k:'qty',t:'Qty',cls:'num'},{k:'sales',t:'Sales',cls:'num'},
  {k:'forecast',t:'Sales Target',cls:'num'},{k:'tarPct',t:'% of Target',cls:'num'},
  {k:'gp',t:'GP',cls:'num'},{k:'gppct',t:'GP %',cls:'num'},{k:'returns',t:'Returns',cls:'num'},
  {k:'retpct',t:'Ret %',cls:'num'},{k:'foc',t:'FOC',cls:'num'},{k:'disp',t:'Disposal',cls:'num'}];
const THEAD=['Product','Description','Material Group','Invoices','Qty','Sales','Sales Target','% of Target','GP','GP %','Returns','Ret %','FOC','Disposal'];
function productRows(){
  const g={};
  const seed=(k)=>{ const o=g[k]||(g[k]={mat:k,sales:0,returns:0,qty:0,inv:0,cogs:0,foc:0,disp:0,forecast:0}); return o; };
  for(const r of DATA.products){
    if(!inRange(r[1])) continue;
    const o=seed(r[0]);
    o.sales+=r[2]||0; o.returns+=r[3]||0; o.qty+=r[4]||0; o.inv+=r[5]||0; o.cogs+=r[6]||0;
  }
  /* FOC / Disposal / Forecast are per material x month too — same period filter as sales */
  for(const r of DATA.prod_foc){ if(!inRange(r[1])) continue; seed(r[0]).foc+=r[2]||0; }
  for(const r of DATA.prod_disp){ if(!inRange(r[1])) continue; seed(r[0]).disp+=r[2]||0; }
  FCST_ON=false;
  for(const r of DATA.prod_fcst){ if(!inRange(r[1])) continue; FCST_ON=true; seed(r[0]).forecast+=r[2]||0; }
  const out=[];
  for(const k in g){
    const o=g[k], info=PROD_INFO[k]||['','',''];
    const gp=o.sales-o.cogs;
    out.push({mat:k, des:(info[0]||'').trim(), grp:(info[2]||info[1]||'').trim(),
      inv:o.inv, qty:o.qty, sales:o.sales, returns:o.returns, cogs:o.cogs, gp,
      gppct: o.sales>0?gp/o.sales*100:0, retpct: o.sales>0?o.returns/o.sales*100:0,
      foc:o.foc, disp:o.disp, forecast:o.forecast, tarPct:o.forecast>0?o.sales/o.forecast*100:0});
  }
  return out.sort((a,b)=>b.sales-a.sales);
}
function productTotals(rows){
  const t={sales:0,cogs:0,returns:0,qty:0,foc:0,disp:0,forecast:0};
  for(const r of rows){ for(const k in t) t[k]+=r[k]||0; }
  t.gp=t.sales-t.cogs; t.gppct=t.sales>0?t.gp/t.sales*100:0;
  return t;
}
const TFMT=(c,r)=>{
  if(c.k==='mat') return '<td>'+esc(strip0(r.mat))+'</td>';
  if(c.k==='des') return '<td>'+esc(r.des||'—')+'</td>';
  if(c.k==='grp') return '<td>'+esc(r.grp||'—')+'</td>';
  if(c.k==='sales') return '<td class="num" style="font-weight:600">'+fmtSAR(r.sales)+'</td>';
  if(c.k==='gp') return '<td class="num">'+fmtSAR(r.gp)+'</td>';
  if(c.k==='gppct') return '<td class="num">'+fmtNum(r.gppct,1)+'%</td>';
  if(c.k==='returns') return '<td class="num" style="color:var(--danger)">'+fmtSAR(r.returns)+'</td>';
  if(c.k==='retpct') return '<td class="num">'+fmtNum(r.retpct,1)+'%</td>';
  if(c.k==='forecast') return '<td class="num">'+(FCST_ON?fmtSAR(r.forecast):'—')+'</td>';
  if(c.k==='tarPct') return '<td class="num">'+(FCST_ON?fmtNum(r.tarPct,1)+'%':'—')+'</td>';
  if(c.k==='foc'||c.k==='disp') return '<td class="num">'+fmtSAR(r[c.k])+'</td>';
  if(c.k==='inv'||c.k==='qty') return '<td class="num">'+fmtInt(r[c.k])+'</td>';
  return '<td>'+esc(r[c.k]==null?'':r[c.k])+'</td>';
};
function renderKpisProduct(rows){
  const el=document.getElementById('kpis-product'); if(!el) return;
  const t=productTotals(rows);
  const top=rows[0];
  const g={}; for(const r of rows){ const k=r.grp||'—'; g[k]=(g[k]||0)+r.sales; }
  const tg=Object.entries(g).sort((a,b)=>b[1]-a[1])[0]||['—',0];
  /* Materials that make up the big chunk of sales: rank products by sales desc,
     count how many are needed to reach 80% of the period's product sales. */
  let chunkCount=0, cum=0;
  if(t.sales>0){ for(const r of rows){ cum+=r.sales; chunkCount++; if(cum/t.sales>=0.80) break; } }
  const cards=[
    {cls:'k-good',label:'Chunk of Sales',value:fmtInt(chunkCount)+' Products',sub:fmtNum(t.sales>0?cum/t.sales*100:0,0)+'% of sales from these '+fmtInt(chunkCount)+' products'},
    {cls:'k-good k-text',label:'Top Product',value:esc(top?top.des:'—')||'—',sub:top?fmtSAR(top.sales):''},
    {cls:'k-value k-text',label:'Top Material Group',value:esc(tg[0]),sub:fmtSAR(tg[1])},
  ];
  el.innerHTML=cards.map(c=>
    '<div class="kpi '+c.cls+'"><div class="label">'+c.label+'</div><div class="value">'+c.value+'</div><div class="sub">'+c.sub+'</div></div>').join('');
}

/* ---------- customer table (top 1500 x month) ---------- */
const CCOL=[{k:'cust',t:'Customer',cls:''},{k:'name',t:'Name',cls:''},{k:'cls',t:'Class',cls:''},{k:'pt',t:'Payment Term',cls:''},
  {k:'inv',t:'Invoices',cls:'num'},{k:'aov',t:'AOV',cls:'num'},{k:'sales',t:'Sales',cls:'num'},
  {k:'gp',t:'GP',cls:'num'},{k:'gppct',t:'GP %',cls:'num'},{k:'returns',t:'Returns',cls:'num'},{k:'retpct',t:'Ret %',cls:'num'}];
const CHEAD=['Customer','Name','Class','Payment Term','Invoices','AOV','Sales','GP','GP %','Returns','Ret %'];
function customerRows(){
  const g={};
  const WALKIN = DATA.meta && DATA.meta.walkin;
  // customers rows: [cust, name, ym, class, payment_terms, sales, returns, qty, inv, cogs]
  for(const r of DATA.customers){
    if(!inRange(r[2])) continue;
    const k=r[0]; const o=g[k]||(g[k]={cust:r[0],name:r[1],cls:r[3]==='CREDIT'?'CREDIT':'CASH',pt:r[4]||'',sales:0,returns:0,qty:0,inv:0,cogs:0});
    o.sales+=r[5]||0; o.returns+=r[6]||0; o.qty+=r[7]||0; o.inv+=r[8]||0; o.cogs+=r[9]||0;
  }
  return Object.values(g).map(o=>{
    if(o.cust===WALKIN) o.name=(o.name||'').trim()+'  (walk-in counter)';   // flag the synthetic row when shown
    const gp=o.sales-o.cogs;
    return {...o, gp, gppct:o.sales>0?gp/o.sales*100:0, retpct:o.sales>0?o.returns/o.sales*100:0, aov:o.inv>0?o.sales/o.inv:0};
  }).sort((a,b)=>b.sales-a.sales);
}
const CFMT=(c,r)=>{
  if(c.k==='cust') return '<td>'+esc(strip0(r.cust))+'</td>';
  if(c.k==='name') return '<td>'+esc((r.name||'').trim()||'—')+'</td>';
  if(c.k==='cls') return '<td><span class="cc-tag '+(r.cls==='CREDIT'?'cc-credit':'cc-cash')+'">'+esc(r.cls)+'</span></td>';
  if(c.k==='pt') return '<td>'+esc(r.pt||'—')+'</td>';
  if(c.k==='sales') return '<td class="num" style="font-weight:600">'+fmtSAR(r.sales)+'</td>';
  if(c.k==='gp') return '<td class="num">'+fmtSAR(r.gp)+'</td>';
  if(c.k==='gppct') return '<td class="num">'+fmtNum(r.gppct,1)+'%</td>';
  if(c.k==='returns') return '<td class="num" style="color:var(--danger)">'+fmtSAR(r.returns)+'</td>';
  if(c.k==='retpct') return '<td class="num">'+fmtNum(r.retpct,1)+'%</td>';
  if(c.k==='inv') return '<td class="num">'+fmtInt(r.inv||0)+'</td>';
  if(c.k==='aov') return '<td class="num">'+fmtSAR(r.aov)+'</td>';
  return '<td>'+esc(r[c.k]==null?'':r[c.k])+'</td>';
};
/* By Customer KPI strip + Cash vs Credit donut — period-filterable.
   Computed on the CLIENT from DATA.customers (top-1500 x month) filtered by the global
   Year/Month filters (via customerRows()), so Cash/Credit Customers, Credit Exposure etc.
   follow the selected period instead of a fixed trailing-12-month window. Class per
   customer is fixed (latest invoice term in the trailing 12 months). GP = sales - cogs. */
function renderKpisCustomer(){
  const el=document.getElementById('kpis-customer'); if(!el) return;
  const rows=customerRows();
  const cash={sales:0,returns:0,inv:0}, credit={sales:0,returns:0,inv:0};
  let cashN=0, creditN=0, totSales=0;
  for(const r of rows){
    if(r.cls==='CREDIT'){ credit.sales+=r.sales||0; credit.returns+=r.returns||0; credit.inv+=r.inv||0; creditN++; }
    else                { cash.sales+=r.sales||0;   cash.returns+=r.returns||0;   cash.inv+=r.inv||0;   cashN++; }
    totSales+=r.sales||0;
  }
  const tot=cashN+creditN;
  const creditPct=totSales>0?credit.sales/totSales*100:0;
  const cashRetPct=cash.sales>0?cash.returns/cash.sales*100:0;
  const creditRetPct=credit.sales>0?credit.returns/credit.sales*100:0;
  const cards=[
    {cls:'k-value',label:'Active Customers',value:fmtInt(tot),sub:'in selected scope'},
    {cls:'k-good',label:'Cash Customers',value:fmtInt(cashN),sub:fmtNum(tot>0?cashN/tot*100:0,1)+'% of active'},
    {cls:'k-warn',label:'Credit Customers',value:fmtInt(creditN),sub:fmtNum(tot>0?creditN/tot*100:0,1)+'% of active'},
    {cls:'k-risk',label:'Credit Exposure',value:fmtSAR(credit.sales),sub:fmtNum(creditPct,1)+'% of sales'},
    {cls:'k-warn',label:'Credit Return %',value:fmtNum(creditRetPct,1)+'%',sub:'vs '+fmtNum(cashRetPct,1)+'% cash'},
  ];
  el.innerHTML=cards.map(c=>
    '<div class="kpi '+c.cls+'"><div class="label">'+c.label+'</div><div class="value">'+c.value+'</div><div class="sub">'+c.sub+'</div></div>').join('');
}
/* Cash vs Credit sales donut — same filtered scope as the KPI strip. */
function renderCustomerDonut(){
  const el=document.getElementById('customer-class-chart'); if(!el) return;
  const rows=customerRows();
  let cash=0, credit=0;
  for(const r of rows){ if(r.cls==='CREDIT') credit+=r.sales||0; else cash+=r.sales||0; }
  const total=cash+credit;
  makeChart('customer-class-chart',{type:'doughnut',data:{labels:['Cash','Credit'],
    datasets:[{data:[cash,credit],backgroundColor:['#22c1a4','#f5a623'],borderRadius:4}]},
    options:{maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{boxWidth:12,font:{size:11}}},
      tooltip:{callbacks:{label:c=>' '+c.label+': '+fmtSAR(c.raw)+' ('+(total>0?fmtNum(c.raw/total*100,1):0)+'%)'}}}}});}

/* Cash vs Credit — active customers by month (stacked bar, last 6 months ending at the
   selected month or latest in data). Class per customer is fixed (latest term). */
function renderCustomerClassTrend(){
  const el=document.getElementById('customer-class-trend'); if(!el) return;
  const all=[...new Set(DATA.customers.map(r=>r[2]))].sort();
  const end=state.month||all[all.length-1];
  const start=addMonths(end,-5);
  const cash={}, credit={};
  for(const r of DATA.customers){
    if(r[2]<start || r[2]>end) continue;
    if(r[3]==='CREDIT') credit[r[2]]=(credit[r[2]]||0)+1;
    else cash[r[2]]=(cash[r[2]]||0)+1;
  }
  const labels=[];
  for(let i=0;i<6;i++){ const ym=addMonths(start,i); labels.push(ym); }
  makeChart('customer-class-trend',{type:'bar',
    data:{labels:labels.map(x=>x.slice(4,6)+'/'+x.slice(0,4)),
      datasets:[
        {label:'Cash',data:labels.map(ym=>cash[ym]||0),backgroundColor:'#22c1a4',borderRadius:4},
        {label:'Credit',data:labels.map(ym=>credit[ym]||0),backgroundColor:'#f5a623',borderRadius:4},
      ]},
    options:{maintainAspectRatio:false,plugins:{legend:{position:'right',labels:{boxWidth:12,font:{size:11}}}},
      scales:{x:{stacked:true,grid:{display:false}},y:{stacked:true,ticks:{callback:v=>fmtInt(v)}}}}});
}

/* ---------- generic table ---------- */
function drawTable(tableId, rows, cols, fmt, sortKey, sortDir, page, pageSize){
  const sorted=[...rows].sort((x,y)=>{
    let a=x[sortKey],b=y[sortKey];
    if(typeof a==='number'&&typeof b==='number') return (a-b)*sortDir;
    a=(a==null?'':String(a)); b=(b==null?'':String(b));
    return a<b?-1*sortDir:a>b?1*sortDir:0;
  });
  const total=sorted.length, pages=Math.max(1,Math.ceil(total/pageSize));
  const p=Math.max(1,Math.min(page,pages));
  const start=(p-1)*pageSize, pageRows=sorted.slice(start,start+pageSize);
  const tbl=document.getElementById(tableId);
  tbl.querySelector('thead').innerHTML='<tr>'+cols.map(c=>
    '<th data-k="'+c.k+'" class="'+c.cls+'">'+c.t+(sortKey===c.k?(sortDir<0?' \u25BC':' \u25B2'):'')+'</th>').join('')+'</tr>';
  tbl.querySelector('tbody').innerHTML=pageRows.map(r=>'<tr>'+cols.map(c=>fmt(c,r)).join('')+'</tr>').join('');
  return {total,pages,page:p};
}

/* ---------- refresh ---------- */
function refresh(){
  const rows=filteredRows();
  const k=execTotals(rows);
  renderKPIs(rows);
  renderTrend();
  renderSeg(rows);
  renderExtGrp();
  renderRegion(rows);
  renderAttention(rows);
  // plant
  renderKpisPlant(rows);
  drawPlantTable(plantRows(rows));
  // segment
  const srows=segRows(rows);
  renderKpisSeg(rows);
  drawSegTable(srows);
  // region
  renderRegionPage();
  // product (all-periods board) & customer
  const trows=productRows();
  renderKpisProduct(trows);
  drawProductTable(trows);
  const crows=customerRows();
  renderKpisCustomer();
  renderCustomerDonut();
  renderCustomerClassTrend();
  drawCustomerTable(crows);
}
function drawPlantTable(rows){
  const cols=PCOL.filter(c=>state.pCols[c.k]);
  const res=drawTable('plant-table',rows,cols,PFMT,state.pSortKey,state.pSortDir,state.pPage,state.pPageSize);
  state.pPage=res.page;
  document.getElementById('p-page-info').textContent='Page '+res.page+' of '+res.pages+' \u00B7 '+fmtInt(res.total)+' plants';
  document.getElementById('p-prev').disabled=res.page<=1;
  document.getElementById('p-next').disabled=res.page>=res.pages;
  document.getElementById('plant-count').textContent=fmtInt(res.total)+' plants';
}
function drawSegTable(rows){
  const res=drawTable('seg-table',rows,SCOL,SFMT,state.segSortKey,state.segSortDir,1,50);
  document.getElementById('seg-count').textContent=fmtInt(res.total)+' segments';
}
function drawProductTable(rows){
  const res=drawTable('product-table',rows,TCOL,TFMT,state.prSortKey,state.prSortDir,state.prPage,state.prPageSize);
  state.prPage=res.page;
  document.getElementById('pr-page-info').textContent='Page '+res.page+' of '+res.pages+' \u00B7 '+fmtInt(res.total)+' products';
  document.getElementById('pr-prev').disabled=res.page<=1;
  document.getElementById('pr-next').disabled=res.page>=res.pages;
  document.getElementById('product-count').textContent=fmtInt(res.total)+' products';
}
function drawCustomerTable(rows){
  const res=drawTable('customer-table',rows,CCOL,CFMT,state.cSortKey,state.cSortDir,state.cPage,state.cPageSize);
  state.cPage=res.page;
  document.getElementById('c-page-info').textContent='Page '+res.page+' of '+res.pages+' \u00B7 '+fmtInt(res.total)+' customers';
  document.getElementById('c-prev').disabled=res.page<=1;
  document.getElementById('c-next').disabled=res.page>=res.pages;
  document.getElementById('customer-count').textContent=fmtInt(res.total)+' customers';
}

/* ---------- CSV ---------- */
function downloadCsv(name,text){ const blob=new Blob([text],{type:'text/csv;charset=utf-8;'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),500); }
function csvFrom(rows,head,keys){ const data=[head.join(',')]; for(const r of rows){ data.push(keys.map(k=>{const v=r[k]; if(v==null)return ''; if(typeof v==='number')return v; return '"'+String(v).replace(/"/g,'""')+'"';}).join(',')); } return data.join('\n'); }
function exportPlantCsv(rows){
  const cols=PCOL.filter(c=>state.pCols[c.k]);
  downloadCsv('sales_by_plant.csv',csvFrom(plantRows(rows),cols.map(c=>c.t),cols.map(c=>c.k)));
}
function exportSegCsv(rows){ downloadCsv('sales_by_segment.csv',csvFrom(segRows(rows),SHEAD,SCOL.map(c=>c.k))); }
function exportProductCsv(){ downloadCsv('sales_by_product.csv',csvFrom(productRows(),THEAD,TCOL.map(c=>c.k))); }
function exportCustomerCsv(){ downloadCsv('sales_by_customer.csv',csvFrom(customerRows(),CHEAD,CCOL.map(c=>c.k))); }

/* ---------- filters UI ---------- */
function fillSelect(id,opts,placeholder){ const el=document.getElementById(id); if(!el) return; el.innerHTML='<option value="">'+placeholder+'</option>'+opts.map(o=>'<option value="'+esc(o[0])+'">'+esc(o[1])+'</option>').join(''); }
function initFilters(){
  const mons=[...new Set(DATA.rows.map(r=>r[0]))].sort();
  const years=[...new Set(mons.map(m=>m.slice(0,4)))].sort();
  const curYear=String(new Date().getFullYear());
  const curMonth=new Date().getFullYear()+String(new Date().getMonth()+1).padStart(2,'0');
  fillSelect('f-year',years.map(y=>[y,y]),'All years');
  fillSelect('f-month',mons.map(m=>[m,m.slice(4,6)+'/'+m.slice(0,4)]),'All months');
  fillSelect('f-plant',Object.keys(PLANTS).sort().map(w=>[w,strip0(w)+' \u2013 '+plantInfo(w).name]),'All plants');
  fillSelect('f-segment',SEG_ORDER.filter(s=>SEG_NAME[s]&&s!=='').map(s=>[s,SEG_NAME[s]]),'All segments');
  // Defaults: current year + current month (fall back to latest available if not present)
  const yearEl=document.getElementById('f-year');
  const hasYear=years.includes(curYear);
  state.year=hasYear?curYear:''; if(yearEl) yearEl.value=state.year;
  const monthEl=document.getElementById('f-month');
  const defMonth=mons.includes(curMonth)?curMonth:(mons[mons.length-1]||'');
  state.month=defMonth; if(monthEl) monthEl.value=defMonth;
}
function bindFilters(){
  const map={'f-year':'year','f-month':'month','f-plant':'plant','f-segment':'segment'};
  for(const id in map){ const el=document.getElementById(id); if(!el) continue; el.addEventListener('change',()=>{ state[map[id]]=el.value; state.pPage=state.prPage=state.cPage=1; refresh(); }); }
  document.getElementById('reset').onclick=()=>{
    // Reset to defaults: current year + current month
    const mons=[...new Set(DATA.rows.map(r=>r[0]))].sort();
    const years=[...new Set(mons.map(m=>m.slice(0,4)))].sort();
    const curYear=String(new Date().getFullYear());
    const curMonth=new Date().getFullYear()+String(new Date().getMonth()+1).padStart(2,'0');
    const yearEl=document.getElementById('f-year');
    const hasYear=years.includes(curYear);
    state.year=hasYear?curYear:''; yearEl.value=state.year;
    const monthEl=document.getElementById('f-month');
    const defMonth=mons.includes(curMonth)?curMonth:(mons[mons.length-1]||'');
    state.month=defMonth; monthEl.value=defMonth;
    state.plant=''; state.segment='';
    ['f-plant','f-segment'].forEach(id=>{const el=document.getElementById(id); if(el) el.value='';});
    state.pSortDir=state.prSortDir=state.segSortDir=state.cSortDir=-1; state.pPage=state.prPage=state.cPage=1;
    refresh();
  };
}
function bindNav(){ document.querySelectorAll('#nav .tab').forEach(tab=>{ tab.addEventListener('click',()=>{ document.querySelectorAll('#nav .tab').forEach(t=>t.classList.remove('active')); tab.classList.add('active'); const pg=tab.dataset.page; document.querySelectorAll('.page').forEach(p=>p.classList.remove('active')); const el=document.getElementById('page-'+pg); if(el) el.classList.add('active'); }); }); }
function bindTables(){
  const wire=(sel,sk,sd)=>{ document.querySelector(sel).addEventListener('click',e=>{ const th=e.target.closest('th'); if(!th) return; const k=th.dataset.k; if(!k) return; if(state[sk]===k) state[sd]*=-1; else {state[sk]=k; state[sd]=-1;} refresh(); }); };
  wire('#plant-table thead','pSortKey','pSortDir');
  wire('#seg-table thead','segSortKey','segSortDir');
  wire('#product-table thead','prSortKey','prSortDir');
  wire('#customer-table thead','cSortKey','cSortDir');
  document.getElementById('p-page-size').onchange=e=>{ state.pPageSize=parseInt(e.target.value,10); state.pPage=1; refresh(); };
  document.getElementById('p-prev').onclick=()=>{ if(state.pPage>1){state.pPage--; refresh();} };
  document.getElementById('p-next').onclick=()=>{ state.pPage++; refresh(); };
  document.getElementById('pr-page-size').onchange=e=>{ state.prPageSize=parseInt(e.target.value,10); state.prPage=1; refresh(); };
  document.getElementById('pr-prev').onclick=()=>{ if(state.prPage>1){state.prPage--; refresh();} };
  document.getElementById('pr-next').onclick=()=>{ state.prPage++; refresh(); };
  document.getElementById('c-page-size').onchange=e=>{ state.cPageSize=parseInt(e.target.value,10); state.cPage=1; refresh(); };
  document.getElementById('c-prev').onclick=()=>{ if(state.cPage>1){state.cPage--; refresh();} };
  document.getElementById('c-next').onclick=()=>{ state.cPage++; refresh(); };
  document.getElementById('export-plant-csv').onclick=()=>exportPlantCsv(filteredRows());
  document.getElementById('export-seg-csv').onclick=()=>exportSegCsv(filteredRows());
  document.getElementById('export-product-csv').onclick=()=>exportProductCsv();
  document.getElementById('export-customer-csv').onclick=()=>exportCustomerCsv();
}

/* ---------- boot ---------- */
function boot(){
  if(window.__SALES__ && window.__SALES__.rows){
    DATA=window.__SALES__;
  } else {
    const ld=document.getElementById('loading'); if(ld) ld.innerHTML='Failed to load data.';
    return;
  }
  for(const p of DATA.plants) PLANTS[p[0]]=[p[1],p[2],p[3],p[4],p[5]];
  for(const p of (DATA.prod_info||[])) PROD_INFO[p[0]]=[p[1],p[2],p[3]];
  for(const t of DATA.targets){ const def=TARGET_DEF[t[0]]||(TARGET_DEF[t[0]]={}); def[t[1]]=t[2]; }
  document.getElementById('meta-time').textContent='Data refreshed: '+(DATA.meta.generated_at||'…');
  initTheme();
  document.getElementById("theme-toggle").onclick=()=>{ applyTheme(CURRENT_THEME==='light'?'dark':'light'); refresh(); };
  initFilters();
  bindFilters();
  bindNav();
  bindTables();
  initPlantCols();
  refresh();
  const ld=document.getElementById('loading'); if(ld) ld.style.display='none';
}
// Boot only after the login gate confirms a session (auth.js dispatches auth:ready).
document.addEventListener('auth:ready', boot);
// Fallback for local double-click testing without auth files present: boot anyway.
// (typeof check — top-level const does not attach to window)
if (typeof SUPABASE_URL === 'undefined' || typeof SUPABASE_ANON_KEY === 'undefined') {
  document.addEventListener('DOMContentLoaded', boot);
}
