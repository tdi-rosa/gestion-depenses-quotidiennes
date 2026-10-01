import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const BRIDGE_BASE = 'https://api.bridgeapi.io';
const BRIDGE_VERSION = '2025-01-15';
const EXTERNAL_USER_ID = process.env.BRIDGE_EXTERNAL_USER_ID || 'spendline-owner';
const SETUP_TOKEN = process.env.SPENDLINE_SETUP_TOKEN || '';
const SESSION_SECRET = process.env.SPENDLINE_SESSION_SECRET || '';
const PUBLIC_APP_URL = (process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');

const STATIC = new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/index.html', ['index.html','text/html; charset=utf-8']],
  ['/app.js', ['app.js','text/javascript; charset=utf-8']],
  ['/db.js', ['db.js','text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css','text/css; charset=utf-8']],
  ['/sw.js', ['sw.js','text/javascript; charset=utf-8']],
  ['/manifest.webmanifest', ['manifest.webmanifest','application/manifest+json']],
  ['/icons/icon-192.png', ['icons/icon-192.png','image/png']],
  ['/icons/icon-512.png', ['icons/icon-512.png','image/png']],
  ['/icons/icon-maskable-512.png', ['icons/icon-maskable-512.png','image/png']]
]);

function json(res, status, body, headers={}) {
  res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'no-store',...headers});
  res.end(JSON.stringify(body));
}
function redirect(res, location, headers={}) {
  res.writeHead(302, {location, ...headers}); res.end();
}
function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(v=>v.trim()).filter(Boolean).map(v=>{
    const i=v.indexOf('='); return [decodeURIComponent(v.slice(0,i)), decodeURIComponent(v.slice(i+1))];
  }));
}
function sessionValue() {
  if (!SETUP_TOKEN || !SESSION_SECRET) return '';
  return crypto.createHmac('sha256', SESSION_SECRET).update(SETUP_TOKEN).digest('hex');
}
function safeEqual(a,b) {
  if (!a || !b) return false;
  const aa=Buffer.from(a), bb=Buffer.from(b);
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}
function authenticated(req) {
  return safeEqual(parseCookies(req).spendline_session || '', sessionValue());
}
async function rawBody(req, limit=1024*1024) {
  const chunks=[]; let size=0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('Payload too large'), {status:413});
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function bodyJson(req) {
  const raw=await rawBody(req);
  if (!raw.length) return {};
  try { return JSON.parse(raw.toString('utf8')); }
  catch { throw Object.assign(new Error('JSON invalide'), {status:400}); }
}
function bridgeConfigured() {
  return Boolean(process.env.BRIDGE_CLIENT_ID && process.env.BRIDGE_CLIENT_SECRET);
}
async function bridgeRequest(endpoint, {method='GET', token, body}={}) {
  const headers = {
    'accept':'application/json',
    'Bridge-Version':BRIDGE_VERSION,
    'Client-Id':process.env.BRIDGE_CLIENT_ID || '',
    'Client-Secret':process.env.BRIDGE_CLIENT_SECRET || ''
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type']='application/json';
  const response = await fetch(endpoint.startsWith('http') ? endpoint : BRIDGE_BASE + endpoint, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text=await response.text();
  let payload=null;
  try { payload=text ? JSON.parse(text) : {}; } catch { payload={message:text}; }
  if (!response.ok) {
    const err=new Error(payload?.message || payload?.error || `Bridge HTTP ${response.status}`);
    err.status=response.status; err.payload=payload; throw err;
  }
  return payload;
}
async function createBridgeUser() {
  try {
    await bridgeRequest('/v3/aggregation/users', {method:'POST', body:{external_user_id:EXTERNAL_USER_ID}});
  } catch (err) {
    if (![400,409,422].includes(err.status)) throw err;
  }
}
async function getBridgeToken() {
  if (!bridgeConfigured()) throw Object.assign(new Error('Bridge non configuré'), {status:503});
  const auth = () => bridgeRequest('/v3/aggregation/authorization/token', {
    method:'POST', body:{external_user_id:EXTERNAL_USER_ID}
  });
  try { return await auth(); }
  catch (err) {
    if (![400,404,422].includes(err.status)) throw err;
    await createBridgeUser();
    return auth();
  }
}
async function listTransactions(params) {
  const auth=await getBridgeToken();
  const search=new URLSearchParams({limit:'500'});
  if (params.since) search.set('since', params.since);
  if (params.min_date) search.set('min_date', params.min_date);
  let endpoint=`/v3/aggregation/transactions?${search}`;
  const out=[]; let generatedAt=null; let page=0;
  while (endpoint && page++ < 20) {
    const data=await bridgeRequest(endpoint, {token:auth.access_token});
    generatedAt=data.generated_at || generatedAt;
    if (Array.isArray(data.resources)) out.push(...data.resources);
    endpoint=data.pagination?.next_uri || null;
  }
  return {resources:out, generated_at:generatedAt};
}
function publicOrigin(req) {
  if (PUBLIC_APP_URL) return PUBLIC_APP_URL;
  const proto=(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  return `${proto}://${req.headers.host}`;
}
function verifyWebhook(raw, signatureHeader) {
  const secret=process.env.BRIDGE_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected=crypto.createHmac('sha256',secret).update(raw).digest('hex').toUpperCase();
  const signatures=String(signatureHeader||'').split(',').map(x=>x.trim()).filter(x=>x.startsWith('v1=')).map(x=>x.slice(3).toUpperCase());
  return signatures.some(sig=>safeEqual(sig,expected));
}

const server=http.createServer(async (req,res)=>{
  try {
    const url=new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname === '/health') return json(res,200,{ok:true,bridgeConfigured:bridgeConfigured()});

    if (url.pathname.startsWith('/setup/')) {
      const supplied=decodeURIComponent(url.pathname.slice('/setup/'.length));
      if (!SETUP_TOKEN || !SESSION_SECRET || !safeEqual(supplied,SETUP_TOKEN)) return json(res,403,{error:'Lien d’activation invalide'});
      const cookie=`spendline_session=${encodeURIComponent(sessionValue())}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=31536000`;
      return redirect(res,'/',{'set-cookie':cookie});
    }

    if (url.pathname === '/api/session') {
      return json(res,200,{authenticated:authenticated(req),bridgeConfigured:bridgeConfigured()});
    }

    if (url.pathname === '/api/bridge/webhook' && req.method === 'POST') {
      const raw=await rawBody(req);
      if (!verifyWebhook(raw,req.headers['bridgeapi-signature'])) return json(res,401,{error:'Signature webhook invalide'});
      return json(res,200,{ok:true});
    }

    if (url.pathname.startsWith('/api/')) {
      if (!authenticated(req)) return json(res,401,{error:'Activation requise'});

      if (url.pathname === '/api/bridge/status' && req.method === 'GET') {
        if (!bridgeConfigured()) return json(res,200,{configured:false,connected:false});
        const auth=await getBridgeToken();
        const items=await bridgeRequest('/v3/aggregation/items?limit=100',{token:auth.access_token});
        return json(res,200,{configured:true,connected:Array.isArray(items.resources)&&items.resources.length>0,itemCount:items.resources?.length||0});
      }

      if (url.pathname === '/api/bridge/connect' && req.method === 'POST') {
        const body=await bodyJson(req);
        const email=String(body.email || '').trim();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res,400,{error:'Adresse e-mail invalide'});
        const auth=await getBridgeToken();
        const payload={user_email:email};
        const callback=process.env.BRIDGE_CALLBACK_URL || (PUBLIC_APP_URL ? `${PUBLIC_APP_URL}/?bridge=connected` : '');
        if (callback) payload.callback_url=callback;
        const session=await bridgeRequest('/v3/aggregation/connect-sessions',{method:'POST',token:auth.access_token,body:payload});
        return json(res,201,{url:session.url,id:session.id});
      }

      if (url.pathname === '/api/bridge/transactions' && req.method === 'GET') {
        const since=url.searchParams.get('since') || '';
        const minDate=url.searchParams.get('min_date') || '';
        const data=await listTransactions({since,min_date:minDate});
        const resources=data.resources.map(t=>({
          id:t.id,
          amount:t.amount,
          clean_description:t.clean_description,
          provider_description:t.provider_description,
          date:t.date,
          transaction_date:t.transaction_date,
          booking_date:t.booking_date,
          updated_at:t.updated_at,
          currency_code:t.currency_code,
          operation_type:t.operation_type,
          future:Boolean(t.future),
          deleted:Boolean(t.deleted)
        }));
        const maxUpdatedAt=resources.reduce((m,t)=>t.updated_at && (!m || t.updated_at>m) ? t.updated_at : m, since || null);
        return json(res,200,{resources,generated_at:data.generated_at,max_updated_at:maxUpdatedAt});
      }

      return json(res,404,{error:'API inconnue'});
    }

    const file=STATIC.get(url.pathname);
    if (file) {
      const [relative,mime]=file;
      const data=await fs.readFile(path.join(__dirname,relative));
      res.writeHead(200, {'content-type':mime,'cache-control':url.pathname==='/sw.js'?'no-cache':'public, max-age=300'});
      return res.end(data);
    }
    return json(res,404,{error:'Not found'});
  } catch (err) {
    const status=Number(err.status)||500;
    if (status>=500) console.error('[server]',err.message);
    return json(res,status,{error: status>=500 ? 'Erreur serveur' : err.message, bridgeStatus:err.status||null});
  }
});

server.listen(PORT,'0.0.0.0',()=>console.log(`Spendline listening on :${PORT}`));
