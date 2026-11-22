"use strict";

const byId = id => document.getElementById(id);
const make = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const allowedOrigin = "https://tasks.voxforma.ru";
const storagePrefix = "jarvis-tasks-v1:";
const keyName = storagePrefix + "connection";
const cacheName = storagePrefix + "days";
const formatDay = (value, options) => new Intl.DateTimeFormat("ru-RU", {...options, timeZone: "UTC"})
  .format(new Date(value + "T12:00:00Z"));
const addDays = (day, count) => {
  const date = new Date(day + "T12:00:00Z");
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};
function today() {
  const parts = new Intl.DateTimeFormat("en-CA", {timeZone: "Asia/Krasnoyarsk",
    year: "numeric", month: "2-digit", day: "2-digit"}).formatToParts();
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
function readStorage(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* The current session still works if storage is unavailable. */ }
}
function readKey(value) {
  if (typeof value !== "string") return null;
  const match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ngrok-free\.dev)~([A-Za-z0-9_-]{43})$/.exec(value.trim());
  return match ? {endpoint: `https://${match[1]}/mobile-planner/tasks`, secret: match[2]} : null;
}

let connection = location.origin === allowedOrigin ? readKey(readStorage(keyName, "")) : null;
let cachedDays = connection ? readStorage(cacheName, []) : [];
if (!Array.isArray(cachedDays)) cachedDays = [];
let selectedDay = today();
let section = "";
let snapshot = null;
let cacheTime = 0;
let online = false;
let busy = false;
let loading = false;
let loadVersion = 0;
let editing = null;
let newTaskRequest = "";
const expandedTasks = new Set();

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api({day, mutation, credentials = connection} = {}) {
  const url = new URL(credentials.endpoint);
  if (day) url.searchParams.set("day", day);
  const headers = {Authorization: `Bearer ${credentials.secret}`, "ngrok-skip-browser-warning": "1"};
  if (mutation) headers["Content-Type"] = "application/json";
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), 8000);
  try {
    const response = await fetch(url, {headers, signal: timer.signal, cache: "no-store", redirect: "error",
      credentials: "omit", ...(mutation && {method: "POST", body: JSON.stringify(mutation)})});
    const data = await response.json();
    if (!response.ok) throw new ApiError(response.status, data.error || "Не удалось выполнить запрос.");
    return data;
  } finally { clearTimeout(timeout); }
}

function remember(snapshot) {
  const entry = {time: Date.now(), snapshot};
  cachedDays = [entry, ...cachedDays.filter(item => item.snapshot.day !== snapshot.day)].slice(0, 10);
  store(cacheName, cachedDays);
  return entry.time;
}

function restoreDay(day) {
  const entry = cachedDays.find(item => item.snapshot.day === day);
  snapshot = entry?.snapshot ?? null;
  cacheTime = entry?.time ?? 0;
}

function renderState() {
  byId("connection").hidden = Boolean(connection);
  byId("planner").hidden = !connection;
  byId("disconnect").hidden = !connection;
  if (!connection) return;
  const last = cacheTime ? new Date(cacheTime).toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit"}) : "";
  byId("status").textContent = online ? "Связь с Джарвисом" : loading ? "Подключаюсь…" :
    last ? `ПК недоступен · копия на ${last}` : "ПК недоступен";
  byId("day").value = selectedDay;
  byId("add-task").disabled = !online || busy || !snapshot;
  byId("tasks").querySelectorAll("input, button").forEach(control => { control.disabled = !online || busy; });
}

function weekView() {
  const monday = addDays(selectedDay, -((new Date(selectedDay + "T12:00:00Z").getUTCDay() + 6) % 7));
  const buttons = Array.from({length: 7}, (_, i) => {
    const day = addDays(monday, i);
    const counts = snapshot?.week[day];
    const open = section ? counts?.categories[section] : counts;
    const button = make("button");
    button.setAttribute("aria-label", formatDay(day, {weekday: "long", day: "numeric", month: "long"}));
    if (day === selectedDay) button.setAttribute("aria-current", "date");
    button.append(make("span", formatDay(day, {weekday: "short"})), make("strong", String(Number(day.slice(-2)))));
    if (open?.total) button.append(make("span", `${open.done}/${open.total}`));
    button.onclick = () => selectDay(day);
    return button;
  });
  byId("week").replaceChildren(...buttons);
}

function render() {
  if (!connection) return renderState();
  if (section && snapshot && !snapshot.categories[section]) section = "";
  weekView();
  const choices = [["", "Все"], ...Object.entries(snapshot?.categories ?? {})];
  byId("sections").replaceChildren(...choices.map(([key, name]) => {
    const button = make("button", name);
    button.setAttribute("aria-pressed", String(key === section));
    button.onclick = () => { section = key; render(); byId("sections").querySelector('[aria-pressed="true"]').focus(); };
    return button;
  }));
  const rows = snapshot?.items.filter(row => !section || row.category === section) ?? [];
  byId("list-heading").textContent = rows.length ? `Задачи · ${rows.filter(row => row.done).length}/${rows.length}` : "Задачи";
  const empty = loading && !snapshot ? "Загружаю задачи…" : !snapshot ? "На эту дату нет сохранённой копии." : "На эту дату задач нет.";
  byId("tasks").replaceChildren(...(rows.length ? rows.map(taskCard) : [make("p", empty, "muted")]));
  renderState();
}

function taskCard(row) {
  const card = make("article", undefined, row.done ? "task done" : "task");
  const line = make("div", undefined, "task-line");
  const label = make("label", undefined, "check");
  const checkbox = make("input");
  checkbox.type = "checkbox";
  checkbox.checked = row.done;
  checkbox.setAttribute("aria-label", `Выполнено: ${row.text}`);
  checkbox.onchange = async () => {
    if (!await change({operation: "done", id: row.id, revision: row.revision, done: checkbox.checked})) checkbox.checked = row.done;
  };
  label.append(checkbox);
  const button = make("button", undefined, "task-name");
  const time = row.end_time ? `${row.time} – ${row.end_time}` : row.time;
  button.append(make("strong", row.text), make("small", [time, snapshot.categories[row.category]].filter(Boolean).join(" · ")));
  button.onclick = () => openEditor(row);
  line.append(label, button);
  card.append(line);
  if (!row.subtasks.length) return card;

  const details = make("details");
  details.open = expandedTasks.has(row.id);
  details.ontoggle = () => details.open ? expandedTasks.add(row.id) : expandedTasks.delete(row.id);
  details.append(make("summary", `Подзадачи · ${row.subtasks.filter(step => step.done).length}/${row.subtasks.length}`));
  for (const step of row.subtasks) {
    const item = make("label", undefined, "step-line");
    const tick = make("input");
    tick.type = "checkbox";
    tick.checked = step.done;
    tick.onchange = async () => {
      const subtasks = row.subtasks.map(part => ({...part, done: part.id === step.id ? tick.checked : part.done}));
      if (!await change({operation: "subtasks", id: row.id, revision: row.revision, subtasks})) tick.checked = step.done;
    };
    item.append(tick, make("span", step.text));
    details.append(item);
  }
  card.append(details);
  return card;
}

function selectDay(day, force = false) {
  if (!day || day < "2000-01-01" || day > "2100-12-31" || busy) return;
  if (day === selectedDay && !force) return;
  selectedDay = day;
  restoreDay(day);
  online = false;
  byId("list-error").textContent = "";
  void sync(true);
}

async function sync(redraw = false) {
  if (!connection) return;
  const revision = ++loadVersion;
  loading = true;
  if (redraw) render();
  try {
    const next = await api({day: selectedDay});
    if (revision !== loadVersion) return;
    const changed = JSON.stringify(snapshot) !== JSON.stringify(next);
    snapshot = next;
    cacheTime = remember(next);
    online = true;
    loading = false;
    if (changed || redraw) render();
    else renderState();
  } catch (error) {
    if (revision !== loadVersion) return;
    online = false;
    loading = false;
    if (error.status === 403) {
      disconnect();
      byId("connect-error").textContent = error.message;
      return;
    }
    if (redraw) render();
    else renderState();
  }
}

async function change(mutation, errorId = "list-error") {
  if (!online || busy) return false;
  busy = true;
  byId(errorId).textContent = "";
  renderState();
  const editor = byId("editor");
  editor.querySelectorAll("button, input, select").forEach(control => { control.disabled = true; });
  try {
    await api({mutation});
    await sync();
    return true;
  } catch (error) {
    byId(errorId).textContent = error instanceof ApiError ? error.message : "Связь прервалась. Проверь список и повтори при необходимости.";
    await sync();
    return false;
  } finally {
    busy = false;
    editor.querySelectorAll("button, input, select").forEach(control => { control.disabled = false; });
    renderState();
  }
}

function openEditor(row) {
  if (!snapshot || !online || busy) return;
  editing = row || null;
  newTaskRequest = crypto.randomUUID();
  byId("editor-title").textContent = row ? "Редактировать задачу" : "Новая задача";
  byId("title").value = row?.text ?? "";
  byId("task-day").value = row?.planned_date ?? selectedDay;
  byId("start").value = row?.time ?? "";
  byId("end").value = row?.end_time ?? "";
  byId("category").replaceChildren(...Object.entries(snapshot.categories).map(([key, name]) => {
    const option = make("option", name);
    option.value = key;
    return option;
  }));
  byId("category").value = row?.category ?? (section || "day");
  byId("steps").replaceChildren();
  row?.subtasks.forEach(addStep);
  byId("remove-task").hidden = !row;
  byId("edit-error").textContent = "";
  byId("editor").showModal();
}

function addStep(step = {id: crypto.randomUUID(), text: "", done: false}) {
  const steps = byId("steps");
  if (steps.children.length >= 20) return;
  const line = make("div", undefined, "step-line");
  line.dataset.stepId = step.id;
  const checkbox = make("input");
  checkbox.type = "checkbox";
  checkbox.checked = step.done;
  checkbox.setAttribute("aria-label", "Подзадача выполнена");
  const input = make("input");
  input.value = step.text;
  input.maxLength = 240;
  input.placeholder = "Подзадача";
  input.setAttribute("aria-label", "Название подзадачи");
  const remove = make("button", "×", "quiet");
  remove.type = "button";
  remove.setAttribute("aria-label", "Убрать подзадачу");
  remove.onclick = () => line.remove();
  line.append(checkbox, input, remove);
  steps.append(line);
  return input;
}

function disconnect() {
  ++loadVersion;
  connection = null;
  snapshot = null;
  cachedDays = [];
  online = false;
  loading = false;
  byId("key").value = "";
  byId("status").textContent = "Задачник Джарвиса";
  byId("tasks").replaceChildren();
  byId("editor").close();
  try { localStorage.removeItem(keyName); localStorage.removeItem(cacheName); }
  catch { /* No locally persisted session to clear. */ }
  renderState();
}

byId("connect-form").onsubmit = async event => {
  event.preventDefault();
  const input = byId("key");
  const value = input.value.trim();
  const candidate = readKey(value);
  const errorText = byId("connect-error");
  if (!candidate || location.origin !== allowedOrigin) {
    errorText.textContent = "Вставь ключ подключения целиком.";
    return;
  }
  const button = event.submitter;
  button.disabled = true;
  errorText.textContent = "";
  try {
    snapshot = await api({credentials: candidate});
    connection = candidate;
    selectedDay = snapshot.day;
    cachedDays = [];
    store(keyName, value);
    cacheTime = remember(snapshot);
    input.value = "";
    online = true;
    render();
  } catch (error) {
    errorText.textContent = error instanceof ApiError ? error.message : "Нет связи с ПК. Проверь, что Джарвис запущен.";
  } finally { button.disabled = false; }
};

byId("previous").onclick = () => selectDay(addDays(selectedDay, -1));
byId("next").onclick = () => selectDay(addDays(selectedDay, 1));
byId("today").onclick = () => selectDay(today(), true);
byId("day").onchange = event => selectDay(event.target.value);
byId("add-task").onclick = () => openEditor();
byId("add-step").onclick = () => addStep()?.focus();
byId("disconnect").onclick = () => { if (!busy) disconnect(); };
byId("close-editor").onclick = () => byId("editor").close();
byId("editor").oncancel = event => { if (busy) event.preventDefault(); };
byId("remove-task").onclick = async () => {
  if (!editing || !confirm(`Удалить задачу «${editing.text}»?`)) return;
  if (await change({operation: "delete", id: editing.id, revision: editing.revision}, "edit-error")) byId("editor").close();
};
byId("task-form").onsubmit = async event => {
  event.preventDefault();
  const text = byId("title").value.trim();
  if (!text) { byId("edit-error").textContent = "Введи название задачи."; return; }
  const subtasks = [...byId("steps").children].map(line => ({id: line.dataset.stepId,
    text: line.querySelector('input:not([type="checkbox"])').value.trim(),
    done: line.querySelector('input[type="checkbox"]').checked})).filter(step => step.text);
  const identity = editing ? {operation: "update", id: editing.id, revision: editing.revision} :
    {operation: "create", request_id: newTaskRequest};
  const day = byId("task-day").value;
  const saved = await change({...identity, text, day, subtasks, category: byId("category").value,
    time: byId("start").value, end_time: byId("end").value}, "edit-error");
  if (saved) { byId("editor").close(); selectDay(day); }
};

const refresh = () => {
  if (connection && !document.hidden && !loading && !busy && !byId("editor").open) void sync();
};
document.addEventListener("visibilitychange", refresh);
window.addEventListener("online", refresh);
window.addEventListener("focus", refresh);
setInterval(refresh, 60000);

if (location.origin !== allowedOrigin) {
  byId("status").textContent = "Открой задачник по адресу tasks.voxforma.ru.";
} else if (connection) {
  restoreDay(selectedDay);
  void sync(true);
} else {
  renderState();
}
if (location.origin === allowedOrigin && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
