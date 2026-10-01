import { getTransactions, putTransaction, addManyTransactions, deleteTransaction, clearTransactions, getSetting, setSetting } from './db.js';

const CATEGORIES = ['Alimentation','Transport','Logement','Loisirs','Santé','Shopping','Abonnements','Autre'];
const $ = (id) => document.getElementById(id);
const euro = new Intl.NumberFormat('fr-FR', { style:'currency', currency:'EUR' });
const dayFmt = new Intl.DateTimeFormat('fr-FR', { day:'2-digit', month:'short' });
const monthFmt = new Intl.DateTimeFormat('fr-FR', { month:'long', year:'numeric' });
let transactions = [];
let pendingCsvRows = [];
let deferredInstallPrompt = null;

function localDateISO(d = new Date()) {
  const tz = new Date(d.getTime() - d.getTimezoneOffset()*60000);
  return tz.toISOString().slice(0,10);
}
function parseAmount(v) {
  if (typeof v === 'number') return Math.abs(v);
  const cleaned = String(v ?? '').replace(/\s/g,'').replace(/€/g,'').replace(/\.(?=\d{3}(\D|$))/g,'').replace(',','.').replace(/[^0-9.-]/g,'');
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.abs(n) : NaN;
}
function inferCategory(text='') {
  const s = text.toLowerCase();
  if (/carrefour|monoprix|franprix|lidl|aldi|biocoop|bio c|restaurant|cafe|boulanger|uber eats|deliveroo/.test(s)) return 'Alimentation';
  if (/ratp|sncf|uber|bolt|velib|lime|total|esso|shell/.test(s)) return 'Transport';
  if (/loyer|edf|engie|eau|assurance habitation/.test(s)) return 'Logement';
  if (/netflix|spotify|deezer|youtube|prime|abonnement/.test(s)) return 'Abonnements';
  if (/pharm|doct|sante|santé|optique/.test(s)) return 'Santé';
  if (/cinema|cinéma|steam|playstation|concert|bar /.test(s)) return 'Loisirs';
  if (/amazon|fnac|uniqlo|zara|ikea|decathlon/.test(s)) return 'Shopping';
  return 'Autre';
}
function fingerprint(row) { return [row.date, row.amount.toFixed(2), row.merchant.trim().toLowerCase()].join('|'); }
function makeRow({amount, merchant, date, category, note='', source='manual'}) {
  const row = { id: crypto.randomUUID(), amount:Number(amount), merchant:merchant.trim(), date, category:category || inferCategory(merchant), note, source, createdAt:Date.now() };
  row.fingerprint = fingerprint(row);
  return row;
}
function isSameMonth(date, now = new Date()) { const d = new Date(date+'T12:00:00'); return d.getFullYear()===now.getFullYear() && d.getMonth()===now.getMonth(); }
function sinceDays(date, days) { const d = new Date(date+'T12:00:00'); const start = new Date(); start.setHours(0,0,0,0); start.setDate(start.getDate()-(days-1)); return d >= start; }
function sum(rows) { return rows.reduce((acc,r)=>acc+r.amount,0); }

async function refresh() {
  transactions = await getTransactions();
  await render();
}

async function render() {
  const now = new Date();
  const monthRows = transactions.filter(t => isSameMonth(t.date, now));
  const today = localDateISO(now);
  const monthSpent = sum(monthRows);
  const budget = Number(await getSetting('monthlyBudget', 0)) || 0;
  const elapsedDays = Math.max(1, now.getDate());
  const daysInMonth = new Date(now.getFullYear(), now.getMonth()+1, 0).getDate();
  const activeDays = new Set(monthRows.map(t=>t.date)).size;
  const avg = monthSpent / Math.max(1, activeDays || elapsedDays);
  const projection = (monthSpent / elapsedDays) * daysInMonth;

  $('monthLabel').textContent = monthFmt.format(now);
  $('monthSpent').textContent = euro.format(monthSpent);
  $('todaySpent').textContent = euro.format(sum(transactions.filter(t=>t.date===today)));
  $('weekSpent').textContent = euro.format(sum(transactions.filter(t=>sinceDays(t.date,7))));
  $('dailyAverage').textContent = euro.format(avg);
  $('monthProjection').textContent = euro.format(projection);
  if (budget > 0) {
    const remaining = budget - monthSpent;
    $('budgetRemaining').textContent = remaining >= 0 ? `${euro.format(remaining)} restants sur ${euro.format(budget)}` : `${euro.format(Math.abs(remaining))} au-dessus du budget`;
    $('budgetProgress').style.width = `${Math.min(100,(monthSpent/budget)*100)}%`;
  } else {
    $('budgetRemaining').textContent = 'Aucun budget défini';
    $('budgetProgress').style.width = '0%';
  }
  renderList();
  drawChart();
}

function currentFilteredRows() {
  const q = $('searchInput').value.trim().toLowerCase();
  const range = $('rangeSelect').value;
  return transactions.filter(t => {
    const matchesQ = !q || `${t.merchant} ${t.category} ${t.note}`.toLowerCase().includes(q);
    const matchesRange = range==='all' || (range==='month' ? isSameMonth(t.date) : sinceDays(t.date, Number(range)));
    return matchesQ && matchesRange;
  });
}

function renderList() {
  const rows = currentFilteredRows();
  $('emptyState').classList.toggle('hidden', rows.length>0);
  $('transactionList').innerHTML = rows.map(t => `
    <div class="transaction" data-id="${t.id}">
      <div class="category-dot" title="${escapeHtml(t.category)}"></div>
      <div class="tx-main"><strong>${escapeHtml(t.merchant)}</strong><span>${dayFmt.format(new Date(t.date+'T12:00:00'))} · ${escapeHtml(t.category)}</span></div>
      <div class="tx-amount">− ${euro.format(t.amount)}</div>
      <button class="delete-btn" data-delete="${t.id}" aria-label="Supprimer">×</button>
    </div>`).join('');
}

function escapeHtml(s='') { return String(s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

function drawChart() {
  const canvas = $('spendChart'); const rect = canvas.getBoundingClientRect(); const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(rect.width*dpr)); canvas.height = Math.max(1, Math.round(rect.height*dpr));
  const ctx = canvas.getContext('2d'); ctx.scale(dpr,dpr); const w=rect.width,h=rect.height;
  const dates=[]; const values=[]; const map=new Map();
  transactions.filter(t=>sinceDays(t.date,30)).forEach(t=>map.set(t.date,(map.get(t.date)||0)+t.amount));
  for(let i=29;i>=0;i--){ const d=new Date(); d.setDate(d.getDate()-i); const key=localDateISO(d); dates.push(key); values.push(map.get(key)||0); }
  const max=Math.max(...values,1); const gap=3; const bw=(w-gap*(values.length-1))/values.length;
  ctx.clearRect(0,0,w,h); ctx.fillStyle='#272d35'; ctx.fillRect(0,h-1,w,1);
  values.forEach((v,i)=>{ const bh=(v/max)*(h-18); ctx.fillStyle=v>0?'#d9ff57':'#232830'; ctx.fillRect(i*(bw+gap), h-bh, Math.max(1,bw), bh); });
  $('chartTotal').textContent = euro.format(values.reduce((a,b)=>a+b,0));
}

function showToast(msg) { const el=$('toast'); el.textContent=msg; el.classList.add('show'); clearTimeout(showToast.t); showToast.t=setTimeout(()=>el.classList.remove('show'),2200); }

function setupCategories() { $('categoryInput').innerHTML = CATEGORIES.map(c=>`<option>${c}</option>`).join(''); }

function parseCsvLine(line, sep) {
  const cells=[]; let cur=''; let quoted=false;
  for(let i=0;i<line.length;i++){ const c=line[i]; if(c==='"'){ if(quoted&&line[i+1]==='"'){cur+='"';i++;} else quoted=!quoted; } else if(c===sep&&!quoted){cells.push(cur);cur='';} else cur+=c; }
  cells.push(cur); return cells.map(c=>c.trim());
}
function normalizeHeader(h) { return h.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,' '); }
function parseDateCell(value) {
  const s=String(value||'').trim();
  let m=s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if(m){ let y=Number(m[3]); if(y<100)y+=2000; return `${y}-${String(m[2]).padStart(2,'0')}-${String(m[1]).padStart(2,'0')}`; }
  m=s.match(/^(\d{4})-(\d{2})-(\d{2})/); if(m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
function parseCsv(text) {
  const lines=text.replace(/^\uFEFF/,'').split(/\r?\n/).filter(l=>l.trim()); if(lines.length<2) throw new Error('CSV vide');
  const sep=(lines[0].match(/;/g)||[]).length >= (lines[0].match(/,/g)||[]).length ? ';' : ',';
  const headers=parseCsvLine(lines[0],sep).map(normalizeHeader);
  const find=(patterns)=>headers.findIndex(h=>patterns.some(p=>h.includes(p)));
  const dateI=find(['date','operation']);
  const amountI=find(['montant','amount','debit','débit']);
  const debitI=find(['debit','débit']); const creditI=find(['credit','crédit']);
  const merchantI=find(['libelle','libellé','description','commercant','commerçant','merchant','nom']);
  if(dateI<0 || merchantI<0 || (amountI<0 && debitI<0)) throw new Error('Colonnes date / montant / libellé introuvables');
  const out=[];
  for(const line of lines.slice(1)){
    const cells=parseCsvLine(line,sep); const date=parseDateCell(cells[dateI]); const merchant=(cells[merchantI]||'').trim();
    let rawAmount = amountI>=0 ? cells[amountI] : cells[debitI];
    if (debitI>=0 && creditI>=0 && !cells[debitI]) continue;
    const signed = Number(String(rawAmount||'').replace(/\s/g,'').replace(',','.').replace(/[^0-9.-]/g,''));
    if (Number.isFinite(signed) && signed > 0 && headers[amountI]?.includes('amount')) { /* keep */ }
    if(!date||!merchant) continue; const amount=parseAmount(rawAmount); if(!Number.isFinite(amount)||amount===0) continue;
    out.push(makeRow({amount,merchant,date,category:inferCategory(merchant),source:'csv'}));
  }
  return out;
}

$('addBtn').addEventListener('click',()=>{ $('dateInput').value=localDateISO(); $('transactionDialog').showModal(); setTimeout(()=>$('amountInput').focus(),50); });
$('transactionForm').addEventListener('submit',async(e)=>{ e.preventDefault(); const amount=parseAmount($('amountInput').value); if(!Number.isFinite(amount)||amount<=0)return showToast('Montant invalide'); const row=makeRow({amount,merchant:$('merchantInput').value,date:$('dateInput').value,category:$('categoryInput').value,note:$('noteInput').value}); try{await putTransaction(row); $('transactionForm').reset(); $('transactionDialog').close(); await refresh(); showToast('Dépense ajoutée');}catch(err){showToast(err?.name==='ConstraintError'?'Transaction déjà présente':'Erreur d’enregistrement');} });
$('editBudgetBtn').addEventListener('click',async()=>{ const b=await getSetting('monthlyBudget',''); $('budgetInput').value=b||''; $('budgetDialog').showModal(); });
$('budgetForm').addEventListener('submit',async(e)=>{ e.preventDefault(); const b=parseAmount($('budgetInput').value); if(!Number.isFinite(b))return; await setSetting('monthlyBudget',b); $('budgetDialog').close(); await render(); showToast('Budget enregistré'); });
$('searchInput').addEventListener('input',renderList); $('rangeSelect').addEventListener('change',renderList);
$('transactionList').addEventListener('click',async(e)=>{ const id=e.target.dataset.delete; if(!id)return; await deleteTransaction(id); await refresh(); showToast('Transaction supprimée'); });
$('importBtn').addEventListener('click',()=>{ pendingCsvRows=[]; $('csvFileInput').value=''; $('importPreview').textContent=''; $('confirmImportBtn').disabled=true; $('importDialog').showModal(); });
$('csvFileInput').addEventListener('change',async(e)=>{ const file=e.target.files[0]; if(!file)return; try{pendingCsvRows=parseCsv(await file.text()); $('importPreview').textContent=`${pendingCsvRows.length} dépense(s) détectée(s).`; $('confirmImportBtn').disabled=pendingCsvRows.length===0;}catch(err){pendingCsvRows=[];$('importPreview').textContent=err.message;$('confirmImportBtn').disabled=true;} });
$('confirmImportBtn').addEventListener('click',async()=>{ const added=await addManyTransactions(pendingCsvRows); $('importDialog').close(); await refresh(); showToast(`${added} transaction(s) importée(s)`); });
$('exportBtn').addEventListener('click',async()=>{ const payload={version:1,exportedAt:new Date().toISOString(),settings:{monthlyBudget:await getSetting('monthlyBudget',0)},transactions}; const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}); const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`spendline-${localDateISO()}.json`;a.click();URL.revokeObjectURL(a.href); });
$('restoreBtn').addEventListener('click',()=>$('jsonFileInput').click());
$('jsonFileInput').addEventListener('change',async(e)=>{ const file=e.target.files[0]; if(!file)return; try{const data=JSON.parse(await file.text()); if(!Array.isArray(data.transactions))throw new Error(); await clearTransactions(); await addManyTransactions(data.transactions); if(data.settings?.monthlyBudget!=null)await setSetting('monthlyBudget',data.settings.monthlyBudget); await refresh();showToast('Sauvegarde restaurée');}catch{showToast('Fichier de sauvegarde invalide');}finally{e.target.value='';} });
$('demoBtn').addEventListener('click',async()=>{ const names=[['Bio c’ Bon',18.42],['RATP',2.15],['Boulangerie',6.8],['Monoprix',32.7],['Cinéma',13.5],['Café',4.2],['Pharmacie',9.9]]; const rows=names.map((x,i)=>{const d=new Date();d.setDate(d.getDate()-i*2);return makeRow({amount:x[1],merchant:x[0],date:localDateISO(d),category:inferCategory(x[0]),source:'demo'});}); const n=await addManyTransactions(rows);await refresh();showToast(`${n} exemple(s) ajouté(s)`); });
window.addEventListener('resize',()=>requestAnimationFrame(drawChart));
window.addEventListener('beforeinstallprompt',(e)=>{e.preventDefault();deferredInstallPrompt=e;$('installBtn').classList.remove('hidden');});
$('installBtn').addEventListener('click',async()=>{if(!deferredInstallPrompt)return;deferredInstallPrompt.prompt();await deferredInstallPrompt.userChoice;deferredInstallPrompt=null;$('installBtn').classList.add('hidden');});
if('serviceWorker' in navigator) window.addEventListener('load',()=>navigator.serviceWorker.register('./sw.js'));
setupCategories();
await refresh();