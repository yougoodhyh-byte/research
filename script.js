(() => {
"use strict";

const cfg = window.RESEARCH_CONFIG || {};
const isConfigured = cfg.supabaseUrl && cfg.supabasePublishableKey &&
  !cfg.supabaseUrl.includes("PASTE_") && !cfg.supabasePublishableKey.includes("PASTE_");
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const BUCKET = "research-files";
const PAPER_STATUSES = {
  submitted:"已投稿", review:"外审中", revision:"返修中",
  accepted:"已录用", published:"已发表", rejected:"拒稿", withdrawn:"撤稿"
};
const ACTIVE = ["submitted","review","revision"];
const todayISO = () => new Date().toISOString().slice(0,10);
const DAY = 86400000;
const daysSince = d => d ? Math.max(0, Math.floor((startToday() - new Date(d+"T00:00:00"))/DAY)) : null;
const daysRemaining = d => d ? Math.ceil((new Date(d+"T00:00:00") - startToday())/DAY) : null;
const startToday = () => { const d=new Date(); d.setHours(0,0,0,0); return d; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const fmtDate = d => d ? new Date(d+"T00:00:00").toLocaleDateString("zh-CN") : "—";
const fmtSize = n => n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n/1024).toFixed(1)} KB` : `${(n/1048576).toFixed(1)} MB`;
const STORAGE_FREE_LIMIT = 1024*1024*1024;
function fmtStorageSize(n){
  n=Number(n)||0;
  if(n<1024) return n+" B";
  if(n<1024*1024) return (n/1024).toFixed(n<10*1024?1:0)+" KB";
  if(n<1024*1024*1024) return (n/(1024*1024)).toFixed(n<10*1024*1024?1:0)+" MB";
  return (n/(1024*1024*1024)).toFixed(2)+" GB";
}
let sb = null, user = null;
let papers=[], services=[], files=[], aiNote="", notifications=[];
let realtimeChannel=null, saveTimer=null, monitorReady=false;
let sortState = {
  submitted:{key:"event_date",dir:"desc"},
  review:{key:"event_date",dir:"desc"},
  revision:{key:"deadline",dir:"asc"},
  reviewService:{key:"end_date",dir:"asc"}
};
let replaceContext=null;
let archiveTab="papers";
let pendingServiceFiles=[];
const OFFLINE_DRAFT_PREFIX="research_offline_draft_v1:";
const CLOUD_CACHE_PREFIX="research_cloud_cache_v1:";
let draftPromptDismissed=false;
let syncingOfflineDraft=false;
let navCloseTimer=null;
let aiFormatPainter=null;
let aiTocUpdating=false;
let aiSelectionRange=null;


function draftKey(){
  return OFFLINE_DRAFT_PREFIX+(user?.id||"guest");
}
function cloudCacheKey(){
  return CLOUD_CACHE_PREFIX+(user?.id||"guest");
}
function readOfflineDraft(){
  try{
    const raw=localStorage.getItem(draftKey());
    if(!raw) return {version:1,created_at:null,updated_at:null,operations:[]};
    const parsed=JSON.parse(raw);
    if(!parsed||!Array.isArray(parsed.operations)) throw new Error("bad draft");
    return parsed;
  }catch{
    return {version:1,created_at:null,updated_at:null,operations:[]};
  }
}
function writeOfflineDraft(draft){
  if(!draft.operations.length){
    localStorage.removeItem(draftKey());
    return;
  }
  localStorage.setItem(draftKey(),JSON.stringify(draft));
}
function hasOfflineDraft(){
  return readOfflineDraft().operations.length>0;
}
function isNetworkError(error){
  const msg=String(error?.message||error||"").toLowerCase();
  return !navigator.onLine || /failed to fetch|network|load failed|fetch failed|timeout|connection|offline/.test(msg);
}
function cacheCloudState(){
  if(!user) return;
  try{
    localStorage.setItem(cloudCacheKey(),JSON.stringify({
      saved_at:new Date().toISOString(),
      papers,services,files,aiNote
    }));
  }catch(error){
    console.warn("cloud cache failed",error);
  }
}
function loadCloudCache(){
  try{
    const raw=localStorage.getItem(cloudCacheKey());
    if(!raw) return false;
    const cached=JSON.parse(raw);
    papers=Array.isArray(cached.papers)?cached.papers:[];
    services=Array.isArray(cached.services)?cached.services:[];
    files=Array.isArray(cached.files)?cached.files:[];
    aiNote=typeof cached.aiNote==="string"?cached.aiNote:"";
    notifications=[];
    monitorReady=false;
    if(document.activeElement!==$("#aiEditor")){
      $("#aiEditor").innerHTML=aiNote;
      ensureAiToc();
      ensureAiEditableTail();
    }
    return true;
  }catch(error){
    console.warn("cloud cache read failed",error);
    return false;
  }
}
function draftDescription(entity,action,payload,label=""){
  if(entity==="paper"){
    const name=payload?.title||label||"未命名稿件";
    if(action==="create") return "新增稿件："+name;
    if(action==="delete") return "删除稿件："+name;
    return "修改稿件："+name;
  }
  if(entity==="service"){
    const name=payload?.title||label||"未命名外审服务";
    if(action==="create") return "新增外审服务："+name;
    if(action==="delete") return "删除外审服务："+name;
    return "修改外审服务："+name;
  }
  if(entity==="ai") return "更新“投稿模板 → AI辅助”内容";
  return label||"网站内容修改";
}
function coalesceDraftOperation(draft,op){
  if(op.entity==="ai"){
    draft.operations=draft.operations.filter(x=>x.entity!=="ai");
    draft.operations.push(op);
    return;
  }
  const same=draft.operations.filter(x=>x.entity===op.entity&&x.id===op.id);
  if(op.action==="delete"){
    draft.operations=draft.operations.filter(x=>!(x.entity===op.entity&&x.id===op.id));
    draft.operations.push(op);
    return;
  }
  const create=same.find(x=>x.action==="create");
  if(create){
    create.payload={...create.payload,...op.payload};
    create.description=draftDescription(op.entity,"create",create.payload);
    create.timestamp=op.timestamp;
    return;
  }
  const update=[...same].reverse().find(x=>x.action==="update");
  if(update&&op.action==="update"){
    update.payload={...update.payload,...op.payload};
    update.description=op.description;
    update.timestamp=op.timestamp;
    return;
  }
  draft.operations.push(op);
}
function applyDraftOperation(op){
  if(op.entity==="paper"){
    if(op.action==="delete"){
      papers=papers.filter(x=>x.id!==op.id);
    }else{
      const row={...op.payload,id:op.id};
      const i=papers.findIndex(x=>x.id===op.id);
      if(i>=0) papers[i]={...papers[i],...row}; else papers.unshift(row);
    }
  }else if(op.entity==="service"){
    if(op.action==="delete"){
      services=services.filter(x=>x.id!==op.id);
    }else{
      const row={...op.payload,id:op.id};
      const i=services.findIndex(x=>x.id===op.id);
      if(i>=0) services[i]={...services[i],...row}; else services.unshift(row);
    }
  }else if(op.entity==="ai"){
    aiNote=op.payload?.content_html||"";
    if(document.activeElement!==$("#aiEditor")){
      $("#aiEditor").innerHTML=aiNote;
      ensureAiToc();
      ensureAiEditableTail();
    }
  }
}
function applyOfflineDraftOverlay(){
  const draft=readOfflineDraft();
  draft.operations.forEach(applyDraftOperation);
}
function queueOfflineDraft({entity,action,id,payload={},description=""}){
  const now=new Date().toISOString();
  const draft=readOfflineDraft();
  if(!draft.created_at) draft.created_at=now;
  draft.updated_at=now;
  const op={
    key:crypto.randomUUID(),
    entity,action,id,
    payload,
    description:description||draftDescription(entity,action,payload),
    timestamp:now
  };
  coalesceDraftOperation(draft,op);
  writeOfflineDraft(draft);
  applyDraftOperation(op);
  draftPromptDismissed=false;
  renderAll();
  renderOfflineState();
}
function renderOfflineState(){
  const offline=!navigator.onLine;
  $("#connectionStatus")?.classList.toggle("hidden",!offline);

  const draft=readOfflineDraft();
  const has=draft.operations.length>0;
  const banner=$("#offlineDraftBanner");
  const canPrompt=has&&!draftPromptDismissed;
  if(banner) banner.classList.toggle("hidden",!canPrompt);

  if(has){
    const meta=$("#offlineDraftMeta");
    if(meta){
      const when=draft.updated_at?new Date(draft.updated_at).toLocaleString("zh-CN"):"";
      meta.textContent="共 "+draft.operations.length+" 项修改"+(when?" · 最近保存 "+when:"");
    }
    const list=$("#offlineDraftList");
    if(list) list.innerHTML=draft.operations.map(op=>"<li>"+esc(op.description)+"</li>").join("");
  }

  const badge=$("#syncBadge");
  if(badge){
    if(offline){
      badge.textContent=has?"离线 · 草稿已保存":"离线";
      badge.classList.add("offline");
    }else if(has){
      badge.textContent="草稿待同步";
      badge.classList.add("draft");
      badge.classList.remove("offline");
    }else{
      badge.textContent="云端同步";
      badge.classList.remove("offline","draft");
    }
  }
  const syncBtn=$("#syncOfflineDraftBtn");
  if(syncBtn) syncBtn.disabled=offline||syncingOfflineDraft;
}
async function runDraftOperation(op){
  if(op.entity==="paper"){
    if(op.action==="create"){
      const row={...op.payload,id:op.id};
      const {error}=await sb.from("papers").insert(row);
      if(error) throw error;
    }else if(op.action==="update"){
      const {error}=await sb.from("papers").update(op.payload).eq("id",op.id);
      if(error) throw error;
    }else if(op.action==="delete"){
      const {error}=await sb.from("papers").delete().eq("id",op.id);
      if(error) throw error;
    }
    return;
  }
  if(op.entity==="service"){
    if(op.action==="create"){
      const row={...op.payload,id:op.id};
      const {error}=await sb.from("review_services").insert(row);
      if(error) throw error;
    }else if(op.action==="update"){
      const {error}=await sb.from("review_services").update(op.payload).eq("id",op.id);
      if(error) throw error;
    }else if(op.action==="delete"){
      const {data:linked,error:readErr}=await sb.from("research_files").select("id,storage_path").eq("review_service_id",op.id).eq("kind","review_manuscript");
      if(readErr) throw readErr;
      const paths=(linked||[]).map(x=>x.storage_path).filter(Boolean);
      if(paths.length){
        const {error}=await sb.storage.from(BUCKET).remove(paths);
        if(error) throw error;
      }
      const {error:fileErr}=await sb.from("research_files").delete().eq("review_service_id",op.id).eq("kind","review_manuscript");
      if(fileErr) throw fileErr;
      const {error}=await sb.from("review_services").delete().eq("id",op.id);
      if(error) throw error;
    }
    return;
  }
  if(op.entity==="ai"){
    const {error}=await sb.from("ai_notes").upsert({
      owner_id:user.id,
      content_html:op.payload?.content_html||"",
      updated_at:op.payload?.updated_at||new Date().toISOString()
    },{onConflict:"owner_id"});
    if(error) throw error;
  }
}
async function syncOfflineDraft(){
  if(!navigator.onLine||syncingOfflineDraft) return;
  const draft=readOfflineDraft();
  if(!draft.operations.length) return;
  syncingOfflineDraft=true;
  renderOfflineState();
  try{
    for(const op of draft.operations) await runDraftOperation(op);
    localStorage.removeItem(draftKey());
    draftPromptDismissed=false;
    alert("离线草稿已同步到云端。");
    await refreshAll();
    subscribeRealtime();
  }catch(error){
    console.error(error);
    alert("草稿同步未完成："+(error?.message||String(error))+"。草稿仍保留在本机，可稍后重试。");
  }finally{
    syncingOfflineDraft=false;
    renderOfflineState();
  }
}
async function discardOfflineDraft(){
  const draft=readOfflineDraft();
  if(!draft.operations.length) return;
  if(!confirm("确认放弃这 "+draft.operations.length+" 项离线草稿吗？放弃后将恢复为最近一次云端/缓存内容。")) return;
  localStorage.removeItem(draftKey());
  draftPromptDismissed=false;
  if(navigator.onLine) await refreshAll();
  else { loadCloudCache(); renderAll(); renderOfflineState(); }
  if(navigator.onLine) subscribeRealtime();
}

function formatHeaderDate(date=new Date()){
  return date.getFullYear()+"年"+(date.getMonth()+1)+"月"+date.getDate()+"日";
}
function renderHeaderDate(){
  const el=$("#headerDate");
  if(el) el.textContent=formatHeaderDate(new Date());
}
function scheduleHeaderDateRefresh(){
  renderHeaderDate();
  const now=new Date();
  const next=new Date(now);
  next.setHours(24,0,1,0);
  setTimeout(()=>{
    renderHeaderDate();
    setInterval(renderHeaderDate,60*60*1000);
  },Math.max(1000,next-now));
}

function showSetup(){
  const b=$("#setupBanner");
  b.classList.remove("hidden");
  b.innerHTML='尚未配置云端同步。请先按压缩包中的 <code>README.md</code> 创建 Supabase 项目，并把 Project URL 和 Publishable key 填入 <code>config.js</code>。';
  $("#authModal").classList.add("hidden");
}
const VIEW_LABELS={
  home:"首页",
  submitted:"已投稿",
  review:"外审中",
  revision:"返修中",
  reviewService:"外审服务",
  templates:"投稿模板",
  archive:"归档管理"
};
function openSideNav(){
  document.body.classList.add("nav-open");
  $("#sideNav")?.classList.add("open");
  $("#navBackdrop")?.classList.add("show");
  $("#menuToggle")?.setAttribute("aria-expanded","true");
}
function closeSideNav(){
  if(navCloseTimer){ clearTimeout(navCloseTimer); navCloseTimer=null; }
  document.body.classList.remove("nav-open");
  $("#sideNav")?.classList.remove("open");
  $("#navBackdrop")?.classList.remove("show");
  $("#menuToggle")?.setAttribute("aria-expanded","false");
}
function isRealMouseEvent(e){
  if(e?.pointerType) return e.pointerType==="mouse";
  if(e?.sourceCapabilities?.firesTouchEvents) return false;
  return true;
}
function cancelNavClose(){
  if(navCloseTimer){ clearTimeout(navCloseTimer); navCloseTimer=null; }
}
function scheduleNavClose(delay=220){
  cancelNavClose();
  navCloseTimer=setTimeout(()=>{
    const side=$("#sideNav");
    const toggle=$("#menuToggle");
    const zone=$("#navHoverZone");
    if(side?.matches(":hover")||toggle?.matches(":hover")||zone?.matches(":hover")) return;
    closeSideNav();
  },delay);
}
function showView(id){
  $$(".view").forEach(v=>v.classList.remove("active"));
  $$("#nav button").forEach(b=>b.classList.remove("active"));
  $("#"+id)?.classList.add("active");
  $(`#nav button[data-view="${id}"]`)?.classList.add("active");
  const label=$("#currentSectionLabel");
  if(label) label.textContent=VIEW_LABELS[id]||"科研工作台";
  closeSideNav();
}
function initNav(){
  $$("#nav button").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));
  $$("[data-jump]").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.jump)));
  $$("[data-close]").forEach(b=>b.addEventListener("click",()=>$("#"+b.dataset.close).classList.add("hidden")));
  $("#menuToggle")?.addEventListener("click",()=>{
    const open=$("#sideNav")?.classList.contains("open");
    if(open) closeSideNav(); else openSideNav();
  });
  $("#menuClose")?.addEventListener("click",closeSideNav);
  $("#navBackdrop")?.addEventListener("click",closeSideNav);

  const toggle=$("#menuToggle"), side=$("#sideNav"), zone=$("#navHoverZone");

  // Mouse over the button or the thin left edge opens the drawer immediately.
  [toggle,zone].filter(Boolean).forEach(el=>{
    el.addEventListener("pointerenter",e=>{
      if(!isRealMouseEvent(e)) return;
      cancelNavClose();
      openSideNav();
    });
    el.addEventListener("pointerleave",e=>{
      if(!isRealMouseEvent(e)) return;
      scheduleNavClose();
    });
  });

  // Keep it open while the mouse is inside the drawer; hide after leaving it.
  side?.addEventListener("pointerenter",e=>{
    if(!isRealMouseEvent(e)) return;
    cancelNavClose();
  });
  side?.addEventListener("pointerleave",e=>{
    if(!isRealMouseEvent(e)) return;
    scheduleNavClose(180);
  });

  // Robust fallback: any real mouse movement within 34 px of the left edge opens it.
  document.addEventListener("pointermove",e=>{
    if(!isRealMouseEvent(e)) return;
    if(e.clientX<=34){
      cancelNavClose();
      openSideNav();
    }
  },{passive:true});

  document.addEventListener("keydown",e=>{
    if(e.key==="Escape"){
      closeSideNav();
      disarmFormatPainter();
    }
  });
}
async function init(){
  initNav();
  scheduleHeaderDateRefresh();
  if(!isConfigured){ showSetup(); return; }
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey);
  const {data:{session}} = await sb.auth.getSession();
  if(session){ user=session.user; await enterApp(); } else { $("#authModal").classList.remove("hidden"); }
  sb.auth.onAuthStateChange(async (_event, session)=>{
    if(session?.user && (!user || user.id!==session.user.id)){ user=session.user; await enterApp(); }
    if(!session){ user=null; $("#authModal").classList.remove("hidden"); }
  });
}
async function enterApp(){
  $("#authModal").classList.add("hidden");
  $("#logoutBtn").classList.remove("hidden");
  $("#accountEmail").textContent=user.email||"";
  await refreshAll();
  if(navigator.onLine&&!hasOfflineDraft()) subscribeRealtime();
  showLegacyOffer();
  renderOfflineState();
}
async function refreshAll(){
  if(!navigator.onLine){
    loadCloudCache();
    applyOfflineDraftOverlay();
    renderAll();
    renderOfflineState();
    return;
  }
  await Promise.all([loadPapers(),loadServices(),loadFiles(),loadAiNote(),loadNotifications()]);
  cacheCloudState();
  applyOfflineDraftOverlay();
  renderAll();
  renderOfflineState();
}
async function loadPapers(){
  const {data,error}=await sb.from("papers").select("*").order("created_at",{ascending:false});
  if(error) return toastError(error); papers=data||[];
}
async function loadServices(){
  const {data,error}=await sb.from("review_services").select("*").order("created_at",{ascending:false});
  if(error) return toastError(error); services=data||[];
}
async function loadFiles(){
  const {data,error}=await sb.from("research_files").select("*").order("created_at",{ascending:false});
  if(error) return toastError(error); files=data||[];
}
async function loadAiNote(){
  const {data,error}=await sb.from("ai_notes").select("content_html").maybeSingle();
  if(error) return toastError(error);
  aiNote=data?.content_html||"";
  if(document.activeElement!==$("#aiEditor")){
    $("#aiEditor").innerHTML=aiNote;
    ensureAiToc();
    await resolveAiImages();
  }
}
async function loadNotifications(){
  const {data,error}=await sb.from("review_notifications").select("*").is("dismissed_at",null).order("created_at",{ascending:false});
  if(error){
    monitorReady=false;
    notifications=[];
    return;
  }
  monitorReady=true;
  notifications=data||[];
}
function subscribeRealtime(){
  if(realtimeChannel) sb.removeChannel(realtimeChannel);
  realtimeChannel=sb.channel("research-workbench-sync")
    .on("postgres_changes",{event:"*",schema:"public",table:"papers"},async()=>{await loadPapers();renderAll();})
    .on("postgres_changes",{event:"*",schema:"public",table:"review_services"},async()=>{await loadServices();renderAll();})
    .on("postgres_changes",{event:"*",schema:"public",table:"research_files"},async()=>{await loadFiles();renderAll();})
    .on("postgres_changes",{event:"*",schema:"public",table:"ai_notes"},async()=>{await loadAiNote();})
    .on("postgres_changes",{event:"*",schema:"public",table:"review_notifications"},async()=>{await loadNotifications();renderAlerts();})
    .subscribe();
}
function renderStorageUsage(){
  const wrap=$("#storageUsage");
  const text=$("#storageUsageText");
  const bar=$("#storageUsageBar");
  if(!wrap||!text||!bar) return;

  const total=files.reduce((sum,f)=>sum+(Number(f.file_size)||0),0);
  const remaining=Math.max(0,STORAGE_FREE_LIMIT-total);
  const percent=Math.min(100,(total/STORAGE_FREE_LIMIT)*100);

  text.textContent=fmtStorageSize(total)+" / 1 GB";
  bar.style.width=(percent>0&&percent<0.35?0.35:percent).toFixed(2)+"%";
  wrap.title="云端文件 "+files.length+" 个 · 已使用 "+fmtStorageSize(total)+" · 剩余约 "+fmtStorageSize(remaining);
  wrap.setAttribute("aria-label",wrap.title);
  wrap.classList.toggle("storage-warning",percent>=80);
  wrap.classList.toggle("storage-full",percent>=95);
}
function renderAll(){
  renderStorageUsage();
  renderCounts(); renderAlerts(); renderPapers(); renderServices(); renderReviewTemplates(); renderTemplates(); renderArchive();
}
function renderAlerts(){
  const wrap=$("#reviewAlerts"), list=$("#alertList");
  if(!wrap||!list) return;
  if(!monitorReady||!notifications.length){
    wrap.classList.add("hidden");
    list.innerHTML="";
    return;
  }
  wrap.classList.remove("hidden");
  $("#alertCount").textContent=notifications.length;
  list.innerHTML=notifications.map(n=>{
    const p=papers.find(x=>x.id===n.paper_id);
    const title=n.paper_title||p?.title||"外审稿件";
    const journal=n.journal||p?.journal||"";
    const change=n.old_status&&n.new_status ? esc(n.old_status)+" → "+esc(n.new_status) : esc(n.message||"追踪页面检测到变化");
    const when=new Date(n.created_at).toLocaleString("zh-CN");
    const href=p?.link ? (/^https?:\/\//i.test(p.link)?p.link:"https://"+p.link) : "";
    return "<div class=\"alert-item\"><div class=\"alert-main\"><div class=\"alert-title\">"+esc(title)+(journal?" · "+esc(journal):"")+"</div><div class=\"alert-change\">"+change+"</div><div class=\"alert-time\">"+when+"</div></div><div class=\"actions\">"+(href?"<a class=\"btn link-btn\" href=\""+esc(href)+"\" target=\"_blank\" rel=\"noopener\">打开追踪页</a>":"")+"<button class=\"btn danger\" data-dismiss-alert=\""+n.id+"\" title=\"擦掉提醒\">×</button></div></div>";
  }).join("");
}
function renderCounts(){
  $("#countSubmitted").textContent=papers.filter(p=>p.status==="submitted").length;
  $("#countReview").textContent=papers.filter(p=>p.status==="review").length;
  $("#countRevision").textContent=papers.filter(p=>p.status==="revision").length;
  $("#countService").textContent=services.filter(s=>(s.status||"pending")==="pending").length;
}
function sortRows(arr,state){
  const {key,dir}=state;
  return [...arr].sort((a,b)=>{
    let av,bv;
    if(key==="duration"){
      av=daysSince(a.event_date)??-999999;
      bv=daysSince(b.event_date)??-999999;
    }else if(key==="remaining"){
      av=daysRemaining(a.end_date)??999999;
      bv=daysRemaining(b.end_date)??999999;
    }else if(key==="countdown"){
      av=daysRemaining(a.deadline)??999999;
      bv=daysRemaining(b.deadline)??999999;
    }else{
      av=a[key]?new Date(a[key]+"T00:00:00").getTime():Number.MAX_SAFE_INTEGER;
      bv=b[key]?new Date(b[key]+"T00:00:00").getTime():Number.MAX_SAFE_INTEGER;
    }
    return (av-bv)*(dir==="asc"?1:-1);
  });
}
function toggleSort(group,key){
  const s=sortState[group];
  if(s.key===key){
    s.dir=s.dir==="asc"?"desc":"asc";
  }else{
    s.key=key;
    s.dir=(key==="deadline"||key==="end_date"||key==="remaining"||key==="countdown")?"asc":"desc";
  }
  renderAll();
}
function sortHead(group,key,label){
  const s=sortState[group],mark=s.key===key?(s.dir==="asc"?"▲":"▼"):"↕";
  return `<th class="sortable" data-sort-group="${group}" data-sort-key="${key}">${label} <span>${mark}</span></th>`;
}
function renderPapers(){
  ["submitted","review","revision"].forEach(status=>{
    const el=$("#"+status), list=sortRows(papers.filter(p=>p.status===status),sortState[status]);
    const dateLabel=status==="submitted"?"投稿日期":status==="review"?"外审日期":"返修开始日期";
    const extraHead=status==="revision"
      ? sortHead(status,"deadline","截止日期")+sortHead(status,"countdown","倒计时")
      : sortHead(status,"duration",status==="submitted"?"投稿时长":"外审时长");
    const rows=list.map(p=>{
      const remaining=status==="revision"?remainingHtml(p.deadline):"";
      return `<tr>
        <td>${esc(p.title)}</td><td>${esc(p.journal||"—")}</td><td>${linkHtml(p.link)}</td>
        <td>${fmtDate(p.event_date)}</td>
        ${status==="revision"?`<td>${fmtDate(p.deadline)}</td><td>${remaining}</td>`:`<td>${daysSince(p.event_date)??"—"} 天</td>`}
        <td>${statusSelect(p)}</td>
        <td><div class="actions"><button class="btn" data-edit-paper="${p.id}">编辑</button><button class="btn danger" data-delete-paper="${p.id}">删除</button></div></td>
      </tr>`;
    }).join("");
    el.innerHTML=`<div class="card"><div class="card-head"><h2>${PAPER_STATUSES[status]}</h2><button class="btn primary" data-add-paper="${status}">＋ 新增稿件</button></div>
      <div class="table-wrap"><table><thead><tr><th>标题</th><th>期刊名</th><th>链接</th>${sortHead(status,"event_date",dateLabel)}${extraHead}<th>状态</th><th>操作</th></tr></thead>
      <tbody>${rows||`<tr><td class="empty" colspan="8">暂无记录</td></tr>`}</tbody></table></div></div>`;
  });
}
function remainingHtml(date){
  const n=daysRemaining(date); if(n==null) return `<span>未设置</span>`;
  if(n<0) return `<span class="remaining late">逾期 ${Math.abs(n)} 天</span>`;
  if(n===0) return `<span class="remaining warn">今天截止</span>`;
  if(n<=7) return `<span class="remaining warn">${n} 天</span>`;
  return `<span class="remaining ok">${n} 天</span>`;
}
function statusSelect(p){
  return `<select data-status-paper="${p.id}">${Object.entries(PAPER_STATUSES).map(([v,n])=>`<option value="${v}" ${p.status===v?"selected":""}>${n}</option>`).join("")}</select>`;
}
function linkHtml(url){
  if(!url) return "—"; const u=/^https?:\/\//i.test(url)?url:"https://"+url;
  return `<a class="link" href="${esc(u)}" target="_blank" rel="noopener">访问 ↗</a>`;
}
function storageFolder(f){
  const parts=String(f?.storage_path||"").split("/");
  return parts.length>2?parts[1]:"";
}
function isReviewTemplate(f){
  return f.kind==="template" && storageFolder(f)==="review_template";
}
function serviceFiles(serviceId){
  return files.filter(f=>f.kind==="review_manuscript"&&f.review_service_id===serviceId);
}
function serviceFilesHtml(serviceId,allowAdd=true){
  const list=serviceFiles(serviceId);
  return `<div class="service-file-list">
    ${list.map(f=>fileActions(f)).join("")}
    ${allowAdd?`<label class="service-file-add">＋ 新增文件<input type="file" hidden multiple data-upload-review="${serviceId}"></label>`:""}
  </div>`;
}
function renderServices(){
  const body=$("#serviceBody");
  const list=sortRows(services.filter(s=>(s.status||"pending")==="pending"),sortState.reviewService);
  body.innerHTML=list.map(s=>{
    return `<tr>
      <td>${esc(s.title)}</td><td>${esc(s.journal||"—")}</td><td>${linkHtml(s.link)}</td>
      <td>${serviceFilesHtml(s.id,true)}</td>
      <td>${fmtDate(s.start_date)}</td><td>${fmtDate(s.end_date)}</td><td>${remainingHtml(s.end_date)}</td>
      <td><div class="actions"><button class="btn" data-edit-service="${s.id}">编辑</button><button class="btn danger" data-delete-service="${s.id}">删除</button></div></td>
    </tr>`;
  }).join("")||`<tr><td class="empty" colspan="8">暂无外审服务记录</td></tr>`;
  $$("[data-service-sort]").forEach(th=>{const key=th.dataset.serviceSort;const st=sortState.reviewService;th.querySelector("span").textContent=st.key===key?(st.dir==="asc"?"▲":"▼"):"↕";});
}
function renderHomeServices(){
  const list=sortRows(services, {key:"end_date",dir:"asc"}).slice(0,5);
  $("#homeServiceBody").innerHTML=list.map(s=>`<tr><td>${esc(s.title)}</td><td>${esc(s.journal||"—")}</td><td>${fmtDate(s.end_date)}</td><td>${remainingHtml(s.end_date)}</td></tr>`).join("")
    || `<tr><td colspan="4" class="empty">暂无外审服务记录</td></tr>`;
}
function fileActions(f,compact=false){
  return `<div class="file-control ${compact?"compact":""}" data-file-control>
    <button type="button" class="file-trigger" data-file-menu="${f.id}" aria-expanded="false" title="${esc(f.file_name)}">
      <span class="file-trigger-name">${esc(f.file_name)}</span>
      <span class="file-trigger-more" aria-hidden="true">•••</span>
    </button>
    <div class="file-hover-actions" role="menu">
      <button class="mini-btn" data-preview-file="${f.id}">预览</button>
      <button class="mini-btn" data-download-file="${f.id}">下载</button>
      <button class="mini-btn" data-replace-file="${f.id}">替换</button>
      <button class="mini-btn danger" data-delete-file="${f.id}">删除</button>
    </div>
  </div>`;
}
function renderReviewTemplates(){
  const box=$("#reviewTemplateList");
  if(!box) return;
  const list=files.filter(isReviewTemplate);
  const count=$("#reviewTemplateCount");
  if(count) count.textContent=list.length;
  box.innerHTML=list.map(f=>`
    <div class="review-template-item">
      ${fileActions(f,true)}
    </div>
  `).join("")||`<div class="review-template-empty">暂无审稿模板</div>`;
}
function renderTemplates(){
  $("#templateList").innerHTML=files.filter(f=>f.kind==="template"&&!isReviewTemplate(f)).map(f=>`
    <div class="file-row">
      <div>
        ${fileActions(f)}
        <div class="file-meta">${fmtSize(f.file_size)} · ${new Date(f.created_at).toLocaleString("zh-CN")}</div>
      </div>
    </div>
  `).join("")||`<div class="empty">暂无模板文件</div>`;
}
function renderArchiveTabs(){
  $$("[data-archive-tab]").forEach(b=>b.classList.toggle("active",b.dataset.archiveTab===archiveTab));
  $("#archivePapersPanel")?.classList.toggle("active",archiveTab==="papers");
  $("#archiveServicesPanel")?.classList.toggle("active",archiveTab==="services");
}
function renderArchive(){
  $("#archiveBody").innerHTML=papers.filter(p=>!ACTIVE.includes(p.status)).map(p=>`
    <tr>
      <td>${esc(p.title)}</td>
      <td>${esc(p.journal||"—")}</td>
      <td>${linkHtml(p.link)}</td>
      <td>${PAPER_STATUSES[p.status]}</td>
      <td>${fmtDate(p.event_date)}</td>
      <td><div class="actions"><button class="btn" data-edit-paper="${p.id}">编辑</button><button class="btn danger" data-delete-paper="${p.id}">删除</button></div></td>
    </tr>
  `).join("")||`<tr><td colspan="6" class="empty">暂无归档论文</td></tr>`;

  const archivedServices=services.filter(s=>(s.status||"pending")==="reviewed");
  $("#archiveServiceBody").innerHTML=archivedServices.map(s=>{
    return `<tr>
      <td>${esc(s.title)}</td>
      <td>${esc(s.journal||"—")}</td>
      <td>${linkHtml(s.link)}</td>
      <td>${serviceFilesHtml(s.id,true)}</td>
      <td>${fmtDate(s.start_date)}</td>
      <td>${fmtDate(s.end_date)}</td>
      <td><span class="status-chip reviewed">已审</span></td>
      <td><div class="actions"><button class="btn" data-edit-service="${s.id}">编辑</button><button class="btn danger" data-delete-service="${s.id}">删除</button></div></td>
    </tr>`;
  }).join("")||`<tr><td colspan="8" class="empty">暂无已归档的外审服务论文</td></tr>`;

  renderArchiveTabs();
}
async function login(signup=false){
  const email=$("#authEmail").value.trim(), password=$("#authPassword").value;
  $("#authMsg").textContent="";
  if(!email||!password) return $("#authMsg").textContent="请输入邮箱和密码。";
  const res=signup?await sb.auth.signUp({email,password}):await sb.auth.signInWithPassword({email,password});
  if(res.error) $("#authMsg").textContent=res.error.message;
  else if(signup&&!res.data.session) $("#authMsg").textContent="注册成功，请检查邮箱完成验证后再登录。";
}
function syncPaperModal(){
  const s=$("#paperStatus").value;
  $("#paperDateLabel").textContent=s==="submitted"?"投稿日期":s==="review"?"外审日期":s==="revision"?"返修开始日期":"状态日期";
  $("#paperDeadlineWrap").classList.toggle("hidden",s!=="revision");
  $("#paperMonitorWrap").classList.toggle("hidden",!(s==="review"&&monitorReady));
}
function openPaper(status="submitted",id=null){
  const p=id?papers.find(x=>x.id===id):null;
  $("#paperId").value=p?.id||""; $("#paperTitle").value=p?.title||""; $("#paperJournal").value=p?.journal||""; $("#paperLink").value=p?.link||"";
  $("#paperStatus").value=p?.status||status; $("#paperDate").value=p?.event_date||todayISO(); $("#paperDeadline").value=p?.deadline||"";
  $("#paperMonitor").checked=!!p?.monitor_enabled;
  syncPaperModal(); $("#paperModal").classList.remove("hidden");
}
async function savePaper(){
  const id=$("#paperId").value;
  const existing=id?papers.find(x=>x.id===id):null;
  const row={
    title:$("#paperTitle").value.trim(),
    journal:$("#paperJournal").value.trim(),
    link:$("#paperLink").value.trim(),
    status:$("#paperStatus").value,
    event_date:$("#paperDate").value||todayISO(),
    deadline:$("#paperStatus").value==="revision"?($("#paperDeadline").value||null):null,
    updated_at:new Date().toISOString()
  };
  if(monitorReady) row.monitor_enabled=row.status==="review"&&$("#paperMonitor").checked;
  if(!row.title) return alert("请填写标题。");

  const draftId=id||crypto.randomUUID();
  const localRow={...existing,...row,id:draftId,created_at:existing?.created_at||new Date().toISOString()};
  const action=id?"update":"create";
  if(!navigator.onLine){
    queueOfflineDraft({entity:"paper",action,id:draftId,payload:localRow});
    $("#paperModal").classList.add("hidden");
    return;
  }

  const q=id?sb.from("papers").update(row).eq("id",id):sb.from("papers").insert(row);
  const {error}=await q;
  if(error){
    if(isNetworkError(error)){
      queueOfflineDraft({entity:"paper",action,id:draftId,payload:localRow});
      $("#paperModal").classList.add("hidden");
      return;
    }
    return toastError(error);
  }
  $("#paperModal").classList.add("hidden");
}

function manuscriptExt(name){
  const m=String(name||"").toLowerCase().match(/\.([a-z0-9]+)$/);
  return m?m[1]:"";
}
function manuscriptCodePrefix(name){
  const base=String(name||"").replace(/\.[^.]+$/,"").trim();
  const m=base.match(/^([A-Za-z][A-Za-z0-9]{1,12})-D-/i);
  return m?m[1].toUpperCase():"";
}
function journalFromKnownFiles(file){
  const prefix=manuscriptCodePrefix(file.name);
  if(!prefix) return "";
  for(const existing of files){
    if(existing.kind!=="review_manuscript"||!existing.review_service_id) continue;
    if(manuscriptCodePrefix(existing.file_name)!==prefix) continue;
    const s=services.find(x=>x.id===existing.review_service_id);
    if(s?.journal) return s.journal;
  }
  return "";
}
function cleanDetectedText(s){
  return String(s||"")
    .replace(/[\u0000-\u001f]+/g," ")
    .replace(/\s+/g," ")
    .trim();
}
function usefulPdfTitle(value){
  const s=cleanDetectedText(value);
  if(!s||s.length<8||s.length>350) return "";
  if(/^(untitled|microsoft word|document|manuscript|article)$/i.test(s)) return "";
  return s;
}
function detectKnownJournal(text,file){
  const source=String(text||"").toLowerCase();
  const journals=[...new Set(services.map(s=>String(s.journal||"").trim()).filter(Boolean))]
    .sort((a,b)=>b.length-a.length);
  for(const journal of journals){
    if(source.includes(journal.toLowerCase())) return journal;
  }
  const mapped=journalFromKnownFiles(file);
  if(mapped) return mapped;

  const lines=String(text||"").split(/\r?\n/).map(cleanDetectedText).filter(Boolean);
  const patterns=[
    /^(?:journal(?:\s+name)?|submitted\s+to|submission\s+to|manuscript\s+submitted\s+to)\s*[:：-]\s*(.+)$/i,
    /^(?:elsevier\s+editorial\s+system|editorial\s+manager)(?:\(tm\))?\s+for\s+(.+)$/i,
    /^for\s+the\s+journal\s+(.+)$/i
  ];
  for(const line of lines.slice(0,80)){
    for(const re of patterns){
      const m=line.match(re);
      if(m){
        const value=cleanDetectedText(m[1]).replace(/[|•].*$/,"").trim();
        if(value.length>=4&&value.length<=140) return value;
      }
    }
  }
  return "";
}
function detectTitleFromLines(lines){
  const cleaned=lines.map(cleanDetectedText).filter(Boolean);
  const stop=/^(abstract|keywords?|highlights?|introduction|article\s+info|research\s+article)\b/i;
  const noise=/^(manuscript|page\s+\d+|confidential|reviewer|review copy|author|authors|corresponding author|declaration|cover letter)\b/i;
  const candidates=[];
  for(const line of cleaned.slice(0,35)){
    if(stop.test(line)) break;
    if(noise.test(line)) continue;
    if(/^[A-Z]{2,12}-D-\d+/i.test(line)) continue;
    if(/@|https?:\/\//i.test(line)) continue;
    if(line.length>=18&&line.length<=220) candidates.push(line);
    if(candidates.length>=3) break;
  }
  if(!candidates.length) return "";
  let title=candidates[0];
  if(title.length<95&&candidates[1]&&candidates[1].length<150){
    const combined=title+" "+candidates[1];
    if(combined.length<=260&&!/^(abstract|keywords?)\b/i.test(candidates[1])) title=combined;
  }
  return cleanDetectedText(title);
}
async function extractPdfInfo(file){
  if(!window.pdfjsLib) return {title:"",journal:"",text:""};
  try{
    window.pdfjsLib.GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
    const doc=await window.pdfjsLib.getDocument({data:new Uint8Array(await file.arrayBuffer())}).promise;
    let metaTitle="";
    try{
      const meta=await doc.getMetadata();
      metaTitle=usefulPdfTitle(meta?.info?.Title||meta?.metadata?.get?.("dc:title")||"");
    }catch{}
    const allLines=[];
    const pages=Math.min(doc.numPages,2);
    for(let p=1;p<=pages;p++){
      const page=await doc.getPage(p);
      const tc=await page.getTextContent();
      const rows=[];
      for(const item of tc.items||[]){
        const str=cleanDetectedText(item.str);
        if(!str) continue;
        const y=Math.round((item.transform?.[5]||0)*2)/2;
        let row=rows.find(r=>Math.abs(r.y-y)<=1.5);
        if(!row){row={y,items:[]};rows.push(row);}
        row.items.push({x:item.transform?.[4]||0,str});
      }
      rows.sort((a,b)=>b.y-a.y);
      for(const row of rows){
        row.items.sort((a,b)=>a.x-b.x);
        const line=cleanDetectedText(row.items.map(x=>x.str).join(" "));
        if(line) allLines.push(line);
      }
    }
    const text=allLines.join("\n");
    return {
      title:metaTitle||detectTitleFromLines(allLines),
      journal:detectKnownJournal(text,file),
      text
    };
  }catch(error){
    console.warn("PDF recognition failed",error);
    return {title:"",journal:journalFromKnownFiles(file),text:""};
  }
}
async function extractDocxInfo(file){
  if(!window.mammoth) return {title:"",journal:journalFromKnownFiles(file),text:""};
  try{
    const result=await window.mammoth.extractRawText({arrayBuffer:await file.arrayBuffer()});
    const text=String(result.value||"");
    return {
      title:detectTitleFromLines(text.split(/\r?\n/)),
      journal:detectKnownJournal(text,file),
      text
    };
  }catch(error){
    console.warn("DOCX recognition failed",error);
    return {title:"",journal:journalFromKnownFiles(file),text:""};
  }
}
async function extractManuscriptInfo(file){
  const ext=manuscriptExt(file.name);
  if(ext==="pdf") return extractPdfInfo(file);
  if(ext==="docx") return extractDocxInfo(file);
  if(["txt","md","rtf"].includes(ext)){
    try{
      const text=await file.text();
      return {title:detectTitleFromLines(text.split(/\r?\n/)),journal:detectKnownJournal(text,file),text};
    }catch{}
  }
  const raw=String(file.name||"").replace(/\.[^.]+$/,"").replace(/[_]+/g," ").trim();
  const coded=/^[A-Za-z][A-Za-z0-9]{1,12}-D-\d+/i.test(raw);
  return {title:coded?"":cleanDetectedText(raw),journal:journalFromKnownFiles(file),text:""};
}
function renderServiceModalFiles(serviceId=null){
  const box=$("#serviceModalFiles");
  if(!box) return;
  const existing=serviceId?serviceFiles(serviceId):[];
  const existingHtml=existing.map(f=>`<div class="service-modal-file existing"><span>${esc(f.file_name)}</span><small>已上传</small></div>`).join("");
  const pendingHtml=pendingServiceFiles.map((f,i)=>`<div class="service-modal-file pending"><span>${esc(f.name)}</span><button type="button" data-remove-pending-service-file="${i}" aria-label="移除 ${esc(f.name)}">×</button></div>`).join("");
  box.innerHTML=existingHtml+pendingHtml||'<div class="service-modal-file-empty">尚未添加稿件</div>';
}
async function recognizeServiceManuscript(file){
  const status=$("#serviceManuscriptStatus");
  if(status) status.textContent="正在识别标题和期刊名…";
  const info=await extractManuscriptInfo(file);
  let filled=[];
  if(info.title&&!$("#serviceTitle").value.trim()){
    $("#serviceTitle").value=info.title;
    filled.push("标题");
  }
  if(info.journal&&!$("#serviceJournal").value.trim()){
    $("#serviceJournal").value=info.journal;
    filled.push("期刊名");
  }
  if(status){
    if(filled.length) status.textContent="已自动填充："+filled.join("、")+"。请核对后保存。";
    else if(info.title||info.journal) status.textContent="已读取稿件信息；现有标题或期刊名未被覆盖。";
    else status.textContent="未能可靠识别标题或期刊名，请手动填写。稿件仍可正常上传。";
  }
}

function openService(id=null){
  const s=id?services.find(x=>x.id===id):null;
  pendingServiceFiles=[];
  $("#serviceManuscriptFiles").value="";
  $("#serviceManuscriptStatus").textContent="";
  $("#serviceId").value=s?.id||""; $("#serviceTitle").value=s?.title||""; $("#serviceJournal").value=s?.journal||""; $("#serviceLink").value=s?.link||"";
  $("#serviceStart").value=s?.start_date||todayISO(); $("#serviceEnd").value=s?.end_date||"";
  $("#serviceStatus").value=s?.status||"pending";
  renderServiceModalFiles(s?.id||null);
  $("#serviceModal").classList.remove("hidden");
}
async function saveService(){
  const id=$("#serviceId").value;
  const existing=id?services.find(x=>x.id===id):null;
  const row={
    title:$("#serviceTitle").value.trim(),
    journal:$("#serviceJournal").value.trim(),
    link:$("#serviceLink").value.trim(),
    start_date:$("#serviceStart").value||todayISO(),
    end_date:$("#serviceEnd").value||null,
    status:$("#serviceStatus").value||"pending",
    updated_at:new Date().toISOString()
  };
  if(!row.title) return alert("请填写标题，或先添加稿件尝试自动识别。");

  const draftId=id||crypto.randomUUID();
  const localRow={...existing,...row,id:draftId,created_at:existing?.created_at||new Date().toISOString()};
  const action=id?"update":"create";

  if(!navigator.onLine){
    queueOfflineDraft({entity:"service",action,id:draftId,payload:localRow});
    $("#serviceModal").classList.add("hidden");
    if(pendingServiceFiles.length){
      alert("外审服务文字信息已保存为离线草稿。文件本身需要联网后再上传；当前选择的文件不会写入云端。");
    }
    pendingServiceFiles=[];
    return;
  }

  let serviceId=id;
  try{
    if(id){
      const {error}=await sb.from("review_services").update(row).eq("id",id);
      if(error) throw error;
    }else{
      const {data,error}=await sb.from("review_services").insert(row).select("id").single();
      if(error) throw error;
      serviceId=data.id;
    }
  }catch(error){
    if(isNetworkError(error)){
      queueOfflineDraft({entity:"service",action,id:draftId,payload:localRow});
      $("#serviceModal").classList.add("hidden");
      if(pendingServiceFiles.length){
        alert("网络中断，文字信息已保存为离线草稿。文件需要联网后重新上传。");
      }
      pendingServiceFiles=[];
      return;
    }
    return toastError(error);
  }

  const queued=[...pendingServiceFiles];
  pendingServiceFiles=[];
  for(const file of queued) await uploadFile(file,"review_manuscript",serviceId);
  $("#serviceModal").classList.add("hidden");
  await Promise.all([loadServices(),loadFiles()]);
  cacheCloudState();
  renderAll();
  if(row.status==="reviewed"){
    archiveTab="services";
    showView("archive");
    renderArchiveTabs();
  }
}
async function deletePaper(id){
  const p=papers.find(x=>x.id===id); if(!confirm(`确认删除稿件“${p?.title||""}”吗？删除后无法恢复。`)) return;
  if(!navigator.onLine){
    queueOfflineDraft({entity:"paper",action:"delete",id,payload:{title:p?.title||""},description:"删除稿件："+(p?.title||"未命名稿件")});
    return;
  }
  const {error}=await sb.from("papers").delete().eq("id",id);
  if(error){
    if(isNetworkError(error)) return queueOfflineDraft({entity:"paper",action:"delete",id,payload:{title:p?.title||""},description:"删除稿件："+(p?.title||"未命名稿件")});
    toastError(error);
  }
}
async function deleteService(id){
  const s=services.find(x=>x.id===id); if(!confirm(`确认删除外审服务“${s?.title||""}”吗？其关联的全部稿件文件也会一并删除。`)) return;
  if(!navigator.onLine){
    queueOfflineDraft({entity:"service",action:"delete",id,payload:{title:s?.title||""},description:"删除外审服务："+(s?.title||"未命名外审服务")});
    return;
  }
  const linked=serviceFiles(id);
  if(linked.length){
    const paths=linked.map(f=>f.storage_path).filter(Boolean);
    if(paths.length){
      const {error:stErr}=await sb.storage.from(BUCKET).remove(paths);
      if(stErr){
        if(isNetworkError(stErr)) return queueOfflineDraft({entity:"service",action:"delete",id,payload:{title:s?.title||""},description:"删除外审服务："+(s?.title||"未命名外审服务")});
        return toastError(stErr);
      }
    }
    const {error:fileErr}=await sb.from("research_files").delete().eq("review_service_id",id).eq("kind","review_manuscript");
    if(fileErr) return toastError(fileErr);
  }
  const {error}=await sb.from("review_services").delete().eq("id",id); if(error) toastError(error);
}
function safeExtension(name){
  const parts=String(name||"").split(".");
  if(parts.length<2) return "";
  const ext=(parts.pop()||"").toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,12);
  return ext ? "."+ext : "";
}
async function uploadFile(file,kind,reviewServiceId=null,existing=null,folder=null){
  if(!file) return;
  if(!navigator.onLine){
    alert("当前处于离线状态。文件上传/替换需要联网；文字内容仍可保存为离线草稿。");
    return;
  }
  // Keep database kind compatible with the existing schema, while using
  // a separate Storage folder to distinguish review templates.
  const existingFolder=existing?storageFolder(existing):"";
  const storageFolderName=folder||existingFolder||kind;
  const path=`${user.id}/${storageFolderName}/${crypto.randomUUID()}${safeExtension(file.name)}`;
  const {error:upErr}=await sb.storage.from(BUCKET).upload(path,file,{contentType:file.type||"application/octet-stream",upsert:false});
  if(upErr) return toastError(upErr);
  const meta={kind,review_service_id:reviewServiceId,file_name:file.name,storage_path:path,mime_type:file.type||"",file_size:file.size,updated_at:new Date().toISOString()};
  let err;
  if(existing){
    const res=await sb.from("research_files").update(meta).eq("id",existing.id); err=res.error;
    if(!err) await sb.storage.from(BUCKET).remove([existing.storage_path]);
  } else {
    const res=await sb.from("research_files").insert(meta); err=res.error;
  }
  if(err){ await sb.storage.from(BUCKET).remove([path]); return toastError(err); }
}
async function deleteFileObject(f,ask=true){
  if(ask&&!confirm(`确认删除文件“${f.file_name}”吗？删除后无法恢复。`)) return;
  const {error:stErr}=await sb.storage.from(BUCKET).remove([f.storage_path]); if(stErr) return toastError(stErr);
  const {error}=await sb.from("research_files").delete().eq("id",f.id); if(error) toastError(error);
}
async function signedUrl(f,seconds=3600){
  const {data,error}=await sb.storage.from(BUCKET).createSignedUrl(f.storage_path,seconds);
  if(error){toastError(error);return null;} return data.signedUrl;
}
async function previewFile(f){
  const url=await signedUrl(f); if(!url) return;
  $("#previewTitle").textContent=f.file_name; const ext=(f.file_name.split(".").pop()||"").toLowerCase(), mime=f.mime_type||"";
  const c=$("#previewContent"); c.innerHTML="";
  if(mime.startsWith("image/")) c.innerHTML=`<img src="${esc(url)}" alt="">`;
  else if(mime==="application/pdf"||ext==="pdf") c.innerHTML=`<iframe src="${esc(url)}"></iframe>`;
  else if(mime.startsWith("video/")) c.innerHTML=`<video controls src="${esc(url)}"></video>`;
  else if(mime.startsWith("audio/")) c.innerHTML=`<audio controls src="${esc(url)}"></audio>`;
  else if(mime.startsWith("text/")||["txt","md","csv","json","xml","log","html","css","js"].includes(ext)){
    try{const text=await fetch(url).then(r=>r.text()); c.innerHTML=`<pre class="preview-text">${esc(text.slice(0,1000000))}</pre>`;}catch{previewFallback(c,url,f);}
  } else if(["doc","docx","xls","xlsx","ppt","pptx"].includes(ext)){
    c.innerHTML=`<iframe src="https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(url)}"></iframe>`;
  } else {
    c.innerHTML=`<object data="${esc(url)}" type="${esc(mime)}" style="width:100%;height:65vh"><div class="preview-fallback">此格式无法在当前浏览器内直接渲染。<br><br><a class="btn primary" href="${esc(url)}" target="_blank">在新标签页打开</a></div></object>`;
  }
  $("#previewModal").classList.remove("hidden");
}
function previewFallback(c,url,f){c.innerHTML=`<div class="preview-fallback">浏览器无法直接预览此文件。<br><br><a class="btn primary" href="${esc(url)}" target="_blank">在新标签页打开</a></div>`;}
async function downloadFile(f){
  const {data,error}=await sb.storage.from(BUCKET).download(f.storage_path); if(error) return toastError(error);
  const u=URL.createObjectURL(data), a=document.createElement("a"); a.href=u;a.download=f.file_name;document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(u);
}


function aiEditorEl(){ return $("#aiEditor"); }
function ensureAiEditableTail(){
  const editor=aiEditorEl();
  if(!editor) return null;

  let tail=editor.querySelector(":scope > .ai-editor-tail");
  if(!tail){
    tail=document.createElement("div");
    tail.className="ai-editor-tail";
    tail.innerHTML="<br>";
    editor.appendChild(tail);
  }else if(!tail.innerHTML.trim()){
    tail.innerHTML="<br>";
  }

  // Make the body a real editing host. This is more reliable on mobile Edge/Chrome
  // than relying only on inherited contenteditable from the outer editor.
  tail.setAttribute("contenteditable","true");
  tail.setAttribute("role","textbox");
  tail.setAttribute("aria-label","AI辅助正文输入区域");
  tail.setAttribute("aria-multiline","true");
  tail.setAttribute("inputmode","text");
  tail.setAttribute("enterkeyhint","enter");
  tail.setAttribute("spellcheck","true");
  tail.tabIndex=0;

  // Keep the body at the end, so the large blank area always belongs to it.
  if(editor.lastElementChild!==tail) editor.appendChild(tail);
  return tail;
}
function placeAiCaretAtEnd(){
  const editor=aiEditorEl();
  if(!editor) return;
  const tail=ensureAiEditableTail();
  if(!tail) return;

  try{ tail.focus({preventScroll:true}); }catch{ tail.focus(); }

  const range=document.createRange();
  range.selectNodeContents(tail);
  range.collapse(false);

  const sel=window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}
function aiHasMeaningfulBodyContent(){
  const editor=aiEditorEl();
  if(!editor) return false;
  return [...editor.childNodes].some(node=>{
    if(node.nodeType===Node.ELEMENT_NODE){
      const el=node;
      if(el.classList.contains("ai-toc")||el.classList.contains("ai-editor-tail")) return false;
      if(el.matches(".ai-image-block")) return true;
      return !!el.textContent?.trim();
    }
    return !!node.textContent?.trim();
  });
}
function ensureAiToc(){
  const editor=aiEditorEl();
  if(!editor||aiTocUpdating) return;
  aiTocUpdating=true;
  try{
    let toc=editor.querySelector(":scope > .ai-toc");
    if(!toc){
      toc=document.createElement("div");
      toc.className="ai-toc";
      toc.setAttribute("contenteditable","false");
      editor.insertBefore(toc,editor.firstChild);
    }

    const headings=[...editor.querySelectorAll("h1")].filter(h=>!h.closest(".ai-toc"));
    headings.forEach((heading,index)=>{
      heading.id="ai-heading-"+(index+1);
    });

    const items=headings.length
      ? headings.map((heading,index)=>{
          const title=cleanDetectedText(heading.textContent)||("一级标题 "+(index+1));
          return '<button type="button" class="ai-toc-link" data-ai-toc-target="'+esc(heading.id)+'">'+esc(title)+'</button>';
        }).join("")
      : '<span class="ai-toc-empty">暂无一级标题</span>';

    toc.innerHTML='<div class="ai-toc-title">目录</div><div class="ai-toc-items">'+items+'</div>';
    ensureAiEditableTail();
  } finally {
    aiTocUpdating=false;
  }
}
function setAiHeading1(){
  focusAiEditor();
  document.execCommand("formatBlock",false,"h1");
  ensureAiToc();
  markAiChanged();
}
async function uploadAiPastedImage(file){
  if(!file) return null;
  if(!navigator.onLine){
    alert("当前离线。图片需要联网后才能上传；文字仍会保存为离线草稿。");
    return null;
  }
  const ext=safeExtension(file.name||"pasted-image.png")||".png";
  const path=`${user.id}/ai_image/${crypto.randomUUID()}${ext}`;
  const {error:upErr}=await sb.storage.from(BUCKET).upload(path,file,{
    contentType:file.type||"image/png",
    upsert:false
  });
  if(upErr){ toastError(upErr); return null; }

  const meta={
    kind:"ai_image",
    review_service_id:null,
    file_name:file.name||("粘贴图片-"+Date.now()+ext),
    storage_path:path,
    mime_type:file.type||"image/png",
    file_size:file.size||0,
    updated_at:new Date().toISOString()
  };
  const {data,error}=await sb.from("research_files").insert(meta).select("*").single();
  if(error){
    await sb.storage.from(BUCKET).remove([path]);
    toastError(error);
    return null;
  }
  files.unshift(data);

  const url=await signedUrl(data,60*60*24*7);
  if(!url) return null;
  return {file:data,url};
}
function insertAiImageAtSelection(url,fileId,fileName){
  const editor=aiEditorEl();
  if(!editor) return;
  const sel=window.getSelection();
  let range=null;
  if(sel&&sel.rangeCount&&editor.contains(sel.anchorNode)){
    range=sel.getRangeAt(0);
  }else{
    range=document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
  }

  const wrap=document.createElement("div");
  wrap.className="ai-image-block";
  const img=document.createElement("img");
  img.src=url;
  img.alt=fileName||"粘贴图片";
  img.dataset.aiImageId=fileId;
  img.draggable=false;
  wrap.appendChild(img);

  const spacer=document.createElement("div");
  spacer.innerHTML="<br>";

  range.deleteContents();
  range.insertNode(spacer);
  range.insertNode(wrap);
  range.setStartAfter(spacer);
  range.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(range);

  ensureAiToc();
  markAiChanged();
  renderStorageUsage();
}
async function resolveAiImages(){
  const editor=aiEditorEl();
  if(!editor) return;
  const imgs=[...editor.querySelectorAll("img[data-ai-image-id]")];
  for(const img of imgs){
    const id=img.dataset.aiImageId;
    const file=files.find(f=>f.id===id);
    if(!file) continue;
    const url=await signedUrl(file,60*60*24*7);
    if(url) img.src=url;
  }
}
function sanitizeAiHtmlForSave(){
  const editor=aiEditorEl();
  if(!editor) return "";
  ensureAiToc();
  const clone=editor.cloneNode(true);
  clone.querySelectorAll("img[data-ai-image-id]").forEach(img=>{
    img.removeAttribute("src");
  });
  clone.querySelectorAll(".ai-editor-tail").forEach(tail=>{
    ["contenteditable","role","aria-label","aria-multiline","inputmode","enterkeyhint","spellcheck","tabindex"].forEach(attr=>tail.removeAttribute(attr));
  });
  return clone.innerHTML;
}


function aiSelectionInsideEditor(sel=window.getSelection()){
  const editor=$("#aiEditor");
  if(!editor||!sel||!sel.rangeCount||sel.isCollapsed) return false;
  const range=sel.getRangeAt(0);
  const node=range.commonAncestorContainer;
  return editor.contains(node.nodeType===Node.ELEMENT_NODE?node:node.parentNode);
}
function rememberAiSelection(){
  const sel=window.getSelection();
  if(!aiSelectionInsideEditor(sel)){
    aiSelectionRange=null;
    return false;
  }
  aiSelectionRange=sel.getRangeAt(0).cloneRange();
  return true;
}
function restoreAiSelection(){
  if(!aiSelectionRange) return false;
  const editor=$("#aiEditor");
  const node=aiSelectionRange.commonAncestorContainer;
  if(!editor||!editor.contains(node.nodeType===Node.ELEMENT_NODE?node:node.parentNode)) return false;
  const sel=window.getSelection();
  sel.removeAllRanges();
  sel.addRange(aiSelectionRange);
  return true;
}
function hideAiSelectionToolbar(){
  const bar=$("#aiSelectionToolbar");
  if(!bar) return;
  bar.classList.remove("show");
  bar.setAttribute("aria-hidden","true");
}
function updateAiSelectionToolbar(){
  const bar=$("#aiSelectionToolbar");
  if(!bar) return;
  const sel=window.getSelection();
  if(!aiSelectionInsideEditor(sel)){
    hideAiSelectionToolbar();
    return;
  }

  const range=sel.getRangeAt(0);
  const rects=range.getClientRects();
  const rect=(rects&&rects.length?rects[0]:range.getBoundingClientRect());
  if(!rect||(!rect.width&&!rect.height)){
    hideAiSelectionToolbar();
    return;
  }

  aiSelectionRange=range.cloneRange();
  bar.classList.add("show");
  bar.setAttribute("aria-hidden","false");

  const margin=8, gap=8;
  const barRect=bar.getBoundingClientRect();
  let left=rect.left+(rect.width/2)-(barRect.width/2);
  left=Math.max(margin,Math.min(window.innerWidth-barRect.width-margin,left));

  let top=rect.top-barRect.height-gap;
  const topLimit=(document.querySelector(".topbar")?.getBoundingClientRect().bottom||0)+4;
  if(top<topLimit) top=rect.bottom+gap;
  top=Math.max(margin,Math.min(window.innerHeight-barRect.height-margin,top));

  bar.style.left=Math.round(left)+"px";
  bar.style.top=Math.round(top)+"px";
}
function runAiFloatingAction(action){
  if(!restoreAiSelection()) return;
  switch(action){
    case "bold": aiCommand("bold"); break;
    case "underline": aiCommand("underline"); break;
    case "red": toggleAiRed(); break;
    case "grow": changeAiFontSize(1); break;
    case "shrink": changeAiFontSize(-1); break;
    case "h1": setAiHeading1(); break;
    case "indent": changeAiIndent(2); break;
    case "outdent": changeAiIndent(-2); break;
    case "paint": armFormatPainter(); break;
  }
  if(action!=="paint"){
    rememberAiSelection();
    requestAnimationFrame(updateAiSelectionToolbar);
  }else{
    hideAiSelectionToolbar();
  }
}

function markAiChanged(){
  $("#aiSaveState").textContent=navigator.onLine?"待保存":"离线草稿";
  clearTimeout(saveTimer);
  saveTimer=setTimeout(saveAi,800);
}
function focusAiEditor(){
  $("#aiEditor")?.focus({preventScroll:true});
}
function aiCommand(command,value=null){
  focusAiEditor();
  document.execCommand(command,false,value);
  markAiChanged();
}
function currentAiFontLevel(){
  focusAiEditor();
  const raw=String(document.queryCommandValue("fontSize")||"").trim();
  const n=parseInt(raw,10);
  return Number.isFinite(n)&&n>=1&&n<=7?n:3;
}
function changeAiFontSize(delta){
  const next=Math.max(1,Math.min(7,currentAiFontLevel()+delta));
  aiCommand("fontSize",String(next));
}
function aiColorIsRed(value){
  const s=String(value||"").toLowerCase().replace(/\s/g,"");
  return s==="#d62839"||s==="rgb(214,40,57)"||s==="rgba(214,40,57,1)";
}
function toggleAiRed(){
  focusAiEditor();
  const current=document.queryCommandValue("foreColor");
  aiCommand("foreColor",aiColorIsRed(current)?"#17233a":"#d62839");
}
function selectionElement(){
  const sel=window.getSelection();
  if(!sel||!sel.rangeCount) return null;
  let node=sel.anchorNode;
  if(node?.nodeType===Node.TEXT_NODE) node=node.parentElement;
  return node instanceof Element?node:null;
}
function fontSizeToExecValue(px){
  const n=parseFloat(px)||16;
  if(n<=10) return "1";
  if(n<=13) return "2";
  if(n<=16) return "3";
  if(n<=19) return "4";
  if(n<=24) return "5";
  if(n<=32) return "6";
  return "7";
}
function aiBlockElement(){
  const el=selectionElement();
  if(!el) return null;
  return el.closest("p,div,li,blockquote,h1,h2,h3,h4,h5,h6")||$("#aiEditor");
}
function currentIndentEm(block){
  if(!block||block===$("#aiEditor")) return 0;
  const px=parseFloat(getComputedStyle(block).marginLeft)||0;
  const font=parseFloat(getComputedStyle(block).fontSize)||16;
  return px/font;
}
function changeAiIndent(deltaEm){
  focusAiEditor();
  let block=aiBlockElement();
  if(block===$("#aiEditor")){
    document.execCommand("formatBlock",false,"div");
    block=aiBlockElement();
  }
  if(!block||block===$("#aiEditor")) return;
  const next=Math.max(0,Math.round((currentIndentEm(block)+deltaEm)*10)/10);
  block.style.marginLeft=next?next+"em":"";
  markAiChanged();
}
function captureAiFormat(){
  const el=selectionElement();
  const style=el?getComputedStyle(el):null;
  const block=aiBlockElement();
  return {
    bold:document.queryCommandState("bold"),
    underline:document.queryCommandState("underline"),
    color:document.queryCommandValue("foreColor")||style?.color||"",
    fontSize:style?.fontSize||"16px",
    indentEm:currentIndentEm(block)
  };
}
function applyAiFormat(format){
  if(!format) return;
  focusAiEditor();

  const currentBold=document.queryCommandState("bold");
  if(currentBold!==!!format.bold) document.execCommand("bold",false,null);

  const currentUnderline=document.queryCommandState("underline");
  if(currentUnderline!==!!format.underline) document.execCommand("underline",false,null);

  if(format.color) document.execCommand("foreColor",false,format.color);
  if(format.fontSize) document.execCommand("fontSize",false,fontSizeToExecValue(format.fontSize));

  let block=aiBlockElement();
  if(block===$("#aiEditor")&&Number.isFinite(format.indentEm)&&format.indentEm>0){
    document.execCommand("formatBlock",false,"div");
    block=aiBlockElement();
  }
  if(block&&block!==$("#aiEditor")&&Number.isFinite(format.indentEm)){
    block.style.marginLeft=format.indentEm?format.indentEm+"em":"";
  }

  markAiChanged();
}
function armFormatPainter(){
  const sel=window.getSelection();
  if(!sel||!sel.rangeCount||sel.isCollapsed){
    alert("请先选中一段作为格式来源的文字，再点击格式刷。");
    return;
  }
  aiFormatPainter=captureAiFormat();
  $("#formatPainterBtn")?.classList.add("active");
  $("#formatPainterBtn")?.setAttribute("aria-pressed","true");
  $("#aiSaveState").textContent="格式刷已取样，请选择目标文字";
}
function disarmFormatPainter(){
  aiFormatPainter=null;
  $("#formatPainterBtn")?.classList.remove("active");
  $("#formatPainterBtn")?.setAttribute("aria-pressed","false");
}
function tryApplyFormatPainter(){
  if(!aiFormatPainter) return;
  const sel=window.getSelection();
  if(!sel||!sel.rangeCount||sel.isCollapsed) return;
  const anchor=sel.anchorNode?.nodeType===Node.TEXT_NODE?sel.anchorNode.parentElement:sel.anchorNode;
  if(!(anchor instanceof Element)||!anchor.closest("#aiEditor")) return;
  applyAiFormat(aiFormatPainter);
  disarmFormatPainter();
}

async function saveAi(){
  const content=sanitizeAiHtmlForSave();
  const payload={content_html:content,updated_at:new Date().toISOString()};
  if(!navigator.onLine){
    queueOfflineDraft({entity:"ai",action:"update",id:user?.id||"ai",payload});
    $("#aiSaveState").textContent="离线草稿";
    return;
  }
  $("#aiSaveState").textContent="保存中…";
  const {error}=await sb.from("ai_notes").upsert({owner_id:user.id,...payload},{onConflict:"owner_id"});
  if(error&&isNetworkError(error)){
    queueOfflineDraft({entity:"ai",action:"update",id:user?.id||"ai",payload});
    $("#aiSaveState").textContent="离线草稿";
    return;
  }
  $("#aiSaveState").textContent=error?"保存失败":"已保存"; if(error) toastError(error);
}
function showLegacyOffer(){
  if(localStorage.getItem("rw_cloud_migrated")==="1") return;
  const has=localStorage.getItem("rw2026")||localStorage.getItem("researchWorkbenchV1")||localStorage.getItem("rw_papers")||localStorage.getItem("rw_files")||localStorage.getItem("rw_ai");
  $("#legacyBanner").classList.toggle("hidden",!has);
}
async function importLegacy(){
  if(!confirm("确认把这台设备中的旧版数据导入云端吗？为避免重复，建议只执行一次。")) return;
  try{
    let d=null;
    for(const k of ["rw2026","researchWorkbenchV1"]){const v=localStorage.getItem(k);if(v){d=JSON.parse(v);break;}}
    const oldP=d?.papers||(localStorage.getItem("rw_papers")?JSON.parse(localStorage.getItem("rw_papers")):[]);
    const oldS=d?.services||(localStorage.getItem("rw_services")?JSON.parse(localStorage.getItem("rw_services")):[]);
    if(oldP.length){
      await sb.from("papers").insert(oldP.map(p=>({title:p.title||"未命名",journal:p.journal||"",link:p.link||"",status:p.status||"submitted",event_date:p.event_date||p.date||p.startDate||todayISO(),deadline:p.deadline||null})));
    }
    if(oldS.length){
      await sb.from("review_services").insert(oldS.map(s=>({title:s.title||"未命名",journal:s.journal||"",link:s.link||"",start_date:s.start_date||todayISO(),end_date:s.end_date||s.deadline||null})));
    }
    const oldAi=localStorage.getItem("rw_ai"); if(oldAi) await sb.from("ai_notes").upsert({owner_id:user.id,content_html:oldAi},{onConflict:"owner_id"});
    const oldFiles=localStorage.getItem("rw_files");
    if(oldFiles){
      for(const f of JSON.parse(oldFiles)){
        if(!f.data) continue; const res=await fetch(f.data); const blob=await res.blob(); const file=new File([blob],f.name||"template-file",{type:blob.type});
        await uploadFile(file,"template");
      }
    }
    localStorage.setItem("rw_cloud_migrated","1"); $("#legacyBanner").classList.add("hidden"); alert("旧数据已导入云端。"); await refreshAll();
  }catch(e){console.error(e);alert("导入旧数据时发生错误，请检查控制台或分批导入。");}
}
async function dismissAlert(id){
  if(!monitorReady) return;
  const {error}=await sb.from("review_notifications").update({dismissed_at:new Date().toISOString()}).eq("id",id);
  if(error) return toastError(error);
  notifications=notifications.filter(n=>n.id!==id);
  renderAlerts();
}
function toastError(error){ console.error(error); alert(error?.message||String(error)); }

function isMobileFileUI(){
  return window.matchMedia("(max-width: 820px)").matches
    || window.matchMedia("(hover: none)").matches
    || window.matchMedia("(pointer: coarse)").matches
    || (navigator.maxTouchPoints||0)>0;
}
function closeMobileFileMenus(except=null){
  $$("[data-file-control].mobile-open").forEach(x=>{
    if(x===except) return;
    x.classList.remove("mobile-open");
    x.querySelector("[data-file-menu]")?.setAttribute("aria-expanded","false");
  });
}

document.addEventListener("click",e=>{
  const link=e.target.closest("[data-ai-toc-target]");
  if(!link) return;
  const target=document.getElementById(link.dataset.aiTocTarget);
  if(target) target.scrollIntoView({behavior:"smooth",block:"center"});
});

document.addEventListener("click", async e=>{
  const b=e.target.closest(
    "[data-add-paper],[data-edit-paper],[data-delete-paper]," +
    "[data-edit-service],[data-delete-service]," +
    "[data-preview-file],[data-download-file],[data-replace-file],[data-delete-file]," +
    "[data-sort-group],[data-service-sort],[data-dismiss-alert],[data-archive-tab],[data-file-menu],[data-remove-pending-service-file],[data-review-template-toggle],[data-jump]"
  );
  if(!b) return;

  if(b.dataset.reviewTemplateToggle!==undefined){
    const panel=b.closest(".review-template-panel");
    const mobile=window.matchMedia("(max-width: 820px)").matches;
    if(mobile&&panel){
      e.preventDefault();
      e.stopPropagation();
      const open=!panel.classList.contains("template-open");
      panel.classList.toggle("template-open",open);
      b.setAttribute("aria-expanded",open?"true":"false");
    }
    return;
  }

  if(b.dataset.fileMenu){
    const control=b.closest("[data-file-control]");
    if(isMobileFileUI()){
      e.preventDefault();
      e.stopImmediatePropagation();
      const willOpen=!control.classList.contains("mobile-open");
      closeMobileFileMenus(control);
      control.classList.toggle("mobile-open",willOpen);
      b.setAttribute("aria-expanded",willOpen?"true":"false");
    }
    return;
  }

  if(b.dataset.addPaper) openPaper(b.dataset.addPaper);
  if(b.dataset.editPaper) openPaper(null,b.dataset.editPaper);
  if(b.dataset.deletePaper) await deletePaper(b.dataset.deletePaper);
  if(b.dataset.editService) openService(b.dataset.editService);
  if(b.dataset.deleteService) await deleteService(b.dataset.deleteService);
  if(b.dataset.previewFile){const f=files.find(x=>x.id===b.dataset.previewFile);if(f)await previewFile(f);}
  if(b.dataset.downloadFile){const f=files.find(x=>x.id===b.dataset.downloadFile);if(f)await downloadFile(f);}
  if(b.dataset.replaceFile){replaceContext=files.find(x=>x.id===b.dataset.replaceFile);$("#replaceInput").value="";$("#replaceInput").click();}
  if(b.dataset.deleteFile){const f=files.find(x=>x.id===b.dataset.deleteFile);if(f)await deleteFileObject(f,true);}
  if(b.dataset.sortGroup) toggleSort(b.dataset.sortGroup,b.dataset.sortKey);
  if(b.dataset.serviceSort) toggleSort("reviewService",b.dataset.serviceSort);
  if(b.dataset.dismissAlert) await dismissAlert(b.dataset.dismissAlert);
  if(b.dataset.archiveTab){
    archiveTab=b.dataset.archiveTab;
    renderArchiveTabs();
  }
  if(b.dataset.removePendingServiceFile!==undefined){
    const idx=Number(b.dataset.removePendingServiceFile);
    if(Number.isInteger(idx)&&idx>=0&&idx<pendingServiceFiles.length){
      pendingServiceFiles.splice(idx,1);
      renderServiceModalFiles($("#serviceId").value||null);
    }
  }
  if(isMobileFileUI() && b.closest("[data-file-control]") && !b.dataset.fileMenu){
    closeMobileFileMenus();
  }
});
document.addEventListener("pointerdown",e=>{
  if(isMobileFileUI()&&!e.target.closest("[data-file-control]")) closeMobileFileMenus();

  if(window.matchMedia("(max-width: 820px)").matches){
    const panel=$(".review-template-panel.template-open");
    if(panel&&!e.target.closest(".review-template-panel")){
      panel.classList.remove("template-open");
      panel.querySelector("[data-review-template-toggle]")?.setAttribute("aria-expanded","false");
    }
  }
});
document.addEventListener("change", async e=>{
  if(e.target.matches("[data-status-paper]")){
    const id=e.target.dataset.statusPaper, status=e.target.value, row={status,event_date:todayISO(),deadline:status==="revision"?null:null,updated_at:new Date().toISOString()};
    const p=papers.find(x=>x.id===id);
    if(!navigator.onLine){
      queueOfflineDraft({entity:"paper",action:"update",id,payload:{...p,...row},description:"更新稿件状态："+(p?.title||"未命名稿件")+" → "+(PAPER_STATUSES[status]||status)});
    }else{
      const {error}=await sb.from("papers").update(row).eq("id",id);
      if(error&&isNetworkError(error)) queueOfflineDraft({entity:"paper",action:"update",id,payload:{...p,...row},description:"更新稿件状态："+(p?.title||"未命名稿件")+" → "+(PAPER_STATUSES[status]||status)});
      else if(error) toastError(error);
    }
  }
  if(e.target.matches("[data-upload-review]")){
    const selected=[...(e.target.files||[])];
    for(const file of selected) await uploadFile(file,"review_manuscript",e.target.dataset.uploadReview);
    e.target.value="";
  }
});
$("#addServiceBtn").addEventListener("click",()=>openService());
$("#paperStatus").addEventListener("change",syncPaperModal);
$("#savePaperBtn").addEventListener("click",savePaper);
$("#saveServiceBtn").addEventListener("click",saveService);
$("#loginBtn").addEventListener("click",()=>login(false));
$("#signupBtn").addEventListener("click",()=>login(true));
$("#logoutBtn").addEventListener("click",async()=>{await sb.auth.signOut();location.reload();});
$("#serviceManuscriptFiles").addEventListener("change",async e=>{
  const selected=[...(e.target.files||[])];
  if(!selected.length) return;
  pendingServiceFiles.push(...selected);
  renderServiceModalFiles($("#serviceId").value||null);
  const preferred=selected.find(f=>["pdf","docx","txt","md","rtf"].includes(manuscriptExt(f.name)))||selected[0];
  await recognizeServiceManuscript(preferred);
  e.target.value="";
});
$("#templateUpload").addEventListener("change",async e=>{for(const f of [...e.target.files])await uploadFile(f,"template");e.target.value="";});
$("#reviewTemplateUpload").addEventListener("change",async e=>{
  for(const f of [...e.target.files]) await uploadFile(f,"template",null,null,"review_template");
  e.target.value="";
});
$("#replaceInput").addEventListener("change",async e=>{const f=e.target.files?.[0];if(f&&replaceContext)await uploadFile(f,replaceContext.kind,replaceContext.review_service_id,replaceContext);replaceContext=null;});
$$(".ai-tool").forEach(btn=>btn.addEventListener("mousedown",e=>e.preventDefault()));
$("#boldBtn").addEventListener("click",()=>aiCommand("bold"));
$("#underlineBtn").addEventListener("click",()=>aiCommand("underline"));
$("#heading1Btn").addEventListener("click",setAiHeading1);
$("#redBtn").addEventListener("click",toggleAiRed);
$("#fontGrowBtn").addEventListener("click",()=>changeAiFontSize(1));
$("#fontShrinkBtn").addEventListener("click",()=>changeAiFontSize(-1));
$("#indentBtn").addEventListener("click",()=>changeAiIndent(2));
$("#outdentBtn").addEventListener("click",()=>changeAiIndent(-2));
$("#formatPainterBtn").addEventListener("click",armFormatPainter);

$$("[data-ai-float-action]").forEach(btn=>{
  btn.addEventListener("pointerdown",e=>{
    e.preventDefault();
    e.stopPropagation();
  });
  btn.addEventListener("click",e=>{
    e.preventDefault();
    e.stopPropagation();
    runAiFloatingAction(btn.dataset.aiFloatAction);
  });
});

$("#aiEditor").addEventListener("mouseup",()=>{
  setTimeout(()=>{
    tryApplyFormatPainter();
    if(!aiFormatPainter) updateAiSelectionToolbar();
  },0);
});
$("#aiEditor").addEventListener("touchend",()=>{
  setTimeout(()=>{
    tryApplyFormatPainter();
    if(!aiFormatPainter) updateAiSelectionToolbar();
  },80);
});
function aiTapNeedsCaret(e){
  const editor=$("#aiEditor");
  if(!editor) return false;
  if(e.target===editor) return true;
  const tail=e.target.closest?.(".ai-editor-tail");
  if(!tail) return false;

  // When the starter area is still empty, mobile browsers often fail to create
  // a native caret after the non-editable TOC. Force a caret only in that case.
  const hasText=!!tail.textContent?.replace(/\u200B/g,"").trim();
  const hasRich=!!tail.querySelector("img,video,audio,table");
  return !hasText&&!hasRich;
}
$("#aiEditor").addEventListener("pointerdown",e=>{
  if(aiTapNeedsCaret(e)){
    // Must focus synchronously inside the user gesture so the mobile keyboard opens.
    placeAiCaretAtEnd();
  }
});
$("#aiEditor").addEventListener("touchstart",e=>{
  if(aiTapNeedsCaret(e)){
    placeAiCaretAtEnd();
  }
},{passive:true});
$("#aiEditor").addEventListener("pointerup",e=>{
  if(aiTapNeedsCaret(e)) setTimeout(placeAiCaretAtEnd,0);
});
$("#aiEditor").addEventListener("click",e=>{
  if(aiTapNeedsCaret(e)) placeAiCaretAtEnd();
});
$("#aiEditor").addEventListener("touchend",e=>{
  if(aiTapNeedsCaret(e)) setTimeout(placeAiCaretAtEnd,30);
});
$("#aiEditor").addEventListener("input",()=>{
  ensureAiToc();
  ensureAiEditableTail();
  markAiChanged();
});
$("#aiEditor").addEventListener("paste",async e=>{
  const items=[...(e.clipboardData?.items||[])];
  const imageItems=items.filter(item=>item.type?.startsWith("image/"));
  if(!imageItems.length) return;

  e.preventDefault();
  const sel=window.getSelection();
  const savedRange=sel&&sel.rangeCount?sel.getRangeAt(0).cloneRange():null;

  for(const item of imageItems){
    const blob=item.getAsFile();
    if(!blob) continue;
    const ext=(blob.type.split("/")[1]||"png").replace(/[^a-z0-9]/gi,"")||"png";
    const file=new File([blob],"粘贴图片-"+Date.now()+"."+ext,{type:blob.type});
    const uploaded=await uploadAiPastedImage(file);
    if(!uploaded) continue;

    if(savedRange&&sel){
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    insertAiImageAtSelection(uploaded.url,uploaded.file.id,uploaded.file.file_name);
  }
});
$("#importLegacyBtn").addEventListener("click",importLegacy);
$("#syncOfflineDraftBtn").addEventListener("click",syncOfflineDraft);
$("#keepOfflineDraftBtn").addEventListener("click",()=>{
  draftPromptDismissed=true;
  renderOfflineState();
});
$("#discardOfflineDraftBtn").addEventListener("click",discardOfflineDraft);

window.addEventListener("offline",()=>{
  draftPromptDismissed=false;
  if(realtimeChannel&&sb){ sb.removeChannel(realtimeChannel); realtimeChannel=null; }
  renderOfflineState();
});
window.addEventListener("online",async()=>{
  draftPromptDismissed=false;
  renderOfflineState();
  if(hasOfflineDraft()){
    if(realtimeChannel&&sb){ sb.removeChannel(realtimeChannel); realtimeChannel=null; }
    return;
  }
  await refreshAll();
  subscribeRealtime();
});
window.addEventListener("focus",renderHeaderDate);
document.addEventListener("visibilitychange",()=>{ if(!document.hidden) renderHeaderDate(); });

document.addEventListener("selectionchange",()=>{
  if(aiFormatPainter) return;
  clearTimeout(window.__aiSelectionToolbarTimer);
  window.__aiSelectionToolbarTimer=setTimeout(updateAiSelectionToolbar,35);
});
document.addEventListener("pointerdown",e=>{
  if(e.target.closest("#aiSelectionToolbar")||e.target.closest("#aiEditor")) return;
  hideAiSelectionToolbar();
});
window.addEventListener("scroll",hideAiSelectionToolbar,{passive:true});
window.addEventListener("resize",hideAiSelectionToolbar,{passive:true});

init();
})();