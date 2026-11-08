// 扫参考站的 CSS 规则：按选择器片段找，打印原样声明。只读，不改任何东西。
const base = "http://localhost:3456";
const target = process.env.REF_TARGET || "B6F3A8C00B162938AD109CBB2549A6B9";
const frags = process.argv.slice(2);
const code = `(()=>{const frags=${JSON.stringify(frags)};const out=[];
for(const ss of document.styleSheets){let rules;try{rules=ss.cssRules}catch(e){continue}
for(const r of rules){if(!r.selectorText)continue;const s=r.selectorText;
if(frags.some(f=>s.includes(f)))out.push(s+" { "+r.style.cssText+" }")}}
return JSON.stringify(out)})()`;
const res = await fetch(`${base}/eval?target=${target}`, { method: "POST", body: code });
const txt = await res.text();
let v = txt;
try { v = JSON.parse(txt).value; } catch {}
try { for (const line of JSON.parse(v)) console.log(line.replace(/url\("data:[^"]*"\)/g, "url(…)")); } catch { console.log(v); }
