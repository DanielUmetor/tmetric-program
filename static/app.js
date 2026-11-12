/* ===== helpers ===== */
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const weekStart = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7)); // Monday
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const JSON_H = { 'Content-Type': 'application/json' };
const KEY_RE = /^[A-Z][A-Z0-9]+-\d+/;

const fmtHM = (sec) => { const m = Math.floor(sec / 60); return `${Math.floor(m / 60)}:${pad(m % 60)}`; };
const fmtLong = (sec) => {
  const m = Math.floor(sec / 60), h = Math.floor(m / 60);
  return h ? `${h}h ${pad(m % 60)}m` : `${m % 60}m`;
};
const fmtHMS = (sec) => {
  sec = Math.max(0, Math.floor(sec));
  return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}`;
};
const fmt12 = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${pad(h % 12 || 12)}:${pad(m)} ${h >= 12 ? 'PM' : 'AM'}`;
};
const dayLabel = (ds) => {
  if (ds === ymd(new Date())) return 'Today';
  if (ds === ymd(addDays(new Date(), -1))) return 'Yesterday';
  return parseYmd(ds).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
};

/* ===== state (UI prefs persist in localStorage) ===== */
const DEFAULTS = {
  range: 'week', customFrom: '', customTo: '',
  statuses: ['open', 'progress', 'pending'], scope: 'mine',
  targetHours: 8, sortKey: 'priority', sortDir: 'desc',
  chartMode: 'ticket', ticket: '', search: '',
};
function loadPrefs() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('tt.prefs') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
const S = { tickets: [], entries: [], running: null, prefs: loadPrefs() };
function savePrefs() {
  try { localStorage.setItem('tt.prefs', JSON.stringify(S.prefs)); } catch { /* ignore */ }
}

/* ===== api / ui helpers ===== */
async function api(url, options) {
  const resp = await fetch(url, options);
  if (!resp.ok) throw new Error((await resp.text()).trim() || resp.statusText);
  return resp;
}
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.className = ''), 3500);
}
function banner(msg) { const b = $('banner'); b.textContent = msg; b.hidden = !msg; }

/* ===== date ranges ===== */
function rangeBounds() {
  const today = startOfDay(new Date());
  switch (S.prefs.range) {
    case 'today': return [today, addDays(today, 1)];
    case 'week': { const w = weekStart(today); return [w, addDays(w, 7)]; }
    case 'month': return [new Date(today.getFullYear(), today.getMonth(), 1),
                          new Date(today.getFullYear(), today.getMonth() + 1, 1)];
    default: {
      let from = S.prefs.customFrom ? parseYmd(S.prefs.customFrom) : today;
      let to = S.prefs.customTo ? parseYmd(S.prefs.customTo) : from;
      if (to < from) [from, to] = [to, from];
      return [from, addDays(to, 1)];
    }
  }
}
function rangeLabel() {
  const labels = { today: 'Today', week: 'This week', month: 'This month' };
  if (labels[S.prefs.range]) return labels[S.prefs.range];
  const [a, b] = rangeBounds();
  return `${ymd(a)} → ${ymd(addDays(b, -1))}`;
}

/* ===== data ===== */
async function loadTickets() {
  S.tickets = await (await api('/tickets?scope=' + S.prefs.scope)).json();
}
async function loadEntries() {
  const today = startOfDay(new Date());
  const from = [rangeBounds()[0], weekStart(today), addDays(today, -1),
    new Date(today.getFullYear(), today.getMonth(), 1)].reduce((a, b) => (a < b ? a : b));
  S.entries = (await (await api(`/entries?from=${ymd(from)}&to=${ymd(today)}`)).json()) || [];
  S.running = S.entries.filter((e) => e.running)
    .sort((a, b) => new Date(b.start) - new Date(a.start))[0] || null;
}
async function refresh(spin = true) {
  if (spin) $('refresh').disabled = true;
  const [t, e] = await Promise.allSettled([loadTickets(), loadEntries()]);
  const errs = [];
  if (t.status === 'rejected') errs.push('Jira: ' + t.reason.message);
  if (e.status === 'rejected') errs.push('TMetric: ' + e.reason.message);
  banner(errs.join('  ·  '));
  renderTicketSelect();
  renderAll();
  $('refresh').disabled = false;
}
async function reloadEntries() {
  try { await loadEntries(); banner(''); } catch (e) { banner('TMetric: ' + e.message); }
  renderAll();
}

const entrySec = (e) =>
  Math.max(0, ((e.end ? new Date(e.end) : new Date()) - new Date(e.start)) / 1000);
const sumWhere = (fn) => S.entries.filter(fn).reduce((s, e) => s + entrySec(e), 0);

function timeByKey() {
  const [a, b] = rangeBounds();
  const m = new Map();
  for (const e of S.entries) {
    const s = new Date(e.start);
    if (s >= a && s < b) m.set(e.key, (m.get(e.key) || 0) + entrySec(e));
  }
  return m;
}

/* ===== ticket classification ===== */
const PRIO = { highest: 5, blocker: 5, critical: 5, urgent: 5, high: 4, medium: 3, low: 2, lowest: 1 };
const prioRank = (p) => PRIO[(p || '').toLowerCase()] ?? 0;
const isUrgent = (p) => prioRank(p) >= 4;
const prioClass = (p) => (prioRank(p) >= 4 ? 'p-high' : prioRank(p) === 3 ? 'p-med' : 'p-low');
const isOverdue = (t) => t.category !== 'done' && t.dueDate && t.dueDate < ymd(new Date());
function bucket(t) {
  if (t.category === 'done') return 'closed';
  if (t.category === 'new') return 'open';
  return /progress/i.test(t.status) ? 'progress' : 'pending';
}
const ticketText = (key) => {
  const t = S.tickets.find((x) => x.key === key);
  return t ? `${t.key} ${t.summary}` : '';
};

/* ===== render: KPIs ===== */
function renderKpis() {
  const open = S.tickets.filter((t) => t.category !== 'done');
  const groups = {};
  open.forEach((t) => { groups[t.status] = (groups[t.status] || 0) + 1; });
  $('kpi-active').innerHTML = `
    <div class="kpi-label">Active tickets</div>
    <div class="kpi-value">${open.length}</div>
    <div class="chips-row">${Object.entries(groups)
      .map(([s, n]) => `<span class="badge">${esc(s)} · ${n}</span>`).join('') || '<span class="muted">None</span>'}</div>`;

  const now = new Date();
  const t0 = startOfDay(now);
  const todaySec = sumWhere((e) => new Date(e.start) >= t0);
  const targetSec = Math.max(1, S.prefs.targetHours) * 3600;
  const pct = Math.min(100, (todaySec / targetSec) * 100);
  $('kpi-today').innerHTML = `
    <div class="kpi-label">Today’s logged time</div>
    <div class="kpi-value">${fmtLong(todaySec)} <small>/ ${S.prefs.targetHours}h</small></div>
    <div class="progress"><div style="width:${pct}%" class="${pct >= 100 ? 'done' : ''}"></div></div>`;

  const weekSec = sumWhere((e) => new Date(e.start) >= weekStart(now));
  const monthSec = sumWhere((e) => new Date(e.start) >= new Date(now.getFullYear(), now.getMonth(), 1));
  $('kpi-period').innerHTML = `
    <div class="kpi-label">Hours tracked</div>
    <div class="two">
      <div><div class="kpi-value">${fmtLong(weekSec)}</div><div class="muted">this week</div></div>
      <div><div class="kpi-value">${fmtLong(monthSec)}</div><div class="muted">this month</div></div>
    </div>`;

  const flagged = open
    .map((t) => ({ t, overdue: isOverdue(t), urgent: isUrgent(t.priority) }))
    .filter((x) => x.overdue || x.urgent);
  $('kpi-urgent').classList.toggle('alert', flagged.length > 0);
  $('kpi-urgent').innerHTML = `
    <div class="kpi-label">Overdue / high priority</div>
    <div class="kpi-value">${flagged.length}</div>
    <ul class="flags">${flagged.slice(0, 4).map(({ t, overdue, urgent }) => `
      <li><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.key)}</a>
        ${overdue ? '<span class="tag p-high">Overdue</span>' : ''}
        ${urgent ? `<span class="tag p-high">${esc(t.priority)}</span>` : ''}</li>`).join('')}
    </ul>`;
}

/* ===== render: tickets table ===== */
function renderTable() {
  $('th-time').textContent = `Time (${rangeLabel()})`;
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.dataset.dir = th.dataset.sort === S.prefs.sortKey ? S.prefs.sortDir : '';
  });

  const q = S.prefs.search.trim().toLowerCase();
  const times = timeByKey();
  const rows = S.tickets
    .filter((t) => S.prefs.statuses.includes(bucket(t)))
    .filter((t) => !q || `${t.key} ${t.summary} ${t.status}`.toLowerCase().includes(q));

  const { sortKey, sortDir } = S.prefs;
  rows.sort((a, b) => {
    let r;
    if (sortKey === 'time') r = (times.get(a.key) || 0) - (times.get(b.key) || 0);
    else if (sortKey === 'priority') r = prioRank(a.priority) - prioRank(b.priority);
    else r = String(a[sortKey]).localeCompare(String(b[sortKey]), undefined, { numeric: true });
    return sortDir === 'asc' ? r : -r;
  });

  $('empty').hidden = rows.length > 0;
  $('tbody').innerHTML = rows.map((t) => {
    const run = S.running && S.running.key === t.key;
    const due = isOverdue(t) ? `<div class="due">Due ${esc(t.dueDate)}</div>` : '';
    const who = S.prefs.scope === 'all' && t.assignee ? `<div class="muted small">${esc(t.assignee)}</div>` : '';
    return `<tr class="${run ? 'active' : ''}">
      <td><a href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.key)}</a></td>
      <td class="title">${esc(t.summary)}${who}${due}</td>
      <td><span class="tag ${prioClass(t.priority)}">${esc(t.priority || '—')}</span></td>
      <td><span class="badge">${esc(t.status)}</span></td>
      <td class="num">${fmtHM(times.get(t.key) || 0)}</td>
      <td class="act">
        <button data-act="${run ? 'stop' : 'start'}" data-key="${esc(t.key)}"
          class="${run ? 'danger' : ''}" title="${run ? 'Stop timer' : 'Start timer now'}">${run ? '■' : '▶'}</button>
        <button data-act="log" data-key="${esc(t.key)}" class="secondary">Add time</button>
      </td></tr>`;
  }).join('');
}

/* ===== render: time entries ===== */
function renderEntries() {
  const [a, b] = rangeBounds();
  $('entries-label').textContent = rangeLabel();
  const rows = S.entries
    .filter((e) => { const s = new Date(e.start); return s >= a && s < b; })
    .sort((x, y) => new Date(y.start) - new Date(x.start));

  $('entries-empty').hidden = rows.length > 0;
  $('entries-body').innerHTML = rows.map((e) => {
    const s = new Date(e.start), en = e.end ? new Date(e.end) : null;
    const span = `${fmt12(hm(s))} – ${en ? fmt12(hm(en)) : 'now'}`;
    const actions = en
      ? `<button class="secondary" data-eact="edit" data-id="${e.id}">Edit</button>
         <button class="secondary danger-text" data-eact="delete" data-id="${e.id}">Delete</button>`
      : '<span class="badge">Running</span>';
    return `<tr>
      <td>${esc(dayLabel(ymd(s)))}</td>
      <td class="nowrap">${span}</td>
      <td class="num">${fmtHM(entrySec(e))}</td>
      <td>${esc(e.note)}</td>
      <td class="act">${actions}</td></tr>`;
  }).join('');
}

/* ===== render: chart ===== */
const COLORS = ['#4c6ef5', '#12b886', '#fab005', '#fa5252', '#7950f2', '#15aabf', '#e64980'];
function renderChart() {
  const totals = new Map();
  for (const [key, sec] of timeByKey()) {
    const label = S.prefs.chartMode === 'project' ? (key.split('-')[0] || 'No ticket') : (key || 'No ticket');
    totals.set(label, (totals.get(label) || 0) + sec);
  }
  let items = [...totals].map(([label, sec]) => ({ label, sec })).filter((x) => x.sec > 0)
    .sort((a, b) => b.sec - a.sec);
  if (items.length > 6) {
    const rest = items.slice(6).reduce((s, x) => s + x.sec, 0);
    items = [...items.slice(0, 6), { label: 'Others', sec: rest }];
  }
  const total = items.reduce((s, x) => s + x.sec, 0);
  if (!total) { $('chart').innerHTML = `<p class="muted center">No time tracked (${esc(rangeLabel())}).</p>`; return; }

  const R = 42, C = 2 * Math.PI * R;
  let offset = 0;
  const arcs = items.map((x, i) => {
    const len = (x.sec / total) * C;
    const s = `<circle cx="60" cy="60" r="${R}" fill="none" stroke="${COLORS[i % COLORS.length]}"
      stroke-width="16" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-offset}"
      transform="rotate(-90 60 60)"/>`;
    offset += len;
    return s;
  }).join('');
  $('chart').innerHTML = `
    <svg viewBox="0 0 120 120" class="donut">${arcs}
      <text x="60" y="58" text-anchor="middle" class="d-total">${fmtHM(total)}</text>
      <text x="60" y="72" text-anchor="middle" class="d-sub">hours</text></svg>
    <ul class="legend">${items.map((x, i) => `
      <li><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(x.label)}
        <b>${fmtHM(x.sec)}</b></li>`).join('')}</ul>`;
}

/* ===== render: tracker ===== */
function renderTicketSelect() {
  const sel = $('tr-ticket');
  const list = [...S.tickets].sort((a, b) => (a.category === 'done') - (b.category === 'done'));
  sel.innerHTML = list.map((t) =>
    `<option value="${esc(t.key)}">${esc(t.key)} – ${esc(t.summary)}</option>`).join('');
  if (list.some((t) => t.key === S.prefs.ticket)) sel.value = S.prefs.ticket;
  else if (list.length) S.prefs.ticket = list[0].key;
}
function tickLive() {
  if (S.running) $('live').textContent = fmtHMS((Date.now() - new Date(S.running.start)) / 1000);
}
function renderTracker() {
  const r = S.running;
  const btn = $('tr-toggle');
  btn.textContent = r ? '■ Stop timer' : '▶ Start timer';
  btn.classList.toggle('danger', !!r);
  $('live-sub').textContent = r ? `Tracking ${r.note}` : 'No timer running';
  if (r) tickLive(); else $('live').textContent = '00:00:00';
}

function renderAll() { renderKpis(); renderTable(); renderEntries(); renderChart(); renderTracker(); }

/* ===== actions ===== */
async function act(url, options, okMsg) {
  try {
    await api(url, options);
    toast(okMsg);
    await refresh(false);
    return true;
  } catch (e) {
    toast(e.message, true);
    return false;
  }
}

async function startKey(key) {
  const t = S.tickets.find((x) => x.key === key);
  if (!t) return toast('Pick a ticket first', true);
  S.prefs.ticket = key; savePrefs();
  $('tr-ticket').value = key;
  await act(`/start/${encodeURIComponent(key)}?title=${encodeURIComponent(t.summary)}`,
    { method: 'POST' }, `Started ${key}`);
}
const stopTimer = () => act('/stop', { method: 'POST' }, 'Timer stopped');

/* ----- add / edit entries (always From → To) ----- */
const entryBody = ({ date, start, end }) =>
  JSON.stringify({ note: $('td-note').value.trim(), date, start, end });

function openEntryDialog(o) {
  const sel = $('td-ticket-sel');
  sel.innerHTML = '<option value="">— No ticket —</option>' + S.tickets.map((t) =>
    `<option value="${esc(t.key)}">${esc(t.key)} – ${esc(t.summary)}</option>`).join('');
  sel.value = S.tickets.some((t) => t.key === o.key) ? o.key : '';
  $('td-note').value = o.note || '';
  TimeDialog.open({
    mode: 'log', title: o.title, ticket: '',
    date: o.date, start: o.start, end: o.end, onSave: o.onSave,
  });
}

function openAdd(key) {
  openEntryDialog({
    title: 'Add time entry', key, note: key ? ticketText(key) : '',
    onSave: (v) => act('/log', { method: 'POST', headers: JSON_H, body: entryBody(v) }, 'Time entry added'),
  });
}

function openEdit(id) {
  const e = S.entries.find((x) => String(x.id) === String(id));
  if (!e || !e.end) return;
  const s = new Date(e.start), en = new Date(e.end);
  if (ymd(s) !== ymd(en)) return toast('Entries that span midnight can’t be edited here.', true);
  openEntryDialog({
    title: 'Edit time entry', key: e.key, note: e.note,
    date: ymd(s), start: hm(s), end: hm(en),
    onSave: (v) => act(`/entries/${e.id}`, { method: 'PUT', headers: JSON_H, body: entryBody(v) }, 'Entry updated'),
  });
}

function deleteEntry(id) {
  const e = S.entries.find((x) => String(x.id) === String(id));
  if (!e) return;
  if (!confirm(`Delete this entry?\n\n${e.note}`)) return;
  act(`/entries/${e.id}`, { method: 'DELETE' }, 'Entry deleted');
}

/* ===== controls ===== */
function applyControls() {
  const p = S.prefs;
  document.querySelectorAll('#range-seg button').forEach((b) => b.classList.toggle('active', b.dataset.range === p.range));
  $('custom-range').hidden = p.range !== 'custom';
  $('range-from').value = p.customFrom; $('range-to').value = p.customTo;
  document.querySelectorAll('#status-chips button').forEach((b) => b.classList.toggle('active', p.statuses.includes(b.dataset.status)));
  document.querySelectorAll('#chart-seg button').forEach((b) => b.classList.toggle('active', b.dataset.mode === p.chartMode));
  $('scope').value = p.scope;
  $('target').value = p.targetHours;
  $('search').value = p.search;
}

function init() {
  applyControls();

  $('range-seg').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.prefs.range = b.dataset.range;
    if (S.prefs.range === 'custom' && !S.prefs.customFrom) {
      S.prefs.customFrom = S.prefs.customTo = ymd(new Date());
    }
    savePrefs(); applyControls(); reloadEntries();
  };
  $('range-from').onchange = (e) => { S.prefs.customFrom = e.target.value; savePrefs(); reloadEntries(); };
  $('range-to').onchange = (e) => { S.prefs.customTo = e.target.value; savePrefs(); reloadEntries(); };

  $('status-chips').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const s = b.dataset.status, list = S.prefs.statuses;
    S.prefs.statuses = list.includes(s) ? list.filter((x) => x !== s) : [...list, s];
    savePrefs(); applyControls(); renderTable();
  };
  $('scope').onchange = (e) => { S.prefs.scope = e.target.value; savePrefs(); refresh(); };
  $('target').onchange = (e) => {
    S.prefs.targetHours = Math.max(1, Number(e.target.value) || 8);
    savePrefs(); renderKpis();
  };
  $('refresh').onclick = () => refresh();

  $('search').oninput = (e) => { S.prefs.search = e.target.value; savePrefs(); renderTable(); };
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sort;
      if (S.prefs.sortKey === k) S.prefs.sortDir = S.prefs.sortDir === 'asc' ? 'desc' : 'asc';
      else { S.prefs.sortKey = k; S.prefs.sortDir = k === 'time' || k === 'priority' ? 'desc' : 'asc'; }
      savePrefs(); renderTable();
    };
  });
  $('tbody').onclick = (e) => {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const { act: a, key } = b.dataset;
    if (a === 'start') startKey(key);
    else if (a === 'stop') stopTimer();
    else if (a === 'log') openAdd(key);
  };
  $('entries-body').onclick = (e) => {
    const b = e.target.closest('button[data-eact]'); if (!b) return;
    if (b.dataset.eact === 'edit') openEdit(b.dataset.id);
    else if (b.dataset.eact === 'delete') deleteEntry(b.dataset.id);
  };

  $('chart-seg').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    S.prefs.chartMode = b.dataset.mode; savePrefs(); applyControls(); renderChart();
  };

  $('tr-ticket').onchange = (e) => { S.prefs.ticket = e.target.value; savePrefs(); };
  $('tr-toggle').onclick = () => (S.running ? stopTimer() : startKey($('tr-ticket').value));
  $('tr-manual').onclick = () => openAdd($('tr-ticket').value);
  $('add-entry').onclick = () => openAdd('');

  // Picking a ticket in the dialog fills the description (still editable).
  $('td-ticket-sel').onchange = (e) => {
    const key = e.target.value;
    if (key) $('td-note').value = ticketText(key);
    else if (KEY_RE.test($('td-note').value)) $('td-note').value = '';
  };

  refresh();
  setInterval(tickLive, 1000);
  setInterval(renderAll, 15000);            // recompute with live running time
  setInterval(() => refresh(false), 60000); // pick up changes made elsewhere
}
init();
