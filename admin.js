(function(){
"use strict";
var $=function(i){return document.getElementById(i)};
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}

var cfg=null,state=null,csrf="",dirty=false,idleAt=0,timer=null,IDLE_MS=15*60*1000;
function show(id){["vLogin","vApp"].forEach(function(v){$(v).hidden=v!==id})}
function api(method,url,body){
  var h={"Content-Type":"application/json"};if(csrf)h["X-CSRF-Token"]=csrf;
  return fetch(url,{method:method,credentials:"same-origin",cache:"no-store",headers:h,body:body?JSON.stringify(body):undefined}).then(function(r){
    return r.json().catch(function(){return {}}).then(function(j){
      if(!r.ok){var e=new Error(j.error||("Error "+r.status));e.status=r.status;e.retry=j.retry;throw e}
      return j;
    });
  });
}
function shrink(file,max){
  return new Promise(function(res,rej){
    if(!/^image\//.test(file.type)||file.size>15e6)return rej(new Error("Choose an image under 15 MB"));
    var u=URL.createObjectURL(file),im=new Image();
    im.onload=function(){
      var s=Math.min(1,max/Math.max(im.width,im.height)),c=document.createElement("canvas");
      c.width=Math.round(im.width*s);c.height=Math.round(im.height*s);
      c.getContext("2d").drawImage(im,0,0,c.width,c.height);URL.revokeObjectURL(u);res(c.toDataURL("image/jpeg",.82));
    };
    im.onerror=function(){URL.revokeObjectURL(u);rej(new Error("Could not read image"))};
    im.src=u;
  });
}

function start(me){
  cfg={user:me.user};csrf=me.csrf;
  return api("GET","/api/content").then(function(d){
    state={brands:d.brands||[],gallery:d.gallery||[]};
    show("vApp");idleAt=Date.now()+IDLE_MS;renderAll();
    clearInterval(timer);
    timer=setInterval(function(){
      var left=idleAt-Date.now();
      if(left<=0){logout("Logged out after 15 minutes of inactivity.");return}
      var s=Math.ceil(left/1000);$("idle").textContent="auto-logout "+Math.floor(s/60)+":"+("0"+s%60).slice(-2);
    },1000);
  });
}
function logout(note,skip){
  clearInterval(timer);if(!skip&&cfg)api("POST","/api/logout").catch(function(){});
  cfg=null;state=null;csrf="";dirty=false;
  $("tWorks").innerHTML=$("tBrands").innerHTML=$("tSettings").innerHTML="";
  $("lbtn").disabled=false;show("vLogin");$("lmsg").className="msg";$("lmsg").textContent=note||"";$("lpw").value="";$("lus").focus();
}
function expired(er){if(er.status===401){logout("Session expired. Please log in again.",true);return true}return false}
$("fLogin").addEventListener("submit",function(e){
  e.preventDefault();
  var b=$("lbtn"),m=$("lmsg");b.disabled=true;m.className="msg";m.textContent="Checking...";
  api("POST","/api/login",{username:$("lus").value,password:$("lpw").value}).then(function(me){
    $("lpw").value="";m.textContent="";return start(me);
  }).catch(function(er){
    $("lpw").value="";b.disabled=false;m.className="msg bad";
    m.textContent=er.retry?"Too many attempts. Try again in "+(er.retry>90?Math.ceil(er.retry/60)+" min":er.retry+"s")+".":er.message;
  });
});
$("logout").addEventListener("click",function(){logout("Logged out.")});
["click","keydown","input","pointerdown"].forEach(function(ev){document.addEventListener(ev,function(){if(cfg)idleAt=Date.now()+IDLE_MS},true)});
window.addEventListener("beforeunload",function(e){if(dirty){e.preventDefault();e.returnValue=""}});

/* ---------- state paths ---------- */
function getP(path){return path.split(".").reduce(function(o,k){return o==null?o:o[k]},state)}
function setP(path,v){var p=path.split("."),l=p.pop(),o=p.reduce(function(o,k){return o[k]},state);o[l]=v}
function newId(n){return (String(n||"brand").toLowerCase().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"")||"brand")+"-"+Math.random().toString(36).slice(2,6)}

/* ---------- rendering ---------- */
function fld(path,label,type,val){
  var v=esc(val==null?"":val),id="f"+Math.random().toString(36).slice(2,8);
  if(type==="area")return '<div><label for="'+id+'">'+label+'</label><textarea id="'+id+'" data-k="'+path+'">'+v+'</textarea></div>';
  return '<div><label for="'+id+'">'+label+'</label><input id="'+id+'" data-k="'+path+'" type="'+(type||"text")+'" value="'+v+'"></div>';
}
function imgField(path,label,val){
  var src=/^(https?:\/\/|assets\/|data:image\/)/.test(val||"")?val:"";
  return '<div class="up"><img class="thumb" alt="" '+(src?'src="'+esc(src)+'"':'')+'><label class="btn" style="margin:0;display:inline-flex;align-items:center;color:inherit">'+label+'<input type="file" accept="image/*" data-img="'+path+'"></label></div>';
}
function renderWorks(){
  var names=state.brands.map(function(b){return b.name}).filter(Boolean);
  $("tWorks").innerHTML='<p class="muted" style="margin-bottom:16px">Videos from your Brands tab appear automatically. Add anything extra here.</p>'+
  state.gallery.map(function(g,i){
    return '<div class="item"><div class="ih"><strong>'+esc(g.title||"New work")+'</strong><button class="btn d" data-del="gallery.'+i+'" type="button">Remove</button></div>'+
    '<div class="row">'+fld("gallery."+i+".title","Title","text",g.title)+
    '<div><label>Brand name</label><input list="bl" data-k="gallery.'+i+'.brand" value="'+esc(g.brand||"")+'"></div>'+
    fld("gallery."+i+".category","Category","text",g.category)+
    fld("gallery."+i+".url","Video link (YouTube, Instagram...)","url",g.url)+'</div>'+
    imgField("gallery."+i+".thumb","Upload thumbnail",g.thumb)+'</div>';
  }).join("")+
  '<datalist id="bl">'+names.map(function(n){return '<option value="'+esc(n)+'">'}).join("")+'</datalist>'+
  '<button class="btn" data-add="gallery" type="button">+ Add work</button>';
}
function renderBrands(){
  $("tBrands").innerHTML=state.brands.map(function(b,i){
    var P="brands."+i;
    return '<div class="item"><div class="ih"><strong>'+esc(b.name||"New brand")+'</strong>'+
    '<label style="margin:0;display:flex;gap:8px;align-items:center"><input type="checkbox" style="width:auto;min-height:0" data-chk="'+P+'.confirmed"'+(b.confirmed?" checked":"")+'> Show on site</label>'+
    '<button class="btn d" data-del="'+P+'" type="button">Remove</button></div>'+
    '<div class="row">'+fld(P+".name","Brand name","text",b.name)+fld(P+".tag","Tag (e.g. Keyboards)","text",b.tag)+'</div>'+
    fld(P+".intro","Short intro","area",b.intro)+imgField(P+".logo","Upload logo",b.logo)+
    '<div class="sub"><strong>Products</strong>'+(b.products||[]).map(function(p,j){
      return '<div class="row" style="margin-top:12px">'+fld(P+".products."+j+".name","Name","text",p.name)+fld(P+".products."+j+".note","Note","text",p.note)+'</div>'+
      imgField(P+".products."+j+".image","Upload image",p.image)+'<button class="btn d" style="margin-top:8px" data-del="'+P+".products."+j+'" type="button">Remove product</button>';
    }).join("")+'<div style="margin-top:12px"><button class="btn" data-add="'+P+'.products" type="button">+ Add product</button></div></div>'+
    '<div class="sub"><strong>Videos</strong>'+(b.content||[]).map(function(v,j){
      var Q=P+".content."+j;
      return '<div class="row" style="margin-top:12px">'+fld(Q+".title","Title","text",v.title)+fld(Q+".youtube","YouTube link","url",v.youtube)+fld(Q+".instagram","Instagram link","url",v.instagram)+fld(Q+".tiktok","TikTok link","url",v.tiktok)+fld(Q+".facebook","Facebook link","url",v.facebook)+'</div>'+
      imgField(Q+".thumb","Custom thumbnail (optional)",v.thumb)+'<button class="btn d" style="margin-top:8px" data-del="'+Q+'" type="button">Remove video</button>';
    }).join("")+'<div style="margin-top:12px"><button class="btn" data-add="'+P+'.content" type="button">+ Add video</button></div></div></div>';
  }).join("")+'<button class="btn" data-add="brands" type="button">+ Add brand</button>';
}
function renderSettings(){
  $("tSettings").innerHTML='<div class="item"><strong>Account</strong><p class="muted" style="margin-top:4px">Signed in as '+esc(cfg.user)+'</p>'+
  '<label for="cpw0">Current password</label><input id="cpw0" type="password" autocomplete="current-password">'+
  '<label for="cpw">New password (12+ characters)</label><input id="cpw" type="password" autocomplete="new-password" minlength="12">'+
  '<label for="cpw2">Repeat new password</label><input id="cpw2" type="password" autocomplete="new-password" minlength="12">'+
  '<button class="btn p" id="csave" type="button" style="margin-top:16px">Change password</button><p class="msg" id="cmsg" role="status"></p></div>';
}
function renderAll(){renderWorks();renderBrands();renderSettings()}

/* ---------- events ---------- */
document.addEventListener("input",function(e){
  var t=e.target;if(t.dataset&&t.dataset.k&&state){setP(t.dataset.k,t.value);dirty=true}
});
document.addEventListener("change",function(e){
  var t=e.target;if(!state)return;
  if(t.dataset.chk){setP(t.dataset.chk,t.checked);dirty=true}
  if(t.dataset.img&&t.files[0]){
    var path=t.dataset.img,big=/\.logo$|\.image$/.test(path)?800:1200;
    shrink(t.files[0],big).then(function(d){setP(path,d);dirty=true;renderAll()}).catch(function(er){$("pmsg").className="msg bad";$("pmsg").textContent=er.message});
  }
});
document.addEventListener("click",function(e){
  var t=e.target.closest("button");if(!t||!state)return;
  if(t.dataset.t){
    ["works","brands","settings"].forEach(function(n){$("t"+n[0].toUpperCase()+n.slice(1)).hidden=n!==t.dataset.t});
    document.querySelectorAll(".tab").forEach(function(b){b.setAttribute("aria-selected",b===t)});
  }
  if(t.dataset.add){
    var a=t.dataset.add,tpl={gallery:{title:"",brand:"",category:"",url:"",thumb:""},brands:{id:newId("brand"),confirmed:true,name:"",tag:"",logo:"",intro:"",products:[],content:[]}};
    var item=tpl[a]||(/products$/.test(a)?{name:"",note:"",image:""}:{title:"",youtube:"",instagram:"",facebook:"",tiktok:"",thumb:""});
    getP(a).push(JSON.parse(JSON.stringify(item)));dirty=true;renderAll();
  }
  if(t.dataset.del){
    if(!confirm("Remove this item?"))return;
    var p=t.dataset.del.split("."),i=+p.pop();getP(p.join(".")).splice(i,1);dirty=true;renderAll();
  }
  if(t.id==="csave")savePw();
});

function savePw(){
  var m=$("cmsg");m.className="msg bad";
  var a=$("cpw0").value,n=$("cpw").value;
  if(n.length<12){m.textContent="New password needs 12+ characters.";return}
  if(n!==$("cpw2").value){m.textContent="New passwords do not match.";return}
  api("POST","/api/password",{current:a,next:n}).then(function(){
    $("cpw0").value=$("cpw").value=$("cpw2").value="";m.className="msg ok";m.textContent="Password changed. Other sessions were logged out.";
  }).catch(function(er){if(!expired(er))m.textContent=er.message});
}
$("publish").addEventListener("click",function(){
  if(!state)return;
  var b=$("publish"),m=$("pmsg");b.disabled=true;m.className="msg";m.textContent="Publishing...";
  api("PUT","/api/content",{brands:state.brands,gallery:state.gallery}).then(function(j){
    state.brands=j.brands;state.gallery=j.gallery;dirty=false;renderAll();
    m.className="msg ok";m.textContent="Published. Live on the site now.";
  }).catch(function(er){if(!expired(er)){m.className="msg bad";m.textContent=er.message}}).then(function(){b.disabled=false});
});

api("GET","/api/me").then(start).catch(function(){show("vLogin");$("lus").focus()});
})();
