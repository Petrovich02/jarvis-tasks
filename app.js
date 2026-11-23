"use strict";

const byId = id => document.getElementById(id);
const make = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const allowedOrigin = "https://tasks.voxforma.ru";
const isTunnelPage = location.protocol === "https:" && location.hostname.endsWith(".ngrok-free.dev")
  && location.pathname.startsWith("/mobile-planner/");
const isPlannerSite = location.origin === allowedOrigin || isTunnelPage;
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
  if (!match || isTunnelPage && match[1] !== location.hostname) return null;
  return {endpoint: `https://${match[1]}/mobile-planner/tasks`, secret: match[2]};
}

let connection = isPlannerSite ? readKey(readStorage(keyName, "")) : null;
let cachedDays = connection ? readStorage(cacheName, []) : [];
if (!Array.isArray(cachedDays)) cachedDays = [];
let selectedDay = today();
let section = "";
let renderedSections = "";
let snapshot = null;
let cacheTime = 0;
let online = false;
let busy = false;
let loading = false;
let loadVersion = 0;
let editing = null;
let newTaskRequest = "";
let categoryRequest = "";
let categoryRevision = 0;
let notices = null;
let noticeLoading = false;
let noticeBusy = false;
let pushRegistration = null;
let pushSubscription = null;
let pushKey = null;
let workflowSnapshot = null;
let workflowLoading = false;
let workflowSubmitting = false;
let workflowRequest = null;
const expandedTasks = new Set();
const noticeSources = {personal: "Личные задачи", editing: "JCenter · заказы на монтаж", crm: "CRM", mailing: "Рассылка"};
const colorLabels = {blue: "Голубой", green: "Зелёный", purple: "Сиреневый", peach: "Персиковый",
  pink: "Розовый", teal: "Бирюзовый", yellow: "Жёлтый"};

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api({day, mutation, credentials = connection, route = "tasks"} = {}) {
  const url = new URL(route, credentials.endpoint);
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
  byId("show-notices").hidden = !connection;
  if (!connection) return;
  const last = cacheTime ? new Date(cacheTime).toLocaleTimeString("ru-RU", {hour: "2-digit", minute: "2-digit"}) : "";
  byId("status").textContent = online ? "Связь с Джарвисом" : loading ? "Подключаюсь…" :
    last ? `ПК недоступен · копия на ${last}` : "ПК недоступен";
  byId("day").value = selectedDay;
  byId("add-task").disabled = !online || busy || !snapshot;
  byId("show-categories").disabled = !online || busy || !snapshot;
  byId("show-workflows").disabled = !online;
  byId("tasks").querySelectorAll("input, button").forEach(control => { control.disabled = !online || busy; });
}

function sectionColor(key) {
  if (!key) return "#d8e3f6";
  const details = snapshot?.category_details?.find(item => item.id === key);
  return snapshot?.category_colors?.[details?.color] ?? snapshot?.category_colors?.blue ?? "var(--accent)";
}

function sectionMark() {
  const mark = make("span", undefined, "section-mark");
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

function weekView() {
  const monday = addDays(selectedDay, -((new Date(selectedDay + "T12:00:00Z").getUTCDay() + 6) % 7));
  const restEnabled = snapshot?.category_details?.find(item => item.id === section)?.rest;
  const buttons = Array.from({length: 7}, (_, i) => {
    const day = addDays(monday, i);
    const counts = snapshot?.week[day];
    const open = section ? counts?.categories?.[section] : counts;
    const button = make("button");
    const label = [formatDay(day, {weekday: "long", day: "numeric", month: "long"})];
    if (day === selectedDay) button.setAttribute("aria-current", "date");
    button.append(make("span", formatDay(day, {weekday: "short"})), make("strong", String(Number(day.slice(-2)))));
    if (open?.total) {
      button.append(make("span", `${open.done}/${open.total}`, "week-count"));
      label.push(`${open.done} из ${open.total} выполнено`);
      if (section) {
        button.classList.add("week-section");
        button.style.setProperty("--section-color", sectionColor(section));
      }
      const marks = make("span", undefined, "week-marks");
      for (const [key, name] of Object.entries(snapshot?.categories ?? {})) {
        if ((section && section !== key) || !counts?.categories?.[key]?.total) continue;
        const mark = sectionMark();
        mark.style.setProperty("--section-color", sectionColor(key));
        marks.append(mark);
        label.push(name);
      }
      if (marks.childElementCount) button.append(marks);
    } else if (restEnabled) {
      button.classList.add("week-rest");
      button.append(make("span", "Отдых", "week-count"));
      label.push("Отдых");
    }
    button.setAttribute("aria-label", label.join(", "));
    button.onclick = () => selectDay(day);
    return button;
  });
  byId("week").replaceChildren(...buttons);
}

function renderSections() {
  const strip = byId("sections");
  const choices = [["", "Все"], ...Object.entries(snapshot?.categories ?? {})]
    .map(([key, name]) => [key, name, sectionColor(key)]);
  const signature = JSON.stringify(choices);
  if (renderedSections !== signature) {
    const position = strip.scrollLeft;
    strip.replaceChildren(...choices.map(([key, name, color]) => {
      const button = make("button");
      button.dataset.section = key;
      button.style.setProperty("--section-color", color);
      button.append(sectionMark(), make("span", name, "section-name"));
      button.onclick = () => { section = key; render(); };
      return button;
    }));
    strip.scrollLeft = position;
    renderedSections = signature;
  }
  for (const button of strip.children) {
    button.setAttribute("aria-pressed", String(button.dataset.section === section));
  }
}

function render() {
  if (!connection) return renderState();
  if (section && snapshot && !snapshot.categories[section]) section = "";
  weekView();
  renderSections();
  const rows = snapshot?.items.filter(row => !section || row.category === section) ?? [];
  byId("list-heading").textContent = rows.length ? `Задачи · ${rows.filter(row => row.done).length}/${rows.length}` : "Задачи";
  const empty = loading && !snapshot ? "Загружаю задачи…" : !snapshot ? "На эту дату нет сохранённой копии." : "На эту дату задач нет.";
  byId("tasks").replaceChildren(...(rows.length ? rows.map(taskCard) : [make("p", empty, "muted")]));
  renderState();
}

function taskCard(row) {
  const card = make("article", undefined, row.done ? "task done" : "task");
  card.style.setProperty("--section-color", sectionColor(row.category));
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
  const category = snapshot.categories[row.category];
  const meta = make("small", time);
  if (category) meta.append(time ? " · " : "", make("span", category, "task-section"));
  button.append(make("strong", row.text), meta);
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

async function change(mutation, errorId = "list-error", route = "tasks", form = byId("editor")) {
  if (!online || busy) return false;
  busy = true;
  byId(errorId).textContent = "";
  renderState();
  const controls = [...form.querySelectorAll("button, input, select")].filter(control => !control.disabled);
  controls.forEach(control => { control.disabled = true; });
  try {
    await api({mutation, route});
    await sync();
    if (route === "tasks") void syncNotices();
    return true;
  } catch (error) {
    byId(errorId).textContent = error instanceof ApiError ? error.message : "Связь прервалась. Проверь список и повтори при необходимости.";
    await sync();
    return false;
  } finally {
    busy = false;
    controls.forEach(control => { control.disabled = false; });
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

function setOptions(id, choices) {
  byId(id).replaceChildren(...choices.map(([value, label]) => {
    const option = make("option", label);
    option.value = value;
    return option;
  }));
}

function selectCategory() {
  const id = byId("category-choice").value;
  const item = snapshot.category_details?.find(category => category.id === id);
  byId("category-name").value = item?.name ?? "";
  byId("category-color").value = item?.color ?? "blue";
  byId("category-rest").checked = Boolean(item?.rest);
  const canRemove = Boolean(id && id !== "day");
  for (const element of ["category-target", "category-target-label", "remove-category"]) byId(element).hidden = !canRemove;
  setOptions("category-target", Object.entries(snapshot.categories).filter(([key]) => key !== id));
  byId("category-error").textContent = "";
}

function openCategories() {
  if (!online || busy || !snapshot) return;
  categoryRequest = crypto.randomUUID();
  categoryRevision = snapshot.category_revision;
  setOptions("category-choice", [["", "Новый раздел"], ...Object.entries(snapshot.categories)]);
  setOptions("category-color", Object.keys(snapshot.category_colors ?? colorLabels).map(key => [key, colorLabels[key] ?? key]));
  byId("category-choice").value = section;
  selectCategory();
  byId("category-editor").showModal();
}

async function saveCategory(value) {
  const form = byId("category-editor");
  if (await change({...value, revision: categoryRevision}, "category-error", "tasks/categories", form)) form.close();
  else if (snapshot?.category_revision !== categoryRevision) {
    byId("category-error").textContent = "Разделы изменились. Закрой настройки и открой их заново.";
  }
}

function noticeAction(label, handler, disabled = false) {
  const button = make("button", label, "quiet");
  button.type = "button";
  button.disabled = noticeBusy || disabled;
  button.onclick = handler;
  return button;
}

function noticeCard(row) {
  const card = make("article", undefined, "notice-card");
  const source = noticeSources[row.source] ?? "Джарвис";
  const due = row.due_at ? new Date(row.due_at * 1000).toLocaleString("ru-RU",
    {timeZone: "Asia/Krasnoyarsk", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"}) : "Требует внимания";
  card.append(make("small", `${source} · ${due}`, "muted"), make("strong", row.title));
  if (row.action && row.action !== row.title) card.append(make("p", row.action));
  if (row.body && row.body !== row.action) {
    const details = make("details");
    details.append(make("summary", "Подробнее"), make("p", row.body));
    card.append(details);
  }
  const actions = make("div", undefined, "notice-actions");
  actions.append(noticeAction("✓ Просмотрено", () => acknowledge({ids: [row.id], dismiss: true})));
  if (row.due) {
    const snoozed = row.snooze_until * 1000 > Date.now();
    actions.append(noticeAction(snoozed ? "Отложено" : "Через час",
      () => acknowledge({ids: [row.id], snooze_seconds: 3600}), snoozed));
  }
  if (row.task) actions.append(noticeAction("Выполнено",
    () => acknowledge({...row.task, operation: "done", done: true}, "tasks")));
  card.append(actions);
  return card;
}

function renderNotices() {
  const count = notices?.due_count ?? 0;
  byId("notice-count").hidden = !count;
  byId("notice-count").textContent = count > 99 ? "99+" : count;
  byId("show-notices").setAttribute("aria-label", count ? `Уведомления (${count})` : "Уведомления");
  byId("notice-clear").hidden = !notices?.total;
  byId("notice-clear").disabled = noticeBusy;
  const list = byId("notice-list");
  if (notices?.items.length) {
    list.replaceChildren(...notices.items.map(noticeCard));
    if (notices.total > notices.items.length) {
      list.append(make("p", `Показано ${notices.items.length} из ${notices.total}`, "muted"));
    }
  } else {
    list.replaceChildren(make("p", notices ? "Непросмотренных уведомлений нет." : "Загружаю уведомления…", "muted"));
  }
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    navigator.setAppBadge?.(count).catch(() => {});
  }
}

async function syncNotices() {
  if (!connection || noticeLoading || noticeBusy) return;
  const credentials = connection;
  noticeLoading = true;
  try {
    const next = await api({route: "reminders", credentials});
    if (connection !== credentials || noticeBusy) return;
    byId("notices-error").textContent = "";
    if (notices?.total !== next.total || notices?.due_count !== next.due_count
        || JSON.stringify(notices?.items) !== JSON.stringify(next.items)) {
      notices = next;
      renderNotices();
    }
  } catch {
    if (connection === credentials && byId("notices").open) {
      byId("notices-error").textContent = "Не удалось обновить уведомления. Проверь связь с ПК.";
    }
  } finally { noticeLoading = false; }
}

async function acknowledge(mutation, route = "reminders/ack") {
  if (!connection || noticeBusy) return;
  noticeBusy = true;
  renderNotices();
  try {
    const result = await api({route, mutation});
    if (result.reminders) notices = result.reminders;
    if (route === "tasks") void sync();
  } catch (error) {
    byId("notices-error").textContent = error instanceof ApiError ? error.message : "Не удалось сохранить. Проверь связь с ПК.";
  } finally {
    noticeBusy = false;
    renderNotices();
  }
  void syncNotices();
}

function updatePushControls() {
  const button = byId("push-toggle");
  button.textContent = pushSubscription ? "Отключить на телефоне" : "Включить на телефоне";
  byId("push-test").hidden = !pushSubscription;
  button.hidden = !pushKey;
}

async function preparePush() {
  const status = byId("push-status");
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
    status.textContent = "Для системных уведомлений на iPhone открой задачник с домашнего экрана.";
    return;
  }
  try {
    const credentials = connection;
    const {public_key} = await api({route: "push", credentials});
    if (credentials !== connection) return;
    pushRegistration = await navigator.serviceWorker.ready;
    if (credentials !== connection) return;
    pushKey = Uint8Array.from(atob(public_key.replace(/-/g, "+").replace(/_/g, "/")), char => char.charCodeAt(0));
    pushSubscription = await pushRegistration.pushManager.getSubscription();
    status.textContent = Notification.permission === "denied" ? "Уведомления заблокированы в настройках устройства." : "";
    updatePushControls();
  } catch {
    status.textContent = "Не удалось загрузить настройки системных уведомлений.";
  }
}

async function togglePush() {
  const button = byId("push-toggle");
  button.disabled = true;
  const status = byId("push-status");
  try {
    if (pushSubscription) {
      await api({route: "push", mutation: {action: "unsubscribe", endpoint: pushSubscription.endpoint}});
      await pushSubscription.unsubscribe();
      pushSubscription = null;
    } else {
      const device = await pushRegistration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: pushKey});
      const {endpoint, keys} = device.toJSON();
      try { await api({route: "push", mutation: {action: "subscribe", endpoint, keys}}); }
      catch (error) { await device.unsubscribe().catch(() => {}); throw error; }
      pushSubscription = device;
    }
    status.textContent = pushSubscription ? "Системные уведомления включены." : "Системные уведомления выключены.";
  } catch (error) {
    status.textContent = error instanceof ApiError ? error.message : "Не удалось изменить подписку. Проверь разрешение на уведомления.";
  } finally {
    button.disabled = false;
    updatePushControls();
  }
}

function openNotices() {
  if (!connection || byId("notices").open) return;
  byId("notices").showModal();
  renderNotices();
  void syncNotices();
  void preparePush();
}

function renderWorkflows() {
  const actions = new Map(workflowSnapshot?.actions.map(action => [action.id, action.label]));
  const runs = workflowSnapshot?.runs ?? [];
  const active = action => workflowSubmitting || runs.some(run => run.action === action && ["queued", "running"].includes(run.status));
  byId("workflow-voice").hidden = !actions.has("news_voice");
  byId("run-collect").hidden = !actions.has("news_collect");
  byId("run-voice").disabled = active("news_voice");
  byId("run-collect").disabled = active("news_collect");
  byId("workflow-link").disabled = active("news_voice");
  byId("workflow-status").textContent = !workflowSnapshot ? "Проверяю связь с ПК…"
    : !actions.size ? "Команды на ПК ещё не настроены." : "";
  byId("workflow-runs").replaceChildren(...runs.map(run => {
    const item = make("li");
    item.append(make("strong", actions.get(run.action)), make("p", run.detail,
      run.status === "failed" || run.status === "interrupted" ? "error" : "muted"));
    return item;
  }));
}

async function syncWorkflows() {
  if (!connection || workflowLoading || workflowSubmitting || !byId("workflows").open) return;
  const credentials = connection;
  workflowLoading = true;
  try {
    const next = await api({route: "workflows", credentials});
    if (connection !== credentials || workflowSubmitting) return;
    if (JSON.stringify(workflowSnapshot) !== JSON.stringify(next)) {
      workflowSnapshot = next;
      renderWorkflows();
    }
  } catch {
    if (connection === credentials) byId("workflow-status").textContent = "ПК недоступен. Попробуй открыть команды ещё раз.";
  } finally { workflowLoading = false; }
}

async function runWorkflow(action) {
  if (!connection || workflowSubmitting) return;
  const credentials = connection;
  const link = action === "news_voice" ? byId("workflow-link").value.trim() : "";
  if (workflowRequest?.action !== action || workflowRequest?.link !== link) {
    workflowRequest = {action, link, request_id: crypto.randomUUID()};
  }
  workflowSubmitting = true;
  byId("workflow-error").textContent = "";
  renderWorkflows();
  try {
    const next = await api({route: "workflows", mutation: workflowRequest, credentials});
    if (connection !== credentials) return;
    workflowSnapshot = next;
    workflowRequest = null;
    if (link) byId("workflow-link").value = "";
  } catch (error) {
    if (connection === credentials) byId("workflow-error").textContent = error instanceof ApiError
      ? error.message : "ПК не подтвердил получение команды. Можно повторить запрос.";
  } finally {
    workflowSubmitting = false;
    renderWorkflows();
  }
}

function disconnect() {
  ++loadVersion;
  connection = null;
  snapshot = null;
  cachedDays = [];
  notices = null;
  workflowSnapshot = null;
  workflowRequest = null;
  pushKey = null;
  pushSubscription = null;
  online = false;
  loading = false;
  byId("key").value = "";
  byId("status").textContent = "Задачник Джарвиса";
  byId("tasks").replaceChildren();
  byId("editor").close();
  byId("category-editor").close();
  byId("notices").close();
  byId("workflows").close();
  renderNotices();
  updatePushControls();
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
  if (!candidate || !isPlannerSite) {
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
    void syncNotices();
    if (new URLSearchParams(location.search).get("view") === "notices") openNotices();
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
byId("disconnect").onclick = async () => {
  if (busy || noticeBusy) return;
  const registration = await navigator.serviceWorker?.getRegistration().catch(() => null);
  const device = await registration?.pushManager?.getSubscription().catch(() => null);
  if (device) {
    await device.unsubscribe().catch(() => false);
    void api({route: "push", mutation: {action: "unsubscribe", endpoint: device.endpoint}}).catch(() => {});
  }
  disconnect();
};
byId("reload").onclick = async () => {
  byId("reload").disabled = true;
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();
  } catch { /* The cached app can still be opened while the PC or internet is offline. */ }
  location.reload();
};
byId("show-notices").onclick = openNotices;
byId("close-notices").onclick = () => byId("notices").close();
byId("notice-clear").onclick = () => acknowledge({dismiss: true, all_current: true});
byId("push-toggle").onclick = togglePush;
byId("push-test").onclick = async () => {
  const button = byId("push-test");
  button.disabled = true;
  try {
    await api({route: "push", mutation: {action: "test", endpoint: pushSubscription.endpoint}});
    byId("push-status").textContent = "Пробное уведомление отправлено.";
  } catch (error) {
    if (error.status === 410) {
      await pushSubscription?.unsubscribe().catch(() => {});
      pushSubscription = null;
      updatePushControls();
    }
    byId("push-status").textContent = error instanceof ApiError ? error.message : "Не удалось отправить пробное уведомление.";
  } finally { button.disabled = false; }
};
byId("show-categories").onclick = openCategories;
byId("show-workflows").onclick = () => {
  byId("workflows").showModal();
  byId("workflow-error").textContent = "";
  renderWorkflows();
  void syncWorkflows();
};
byId("close-workflows").onclick = () => byId("workflows").close();
byId("run-voice").onclick = () => runWorkflow("news_voice");
byId("run-collect").onclick = () => runWorkflow("news_collect");
byId("close-categories").onclick = () => byId("category-editor").close();
byId("category-editor").oncancel = event => { if (busy) event.preventDefault(); };
byId("category-choice").onchange = selectCategory;
byId("category-form").onsubmit = event => {
  event.preventDefault();
  const id = byId("category-choice").value;
  const identity = id ? {operation: "update", id} : {operation: "create", request_id: categoryRequest};
  void saveCategory({...identity, name: byId("category-name").value.trim(),
    color: byId("category-color").value, rest: byId("category-rest").checked});
};
byId("remove-category").onclick = () => {
  const id = byId("category-choice").value;
  const target = byId("category-target").value;
  if (id && target && confirm(`Удалить раздел «${snapshot.categories[id]}» и перенести его задачи в «${snapshot.categories[target]}»?`)) {
    void saveCategory({operation: "delete", id, target});
  }
};
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
  if (!connection || document.hidden) return;
  void syncNotices();
  void syncWorkflows();
  if (!loading && !busy && !byId("editor").open && !byId("category-editor").open) void sync();
};
document.addEventListener("visibilitychange", refresh);
window.addEventListener("online", refresh);
window.addEventListener("focus", refresh);
setInterval(refresh, 60000);
setInterval(() => { if (!document.hidden) void syncNotices(); }, 15000);
setInterval(() => { if (!document.hidden) void syncWorkflows(); }, 4000);

if (!isPlannerSite) {
  byId("status").textContent = "Открой задачник по адресу tasks.voxforma.ru.";
} else if (connection) {
  restoreDay(selectedDay);
  void sync(true);
  void syncNotices();
  if (new URLSearchParams(location.search).get("view") === "notices") openNotices();
} else {
  renderState();
}
if (isPlannerSite && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", {updateViaCache: "none"}).catch(() => {});
  navigator.serviceWorker.addEventListener("message", event => {
    if (event.data === "open-notices") openNotices();
  });
}
