// Stundenplan-Export aus WebUntis → timetable.json
//
// So geht's: in WebUntis einloggen, F12 drücken → Tab "Konsole" → den ganzen Inhalt
// dieser Datei einfügen → Enter. Nach ca. 20 Sekunden wird timetable.json heruntergeladen.
// Diese Datei dann im GitHub-Repo hochladen (alte Datei ersetzen).
//
// Exportiert werden nur Fach, Lehrer-Kürzel, Raum, Status und Infotexte.
// Name, Schülernummer, Abwesenheiten und Lehrer-Nachnamen werden NICHT exportiert.

(async () => {
  // Fächer, die nicht angezeigt werden sollen (Kürzel wie in WebUntis)
  const HIDDEN_SUBJECTS = ['FNASA', 'RISL', 'FMVKA'];

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const intToIso = (n) => { const s = String(n); return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`; };

  const token = await (await fetch('/WebUntis/api/token/new', { credentials: 'include' })).text();
  if (!token || token.length < 50) throw new Error('Nicht in WebUntis eingeloggt.');
  const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  const headers = {
    authorization: `Bearer ${token}`,
    'tenant-id': String(claims.tenant_id),
    accept: 'application/json',
  };
  const api = async (path, extra = {}) => {
    const r = await fetch(`/WebUntis/api/rest/view/v1/${path}`, { headers: { ...headers, ...extra }, credentials: 'include' });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  };

  // Aktuelles (bzw. nächstes) Schuljahr
  const today = iso(new Date());
  const years = await api('schoolyears');
  const year = years.find((y) => y.dateRange.start <= today && today <= y.dateRange.end)
    || years.filter((y) => y.dateRange.start > today).sort((a, b) => a.dateRange.start.localeCompare(b.dateRange.start))[0]
    || years[0];
  headers['x-webuntis-api-school-year-id'] = String(year.id);

  // Stundenraster
  const grid = await api('timetable/grid?timetableType=MY_TIMETABLE');
  const fmt = grid.formatDefinitions.find((f) => f.id === grid.studentFormat) || grid.formatDefinitions[0];
  const slots = fmt.timeGridSlots.map((s) => ({ n: s.number, start: s.duration.start, end: s.duration.end }));

  // Ferien und Feiertage
  let holidays = [];
  try {
    const r = await fetch(`/WebUntis/jsonrpc.do?school=${encodeURIComponent(claims.sn)}`, {
      method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: '1', method: 'getHolidays', params: {}, jsonrpc: '2.0' }),
    });
    const j = await r.json();
    holidays = (j.result || [])
      .map((h) => {
        const start = intToIso(h.startDate), end = intToIso(h.endDate);
        let name = h.longName || h.name;
        if (/^\d/.test(name)) name = start.slice(5, 7) === '12' ? 'Weihnachtsferien' : 'Schulfrei';
        return { name, start, end };
      })
      .filter((h) => h.end >= year.dateRange.start && h.start <= year.dateRange.end)
      .sort((a, b) => a.start.localeCompare(b.start));
  } catch (e) {
    console.warn('Ferien konnten nicht geladen werden:', e);
  }

  const KIND = { NORMAL_TEACHING_PERIOD: 'lesson', ADDITIONAL_PERIOD: 'extra', EXAM: 'exam', EVENT: 'event' };
  const STATUS = { REGULAR: 'regular', CANCELLED: 'cancelled', CHANGED: 'changed', ADDITIONAL: 'added' };

  const toLesson = (g) => {
    const l = { start: g.duration.start.slice(11, 16), end: g.duration.end.slice(11, 16), subject: '', subjectName: '',
      teachers: [], oldTeachers: [], rooms: [], oldRooms: [], status: STATUS[g.status] || 'regular', kind: KIND[g.type] || 'lesson', info: '' };
    let title = '';
    for (let i = 1; i <= 7; i++) {
      for (const p of g[`position${i}`] || []) {
        const cur = p.current, old = p.removed;
        const type = (cur || old || {}).type;
        if (type === 'TEACHER') {
          if (cur) l.teachers.push(cur.shortName);
          if (old) l.oldTeachers.push(old.shortName);
        } else if (type === 'ROOM') {
          if (cur) l.rooms.push(cur.shortName);
          if (old) l.oldRooms.push(old.shortName);
        } else if (type === 'SUBJECT') {
          if (cur) { l.subject = cur.shortName; l.subjectName = cur.longName || cur.shortName; }
          else if (old && !l.subject) { l.subject = old.shortName; l.subjectName = old.longName || old.shortName; }
        } else if (type && type !== 'CLASS' && type !== 'STUDENT' && cur) {
          title = title || cur.longName || cur.shortName;
        }
      }
    }
    if (!l.subject) { l.subject = title || g.name || ''; l.subjectName = l.subject; }
    const texts = [...(g.texts || []).map((t) => t.text), g.lessonText, g.substitutionText]
      .map((t) => (t || '').trim()).filter(Boolean);
    l.info = [...new Set(texts)].filter((t) => t !== l.subject).join(' · ');
    for (const k of ['teachers', 'oldTeachers', 'rooms', 'oldRooms']) l[k] = [...new Set(l[k])];
    for (const k of ['oldTeachers', 'oldRooms']) if (!l[k].length) delete l[k];
    if (!l.info) delete l.info;
    return l;
  };

  // Alle Wochen des Schuljahres laden
  const days = {};
  const first = new Date(`${year.dateRange.start}T12:00:00`);
  const last = new Date(`${year.dateRange.end}T12:00:00`);
  let monday = addDays(first, -((first.getDay() + 6) % 7));
  for (; monday <= last; monday = addDays(monday, 7)) {
    const q = new URLSearchParams({ start: iso(monday), end: iso(addDays(monday, 4)), format: '1', resourceType: 'STUDENT',
      resources: String(claims.person_id), periodTypes: '', timetableType: 'MY_TIMETABLE', layout: 'START_TIME' });
    const week = await api(`timetable/entries?${q}`);
    for (const day of week.days) {
      const dow = new Date(`${day.date}T12:00:00`).getDay();
      if (dow === 0 || dow === 6) continue;
      const lessons = day.gridEntries
        .map(toLesson)
        .filter((l) => !HIDDEN_SUBJECTS.includes(l.subject))
        .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
      if (lessons.length) days[day.date] = lessons;
    }
  }

  const data = {
    generatedAt: new Date().toISOString(),
    schoolYear: { name: year.name, start: year.dateRange.start, end: year.dateRange.end },
    slots,
    holidays,
    days,
  };

  const lessonCount = Object.values(days).reduce((n, d) => n + d.length, 0);
  console.log(`Stundenplan exportiert: ${Object.keys(days).length} Tage, ${lessonCount} Einheiten.`);

  if (!window.__stundenplanNoDownload) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    a.download = 'timetable.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  return data;
})();
