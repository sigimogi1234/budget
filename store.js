import { firebaseConfig } from './firebase-config.js';

export const DEFAULT_SETTINGS = {
  names: { groom: '신랑', bride: '신부' },
  categories: [
    { name: '식비', subs: ['장보기', '외식', '배달', '카페/간식'] },
    { name: '주거/공과금', subs: ['월세/관리비', '전기/가스/수도', '통신비'] },
    { name: '교통', subs: ['대중교통', '주유', '주차/통행료'] },
    { name: '생활', subs: ['생활용품', '의류/잡화', '미용'] },
    { name: '문화/여가', subs: ['여행', '취미', '구독서비스'] },
    { name: '경조사/선물', subs: ['경조사비', '선물'] },
    { name: '의료/건강', subs: ['병원', '약국', '운동'] },
    { name: '기타', subs: ['기타'] },
  ],
  cards: [],
  budget: { default: { expense: 0, emergency: 0 }, months: {}, applyBenefit: false },
};

export const clone = (o) => JSON.parse(JSON.stringify(o));

export function normalizeSettings(s) {
  const d = clone(DEFAULT_SETTINGS);
  s = s || {};
  return {
    names: { ...d.names, ...(s.names || {}) },
    categories: Array.isArray(s.categories) ? s.categories : d.categories,
    cards: Array.isArray(s.cards) ? s.cards : [],
    budget: {
      default: { ...d.budget.default, ...(s.budget?.default || {}) },
      months: s.budget?.months || {},
      applyBenefit: !!s.budget?.applyBenefit,
    },
  };
}

export const isCloudConfigured = () => !!(firebaseConfig && firebaseConfig.apiKey && firebaseConfig.projectId);

const LS_CODE = 'budget.code';
export const LS_LOCAL = 'budget.local.v1';

export function getCode() {
  const m = location.hash.match(/code=([A-Za-z0-9_-]{16,})/);
  if (m) {
    try { localStorage.setItem(LS_CODE, m[1]); } catch {}
    return m[1];
  }
  let c = '';
  try { c = localStorage.getItem(LS_CODE) || ''; } catch {}
  if (c) history.replaceState(null, '', location.pathname + location.search + '#code=' + c);
  return c;
}
export function setCode(c) {
  try { localStorage.setItem(LS_CODE, c); } catch {}
  history.replaceState(null, '', location.pathname + location.search + '#code=' + c);
}
export function clearCode() {
  try { localStorage.removeItem(LS_CODE); } catch {}
  history.replaceState(null, '', location.pathname + location.search);
}
export function newCode() {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const a = new Uint8Array(20);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => abc[b % 32]).join('');
}
export const shareLink = (code) => location.origin + location.pathname + '#code=' + code;

export function readLocalData() {
  try {
    const r = JSON.parse(localStorage.getItem(LS_LOCAL) || 'null');
    return { entries: r?.entries || [], settings: normalizeSettings(r?.settings) };
  } catch {
    return { entries: [], settings: normalizeSettings() };
  }
}

export async function createStore({ onData, onStatus }) {
  if (!isCloudConfigured()) return localStore(onData, onStatus);
  return cloudStore(getCode(), onData, onStatus);
}

function localStore(onData, onStatus) {
  let st = readLocalData();
  const save = () => {
    try { localStorage.setItem(LS_LOCAL, JSON.stringify(st)); }
    catch { onStatus('error', '브라우저 저장 실패'); }
    onData(clone(st));
  };
  const upsert = (e) => {
    const i = st.entries.findIndex((x) => x.id === e.id);
    if (i >= 0) st.entries[i] = e; else st.entries.push(e);
  };
  onStatus('local');
  onData(clone(st));
  addEventListener('storage', (ev) => {
    if (ev.key === LS_LOCAL) { st = readLocalData(); onData(clone(st)); }
  });
  return {
    mode: 'local',
    put(e) { upsert(e); save(); },
    remove(id) { st.entries = st.entries.filter((x) => x.id !== id); save(); },
    saveSettings(s) { st.settings = s; save(); },
    async bulkPut(list) { list.forEach(upsert); save(); },
  };
}

async function cloudStore(code, onData, onStatus) {
  onStatus('connecting');
  const base = 'https://www.gstatic.com/firebasejs/10.12.2/';
  const [{ initializeApp }, A, F] = await Promise.all([
    import(base + 'firebase-app.js'),
    import(base + 'firebase-auth.js'),
    import(base + 'firebase-firestore.js'),
  ]);
  const app = initializeApp(firebaseConfig);
  await A.signInAnonymously(A.getAuth(app));
  let db;
  try {
    db = F.initializeFirestore(app, {
      localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }),
    });
  } catch {
    db = F.getFirestore(app);
  }
  const col = F.collection(db, 'households', code, 'entries');
  const sref = F.doc(db, 'households', code, 'meta', 'settings');
  let entries = [], settings = normalizeSettings(), gotE = false, gotS = false;
  const emit = () => { if (gotE && gotS) onData({ entries, settings: clone(settings) }); };
  const fail = (err) => onStatus('error', err.code || err.message);

  F.onSnapshot(col, { includeMetadataChanges: true }, (snap) => {
    entries = snap.docs.map((d) => ({ ...d.data(), id: d.id }));
    gotE = true;
    onStatus(snap.metadata.hasPendingWrites ? 'pending' : snap.metadata.fromCache ? 'offline' : 'synced');
    emit();
  }, fail);
  F.onSnapshot(sref, (snap) => {
    if (snap.exists()) settings = normalizeSettings(snap.data());
    else if (!snap.metadata.fromCache) F.setDoc(sref, clone(DEFAULT_SETTINGS)).catch(fail);
    gotS = true;
    emit();
  }, fail);

  const strip = ({ id, ...rest }) => rest;
  return {
    mode: 'cloud',
    code,
    put(e) { F.setDoc(F.doc(col, e.id), strip(e)).catch(fail); },
    remove(id) { F.deleteDoc(F.doc(col, id)).catch(fail); },
    saveSettings(s) { F.setDoc(sref, s).catch(fail); },
    async bulkPut(list) {
      for (let i = 0; i < list.length; i += 400) {
        const b = F.writeBatch(db);
        list.slice(i, i + 400).forEach((e) => b.set(F.doc(col, e.id), strip(e)));
        await b.commit();
      }
    },
  };
}
