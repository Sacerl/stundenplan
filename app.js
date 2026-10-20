(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const DAY_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr'];
  const DAY_LONG = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'];
  const MONTHS = ['Jänner', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const MIN_ROWS = 8;
  const wide = window.matchMedia('(min-width: 761px)');

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const fmtMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const dm = (d) => `${d.getDate()}.${d.getMonth() + 1}.`;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let data, slots, firstMonday, lastMonday;
  const hues = {};
  const state = { monday: null, day: 0 };

  // ---------- helpers ----------

  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
    const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    return Math.ceil(((t - y0) / 86400000 + 1) / 7);
  }

  // "ANGEW. MATHEMATIK" → "Angew. Mathematik"; leaves codes like "DSAI_1" alone
  function niceName(s) {
    if (!s || s !== s.toUpperCase() || /[\d_]/.test(s) || s.length < 4) return s;
    return s.toLowerCase().replace(/(^|[\s\-./(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
  }

  // DBI1x / DBI1y / DBI1 → DBI, so related subjects share a colour
  const base = (s) => s.replace(/(_?\d+)?[xy]?$/i, '') || s;

  function buildHues() {
    const count = {};
    for (const ls of Object.values(data.days)) for (const l of ls) count[base(l.subject)] = (count[base(l.subject)] || 0) + 1;
    Object.keys(count)
      .sort((a, b) => count[b] - count[a] || a.localeCompare(b))
      // golden-angle spread, skipping reds so nothing looks like "Entfall"
      .forEach((b, i) => { hues[b] = Math.round(35 + ((i * 137.508) % 290)); });
  }
  const hueOf = (l) => hues[base(l.subject)] ?? 220;

  // The most specific holiday wins (e.g. "Allerheiligen" inside "Herbstferien")
  function holidayFor(ds) {
    let best = null, bestSpan = Infinity;
    for (const h of data.holidays) {
      if (h.start > ds || ds > h.end) continue;
      const span = parse(h.end) - parse(h.start);
      if (span < bestSpan) { best = h; bestSpan = span; }
    }
    return best;
  }

  // Position of a time in slot units (breaks collapse to the next slot's top)
  function slotPos(min) {
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      if (min < s.s) return i;
      if (min < s.e) return i + (min - s.s) / (s.e - s.s);
    }
    return slots.length;
  }

  function slotSpan(l) {
    const a = toMin(l.start), b = toMin(l.end);
    const from = slots.find((s) => a < s.e);
    const to = [...slots].reverse().find((s) => b > s.s);
    if (!from || !to) return '';
    return from.n === to.n ? `${from.n}. Stunde` : `${from.n}.–${to.n}. Stunde`;
  }

  // Overlapping lessons share the column side by side, like WebUntis
  function layoutDay(lessons) {
    const items = lessons.map((l, idx) => ({ l, idx, a: toMin(l.start), b: toMin(l.end) }))
      .sort((x, y) => x.a - y.a || y.b - x.b);
    const out = [];
    let cluster = [], clusterEnd = -1;
    const flush = () => {
      const lanes = [];
      for (const it of cluster) {
        let i = lanes.findIndex((end) => end <= it.a);
        if (i < 0) { i = lanes.length; lanes.push(0); }
        lanes[i] = it.b;
        it.lane = i;
      }
      for (const it of cluster) it.lanes = lanes.length;
      out.push(...cluster);
      cluster = [];
    };
    for (const it of items) {
      if (cluster.length && it.a >= clusterEnd) flush();
      cluster.push(it);
      clusterEnd = Math.max(clusterEnd, it.b);
    }
    if (cluster.length) flush();
    return out;
  }

  function badges(l, short) {
    const out = [];
    if (l.status === 'cancelled') out.push({ t: 'Entfall', c: 'b-cancel' });
    if (l.kind === 'exam') out.push({ t: 'Prüfung', c: 'b-exam' });
    if (l.kind === 'extra' || l.status === 'added') out.push({ t: short ? 'Zusatz' : 'Zusatzstunde', c: 'b-extra' });
    if (l.kind === 'event') out.push({ t: 'Termin', c: 'b-event' });
    if (l.status !== 'cancelled') {
      if (l.oldTeachers) out.push({ t: 'Vertretung', c: 'b-change' });
      if (l.oldRooms) out.push({ t: short ? 'Raum' : 'Raumänderung', c: 'b-change' });
      if (l.status === 'changed' && !l.oldTeachers && !l.oldRooms && l.kind === 'lesson') out.push({ t: 'Geändert', c: 'b-change' });
    }
    return out;
  }

  function people(cur, old) {
    const removed = (old || []).filter((o) => !cur.includes(o)).map((o) => `<s>${esc(o)}</s>`);
    return [...removed, cur.map(esc).join(', ')].filter(Boolean).join(' ');
  }

  function cardHtml(l, ds, idx, variant, style, tall) {
    const b = badges(l, true)[0];
    const badge = b ? `<i class="badge ${b.c}">${b.t}</i>` : '';
    const cls = `card st-${l.status} k-${l.kind}${variant === 'list' ? ' list' : ''}`;
    const teachers = people(l.teachers, l.oldTeachers);
    const rooms = people(l.rooms, l.oldRooms);
    const label = `${niceName(l.subjectName)}, ${l.start} bis ${l.end}${b ? `, ${b.t}` : ''}`;
    if (variant === 'list') {
      const code = niceName(l.subjectName) === l.subject ? '' : `<b class="c-code">${esc(l.subject)}</b>`;
      const meta = [code, teachers, rooms].filter(Boolean).join(' · ');
      return `<button class="${cls}" style="--h:${hueOf(l)}" data-ds="${ds}" data-i="${idx}" aria-label="${esc(label)}">
        <span class="c-top"><span class="c-name">${esc(niceName(l.subjectName))}</span>${badge}</span>
        <span class="c-line">${meta}</span>
        ${l.info ? `<span class="c-info">${esc(l.info)}</span>` : ''}
      </button>`;
    }
    return `<button class="${cls}" style="--h:${hueOf(l)};${style}" data-ds="${ds}" data-i="${idx}" aria-label="${esc(label)}">
      <span class="c-top"><span class="c-subj">${esc(l.subject)}</span>${badge}</span>
      ${teachers ? `<span class="c-line">${teachers}</span>` : ''}
      ${rooms ? `<span class="c-line">${rooms}</span>` : ''}
      ${l.info && tall ? `<span class="c-info">${esc(l.info)}</span>` : ''}
    </button>`;
  }

  // ---------- rendering ----------

  function weekDays() {
    const todayIso = iso(new Date());
    return [0, 1, 2, 3, 4].map((i) => {
      const d = addDays(state.monday, i);
      const ds = iso(d);
      return { i, d, ds, lessons: data.days[ds] || [], holiday: holidayFor(ds), today: ds === todayIso };
    });
  }

  function rangeLabel(a, b) {
    if (a.getMonth() === b.getMonth()) return `${a.getDate()}.–${b.getDate()}. ${MONTHS[a.getMonth()]} ${a.getFullYear()}`;
    const y = a.getFullYear() === b.getFullYear() ? '' : ` ${a.getFullYear()}`;
    return `${a.getDate()}. ${MONTHS[a.getMonth()]}${y} – ${b.getDate()}. ${MONTHS[b.getMonth()]} ${b.getFullYear()}`;
  }

  function render() {
    const days = weekDays();
    $('#kw').textContent = `Kalenderwoche ${isoWeek(state.monday)}`;
    $('#range').textContent = rangeLabel(state.monday, addDays(state.monday, 4));
    $('#prev').disabled = state.monday <= firstMonday;
    $('#next').disabled = state.monday >= lastMonday;
    renderInfo(days);
    renderGrid(days);
    renderTabs(days);
    renderDay(days[state.day]);
  }

  function renderInfo(days) {
    const all = days.flatMap((d) => d.lessons);
    const n = (f) => all.filter(f).length;
    const chips = [];
    const holidays = [...new Set(days.filter((d) => !d.lessons.length && d.holiday).map((d) => cap(d.holiday.name)))];
    for (const h of holidays) chips.push(['var(--muted)', h]);
    const c = n((l) => l.status === 'cancelled');
    const v = n((l) => l.status !== 'cancelled' && (l.oldTeachers || l.oldRooms || l.status === 'changed' || l.status === 'added'));
    const e = n((l) => l.kind === 'exam');
    if (c) chips.push(['var(--red)', `${c} ${c === 1 ? 'Entfall' : 'Entfälle'}`]);
    if (v) chips.push(['var(--green)', `${v} ${v === 1 ? 'Änderung' : 'Änderungen'}`]);
    if (e) chips.push(['var(--amber)', `${e} ${e === 1 ? 'Prüfung' : 'Prüfungen'}`]);
    $('#weekinfo').innerHTML = chips.map(([col, t]) => `<span class="chip" style="--c:${col}">${esc(t)}</span>`).join('');
  }

  function renderGrid(days) {
    let maxEnd = 0;
    for (const d of days) for (const l of d.lessons) maxEnd = Math.max(maxEnd, slotPos(toMin(l.end)));
    const rows = Math.min(slots.length, Math.max(MIN_ROWS, Math.ceil(maxEnd - 1e-6)));
    const el = $('#week');
    el.style.setProperty('--rows', rows);

    let html = '<div class="corner"></div>';
    for (const d of days) {
      html += `<div class="dayhead${d.today ? ' is-today' : ''}"><span>${DAY_SHORT[d.i]}</span><b>${dm(d.d)}</b></div>`;
    }
    html += '<div class="times">' + slots.slice(0, rows)
      .map((s) => `<div class="slot"><b>${s.n}.</b><span>${s.start}</span><span>${s.end}</span></div>`).join('') + '</div>';

    const now = new Date();
    const nowPos = slotPos(now.getHours() * 60 + now.getMinutes());
    for (const d of days) {
      html += `<div class="daycol${d.today ? ' is-today' : ''}">`;
      if (!d.lessons.length) html += `<div class="free"><span>${esc(d.holiday ? cap(d.holiday.name) : 'Kein Unterricht')}</span></div>`;
      for (const it of layoutDay(d.lessons)) {
        const top = slotPos(it.a), bottom = slotPos(it.b);
        const style = `top:calc(${top} * var(--slot-h) + 2px);height:calc(${Math.max(bottom - top, 0.6)} * var(--slot-h) - 4px);`
          + `left:calc(${it.lane} * 100% / ${it.lanes} + 3px);width:calc(100% / ${it.lanes} - 6px)`;
        html += cardHtml(it.l, d.ds, it.idx, 'grid', style, bottom - top >= 1.5);
      }
      if (d.today && nowPos > 0 && nowPos < rows) html += `<div class="now" style="top:calc(${nowPos} * var(--slot-h))"></div>`;
      html += '</div>';
    }
    el.innerHTML = html;
  }

  function renderTabs(days) {
    $('#daytabs').innerHTML = days.map((d) => {
      let mark = '';
      if (d.lessons.some((l) => l.status === 'cancelled')) mark = 'var(--red)';
      else if (d.lessons.some((l) => l.kind === 'exam')) mark = 'var(--amber)';
      else if (d.lessons.some((l) => l.oldTeachers || l.oldRooms || l.status === 'changed' || l.status === 'added')) mark = 'var(--green)';
      const sel = d.i === state.day;
      return `<button class="tab${sel ? ' is-sel' : ''}${d.today ? ' is-today' : ''}${d.lessons.length ? '' : ' is-free'}" role="tab" aria-selected="${sel}" data-day="${d.i}">
        <span>${DAY_SHORT[d.i]}</span><b>${d.d.getDate()}</b>${mark ? `<i class="mark" style="--c:${mark}"></i>` : ''}
      </button>`;
    }).join('');
  }

  function renderDay(d) {
    const el = $('#daylist');
    const title = `<h2 class="dayname">${DAY_LONG[d.i]}<small>${d.d.getDate()}. ${MONTHS[d.d.getMonth()]}</small></h2>`;
    if (!d.lessons.length) {
      el.innerHTML = `${title}<div class="empty">
        <svg viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="8"/><path d="M24 6v5M24 37v5M6 24h5M37 24h5M11.3 11.3l3.5 3.5M33.2 33.2l3.5 3.5M11.3 36.7l3.5-3.5M33.2 14.8l3.5-3.5"/></svg>
        <h3>${esc(d.holiday ? cap(d.holiday.name) : 'Kein Unterricht')}</h3><p>Heute keine Stunden.</p></div>`;
      return;
    }
    const groups = [];
    d.lessons.forEach((l, idx) => {
      const g = groups.find((x) => x.start === l.start && x.end === l.end);
      if (g) g.items.push({ l, idx }); else groups.push({ start: l.start, end: l.end, items: [{ l, idx }] });
    });
    groups.sort((a, b) => a.start.localeCompare(b.start));
    let html = title, prevEnd = null;
    for (const g of groups) {
      if (prevEnd !== null && toMin(g.start) - prevEnd >= 30) html += `<div class="gap">Frei · ${fmtMin(prevEnd)}–${g.start}</div>`;
      html += `<div class="row"><div class="when"><b>${g.start}</b><span>${g.end}</span></div><div class="cards">`
        + g.items.map(({ l, idx }) => cardHtml(l, d.ds, idx, 'list')).join('') + '</div></div>';
      prevEnd = Math.max(prevEnd ?? 0, toMin(g.end));
    }
    el.innerHTML = html;
  }

  function openDetail(ds, idx) {
    const l = data.days[ds][idx];
    const d = parse(ds);
    const dlg = $('#detail');
    const bs = badges(l, false);
    const teacherLabel = l.teachers.length + (l.oldTeachers || []).length > 1 ? 'Lehrkräfte' : 'Lehrkraft';
    const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : '');
    dlg.innerHTML = `<form method="dialog" class="sheet" style="--h:${hueOf(l)}">
      <header><span class="code">${esc(l.subject)}</span><button class="x" value="close" aria-label="Schließen">×</button></header>
      <h3>${esc(niceName(l.subjectName))}</h3>
      ${bs.length ? `<div class="badges">${bs.map((b) => `<i class="badge ${b.c}">${b.t}</i>`).join('')}</div>` : ''}
      <dl>
        ${row('Zeit', `${DAY_LONG[(d.getDay() + 6) % 7]}, ${dm(d)} · ${l.start}–${l.end}<br><small>${slotSpan(l)}</small>`)}
        ${row(teacherLabel, people(l.teachers, l.oldTeachers))}
        ${row((l.rooms.length > 1 ? 'Räume' : 'Raum'), people(l.rooms, l.oldRooms))}
        ${row('Info', l.info ? esc(l.info) : '')}
      </dl>
    </form>`;
    dlg.showModal();
  }

  // ---------- navigation ----------

  function clampTo(date) {
    let d = date;
    if (d.getDay() === 6) d = addDays(d, 2);
    if (d.getDay() === 0) d = addDays(d, 1);
    let monday = mondayOf(d);
    let day = (d.getDay() + 6) % 7;
    if (monday < firstMonday) { monday = firstMonday; day = 0; }
    if (monday > lastMonday) { monday = lastMonday; day = 0; }
    state.monday = monday;
    state.day = day;
  }

  function fromHash() {
    const m = location.hash.match(/^#(\d{4}-\d{2}-\d{2})$/);
    clampTo(m ? parse(m[1]) : new Date());
  }

  function go(keepHash) {
    if (!keepHash) history.replaceState(null, '', `#${iso(addDays(state.monday, state.day))}`);
    render();
  }

  function stepWeek(n) {
    const m = addDays(state.monday, 7 * n);
    if (m < firstMonday || m > lastMonday) return;
    state.monday = m;
    go();
  }

  function stepDay(n) {
    let day = state.day + n, monday = state.monday;
    if (day > 4) { if (monday >= lastMonday) return; monday = addDays(monday, 7); day = 0; }
    if (day < 0) { if (monday <= firstMonday) return; monday = addDays(monday, -7); day = 4; }
    state.monday = monday;
    state.day = day;
    go();
  }

  function bind() {
    $('#prev').addEventListener('click', () => stepWeek(-1));
    $('#next').addEventListener('click', () => stepWeek(1));
    $('#today').addEventListener('click', () => {
      history.replaceState(null, '', location.pathname + location.search);
      clampTo(new Date());
      render();
    });
    $('#daytabs').addEventListener('click', (e) => {
      const t = e.target.closest('.tab');
      if (!t) return;
      state.day = Number(t.dataset.day);
      go();
    });
    $('#main').addEventListener('click', (e) => {
      const c = e.target.closest('.card');
      if (c) openDetail(c.dataset.ds, Number(c.dataset.i));
    });
    const dlg = $('#detail');
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });

    document.addEventListener('keydown', (e) => {
      if (dlg.open || e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowLeft') wide.matches ? stepWeek(-1) : stepDay(-1);
      if (e.key === 'ArrowRight') wide.matches ? stepWeek(1) : stepDay(1);
    });

    let sx = null, sy = null;
    const main = $('#main');
    main.addEventListener('touchstart', (e) => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; }, { passive: true });
    main.addEventListener('touchend', (e) => {
      if (sx === null) return;
      const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
      sx = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy)) (wide.matches ? stepWeek : stepDay)(dx < 0 ? 1 : -1);
    }, { passive: true });

    window.addEventListener('hashchange', () => { if (dlg.open) dlg.close(); fromHash(); render(); });

    // keep the "now" line and today markers current
    setInterval(() => { if (!dlg.open) render(); }, 60000);
  }

  // ---------- start ----------

  async function init() {
    try {
      const r = await fetch('timetable.json', { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      data = await r.json();
    } catch (err) {
      $('#week').innerHTML = '<p class="loading">Der Stundenplan konnte nicht geladen werden.</p>';
      $('#sub').textContent = 'Fehler beim Laden';
      return;
    }
    slots = data.slots.map((s) => ({ ...s, s: toMin(s.start), e: toMin(s.end) }));
    firstMonday = mondayOf(parse(data.schoolYear.start));
    lastMonday = mondayOf(parse(data.schoolYear.end));
    buildHues();

    const yearName = data.schoolYear.name.replace(/^(\d{4})\/\d{2}(\d{2})$/, '$1/$2');
    const stand = new Date(data.generatedAt);
    const standText = `${dm(stand)}${stand.getFullYear()}, ${pad(stand.getHours())}:${pad(stand.getMinutes())}`;
    $('#sub').textContent = `Schuljahr ${yearName} · Stand ${standText}`;
    $('#stand').textContent = `Stand: ${standText} Uhr. Spätere Änderungen in WebUntis sind hier noch nicht enthalten.`;
    document.title = `Stundenplan ${yearName}`;

    fromHash();
    bind();
    render();
  }

  init();
})();
