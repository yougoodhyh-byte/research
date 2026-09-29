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
let sb = null, user = null;
let papers=[], services=[], files=[], aiNote="";
let realtimeChannel=null, saveTimer=null;
let sortState = {
  submitted:{key:"event_date",dir:"desc"},
  review:{key:"event_date",dir:"desc"},
  revision:{key:"deadline",dir:"asc"},
  reviewService:{key:"end_date",dir:"asc"}
};
let replaceContext=null;

function showSetup(){
  const b=$("#setupBanner");
  b.classList.remove("hidden");
  b.innerHTML='尚未配置云端同步。请先按压缩包中的 <code>README.md</code> 创建 Supabase 项目，并把 Project URL 和 Publishable key 填入 <code>config.js</code>。';
  $("#authModal").classList.add("hidden");
}
function showView(id){
  $$(".view").forEach(v=>v.classList.remove("active"));
  $$(".nav button").forEach(b=>b.classList.remove("active"));
  $("#"+id)?.classList.add("active");
  $(`.nav button[data-view="${id}"]`)?.classList.add("active");
}
function initNav(){
  $$(".nav button").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.view)));
  $$("[data-jump]").forEach(b=>b.addEventListener("click",()=>showView(b.dataset.jump)));
  $$("[data-close]").forEach(b=>b.addEventListener("click",()=>$("#"+b.dataset.close).classList.add("hidden")));
}
async function init(){
  initNav();
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
  subscribeRealtime();
  showLegacyOffer();
}
async function refreshAll(){
  await Promise.all([loadPapers(),loadServices(),loadFiles(),loadAiNote()]);
  renderAll();
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
  if(document.activeElement!==$("#aiEditor")) $("#aiEditor").innerHTML=aiNote;
}
function subscribeRealtime(){
  if(realtimeChannel) sb.removeChannel(realtimeChannel);
  realtimeChannel=sb.channel("research-workbench-sync")
    .on("postgres_changes",{event:"*",schema:"public",table:"papers"},async()=>{await loadPapers();renderAll();})
    .on("postgres_changes",{event:"*",schema:"public",table:"review_services"},async()=>{await loadServices();renderAll();})
    .on("postgres_changes",{event:"*",schema:"public",table:"research_files"},async()=>{await loadFiles();renderAll();})
    .on("postgres_changes",{event:"*",schema:"public",table:"ai_notes"},async()=>{await loadAiNote();})
    .subscribe();
}
function renderAll(){
  renderCounts(); renderPapers(); renderServices(); renderHomeServices(); renderTemplates(); renderArchive();
}
function renderCounts(){
  $("#countSubmitted").textContent=papers.filter(p=>p.status==="submitted").length;
  $("#countReview").textContent=papers.filter(p=>p.status==="review").length;
  $("#countRevision").textContent=papers.filter(p=>p.status==="revision").length;
  $("#countService").textContent=services.length;
}
function sortRows(arr,state){
  const {key,dir}=state;
  return [...arr].sort((a,b)=>{
    let av,bv;
    if(key==="duration"){ av=daysSince(a.event_date)??-999999; bv=daysSince(b.event_date)??-999999; }
    else if(key==="remaining"){ av=daysRemaining(a.end_date)??999999; bv=daysRemaining(b.end_date)??999999; }
    else { av=a[key]?new Date(a[key]+"T00:00:00").getTime():Number.MAX_SAFE_INTEGER; bv=b[key]?new Date(b[key]+"T00:00:00").getTime():Number.MAX_SAFE_INTEGER; }
    return (av-bv)*(dir==="asc"?1:-1);
  });
}
function toggleSort(group,key){
  const s=sortState[group]; if(s.key===key) s.dir=s.dir==="asc"?"desc":"asc"; else {s.key=key;s.dir=(key==="deadline"||key==="end_date"||key==="remaining")?"asc":"desc";}
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
      ? sortHead(status,"deadline","截止日期")+sortHead(status,"deadline","倒计时")
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
function serviceFile(serviceId){ return files.find(f=>f.kind==="review_manuscript"&&f.review_service_id===serviceId); }
function renderServices(){
  const body=$("#serviceBody");
  const list=sortRows(services,sortState.reviewService);
  body.innerHTML=list.map(s=>{
    const f=serviceFile(s.id);
    return `<tr>
      <td>${esc(s.title)}</td><td>${esc(s.journal||"—")}</td><td>${linkHtml(s.link)}</td>
      <td>${f?fileActions(f):`<label class="btn">上传稿件<input type="file" hidden data-upload-review="${s.id}"></label>`}</td>
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
function fileActions(f){
  return `<div class="actions">
    <button class="btn" data-preview-file="${f.id}">预览</button>
    <button class="btn" data-download-file="${f.id}">下载</button>
    <button class="btn" data-replace-file="${f.id}">替换</button>
    <button class="btn danger" data-delete-file="${f.id}">删除</button>
  </div><div class="file-meta">${esc(f.file_name)}</div>`;
}
function renderTemplates(){
  $("#templateList").innerHTML=files.filter(f=>f.kind==="template").map(f=>`
    <div class="file-row"><div><div class="file-name">${esc(f.file_name)}</div><div class="file-meta">${fmtSize(f.file_size)} · ${new Date(f.created_at).toLocaleString("zh-CN")}</div></div>${fileActions(f)}</div>
  `).join("")||`<div class="empty">暂无模板文件</div>`;
}
function renderArchive(){
  $("#archiveBody").innerHTML=papers.filter(p=>!ACTIVE.includes(p.status)).map(p=>`<tr><td>${esc(p.title)}</td><td>${esc(p.journal||"—")}</td><td>${linkHtml(p.link)}</td><td>${PAPER_STATUSES[p.status]}</td><td>${fmtDate(p.event_date)}</td><td><div class="actions"><button class="btn" data-edit-paper="${p.id}">编辑</button><button class="btn danger" data-delete-paper="${p.id}">删除</button></div></td></tr>`).join("")
    ||`<tr><td colspan="6" class="empty">暂无归档稿件</td></tr>`;
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
}
function openPaper(status="submitted",id=null){
  const p=id?papers.find(x=>x.id===id):null;
  $("#paperId").value=p?.id||""; $("#paperTitle").value=p?.title||""; $("#paperJournal").value=p?.journal||""; $("#paperLink").value=p?.link||"";
  $("#paperStatus").value=p?.status||status; $("#paperDate").value=p?.event_date||todayISO(); $("#paperDeadline").value=p?.deadline||"";
  syncPaperModal(); $("#paperModal").classList.remove("hidden");
}
async function savePaper(){
  const id=$("#paperId").value, row={title:$("#paperTitle").value.trim(),journal:$("#paperJournal").value.trim(),link:$("#paperLink").value.trim(),status:$("#paperStatus").value,event_date:$("#paperDate").value||todayISO(),deadline:$("#paperStatus").value==="revision"?($("#paperDeadline").value||null):null,updated_at:new Date().toISOString()};
  if(!row.title) return alert("请填写标题。");
  const q=id?sb.from("papers").update(row).eq("id",id):sb.from("papers").insert(row);
  const {error}=await q; if(error) return toastError(error); $("#paperModal").classList.add("hidden");
}
function openService(id=null){
  const s=id?services.find(x=>x.id===id):null;
  $("#serviceId").value=s?.id||""; $("#serviceTitle").value=s?.title||""; $("#serviceJournal").value=s?.journal||""; $("#serviceLink").value=s?.link||"";
  $("#serviceStart").value=s?.start_date||todayISO(); $("#serviceEnd").value=s?.end_date||"";
  $("#serviceModal").classList.remove("hidden");
}
async function saveService(){
  const id=$("#serviceId").value, row={title:$("#serviceTitle").value.trim(),journal:$("#serviceJournal").value.trim(),link:$("#serviceLink").value.trim(),start_date:$("#serviceStart").value||todayISO(),end_date:$("#serviceEnd").value||null,updated_at:new Date().toISOString()};
  if(!row.title) return alert("请填写标题。");
  const q=id?sb.from("review_services").update(row).eq("id",id):sb.from("review_services").insert(row);
  const {error}=await q; if(error) return toastError(error); $("#serviceModal").classList.add("hidden");
}
async function deletePaper(id){
  const p=papers.find(x=>x.id===id); if(!confirm(`确认删除稿件“${p?.title||""}”吗？删除后无法恢复。`)) return;
  const {error}=await sb.from("papers").delete().eq("id",id); if(error) toastError(error);
}
async function deleteService(id){
  const s=services.find(x=>x.id===id); if(!confirm(`确认删除外审服务“${s?.title||""}”吗？其关联稿件文件也会一并删除。`)) return;
  const f=serviceFile(id); if(f) await deleteFileObject(f,false);
  const {error}=await sb.from("review_services").delete().eq("id",id); if(error) toastError(error);
}
function safeName(name){return name.replace(/[^\w.\-()\u4e00-\u9fff]+/g,"_").slice(-140)}
async function uploadFile(file,kind,reviewServiceId=null,existing=null){
  if(!file) return;
  const path=`${user.id}/${kind}/${crypto.randomUUID()}-${safeName(file.name)}`;
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
async function saveAi(){
  $("#aiSaveState").textContent="保存中…";
  const content=$("#aiEditor").innerHTML;
  const {error}=await sb.from("ai_notes").upsert({owner_id:user.id,content_html:content,updated_at:new Date().toISOString()},{onConflict:"owner_id"});
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
function toastError(error){ console.error(error); alert(error?.message||String(error)); }

document.addEventListener("click", async e=>{
  const b=e.target.closest("button,[data-jump]"); if(!b) return;
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
});
document.addEventListener("change", async e=>{
  if(e.target.matches("[data-status-paper]")){
    const id=e.target.dataset.statusPaper, status=e.target.value, row={status,event_date:todayISO(),deadline:status==="revision"?null:null,updated_at:new Date().toISOString()};
    const {error}=await sb.from("papers").update(row).eq("id",id); if(error)toastError(error);
  }
  if(e.target.matches("[data-upload-review]")){const file=e.target.files?.[0];if(file)await uploadFile(file,"review_manuscript",e.target.dataset.uploadReview);}
});
$("#addServiceBtn").addEventListener("click",()=>openService());
$("#paperStatus").addEventListener("change",syncPaperModal);
$("#savePaperBtn").addEventListener("click",savePaper);
$("#saveServiceBtn").addEventListener("click",saveService);
$("#loginBtn").addEventListener("click",()=>login(false));
$("#signupBtn").addEventListener("click",()=>login(true));
$("#logoutBtn").addEventListener("click",async()=>{await sb.auth.signOut();location.reload();});
$("#templateUpload").addEventListener("change",async e=>{for(const f of [...e.target.files])await uploadFile(f,"template");e.target.value="";});
$("#replaceInput").addEventListener("change",async e=>{const f=e.target.files?.[0];if(f&&replaceContext)await uploadFile(f,replaceContext.kind,replaceContext.review_service_id,replaceContext);replaceContext=null;});
$("#boldBtn").addEventListener("click",()=>document.execCommand("bold"));
$("#aiEditor").addEventListener("input",()=>{ $("#aiSaveState").textContent="待保存"; clearTimeout(saveTimer); saveTimer=setTimeout(saveAi,800); });
$("#importLegacyBtn").addEventListener("click",importLegacy);
$$("[data-service-sort]").forEach(th=>th.addEventListener("click",()=>{toggleSort("reviewService",th.dataset.serviceSort);}));
init();
})();