const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["./index-Dvb9pIT1.css","./base-DIn17Gf-.css","./app-Ib-FxDsb.css"])))=>i.map(i=>d[i]);
import{k as r,i as v,S as u,_ as m,v as s,E as h,J as w,I as k,O as f,N as _,T as S}from"./netRetry-CH-q56_p.js";function x(e){return e.deleted?"[deleted]":e.type==="poll"?`[poll] ${e.poll?.q||""}`:e.type==="image"?`[photo] ${e.file?.name||""}`:e.type==="video"?`[video] ${e.file?.name||""}`:e.type==="videoNote"?"[video note]":e.type==="album"?`[album] ${(e.album||[]).length}`:e.type==="file"?`[file] ${e.file?.name||""}`:e.type==="voice"?`[voice] ${S(e.voice?.dur||0)}`:String(e.text||"")}function y(e){return e.sender==="u_me"?r.me?.name||"me":_(e.sender).name}async function D(){const e=[...r.chats||[]],t=[];for(const a of e){let i=[];if(r.active===a.id&&r.messages[a.id]?.length)i=r.messages[a.id];else try{i=await v.messagesOf(a.id)}catch{i=[]}if(u.url&&u.anonKey)try{const{loadMessagesPage:o}=await m(async()=>{const{loadMessagesPage:d}=await import("./richText-BlI_xq5-.js").then(l=>l.$);return{loadMessagesPage:d}},[],import.meta.url),{oldestTs:n}=await m(async()=>{const{oldestTs:d}=await import("./app-ozgUQ-3g.js").then(l=>l.E);return{oldestTs:d}},__vite__mapDeps([0,1,2]),import.meta.url),p=[];let c=0;for(let d=0;d<60;d++){const{messages:l,hasMore:$}=await o(a.id,a.kind,a.publicKey,c?{before:c}:{});if(l.length&&p.unshift(...l),!$||(c=n(l),!c))break}p.length&&(i=p)}catch{}t.push({chat:a,messages:(i||[]).filter(o=>!o.hidden&&!o.localDeleted).sort((o,n)=>(o.ts||0)-(n.ts||0))})}return t}function g(e,t,a){const i=new Blob([t],{type:a}),o=URL.createObjectURL(i),n=document.createElement("a");n.href=o,n.download=e,document.body.appendChild(n),n.click(),n.remove(),setTimeout(()=>URL.revokeObjectURL(o),5e3)}function b(){const e=new Date,t=a=>String(a).padStart(2,"0");return`${e.getFullYear()}-${t(e.getMonth()+1)}-${t(e.getDate())}-${t(e.getHours())}${t(e.getMinutes())}`}function O(e){return JSON.stringify({app:"Relik",exportedAt:new Date().toISOString(),me:r.me?{id:r.me.id,name:r.me.name}:null,chats:e.map(({chat:t,messages:a})=>({id:t.id,kind:t.kind,title:h(t),messages:a.map(i=>({at:new Date(i.ts).toISOString(),from:y(i),type:i.type||"text",text:x(i),edited:!!i.edited,file:i.file?{name:i.file.name||"",size:i.file.size||0}:void 0}))}))},null,2)}function R(e){const t=f==="ru"?{title:"Экспорт Relik",nobody:"Нет сообщений",edited:"изменено"}:{title:"Relik export",nobody:"No messages",edited:"edited"},a=e.map(({chat:i,messages:o})=>`
    <section>
      <h2>${s(h(i))}</h2>
      ${o.length?o.map(n=>`
        <div class="m${n.sender==="u_me"?" me":""}">
          <div class="meta"><b>${s(y(n))}</b> · ${s(w(n.ts))} ${s(k(n.ts))}${n.edited?` · ${t.edited}`:""}</div>
          <div class="text">${s(x(n))}</div>
        </div>`).join(""):`<p class="empty">${t.nobody}</p>`}
    </section>`).join("");return`<!DOCTYPE html><html lang="${f}"><head><meta charset="utf-8">
<title>${s(t.title)}</title>
<style>
  body{margin:0;padding:24px;background:#0b0e14;color:#e8eaf2;font:15px/1.5 Inter,system-ui,sans-serif}
  main{max-width:860px;margin:0 auto}
  h1{font-size:22px;margin:0 0 6px}.sub{color:#9aa3b5;font-size:12px;margin-bottom:24px}
  section{margin:0 0 28px}h2{font-size:16px;border-bottom:1px solid #20262f;padding-bottom:8px;margin:0 0 12px}
  .m{padding:8px 12px;margin:6px 0;border-radius:12px;background:#151a23;border:1px solid #232b39;max-width:80%}
  .m.me{margin-left:auto;background:#20273d;border-color:#2c3550}
  .meta{font-size:11px;color:#8892a6;margin-bottom:3px}.text{white-space:pre-wrap;word-break:break-word}
  .empty{color:#6c7590;font-size:13px}
</style></head><body><main>
<h1>${s(t.title)}</h1>
<div class="sub">${s(new Date().toLocaleString())} · Relik</div>
${a}
</main></body></html>`}async function E(e="json"){const t=await D();return e==="html"?g(`relik-export-${b()}.html`,R(t),"text/html;charset=utf-8"):g(`relik-export-${b()}.json`,O(t),"application/json;charset=utf-8"),t.reduce((a,i)=>a+i.messages.length,0)}export{E as e};
