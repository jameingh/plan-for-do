// 参考站取证助手：走 web-access 的 CDP 代理（localhost:3456），避免 shell 引号把中文吃掉的坑。
// 用法：
//   node scripts/ref.mjs eval   '<js 表达式文件路径或表达式>'
//   node scripts/ref.mjs click  <x> <y>
//   node scripts/ref.mjs dump                      # 打印当前可见弹层结构
//   node scripts/ref.mjs chip     <className>      # 点某个 matter-* 芯片（真实鼠标坐标）
const base = "http://localhost:3456";
const target = process.env.REF_TARGET || "B6F3A8C00B162938AD109CBB2549A6B9";
const fs = await import("node:fs");

async function evalJs(code) {
  const res = await fetch(`${base}/eval?target=${target}`, { method: "POST", body: code });
  const txt = await res.text();
  try {
    const j = JSON.parse(txt);
    return j.value !== undefined ? j.value : j;
  } catch {
    return txt;
  }
}
async function clickXY(x, y) {
  const res = await fetch(`${base}/clickXY?target=${target}&x=${x}&y=${y}`);
  return res.text();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const [mode, a, b] = process.argv.slice(2);
if (mode === "eval") {
  const code = fs.existsSync(a) ? fs.readFileSync(a, "utf8") : a;
  console.log(await evalJs(code));
} else if (mode === "click") {
  console.log(await clickXY(a, b));
} else if (mode === "chip") {
  console.log(await evalJs(`(()=>{const e=document.querySelector(${JSON.stringify("." + a)});const r=e.getBoundingClientRect();return JSON.stringify([Math.round(r.x+r.width/2),Math.round(r.y+r.height/2)])})()`));
} else if (mode === "dump") {
  const out = await evalJs(`(()=>{const ps=[...document.querySelectorAll("div")].filter(e=>{const c=String(e.className);const r=e.getBoundingClientRect();return r.width>0&&/^body-/.test(c)&&c!=="body-scroll"}).map(e=>{const r=e.getBoundingClientRect();return{cls:String(e.className),rect:[r.x,r.y,r.width,r.height].map(Math.round),txt:(e.innerText||"").replace(/\\n/g,"|").slice(0,220),foot:[...e.querySelectorAll("[class*=button-]")].map(x=>String(x.className).replace(/ ?my-cursor/,"")+"="+x.innerText.trim())}});
  const chips=[...document.querySelectorAll("[class*=matter-]")].filter(e=>r2(e).width>0).map(e=>String(e.className).replace(/ ?my-cursor| ?filled-?true?/g,"").trim()+"="+(e.innerText||"").replace(/\\n/g,"/").slice(0,20));
  function r2(e){return e.getBoundingClientRect()}
  return JSON.stringify({panels:ps,chips:chips.slice(0,14)},null,1)})()`);
  console.log(out);
} else if (mode === "find") {
  // a 是 \uXXXX 串（避免 shell 把中文吃掉）；打印命中点上下文
  const key = a.replace(/\\u([0-9a-fA-F]{4})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
  const out = await evalJs(`(()=>{const d=window.__dec||"";const s=${JSON.stringify(key)};const pos=[];let p=0;
  while((p=d.indexOf(s,p))>=0){pos.push(p);p+=s.length;if(pos.length>8)break}
  return JSON.stringify({len:d.length,n:pos.length,hits:pos.map(x=>d.slice(Math.max(0,x-140),x+80).replace(/\\s+/g," "))},null,1)})()`);
  console.log(out);
} else if (mode === "loadbundle") {
  console.log(await evalJs(`(async()=>{const s=[...document.querySelectorAll("script[src]")].map(x=>x.src);const url=s.find(u=>/app\\./.test(u))||s[0];
  if(!window.__dec){const t=await (await fetch(url)).text();window.__dec=t.replace(/\\\\u([0-9a-fA-F]{4})/g,(m,h)=>String.fromCharCode(parseInt(h,16)))}
  return JSON.stringify({url,len:window.__dec.length})})()`));
} else if (mode === "tree") {
  // a 是选择器，打印其子树（类名/纵坐标/高度/文本），用来对账 DOM 骨架
  const out = await evalJs(`(()=>{const c=document.querySelector(${JSON.stringify(a)});if(!c)return"selector miss: "+${JSON.stringify(a)};
  const out=[];const walk=(e,d)=>{[...e.children].forEach(k=>{const r=k.getBoundingClientRect();
  out.push("  ".repeat(d)+String(k.className).replace(/ ?my-cursor| ?filled-\\w+/g,"").trim().padEnd(26)+" y="+String(Math.round(r.y)).padEnd(6)+" h="+String(Math.round(r.height)).padEnd(5)+" "+(k.innerText||"").replace(/\\n/g,"/").slice(0,24).replace(/[\\u0000-\\u001f]/g,""));
  if(d<4)walk(k,d+1)})};walk(c,0);return out.join("\\n")})()`);
  console.log(typeof out === "string" ? out : JSON.stringify(out));
} else {
  console.log("未知模式");
}
