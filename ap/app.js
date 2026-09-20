/* Accounts Payable Dashboard - client-side analytics over data.js payload
   Source: fact_accounts_payable (BSIK-only FIFO payment-application), SAP ECC PRD.
   Grain: one row per UNPAID vendor line item. All amounts SAR (positive).
   Outstanding AP = SUM(remaining_amount). Buckets: Not Due / 0-30 / 31-60 /
   61-90 / 91-120 / 120+ Days (vs CAST(GETDATE() AS DATE) at extract). */
'use strict';

const FONT = "'Segoe UI', Roboto, Arial, sans-serif";
const BUCKET_ORDER = ['Not Due','0-30 Days','31-60 Days','61-90 Days','91-120 Days','120+ Days','Advance Payment'];
const BUCKET_COLOR = {
  'Not Due':'#33c08a','0-30 Days':'#4f8cff','31-60 Days':'#e6c15c','61-90 Days':'#f0a63e',
  '91-120 Days':'#ff8c42','120+ Days':'#e5484d','Advance Payment':'#9b6bff'};
const BUCKET_CLASS = {
  'Not Due':'t-NotDue','0-30 Days':'t-Low','31-60 Days':'t-Low','61-90 Days':'t-High',
  '91-120 Days':'t-Critical','120+ Days':'t-Critical','Advance Payment':'t-NotDue'};

let DATA = null;            // window.__AP__
let VENDOR_LIST = [];       // [code, name] for the vendor combo
const state = {
  company:'', vendor:'', bucket:'', credit:'', currency:'',
  dfrom:'', dto:'',
  topN:15,
  vSortKey:'total', vSortDir:-1, vPage:1, vPageSize:20,
  dSortKey:'remaining', dSortDir:-1, dPage:1, dPageSize:50,
};
const charts = {};
let CURRENT_THEME = 'dark';

/* ---------- helpers ---------- */
const fmtInt = n => Math.round(n==null?0:n).toLocaleString('en-US',{maximumFractionDigits:0});
const fmtNum = (n,d=2) => (n==null?0:n).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:d});
const fmtAP = n => 'SAR '+fmtInt(n);
const fmtM = n => fmtNum(n/1e6,2)+'M';
const esc = s => String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const strip0 = s => String(s==null?'':s).replace(/^0+/,'')||'0';
function cssVar(n){ return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function heatColor(v, max, base){ // rgba tint scaled by value/max
  const a = max>0 ? Math.max(0.10, Math.min(0.85, 0.10 + 0.75*(v/max))) : 0.10;
  return 'rgba('+base+','+a.toFixed(3)+')';
}

/* ---------- theme ---------- */
/* Sun/moon pair for the account-menu theme row. Both stay in the DOM and
   cross-fade, so enter AND exit animate. */
const THEME_ICONS =
  '<span class="icon-stack">'+
  '<svg class="icon icon-sun" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'+
  '<svg class="icon icon-moon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3a6.6 6.6 0 0 0 9.8 9.8Z"/></svg>'+
  '</span><span class="theme-item-label"></span>';

function applyTheme(t){
  CURRENT_THEME=t;
  document.documentElement.setAttribute('data-theme',t);
  try{localStorage.setItem('ap-theme',t);}catch(e){}
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
  try{ t = localStorage.getItem('ap-theme') || 'dark'; }catch(e){}
  applyTheme(t==='light'?'light':'dark');
}
Chart.defaults.font.family=FONT;

/* ---------- data access ---------- */
function itemObj(r){
  return {cc:r[0], vendor:r[1], belnr:r[2], gjahr:r[3], buzei:r[4],
    pdate:r[5], ddate:r[6], wrbtr:r[7], dmbtr:r[8], waers:r[9],
    block:r[10], zterm:r[11], text1:r[12], credit:r[13], due:r[14],
    applied:r[15], remaining:r[16], bucket:r[17], name:r[18], local:r[19]};
}
function filteredItems(){
  const out = [];
  for(const r of DATA.items){
    if(state.company && r[0]!==state.company) continue;
    if(state.vendor && r[1]!==state.vendor) continue;
    if(state.bucket && r[17]!==state.bucket) continue;
    if(state.currency && r[9]!==state.currency) continue;
    if(state.credit!=='' && r[13]!==parseInt(state.credit,10)) continue;
    if(state.dfrom && r[14] && r[14] < state.dfrom) continue;
    if(state.dto && r[14] && r[14] > state.dto) continue;
    out.push(r);
  }
  return out;
}

/* ---------- aggregation ---------- */
function sum(rows, f){ let s=0; for(const r of rows) s+=(f(r)||0); return s; }
function byBucket(rows){
  const b={}; for(const k of BUCKET_ORDER) b[k]=0;
  for(const r of rows) b[r[17]]=(b[r[17]]||0)+(r[16]||0);
  return b;
}
function byGroup(rows, keyFn){
  const g={};
  for(const r of rows){
    const k=keyFn(r);
    const o=g[k]||(g[k]={open:0, notdue:0, overdue:0, count:0});
    const rem=r[16]||0;
    o.open+=rem;
    if(r[17]==='Not Due') o.notdue+=rem; else o.overdue+=rem;
    o.count++;
  }
  return g;
}
function byVendor(rows){
  const v={};
  for(const r of rows){
    const key=r[1];
    const o=v[key]||(v[key]={vendor:r[1],name:r[18],local:r[19],count:0,total:0,notdue:0,b:{},
      over90:0,oldest:'',credits:[],cc:new Set(),maxDue:''});
    o.count++; o.total+=r[16]||0; o.cc.add(r[0]);
    o.b[r[17]]=(o.b[r[17]]||0)+(r[16]||0);
    if(r[17]==='Not Due') o.notdue+=r[16]||0;
    if(r[17]==='91-120 Days'||r[17]==='120+ Days') o.over90+=r[16]||0;
    if(r[14] && (!o.oldest || r[14]<o.oldest)) o.oldest=r[14];
    if(r[14] && r[14]>o.maxDue) o.maxDue=r[14];
    if(r[13]!=null) o.credits.push(r[13]);
  }
  return Object.values(v).map(o=>({...o, cc:[...o.cc].join(','),
    avgCredit:o.credits.length? o.credits.reduce((a,b)=>a+b,0)/o.credits.length : 0}));
}
function byTerms(rows){
  const t={};
  for(const r of rows){
    const k=r[11]||'Not Defined';
    const o=t[k]||(t[k]={open:0,count:0});
    o.open+=r[16]||0; o.count++;
  }
  return Object.entries(t).sort((a,b)=>b[1].open-a[1].open);
}
function computeKpis(rows){
  // Advances are held out of Total Outstanding AP and shown on their own card.
  let total=0, notdue=0, over90=0, advance=0, nInv=0, nAdv=0;
  for(const r of rows){
    const rem=r[16]||0;
    if(r[17]==='Advance Payment'){ advance+=rem; nAdv++; continue; }
    nInv++;
    total+=rem;
    if(r[17]==='Not Due') notdue+=rem;
    if(r[17]==='91-120 Days'||r[17]==='120+ Days') over90+=rem;
  }
  const overdue=total-notdue;
  return {total, notdue, overdue, over90, advance, count:nInv, advCount:nAdv};
}
function renderKPIs(k){
  const overduePct = k.total>0 ? k.overdue/k.total*100 : 0;
  const notduePct = k.total>0 ? k.notdue/k.total*100 : 0;
  const cards=[
    {cls:'k-value',label:'Total Outstanding AP',value:fmtAP(k.total),sub:fmtInt(k.count)+' open lines'},
    {cls:'k-good',label:'Not Due AP',value:fmtAP(k.notdue),sub:fmtNum(notduePct,1)+'% of total'},
    {cls:'k-risk',label:'Overdue AP',value:fmtAP(k.overdue),sub:fmtNum(overduePct,1)+'% of total'},
    {cls:'k-warn',label:'AP >90 Days',value:fmtAP(k.over90),sub:fmtNum(k.total>0?k.over90/k.total*100:0,1)+'% of total'},
    {cls:'k-purple',label:'Advance Payment',value:fmtAP(k.advance),sub:fmtInt(k.advCount)+' advance lines'},
  ];
  document.getElementById('kpis').innerHTML=cards.map(c=>
    '<div class="kpi '+c.cls+'"><div class="label">'+c.label+'</div><div class="value">'+c.value+'</div><div class="sub">'+c.sub+'</div></div>').join('');
}

/* ---------- charts ---------- */
function makeChart(id, cfg){
  const ctx=document.getElementById(id);
  if(!ctx) return;
  if(charts[id]) charts[id].destroy();
  charts[id]=new Chart(ctx,cfg);
}
function renderAging(b){
  const labels=BUCKET_ORDER.filter(k=>b[k]>0);
  const total=Object.values(b).reduce((s,x)=>s+x,0);
  makeChart('chart-aging',{type:'bar',data:{labels,datasets:[{data:labels.map(k=>b[k]),
    backgroundColor:labels.map(k=>BUCKET_COLOR[k]),borderRadius:6}]},
    options:{indexAxis:'y',maintainAspectRatio:false,
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+fmtAP(c.raw)+' ('+fmtNum((c.raw/(total||1))*100,1)+'%)'}}},
      scales:{x:{ticks:{callback:v=>fmtM(v)}}}}});
}
function renderLocal(l){
  const labels=['LOCAL','FOREIGN'];
  const get=k=>l[k]||{notdue:0,overdue:0};
  makeChart('chart-local',{type:'bar',data:{labels,datasets:[
    {label:'Not Due',data:labels.map(k=>get(k).notdue),backgroundColor:'#33c08a',borderRadius:4,stack:'s'},
    {label:'Overdue',data:labels.map(k=>get(k).overdue),backgroundColor:'#ff5d6c',borderRadius:4,stack:'s'}]},
    options:{maintainAspectRatio:false,plugins:{legend:{labels:{usePointStyle:true}},tooltip:{callbacks:{label:x=>x.dataset.label+': '+fmtAP(x.raw)}}},
      scales:{x:{stacked:true},y:{stacked:true,ticks:{callback:v=>fmtM(v)}}}}});
}
function renderCompany(c){
  const keys=Object.keys(c).sort();
  makeChart('chart-company',{type:'bar',data:{labels:keys,datasets:[
    {label:'Not Due',data:keys.map(k=>c[k].notdue),backgroundColor:'#33c08a',borderRadius:4,stack:'s'},
    {label:'Overdue',data:keys.map(k=>c[k].overdue),backgroundColor:'#ff5d6c',borderRadius:4,stack:'s'}]},
    options:{maintainAspectRatio:false,plugins:{legend:{labels:{usePointStyle:true}},tooltip:{callbacks:{label:x=>x.dataset.label+': '+fmtAP(x.raw)}}},
      scales:{x:{stacked:true},y:{stacked:true,ticks:{callback:v=>fmtM(v)}}}}});
}
function renderTerms(t){
  const top=t.slice(0,12);
  makeChart('chart-terms',{type:'bar',data:{labels:top.map(e=>e[0]),
    datasets:[{data:top.map(e=>e[1].open),backgroundColor:top.map((_,i)=>'hsl('+(12+i*6)+' 70% 52%)'),borderRadius:6}]},
    options:{indexAxis:'y',maintainAspectRatio:false,plugins:{legend:{display:false},
      tooltip:{callbacks:{label:c=>' '+fmtAP(c.raw)+' / '+fmtInt(top[c.dataIndex][1].count)+' lines'}}},
      scales:{x:{ticks:{callback:v=>fmtM(v)}}}}});
}

/* ---------- management attention ---------- */
function renderAttention(rows, total, vendors){
  const b=byBucket(rows);
  const over30=b['31-60 Days']+b['61-90 Days']+b['91-120 Days']+b['120+ Days'];
  const over60=b['61-90 Days']+b['91-120 Days']+b['120+ Days'];
  const over90=b['91-120 Days']+b['120+ Days'];
  const over120=b['120+ Days'];
  const sorted=vendors.slice().sort((a,b)=>b.total-a.total);
  const big=sorted[0];
  const overBig=sorted.slice().sort((a,b)=>b.overdue-a.overdue)[0];
  let bigInv=null, oldestInv=null;
  for(const r of rows){
    if(!bigInv || r[16]>bigInv[16]) bigInv=r;
    if(!oldestInv || (r[14] && r[14]<oldestInv[14])) oldestInv=r;
  }
  const pct=(v,t)=>(t>0? v/t*100:0);
  const tiles=[
    {l:'AP >30 Days',v:fmtAP(over30),s:fmtNum(pct(over30,total),1)+'% of total',c:'risk'},
    {l:'AP >60 Days',v:fmtAP(over60),s:fmtNum(pct(over60,total),1)+'% of total',c:'risk'},
    {l:'AP >90 Days',v:fmtAP(over90),s:fmtNum(pct(over90,total),1)+'% of total',c:'risk'},
    {l:'AP >120 Days',v:fmtAP(over120),s:fmtNum(pct(over120,total),1)+'% of total',c:'warn'},
    {l:'Largest Vendor Exposure',v:fmtAP(big?big.total:0),s:big?('<span class="nm">'+esc(big.name||big.vendor)+'</span>'):'',c:'risk'},
    {l:'Largest Overdue Vendor',v:fmtAP(overBig?overBig.overdue:0),s:overBig?('<span class="nm">'+esc(overBig.name||overBig.vendor)+'</span>'):'',c:'risk'},
    {l:'Largest Open Invoice',v:fmtAP(bigInv?bigInv[16]:0),s:bigInv?('<span class="nm">'+esc(bigInv[18])+' · '+esc(bigInv[2])+'</span>'):'',c:''},
    {l:'Oldest Due Invoice',v:oldestInv&&oldestInv[14]?esc(oldestInv[14]):'—',s:oldestInv?('<span class="nm">'+esc(oldestInv[18])+' · '+esc(oldestInv[2])+'</span>'):'',c:'warn'},
  ];
  document.getElementById('attention').innerHTML=tiles.map(t=>
    '<div class="att"><div class="l">'+t.l+'</div><div class="v '+(t.c||'')+'">'+t.v+'</div><div class="s">'+t.s+'</div></div>').join('');
}

/* ---------- vendor table ---------- */
const VCOL = [
  {k:'vendor',t:'Vendor',cls:''},{k:'name',t:'Vendor Name',cls:''},{k:'local',t:'L/F',cls:''},
  {k:'cc',t:'Company',cls:''},{k:'count',t:'Invoices',cls:'num'},{k:'total',t:'Total Outstanding',cls:'num'},
  {k:'notdue',t:'Not Due',cls:'num'},{k:'b30',t:'0-30',cls:'num'},{k:'b60',t:'31-60',cls:'num'},
  {k:'b90',t:'61-90',cls:'num'},{k:'b120',t:'91-120',cls:'num'},{k:'b120p',t:'120+',cls:'num'},
  {k:'adv',t:'Advance',cls:'num'},
  {k:'over90',t:'AP >90',cls:'num'},{k:'pct',t:'% of Total',cls:'num'},{k:'oldest',t:'Oldest Due',cls:''},
  {k:'avgCredit',t:'Avg Credit Days',cls:'num'},
];
const VHEAD=['Vendor','Vendor Name','L/F','Company','Invoices','Total Outstanding','Not Due','0-30','31-60','61-90','91-120','120+','Advance','AP >90','% of Total','Oldest Due','Avg Credit Days'];
function vendorRows(rows){
  return byVendor(rows).map(o=>({...o,
    b30:o.b['0-30 Days']||0,b60:o.b['31-60 Days']||0,b90:o.b['61-90 Days']||0,
    b120:o.b['91-120 Days']||0,b120p:o.b['120+ Days']||0,
    adv:o.b['Advance Payment']||0,
    overdue:o.total-o.notdue})).sort((a,b)=>b.total-a.total);
}
const VFMT=(c,r,ctx)=>{
  if(c.k==='vendor') return '<td>'+esc(strip0(r.vendor))+'</td>';
  if(c.k==='name') return '<td>'+esc(r.name||'')+'</td>';
  if(c.k==='local') return '<td><span class="tag '+(r.local==='FOREIGN'?'t-High':'t-NotDue')+'">'+esc(r.local)+'</span></td>';
  if(c.k==='cc') return '<td>'+esc(r.cc)+'</td>';
  if(c.k==='count') return '<td class="num">'+fmtInt(r.count)+'</td>';
  if(c.k==='total') return '<td class="num" style="font-weight:600">'+fmtAP(r.total)+'</td>';
  if(c.k==='pct') return '<td class="num">'+fmtNum(r.pct,1)+'%</td>';
  if(c.k==='oldest') return '<td>'+(r.oldest?esc(r.oldest):'—')+'</td>';
  if(c.k==='avgCredit') return '<td class="num">'+fmtNum(r.avgCredit,0)+'</td>';
  if(c.k==='over90') return '<td class="num" style="color:'+(r.over90>0?'var(--danger)':'inherit')+'">'+fmtAP(r.over90)+'</td>';
  if(c.k==='notdue') return heatTd(r.notdue, ctx.maxNot,'33,192,138');
  if(c.k==='b30') return heatTd(r.b30, ctx.max30,'79,140,255');
  if(c.k==='b60') return heatTd(r.b60, ctx.max60,'230,193,92');
  if(c.k==='b90') return heatTd(r.b90, ctx.max90,'240,166,62');
  if(c.k==='b120') return heatTd(r.b120, ctx.max120,'255,140,66');
  if(c.k==='b120p') return heatTd(r.b120p, ctx.max120p,'229,72,77');
  if(c.k==='adv') return heatTd(r.adv, ctx.maxAdv,'155,107,255');
  return '<td>'+esc(r[c.k]==null?'':r[c.k])+'</td>';
};
function heatTd(v,max,base){
  return '<td class="num" style="background:'+heatColor(v,max,base)+'">'+fmtAP(v)+'</td>';
}

/* ---------- detail table ---------- */
const DCOL = [
  {k:'cc',t:'Co',cls:''},{k:'vendor',t:'Vendor',cls:''},{k:'name',t:'Vendor Name',cls:''},
  {k:'belnr',t:'Document',cls:''},{k:'gjahr',t:'FY',cls:''},{k:'buzei',t:'Line',cls:''},
  {k:'pdate',t:'Posting',cls:''},{k:'ddate',t:'Doc Date',cls:''},{k:'due',t:'Due',cls:''},
  {k:'credit',t:'Credit Days',cls:'num'},{k:'zterm',t:'Terms',cls:''},{k:'text1',t:'Term Text',cls:''},
  {k:'waers',t:'Cur',cls:''},{k:'dmbtr',t:'Invoice Amt',cls:'num'},{k:'applied',t:'Applied',cls:'num'},
  {k:'remaining',t:'Remaining',cls:'num'},{k:'bucket',t:'Aging',cls:''},
  {k:'local',t:'L/F',cls:''},
];
const DHEAD=['Co','Vendor','Vendor Name','Document','FY','Line','Posting','Doc Date','Due','Credit Days','Terms','Term Text','Cur','Invoice Amt','Applied','Remaining','Aging','L/F'];
const DFMT=(c,r)=>{
  if(c.k==='vendor') return '<td>'+esc(strip0(r.vendor))+'</td>';
  if(c.k==='name') return '<td>'+esc(r.name||'')+'</td>';
  if(c.k==='dmbtr') return '<td class="num">'+fmtAP(r.dmbtr)+'</td>';
  if(c.k==='applied') return '<td class="num" style="color:var(--muted)">'+fmtAP(r.applied)+'</td>';
  if(c.k==='remaining') return '<td class="num" style="font-weight:600">'+fmtAP(r.remaining)+'</td>';
  if(c.k==='bucket') return '<td><span class="tag '+BUCKET_CLASS[r.bucket]+'">'+esc(r.bucket)+'</span></td>';
  if(c.k==='local') return '<td>'+esc(r.local==='FOREIGN'?'F':'L')+'</td>';
  if(c.k==='credit') return '<td class="num">'+fmtInt(r.credit)+'</td>';
  if(c.k==='pdate'||c.k==='ddate'||c.k==='due') return '<td>'+(r[c.k]?esc(r[c.k]):'—')+'</td>';
  return '<td>'+esc(r[c.k]==null?'':r[c.k])+'</td>';
};

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
  const ctx={}; // for vendor heat scaling
  ctx.maxNot=Math.max(...pageRows.map(r=>r.notdue||0));
  ctx.max30=Math.max(...pageRows.map(r=>r.b30||0));
  ctx.max60=Math.max(...pageRows.map(r=>r.b60||0));
  ctx.max90=Math.max(...pageRows.map(r=>r.b90||0));
  ctx.max120=Math.max(...pageRows.map(r=>r.b120||0));
  ctx.max120p=Math.max(...pageRows.map(r=>r.b120p||0));
  ctx.maxAdv=Math.max(...pageRows.map(r=>r.adv||0));
  tbl.querySelector('tbody').innerHTML=pageRows.map(r=>'<tr>'+cols.map(c=>fmt(c,r,ctx)).join('')+'</tr>').join('');
  return {total,pages,page:p};
}

/* ---------- refresh ---------- */
function refresh(){
  const rows=filteredItems();
  const k=computeKpis(rows);
  const total=k.total;   // Total Outstanding AP = invoices only (advances held out)
  renderKPIs(k);
  const b=byBucket(rows);
  renderAging(b);
  const local=byGroup(rows,r=>r[19]==='FOREIGN'?'FOREIGN':'LOCAL');
  renderLocal(local);
  renderCompany(byGroup(rows,r=>r[0]));
  renderTerms(byTerms(rows));
  const vendors=vendorRows(rows);
  const vendTotal=vendors.reduce((s,v)=>s+v.total,0);   // incl advances -> matches the table's Total Outstanding
  const vrows=vendors.map(v=>({...v,pct:vendTotal>0?v.total/vendTotal*100:0}));
  renderAttention(rows,total,vrows);
  drawVendorTable(vrows);
  drawDetailTable(rows);
}
function drawVendorTable(rows){
  const limited=state.topN>0?rows.slice(0,state.topN):rows;
  const res=drawTable('vendor-table',limited,VCOL,VFMT,state.vSortKey,state.vSortDir,state.vPage,state.vPageSize);
  state.vPage=res.page;
  document.getElementById('v-page-info').textContent='Page '+res.page+' of '+res.pages+' \u00B7 '+fmtInt(res.total)+' vendors';
  document.getElementById('v-prev').disabled=res.page<=1;
  document.getElementById('v-next').disabled=res.page>=res.pages;
  document.getElementById('vendor-count').textContent=fmtInt(rows.length)+' vendors';
}
function drawDetailTable(rows){
  const objs=rows.map(itemObj);
  const res=drawTable('detail-table',objs,DCOL,DFMT,state.dSortKey,state.dSortDir,state.dPage,state.dPageSize);
  state.dPage=res.page;
  document.getElementById('detail-count').textContent=fmtInt(res.total)+' open line items';
  document.getElementById('d-page-info').textContent='Page '+res.page+' of '+res.pages+' \u00B7 '+fmtInt(res.total)+' items';
  document.getElementById('d-prev').disabled=res.page<=1;
  document.getElementById('d-next').disabled=res.page>=res.pages;
}

/* ---------- CSV ---------- */
function downloadCsv(name,text){
  const blob=new Blob([text],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob); a.download=name; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),500);
}
function csvFrom(rows, head, keys){
  const data=[head.join(',')];
  for(const r of rows){
    data.push(keys.map(k=>{const v=r[k]; if(v==null)return ''; if(typeof v==='number')return v; return '"'+String(v).replace(/"/g,'""')+'"';}).join(','));
  }
  return data.join('\n');
}
function exportVendorCsv(rows){
  const vr=vendorRows(rows);
  const grand=vr.reduce((s,v)=>s+v.total,0);
  const flat=vr.map(v=>({vendor:v.vendor,name:v.name,local:v.local,cc:v.cc,count:v.count,
    total:v.total,notdue:v.notdue,b30:v.b30,b60:v.b60,b90:v.b90,b120:v.b120,b120p:v.b120p,adv:v.adv,
    over90:v.over90,pct:grand>0?Math.round(v.total/grand*1000)/10:0,oldest:v.oldest,avgCredit:Math.round(v.avgCredit*10)/10}));
  downloadCsv('ap_vendor_summary.csv',csvFrom(flat,VHEAD,['vendor','name','local','cc','count','total','notdue','b30','b60','b90','b120','b120p','adv','over90','pct','oldest','avgCredit']));
}
function exportDetailCsv(rows){
  downloadCsv('ap_open_line_items.csv',csvFrom(rows.map(itemObj),DHEAD,DCOL.map(c=>c.k)));
}

/* ---------- filters UI ---------- */
function fillSelect(id,opts,placeholder){
  const el=document.getElementById(id);
  if(!el) return;
  el.innerHTML='<option value="">'+placeholder+'</option>'+opts.map(o=>'<option value="'+esc(o[0])+'">'+esc(o[1])+'</option>').join('');
}
function initFilters(){
  const all=DATA.items;
  const comps=[...new Set(all.map(r=>r[0]))].sort();
  fillSelect('f-company',comps.map(c=>[c,c]),'All');
  const vmap={};
    for(const r of all) if(!(r[1] in vmap)) vmap[r[1]]=r[18];
    VENDOR_LIST=Object.keys(vmap).sort().map(v=>[v,vmap[v]||'']);
    initVendorCombo();
  const buckets=BUCKET_ORDER.filter(bk=>all.some(r=>r[17]===bk));
  fillSelect('f-bucket',buckets.map(bk=>[bk,bk]),'All');
  const credits=[...new Set(all.map(r=>r[13]).filter(c=>c!=null))].sort((a,b)=>a-b);
  fillSelect('f-credit',credits.map(c=>[c,'Credit '+c+'d']),'All');
  const curs=[...new Set(all.map(r=>r[9]))].sort();
  fillSelect('f-currency',curs.map(c=>[c,c]),'All');
}
function bindFilters(){
  const map={
    'f-company':'company','f-bucket':'bucket',
    'f-credit':'credit','f-currency':'currency',
    'f-dfrom':'dfrom','f-dto':'dto'};
  for(const id in map){
    const el=document.getElementById(id);
    if(!el) continue;
    el.addEventListener('change',()=>{
      state[map[id]]=el.value;
      state.vPage=1; state.dPage=1; refresh();
    });
  }
  document.getElementById('reset').onclick=()=>{
    Object.keys(state).forEach(k=>{ if(typeof state[k]==='string') state[k]=''; });
    state.topN=15; state.vSortKey='total'; state.vSortDir=-1; state.vPage=1;
    state.dSortKey='remaining'; state.dSortDir=-1; state.dPage=1;
    ['f-company','f-bucket','f-credit','f-currency'].forEach(id=>{const el=document.getElementById(id); if(el) el.value='';});
    ['f-dfrom','f-dto'].forEach(id=>{const el=document.getElementById(id); if(el) el.value='';});
    resetVendorCombo();
    refresh();
  };
}
function initVendorCombo(){
  const input=document.getElementById('f-vendor');
  const list=document.getElementById('vendor-list');
  if(!input||!list) return;
  const render=(q)=>{
    const t=(q||'').trim().toLowerCase();
    const opts=VENDOR_LIST.filter(v=>!t||(v[0]+' '+v[1]).toLowerCase().includes(t));
    list.innerHTML=opts.length
      ? opts.map(v=>'<div class="combo-opt" data-v="'+esc(v[0])+'">'+esc(strip0(v[0])+' \u2013 '+(v[1]||''))+'</div>').join('')
      : '<div class="combo-empty">No matching vendors</div>';
    list.classList.add('open');
  };
  input.addEventListener('focus',()=>render(input.value));
  input.addEventListener('input',()=>{ render(input.value); });
  list.addEventListener('mousedown',e=>{
    const opt=e.target.closest('.combo-opt'); if(!opt) return;
    e.preventDefault();
    const code=opt.dataset.v;
    const name=(VENDOR_LIST.find(v=>v[0]===code)||[])[1]||'';
    state.vendor=code;
    input.value=strip0(code)+' \u2013 '+name;
    list.classList.remove('open');
    state.vPage=1; state.dPage=1; refresh();
  });
  document.addEventListener('click',e=>{
    if(!e.target.closest('.combo')) list.classList.remove('open');
  });
}
function resetVendorCombo(){
  const input=document.getElementById('f-vendor');
  if(input) input.value='';
  state.vendor='';
}
function bindNav(){
  document.querySelectorAll('#nav .tab').forEach(tab=>{
    tab.addEventListener('click',()=>{
      document.querySelectorAll('#nav .tab').forEach(t=>t.classList.remove('active'));
      tab.classList.add('active');
      const page=tab.dataset.page;
      document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
      const el=document.getElementById('page-'+page);
      if(el) el.classList.add('active');
    });
  });
}
function bindTables(){
  const wire=(sel, sortKey, sortDir)=>{
    document.querySelector(sel).addEventListener('click',e=>{
      const th=e.target.closest('th'); if(!th) return; const k=th.dataset.k; if(!k) return;
      if(state[sortKey]===k) state[sortDir]*=-1; else {state[sortKey]=k; state[sortDir]=-1;}
      state.vPage=1; state.dPage=1; refresh();
    });
  };
  wire('#vendor-table thead','vSortKey','vSortDir');
  wire('#detail-table thead','dSortKey','dSortDir');
  document.getElementById('f-topn').onchange=e=>{ state.topN=parseInt(e.target.value,10); state.vPage=1; refresh(); };
  document.getElementById('v-page-size').onchange=e=>{ state.vPageSize=parseInt(e.target.value,10); state.vPage=1; refresh(); };
  document.getElementById('v-prev').onclick=()=>{ if(state.vPage>1){state.vPage--; refresh();} };
  document.getElementById('v-next').onclick=()=>{ state.vPage++; refresh(); };
  document.getElementById('d-page-size').onchange=e=>{ state.dPageSize=parseInt(e.target.value,10); state.dPage=1; refresh(); };
  document.getElementById('d-prev').onclick=()=>{ if(state.dPage>1){state.dPage--; refresh();} };
  document.getElementById('d-next').onclick=()=>{ state.dPage++; refresh(); };
  document.getElementById('export-vendor-csv').onclick=()=>exportVendorCsv(filteredItems());
  document.getElementById('export-detail-csv').onclick=()=>exportDetailCsv(filteredItems());
}

/* ---------- boot ---------- */
function boot(){
  if(window.__AP__ && window.__AP__.items){
    DATA=window.__AP__;
  } else {
    const ld=document.getElementById('loading'); if(ld) ld.innerHTML='Failed to load data.';
    return;
  }
  document.getElementById('meta-time').textContent='Data refreshed: '+(DATA.meta.generated_at||'…');
    initTheme();
    document.getElementById('theme-toggle').onclick=()=>{ applyTheme(CURRENT_THEME==='light'?'dark':'light'); refresh(); };
    initFilters();
  bindFilters();
  bindNav();
  bindTables();
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
