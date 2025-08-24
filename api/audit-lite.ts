// api/audit-lite.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";

// Helpers
const MAX_LINKS = 30;
const TIMEOUT_MS = 20000;

function ok(u: string) { try { return new URL(u); } catch { return null; } }
function aborter(ms:number){ const c=new AbortController(); const t=setTimeout(()=>c.abort(),ms); return {signal:c.signal, done:()=>clearTimeout(t)}; }

async function text(url:string){ const {signal,done}=aborter(TIMEOUT_MS); try{ const r=await fetch(url,{signal}); return r.ok?await r.text():""; } catch { return ""; } finally {done();} }
async function head(url:string){ const {signal,done}=aborter(TIMEOUT_MS); try{ const r=await fetch(url,{method:"HEAD",redirect:"follow",signal}); return {ok:r.ok,status:r.status,headers:r.headers}; } catch { return {ok:false,status:0,headers:new Headers()}; } finally {done();} }
async function get(url:string){ const {signal,done}=aborter(TIMEOUT_MS); try{ const r=await fetch(url,{redirect:"follow",signal}); return {ok:r.ok,status:r.status,headers:r.headers,html:await r.text()}; } catch { return {ok:false,status:0,headers:new Headers(),html:""}; } finally {done();} }

function pickInternalLinks(html:string, base:URL) {
  const hrefs = [...html.matchAll(/<a[^>]+href=["']([^"']+)["']/gi)].map(m=>m[1]);
  const urls:string[]=[];
  for(const h of hrefs){
    try{
      const u = new URL(h, base);
      if(u.origin===base.origin) urls.push(u.toString());
    }catch{}
    if(urls.length>=MAX_LINKS) break;
  }
  return Array.from(new Set(urls));
}

export default async function handler(req:VercelRequest,res:VercelResponse){
  res.setHeader("Content-Type","application/json; charset=utf-8");
  res.setHeader("Cache-Control","no-store");

  const urlParam = (req.query.url||"").toString().trim();
  const url = ok(urlParam);
  if(!url) return res.status(400).json({error:"URL invalide"});

  // 1) Page principale
  const page = await get(url.toString());

  // 2) En-têtes sécurité (échantillon utile)
  const securityHeaders = ["content-security-policy","x-frame-options","x-content-type-options","referrer-policy","permissions-policy","strict-transport-security"];
  const headersPresent = securityHeaders.filter(h => page.headers.has(h));

  // 3) Mixed content (naïf, mais utile)
  const mixedContent = /http:\/\/[^"' \n]+/i.test(page.html);

  // 4) Robots / sitemap
  const robotsTxt = await text(new URL("/robots.txt", url).toString());
  const sitemapHead = await head(new URL("/sitemap.xml", url).toString());

  // 5) Pages légales/RGPD (HEAD)
  const legalPaths = [
    "/mentions-legales","/mentions-légales","/mentions","/legal-notice",
    "/conditions-generales","/cgv","/cgu","/terms","/terms-and-conditions",
    "/politique-de-confidentialite","/confidentialite","/privacy","/privacy-policy",
    "/cookies","/cookie-policy","/politique-de-cookies"
  ];
  const legalResults = await Promise.all(legalPaths.map(async p=>{
    const r = await head(new URL(p, url).toString());
    return {path:p, present:r.ok || (r.status>=200 && r.status<400)};
  }));
  const legalPresent = legalResults.filter(r=>r.present).map(r=>r.path);

  // 6) Liens internes (échantillon) + statuts
  const internal = pickInternalLinks(page.html,url);
  const linkStatuses = await Promise.all(internal.map(async u=>{
    const r = await head(u);
    return {url:u, ok:r.ok, status:r.status};
  }));

  return res.status(200).json({
    ok:true,
    requestedUrl:url.toString(),
    security:{ present:headersPresent, https:url.protocol==="https:" },
    mixedContent,
    robots:{ present:robotsTxt.trim().length>0 },
    sitemap:{ ok:sitemapHead.ok, status:sitemapHead.status },
    legal:{ present:legalPresent },
    links:{ checked:linkStatuses.length, broken: linkStatuses.filter(l=>!l.ok).length, sample: linkStatuses.filter(l=>!l.ok).slice(0,10) }
  });
}
