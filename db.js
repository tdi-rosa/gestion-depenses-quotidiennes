const DB_NAME = 'spendline-db';
const DB_VERSION = 1;
const TX_STORE = 'transactions';
const SETTINGS_STORE = 'settings';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TX_STORE)) {
        const store = db.createObjectStore(TX_STORE, { keyPath: 'id' });
        store.createIndex('date', 'date');
        store.createIndex('fingerprint', 'fingerprint', { unique: true });
      }
      if (!db.objectStoreNames.contains(SETTINGS_STORE)) {
        db.createObjectStore(SETTINGS_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function getTransactions() {
  const db = await openDb();
  const tx = db.transaction(TX_STORE, 'readonly');
  const rows = await request(tx.objectStore(TX_STORE).getAll());
  db.close();
  return rows.sort((a,b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

export async function putTransaction(row) {
  const db = await openDb();
  const tx = db.transaction(TX_STORE, 'readwrite');
  try { await request(tx.objectStore(TX_STORE).put(row)); } finally { db.close(); }
}

export async function addManyTransactions(rows) {
  const db = await openDb();
  const tx = db.transaction(TX_STORE, 'readwrite');
  const store = tx.objectStore(TX_STORE);
  let added = 0;
  for (const row of rows) {
    try { await request(store.add(row)); added++; } catch (e) { if (e?.name !== 'ConstraintError') throw e; }
  }
  db.close();
  return added;
}

export async function deleteTransaction(id) {
  const db = await openDb();
  const tx = db.transaction(TX_STORE, 'readwrite');
  await request(tx.objectStore(TX_STORE).delete(id));
  db.close();
}

export async function clearTransactions() {
  const db = await openDb();
  const tx = db.transaction(TX_STORE, 'readwrite');
  await request(tx.objectStore(TX_STORE).clear());
  db.close();
}

export async function getSetting(key, fallback = null) {
  const db = await openDb();
  const tx = db.transaction(SETTINGS_STORE, 'readonly');
  const row = await request(tx.objectStore(SETTINGS_STORE).get(key));
  db.close();
  return row?.value ?? fallback;
}

export async function setSetting(key, value) {
  const db = await openDb();
  const tx = db.transaction(SETTINGS_STORE, 'readwrite');
  await request(tx.objectStore(SETTINGS_STORE).put({ key, value }));
  db.close();
}