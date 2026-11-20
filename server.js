"use strict";
/* Portfolio server: static site + real server-side admin authentication.
   No dependencies. Run:  node server.js set-password   (once)   then   node server.js */
const http=require("http"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const ROOT=__dirname,DATA=path.join(ROOT,"data"),USERF=path.join(DATA,"admin.json"),CONTENT=path.join(ROOT,"content.json");
const PORT=+process.env.PORT||3000,HOST=process.env.HOST||"127.0.0.1",TRUST=process.env.TRUST_PROXY==="1";
const IDLE=30*60e3,ABSOLUTE=8*3600e3,MAXBODY=25*1024*1024;

/* ---------- password hashing (scrypt, per-user random salt) ---------- */
const SC={N:32768,r:8,p:1,maxmem:96*1024*1024};
const hashPw=(pw,salt)=>new Promise((ok,no)=>crypto.scrypt(pw,salt,64,SC,(e,k)=>e?no(e):ok(k)));
function readUser(){try{return JSON.parse(fs.readFileSync(USERF,"utf8"))}catch(e){return null}}
async function writeUser(user,pw){
  const salt=crypto.randomBytes(16),h=await hashPw(pw,salt);
  fs.mkdirSync(DATA,{recursive:true,mode:0o700});
  fs.writeFileSync(USERF,JSON.stringify({user,salt:salt.toString("base64"),hash:h.toString("base64"),alg:"scrypt-N32768"}),{mode:0o600});
}

/* ---------- CLI: set-password ---------- */
if(process.argv[2]==="set-password"){
  let lines=null;
  const ask=(q,hide)=>new Promise(res=>{
    process.stdout.write(q);
    if(!process.stdin.isTTY){
      if(!lines){let buf="";process.stdin.on("data",d=>buf+=d);process.stdin.on("end",()=>{lines=buf.split(/\r?\n/);res(lines.shift()||"")});return}
      return res(lines.shift()||"");
    }
    if(!hide){process.stdin.setEncoding("utf8");process.stdin.once("data",d=>{process.stdin.pause();res(String(d).trim())});return}
    let s="";process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding("utf8");
    const on=c=>{for(const ch of c){
      if(ch==="\r"||ch==="\n"||ch==="\u0004"){process.stdin.setRawMode(false);process.stdin.pause();process.stdin.removeListener("data",on);process.stdout.write("\n");return res(s)}
      if(ch==="\u0003")process.exit(1);
      if(ch==="\u007f"||ch==="\b")s=s.slice(0,-1);else s+=ch;}};
    process.stdin.on("data",on);
  });
  (async()=>{
    const u=(await ask("Admin username [admin]: ",false)).trim()||"admin";
    const a=await ask("New password (12+ chars): ",true),b=await ask("Repeat password: ",true);
    if(a.length<12){console.error("Password must be at least 12 characters.");process.exit(1)}
    if(a!==b){console.error("Passwords do not match.");process.exit(1)}
    await writeUser(u,a);console.log("Saved. Start the server with: node server.js");process.exit(0);
  })();
  return;
}

/* ---------- sessions & throttling ---------- */
const sessions=new Map(),fails=new Map();
const now=()=>Date.now();
function ipOf(req){
  if(TRUST){const x=String(req.headers["x-forwarded-for"]||"").split(",")[0].trim();if(x)return x}
  return req.socket.remoteAddress||"?";
}
const isHttps=req=>!!req.socket.encrypted||(TRUST&&req.headers["x-forwarded-proto"]==="https");
function cookies(req){const o={};String(req.headers.cookie||"").split(";").forEach(p=>{const i=p.indexOf("=");if(i>0)o[p.slice(0,i).trim()]=p.slice(i+1).trim()});return o}
function session(req){
  const id=cookies(req).sid;if(!id)return null;
  const s=sessions.get(id);if(!s)return null;
  if(now()>s.abs||now()-s.last>IDLE){sessions.delete(id);return null}
  s.last=now();s.id=id;return s;
}
function setCookie(res,req,val,maxAge){
  res.setHeader("Set-Cookie","sid="+val+"; HttpOnly; SameSite=Strict; Path=/; Max-Age="+maxAge+(isHttps(req)?"; Secure":""));
}
setInterval(()=>{const t=now();sessions.forEach((s,k)=>{if(t>s.abs||t-s.last>IDLE)sessions.delete(k)});fails.forEach((f,k)=>{if(t>f.until+3600e3&&t-f.at>3600e3)fails.delete(k)})},60e3).unref();

/* ---------- helpers ---------- */
function baseHeaders(res){
  res.setHeader("X-Content-Type-Options","nosniff");
  res.setHeader("Referrer-Policy","no-referrer");
  res.setHeader("X-Frame-Options","SAMEORIGIN");
  res.setHeader("Cross-Origin-Opener-Policy","same-origin");
  res.setHeader("Permissions-Policy","camera=(), microphone=(), geolocation=()");
}
function send(res,code,obj,extra){
  const b=Buffer.from(JSON.stringify(obj));
  res.writeHead(code,Object.assign({"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store","Content-Length":b.length},extra||{}));
  res.end(b);
}
function body(req){
  return new Promise((ok,no)=>{
    let n=0;const c=[];
    req.on("data",d=>{n+=d.length;if(n>MAXBODY){no(Object.assign(new Error("Too large"),{code:413}));req.destroy();return}c.push(d)});
    req.on("end",()=>{try{ok(JSON.parse(Buffer.concat(c).toString("utf8")||"{}"))}catch(e){no(Object.assign(new Error("Bad JSON"),{code:400}))}});
    req.on("error",no);
  });
}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function eq(a,b){return a.length===b.length&&crypto.timingSafeEqual(a,b)}
function sameOrigin(req){const o=req.headers.origin;if(!o)return true;try{return new URL(o).host===req.headers.host}catch(e){return false}}

/* ---------- content validation ---------- */
const str=(v,n)=>typeof v==="string"?v.trim().slice(0,n):"";
const link=v=>{v=str(v,2000);return /^(https?:\/\/)/i.test(v)?v:""};
const img=v=>{if(typeof v!=="string")return "";v=v.trim();if(v.startsWith("data:image/"))return v.length<9e6?v:"";v=v.slice(0,500);return /^(https?:\/\/|assets\/[\w.-]+$)/i.test(v)?v:""};
function clean(d){
  const L=(a,n)=>Array.isArray(a)?a.slice(0,n):[];
  return {
    brands:L(d.brands,200).map(b=>({
      id:str(b.id,80)||"b-"+crypto.randomBytes(3).toString("hex"),confirmed:!!b.confirmed,name:str(b.name,120),tag:str(b.tag,80),logo:img(b.logo),intro:str(b.intro,1500),
      products:L(b.products,100).map(p=>({name:str(p.name,160),note:str(p.note,160),image:img(p.image)})),
      content:L(b.content,500).map(v=>({title:str(v.title,200),youtube:link(v.youtube),instagram:link(v.instagram),facebook:link(v.facebook),tiktok:link(v.tiktok),thumb:img(v.thumb)}))
    })),
    gallery:L(d.gallery,1000).map(g=>({title:str(g.title,200),brand:str(g.brand,120),category:str(g.category,80),url:link(g.url),thumb:img(g.thumb)})).filter(g=>g.url)
  };
}
function saveImage(dataUrl){
  const m=/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if(!m)throw Object.assign(new Error("Unsupported image"),{code:400});
  const buf=Buffer.from(m[2],"base64");
  const ok=(m[1]==="jpeg"&&buf[0]===0xFF&&buf[1]===0xD8)||(m[1]==="png"&&buf.slice(0,4).toString("hex")==="89504e47")||(m[1]==="webp"&&buf.slice(0,4).toString()==="RIFF"&&buf.slice(8,12).toString()==="WEBP");
  if(!ok||buf.length>6e6)throw Object.assign(new Error("Invalid image file"),{code:400});
  const name="img-"+crypto.createHash("sha256").update(buf).digest("hex").slice(0,16)+"."+(m[1]==="jpeg"?"jpg":m[1]);
  const dir=path.join(ROOT,"assets");fs.mkdirSync(dir,{recursive:true});
  const f=path.join(dir,name);if(!fs.existsSync(f))fs.writeFileSync(f,buf);
  return "assets/"+name;
}
function materialize(o){
  for(const k of Object.keys(o)){
    const v=o[k];
    if(typeof v==="string"&&v.startsWith("data:image/"))o[k]=saveImage(v);
    else if(v&&typeof v==="object")materialize(v);
  }
}
function atomicWrite(file,text){const t=file+"."+process.pid+".tmp";fs.writeFileSync(t,text);fs.renameSync(t,file)}
function readContent(){try{return JSON.parse(fs.readFileSync(CONTENT,"utf8"))}catch(e){return {}}}

/* ---------- API ---------- */
async function api(req,res,p){
  const m=req.method;
  if(m!=="GET"&&!sameOrigin(req))return send(res,403,{error:"Bad origin"});

  if(p==="/api/login"&&m==="POST"){
    const ip=ipOf(req),f=fails.get(ip)||{n:0,until:0,at:0};
    if(now()<f.until)return send(res,429,{error:"Too many attempts. Try again later.",retry:Math.ceil((f.until-now())/1000)},{"Retry-After":Math.ceil((f.until-now())/1000)});
    let d;try{d=await body(req)}catch(e){return send(res,e.code||400,{error:e.message})}
    const u=readUser(),user=str(d.username,200),pw=typeof d.password==="string"?d.password.slice(0,500):"";
    const salt=u?Buffer.from(u.salt,"base64"):crypto.randomBytes(16);
    const h=await hashPw(pw,salt);
    const good=!!u&&eq(Buffer.from(user),Buffer.from(u.user))&&eq(h,Buffer.from(u.hash,"base64"));
    if(!good){
      f.n++;f.at=now();if(f.n>=5)f.until=now()+Math.min(3600e3,60e3*Math.pow(2,f.n-5));fails.set(ip,f);
      await sleep(400+Math.random()*300);
      return send(res,401,{error:"Wrong username or password."});
    }
    fails.delete(ip);
    const id=crypto.randomBytes(32).toString("hex"),csrf=crypto.randomBytes(24).toString("hex");
    sessions.set(id,{user:u.user,csrf,last:now(),abs:now()+ABSOLUTE});
    setCookie(res,req,id,ABSOLUTE/1000);
    return send(res,200,{user:u.user,csrf});
  }

  const s=session(req);
  if(!s)return send(res,401,{error:"Not logged in"});
  if(p==="/api/me"&&m==="GET")return send(res,200,{user:s.user,csrf:s.csrf});
  if(m!=="GET"){
    const t=String(req.headers["x-csrf-token"]||"");
    if(!eq(Buffer.from(t),Buffer.from(s.csrf)))return send(res,403,{error:"Bad CSRF token"});
  }
  if(p==="/api/logout"&&m==="POST"){sessions.delete(s.id);setCookie(res,req,"",0);return send(res,200,{ok:true})}
  if(p==="/api/content"&&m==="GET"){const c=readContent();return send(res,200,{brands:c.brands||[],gallery:c.gallery||[]})}
  if(p==="/api/content"&&m==="PUT"){
    let d;try{d=await body(req)}catch(e){return send(res,e.code||400,{error:e.message})}
    try{
      const c=clean(d);materialize(c);
      const merged=Object.assign({},readContent(),c);
      atomicWrite(CONTENT,JSON.stringify(merged,null,2));
      return send(res,200,c);
    }catch(e){return send(res,e.code||500,{error:e.code?e.message:"Could not save"})}
  }
  if(p==="/api/password"&&m==="POST"){
    let d;try{d=await body(req)}catch(e){return send(res,e.code||400,{error:e.message})}
    const u=readUser(),cur=typeof d.current==="string"?d.current:"",np=typeof d.next==="string"?d.next:"";
    if(np.length<12||np.length>500)return send(res,400,{error:"New password needs 12+ characters."});
    const h=await hashPw(cur,Buffer.from(u.salt,"base64"));
    if(!eq(h,Buffer.from(u.hash,"base64"))){await sleep(500);return send(res,403,{error:"Current password is wrong."})}
    await writeUser(u.user,np);
    sessions.forEach((x,k)=>{if(k!==s.id)sessions.delete(k)});
    return send(res,200,{ok:true});
  }
  return send(res,404,{error:"Not found"});
}

/* ---------- static files (strict allow-list) ---------- */
const TYPES={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".json":"application/json; charset=utf-8",".css":"text/css; charset=utf-8",".jpg":"image/jpeg",".jpeg":"image/jpeg",".png":"image/png",".webp":"image/webp",".gif":"image/gif",".ico":"image/x-icon",".txt":"text/plain; charset=utf-8",".xml":"application/xml",".webmanifest":"application/manifest+json"};
const ROOTFILES=new Set(["index.html","admin.html","admin.js","content.json","robots.txt","sitemap.xml","favicon.ico"]);
const ADMIN_CSP="default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
function serveStatic(req,res,p){
  if(req.method!=="GET"&&req.method!=="HEAD"){res.writeHead(405,{Allow:"GET, HEAD"});return res.end()}
  if(p==="/")p="/index.html";else if(p==="/admin")p="/admin.html";
  const rel=p.replace(/^\/+/,"");
  const ext=path.extname(rel).toLowerCase();
  let ok=false;
  if(rel.startsWith("assets/"))ok=!!TYPES[ext]&&ext!==".html"&&ext!==".js"&&ext!==".json";
  else ok=ROOTFILES.has(rel);
  const file=path.resolve(ROOT,rel);
  if(!ok||!file.startsWith(ROOT+path.sep)||rel.includes("\0")){res.writeHead(404);return res.end("Not found")}
  fs.readFile(file,(e,b)=>{
    if(e){res.writeHead(404);return res.end("Not found")}
    const h={"Content-Type":TYPES[ext]||"application/octet-stream","Content-Length":b.length};
    if(rel==="admin.html"||rel==="admin.js"){h["Content-Security-Policy"]=ADMIN_CSP;h["X-Robots-Tag"]="noindex, nofollow";h["Cache-Control"]="no-store"}
    else if(rel==="content.json"||rel==="index.html")h["Cache-Control"]="no-cache";
    else h["Cache-Control"]="public, max-age=86400";
    res.writeHead(200,h);res.end(req.method==="HEAD"?undefined:b);
  });
}

http.createServer(async(req,res)=>{
  try{
    baseHeaders(res);
    const p=decodeURIComponent(new URL(req.url,"http://x").pathname);
    if(p.startsWith("/api/"))return await api(req,res,p);
    serveStatic(req,res,p);
  }catch(e){
    if(!res.headersSent){if(e instanceof URIError){res.writeHead(400);res.end("Bad request")}else send(res,500,{error:"Server error"})}
  }
}).listen(PORT,HOST,()=>{
  console.log("Site:  http://"+(HOST==="127.0.0.1"?"localhost":HOST)+":"+PORT+"/\nAdmin: http://"+(HOST==="127.0.0.1"?"localhost":HOST)+":"+PORT+"/admin");
  if(!readUser())console.log("\nNo admin account yet. Stop the server and run:  node server.js set-password");
});
