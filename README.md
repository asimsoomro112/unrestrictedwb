# ProxyFlow v3 — Deploy Guide

## Kyun pehla kaam nahi kiya?

1. **Intermediate proxies ki zarurat nahi thi** — Vercel ke servers khud US mein hain
2. **Free proxies expire ho chuke the** — screenshot wali proxies trial thi
3. **CONNECT tunnel complex tha** — bahut saare failure points

## V3 mein kya badla?

- ✅ Vercel ka apna US IP use hota hai — koi intermediate proxy nahi
- ✅ HLS video streams (m3u8) bhi rewrite hoti hain — video play hogi
- ✅ Fetch, XHR, clicks, forms sab intercept hote hain
- ✅ Cookies properly forward hoti hain
- ✅ Redirects automatically follow hote hain
- ✅ No external npm packages — zero dependencies

---

## ⚡ Vercel Deploy (5 minute)

### Step 1 — GitHub repo banao
1. https://github.com/new jao
2. Name: `proxyflow-v3`, Public banao
3. Create karo
4. "uploading an existing file" click karo
5. Is ZIP ki saari files drag & drop karo:
   - `api/proxy.js`
   - `public/index.html`  
   - `vercel.json`
   - `package.json`
6. Commit changes

### Step 2 — Vercel par import karo
1. https://vercel.com/new jao
2. GitHub se login karo
3. `proxyflow-v3` repo import karo
4. Sab default — "Deploy" click karo
5. ✅ Done! URL mil jaegi: `https://proxyflow-v3-xxx.vercel.app`

---

## ⚠️ Important Notes

- Vercel **free plan** pe 100GB bandwidth/month milti hai
- Heavy sites jaise YouTube/Pornhub ke video players JS-heavy hain — basic browsing kaam karega, full player sometimes nahi
- Agar site completely kaam na kare, try karo us site ka mobile version: `m.pornhub.com`
- Apni deployed URL ko **private rakhna** — public share mat karo warna bandwidth khatam hogi
