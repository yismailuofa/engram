const DB_NAME = "engram";
const DB_VERSION = 1;
const VIDEO_STORE = "videos";
const POSITION_SAVE_INTERVAL_SECONDS = 5;

const fileInput = document.getElementById("file-input");
const saveStatus = document.getElementById("save-status");
const emptyState = document.getElementById("empty-state");
const videoList = document.getElementById("video-list");

let dbPromise;
let statusTimer;
const objectUrls = new Set();

function setStatus(state, message) {
  saveStatus.dataset.state = state;
  saveStatus.textContent = message;
}

function pulseSaved(message = "Saved") {
  setStatus("saved", message);
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => setStatus("ready", "Ready"), 1100);
}

function videoIdFor(fileLike) {
  return [fileLike.name, fileLike.size, fileLike.lastModified].join("::");
}

function openDatabase() {
  if (dbPromise) {
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(VIDEO_STORE)) {
        db.createObjectStore(VIDEO_STORE, { keyPath: "id" });
      }
    };

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });

  return dbPromise;
}

function withStore(mode, callback) {
  return openDatabase().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(VIDEO_STORE, mode);
        const store = tx.objectStore(VIDEO_STORE);
        const request = callback(store);

        tx.oncomplete = () => resolve(request?.result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

function getAllVideos() {
  return withStore("readonly", (store) => store.getAll()).then((items) =>
    [...items].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)),
  );
}

function saveVideoRecord(record) {
  return withStore("readwrite", (store) => store.put(record));
}

function deleteVideoRecord(id) {
  return withStore("readwrite", (store) => store.delete(id));
}

function loadVideoRecord(id) {
  return withStore("readonly", (store) => store.get(id));
}

function cleanupObjectUrls() {
  for (const url of objectUrls) {
    URL.revokeObjectURL(url);
  }
  objectUrls.clear();
}

function createVideoCard(record) {
  const item = document.createElement("li");
  item.className = "video-card video-card--collapsed";

  const details = document.createElement("details");

  const summary = document.createElement("summary");
  summary.className = "video-card__summary";
  summary.textContent = record.name;

  const body = document.createElement("div");
  body.className = "video-card__body";

  const title = document.createElement("p");
  title.className = "video-card__title";
  title.textContent = record.name;

  const video = document.createElement("video");
  video.controls = true;
  video.preload = "metadata";

  const url = URL.createObjectURL(record.blob);
  objectUrls.add(url);
  video.src = url;

  let lastSavedPosition = Number(record.position || 0);

  video.addEventListener("loadedmetadata", () => {
    if (
      Number.isFinite(lastSavedPosition) &&
      lastSavedPosition > 0 &&
      lastSavedPosition < video.duration
    ) {
      video.currentTime = lastSavedPosition;
    }
  });

  const persistPosition = async ({ force = false } = {}) => {
    if (!Number.isFinite(video.currentTime)) {
      return;
    }

    const roundedPosition = Number(video.currentTime.toFixed(2));
    const delta = Math.abs(roundedPosition - lastSavedPosition);
    const minDelta = force ? 0.1 : POSITION_SAVE_INTERVAL_SECONDS;
    if (delta < minDelta) {
      return;
    }

    lastSavedPosition = roundedPosition;
    setStatus("saving", "Saving...");
    const latest = await loadVideoRecord(record.id);
    if (!latest) {
      return;
    }

    latest.position = roundedPosition;
    latest.updatedAt = Date.now();
    await saveVideoRecord(latest);
    pulseSaved("Position saved");
  };

  video.addEventListener("timeupdate", () => {
    persistPosition();
  });
  video.addEventListener("seeked", () => {
    persistPosition({ force: true });
  });
  video.addEventListener("pause", () => {
    persistPosition({ force: true });
  });
  video.addEventListener("ended", () => {
    persistPosition({ force: true });
  });

  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "video-card__remove";
  removeButton.textContent = "Remove";
  removeButton.addEventListener("click", async () => {
    setStatus("saving", "Removing...");
    await deleteVideoRecord(record.id);
    pulseSaved("Removed");
    await render();
  });

  body.append(title, video, removeButton);
  details.append(summary, body);
  item.append(details);
  return item;
}

async function render() {
  const records = await getAllVideos();
  cleanupObjectUrls();
  videoList.innerHTML = "";

  for (const record of records) {
    videoList.append(createVideoCard(record));
  }

  emptyState.hidden = records.length > 0;
}

async function handleFileUpload(event) {
  const files = [...(event.target.files || [])];
  if (!files.length) {
    return;
  }

  setStatus("saving", "Saving...");
  for (const file of files) {
    const id = videoIdFor(file);
    const existing = await loadVideoRecord(id);

    await saveVideoRecord({
      id,
      name: file.name,
      type: file.type || "video/mp4",
      size: file.size,
      lastModified: file.lastModified,
      blob: file,
      position: existing?.position || 0,
      updatedAt: Date.now(),
    });
  }

  fileInput.value = "";
  pulseSaved(`${files.length} video${files.length === 1 ? "" : "s"} saved`);
  await render();
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register("service-worker.js");
  } catch (error) {
    console.error("Service worker registration failed", error);
  }
}

async function start() {
  try {
    await openDatabase();
    fileInput.addEventListener("change", handleFileUpload);
    await render();
    await registerServiceWorker();
  } catch (error) {
    console.error(error);
    setStatus("ready", "Could not initialize storage");
  }
}

window.addEventListener("beforeunload", cleanupObjectUrls);
start();
