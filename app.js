const DB_NAME = "offline-videos";
const DB_VERSION = 1;
const STORE = "videos";
const TIMEUPDATE_INTERVAL_MS = 1500;

/**
 * @typedef {Object} VideoRecord
 * @property {string} id
 * @property {string} name
 * @property {string} type
 * @property {Blob} blob
 * @property {number} positionSec
 */

/** @type {IDBDatabase | null} */
let db = null;

/** id -> object URL for cleanup */
const objectUrls = new Map();

/** id -> last throttled save timestamp */
const throttleMarks = new Map();

/** Nested IndexedDB writes: show one “Saving…” until all finish */
let saveDepth = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let saveStatusIdleTimer = null;

function beginSave() {
  saveDepth += 1;
  if (saveDepth === 1) setSaveStatus("saving", "Saving…");
}

function endSave() {
  saveDepth = Math.max(0, saveDepth - 1);
  if (saveDepth === 0) setSaveStatus("saved", "Saved");
}

/**
 * @param {"ready" | "saving" | "saved"} state
 * @param {string} text
 */
function setSaveStatus(state, text) {
  const el = document.getElementById("save-status");
  if (el) {
    el.dataset.state = state;
    el.textContent = text;
  }
  if (saveStatusIdleTimer !== null) {
    clearTimeout(saveStatusIdleTimer);
    saveStatusIdleTimer = null;
  }
  if (state === "saved") {
    saveStatusIdleTimer = setTimeout(() => {
      saveStatusIdleTimer = null;
      if (saveDepth === 0) setSaveStatus("ready", "Ready");
    }, 1400);
  }
}

/**
 * @param {VideoRecord} record
 * @param {{ track?: boolean }} [options]
 */
function putVideo(record, options = {}) {
  const track = options.track !== false;
  if (track) beginSave();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.put(record);
    req.onerror = () => {
      if (track) endSave();
      reject(req.error);
    };
    tx.oncomplete = () => {
      if (track) endSave();
      resolve();
    };
  });
}

/**
 * @param {string} id
 * @param {{ track?: boolean }} [options]
 */
function deleteVideo(id, options = {}) {
  const track = options.track !== false;
  if (track) beginSave();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.delete(id);
    req.onerror = () => {
      if (track) endSave();
      reject(req.error);
    };
    tx.oncomplete = () => {
      if (track) endSave();
      resolve();
    };
  });
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(STORE)) {
        idb.createObjectStore(STORE, { keyPath: "id" });
      }
    };
  });
}

/**
 * @param {string} id
 * @returns {Promise<VideoRecord | undefined>}
 */
function getVideo(id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.get(id);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

/**
 * @returns {Promise<VideoRecord[]>}
 */
function getAllVideos() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const store = tx.objectStore(STORE);
    const req = store.getAll();
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result || []);
  });
}

/**
 * @param {string} id
 * @param {number} positionSec
 */
async function updatePositionSec(id, positionSec) {
  const rec = await getVideo(id);
  if (!rec) return;
  rec.positionSec = positionSec;
  await putVideo(rec);
}

/**
 * @param {HTMLVideoElement} video
 * @param {number} t
 */
function clampTime(video, t) {
  const d = video.duration;
  if (Number.isFinite(d) && d > 0) {
    return Math.max(0, Math.min(d, t));
  }
  return Math.max(0, t);
}

/**
 * @param {string} id
 * @param {HTMLVideoElement} video
 */
async function savePositionImmediate(id, video) {
  await updatePositionSec(id, clampTime(video, video.currentTime));
}

/**
 * @param {string} id
 * @param {HTMLVideoElement} video
 */
function savePositionThrottled(id, video) {
  const now = performance.now();
  const last = throttleMarks.get(id) ?? 0;
  if (now - last < TIMEUPDATE_INTERVAL_MS) return;
  throttleMarks.set(id, now);
  savePositionImmediate(id, video).catch(console.error);
}

function setEmptyVisible(visible) {
  const el = document.getElementById("empty-state");
  if (el) el.hidden = !visible;
}

function revokeAllObjectUrls() {
  for (const u of objectUrls.values()) {
    URL.revokeObjectURL(u);
  }
  objectUrls.clear();
  throttleMarks.clear();
}

/**
 * @param {VideoRecord} record
 * @param {{ collapsed?: boolean }} [options]
 */
function renderCard(record, options = {}) {
  const collapsed = options.collapsed === true;
  const list = document.getElementById("video-list");
  if (!list) return;

  const li = document.createElement("li");
  li.className = "video-card";
  if (collapsed) li.classList.add("video-card--collapsed");
  li.dataset.videoId = record.id;

  const url = URL.createObjectURL(record.blob);
  objectUrls.set(record.id, url);

  const video = document.createElement("video");
  video.src = url;
  video.controls = true;
  video.preload = "metadata";

  const removeBtn = document.createElement("button");
  removeBtn.type = "button";
  removeBtn.className = "video-card__remove";
  removeBtn.textContent = "Remove from library";
  removeBtn.addEventListener("click", async () => {
    await savePositionImmediate(record.id, video);
    await deleteVideo(record.id);
    await refreshList();
  });

  const applySavedPosition = () => {
    const t = clampTime(video, record.positionSec);
    if (t > 0) video.currentTime = t;
  };

  video.addEventListener("loadedmetadata", applySavedPosition, { once: true });

  video.addEventListener("timeupdate", () => {
    savePositionThrottled(record.id, video);
  });

  video.addEventListener("pause", () => {
    savePositionImmediate(record.id, video).catch(console.error);
  });

  video.addEventListener("ended", () => {
    savePositionImmediate(record.id, video).catch(console.error);
  });

  video.addEventListener("seeked", () => {
    savePositionImmediate(record.id, video).catch(console.error);
  });

  if (collapsed) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.className = "video-card__summary";
    summary.textContent = record.name;
    const body = document.createElement("div");
    body.className = "video-card__body";
    body.appendChild(video);
    body.appendChild(removeBtn);
    details.appendChild(summary);
    details.appendChild(body);
    li.appendChild(details);
  } else {
    const title = document.createElement("h2");
    title.className = "video-card__title";
    title.textContent = record.name;
    li.appendChild(title);
    li.appendChild(video);
    li.appendChild(removeBtn);
  }

  list.appendChild(li);
}

async function refreshList() {
  const list = document.getElementById("video-list");
  if (!list) return;
  list.replaceChildren();
  revokeAllObjectUrls();

  const records = await getAllVideos();
  setEmptyVisible(records.length === 0);
  records.forEach((rec, index) => {
    renderCard(rec, { collapsed: index > 0 });
  });
}

const VIDEO_EXT = /\.(mp4|webm|ogg|ogv|mov|mkv|m4v|avi)$/i;

function isVideoFile(f) {
  if (f.type.startsWith("video/")) return true;
  if (!f.type && VIDEO_EXT.test(f.name)) return true;
  return false;
}

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(isVideoFile);
  if (files.length === 0) return;

  const priorCount = document.querySelectorAll(".video-card").length;
  beginSave();
  try {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const id = crypto.randomUUID();
      /** @type {VideoRecord} */
      const record = {
        id,
        name: file.name,
        type: file.type || "video/mp4",
        blob: file,
        positionSec: 0,
      };
      await putVideo(record, { track: false });
      const collapsed = priorCount + i > 0;
      renderCard(record, { collapsed });
    }
  } finally {
    endSave();
  }
  setEmptyVisible(false);
}

function flushAllVideoPositions() {
  document.querySelectorAll(".video-card").forEach((card) => {
    const id = card.dataset.videoId;
    const video = card.querySelector("video");
    if (id && video instanceof HTMLVideoElement) {
      savePositionImmediate(id, video).catch(() => {});
    }
  });
}

// Save positions when the page is hidden or closed
function wireLifecycleSaves() {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushAllVideoPositions();
  });
  window.addEventListener("pagehide", () => {
    flushAllVideoPositions();
  });
}

async function init() {
  db = await openDatabase();

  const input = document.getElementById("file-input");
  if (input) {
    input.addEventListener("change", (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.files?.length) {
        handleFiles(t.files).catch(console.error);
        t.value = "";
      }
    });
  }

  wireLifecycleSaves();
  await refreshList();
}

init().catch(console.error);
