// Analog clock time picker. Drag/click inside the face to move the hour hand,
// near the rim to move the minute hand. Future times are blocked for today.
const TimeDialog = (() => {
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const dlg = $('time-dialog');
  const svg = $('clock');

  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
  const hhmm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };
  const fmt12 = (m) => {
    const h = Math.floor(m / 60);
    return `${pad(h % 12 || 12)}:${pad(m % 60)} ${h >= 12 ? 'PM' : 'AM'}`;
  };

  let mode = 'log';        // 'log' (from + to) or 'start' (single time)
  let active = 'start';    // which field the clock edits
  let val = { start: 0, end: 0 };
  let onSave = null;
  let drag = null;         // 'hour' | 'minute' while dragging

  // ----- build the clock face -----
  function el(name, attrs) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    svg.appendChild(e);
    return e;
  }
  const pt = (deg, r) => [100 + r * Math.sin(deg * Math.PI / 180), 100 - r * Math.cos(deg * Math.PI / 180)];

  el('circle', { cx: 100, cy: 100, r: 96, class: 'face' });
  for (let i = 0; i < 60; i++) {
    const major = i % 5 === 0;
    const [x1, y1] = pt(i * 6, major ? 82 : 86);
    const [x2, y2] = pt(i * 6, 92);
    el('line', { x1, y1, x2, y2, class: major ? 'tick major' : 'tick' });
  }
  for (let h = 1; h <= 12; h++) {
    const [x, y] = pt(h * 30, 70);
    const t = el('text', { x, y, class: 'num', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
    t.textContent = h;
  }
  const hourHand = el('line', { x1: 100, y1: 100, class: 'hand hour' });
  const minHand = el('line', { x1: 100, y1: 100, class: 'hand min' });
  const hourKnob = el('circle', { r: 8, class: 'knob hour' });
  const minKnob = el('circle', { r: 6, class: 'knob min' });
  el('circle', { cx: 100, cy: 100, r: 4, class: 'pivot' });

  // ----- state -----
  const maxForDate = () => ($('td-date').value === ymd(new Date()) ? nowMin() : 1439);

  function warn(msg) { $('td-warn').textContent = msg; }

  function setVal(m) {
    const max = maxForDate();
    if (m > max) { m = max; warn('You can’t pick a time in the future.'); }
    else warn('');
    val[active] = Math.max(0, m);
    draw();
  }

  function clampBoth() {
    const max = maxForDate();
    val.start = Math.min(val.start, max);
    val.end = Math.min(val.end, max);
  }

  function draw() {
    const m = val[active], h = Math.floor(m / 60), mm = m % 60;
    const [hx, hy] = pt((h % 12) * 30 + mm * 0.5, 40);
    const [mx, my] = pt(mm * 6, 60);
    hourHand.setAttribute('x2', hx); hourHand.setAttribute('y2', hy);
    minHand.setAttribute('x2', mx); minHand.setAttribute('y2', my);
    hourKnob.setAttribute('cx', hx); hourKnob.setAttribute('cy', hy);
    minKnob.setAttribute('cx', mx); minKnob.setAttribute('cy', my);

    $('td-digital').textContent = fmt12(m);
    $('td-start-val').textContent = fmt12(val.start);
    $('td-end-val').textContent = fmt12(val.end);
    document.querySelectorAll('#td-tabs .tab').forEach((t) =>
      t.classList.toggle('active', t.dataset.field === active));
    document.querySelectorAll('.ampm button').forEach((b) =>
      b.classList.toggle('active', (b.dataset.ap === 'PM') === (h >= 12)));

    if (mode === 'log') {
      const d = val.end - val.start;
      $('td-duration').textContent = d > 0
        ? `Duration: ${Math.floor(d / 60)}h ${pad(d % 60)}m`
        : 'End must be after start.';
    } else {
      $('td-duration').textContent = '';
    }
  }

  // ----- pointer handling -----
  function coords(e) {
    const r = svg.getBoundingClientRect();
    const k = 200 / r.width;
    const x = (e.clientX - r.left) * k - 100;
    const y = (e.clientY - r.top) * k - 100;
    return { ang: (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360, dist: Math.hypot(x, y) };
  }

  function apply(e) {
    const { ang } = coords(e);
    const m = val[active], h = Math.floor(m / 60), mm = m % 60, pm = h >= 12;
    if (drag === 'hour') {
      const h12 = ((Math.round((ang - mm * 0.5) / 30) % 12) + 12) % 12;
      setVal((h12 + (pm ? 12 : 0)) * 60 + mm);
    } else {
      setVal(h * 60 + (Math.round(ang / 6) % 60));
    }
  }

  svg.addEventListener('pointerdown', (e) => {
    drag = coords(e).dist < 50 ? 'hour' : 'minute';
    svg.setPointerCapture(e.pointerId);
    apply(e);
  });
  svg.addEventListener('pointermove', (e) => { if (drag) apply(e); });
  const endDrag = () => { drag = null; };
  svg.addEventListener('pointerup', endDrag);
  svg.addEventListener('pointercancel', endDrag);

  // ----- controls -----
  document.querySelectorAll('#td-tabs .tab').forEach((t) => {
    t.onclick = () => { active = t.dataset.field; warn(''); draw(); };
  });
  document.querySelectorAll('.ampm button').forEach((b) => {
    b.onclick = () => {
      const m = val[active], h = Math.floor(m / 60);
      if ((b.dataset.ap === 'PM') === (h >= 12)) return;
      setVal(((h + 12) % 24) * 60 + (m % 60));
    };
  });
  $('td-date').onchange = () => { clampBoth(); warn(''); draw(); };
  $('td-cancel').onclick = () => dlg.close();

  $('time-form').onsubmit = (e) => {
    e.preventDefault();
    const date = $('td-date').value;
    if (!date) return;
    if (mode === 'log' && val.end <= val.start) { warn('End must be after start.'); return; }
    const result = { date, start: hhmm(val.start), end: hhmm(val.end) };
    dlg.close();
    if (onSave) onSave(result);
  };

  // ----- public API -----
  function open(o) {
    mode = o.mode;
    onSave = o.onSave;
    active = 'start';
    $('td-title').textContent = o.title;
    $('td-ticket').textContent = o.ticket || '';
    $('td-date').max = ymd(new Date());
    $('td-date').value = o.date || ymd(new Date());
    $('td-tab-end').hidden = mode === 'start';
    $('td-start-label').textContent = mode === 'start' ? 'Start time' : 'From';

    const now = nowMin();
    val.start = o.start ? toMin(o.start) : Math.max(0, now - (mode === 'start' ? 30 : 60));
    val.end = o.end ? toMin(o.end) : now;
    clampBoth();
    warn('');
    draw();
    dlg.showModal();
  }

  return { open };
})();