import {
  createStore, isCloudConfigured, getCode, setCode, clearCode, newCode, shareLink,
  DEFAULT_SETTINGS, clone, normalizeSettings, readLocalData, LS_LOCAL,
} from './store.js';

/* ---------- helpers ---------- */
const $ = (s, el = document) => el.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const curYM = () => todayStr().slice(0, 7);
const shiftYM = (ym, k) => {
  let [y, m] = ym.split('-').map(Number);
  m += k;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  return `${y}-${pad(m)}`;
};
const ymLabel = (ym) => `${+ym.slice(0, 4)}년 ${+ym.slice(5)}월`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (n ? Math.round(n).toLocaleString('ko-KR') : '');
const won = (n) => Math.round(n || 0).toLocaleString('ko-KR') + '원';
const num = (v) => { const n = Number(String(v ?? '').replace(/[^\d.-]/g, '')); return Number.isFinite(n) ? n : 0; };
const sum = (a) => a.reduce((s, e) => s + (Number(e.amount) || 0), 0);
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
const KIND_LABEL = { income: '수입', expense: '지출', saving: '저축' };

/* ---------- state ---------- */
const LS_UI = 'budget.ui';
const ui = { tab: 'summary', ym: curYM(), filter: { income: 'all', expense: 'all', saving: 'all' }, me: 'groom' };
try { const s = JSON.parse(localStorage.getItem(LS_UI) || '{}'); Object.assign(ui, { tab: s.tab || ui.tab, filter: { ...ui.filter, ...(s.filter || {}) }, me: s.me || ui.me }); } catch {}
const saveUI = () => { try { localStorage.setItem(LS_UI, JSON.stringify({ tab: ui.tab, filter: ui.filter, me: ui.me })); } catch {} };

let S = { entries: [], settings: normalizeSettings(DEFAULT_SETTINGS) };
let store = null;

const nm = (o) => (o === 'shared' ? '공용' : (S.settings.names?.[o] || (o === 'groom' ? '신랑' : '신부')));

/* ---------- calculations ---------- */
function budgetFor(ym) {
  const b = S.settings.budget;
  const o = b.months?.[ym] || {};
  return { expense: o.expense ?? b.default.expense ?? 0, emergency: o.emergency ?? b.default.emergency ?? 0, custom: !!b.months?.[ym] };
}

function calc(ym) {
  const inM = (k, m = ym) => S.entries.filter((e) => e.kind === k && (e.date || '').startsWith(m));
  const inc = inM('income'), exp = inM('expense'), sav = inM('saving');
  const prevExp = inM('expense', shiftYM(ym, -1));
  const cards = S.settings.cards.map((c) => {
    const spend = sum(exp.filter((e) => e.card === c.id));
    const prev = sum(prevExp.filter((e) => e.card === c.id));
    const met = !c.minSpend || prev >= c.minSpend;
    let benefit = met ? (spend * (Number(c.rate) || 0)) / 100 : 0;
    if (c.cap) benefit = Math.min(benefit, c.cap);
    return { card: c, spend, prev, met, benefit: Math.floor(benefit) };
  });
  const ratio = Object.fromEntries(cards.map((r) => [r.card.id, r.spend ? r.benefit / r.spend : 0]));
  const benOf = (l) => l.reduce((s, e) => s + (Number(e.amount) || 0) * (ratio[e.card] || 0), 0);
  const normal = exp.filter((e) => !e.emergency), emerg = exp.filter((e) => e.emergency);
  const apply = !!S.settings.budget.applyBenefit;
  const by = (l, o) => sum(l.filter((e) => e.owner === o));
  const end = ym + '-31';
  const cum = (o) => sum(S.entries.filter((e) => e.kind === 'saving' && e.owner === o && (e.date || '') <= end));
  const cats = {};
  exp.forEach((e) => { const k = e.major || '미분류'; cats[k] = (cats[k] || 0) + (Number(e.amount) || 0); });
  return {
    inc, exp, sav, cards, cats,
    income: { groom: by(inc, 'groom'), bride: by(inc, 'bride'), total: sum(inc) },
    expense: { groom: by(exp, 'groom'), bride: by(exp, 'bride'), shared: by(exp, 'shared'), emergency: sum(emerg), normal: sum(normal), total: sum(exp) },
    saving: { groom: by(sav, 'groom'), bride: by(sav, 'bride'), total: sum(sav) },
    cumSaving: { groom: cum('groom'), bride: cum('bride') },
    budget: { ...budgetFor(ym), normalUsed: sum(normal) - (apply ? benOf(normal) : 0), emergUsed: sum(emerg) - (apply ? benOf(emerg) : 0), apply },
    benefit: cards.reduce((s, r) => s + r.benefit, 0),
  };
}

/* ---------- render ---------- */
const TABS = [['summary', '요약'], ['income', '수입'], ['expense', '지출'], ['saving', '저축'], ['year', '연간'], ['settings', '설정']];

function render() {
  pendingRender = false;
  $('#tabs').innerHTML = TABS.map(([k, l]) => `<button class="tab ${ui.tab === k ? 'on' : ''}" data-act="tab" data-v="${k}" ${ui.tab === k ? 'aria-current="page"' : ''}>${l}</button>`).join('');
  const isYear = ui.tab === 'year';
  $('#monthbar').hidden = false;
  $('#monthbar').innerHTML = `<button class="nav" data-act="shift" data-v="${isYear ? -12 : -1}" aria-label="이전">‹</button>
    <button class="cur" data-act="thisMonth" title="이번 달로">${isYear ? ui.ym.slice(0, 4) + '년' : ymLabel(ui.ym)}</button>
    <button class="nav" data-act="shift" data-v="${isYear ? 12 : 1}" aria-label="다음">›</button>`;
  const views = { summary: viewSummary, income: () => viewList('income'), expense: () => viewList('expense'), saving: () => viewList('saving'), year: viewYear, settings: viewSettings };
  $('#view').innerHTML = views[ui.tab]();
}

let pendingRender = false;
function scheduleRender() {
  const a = document.activeElement;
  if (a && $('#view').contains(a) && /INPUT|SELECT|TEXTAREA/.test(a.tagName)) { pendingRender = true; return; }
  render();
}

function bar(label, used, budget) {
  if (!budget) return `<div class="bud"><div class="bud-h"><span>${label}</span><span class="muted">예산 미설정 · 설정 탭에서 입력</span></div><div class="bud-h"><span class="muted">사용</span><b>${won(used)}</b></div></div>`;
  const left = budget - used;
  const pct = Math.min(100, Math.max(0, (used / budget) * 100));
  const cls = left < 0 ? 'over' : pct >= 80 ? 'warn' : '';
  return `<div class="bud ${cls}">
    <div class="bud-h"><span>${label}</span><span class="muted">${won(used)} / ${won(budget)}</span></div>
    <div class="track" role="progressbar" aria-valuenow="${Math.round(pct)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${pct}%"></i></div>
    <div class="bud-left">${left >= 0 ? `남은 금액 <b>${won(left)}</b>` : `<b>${won(-left)}</b> 초과`}</div>
  </div>`;
}

function kpi(title, total, rows, cls) {
  return `<div class="kpi ${cls}"><div class="kpi-t">${title}</div><div class="kpi-v">${won(total)}</div>
    <dl>${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v === null ? '' : won(v)}</dd></div>`).join('')}</dl></div>`;
}

function localNotice() {
  return store?.mode === 'local'
    ? `<div class="notice">지금은 <b>로컬 모드</b>라 이 브라우저에만 저장돼요. 둘이 함께 쓰려면 <a href="#" data-act="tab" data-v="settings">설정 › 공유</a>를 확인하세요.</div>`
    : '';
}

function viewSummary() {
  const c = calc(ui.ym);
  const balance = c.income.total - c.expense.total - c.saving.total;
  const cumTotal = c.cumSaving.groom + c.cumSaving.bride;
  const catRows = Object.entries(c.cats).sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(1, ...catRows.map((r) => r[1]));
  return `${localNotice()}
  <section class="kpis">
    ${kpi('수입', c.income.total, [[nm('groom'), c.income.groom], [nm('bride'), c.income.bride]], 'inc')}
    ${kpi('지출', c.expense.total, [[nm('groom') + ' 개인', c.expense.groom], [nm('bride') + ' 개인', c.expense.bride], ['공용', c.expense.shared], ['그중 비상금', c.expense.emergency]], 'exp')}
    ${kpi('저축', c.saving.total, [[nm('groom'), c.saving.groom], [nm('bride'), c.saving.bride]], 'sav')}
    ${kpi('남은 돈', balance, [['수입 − 지출 − 저축', null], ...(c.benefit ? [['예상 카드 혜택', c.benefit]] : [])], balance < 0 ? 'neg' : 'bal')}
  </section>
  <div class="cols">
    <section class="card">
      <h3>예산 <small class="muted">${c.budget.custom ? '이번 달 개별 예산' : '기본 예산'}${c.budget.apply ? ' · 카드 혜택 차감' : ''}</small></h3>
      ${bar('지출 예산 (개인+공용)', c.budget.normalUsed, c.budget.expense)}
      ${bar('비상금 예산 (변동 지출)', c.budget.emergUsed, c.budget.emergency)}
    </section>
    <section class="card">
      <h3>누적 저축 <small class="muted">${ymLabel(ui.ym)}까지</small></h3>
      <div class="big">${won(cumTotal)}</div>
      <div class="split">
        <div><span class="dot groom"></span>${esc(nm('groom'))}<b>${won(c.cumSaving.groom)}</b></div>
        <div><span class="dot bride"></span>${esc(nm('bride'))}<b>${won(c.cumSaving.bride)}</b></div>
      </div>
      ${cumTotal ? `<div class="stack"><i class="groom" style="width:${(c.cumSaving.groom / cumTotal) * 100}%"></i><i class="bride" style="width:${(c.cumSaving.bride / cumTotal) * 100}%"></i></div>` : ''}
    </section>
  </div>
  <div class="cols">
    <section class="card">
      <h3>분류별 지출</h3>
      ${catRows.length ? `<div class="hbars">${catRows.map(([k, v]) => `<div class="hb"><span>${esc(k)}</span><div class="hb-t"><i style="width:${(v / catMax) * 100}%"></i></div><b>${won(v)}</b></div>`).join('')}</div>` : '<p class="empty">이번 달 지출이 없어요.</p>'}
    </section>
    <section class="card">
      <h3>카드별 사용 · 예상 혜택</h3>
      ${cardTable(c.cards)}
    </section>
  </div>`;
}

function cardTable(rows) {
  if (!rows.length) return `<p class="empty">설정 탭에서 카드와 혜택률을 등록하면 카드별 예상 할인·캐시백을 계산해요.</p>`;
  const total = rows.reduce((s, r) => s + r.benefit, 0);
  return `<div class="tbl-wrap"><table class="tbl">
    <thead><tr><th>카드</th><th>사용액</th><th>혜택</th><th>예상 혜택</th></tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td>${esc(r.card.name)}<div class="sub">${esc(nm(r.card.owner || 'shared'))}${r.card.minSpend ? ` · 전월실적 ${r.met ? '충족' : `<span class="bad">미달(${won(r.prev)})</span>`}` : ''}</div></td>
      <td>${won(r.spend)}</td>
      <td>${Number(r.card.rate) || 0}%${r.card.cap ? `<div class="sub">한도 ${won(r.card.cap)}</div>` : ''}</td>
      <td><b>${won(r.benefit)}</b></td></tr>`).join('')}</tbody>
    <tfoot><tr><td colspan="3">합계</td><td><b>${won(total)}</b></td></tr></tfoot>
  </table></div>`;
}

function cardName(id) {
  if (!id) return '현금/이체';
  return S.settings.cards.find((c) => c.id === id)?.name || '(삭제된 카드)';
}

function viewList(kind) {
  const c = calc(ui.ym);
  const all = c[{ income: 'inc', expense: 'exp', saving: 'sav' }[kind]];
  const f = ui.filter[kind];
  const chips = kind === 'expense'
    ? [['all', '전체'], ['groom', nm('groom') + ' 개인'], ['bride', nm('bride') + ' 개인'], ['shared', '공용'], ['emergency', '비상금']]
    : [['all', '전체'], ['groom', nm('groom')], ['bride', nm('bride')]];
  const pick = (k) => (k === 'all' ? all : k === 'emergency' ? all.filter((e) => e.emergency) : all.filter((e) => e.owner === k));
  const list = [...pick(f)].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));

  let top = '';
  if (kind === 'expense') {
    top = `<section class="card slim">${bar('지출 예산', c.budget.normalUsed, c.budget.expense)}${bar('비상금 예산', c.budget.emergUsed, c.budget.emergency)}</section>`;
  } else if (kind === 'saving') {
    top = `<section class="card slim"><div class="split three">
      <div>${esc(nm('groom'))} 누적<b>${won(c.cumSaving.groom)}</b></div>
      <div>${esc(nm('bride'))} 누적<b>${won(c.cumSaving.bride)}</b></div>
      <div>둘이 합친 총 저축<b class="accent">${won(c.cumSaving.groom + c.cumSaving.bride)}</b></div></div></section>`;
  }

  return `${localNotice()}${top}
  <div class="list-h">
    <div class="chips" role="tablist">${chips.map(([k, l]) => `<button class="chip-f ${f === k ? 'on' : ''}" data-act="filter" data-kind="${kind}" data-v="${k}">${esc(l)}<small>${won(sum(pick(k)))}</small></button>`).join('')}</div>
    <button class="btn primary" data-act="add" data-kind="${kind}">+ ${KIND_LABEL[kind]} 추가</button>
  </div>
  <section class="list">
    ${list.length ? list.map((e) => row(e, kind)).join('') : `<p class="empty">${ymLabel(ui.ym)} ${KIND_LABEL[kind]} 내역이 없어요.</p>`}
  </section>`;
}

function row(e, kind) {
  const cat = kind === 'income' ? e.cat : kind === 'expense' ? [e.major, e.minor].filter(Boolean).join(' › ') : '';
  const sub = [cat, kind === 'expense' ? cardName(e.card) : '', e.note].filter(Boolean).map(esc).join(' · ');
  return `<button class="row" data-act="edit" data-id="${esc(e.id)}">
    <span class="r-date">${+e.date.slice(5, 7)}.${+e.date.slice(8, 10)}</span>
    <span class="r-main">
      <span class="r-title"><span class="badge ${e.owner}">${esc(e.owner === 'shared' ? '공용' : nm(e.owner))}</span>${e.emergency ? '<span class="badge em">비상금</span>' : ''}${esc(e.desc || KIND_LABEL[kind])}</span>
      ${sub ? `<span class="r-sub">${sub}</span>` : ''}
    </span>
    <span class="r-amt ${kind}">${won(e.amount)}</span>
  </button>`;
}

function viewYear() {
  const y = ui.ym.slice(0, 4);
  const ms = Array.from({ length: 12 }, (_, i) => { const ym = `${y}-${pad(i + 1)}`; return { ym, c: calc(ym) }; });
  const T = (f) => ms.reduce((s, m) => s + f(m.c), 0);
  const tot = { inc: T((c) => c.income.total), exp: T((c) => c.expense.total), sav: T((c) => c.saving.total), ben: T((c) => c.benefit) };
  const max = Math.max(1, ...ms.flatMap((m) => [m.c.income.total, m.c.expense.total, m.c.saving.total]));
  const h = (v) => Math.round((v / max) * 100);
  const cats = {};
  ms.forEach((m) => Object.entries(m.c.cats).forEach(([k, v]) => { cats[k] = (cats[k] || 0) + v; }));
  const catRows = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  const catMax = Math.max(1, ...catRows.map((r) => r[1]));
  const cardTot = {};
  ms.forEach((m) => m.c.cards.forEach((r) => { const t = (cardTot[r.card.id] ||= { name: r.card.name, spend: 0, benefit: 0 }); t.spend += r.spend; t.benefit += r.benefit; }));
  const lastC = ms[11].c;
  return `${localNotice()}
  <section class="kpis">
    ${kpi(`${y}년 수입`, tot.inc, [[nm('groom'), T((c) => c.income.groom)], [nm('bride'), T((c) => c.income.bride)]], 'inc')}
    ${kpi(`${y}년 지출`, tot.exp, [[nm('groom') + ' 개인', T((c) => c.expense.groom)], [nm('bride') + ' 개인', T((c) => c.expense.bride)], ['공용', T((c) => c.expense.shared)], ['그중 비상금', T((c) => c.expense.emergency)]], 'exp')}
    ${kpi(`${y}년 저축`, tot.sav, [[nm('groom'), T((c) => c.saving.groom)], [nm('bride'), T((c) => c.saving.bride)], ['연말 누적 총액', lastC.cumSaving.groom + lastC.cumSaving.bride]], 'sav')}
    ${kpi('남은 돈', tot.inc - tot.exp - tot.sav, [['예상 카드 혜택', tot.ben]], tot.inc - tot.exp - tot.sav < 0 ? 'neg' : 'bal')}
  </section>
  <section class="card">
    <h3>월별 흐름 <small class="muted">막대를 누르면 그 달로 이동</small></h3>
    <div class="chart">${ms.map((m) => `<button class="col" data-act="gotoMonth" data-v="${m.ym}" aria-label="${ymLabel(m.ym)}: 수입 ${won(m.c.income.total)}, 지출 ${won(m.c.expense.total)}, 저축 ${won(m.c.saving.total)}">
      <span class="bars"><i class="b inc" style="height:${h(m.c.income.total)}%"></i><i class="b exp" style="height:${h(m.c.expense.total)}%"></i><i class="b sav" style="height:${h(m.c.saving.total)}%"></i></span>
      <span class="lbl">${+m.ym.slice(5)}월</span></button>`).join('')}</div>
    <div class="legend"><span><i class="inc"></i>수입</span><span><i class="exp"></i>지출</span><span><i class="sav"></i>저축</span></div>
  </section>
  <section class="card">
    <h3>월별 정리</h3>
    <div class="tbl-wrap"><table class="tbl num">
      <thead><tr><th>월</th><th>수입</th><th>지출</th><th>저축</th><th>남은 돈</th><th>예산 대비</th></tr></thead>
      <tbody>${ms.map((m) => { const b = m.c.budget, bal = m.c.income.total - m.c.expense.total - m.c.saving.total; return `<tr class="click" data-act="gotoMonth" data-v="${m.ym}">
        <td>${+m.ym.slice(5)}월</td><td>${fmt(m.c.income.total) || '-'}</td><td>${fmt(m.c.expense.total) || '-'}</td><td>${fmt(m.c.saving.total) || '-'}</td>
        <td class="${bal < 0 ? 'bad' : ''}">${bal ? bal.toLocaleString('ko-KR') : '-'}</td>
        <td>${b.expense && m.c.exp.length ? (b.expense - b.normalUsed >= 0 ? `<span class="good">${fmt(b.expense - b.normalUsed) || 0} 남음</span>` : `<span class="bad">${fmt(b.normalUsed - b.expense)} 초과</span>`) : '-'}</td></tr>`; }).join('')}</tbody>
      <tfoot><tr><td>합계</td><td>${fmt(tot.inc) || 0}</td><td>${fmt(tot.exp) || 0}</td><td>${fmt(tot.sav) || 0}</td><td>${(tot.inc - tot.exp - tot.sav).toLocaleString('ko-KR')}</td><td></td></tr></tfoot>
    </table></div>
  </section>
  <div class="cols">
    <section class="card"><h3>분류별 연간 지출</h3>
      ${catRows.length ? `<div class="hbars">${catRows.map(([k, v]) => `<div class="hb"><span>${esc(k)}</span><div class="hb-t"><i style="width:${(v / catMax) * 100}%"></i></div><b>${won(v)}</b></div>`).join('')}</div>` : '<p class="empty">지출 내역이 없어요.</p>'}
    </section>
    <section class="card"><h3>카드별 연간 혜택</h3>
      ${Object.keys(cardTot).length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>카드</th><th>사용액</th><th>예상 혜택</th></tr></thead><tbody>
        ${Object.values(cardTot).map((t) => `<tr><td>${esc(t.name)}</td><td>${won(t.spend)}</td><td><b>${won(t.benefit)}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="2">합계</td><td><b>${won(tot.ben)}</b></td></tr></tfoot></table></div>` : '<p class="empty">등록된 카드가 없어요.</p>'}
    </section>
  </div>`;
}

function viewSettings() {
  const s = S.settings, b = s.budget, mo = b.months?.[ui.ym] || {};
  let hasLocal = false;
  if (store?.mode === 'cloud') hasLocal = readLocalData().entries.length > 0;
  const moneyIn = (attrs, val, ph = '0') => `<input inputmode="numeric" autocomplete="off" ${attrs} value="${fmt(val)}" placeholder="${ph}">`;
  return `
  <section class="card"><h3>이 기기 사용자</h3><p class="muted">내역을 추가할 때 기본으로 선택돼요.</p>
    <div class="seg">${['groom', 'bride'].map((o) => `<label><input type="radio" name="me" value="${o}" data-chg="me" ${ui.me === o ? 'checked' : ''}><span>${esc(nm(o))}</span></label>`).join('')}</div>
  </section>
  <section class="card"><h3>이름</h3><div class="grid2">
    <label class="fld"><span>신랑</span><input data-chg="name" data-k="groom" value="${esc(s.names.groom)}" maxlength="20"></label>
    <label class="fld"><span>신부</span><input data-chg="name" data-k="bride" value="${esc(s.names.bride)}" maxlength="20"></label>
  </div></section>
  <section class="card"><h3>예산</h3>
    <p class="muted">지출 예산은 비상금을 제외한 일반 지출(개인+공용)에, 비상금 예산은 '비상금'으로 표시한 지출에 적용돼요.</p>
    <div class="grid2">
      <label class="fld"><span>기본 월 지출 예산</span>${moneyIn('data-chg="budgetDefault" data-k="expense"', b.default.expense)}</label>
      <label class="fld"><span>기본 월 비상금 예산</span>${moneyIn('data-chg="budgetDefault" data-k="emergency"', b.default.emergency)}</label>
    </div>
    <h4>${ymLabel(ui.ym)}만 다르게 <small class="muted">비우면 기본 예산 사용 · 위쪽 ‹ › 로 월 변경</small></h4>
    <div class="grid2">
      <label class="fld"><span>지출 예산</span>${moneyIn('data-chg="budgetMonth" data-k="expense"', mo.expense, fmt(b.default.expense) || '기본값')}</label>
      <label class="fld"><span>비상금 예산</span>${moneyIn('data-chg="budgetMonth" data-k="emergency"', mo.emergency, fmt(b.default.emergency) || '기본값')}</label>
    </div>
    <label class="check"><input type="checkbox" data-chg="applyBenefit" ${b.applyBenefit ? 'checked' : ''}> 카드 할인·캐시백을 뺀 금액(실질 지출)으로 예산 계산</label>
  </section>
  <section class="card"><h3>지출 분류</h3><p class="muted">대분류를 만들고 그 안에 소분류를 추가하세요. 지출을 입력할 때 이 목록에서 골라요.</p>
    ${s.categories.map((c, i) => `<div class="cat">
      <div class="cat-h"><b>${esc(c.name)}</b><button class="link danger" data-act="delMajor" data-i="${i}">대분류 삭제</button></div>
      <div class="chips">${(c.subs || []).map((sb, j) => `<span class="chip">${esc(sb)}<button data-act="delSub" data-i="${i}" data-j="${j}" aria-label="${esc(sb)} 삭제">×</button></span>`).join('')}
        <span class="addsub"><input placeholder="소분류 추가" data-sub="${i}" maxlength="20" data-enter="addSub"><button class="btn sm" data-act="addSub" data-i="${i}">추가</button></span>
      </div></div>`).join('')}
    <div class="addrow"><input id="newMajor" placeholder="새 대분류 이름" maxlength="20" data-enter="addMajor"><button class="btn" data-act="addMajor">대분류 추가</button></div>
  </section>
  <section class="card"><h3>카드 · 혜택</h3>
    <p class="muted">할인율(또는 캐시백률), 월 혜택 한도, 전월 실적 조건을 적어두면 매달 카드별 사용액으로 예상 혜택을 계산해요. 전월 실적은 이 가계부에 적은 그 카드의 지난달 사용액으로 판단해요.</p>
    ${s.cards.length ? s.cards.map((c) => `<div class="cardrow">
      <label class="fld"><span>카드 이름</span><input data-chg="card" data-id="${c.id}" data-k="name" value="${esc(c.name)}" maxlength="30"></label>
      <label class="fld"><span>사용자</span><select data-chg="card" data-id="${c.id}" data-k="owner">${['groom', 'bride', 'shared'].map((o) => `<option value="${o}" ${c.owner === o ? 'selected' : ''}>${esc(nm(o))}</option>`).join('')}</select></label>
      <label class="fld"><span>혜택률 (%)</span><input inputmode="decimal" data-chg="card" data-id="${c.id}" data-k="rate" value="${c.rate || ''}" placeholder="0"></label>
      <label class="fld"><span>월 혜택 한도</span>${moneyIn(`data-chg="card" data-id="${c.id}" data-k="cap"`, c.cap, '제한 없음')}</label>
      <label class="fld"><span>전월 실적 조건</span>${moneyIn(`data-chg="card" data-id="${c.id}" data-k="minSpend"`, c.minSpend, '없음')}</label>
      <button class="link danger" data-act="delCard" data-id="${c.id}">삭제</button>
    </div>`).join('') : '<p class="empty">등록된 카드가 없어요.</p>'}
    <button class="btn" data-act="addCard">+ 카드 추가</button>
  </section>
  <section class="card"><h3>공유 · 동기화</h3>
    ${store?.mode === 'cloud' ? `<p>아래 링크를 상대방에게 보내면 같은 가계부를 함께 쓸 수 있어요. <b>링크를 가진 사람은 누구나 볼 수 있으니</b> 둘만 공유하세요.</p>
      <div class="addrow"><input readonly id="shareLink" value="${esc(shareLink(store.code))}"><button class="btn primary" data-act="copyLink">링크 복사</button></div>
      ${hasLocal ? `<p class="muted">이 기기에 로컬 모드로 적어둔 내역이 있어요.</p><button class="btn" data-act="migrateLocal">로컬 내역을 공유 가계부로 올리기</button>` : ''}
      <button class="link" data-act="leave">다른 가계부 코드로 전환</button>`
    : `<p>지금은 <b>로컬 모드</b>예요. 이 브라우저에만 저장되고 상대방에게는 보이지 않아요.</p><p class="muted">Firebase를 연결하면 공유 링크가 생기고 둘이 실시간으로 같이 쓸 수 있어요. 방법은 저장소의 README를 보세요.</p>`}
  </section>
  <section class="card"><h3>백업</h3>
    <div class="addrow"><button class="btn" data-act="export">JSON으로 내보내기</button>
    <label class="btn">JSON 가져오기<input type="file" accept="application/json,.json" data-chg="import" hidden></label></div>
    <p class="muted">가져오기는 기존 내역에 추가돼요(같은 항목은 덮어씀). 설정도 백업 파일의 설정으로 바뀌어요.</p>
  </section>`;
}

/* ---------- modal form ---------- */
function majorOpts(sel) {
  const names = S.settings.categories.map((c) => c.name);
  if (sel && !names.includes(sel)) names.push(sel);
  return `<option value="">선택 안 함</option>` + names.map((n) => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
}
function minorOpts(major, sel) {
  const subs = [...(S.settings.categories.find((c) => c.name === major)?.subs || [])];
  if (sel && !subs.includes(sel)) subs.push(sel);
  return `<option value="">선택 안 함</option>` + subs.map((n) => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

function openForm(kind, id) {
  const ex = id ? S.entries.find((e) => e.id === id) : null;
  const f = ui.filter[kind];
  const ownerDefault = f === 'groom' || f === 'bride' || (kind === 'expense' && f === 'shared') ? f : ui.me;
  const e = ex ? { ...ex } : {
    kind, owner: ownerDefault, date: ui.ym === curYM() ? todayStr() : ui.ym + '-01',
    amount: '', desc: '', note: '', cat: '월급', major: '', minor: '', card: '', emergency: kind === 'expense' && f === 'emergency',
  };
  const owners = kind === 'expense' ? ['groom', 'bride', 'shared'] : ['groom', 'bride'];
  const title = KIND_LABEL[kind] + (ex ? ' 수정' : ' 추가');
  const ph = { income: '예: 11월 급여', expense: '예: 마트 장보기', saving: '예: 청년적금' }[kind];
  $('#modal').innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="${title}">
  <form id="entryForm" data-kind="${kind}" data-id="${esc(ex?.id || '')}" novalidate>
    <div class="sheet-h"><h3>${title}</h3><button type="button" class="x" data-act="closeModal" aria-label="닫기">×</button></div>
    <div class="seg">${owners.map((o) => `<label><input type="radio" name="owner" value="${o}" ${e.owner === o ? 'checked' : ''}><span>${esc(o === 'shared' ? '공용' : nm(o) + (kind === 'expense' ? ' 개인' : ''))}</span></label>`).join('')}</div>
    <div class="grid2">
      <label class="fld"><span>날짜</span><input type="date" name="date" value="${esc(e.date)}" required></label>
      <label class="fld"><span>금액 (원)</span><input name="amount" inputmode="numeric" value="${fmt(e.amount)}" placeholder="0" autocomplete="off" required></label>
    </div>
    ${kind === 'income' ? `<label class="fld"><span>분류</span><select name="cat">${['월급', '기타'].map((x) => `<option ${e.cat === x ? 'selected' : ''}>${x}</option>`).join('')}</select></label>` : ''}
    ${kind === 'expense' ? `<div class="grid2">
      <label class="fld"><span>대분류</span><select name="major">${majorOpts(e.major)}</select></label>
      <label class="fld"><span>소분류</span><select name="minor">${minorOpts(e.major, e.minor)}</select></label></div>
      <label class="fld"><span>사용 카드</span><select name="card"><option value="">현금 / 계좌이체</option>${S.settings.cards.map((c) => `<option value="${esc(c.id)}" ${e.card === c.id ? 'selected' : ''}>${esc(c.name)}${c.rate ? ` (${c.rate}%)` : ''}</option>`).join('')}${e.card && !S.settings.cards.some((c) => c.id === e.card) ? `<option value="${esc(e.card)}" selected>(삭제된 카드)</option>` : ''}</select></label>
      <label class="check"><input type="checkbox" name="emergency" ${e.emergency ? 'checked' : ''}> 비상금(변동) 지출 · 비상금 예산에서 차감</label>` : ''}
    <label class="fld"><span>내용</span><input name="desc" value="${esc(e.desc)}" maxlength="60" placeholder="${ph}"></label>
    <label class="fld"><span>비고</span><input name="note" value="${esc(e.note)}" maxlength="100" placeholder="메모"></label>
    <div class="sheet-f">${ex ? `<button type="button" class="link danger" data-act="delEntry" data-id="${esc(ex.id)}">삭제</button>` : ''}<span class="sp"></span>
      <button type="button" class="btn" data-act="closeModal">취소</button><button class="btn primary">저장</button></div>
  </form></div>`;
  $('#modal').hidden = false;
  document.body.classList.add('locked');
  setTimeout(() => $('#entryForm [name=amount]')?.focus(), 30);
}
function closeModal() {
  $('#modal').hidden = true;
  $('#modal').innerHTML = '';
  document.body.classList.remove('locked');
  if (pendingRender) render();
}

/* ---------- actions ---------- */
function updSettings(fn) {
  const s = clone(S.settings);
  fn(s);
  S.settings = s;
  store.saveSettings(s);
}

let toastT;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove('on'), 1800);
}

const STATUS = { local: '로컬 저장 (이 기기만)', connecting: '연결 중…', synced: '동기화됨', pending: '저장 중…', offline: '오프라인 · 연결되면 저장', error: '오류' };
function setStatus(s, msg) {
  const el = $('#sync');
  el.className = 'sync ' + s;
  el.textContent = STATUS[s] + (msg ? ': ' + msg : '');
}

function addMajor() {
  const inp = $('#newMajor');
  const v = inp.value.trim();
  if (!v) return;
  if (S.settings.categories.some((c) => c.name === v)) return toast('이미 있는 대분류예요');
  updSettings((s) => s.categories.push({ name: v, subs: [] }));
  render();
  $('#newMajor')?.focus();
}
function addSub(i) {
  const inp = $(`[data-sub="${i}"]`);
  const v = inp.value.trim();
  if (!v) return;
  if (S.settings.categories[i].subs.includes(v)) return toast('이미 있는 소분류예요');
  updSettings((s) => s.categories[i].subs.push(v));
  render();
  $(`[data-sub="${i}"]`)?.focus();
}

const ACTIONS = {
  tab: (d) => { ui.tab = d.v; saveUI(); render(); scrollTo(0, 0); },
  shift: (d) => { ui.ym = shiftYM(ui.ym, +d.v); render(); },
  thisMonth: () => { ui.ym = curYM(); render(); },
  gotoMonth: (d) => { ui.ym = d.v; ui.tab = 'summary'; saveUI(); render(); scrollTo(0, 0); },
  filter: (d) => { ui.filter[d.kind] = d.v; saveUI(); render(); },
  add: (d) => openForm(d.kind),
  edit: (d) => { const e = S.entries.find((x) => x.id === d.id); if (e) openForm(e.kind, e.id); },
  closeModal,
  delEntry: (d) => { if (confirm('이 내역을 삭제할까요?')) { store.remove(d.id); closeModal(); toast('삭제했어요'); } },
  addMajor,
  addSub: (d) => addSub(+d.i),
  delMajor: (d) => { const c = S.settings.categories[+d.i]; if (confirm(`'${c.name}' 대분류를 삭제할까요? (이미 적은 내역은 그대로 남아요)`)) { updSettings((s) => s.categories.splice(+d.i, 1)); render(); } },
  delSub: (d) => { updSettings((s) => s.categories[+d.i].subs.splice(+d.j, 1)); render(); },
  addCard: () => { updSettings((s) => s.cards.push({ id: uid(), name: '새 카드', owner: ui.me, rate: 0, cap: 0, minSpend: 0 })); render(); const ins = document.querySelectorAll('.cardrow input[data-k="name"]'); ins[ins.length - 1]?.select(); },
  delCard: (d) => { const c = S.settings.cards.find((x) => x.id === d.id); if (confirm(`'${c?.name}' 카드를 삭제할까요?`)) { updSettings((s) => { s.cards = s.cards.filter((x) => x.id !== d.id); }); render(); } },
  copyLink: async () => { const v = $('#shareLink').value; try { await navigator.clipboard.writeText(v); toast('링크를 복사했어요'); } catch { $('#shareLink').select(); toast('링크를 길게 눌러 복사하세요'); } },
  leave: () => { if (confirm('이 기기에서 현재 가계부 연결을 해제할까요? (데이터는 지워지지 않아요. 공유 링크로 다시 들어올 수 있어요)')) { clearCode(); location.reload(); } },
  migrateLocal: async () => { const l = readLocalData(); if (!confirm(`로컬 내역 ${l.entries.length}건을 공유 가계부로 올릴까요?`)) return; await store.bulkPut(l.entries); try { localStorage.removeItem(LS_LOCAL); } catch {} toast('올렸어요'); render(); },
  export: () => {
    const blob = new Blob([JSON.stringify({ app: 'couple-budget', v: 1, exportedAt: new Date().toISOString(), entries: S.entries, settings: S.settings }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `가계부-백업-${todayStr()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  createHousehold: () => { setCode(newCode()); location.reload(); },
  joinHousehold: () => {
    const v = $('#joinCode').value.trim();
    const m = v.match(/(?:code=)?([A-Za-z0-9_-]{16,})\s*$/);
    if (!m) return toast('링크나 코드를 확인해 주세요');
    setCode(m[1]);
    location.reload();
  },
};

function bindEvents() {
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) {
      if (ev.target.id === 'modal') closeModal();
      return;
    }
    if (el.tagName === 'A') ev.preventDefault();
    ACTIONS[el.dataset.act]?.(el.dataset, el);
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && !$('#modal').hidden) closeModal();
    if (ev.key === 'Enter' && ev.target.dataset?.enter && !ev.isComposing) {
      ev.preventDefault();
      if (ev.target.dataset.enter === 'addMajor') addMajor();
      else addSub(+ev.target.dataset.sub);
    }
  });

  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.getAttribute('inputmode') === 'numeric') {
      const n = num(t.value);
      const f = t.value.trim() === '' ? '' : n.toLocaleString('ko-KR');
      if (f !== t.value) t.value = f;
    }
  });

  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.form?.id === 'entryForm' && t.name === 'major') {
      t.form.minor.innerHTML = minorOpts(t.value, '');
      return;
    }
    const a = t.dataset.chg;
    if (!a) return;
    if (a === 'me') { ui.me = t.value; saveUI(); return; }
    if (a === 'name') updSettings((s) => { s.names[t.dataset.k] = t.value.trim() || (t.dataset.k === 'groom' ? '신랑' : '신부'); });
    if (a === 'budgetDefault') updSettings((s) => { s.budget.default[t.dataset.k] = num(t.value); });
    if (a === 'budgetMonth') updSettings((s) => {
      const m = (s.budget.months[ui.ym] ||= {});
      if (t.value.trim() === '') delete m[t.dataset.k]; else m[t.dataset.k] = num(t.value);
      if (!Object.keys(m).length) delete s.budget.months[ui.ym];
    });
    if (a === 'applyBenefit') updSettings((s) => { s.budget.applyBenefit = t.checked; });
    if (a === 'card') updSettings((s) => {
      const c = s.cards.find((x) => x.id === t.dataset.id);
      if (!c) return;
      const k = t.dataset.k;
      c[k] = k === 'name' ? t.value.trim() || '카드' : k === 'owner' ? t.value : num(t.value);
    });
    if (a === 'import') {
      const file = t.files?.[0];
      if (!file) return;
      file.text().then(async (txt) => {
        const d = JSON.parse(txt);
        if (!Array.isArray(d.entries)) throw new Error('형식 오류');
        if (!confirm(`내역 ${d.entries.length}건을 가져올까요?`)) return;
        const list = d.entries.filter((e) => e && e.id && e.kind && e.date).map((e) => JSON.parse(JSON.stringify(e)));
        await store.bulkPut(list);
        if (d.settings) updSettings((s) => Object.assign(s, normalizeSettings(d.settings)));
        toast('가져왔어요');
        render();
      }).catch(() => toast('백업 파일을 읽지 못했어요'));
      t.value = '';
    }
  });

  document.addEventListener('focusout', () => {
    setTimeout(() => {
      const a = document.activeElement;
      if (pendingRender && !($('#view').contains(a) && /INPUT|SELECT|TEXTAREA/.test(a?.tagName))) render();
    }, 200);
  });

  document.addEventListener('submit', (ev) => {
    if (ev.target.id !== 'entryForm') return;
    ev.preventDefault();
    const fm = ev.target, fd = new FormData(fm), kind = fm.dataset.kind;
    const amount = num(fd.get('amount'));
    const date = fd.get('date');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return toast('날짜를 입력하세요');
    if (!(amount > 0)) return toast('금액을 입력하세요');
    const ex = S.entries.find((e) => e.id === fm.dataset.id);
    const e = {
      id: ex?.id || uid(), kind, owner: fd.get('owner') || ui.me, date, amount,
      desc: String(fd.get('desc') || '').trim(), note: String(fd.get('note') || '').trim(),
      createdAt: ex?.createdAt || Date.now(), updatedAt: Date.now(),
    };
    if (kind === 'income') e.cat = fd.get('cat') || '기타';
    if (kind === 'expense') {
      e.major = fd.get('major') || '';
      e.minor = fd.get('minor') || '';
      e.card = fd.get('card') || '';
      e.emergency = !!fd.get('emergency');
    }
    store.put(e);
    if (!date.startsWith(ui.ym)) ui.ym = date.slice(0, 7);
    closeModal();
    render();
    toast(ex ? '수정했어요' : '저장했어요');
  });
}

/* ---------- boot ---------- */
function showSetup() {
  $('#tabs').innerHTML = '';
  $('#monthbar').hidden = true;
  setStatus('connecting');
  $('#sync').textContent = '';
  $('#view').innerHTML = `<section class="card setup">
    <h2>우리 둘의 가계부</h2>
    <p>처음이라면 새 가계부를 만들고, 생성된 링크를 상대방에게 보내 주세요. 상대방에게 받은 링크가 있다면 그 링크로 바로 들어오면 돼요.</p>
    <button class="btn primary lg" data-act="createHousehold">새 가계부 만들기</button>
    <div class="or">또는</div>
    <div class="addrow"><input id="joinCode" placeholder="받은 링크 또는 코드 붙여넣기"><button class="btn" data-act="joinHousehold">참여하기</button></div>
  </section>`;
}

async function boot() {
  bindEvents();
  if (isCloudConfigured() && !getCode()) { showSetup(); return; }
  render();
  try {
    store = await createStore({ onData: (d) => { S = d; scheduleRender(); }, onStatus: setStatus });
  } catch (err) {
    setStatus('error', err.code || err.message);
    $('#view').innerHTML = `<section class="card"><h3>연결하지 못했어요</h3><p>${esc(err.code || err.message)}</p><p class="muted">Firebase 설정(익명 로그인 사용 설정, Firestore 생성, 보안 규칙)을 README대로 했는지 확인해 주세요.</p></section>`;
    return;
  }
  render();
}
boot();
