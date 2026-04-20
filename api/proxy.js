const https = require('https');
const http = require('http');
const zlib = require('zlib');
const url = require('url');

// ─── Helpers ────────────────────────────────────────────────────────────────

function decompress(response) {
  const enc = (response.headers['content-encoding'] || '').toLowerCase();
  if (enc === 'gzip')    return response.pipe(zlib.createGunzip());
  if (enc === 'deflate') return response.pipe(zlib.createInflate());
  if (enc === 'br')      return response.pipe(zlib.createBrotliDecompress());
  return response;
}

function readStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// Direct fetch — Vercel servers are in US/EU, so blocked sites are reachable
function fetchDirect(targetUrl, method, reqHeaders, body) {
  return new Promise((resolve, reject) => {
    const parsed = url.parse(targetUrl);
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.path || '/',
      method: method || 'GET',
      headers: reqHeaders,
      rejectUnauthorized: false,
      timeout: 25000,
    };

    const req = lib.request(options, (res) => {
      const stream = decompress(res);
      readStream(stream)
        .then(buf => resolve({ status: res.statusCode, headers: res.headers, body: buf }))
        .catch(reject);
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });

    if (body && body.length) req.write(body);
    req.end();
  });
}

// ─── URL rewriting ──────────────────────────────────────────────────────────

function makeProxyUrl(u, base, origin) {
  if (!u) return u;
  u = u.trim();
  if (u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('javascript:') || u.startsWith('#') || u.startsWith('mailto:')) return u;
  try {
    const abs = new URL(u, origin).href;
    return `${base}?url=${encodeURIComponent(abs)}`;
  } catch (e) {
    return u;
  }
}

function rewriteHtml(html, targetUrl, proxyBase) {
  let origin;
  try { origin = new URL(targetUrl).origin; } catch(e) { origin = ''; }

  // Inject JS interceptor — captures dynamic navigation, fetch, XHR
  const interceptor = `
<script>
(function(){
  var BASE = '${proxyBase}';
  var ORIGIN = '${origin}';
  function px(u){
    if(!u||typeof u!=='string') return u;
    if(u.indexOf(BASE)===0) return u;
    if(u.startsWith('data:')||u.startsWith('blob:')||u.startsWith('javascript:')||u.startsWith('#')||u.startsWith('mailto:')) return u;
    try{ return BASE+'?url='+encodeURIComponent(new URL(u,ORIGIN).href); }catch(e){ return u; }
  }
  // Intercept fetch
  var oF=window.fetch;
  window.fetch=function(r,o){
    if(typeof r==='string') r=px(r);
    else if(r instanceof Request){ r=new Request(px(r.url),r); }
    return oF.call(this,r,o);
  };
  // Intercept XHR
  var oO=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){
    return oO.apply(this,[m,px(u)].concat([].slice.call(arguments,2)));
  };
  // Intercept link clicks
  document.addEventListener('click',function(e){
    var a=e.target.closest('a[href]');
    if(!a) return;
    var h=a.getAttribute('href');
    if(!h||h.startsWith('#')||h.startsWith('javascript:')) return;
    var pxd=px(h);
    if(pxd!==h){ e.preventDefault(); e.stopPropagation(); location.href=pxd; }
  },true);
  // Intercept form submit
  document.addEventListener('submit',function(e){
    var f=e.target;
    var action=f.action||location.href;
    if(action.indexOf(BASE)===0) return;
    e.preventDefault();
    var fd=new FormData(f);
    if(f.method.toLowerCase()==='get'){
      location.href=BASE+'?url='+encodeURIComponent(action+'?'+new URLSearchParams(fd));
    } else {
      location.href=BASE+'?url='+encodeURIComponent(action);
    }
  },true);
  // history.pushState / replaceState — keep URL bar clean
  var oP=history.pushState;
  history.pushState=function(s,t,u){
    if(u) u=px(u);
    return oP.call(this,s,t,u);
  };
})();
</script>`;

  // Inject after <head> or <body>
  if (/<head[\s>]/i.test(html)) {
    html = html.replace(/<head([^>]*)>/i, (m) => m + interceptor);
  } else if (/<body[\s>]/i.test(html)) {
    html = html.replace(/<body([^>]*)>/i, (m) => m + interceptor);
  } else {
    html = interceptor + html;
  }

  // Remove restrictive meta tags and headers
  html = html.replace(/<meta[^>]*http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
  html = html.replace(/<meta[^>]*x-frame-options[^>]*>/gi, '');

  // Rewrite src, href, action, srcset, poster, data-src
  html = html.replace(/(\s(?:src|href|action|data-src|poster|data-href|data-url|data-lazy-src))=["']([^"']+)["']/gi, (m, attr, val) => {
    const rewritten = makeProxyUrl(val, proxyBase, origin);
    return `${attr}="${rewritten}"`;
  });

  // Protocol-relative URLs
  html = html.replace(/(\s(?:src|href))=(["'])\/\/([^"']+)\2/gi, (m, attr, q, rest) => {
    const abs = 'https://' + rest;
    return `${attr}="${proxyBase}?url=${encodeURIComponent(abs)}"`;
  });

  // srcset
  html = html.replace(/srcset=["']([^"']+)["']/gi, (m, srcset) => {
    const rewritten = srcset.replace(/([^\s,]+)(\s+[^\s,]+)?/g, (part, u, d) => {
      const r = makeProxyUrl(u.trim(), proxyBase, origin);
      return r + (d || '');
    });
    return `srcset="${rewritten}"`;
  });

  // CSS url() inside style tags and inline styles
  html = html.replace(/url\(["']?([^"')]+)["']?\)/gi, (m, u) => {
    if (u.startsWith('data:')) return m;
    return `url("${makeProxyUrl(u, proxyBase, origin)}")`;
  });

  return html;
}

function rewriteCss(css, targetUrl, proxyBase) {
  let origin;
  try { origin = new URL(targetUrl).origin; } catch(e) { origin = ''; }
  return css.replace(/url\(["']?([^"')]+)["']?\)/gi, (m, u) => {
    if (u.startsWith('data:')) return m;
    return `url("${makeProxyUrl(u, proxyBase, origin)}")`;
  });
}

function rewriteM3u8(text, targetUrl, proxyBase) {
  // Rewrite HLS playlist — proxy each segment and chunk URL
  return text.split('\n').map(line => {
    line = line.trim();
    if (line.startsWith('#')) return line;
    if (!line) return line;
    try {
      const abs = new URL(line, targetUrl).href;
      return `${proxyBase}?url=${encodeURIComponent(abs)}`;
    } catch(e) { return line; }
  }).join('\n');
}

// ─── Main handler ───────────────────────────────────────────────────────────

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  let targetUrl = req.query.url || '';
  if (!targetUrl) {
    res.status(400).send('Missing ?url= parameter');
    return;
  }
  if (!/^https?:\/\//i.test(targetUrl)) targetUrl = 'https://' + targetUrl;

  const proxyBase = `https://${req.headers.host}/api/proxy`;

  // Build request headers — look like a real browser
  const sendHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Accept': req.headers['accept'] || 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  };

  // Forward cookies
  if (req.headers.cookie) sendHeaders['Cookie'] = req.headers.cookie;

  // Forward content-type for POST
  if (req.method === 'POST' && req.headers['content-type']) {
    sendHeaders['Content-Type'] = req.headers['content-type'];
  }

  // Read POST body
  let body = null;
  if (req.method === 'POST') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = Buffer.concat(chunks);
    if (body.length) sendHeaders['Content-Length'] = String(body.length);
  }

  try {
    let result = await fetchDirect(targetUrl, req.method, sendHeaders, body);

    // Follow redirects (up to 5)
    let redirects = 0;
    while ([301,302,303,307,308].includes(result.status) && result.headers.location && redirects < 5) {
      redirects++;
      const loc = new URL(result.headers.location, targetUrl).href;
      targetUrl = loc;
      result = await fetchDirect(targetUrl, 'GET', sendHeaders, null);
    }

    // Strip bad response headers
    const strip = new Set(['content-encoding','transfer-encoding','content-security-policy',
      'x-frame-options','strict-transport-security','content-length',
      'x-content-type-options','permissions-policy','cross-origin-embedder-policy',
      'cross-origin-opener-policy','cross-origin-resource-policy']);

    Object.entries(result.headers).forEach(([k, v]) => {
      if (strip.has(k.toLowerCase())) return;
      if (k.toLowerCase() === 'set-cookie') return; // handle below
      try { res.setHeader(k, v); } catch(e) {}
    });

    // Forward cookies (strip domain/secure so browser keeps them)
    if (result.headers['set-cookie']) {
      const cookies = [].concat(result.headers['set-cookie']);
      const cleaned = cookies.map(c =>
        c.replace(/\s*Domain=[^;]+;?/gi,'')
         .replace(/\s*Secure;?/gi,'')
         .replace(/\s*SameSite=[^;]+;?/gi,'')
      );
      res.setHeader('Set-Cookie', cleaned);
    }

    const ct = (result.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    res.setHeader('Content-Type', result.headers['content-type'] || 'application/octet-stream');
    res.status(result.status);

    if (ct === 'text/html') {
      const html = rewriteHtml(result.body.toString('utf8'), targetUrl, proxyBase);
      res.send(html);
    } else if (ct === 'text/css') {
      const css = rewriteCss(result.body.toString('utf8'), targetUrl, proxyBase);
      res.send(css);
    } else if (ct === 'application/vnd.apple.mpegurl' || ct === 'application/x-mpegurl' || targetUrl.includes('.m3u8')) {
      // HLS video playlist — rewrite chunk URLs
      const m3u8 = rewriteM3u8(result.body.toString('utf8'), targetUrl, proxyBase);
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.send(m3u8);
    } else {
      res.send(result.body);
    }

  } catch (err) {
    console.error('Proxy error:', err.message);
    res.status(502).json({
      error: 'Could not fetch the requested URL',
      reason: err.message,
      url: targetUrl,
      tip: 'Make sure the URL is correct and try again'
    });
  }
};
