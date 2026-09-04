import { getLocale, localeCode, t } from "./i18n.js";

/* Maleta — Calendario
 * Week / day / month time grid with drag-to-create, drag-to-move, edge resize,
 * weekly recurrence with per-occurrence exceptions, tags and subject colours.
 *
 * Visual system follows design-system.css: the Meleta gold is the only
 * interactive accent, white surfaces, hairline rules only where the grid needs
 * them, no shadows on chrome. Subject colours are a muted identity palette and
 * never carry meaning alone — every block also states its status in words, as
 * info.md requires.
 */

const STEP_MINUTES = 15;
const MIN_DURATION = 15;
const DEFAULT_DURATION = 60;
const DAY_MINUTES = 1440;
const DRAG_THRESHOLD = 4;

export const EVENT_COLORS = [
  { id: "blu", label: "Miele" },
  { id: "salvia", label: "Salvia" },
  { id: "ardesia", label: "Ardesia" },
  { id: "pino", label: "Pino" },
  { id: "prugna", label: "Prugna" },
  { id: "argilla", label: "Argilla" },
  { id: "ocra", label: "Ocra" },
  { id: "rosa", label: "Rosa" },
];
const COLOR_IDS = EVENT_COLORS.map((color) => color.id);

/* Stored weekdays keep the JavaScript convention (0 = domenica) so the rest of
   the application keeps reading them unchanged. Display order is Monday-first. */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WEEKDAY_SHORT = getLocale() === "en" ? ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] : ["dom", "lun", "mar", "mer", "gio", "ven", "sab"];
const WEEKDAY_INITIAL = getLocale() === "en" ? ["S", "M", "T", "W", "T", "F", "S"] : ["D", "L", "M", "M", "G", "V", "S"];
const WEEKDAY_LONG = getLocale() === "en" ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] : ["domenica", "lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato"];

const state = {
  view: "week",
  anchor: startOfDay(new Date()),
  focusKey: null,
  nowTimer: null,
  scrollDirty: true,
};

let context = null;
let root = null;
let dialog = null;
let drag = null;
let dialogState = null;
let tagDraft = [];

/* ---------------------------------------------------------------- dates */

const pad = (value) => String(value).padStart(2, "0");

export function dateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseKey(key) {
  const [year, month, day] = String(key).split("-").map(Number);
  return new Date(year, month - 1, day);
}

function startOfDay(date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date, amount) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + amount);
  return copy;
}

function startOfWeek(date) {
  const copy = startOfDay(date);
  return addDays(copy, -((copy.getDay() + 6) % 7));
}

function daysBetween(from, to) {
  return Math.round((startOfDay(to) - startOfDay(from)) / 86400000);
}

function toMinutes(time) {
  const [hour, minute] = String(time).split(":").map(Number);
  return hour * 60 + minute;
}

function toTime(value) {
  const clamped = Math.max(0, Math.min(DAY_MINUTES, Math.round(value)));
  return `${pad(Math.floor(clamped / 60))}:${pad(clamped % 60)}`;
}

function snap(value) {
  return Math.round(value / STEP_MINUTES) * STEP_MINUTES;
}

function formatDate(date, options) {
  return new Intl.DateTimeFormat(localeCode(), options).format(date);
}

function capitalise(value) {
  return value.charAt(0).toLocaleUpperCase(localeCode()) + value.slice(1);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
}

/* ------------------------------------------------------------ event model
 * An event keeps `weekday`, `startTime` and `endTime` at the top level so the
 * Oggi screen, the library filters and the note detail keep working unchanged.
 * Recurrence, exceptions, colour and tags are additive.
 */

function colorForSubject(subject = "") {
  let hash = 0;
  for (let index = 0; index < subject.length; index += 1) hash = (hash * 31 + subject.charCodeAt(index)) % 997;
  return COLOR_IDS[hash % COLOR_IDS.length];
}

export function normalizeEvent(event) {
  const normalized = { ...event };
  normalized.subject = String(normalized.subject || "").trim();
  normalized.startTime = normalized.startTime || "09:00";
  normalized.endTime = normalized.endTime || "10:00";
  normalized.professor = normalized.professor || "";
  normalized.room = normalized.room || "";
  normalized.notes = normalized.notes || "";
  normalized.tags = Array.isArray(normalized.tags) ? normalized.tags.filter(Boolean) : [];
  normalized.color = COLOR_IDS.includes(normalized.color) ? normalized.color : colorForSubject(normalized.subject);
  normalized.exceptions = normalized.exceptions && typeof normalized.exceptions === "object" ? normalized.exceptions : {};

  if (!normalized.startDate) {
    /* Legacy block: only a weekday existed. Anchor it on the current week. */
    const weekday = Number.isInteger(normalized.weekday) ? normalized.weekday : 1;
    const monday = startOfWeek(new Date());
    normalized.startDate = dateKey(addDays(monday, (weekday + 6) % 7));
  }
  if (normalized.recurrence === undefined) {
    normalized.recurrence = { freq: "weekly", interval: 1, byday: [Number.isInteger(normalized.weekday) ? normalized.weekday : parseKey(normalized.startDate).getDay()], end: { type: "never" } };
  }
  if (normalized.recurrence) {
    const byday = Array.isArray(normalized.recurrence.byday) && normalized.recurrence.byday.length
      ? [...new Set(normalized.recurrence.byday.map(Number))].sort()
      : [parseKey(normalized.startDate).getDay()];
    normalized.recurrence = {
      freq: "weekly",
      interval: Math.max(1, Number(normalized.recurrence.interval) || 1),
      byday,
      end: normalized.recurrence.end?.type ? normalized.recurrence.end : { type: "never" },
    };
    normalized.weekday = byday.includes(parseKey(normalized.startDate).getDay()) ? parseKey(normalized.startDate).getDay() : byday[0];
  } else {
    normalized.weekday = parseKey(normalized.startDate).getDay();
  }
  return normalized;
}

function events() {
  return (context?.state.classes || []).map(normalizeEvent);
}

const untilCache = new Map();

function seriesUntil(event) {
  const recurrence = event.recurrence;
  if (!recurrence) return parseKey(event.startDate);
  if (recurrence.end?.type === "until" && recurrence.end.until) return parseKey(recurrence.end.until);
  if (recurrence.end?.type === "count") {
    const cacheKey = `${event.id}:${event.updatedAt || ""}:${recurrence.end.count}`;
    if (untilCache.has(cacheKey)) return untilCache.get(cacheKey);
    const target = Math.max(1, Number(recurrence.end.count) || 1);
    const start = parseKey(event.startDate);
    let cursor = new Date(start);
    let seen = 0;
    let last = start;
    for (let guard = 0; guard < 3700 && seen < target; guard += 1) {
      if (matchesPattern(event, cursor)) { seen += 1; last = new Date(cursor); }
      cursor = addDays(cursor, 1);
    }
    untilCache.set(cacheKey, last);
    return last;
  }
  return null;
}

function matchesPattern(event, date) {
  const start = parseKey(event.startDate);
  if (startOfDay(date) < start) return false;
  if (!event.recurrence) return daysBetween(start, date) === 0;
  if (!event.recurrence.byday.includes(date.getDay())) return false;
  const weeks = Math.floor(daysBetween(startOfWeek(start), startOfWeek(date)) / 7);
  return weeks >= 0 && weeks % event.recurrence.interval === 0;
}

function occurrenceFor(event, date) {
  if (!matchesPattern(event, date)) return null;
  const until = seriesUntil(event);
  if (until && startOfDay(date) > startOfDay(until)) return null;
  const key = dateKey(date);
  const exception = Object.prototype.hasOwnProperty.call(event.exceptions, key) ? event.exceptions[key] : undefined;
  if (exception === null) return null;
  const merged = exception ? { ...event, ...exception } : event;
  const startMinutes = toMinutes(merged.startTime);
  const endMinutes = Math.max(startMinutes + MIN_DURATION, toMinutes(merged.endTime));
  return {
    eventId: event.id,
    event,
    date: startOfDay(date),
    key,
    id: `${event.id}|${key}`,
    subject: merged.subject,
    color: COLOR_IDS.includes(merged.color) ? merged.color : event.color,
    room: merged.room || "",
    professor: merged.professor || "",
    tags: Array.isArray(merged.tags) ? merged.tags : [],
    notes: merged.notes || "",
    startTime: merged.startTime,
    endTime: merged.endTime,
    startMinutes,
    endMinutes,
    isException: Boolean(exception),
    isRecurring: Boolean(event.recurrence),
  };
}

export function occurrencesBetween(list, from, to) {
  const result = [];
  const first = startOfDay(from);
  const last = startOfDay(to);
  for (const event of list) {
    for (let cursor = new Date(first); cursor <= last; cursor = addDays(cursor, 1)) {
      const occurrence = occurrenceFor(event, cursor);
      if (occurrence) result.push(occurrence);
    }
  }
  return result.sort((a, b) => a.date - b.date || a.startMinutes - b.startMinutes);
}

/* Used by the Oggi screen to name the current or next class. */
export function currentOrNextOccurrence(reference = new Date()) {
  const list = events();
  if (!list.length) return null;
  const nowMinutes = reference.getHours() * 60 + reference.getMinutes();
  const today = startOfDay(reference);
  /* Walks forward a day at a time and stops at the first hit. Building and
     sorting a 120-day horizon just to read its first element made this the most
     expensive thing on the Oggi screen. */
  for (let offset = 0; offset <= 120; offset += 1) {
    const day = addDays(today, offset);
    const dayOccurrences = [];
    for (const event of list) {
      const occurrence = occurrenceFor(event, day);
      if (occurrence) dayOccurrences.push(occurrence);
    }
    dayOccurrences.sort((a, b) => a.startMinutes - b.startMinutes);
    if (offset === 0) {
      const active = dayOccurrences.find((item) => item.startMinutes <= nowMinutes && item.endMinutes > nowMinutes);
      if (active) return { occurrence: active, active: true };
      const later = dayOccurrences.find((item) => item.startMinutes > nowMinutes);
      if (later) return { occurrence: later, active: false };
    } else if (dayOccurrences.length) {
      return { occurrence: dayOccurrences[0], active: false };
    }
  }
  return null;
}

/* ------------------------------------------------------------- persistence */

async function persist(event) {
  untilCache.clear();
  await context.persist(normalizeEvent(event));
}

async function removeEvent(id) {
  untilCache.clear();
  await context.remove(id);
}

function findEvent(id) {
  return events().find((event) => event.id === id) || null;
}

/* ------------------------------------------------------------------ layout */

function packColumns(occurrences) {
  const items = [...occurrences].sort((a, b) => a.startMinutes - b.startMinutes || b.endMinutes - a.endMinutes);
  let cluster = [];
  let clusterEnd = -1;
  const clusters = [];
  for (const item of items) {
    if (cluster.length && item.startMinutes >= clusterEnd) { clusters.push(cluster); cluster = []; clusterEnd = -1; }
    cluster.push(item);
    clusterEnd = Math.max(clusterEnd, item.endMinutes);
  }
  if (cluster.length) clusters.push(cluster);
  for (const group of clusters) {
    const columns = [];
    for (const item of group) {
      let placed = false;
      for (let index = 0; index < columns.length; index += 1) {
        if (columns[index][columns[index].length - 1].endMinutes <= item.startMinutes) {
          columns[index].push(item); item.column = index; placed = true; break;
        }
      }
      if (!placed) { item.column = columns.length; columns.push([item]); }
    }
    for (const item of group) item.columnCount = columns.length;
  }
  return items;
}

/* Read from the root element: the value is declared on :root and changed by
   media queries, so it stays correct before the grid itself exists. */
function hourHeight() {
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--cal-hour")) || 48;
}

/* ------------------------------------------------------------------ render */

function visibleRange() {
  if (state.view === "day") return { from: state.anchor, to: state.anchor };
  if (state.view === "week") {
    const monday = startOfWeek(state.anchor);
    return { from: monday, to: addDays(monday, 6) };
  }
  const first = new Date(state.anchor.getFullYear(), state.anchor.getMonth(), 1);
  const grid = startOfWeek(first);
  return { from: grid, to: addDays(grid, 41) };
}

function periodTitle() {
  if (state.view === "day") return capitalise(formatDate(state.anchor, { weekday: "long", day: "numeric", month: "long" }));
  if (state.view === "month") return capitalise(formatDate(state.anchor, { month: "long", year: "numeric" }));
  const monday = startOfWeek(state.anchor);
  const sunday = addDays(monday, 6);
  if (monday.getMonth() === sunday.getMonth()) return capitalise(`${monday.getDate()} – ${sunday.getDate()} ${formatDate(monday, { month: "long", year: "numeric" })}`);
  return capitalise(`${formatDate(monday, { day: "numeric", month: "short" })} – ${formatDate(sunday, { day: "numeric", month: "short", year: "numeric" })}`);
}

function statusFor(occurrence) {
  return context.statusFor ? context.statusFor(occurrence) : null;
}

function toolbarHtml() {
  const views = [["day", "Giorno"], ["week", "Settimana"], ["month", "Mese"]];
  return `<div class="cal-toolbar">
    <div class="cal-nav">
      <button class="button button-secondary cal-today" type="button" data-cal="today">Oggi</button>
      <span class="cal-steppers">
        <button class="cal-arrow" type="button" data-cal="prev" aria-label="Periodo precedente">‹</button>
        <button class="cal-arrow" type="button" data-cal="next" aria-label="Periodo successivo">›</button>
      </span>
      <h2 class="cal-period">${escapeHtml(periodTitle())}</h2>
    </div>
    <div class="cal-tools">
      <div class="cal-views" role="group" aria-label="Vista del calendario">
        ${views.map(([id, label]) => `<button class="cal-view" type="button" data-cal-view="${id}" aria-pressed="${state.view === id}">${label}</button>`).join("")}
      </div>
      <button class="button button-primary" type="button" data-cal="new">Nuova lezione</button>
    </div>
  </div>`;
}

function eventHtml(occurrence, hour) {
  const status = statusFor(occurrence);
  const top = occurrence.startMinutes / 60 * hour;
  const height = Math.max(22, (occurrence.endMinutes - occurrence.startMinutes) / 60 * hour);
  const width = 100 / (occurrence.columnCount || 1);
  const left = (occurrence.column || 0) * width;
  const compact = height < 46 ? " is-compact" : "";
  const meta = [occurrence.room, occurrence.professor].filter(Boolean).join(" · ");
  const label = `${occurrence.subject || t("Lezione")}, ${occurrence.startTime}–${occurrence.endTime}${status ? `, ${status.label}` : ""}`;
  return `<button class="cal-event${compact}" type="button" data-occurrence="${escapeHtml(occurrence.id)}" data-color="${occurrence.color}"
    style="top:${top}px;height:${height}px;left:${left}%;width:${width}%" aria-label="${escapeHtml(label)}">
    <span class="cal-event-body">
      <span class="cal-event-title" data-no-translate>${escapeHtml(occurrence.subject || t("Lezione"))}</span>
      <span class="cal-event-time">${escapeHtml(occurrence.startTime)}–${escapeHtml(occurrence.endTime)}</span>
      ${meta && height >= 74 ? `<span class="cal-event-meta">${escapeHtml(meta)}</span>` : ""}
      ${status && height >= 58 ? `<span class="cal-event-status" data-tone="${status.tone}"><i aria-hidden="true"></i>${escapeHtml(status.label)}</span>` : ""}
    </span>
    <span class="cal-resize" data-resize="start" aria-hidden="true"></span>
    <span class="cal-resize" data-resize="end" aria-hidden="true"></span>
  </button>`;
}

function timeGridHtml(days) {
  const hour = hourHeight();
  const list = events();
  const todayKey = dateKey(new Date());
  const rail = Array.from({ length: 24 }, (_, index) => `<div class="cal-rail-hour"><span>${index ? `${pad(index)}:00` : ""}</span></div>`).join("");
  const columns = days.map((day) => {
    const key = dateKey(day);
    const occurrences = packColumns(occurrencesBetween(list, day, day));
    return `<div class="cal-col${key === todayKey ? " is-today" : ""}" data-date="${key}" role="group" aria-label="${escapeHtml(capitalise(formatDate(day, { weekday: "long", day: "numeric", month: "long" })))}">
      ${occurrences.map((occurrence) => eventHtml(occurrence, hour)).join("")}
    </div>`;
  }).join("");
  const heads = days.map((day) => {
    const key = dateKey(day);
    return `<button class="cal-head-day${key === todayKey ? " is-today" : ""}" type="button" data-day="${key}"
      aria-label="${escapeHtml(`${t("Apri")} ${capitalise(formatDate(day, { weekday: "long", day: "numeric", month: "long" }))}`)}">
      <span>${escapeHtml(WEEKDAY_SHORT[day.getDay()])}</span><strong>${day.getDate()}</strong>
    </button>`;
  }).join("");
  return `<div class="cal-timegrid" style="--cal-days:${days.length}">
    <div class="cal-head"><div class="cal-head-rail"></div><div class="cal-head-days">${heads}</div></div>
    <div class="cal-scroll">
      <div class="cal-inner">
        <div class="cal-rail">${rail}</div>
        <div class="cal-cols">${columns}<div class="cal-ghost" hidden></div></div>
      </div>
    </div>
  </div>`;
}

function monthHtml() {
  const { from } = visibleRange();
  const list = events();
  const todayKey = dateKey(new Date());
  const month = state.anchor.getMonth();
  const heads = WEEK_ORDER.map((day) => `<span>${escapeHtml(WEEKDAY_SHORT[day])}</span>`).join("");
  const cells = Array.from({ length: 42 }, (_, index) => {
    const day = addDays(from, index);
    const key = dateKey(day);
    const occurrences = occurrencesBetween(list, day, day);
    const shown = occurrences.slice(0, 3);
    const hidden = occurrences.length - shown.length;
    return `<div class="cal-month-cell${day.getMonth() === month ? "" : " is-outside"}${key === todayKey ? " is-today" : ""}" data-date="${key}">
      <span class="cal-month-date">${day.getDate()}</span>
      <div class="cal-month-items">
        ${shown.map((occurrence) => {
          const status = statusFor(occurrence);
          return `<button class="cal-chip" type="button" data-occurrence="${escapeHtml(occurrence.id)}" data-color="${occurrence.color}"${status ? ` data-tone="${status.tone}"` : ""} aria-label="${escapeHtml(`${occurrence.subject}, ${occurrence.startTime}${status ? `, ${status.label}` : ""}`)}">
            <i aria-hidden="true"></i><span class="cal-chip-time">${escapeHtml(occurrence.startTime)}</span><span class="cal-chip-title" data-no-translate>${escapeHtml(occurrence.subject || t("Lezione"))}</span>
          </button>`;
        }).join("")}
        ${hidden > 0 ? `<button class="cal-more" type="button" data-more="${key}">${getLocale() === "en" ? `+${hidden} more` : `+${hidden} altr${hidden === 1 ? "a" : "e"}`}</button>` : ""}
      </div>
    </div>`;
  }).join("");
  return `<div class="cal-month">
    <div class="cal-month-head">${heads}</div>
    <div class="cal-month-grid">${cells}</div>
  </div>`;
}

function emptyHtml() {
  return `<div class="cal-empty">
    <h3>Nessuna lezione nel calendario</h3>
    <p>Trascina sulla griglia per creare una lezione, oppure usa «Nuova lezione». Le lezioni ricorrenti si ripetono ogni settimana.</p>
    <button class="button button-primary" type="button" data-cal="new">Crea la prima lezione</button>
  </div>`;
}

export function renderCalendar() {
  if (!root) return;
  const scrolled = root.querySelector(".cal-scroll")?.scrollTop;
  const { from, to } = visibleRange();
  const days = state.view === "month" ? [] : Array.from({ length: daysBetween(from, to) + 1 }, (_, index) => addDays(from, index));
  const body = state.view === "month" ? monthHtml() : timeGridHtml(days);
  const isEmpty = !events().length;
  root.innerHTML = `${toolbarHtml()}<div class="cal-body" data-view="${state.view}">${body}</div>${isEmpty ? emptyHtml() : ""}`;
  const scroll = root.querySelector(".cal-scroll");
  if (scroll) {
    const fresh = state.scrollDirty || scrolled === undefined;
    scroll.scrollTop = fresh ? preferredScroll() : scrolled;
    state.scrollDirty = false;
  }
  paintNow();
  if (state.focusKey) {
    root.querySelector(`[data-occurrence="${cssEscape(state.focusKey)}"]`)?.focus();
    state.focusKey = null;
  }
}

/* Open on the first class of the period rather than on an empty midnight. */
function preferredScroll() {
  const { from, to } = visibleRange();
  const list = occurrencesBetween(events(), from, to);
  const now = new Date();
  const earliest = list.length ? Math.min(...list.map((item) => item.startMinutes)) : now.getHours() * 60;
  return Math.max(0, (earliest - 60) / 60 * hourHeight());
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

function paintNow() {
  for (const node of root?.querySelectorAll(".cal-now, .cal-now-label") || []) node.remove();
  if (state.view === "month") return;
  const now = new Date();
  const column = root?.querySelector(`.cal-col[data-date="${dateKey(now)}"]`);
  const cols = root?.querySelector(".cal-cols");
  if (!column || !cols) return;
  const top = (now.getHours() * 60 + now.getMinutes()) / 60 * hourHeight();

  /* One rule across every day of the week, with the dot over today. */
  const line = document.createElement("div");
  line.className = "cal-now";
  line.setAttribute("aria-hidden", "true");
  line.style.top = `${top}px`;
  line.style.setProperty("--now-left", `${column.offsetLeft + column.offsetWidth / 2}px`);
  cols.appendChild(line);

  const rail = root.querySelector(".cal-rail");
  if (!rail) return;
  const label = document.createElement("div");
  label.className = "cal-now-label";
  label.setAttribute("aria-hidden", "true");
  label.style.top = `${top}px`;
  label.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  rail.appendChild(label);
}

/* ------------------------------------------------------------- navigation */

function step(direction) {
  if (state.view === "day") state.anchor = addDays(state.anchor, direction);
  else if (state.view === "week") state.anchor = addDays(state.anchor, direction * 7);
  else state.anchor = new Date(state.anchor.getFullYear(), state.anchor.getMonth() + direction, 1);
  state.scrollDirty = true;
  renderCalendar();
}

function setView(view, date) {
  state.view = view;
  if (date) state.anchor = startOfDay(date);
  state.scrollDirty = true;
  renderCalendar();
}

/* --------------------------------------------------------------- pointers */

function minutesAtPointer(clientY) {
  const cols = root.querySelector(".cal-cols");
  if (!cols) return 0;
  const rect = cols.getBoundingClientRect();
  return Math.max(0, Math.min(DAY_MINUTES, (clientY - rect.top) / hourHeight() * 60));
}

function columnAtPointer(clientX) {
  const columns = [...root.querySelectorAll(".cal-col")];
  if (!columns.length) return null;
  let closest = columns[0];
  for (const column of columns) {
    const rect = column.getBoundingClientRect();
    if (clientX >= rect.left && clientX <= rect.right) return column;
    if (Math.abs(clientX - rect.left) < Math.abs(clientX - closest.getBoundingClientRect().left)) closest = column;
  }
  return closest;
}

function showGhost(dateKeyValue, startMinutes, endMinutes, label) {
  const ghost = root.querySelector(".cal-ghost");
  const column = root.querySelector(`.cal-col[data-date="${cssEscape(dateKeyValue)}"]`);
  if (!ghost || !column) return;
  const cols = root.querySelector(".cal-cols");
  const columnRect = column.getBoundingClientRect();
  const colsRect = cols.getBoundingClientRect();
  const hour = hourHeight();
  ghost.hidden = false;
  ghost.style.left = `${columnRect.left - colsRect.left}px`;
  ghost.style.width = `${columnRect.width}px`;
  ghost.style.top = `${startMinutes / 60 * hour}px`;
  ghost.style.height = `${Math.max(16, (endMinutes - startMinutes) / 60 * hour)}px`;
  ghost.textContent = label;
}

function hideGhost() {
  const ghost = root?.querySelector(".cal-ghost");
  if (ghost) { ghost.hidden = true; ghost.textContent = ""; }
}

function onPointerDown(event) {
  if (event.button !== 0 || state.view === "month") return;
  /* Touch keeps the grid scrollable: tapping creates and edits instead. */
  if (event.pointerType === "touch") return;
  const eventElement = event.target.closest(".cal-event");
  const column = event.target.closest(".cal-col");
  if (!column) return;

  if (eventElement) {
    const occurrence = occurrenceById(eventElement.dataset.occurrence);
    if (!occurrence) return;
    const handle = event.target.closest(".cal-resize");
    drag = {
      mode: handle ? "resize" : "move",
      edge: handle?.dataset.resize || "end",
      occurrence,
      element: eventElement,
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      grabOffset: minutesAtPointer(event.clientY) - occurrence.startMinutes,
      dateKey: occurrence.key,
      startMinutes: occurrence.startMinutes,
      endMinutes: occurrence.endMinutes,
      moved: false,
    };
  } else {
    const startMinutes = snap(minutesAtPointer(event.clientY));
    drag = {
      mode: "create",
      pointerId: event.pointerId,
      originX: event.clientX,
      originY: event.clientY,
      dateKey: column.dataset.date,
      anchorMinutes: startMinutes,
      startMinutes,
      endMinutes: startMinutes + DEFAULT_DURATION,
      moved: false,
    };
  }
  root.setPointerCapture?.(event.pointerId);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp, { once: true });
  window.addEventListener("pointercancel", onPointerCancel, { once: true });
  window.addEventListener("keydown", onDragKeydown);
}

function onPointerMove(event) {
  if (!drag) return;
  if (!drag.moved && Math.abs(event.clientY - drag.originY) < DRAG_THRESHOLD && Math.abs(event.clientX - drag.originX) < DRAG_THRESHOLD) return;
  drag.moved = true;
  event.preventDefault();
  const pointerMinutes = minutesAtPointer(event.clientY);

  if (drag.mode === "create") {
    const current = snap(pointerMinutes);
    drag.startMinutes = Math.max(0, Math.min(drag.anchorMinutes, current));
    drag.endMinutes = Math.min(DAY_MINUTES, Math.max(drag.anchorMinutes, current) + (current === drag.anchorMinutes ? MIN_DURATION : 0));
    if (drag.endMinutes - drag.startMinutes < MIN_DURATION) drag.endMinutes = drag.startMinutes + MIN_DURATION;
  } else if (drag.mode === "move") {
    const duration = drag.occurrence.endMinutes - drag.occurrence.startMinutes;
    const start = snap(pointerMinutes - drag.grabOffset);
    drag.startMinutes = Math.max(0, Math.min(DAY_MINUTES - duration, start));
    drag.endMinutes = drag.startMinutes + duration;
    const column = columnAtPointer(event.clientX);
    if (column) drag.dateKey = column.dataset.date;
    drag.element.classList.add("is-dragging");
  } else if (drag.edge === "start") {
    drag.startMinutes = Math.max(0, Math.min(drag.occurrence.endMinutes - MIN_DURATION, snap(pointerMinutes)));
    drag.endMinutes = drag.occurrence.endMinutes;
    drag.element.classList.add("is-dragging");
  } else {
    drag.startMinutes = drag.occurrence.startMinutes;
    drag.endMinutes = Math.max(drag.startMinutes + MIN_DURATION, Math.min(DAY_MINUTES, snap(pointerMinutes)));
    drag.element.classList.add("is-dragging");
  }
  showGhost(drag.dateKey, drag.startMinutes, drag.endMinutes, `${toTime(drag.startMinutes)}–${toTime(drag.endMinutes)}`);
}

function onDragKeydown(event) {
  if (event.key !== "Escape" || !drag) return;
  event.preventDefault();
  onPointerCancel();
}

function onPointerCancel() {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("keydown", onDragKeydown);
  drag?.element?.classList.remove("is-dragging");
  drag = null;
  hideGhost();
  renderCalendar();
}

async function onPointerUp(event) {
  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointercancel", onPointerCancel);
  window.removeEventListener("keydown", onDragKeydown);
  const current = drag;
  drag = null;
  hideGhost();
  if (!current) return;
  current.element?.classList.remove("is-dragging");

  if (current.mode === "create") {
    if (!current.moved) {
      const minutes = snap(minutesAtPointer(event.clientY));
      openEditor({ mode: "create", date: parseKey(current.dateKey), startMinutes: minutes, endMinutes: Math.min(DAY_MINUTES, minutes + DEFAULT_DURATION) });
      return;
    }
    openEditor({ mode: "create", date: parseKey(current.dateKey), startMinutes: current.startMinutes, endMinutes: current.endMinutes });
    return;
  }

  if (!current.moved) { openOccurrence(current.occurrence); return; }

  const unchanged = current.startMinutes === current.occurrence.startMinutes
    && current.endMinutes === current.occurrence.endMinutes
    && current.dateKey === current.occurrence.key;
  if (unchanged) { renderCalendar(); return; }

  await applyReschedule(current.occurrence, current.dateKey, current.startMinutes, current.endMinutes);
}

function occurrenceById(id) {
  const [eventId, key] = String(id).split("|");
  const event = findEvent(eventId);
  return event ? occurrenceFor(event, parseKey(key)) : null;
}

function openOccurrence(occurrence) {
  if (context.openRecording?.(occurrence)) return;
  openEditor({ mode: "edit", occurrence });
}

/* Dragging never interrupts with a dialog. A timetable block that moves is
   almost always moving for good, so the drag edits the whole series and the
   toast says so; a one-off change is made in the editor's scope control. */
async function applyReschedule(occurrence, newDateKey, startMinutes, endMinutes) {
  const changes = { startTime: toTime(startMinutes), endTime: toTime(endMinutes) };
  const event = findEvent(occurrence.eventId);
  if (!event) return;
  const movedDay = newDateKey !== occurrence.key;
  if (!occurrence.isRecurring) {
    await persist({ ...event, ...changes, startDate: newDateKey, updatedAt: new Date().toISOString() });
    context.announce("Lezione spostata.");
    renderCalendar();
    return;
  }
  await writeChange(occurrence, changes, "all", movedDay ? newDateKey : null);
  context.announce(movedDay
    ? `Spostata al ${WEEKDAY_LONG[parseKey(newDateKey).getDay()]}, ogni settimana.`
    : `Nuovo orario ${changes.startTime}–${changes.endTime}, ogni settimana.`);
}

/* Applies `changes` to a whole series, moving one weekday of the pattern when
   the block was dragged onto another day. Per-date overrides of the very
   fields being changed are dropped: otherwise those dates keep their old
   values and the change looks like it undid itself. Cancellations survive,
   unless their date no longer belongs to the pattern. */
export function seriesChange(event, occurrenceKey, changes, movedToKey = null) {
  const next = { ...event, ...changes };
  if (movedToKey && event.recurrence) {
    const from = parseKey(occurrenceKey).getDay();
    const to = parseKey(movedToKey).getDay();
    next.recurrence = {
      ...event.recurrence,
      byday: [...new Set(event.recurrence.byday.map((day) => (day === from ? to : day)))].sort(),
    };
    next.startDate = movedToKey < event.startDate ? movedToKey : event.startDate;
  }

  const changed = Object.keys(changes);
  const exceptions = {};
  for (const [key, value] of Object.entries(event.exceptions || {})) {
    /* An exception on a weekday the series no longer visits is dead weight. */
    if (next.recurrence && !next.recurrence.byday.includes(parseKey(key).getDay())) continue;
    if (value === null) { exceptions[key] = null; continue; }
    const rest = { ...value };
    for (const field of changed) delete rest[field];
    if (Object.keys(rest).length) exceptions[key] = rest;
  }
  next.exceptions = exceptions;
  return next;
}

/* Writes `changes` onto a series according to the chosen scope. */
async function writeChange(occurrence, changes, scope, movedToKey = null) {
  const event = findEvent(occurrence.eventId);
  if (!event) return;
  const stamp = new Date().toISOString();

  if (scope === "all") {
    await persist({ ...seriesChange(event, occurrence.key, changes, movedToKey), updatedAt: stamp });
    renderCalendar();
    return;
  }

  if (scope === "following") {
    if (occurrence.key === event.startDate) {
      await writeChange(occurrence, changes, "all", movedToKey);
      return;
    }
    const cutoff = dateKey(addDays(parseKey(occurrence.key), -1));
    const kept = { ...event, recurrence: { ...event.recurrence, end: { type: "until", until: cutoff } }, updatedAt: stamp };
    const keptExceptions = {};
    for (const [key, value] of Object.entries(event.exceptions)) if (key <= cutoff) keptExceptions[key] = value;
    kept.exceptions = keptExceptions;

    const startDate = movedToKey || occurrence.key;
    const carried = {};
    for (const [key, value] of Object.entries(event.exceptions)) if (key >= startDate) carried[key] = value;
    const created = {
      ...event, ...changes,
      id: context.makeId("class"),
      startDate,
      exceptions: carried,
      recurrence: { ...event.recurrence, byday: movedToKey ? [parseKey(movedToKey).getDay()] : event.recurrence.byday, end: event.recurrence.end },
      updatedAt: stamp,
    };
    await persist(kept);
    await persist(created);
    renderCalendar();
    return;
  }

  /* Single occurrence. Moving it to another day becomes a standalone block. */
  if (movedToKey) {
    const cancelled = { ...event, exceptions: { ...event.exceptions, [occurrence.key]: null }, updatedAt: stamp };
    await persist(cancelled);
    await persist({
      ...event, ...changes,
      id: context.makeId("class"),
      startDate: movedToKey,
      recurrence: null,
      exceptions: {},
      updatedAt: stamp,
    });
    renderCalendar();
    return;
  }
  const override = { ...(event.exceptions[occurrence.key] || {}), ...changes };
  await persist({ ...event, exceptions: { ...event.exceptions, [occurrence.key]: override }, updatedAt: stamp });
  renderCalendar();
}

/* ------------------------------------------------------------ event editor */

function buildDialog() {
  dialog = document.createElement("dialog");
  dialog.className = "app-dialog cal-dialog";
  dialog.innerHTML = `<form id="cal-form" novalidate>
    <div class="dialog-heading">
      <h2 id="cal-dialog-title">Nuova lezione</h2>
      <button class="icon-button" type="button" data-cal-dialog="close" aria-label="Chiudi">×</button>
    </div>

    <label class="cal-field">Materia
      <input name="subject" maxlength="80" required placeholder="es. Analisi matematica" autocomplete="off" />
    </label>

    <fieldset class="cal-colors">
      <legend>Colore</legend>
      <div class="cal-swatches">
        ${EVENT_COLORS.map((color, index) => `<label class="cal-swatch" data-color="${color.id}">
          <input type="radio" name="color" value="${color.id}" ${index === 0 ? "checked" : ""} />
          <span aria-hidden="true"></span><span class="visually-hidden">${color.label}</span>
        </label>`).join("")}
      </div>
    </fieldset>

    <div class="cal-field-row">
      <label class="cal-field">Data<input name="date" type="date" required /></label>
      <label class="cal-field">Inizio<input name="startTime" type="time" step="900" required /></label>
      <label class="cal-field">Fine<input name="endTime" type="time" step="900" required /></label>
    </div>

    <div class="cal-field">
      <span class="cal-label">Etichette <span class="optional">opzionale</span></span>
      <div class="cal-tags" data-cal-tags>
        <ul class="cal-tag-list" id="cal-tag-list"></ul>
        <input name="tagDraft" placeholder="Aggiungi etichetta e premi Invio" autocomplete="off" />
      </div>
    </div>

    <fieldset class="cal-repeat">
      <legend>Ripetizione</legend>
      <label class="cal-field">Ripeti
        <select name="repeat">
          <option value="none">Non si ripete</option>
          <option value="weekly">Ogni settimana</option>
          <option value="biweekly">Ogni 2 settimane</option>
          <option value="custom">Personalizzata…</option>
        </select>
      </label>
      <div class="cal-repeat-detail" data-repeat-detail hidden>
        <div class="cal-days" role="group" aria-label="Giorni di ripetizione">
          ${WEEK_ORDER.map((day) => `<label class="cal-day"><input type="checkbox" name="byday" value="${day}" /><span aria-hidden="true">${WEEKDAY_INITIAL[day]}</span><span class="visually-hidden">${WEEKDAY_LONG[day]}</span></label>`).join("")}
        </div>
        <label class="cal-field cal-interval" data-interval hidden>Ogni
          <span class="cal-interval-input"><input name="interval" type="number" min="1" max="12" value="1" /> settimane</span>
        </label>
        <div class="cal-end">
          <span class="cal-label">Termina</span>
          <label class="cal-radio"><input type="radio" name="endType" value="never" checked /><span>Mai</span></label>
          <label class="cal-radio"><input type="radio" name="endType" value="until" /><span>Il</span><input name="until" type="date" /></label>
          <label class="cal-radio"><input type="radio" name="endType" value="count" /><span>Dopo</span><input name="count" type="number" min="1" max="365" value="10" /><span>occorrenze</span></label>
        </div>
      </div>
    </fieldset>

    <div class="cal-field-row">
      <label class="cal-field">Docente <span class="optional">opzionale</span><input name="professor" maxlength="80" autocomplete="off" /></label>
      <label class="cal-field">Aula <span class="optional">opzionale</span><input name="room" maxlength="40" autocomplete="off" /></label>
    </div>

    <label class="cal-field">Note <span class="optional">opzionale</span>
      <textarea name="notes" rows="2" maxlength="500"></textarea>
    </label>

    <div class="cal-scope-row" data-scope-row hidden>
      <span class="cal-label">Applica a</span>
      <div class="cal-segment" role="radiogroup" aria-label="Ambito della modifica">
        <label><input type="radio" name="scope" value="all" checked /><span>Tutta la serie</span></label>
        <label><input type="radio" name="scope" value="following" /><span>Da qui in poi</span></label>
        <label><input type="radio" name="scope" value="single" /><span>Solo questa data</span></label>
      </div>
    </div>

    <p class="cal-status" data-cal-status role="status"></p>

    <div class="dialog-actions">
      <button class="text-button danger-action" type="button" data-cal-dialog="delete" hidden>Elimina</button>
      <span class="dialog-spacer"></span>
      <button class="button button-secondary" type="button" data-cal-dialog="record" hidden>Registra</button>
      <button class="button button-secondary" type="button" data-cal-dialog="close">Annulla</button>
      <button class="button button-primary" type="submit">Salva</button>
    </div>
  </form>`;
  document.body.appendChild(dialog);

  const form = dialog.querySelector("#cal-form");
  form.addEventListener("submit", (event) => { event.preventDefault(); saveFromDialog(); });
  form.elements.repeat.addEventListener("change", syncRepeatControls);
  form.addEventListener("change", (event) => { if (event.target.name === "endType") syncRepeatControls(); });
  form.elements.tagDraft.addEventListener("keydown", onTagKeydown);
  form.elements.tagDraft.addEventListener("blur", () => commitTag());
  dialog.querySelector("#cal-tag-list").addEventListener("click", (event) => {
    const index = event.target.closest("[data-tag-index]")?.dataset.tagIndex;
    if (index === undefined) return;
    tagDraft.splice(Number(index), 1);
    renderTags();
  });
  dialog.addEventListener("click", (event) => {
    const action = event.target.closest("[data-cal-dialog]")?.dataset.calDialog;
    if (action === "close") dialog.close();
    if (action === "delete") deleteFromDialog();
    if (action === "record") {
      const id = dialogState?.occurrence?.eventId;
      dialog.close();
      if (id) context.startRecording(id);
    }
  });
  dialog.addEventListener("cancel", () => { dialogState = null; });
  dialog.addEventListener("close", () => { renderCalendar(); });
}

function renderTags() {
  const list = dialog.querySelector("#cal-tag-list");
  list.innerHTML = tagDraft.map((tag, index) => `<li class="cal-tag">${escapeHtml(tag)}<button type="button" data-tag-index="${index}" aria-label="Rimuovi ${escapeHtml(tag)}">×</button></li>`).join("");
}

function commitTag() {
  const input = dialog.querySelector('[name="tagDraft"]');
  const value = input.value.trim().replace(/,$/, "").trim();
  if (value && !tagDraft.includes(value) && tagDraft.length < 12) tagDraft.push(value);
  input.value = "";
  renderTags();
}

function onTagKeydown(event) {
  if (event.key === "Enter" || event.key === ",") { event.preventDefault(); commitTag(); return; }
  if (event.key === "Backspace" && !event.target.value && tagDraft.length) { tagDraft.pop(); renderTags(); }
}

function syncRepeatControls() {
  const form = dialog.querySelector("#cal-form");
  const repeat = form.elements.repeat.value;
  form.querySelector("[data-repeat-detail]").hidden = repeat === "none";
  form.querySelector("[data-interval]").hidden = repeat !== "custom";
  const endType = form.elements.endType.value;
  form.elements.until.disabled = endType !== "until";
  form.elements.count.disabled = endType !== "count";
  if (repeat === "weekly") form.elements.interval.value = "1";
  if (repeat === "biweekly") form.elements.interval.value = "2";
}

function openEditor(options) {
  if (!dialog) buildDialog();
  dialogState = options;
  const form = dialog.querySelector("#cal-form");
  form.reset();
  dialog.querySelector("[data-cal-status]").textContent = "";

  const isEdit = options.mode === "edit";
  const occurrence = options.occurrence || null;
  const event = isEdit ? findEvent(occurrence.eventId) : null;
  const date = isEdit ? parseKey(occurrence.key) : startOfDay(options.date || state.anchor);

  dialog.querySelector("#cal-dialog-title").textContent = isEdit ? "Modifica lezione" : "Nuova lezione";
  form.elements.subject.value = isEdit ? occurrence.subject : "";
  form.elements.date.value = dateKey(date);
  form.elements.startTime.value = isEdit ? occurrence.startTime : toTime(snap(options.startMinutes ?? 540));
  form.elements.endTime.value = isEdit ? occurrence.endTime : toTime(snap(options.endMinutes ?? 600));
  form.elements.professor.value = isEdit ? occurrence.professor : "";
  form.elements.room.value = isEdit ? occurrence.room : "";
  form.elements.notes.value = isEdit ? occurrence.notes : "";

  const color = isEdit ? occurrence.color : COLOR_IDS[0];
  const swatch = form.querySelector(`input[name="color"][value="${color}"]`);
  if (swatch) swatch.checked = true;

  tagDraft = isEdit ? [...occurrence.tags] : [];
  renderTags();

  const recurrence = event?.recurrence;
  if (recurrence) {
    form.elements.repeat.value = recurrence.interval === 2 && recurrence.byday.length === 1 ? "biweekly"
      : recurrence.interval === 1 && recurrence.byday.length === 1 ? "weekly" : "custom";
    form.elements.interval.value = String(recurrence.interval);
    for (const box of form.querySelectorAll('input[name="byday"]')) box.checked = recurrence.byday.includes(Number(box.value));
    const end = recurrence.end || { type: "never" };
    form.elements.endType.value = end.type;
    if (end.type === "until") form.elements.until.value = end.until || "";
    if (end.type === "count") form.elements.count.value = String(end.count || 10);
  } else {
    form.elements.repeat.value = isEdit ? "none" : "weekly";
    for (const box of form.querySelectorAll('input[name="byday"]')) box.checked = Number(box.value) === date.getDay();
    form.elements.endType.value = "never";
  }
  if (!isEdit) {
    for (const box of form.querySelectorAll('input[name="byday"]')) box.checked = Number(box.value) === date.getDay();
  }
  syncRepeatControls();

  const recurringEdit = isEdit && Boolean(recurrence);
  dialog.querySelector("[data-scope-row]").hidden = !recurringEdit;
  form.querySelector('input[name="scope"][value="all"]').checked = true;
  dialog.querySelector('[data-cal-dialog="delete"]').hidden = !isEdit;
  dialog.querySelector('[data-cal-dialog="record"]').hidden = !isEdit;
  dialog.showModal();
  form.elements.subject.focus();
}

function readForm() {
  const form = dialog.querySelector("#cal-form");
  commitTag();
  const repeat = form.elements.repeat.value;
  const byday = [...form.querySelectorAll('input[name="byday"]:checked')].map((box) => Number(box.value));
  const date = form.elements.date.value;
  const endType = form.elements.endType.value;
  return {
    subject: form.elements.subject.value.trim(),
    color: form.querySelector('input[name="color"]:checked')?.value || COLOR_IDS[0],
    startDate: date,
    startTime: form.elements.startTime.value,
    endTime: form.elements.endTime.value,
    professor: form.elements.professor.value.trim(),
    room: form.elements.room.value.trim(),
    notes: form.elements.notes.value.trim(),
    tags: [...tagDraft],
    recurrence: repeat === "none" ? null : {
      freq: "weekly",
      interval: repeat === "biweekly" ? 2 : repeat === "custom" ? Math.max(1, Number(form.elements.interval.value) || 1) : 1,
      byday: byday.length ? byday : [parseKey(date).getDay()],
      end: endType === "until" ? { type: "until", until: form.elements.until.value || null }
        : endType === "count" ? { type: "count", count: Math.max(1, Number(form.elements.count.value) || 1) }
        : { type: "never" },
    },
  };
}

function invalidReason(values) {
  if (!values.subject) return "Inserisci il nome della materia.";
  if (!values.startDate) return "Scegli una data.";
  if (!values.startTime || !values.endTime) return "Scegli l’orario di inizio e di fine.";
  if (toMinutes(values.endTime) <= toMinutes(values.startTime)) return "L’ora di fine deve essere successiva all’inizio.";
  if (values.recurrence?.end?.type === "until" && !values.recurrence.end.until) return "Scegli la data di fine della ripetizione.";
  if (values.recurrence?.end?.type === "until" && values.recurrence.end.until < values.startDate) return "La ripetizione non può finire prima di iniziare.";
  return null;
}

async function saveFromDialog() {
  const values = readForm();
  const problem = invalidReason(values);
  if (problem) { dialog.querySelector("[data-cal-status]").textContent = problem; return; }
  const stamp = new Date().toISOString();

  if (dialogState.mode === "create") {
    /* The anchor must fall on one of the chosen weekdays. */
    let startDate = values.startDate;
    if (values.recurrence && !values.recurrence.byday.includes(parseKey(startDate).getDay())) {
      const anchor = parseKey(startDate);
      for (let offset = 1; offset <= 7; offset += 1) {
        const candidate = addDays(anchor, offset);
        if (values.recurrence.byday.includes(candidate.getDay())) { startDate = dateKey(candidate); break; }
      }
    }
    await persist({ ...values, startDate, id: context.makeId("class"), exceptions: {}, updatedAt: stamp });
    dialogState = null;
    dialog.close();
    context.announce(values.recurrence ? "Lezione ricorrente aggiunta." : "Lezione aggiunta.");
    return;
  }

  const occurrence = dialogState.occurrence;
  const event = findEvent(occurrence.eventId);
  const structural = !event.recurrence !== !values.recurrence
    || (values.recurrence && event.recurrence && (
      values.recurrence.interval !== event.recurrence.interval
      || values.recurrence.byday.join() !== event.recurrence.byday.join()
      || JSON.stringify(values.recurrence.end) !== JSON.stringify(event.recurrence.end)))
    || values.startDate !== occurrence.key;

  if (!event.recurrence) {
    await persist({ ...event, ...values, exceptions: {}, updatedAt: stamp });
    dialogState = null; dialog.close();
    context.announce("Lezione aggiornata.");
    return;
  }

  if (structural) {
    /* Recurrence itself changed: it can only apply to the whole series. */
    await persist({ ...event, ...values, updatedAt: stamp });
    dialogState = null; dialog.close();
    context.announce("Serie aggiornata.");
    return;
  }

  const scope = dialog.querySelector("#cal-form").elements.scope.value || "all";
  dialog.close();
  dialogState = null;
  const changes = { subject: values.subject, color: values.color, startTime: values.startTime, endTime: values.endTime, professor: values.professor, room: values.room, notes: values.notes, tags: values.tags };
  await writeChange(occurrence, changes, scope);
  context.announce(scope === "single" ? "Aggiornata solo per questa data."
    : scope === "following" ? "Aggiornata da questa data in poi." : "Serie aggiornata.");
}

async function deleteFromDialog() {
  const occurrence = dialogState?.occurrence;
  if (!occurrence) return;
  const event = findEvent(occurrence.eventId);
  const scope = dialog.querySelector("#cal-form").elements.scope.value || "all";
  dialog.close();

  if (!event.recurrence) {
    if (!confirm(`Eliminare “${occurrence.subject}”? Le registrazioni collegate restano nella Raccolta, da organizzare.`)) return;
    await removeEvent(event.id);
    dialogState = null;
    context.announce("Lezione eliminata.");
    renderCalendar();
    return;
  }

  dialogState = null;
  const stamp = new Date().toISOString();

  if (scope === "all") {
    if (!confirm(`Eliminare tutte le lezioni della serie “${occurrence.subject}”? Le registrazioni collegate restano nella Raccolta.`)) { renderCalendar(); return; }
    await removeEvent(event.id);
    context.announce("Serie eliminata.");
    renderCalendar();
    return;
  }

  if (scope === "following") {
    if (occurrence.key === event.startDate) {
      await removeEvent(event.id);
    } else {
      const cutoff = dateKey(addDays(parseKey(occurrence.key), -1));
      const exceptions = {};
      for (const [key, value] of Object.entries(event.exceptions)) if (key <= cutoff) exceptions[key] = value;
      await persist({ ...event, exceptions, recurrence: { ...event.recurrence, end: { type: "until", until: cutoff } }, updatedAt: stamp });
    }
    context.announce("Lezioni successive eliminate.");
    renderCalendar();
    return;
  }

  await persist({ ...event, exceptions: { ...event.exceptions, [occurrence.key]: null }, updatedAt: stamp });
  context.announce("Lezione annullata per questa data.");
  renderCalendar();
}

/* ------------------------------------------------------------------ events */

function onClick(event) {
  const action = event.target.closest("[data-cal]")?.dataset.cal;
  if (action === "today") { state.anchor = startOfDay(new Date()); state.scrollDirty = true; renderCalendar(); return; }
  if (action === "prev") { step(-1); return; }
  if (action === "next") { step(1); return; }
  if (action === "new") { openEditor({ mode: "create", date: state.anchor, startMinutes: 540, endMinutes: 600 }); return; }

  const view = event.target.closest("[data-cal-view]")?.dataset.calView;
  if (view) { setView(view); return; }

  const more = event.target.closest("[data-more]")?.dataset.more;
  if (more) { setView("day", parseKey(more)); return; }

  const day = event.target.closest("[data-day]")?.dataset.day;
  if (day) { setView("day", parseKey(day)); return; }

  if (state.view === "month") {
    const chip = event.target.closest("[data-occurrence]");
    if (chip) {
      const occurrence = occurrenceById(chip.dataset.occurrence);
      if (occurrence) openOccurrence(occurrence);
      return;
    }
    const cell = event.target.closest(".cal-month-cell");
    if (cell) openEditor({ mode: "create", date: parseKey(cell.dataset.date), startMinutes: 540, endMinutes: 600 });
    return;
  }

  /* Pointer drag covers mouse and pen; touch reaches the grid as a plain tap. */
  if (event.pointerType !== "touch") return;
  const block = event.target.closest(".cal-event");
  if (block) {
    const occurrence = occurrenceById(block.dataset.occurrence);
    if (occurrence) openOccurrence(occurrence);
    return;
  }
  const column = event.target.closest(".cal-col");
  if (column) {
    const minutes = snap(minutesAtPointer(event.clientY));
    openEditor({ mode: "create", date: parseKey(column.dataset.date), startMinutes: minutes, endMinutes: Math.min(DAY_MINUTES, minutes + DEFAULT_DURATION) });
  }
}

/* Keyboard equivalents for the pointer gestures. */
async function onKeydown(event) {
  const element = event.target.closest?.("[data-occurrence]");
  if (element && (event.key === "Enter" || event.key === " ")) {
    event.preventDefault();
    const occurrence = occurrenceById(element.dataset.occurrence);
    if (occurrence) openOccurrence(occurrence);
    return;
  }
  if (!element || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
  const occurrence = occurrenceById(element.dataset.occurrence);
  if (!occurrence) return;
  event.preventDefault();
  const delta = event.key === "ArrowUp" ? -STEP_MINUTES : STEP_MINUTES;
  const start = event.shiftKey ? occurrence.startMinutes : Math.max(0, Math.min(DAY_MINUTES - (occurrence.endMinutes - occurrence.startMinutes), occurrence.startMinutes + delta));
  const end = event.shiftKey
    ? Math.max(occurrence.startMinutes + MIN_DURATION, Math.min(DAY_MINUTES, occurrence.endMinutes + delta))
    : start + (occurrence.endMinutes - occurrence.startMinutes);
  state.focusKey = occurrence.id;
  if (!occurrence.isRecurring) {
    const stored = findEvent(occurrence.eventId);
    await persist({ ...stored, startTime: toTime(start), endTime: toTime(end), updatedAt: new Date().toISOString() });
    renderCalendar();
    return;
  }
  await writeChange(occurrence, { startTime: toTime(start), endTime: toTime(end) }, "single");
}

/* -------------------------------------------------------------------- init */

export function initCalendar(options) {
  context = options;
  root = options.root;
  if (!root) return;
  /* A seven-column time grid is unusable on a phone; start on the day view. */
  if (window.matchMedia("(max-width: 700px)").matches) state.view = "day";
  root.addEventListener("click", onClick);
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("keydown", onKeydown);
  clearInterval(state.nowTimer);
  state.nowTimer = setInterval(() => { if (root.offsetParent) paintNow(); }, 60000);
  /* The hour height changes with the breakpoint, so block geometry is re-laid. */
  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (root.offsetParent) renderCalendar(); }, 150);
  });
  /* Bring legacy weekday-only blocks up to the current shape once. */
  const legacy = (context.state.classes || []).filter((item) => !item.startDate || item.recurrence === undefined);
  if (legacy.length) Promise.all(legacy.map((item) => context.persist(normalizeEvent(item)))).then(renderCalendar).catch(() => {});
}
