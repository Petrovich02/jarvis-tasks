"use strict";

const offlineCalendar = (() => {
  const empty = () => ({base: null, queued: [], acknowledged: 0});
  let opening;

  function database() {
    opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("jarvis-tasks-calendar", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("sessions");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => { opening = null; throw error; });
    return opening;
  }

  async function access(credentials, update) {
    const db = await database();
    const key = credentials.endpoint + "~" + credentials.secret;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction("sessions", update ? "readwrite" : "readonly");
      const store = transaction.objectStore("sessions");
      const request = store.get(key);
      let result, failure;
      request.onsuccess = () => {
        result = request.result ?? empty();
        if (!update) return;
        try {
          result = update(result);
          if (result) store.put(result, key);
          else store.delete(key);
        } catch (error) {
          failure = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Хранилище недоступно."));
    });
  }

  function taskId(entry) {
    return entry.mutation.operation === "create" ? "local:" + entry.id : entry.mutation.id;
  }

  function apply(items, entry) {
    const mutation = entry.mutation;
    const id = taskId(entry);
    const old = items.get(id);
    switch (mutation.operation) {
      case "delete":
        items.delete(id);
        return;
      case "create":
      case "update": {
        if (mutation.operation === "update" && !old) return;
        const subtasks = mutation.subtasks ?? old?.subtasks ?? [];
        items.set(id, {...old, id, text: mutation.text, planned_date: mutation.day, category: mutation.category,
          time: mutation.time, end_time: mutation.end_time, pinned: mutation.pinned ?? old?.pinned ?? false,
          subtasks, done: subtasks.length ? subtasks.every(step => step.done) : old?.done ?? false,
          revision: (old?.revision ?? 0) + 1});
        return;
      }
      case "done":
        if (old) items.set(id, {...old, done: mutation.done, revision: old.revision + 1,
          subtasks: old.subtasks.map(step => ({...step, done: mutation.done}))});
        return;
      case "subtasks":
        if (old) items.set(id, {...old, subtasks: mutation.subtasks, revision: old.revision + 1,
          done: mutation.subtasks.length ? mutation.subtasks.every(step => step.done) : old.done});
        return;
    }
  }

  function rows(state, base) {
    const items = new Map(base.all_items.map(row => [row.id, row]));
    state.queued.forEach(entry => apply(items, entry));
    return [...items.values()];
  }

  function view(state, base, day) {
    const {all_items, ...metadata} = base;
    const tasks = rows(state, base);
    const items = tasks.filter(row => row.planned_date === day || row.pinned && !row.done);
    items.sort((a, b) => Number(a.done) - Number(b.done) || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
      || (a.time || "24:00").localeCompare(b.time || "24:00"));
    const week = {};
    for (const row of tasks) {
      if (row.pinned) continue;
      const counts = week[row.planned_date] ??= {total: 0, done: 0, categories: Object.create(null)};
      const category = counts.categories[row.category] ??= {total: 0, done: 0};
      counts.total++;
      category.total++;
      if (row.done) { counts.done++; category.done++; }
    }
    return {...metadata, day, items, week};
  }

  function acknowledge(state, entry, result) {
    if (state.queued[0]?.id !== entry.id) return state;
    const id = taskId(entry);
    const queued = state.queued.slice(1).map(next => next.mutation.id === id && result.item ?
      {...next, mutation: {...next.mutation, id: result.id}} : next);
    const all_items = state.base.all_items.filter(row => row.id !== result.id);
    if (result.item) all_items.push(result.item);
    return {...state, base: {...state.base, all_items}, queued, acknowledged: state.acknowledged + 1};
  }

  return {empty, access, rows, view, taskId, acknowledge};
})();
