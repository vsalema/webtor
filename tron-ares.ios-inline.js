// =====================================================
// TRON ARES IPTV PLAYER - JS CLEAN + RESUME + TRACKS
// =====================================================

// --------- RESUME POSITIONS (CHANNELS SEULEMENT) ---------
let resumePositions = {};
try {
  const saved = localStorage.getItem('tronAresResume');
  if (saved) resumePositions = JSON.parse(saved);
} catch {
  resumePositions = {};
}
if (!resumePositions || typeof resumePositions !== 'object') resumePositions = {};

// --------- PERF: PERSISTENCE THROTTLING (localStorage is sync) ---------
let __resumeDirty = false;
let __resumeSaveTimer = null;
let __lastResumeSaveAt = 0;
const RESUME_SAVE_INTERVAL_MS = 4000;

function __persistResumeNow() {
  if (!__resumeDirty) return;
  __resumeDirty = false;
  try { localStorage.setItem('tronAresResume', JSON.stringify(resumePositions)); } catch {}
  __lastResumeSaveAt = Date.now();
}

function __scheduleResumeSave(force = false) {
  __resumeDirty = true;
  if (force) {
    if (__resumeSaveTimer) { clearTimeout(__resumeSaveTimer); __resumeSaveTimer = null; }
    __persistResumeNow();
    return;
  }
  if (__resumeSaveTimer) return;
  const elapsed = Date.now() - __lastResumeSaveAt;
  const wait = Math.max(RESUME_SAVE_INTERVAL_MS - elapsed, 500);
  __resumeSaveTimer = setTimeout(() => {
    __resumeSaveTimer = null;
    __persistResumeNow();
  }, wait);
}

// UID persistence (avoid thousands of sync writes during M3U parsing)
let __uidDirty = false;
let __uidSaveTimer = null;
function __persistUidSoon() {
  __uidDirty = true;
  if (__uidSaveTimer) return;
  __uidSaveTimer = setTimeout(() => {
    __uidSaveTimer = null;
    if (!__uidDirty) return;
    __uidDirty = false;
    try { localStorage.setItem('tronAresUid', String(uid)); } catch {}
  }, 800);
}

// Flush persistence on lifecycle events
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    __persistResumeNow();
    // uid flush (best-effort)
    if (__uidDirty) { __uidDirty = false; try { localStorage.setItem('tronAresUid', String(uid)); } catch {} }
  }
});
window.addEventListener('beforeunload', () => {
  __persistResumeNow();
  if (__uidDirty) { __uidDirty = false; try { localStorage.setItem('tronAresUid', String(uid)); } catch {} }
});


// --- RECHERCHE GLOBALE ---
let currentSearch = '';
function matchesSearch(entry) {
  if (!currentSearch) return true;
  const q = currentSearch.toLowerCase();
  return (
    (entry?.name && entry.name.toLowerCase().includes(q)) ||
    (entry?.group && entry.group.toLowerCase().includes(q))
  );
}
// --------- LINK CHECKER (badges 🟢 OK / 🔴 KO) ---------
const linkCheckCache = new Map(); // key -> { status:'ok'|'ko'|'pending'|null, at:number, info:string }

function linkKeyForEntry(entry) {
  if (!entry) return '';
  if (entry.id !== undefined && entry.id !== null) return 'id:' + String(entry.id);
  if (entry.url) return 'url:' + String(entry.url);
  return '';
}

function applyLinkStatusToBadge(badgeEl, status, info) {
  if (!badgeEl) return;
  badgeEl.classList.remove('pending', 'ok', 'ko');
  badgeEl.title = '';
  badgeEl.textContent = '';

  if (status === 'pending') {
    badgeEl.classList.add('pending');
    badgeEl.textContent = '⏳';
    badgeEl.title = info || 'Vérification…';
    return;
  }

  if (status === 'ok') {
    badgeEl.classList.add('ok');
    badgeEl.textContent = '🟢 OK';
    badgeEl.title = info || 'OK';
    return;
  }

  if (status === 'ko') {
    badgeEl.classList.add('ko');
    badgeEl.textContent = '🔴 KO';
    badgeEl.title = info || 'KO';
    return;
  }
}

function updateBadgesForKey(key) {
  if (!key) return;
  const st = linkCheckCache.get(key);
  document.querySelectorAll('.channel-item[data-linkkey]').forEach((item) => {
    if (item.dataset.linkkey === key) {
      const badge = item.querySelector('.link-status');
      if (badge) applyLinkStatusToBadge(badge, st?.status || null, st?.info || '');
    }
  });
}

function setLinkStatus(key, status, info = '') {
  if (!key) return;
  linkCheckCache.set(key, { status, at: Date.now(), info: info || '' });
  updateBadgesForKey(key);
}

function hydrateBadgeFromCache(itemEl, entry) {
  const badge = itemEl?.querySelector?.('.link-status');
  if (!badge) return;
  const key = itemEl.dataset.linkkey || linkKeyForEntry(entry);
  const st = linkCheckCache.get(key);
  if (st) applyLinkStatusToBadge(badge, st.status, st.info);
}

async function checkUrlByFetch(url, timeoutMs = 6500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Range: 'bytes=0-2047' },
      cache: 'no-store',
      signal: ctrl.signal
    });
    clearTimeout(t);

    const ok = (res.status >= 200 && res.status < 300) || res.status === 206;
    return { ok, info: 'HTTP ' + String(res.status || 'ERR') };
  } catch (err) {
    clearTimeout(t);
    const msg = (err && err.name === 'AbortError') ? 'timeout' : (err?.message || 'fetch error');
    return { ok: false, info: msg };
  }
}

function checkUrlByIframeLoad(url, timeoutMs = 6500) {
  return new Promise((resolve) => {
    let done = false;
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      iframe.remove();
      resolve({ ok: false, info: 'timeout' });
    }, timeoutMs);

    const finish = (ok, info) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      iframe.remove();
      resolve({ ok, info });
    };

    iframe.onload = () => finish(true, 'loaded');
    iframe.onerror = () => finish(false, 'error');

    // ⚠️ on affecte le src APRES les handlers
    iframe.src = url;

    document.body.appendChild(iframe);
  });
}

function isHttpUrl(u) {
  return typeof u === 'string' && /^https?:\/\//i.test(u.trim());
}

async function checkEntryLink(entry) {
  const url = entry?.url || '';
  if (!isHttpUrl(url)) return { ok: false, info: 'URL invalide' };

  // iFrame/Youtube → test "chargeable" via iframe
  if (entry?.isIframe || isYoutubeUrl(url)) {
    return await checkUrlByIframeLoad(url);
  }

  // Stream → test réseau via fetch (403/404/timeout, etc.)
  return await checkUrlByFetch(url);
}

async function runWithConcurrency(tasks, limit, onProgress) {
  const results = [];
  let idx = 0;
  let running = 0;

  return new Promise((resolve) => {
    const next = () => {
      while (running < limit && idx < tasks.length) {
        const cur = idx++;
        running++;
        Promise.resolve()
          .then(() => tasks[cur]())
          .then((res) => { results[cur] = res; })
          .catch((err) => { results[cur] = err; })
          .finally(() => {
            running--;
            if (onProgress) onProgress(cur, results[cur]);
            if (idx >= tasks.length && running === 0) resolve(results);
            else next();
          });
      }
    };
    next();
  });
}


// --------- DATA MODEL ---------
const frChannels = [];    // Liste M3U FR
const channels = [];      // Liste M3U principale
const iframeItems = [];   // Overlays / iFrames

// ✅ UID GLOBAL UNIQUE (PERSISTANT) + HELPERS ID/LOGO
// =====================================================
let uid = Number(localStorage.getItem('tronAresUid') || '0');
function nextUid() {
  uid += 1;
  __persistUidSoon();
  return uid;
}

function normalizeLogo(logo, fallbackName) {
  if (logo && typeof logo === 'object') {
    if (logo.type === 'image' && typeof logo.value === 'string' && logo.value.trim()) return logo;
    if (logo.type === 'letter' && typeof logo.value === 'string' && logo.value.trim()) return logo;
  }
  return deriveLogoFromName(fallbackName);
}

let currentIndex = -1;
let currentFrIndex = -1;
let currentIframeIndex = -1;

let favoritesView = [];

// =====================================================
// 🆕 Derniers ajouts (JSON ids + filtre sur tvg-id)
// =====================================================
const NEW_ADDITIONS_JSON = 'nouveaux_items.json';
const MAX_NEW_ADDITIONS = 20;
let newAdditionsIds = [];
let newAdditionsMode = false;

function getActiveTabKey(){
  return document.querySelector('.tab-btn.active')?.dataset?.tab || '';
}

async function fetchNewAdditionsIds(){
  try{
    const res = await fetch(NEW_ADDITIONS_JSON + '?_=' + Date.now());
    if(!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const ids = Array.isArray(data?.ids) ? data.ids : [];
    const clean = ids.filter(x => typeof x === 'string' && x.trim()).map(x => x.trim());
    if(clean.length > MAX_NEW_ADDITIONS){
      console.warn(`[Derniers ajouts] Limite ${MAX_NEW_ADDITIONS} atteinte: ${clean.length} IDs dans le JSON. Les plus anciens sont ignorés.`);
    }
    newAdditionsIds = clean.slice(0, MAX_NEW_ADDITIONS);
  }catch(err){
    console.warn('[Derniers ajouts] JSON introuvable ou invalide:', err);
    newAdditionsIds = [];
  }
}

function computeNewAdditionsIndexes(){
  if(!newAdditionsIds.length) return [];
  // Préserve l'ordre du JSON (mets tes IDs du plus récent au plus ancien)
  const idToIndex = new Map();
  for(let i=0;i<channels.length;i++){
    const tvgId = (channels[i]?.tvgId || '').trim();
    if(tvgId) idToIndex.set(tvgId, i);
  }

  const out = [];
  const seen = new Set();
  for(const id of newAdditionsIds){
    if(seen.has(id)) continue;
    const idx = idToIndex.get(id);
    if(typeof idx === 'number') out.push(idx);
    seen.add(id);
  }
  return out;
}

function updateNewAdditionsButtonVisibility(){
  if(!newAdditionsContainer || !newAdditionsBtn) return;

  const isFilmTab = (getActiveTabKey() === 'channels');
  if(!isFilmTab){
    newAdditionsContainer.classList.add('hidden');
    if(newAdditionsMode){
      newAdditionsMode = false;
      renderChannelList();
    }
    return;
  }

  newAdditionsContainer.classList.remove('hidden');

  const count = computeNewAdditionsIndexes().length;
  newAdditionsBtn.textContent = count ? `🆕 Derniers ajouts (${count})` : '🆕 Derniers ajouts';
  // Le bouton reste cliquable même si la liste est vide
  newAdditionsBtn.disabled = false;
  newAdditionsBtn.style.opacity = (count === 0) ? '0.85' : '1';
}

function toggleNewAdditionsMode(){
  if(getActiveTabKey() !== 'channels') return;
  const count = computeNewAdditionsIndexes().length;
  if(!count){
    // rien à afficher
    newAdditionsMode = true;
  }else{
    newAdditionsMode = !newAdditionsMode;
  }
  renderChannelList();
  scrollToActiveItem();
}

   // [{ id, sourceType, sourceIndex, entry }]
let currentFavPos = -1;   // position dans favoritesView

// FR par défaut
let currentListType = 'fr'; // 'channels' | 'fr' | 'iframe' | 'favorites'

let overlayMode = false;
let activePlaybackMode = 'stream'; // 'stream' | 'iframe'

let hlsInstance = null;
let dashInstance = null;

let currentEntry = null;
let externalFallbackTried = false;

let offlineMode = false;
let offlineRetryIntervalId = null;
let stallWatchdogIntervalId = null;
let lastProgressTs = 0;

// MP4 de secours quand un flux ne diffuse pas
const OFFLINE_MP4_URL = 'https://raw.githubusercontent.com/vsalema/tvpt4/refs/heads/main/css/kling_looped.mp4';

function stopOfflineAutoRetry() {
  if (offlineRetryIntervalId) {
    clearInterval(offlineRetryIntervalId);
    offlineRetryIntervalId = null;
  }
}

function startOfflineAutoRetry() {
  stopOfflineAutoRetry();
  // On retente régulièrement le flux original
  offlineRetryIntervalId = setInterval(() => {
    if (!offlineMode) return;
    if (!currentEntry || !currentEntry.url) return;
    // Retente la lecture du flux original
    playUrl(currentEntry);
  }, 15000);
}

function startStallWatchdog() {
  if (stallWatchdogIntervalId) return;
  lastProgressTs = Date.now();
  stallWatchdogIntervalId = setInterval(() => {
    if (!videoEl) return;
    if (offlineMode) return;
    if (activePlaybackMode !== 'stream') return;
    if (!currentEntry || !currentEntry.url) return;
    if (currentEntry.isIframe) return;
    if (videoEl.paused || videoEl.ended) return;

    // Si la lecture n'avance pas depuis un moment (buffering / flux mort)
    const now = Date.now();
    const stuckMs = now - (lastProgressTs || now);
    if (stuckMs > 18000) {
      enterOfflineMode('Flux interrompu / plus de données');
    }
  }, 2000);
}

function markProgress() {
  lastProgressTs = Date.now();
}

function enterOfflineMode(reason) {
  if (!videoEl) return;
  if (offlineMode) return;
  if (!currentEntry || !currentEntry.url) return;

  offlineMode = true;
  externalFallbackTried = true; // évite les fallbacks multiples ailleurs

  // Stop players
  destroyHls();
  destroyDash();

  showVideo();

  try { videoEl.pause(); } catch {}
  try { videoEl.removeAttribute('src'); videoEl.load(); } catch {}

  // Lecture du MP4 offline
  videoEl.src = OFFLINE_MP4_URL;
  videoEl.loop = true;

  // évite un bruit surprise si le MP4 a une piste audio
  videoEl.muted = true;

  videoEl.play().catch(() => {});
  setStatus('OFFLINE' + (reason ? ' — ' + reason : ''));

  if (npBadge) npBadge.textContent = 'OFFLINE';

  startOfflineAutoRetry();
}

function leaveOfflineMode() {
  if (!offlineMode) return;
  offlineMode = false;
  stopOfflineAutoRetry();
  // On remet le loop à l'état normal (flux / film)
  try { if (videoEl) videoEl.loop = false; } catch {}
  // Par défaut on rend le son au lecteur (l’utilisateur peut remuter via contrôles)
  try { if (videoEl) videoEl.muted = false; } catch {}
}

let activeAudioIndex = -1;
let activeSubtitleIndex = -1;

// --------- DOM REFS ---------
const videoEl = document.getElementById('videoEl');
/**
 * iOS only: keep video inline (prevents forced fullscreen on iPhone/iPad),
 * while avoiding CLS regressions on desktop by NOT applying playsinline there.
 */
(() => {
  if (!videoEl) return;
  const ua = navigator.userAgent || '';
  const isIOS = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
  if (isIOS) {
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('webkit-playsinline', '');
  } else {
    videoEl.removeAttribute('playsinline');
    videoEl.removeAttribute('webkit-playsinline');
  }
})();

const iframeOverlay = document.getElementById('iframeOverlay');
const iframeEl = document.getElementById('iframeEl');

/**
 * Keep embedded trailers (YouTube, iFrame content) inside THIS page on mobile:
 * - allow autoplay/PiP
 * - use a stricter referrer policy (helps some embed contexts)
 */
(() => {
  if (!iframeEl) return;
  try { iframeEl.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture; fullscreen'); } catch {}
  try { iframeEl.setAttribute('referrerpolicy', 'origin'); } catch {}
})();

const channelFrListEl = document.getElementById('channelFrList');
const channelListEl = document.getElementById('channelList');
const iframeListEl = document.getElementById('iframeList');
const favoriteListEl = document.getElementById('favoriteList');

const newAdditionsContainer = document.getElementById('newAdditionsContainer');
const newAdditionsBtn = document.getElementById('newAdditionsBtn');

// =====================================================
// 🆕 Derniers ajouts - INIT (après DOM refs)
// =====================================================
(async () => {
  // Charge la liste d'IDs "nouveaux" depuis le JSON (shared pour tous les PC)
  await fetchNewAdditionsIds();
  updateNewAdditionsButtonVisibility();

  // Clic sur 🆕 : refresh JSON + bascule mode "Derniers ajouts"
  if (newAdditionsBtn) {
    newAdditionsBtn.addEventListener('click', async () => {
      await fetchNewAdditionsIds();           // refresh à chaque clic (pratique après un commit)
      updateNewAdditionsButtonVisibility();
      toggleNewAdditionsMode();
    });
  }

  // Quand tu changes d'onglet, on masque/affiche le bouton (après le switch de l'app)
  document.addEventListener('click', (e) => {
    if (e.target && e.target.closest && e.target.closest('.tab-btn')) {
      setTimeout(() => updateNewAdditionsButtonVisibility(), 0);
    }
  }, true);
})();

const statusPill = document.getElementById('statusPill');
const npLogo = document.getElementById('npLogo');
const npTitle = document.getElementById('npTitle');
const npSub = document.getElementById('npSub');
const npBadge = document.getElementById('npBadge');
const npCounter = document.getElementById('npCounter');

// Counter: retire la classe d'animation une fois terminée (permet de rejouer l'effet à chaque update)
if (npCounter) {
  npCounter.addEventListener('animationend', (e) => {
    if (e && e.animationName === 'npTick') npCounter.classList.remove('tick');
  });
}


const sidebar = document.getElementById('sidebar');
const toggleSidebarBtn = document.getElementById('toggleSidebarBtn');

const urlInput = document.getElementById('urlInput');
const loadUrlBtn = document.getElementById('loadUrlBtn');
const fileInput = document.getElementById('fileInput');
const openFileBtn = document.getElementById('openFileBtn');
const fileNameLabel = document.getElementById('fileNameLabel');

const iframeTitleInput = document.getElementById('iframeTitleInput');
const iframeUrlInput = document.getElementById('iframeUrlInput');
const addIframeBtn = document.getElementById('addIframeBtn');

const exportM3uJsonBtn = document.getElementById('exportM3uJsonBtn');
const exportIframeJsonBtn = document.getElementById('exportIframeJsonBtn');
const importJsonBtn = document.getElementById('importJsonBtn');
const jsonArea = document.getElementById('jsonArea');

const toggleOverlayBtn = document.getElementById('toggleOverlayBtn');
const fullPageBtn = document.getElementById('fullPageBtn');
const playerContainer = document.getElementById('playerContainer');
const appShell = document.getElementById('appShell');

const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');

const fxToggleBtn = document.getElementById('fxToggleBtn');
const pipToggleBtn = document.getElementById('pipToggleBtn');
const themeToggleBtn = document.getElementById('themeToggleBtn');

// --- Stream URL (Akamai-style) ---
const openStreamUrlBtn = document.getElementById('openStreamUrlBtn');
const streamUrlOverlay = document.getElementById('streamUrlOverlay');
const streamUrlInput = document.getElementById('streamUrlInput');
const streamTitleInput = document.getElementById('streamTitleInput');
const streamUrlPlayBtn = document.getElementById('streamUrlPlayBtn');
const streamUrlCopyBtn = document.getElementById('streamUrlCopyBtn');
const streamUrlCloseBtn = document.getElementById('streamUrlCloseBtn');

// --- Contrôles pistes (now-playing) ---
const npTracks = document.getElementById('npTracks');
const audioGroup = document.getElementById('audioGroup');
const subtitleGroup = document.getElementById('subtitleGroup');
const audioTrackBtn = document.getElementById('audioTrackBtn');
const subtitleTrackBtn = document.getElementById('subtitleTrackBtn');
const audioTrackMenu = document.getElementById('audioTrackMenu');
const subtitleTrackMenu = document.getElementById('subtitleTrackMenu');

// --- Chromecast ---
const castLauncher = document.getElementById('castLauncher');


// --- Recherche ---
const globalSearchInput = document.getElementById('globalSearchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');
const verifyLinksBtn = document.getElementById('verifyLinksBtn');

// --- MINI RADIO R.ALFA + LUNA (postMessage) ---
const miniRadioEl = document.getElementById('miniRadioPlayer');
const radioPlayBtn = document.getElementById('radioPlayBtn');

// (Optionnel) Audio direct : gardé pour compat / fallback, mais la lecture principale passe par Luna
const radioAudio = new Audio(
  'https://n32a-eu.rcs.revma.com/amrbkhqtkm0uv?rj-ttl=5&rj-tok=AAABmqMYXjQAwgI6eJQzoCwBDw'
);
radioAudio.preload = 'none';

// radioPlaying = mode radio actif (overlay Luna ouvert)
let radioPlaying = false;
// état réel remonté par Luna
let lunaIsPlaying = false;

// postMessage bridge
let lunaReady = false;
const lunaCmdQueue = [];

let prevVideoMuted = false;
let prevVideoVolume = 1;

// =====================================================
// RADIO OVERLAY LAYER (3e couche dans playerContainer)
// =====================================================
let radioOverlayLayer = null;

// =====================================================
// LUNA ↔ TRON : postMessage bridge (commande depuis #radioPlayBtn)
// =====================================================
function lunaGetIframeEl() {
  const layer = ensureRadioOverlayLayer();
  return layer ? layer.querySelector('#lunaIframe') : null;
}

function lunaGetTargetOrigin() {
  const iframe = lunaGetIframeEl();
  if (!iframe) return '*';
  try {
    const u = new URL(iframe.src, window.location.href);
    return u.origin;
  } catch {
    return '*';
  }
}

function lunaPost(cmd, payload = {}) {
  const iframe = lunaGetIframeEl();
  if (!iframe || !iframe.contentWindow) return;

  const msg = {
    __luna: 1,
    from: 'tron-ares',
    type: 'LUNA_CMD',
    cmd,
    payload
  };

  // si Luna n'a pas encore envoyé READY, on met en file
  if (!lunaReady && cmd !== 'HELLO') {
    lunaCmdQueue.push(msg);
    return;
  }

  try {
    iframe.contentWindow.postMessage(msg, lunaGetTargetOrigin());
  } catch {
    try { iframe.contentWindow.postMessage(msg, '*'); } catch {}
  }
}

function lunaFlushQueue() {
  if (!lunaCmdQueue.length) return;
  const iframe = lunaGetIframeEl();
  if (!iframe || !iframe.contentWindow) return;

  const origin = lunaGetTargetOrigin();
  while (lunaCmdQueue.length) {
    const msg = lunaCmdQueue.shift();
    try { iframe.contentWindow.postMessage(msg, origin); }
    catch { try { iframe.contentWindow.postMessage(msg, '*'); } catch {} }
  }
}

function lunaBindWindowMessageListenerOnce() {
  if (window.__tronLunaPmBound) return;
  window.__tronLunaPmBound = true;

  window.addEventListener('message', (ev) => {
    const iframe = lunaGetIframeEl();
    if (!iframe || ev.source !== iframe.contentWindow) return;

    const data = ev.data;
    if (!data || data.__luna !== 1 || data.from !== 'luna') return;

    if (data.type === 'LUNA_READY') {
      lunaReady = true;
      lunaFlushQueue();
      // demande un état immédiat
      lunaPost('GET_STATE');
      return;
    }

    if (data.type === 'LUNA_STATE') {
      lunaIsPlaying = !!data.playing;

      // UI mini-radio = état lecture réel
      miniRadioEl?.classList.toggle('playing', lunaIsPlaying);
      if (radioPlayBtn) radioPlayBtn.textContent = lunaIsPlaying ? '⏸' : '▶';

      // status optionnel
      if (data.station && data.station.name) setStatus(`Luna • ${data.station.name}`);
      return;
    }

    if (data.type === 'LUNA_AUTOPLAY_BLOCKED') {
      setStatus('Luna • autoplay bloqué (clique dans le lecteur)');
      if (radioPlayBtn) radioPlayBtn.textContent = '▶';
      miniRadioEl?.classList.remove('playing');
      lunaIsPlaying = false;
    }
  });
}

lunaBindWindowMessageListenerOnce();

function ensureRadioOverlayLayer() {
  if (radioOverlayLayer) return radioOverlayLayer;
  if (!playerContainer) return null;

  const host = playerContainer.querySelector('.player-inner') || playerContainer;

  // Garantit que l'absolu de l'overlay se positionne bien dans le player
  try {
    const cs = window.getComputedStyle(host);
    if (cs.position === 'static') host.style.position = 'relative';
  } catch {}

  const layer = document.createElement('div');
  layer.id = 'radioOverlayLayer';
  layer.style.position = 'absolute';
  layer.style.inset = '0';
  layer.style.display = 'none';
  layer.style.zIndex = '80';
  layer.style.pointerEvents = 'auto';
  layer.style.background = 'rgba(0,0,0,.88)';
  layer.style.backdropFilter = 'blur(6px)';

  layer.innerHTML = `
    <div style="height:100%; width:100%; display:flex; flex-direction:column;">
      <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;
                  padding:10px 12px; border-bottom:1px solid rgba(0,255,255,.18);
                  font-family: Orbitron, system-ui, sans-serif;">
        <div style="display:flex; align-items:center; gap:10px; min-width:0;">
          <div style="width:10px; height:10px; border-radius:50%; background:rgba(0,255,255,.8);
                      box-shadow:0 0 14px rgba(0,255,255,.45);"></div>
          <div style="font-size:13px; letter-spacing:.08em; color:rgba(230,255,255,.92);
                      white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">
            LUNA AUDIO PLAYER
          </div>
        </div>

        <div style="display:flex; align-items:center; gap:8px;">
          <button id="lunaPlayPauseBtn"
                  style="appearance:none; border:1px solid rgba(255,145,0,.35);
                         background:rgba(255,145,0,.12); color:rgba(255,255,255,.92);
                         border-radius:12px; padding:8px 10px; cursor:pointer;
                         font-family: Orbitron, system-ui, sans-serif;">
            ⏸
          </button>
          <button id="lunaCloseBtn"
                  style="appearance:none; border:1px solid rgba(0,255,255,.28);
                         background:rgba(0,0,0,.35); color:rgba(230,255,255,.92);
                         border-radius:12px; padding:8px 10px; cursor:pointer;
                         font-family: Orbitron, system-ui, sans-serif;">
            ✕
          </button>
        </div>
      </div>

      <div style="flex:1 1 auto; min-height:0;">
        <iframe id="lunaIframe"
                title="Luna Player"
                src="about:blank"
                allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
                style="width:100%; height:100%; border:0; display:block;"></iframe>
      </div>
    </div>
  `;

  host.appendChild(layer);
  radioOverlayLayer = layer;
  return layer;
}

function showRadioOverlayInPlayer() {
  const layer = ensureRadioOverlayLayer();
  if (!layer) return;

  layer.style.display = 'block';

  const iframe = layer.querySelector('#lunaIframe');
  if (iframe) {
    const url =
      (radioPlayBtn && radioPlayBtn.dataset && radioPlayBtn.dataset.lunaUrl) ? radioPlayBtn.dataset.lunaUrl :
      (playerContainer && playerContainer.dataset && playerContainer.dataset.lunaUrl) ? playerContainer.dataset.lunaUrl :
      ((typeof window !== 'undefined' && window.LUNA_URL_OVERRIDE) ? window.LUNA_URL_OVERRIDE : 'index.html');

    if (!iframe.src || iframe.src === 'about:blank' || iframe.dataset.loaded !== '1') {
      iframe.src = url;
      iframe.dataset.loaded = '1';
    }

    // postMessage: on réinitialise READY quand on (re)charge Luna, puis handshake
    if (!iframe.dataset.pmBound) {
      iframe.dataset.pmBound = '1';
      iframe.addEventListener('load', () => {
        lunaReady = false;
        lunaPost('HELLO'); // Luna répond READY + STATE
      });
    } else {
      lunaPost('HELLO');
    }
  }

  const closeBtn = layer.querySelector('#lunaCloseBtn');
  if (closeBtn) closeBtn.onclick = () => stopRadioAndRestore();

  const ppBtn = layer.querySelector('#lunaPlayPauseBtn');
  if (ppBtn) {
    ppBtn.textContent = lunaIsPlaying ? '⏸' : '▶';
    ppBtn.onclick = () => {
      if (lunaIsPlaying) {
        lunaPost('PAUSE');
      } else {
        // "RESUME" n'est pas garanti côté Luna → on relance la station 0 (RADIO ALFA)
        lunaPost('PLAY_STATION', { stationIndex: 0, stationKey: 'RADIO_ALFA', stationName: 'RADIO ALFA' });
      }
    };
  }

  setStatus('Luna');
}

function hideRadioOverlayInPlayer() {
  const layer = ensureRadioOverlayLayer();
  if (!layer) return;

  // Stop audio inside the iframe by unloading it
  try {
    const iframe = layer.querySelector('#lunaIframe');
    if (iframe) {
      iframe.src = 'about:blank';
      iframe.dataset.loaded = '0';
    }
  } catch {}

  layer.style.display = 'none';
}

// Masquer les contrôles pistes au démarrage
npTracks?.classList.add('hidden');

// =====================================================
// UTILS
// =====================================================
function setStatus(text) {
  if (statusPill) statusPill.textContent = text;
}

// =====================================================
// CHROMECAST (Google Cast) — cast du flux en cours
// ✅ Détecte la disponibilité Chromecast (à proximité)
// ✅ Lance/arrête un cast
// ⚠️ On ne peut pas « caster la page » depuis un site web :
//    Chromecast ne reçoit que des URLs média (HLS/DASH/MP4/MP3…)
//    Pour caster l’onglet/page entière → menu Chrome “Caster…”
// =====================================================
const CAST = {
  frameworkReady: false,
  castState: 'NO_DEVICES_AVAILABLE',
  sessionState: null,
  isConnected: false,
  lastLoadedUrl: null,
};

function _castHasFramework() {
  return typeof window.cast !== 'undefined' &&
         window.cast &&
         window.cast.framework &&
         typeof window.chrome !== 'undefined' &&
         window.chrome &&
         window.chrome.cast;
}

function updateCastButtonUI() {
  if (!castLauncher) return;

  castLauncher.classList.remove('cast-disabled','cast-available','cast-connecting','cast-connected');

  // Par défaut : désactivé
  let disabled = true;
  let label = 'Chromecast indisponible';

  if (_castHasFramework() && CAST.frameworkReady) {
    const cs = CAST.castState;

    if (cs === cast.framework.CastState.NO_DEVICES_AVAILABLE) {
      disabled = true;
      label = 'Aucun Chromecast détecté';
    } else if (cs === cast.framework.CastState.CONNECTING) {
      disabled = false;
      label = 'Connexion Chromecast…';
      castLauncher.classList.add('cast-connecting','cast-available');
    } else if (cs === cast.framework.CastState.CONNECTED) {
      disabled = false;
      label = 'Casting en cours — cliquer pour arrêter';
      castLauncher.classList.add('cast-connected');
    } else {
      // NOT_CONNECTED (devices dispo) ou état inconnu
      disabled = false;
      label = 'Caster sur Chromecast';
      castLauncher.classList.add('cast-available');
    }
  } else {
    disabled = true;
    label = 'Chromecast indisponible (Chrome/Edge requis)';
  }

  castLauncher.title = label;
  castLauncher.setAttribute('aria-label', label);

  if (disabled) {
    castLauncher.classList.add('cast-disabled');
    castLauncher.setAttribute('aria-disabled', 'true');
  } else {
    castLauncher.removeAttribute('aria-disabled');
  }
}

function guessCastContentType(url) {
  const u = String(url || '').toLowerCase();

  if (u.includes('.m3u8')) return 'application/x-mpegURL';
  if (u.includes('.mpd'))  return 'application/dash+xml';
  if (u.match(/\.(mp4|m4v)(\?|#|$)/)) return 'video/mp4';
  if (u.match(/\.(webm)(\?|#|$)/))    return 'video/webm';
  if (u.match(/\.(mp3)(\?|#|$)/))     return 'audio/mpeg';
  if (u.match(/\.(aac)(\?|#|$)/))     return 'audio/aac';
  if (u.match(/\.(m4a)(\?|#|$)/))     return 'audio/mp4';
  if (u.match(/\.(ogg|oga)(\?|#|$)/)) return 'audio/ogg';
  if (u.match(/\.(ts)(\?|#|$)/))      return 'video/mp2t';

  // fallback : beaucoup de flux IPTV ne donnent pas l’extension.
  // on laisse une valeur "générique" vidéo, le receiver tentera de lire.
  return 'video/mp4';
}

function guessCastStreamType(url) {
  const u = String(url || '').toLowerCase();
  if (u.includes('.m3u8') || u.includes('.mpd') || u.includes('live') || u.includes('manifest')) {
    return chrome.cast.media.StreamType.LIVE;
  }
  return chrome.cast.media.StreamType.BUFFERED;
}

function buildCastLoadRequest() {
  if (!currentEntry || !currentEntry.url) {
    return { ok:false, reason:'Aucun flux en cours.' };
  }

  // iFrame / YouTube : pas casterable via Default Media Receiver
  if (currentEntry.isIframe || isYoutubeUrl(currentEntry.url) || activePlaybackMode === 'iframe') {
    return { ok:false, reason:'Ce contenu (iFrame/YouTube) ne peut pas être casté directement.' };
  }

  const url = String(currentEntry.url);

  // Fichiers locaux / blob
  if (/^(blob:|file:|data:)/i.test(url)) {
    return { ok:false, reason:'Un fichier local / blob ne peut pas être casté (Chromecast doit accéder à une URL HTTP(S)).' };
  }

  const contentType = guessCastContentType(url);
  const mediaInfo = new chrome.cast.media.MediaInfo(url, contentType);

  mediaInfo.streamType = guessCastStreamType(url);

  // Métadonnées (titre/logo)
  try {
    const meta = new chrome.cast.media.GenericMediaMetadata();
    meta.title = normalizeName(currentEntry.name || 'Lecture');
    const logo = currentEntry.logo || deriveLogoFromName(currentEntry.name);
    if (logo && logo.type === 'image' && typeof logo.value === 'string' && /^https?:\/\//i.test(logo.value)) {
      meta.images = [ new chrome.cast.Image(logo.value) ];
    }
    mediaInfo.metadata = meta;
  } catch {}

  const req = new chrome.cast.media.LoadRequest(mediaInfo);
  req.autoplay = true;

  // reprise (uniquement si contenu buffered)
  try {
    if (videoEl && Number.isFinite(videoEl.currentTime) && mediaInfo.streamType === chrome.cast.media.StreamType.BUFFERED) {
      req.currentTime = Math.max(0, Number(videoEl.currentTime) || 0);
    }
  } catch {}

  return { ok:true, request:req, url };
}

async function castLoadCurrentEntry(silent = false) {
  if (!_castHasFramework() || !CAST.frameworkReady) {
    if (!silent) setStatus('Chromecast indisponible');
    return false;
  }

  const ctx = cast.framework.CastContext.getInstance();
  const session = ctx.getCurrentSession();

  if (!session) {
    if (!silent) setStatus('Chromecast : aucune session');
    return false;
  }

  const built = buildCastLoadRequest();
  if (!built.ok) {
    if (!silent) setStatus('Chromecast : ' + built.reason);
    return false;
  }

  // Évite de recharger la même URL en boucle
  if (CAST.lastLoadedUrl === built.url && silent) return true;

  try {
    await session.loadMedia(built.request);
    CAST.lastLoadedUrl = built.url;

    // côté local : on coupe pour éviter double son
    try { videoEl?.pause(); } catch {}

    if (!silent) setStatus('Chromecast : diffusion lancée');
    return true;
  } catch (e) {
    console.warn('Chromecast loadMedia error', e);
    if (!silent) setStatus('Chromecast : impossible de diffuser ce flux');
    return false;
  }
}

// Bind UI
if (castLauncher) {
  updateCastButtonUI(); // état initial
}

// Callback appelé par le SDK Cast
window.__onGCastApiAvailable = function(isAvailable) {
  if (!isAvailable) {
    CAST.frameworkReady = false;
    updateCastButtonUI();
    return;
  }

  try {
    const ctx = cast.framework.CastContext.getInstance();
    const DEFAULT_RECEIVER_APP_ID =
      (cast.framework && cast.framework.CastContext && cast.framework.CastContext.DEFAULT_MEDIA_RECEIVER_APP_ID)
      ? cast.framework.CastContext.DEFAULT_MEDIA_RECEIVER_APP_ID
      : 'CC1AD845'; // Default Media Receiver (fallback)

    ctx.setOptions({
      receiverApplicationId: DEFAULT_RECEIVER_APP_ID,
      autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED,
    });

    // Debug (décommente si besoin)
    // cast.framework.Logger.setLevel(cast.framework.LoggerLevel.DEBUG);
CAST.frameworkReady = true;
    CAST.castState = ctx.getCastState();

    ctx.addEventListener(
      cast.framework.CastContextEventType.CAST_STATE_CHANGED,
      (e) => {
        CAST.castState = e.castState;
        updateCastButtonUI();
      }
    );

    ctx.addEventListener(
      cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
      (e) => {
        CAST.sessionState = e.sessionState;
        CAST.isConnected = (
          e.sessionState === cast.framework.SessionState.SESSION_STARTED ||
          e.sessionState === cast.framework.SessionState.SESSION_RESUMED
        );

        updateCastButtonUI();

        // Si session connectée, on tente de diffuser le flux courant
        if (CAST.isConnected) {
          castLoadCurrentEntry(true);
        }
      }
    );

    updateCastButtonUI();
  } catch (e) {
    console.warn('Chromecast init error', e);
    CAST.frameworkReady = false;
    updateCastButtonUI();
  }
};

// CAST: init immédiat si déjà dispo (si le SDK s’est chargé avant la callback)
try{
  if (_castHasFramework() && typeof window.__onGCastApiAvailable === 'function' && window.cast && window.cast.framework) {
    // Some builds set chrome.cast.isAvailable, others rely on cast.framework presence
    window.__onGCastApiAvailable(true);
  }
}catch{}


// =====================================================
// STREAM URL (Akamai-style)
// =====================================================
function getQueryParams() {
  try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); }
}

function normalizeStreamUrl(u) {
  if (!u) return '';
  let url = String(u).trim();
  if (!url) return '';
  if (url.startsWith('//')) url = window.location.protocol + url;
  return url;
}

function buildStreamShareLink(streamUrl, title) {
  const url = new URL(window.location.href);
  url.searchParams.set('streamUrl', streamUrl);
  if (title) url.searchParams.set('title', title);
  else url.searchParams.delete('title');
  url.searchParams.set('autoplay', '1');
  return url.toString();
}

function openStreamUrlPanel(prefillFromQuery = true) {
  if (!streamUrlOverlay) return;
  streamUrlOverlay.classList.remove('hidden');
  streamUrlOverlay.setAttribute('aria-hidden', 'false');

  if (prefillFromQuery) {
    const qs = getQueryParams();
    const qUrl = normalizeStreamUrl(qs.get('streamUrl'));
    const qTitle = (qs.get('title') || '').trim();
    if (streamUrlInput) streamUrlInput.value = qUrl || (streamUrlInput.value || '');
    if (streamTitleInput) streamTitleInput.value = qTitle || (streamTitleInput.value || '');
  }

  setTimeout(() => {
    try { streamUrlInput?.focus(); streamUrlInput?.select(); } catch {}
  }, 0);
}

function closeStreamUrlPanel() {
  if (!streamUrlOverlay) return;
  streamUrlOverlay.classList.add('hidden');
  streamUrlOverlay.setAttribute('aria-hidden', 'true');
}

function playDirectStream(url, title, { updateUrl = true } = {}) {
  const cleanUrl = normalizeStreamUrl(url);
  if (!cleanUrl) {
    setStatus('Stream URL vide');
    return;
  }

  const entry = {
    id: `direct-${Date.now()}`,
    name: (title && String(title).trim()) ? String(title).trim() : 'Stream URL',
    url: cleanUrl,
    group: 'Direct',
    isFavorite: false,
    listType: 'direct'
  };

  activePlaybackMode = 'stream';
  try { iframeOverlay?.classList.add('hidden'); } catch {}
  try { iframeEl && (iframeEl.src = 'about:blank'); } catch {}

  playUrl(entry);

  if (updateUrl) {
    try {
      const next = new URL(window.location.href);
      next.searchParams.set('streamUrl', cleanUrl);
      if (entry.name && entry.name !== 'Stream URL') next.searchParams.set('title', entry.name);
      else next.searchParams.delete('title');
      next.searchParams.set('autoplay', '1');
      window.history.replaceState({}, '', next.toString());
    } catch {}
  }
}


function normalizeName(name) {
  return name || 'Flux sans titre';
}

function deriveLogoFromName(name) {
  const initial = (name || '?').trim()[0] || '?';
  return { type: 'letter', value: initial.toUpperCase() };
}

function isProbablyHls(url) {
  if (!url) return false;
  // ✅ HLS "classique" (.m3u8) + heuristiques pour les URLs sans extension
  // (ex: URLs sécurisées / tokenisées qui pointent vers un manifest HLS)
  return (
    /\.m3u8(\?|$)/i.test(url) ||
    /(^|\/)(hls)(\/|-|_)/i.test(url) ||
    /hls-vod/i.test(url) ||
    /\/manifest(\?|$)/i.test(url) ||
    /\/master(\?|$)/i.test(url)
  );
}
function isProbablyDash(url) {
  return /\.mpd(\?|$)/i.test(url);
}
function isProbablyPlaylist(url) {
  return /\.m3u8?(\?|$)/i.test(url);
}
function isYoutubeUrl(url) {
  return /youtu\.be|youtube\.com|youtube\-nocookie\.com/i.test(url);
}
function youtubeToEmbed(url) {
  try {
    const u = new URL(url, window.location.href);
    let id = null;
    if (u.hostname.includes('youtu.be')) id = u.pathname.replace('/', '');
    else id = u.searchParams.get('v');
    return id ? `https://www.youtube.com/embed/${id}` : url;
  } catch {
    return url;
  }
}

// ✅ IMPORTANT : MovieContext basé sur l’entrée réellement en lecture (pas sur l’onglet)
function isMovieContext() {
  return currentEntry?.listType === 'channels';
}

// =====================================================
// RADIO ↔ TV : SWITCH INTELLIGENT (retour stream exact)
// =====================================================
let lastPlaybackSnapshot = null;

function snapshotCurrentPlayback() {
  const snap = {
    wasOverlayMode: !!overlayMode,
    entry: currentEntry || null,
    videoSrc: videoEl?.currentSrc || videoEl?.src || '',
    videoTime: 0,
    iframeSrc: iframeEl?.src || ''
  };
  try {
    if (videoEl) snap.videoTime = Number.isFinite(videoEl.currentTime) ? videoEl.currentTime : 0;
  } catch {}
  return snap;
}

function stopPlaybackForRadio(snap) {
  try { videoEl?.pause(); } catch {}
  try {
    if (videoEl) {
      prevVideoMuted = !!videoEl.muted;
      prevVideoVolume = typeof videoEl.volume === 'number' ? videoEl.volume : 1;
      videoEl.muted = true;
      videoEl.volume = 0;
    }
  } catch {}

  try {
    if (snap?.wasOverlayMode && iframeEl && iframeEl.src && iframeEl.src !== 'about:blank') {
      iframeEl.src = 'about:blank';
    }
  } catch {}

  showRadioOverlayInPlayer();
}

function restorePlaybackAfterRadio() {
  hideRadioOverlayInPlayer();

  try {
    if (videoEl) {
      videoEl.muted = prevVideoMuted;
      videoEl.volume = prevVideoVolume;
    }
  } catch {}

  const snap = lastPlaybackSnapshot;
  lastPlaybackSnapshot = null;
  if (!snap) return;

  if (snap.wasOverlayMode && snap.iframeSrc && snap.iframeSrc !== 'about:blank') {
    showIframe();
    try { iframeEl.src = snap.iframeSrc; } catch {}
    setStatus('Retour overlay');
    return;
  }

  if (snap.entry) {
    const wantedTime = snap.videoTime || 0;

    const once = () => {
      try {
        if (wantedTime > 0 && Number.isFinite(videoEl.duration) && wantedTime < videoEl.duration - 2) {
          videoEl.currentTime = wantedTime;
        }
      } catch {}
      videoEl?.removeEventListener('loadedmetadata', once);
    };
    videoEl?.addEventListener('loadedmetadata', once);

    playUrl(snap.entry);
    setStatus('Retour diffusion');
    return;
  }

  if (snap.videoSrc) {
    showVideo();
    videoEl.src = snap.videoSrc;
    videoEl.play().catch(() => {});
    setStatus('Retour diffusion');
  }
}

function stopLunaOverlayHard() {
  try { lunaPost('PAUSE'); } catch {}
  try { radioAudio?.pause(); } catch {}

  lunaIsPlaying = false;
  lunaReady = false;

  radioPlaying = false;
  if (radioPlayBtn) radioPlayBtn.textContent = '▶';
  miniRadioEl?.classList.remove('playing');

  hideRadioOverlayInPlayer();

  try {
    if (videoEl) {
      videoEl.muted = prevVideoMuted;
      videoEl.volume = prevVideoVolume;
    }
  } catch {}

  lastPlaybackSnapshot = null;
}

function stopRadioAndRestore() {
  try { lunaPost('PAUSE'); } catch {}
  try { radioAudio?.pause(); } catch {}

  lunaIsPlaying = false;
  lunaReady = false;

  radioPlaying = false;
  if (radioPlayBtn) radioPlayBtn.textContent = '▶';
  miniRadioEl?.classList.remove('playing');

  restorePlaybackAfterRadio();
}

if (miniRadioEl && radioPlayBtn) {
  radioPlayBtn.addEventListener('click', () => {
    if (!radioPlaying) {
      lastPlaybackSnapshot = snapshotCurrentPlayback();
      stopPlaybackForRadio(lastPlaybackSnapshot);

      radioPlaying = true;

      // Demande à Luna de jouer RADIO ALFA (station 0)
      lunaPost('PLAY_STATION', { stationIndex: 0, stationKey: 'RADIO_ALFA', stationName: 'RADIO ALFA' });

      // UI optimiste (Luna renverra LUNA_STATE)
      radioPlayBtn.textContent = '⏸';
      miniRadioEl.classList.add('playing');
      setStatus('Luna • RADIO ALFA');
    } else {
      stopRadioAndRestore();
    }
  });
}

// =====================================================
// RENDERING
// =====================================================

// =====================================================
// TRAILERS (TMDb -> YouTube) — Films (channelList)
// =====================================================
// ⚠️ Renseigne ta clé TMDb v3 ici (api_key) : https://www.themoviedb.org/settings/api
// Tu peux aussi utiliser un Bearer token, mais ici on reste simple avec api_key.
const TMDB_API_KEY = '28137357fc45c293055b72824aef6006'; // <-- AJOUTE TA CLE ICI
const TMDB_LANG_PRIMARY = 'fr-FR';
const TMDB_LANG_FALLBACK = 'en-US';

// Cache en mémoire (évite des appels répétés). Clé = "title|year"
const __trailerCache = new Map();
// Rendu du badge trailer (🎞 + petit tag FR/EN/KO)
function __trailerBadgeHTML(tag) {
  const t = (tag || '').trim();
  if (!t) return '🎞';
  const safe = t.replace(/[^A-Z0-9?]/g, '').slice(0, 3);
  return '<span style="display:inline-flex;align-items:center;gap:4px;">' +
    '<span aria-hidden="true">🎞</span>' +
    '<span style="font-size:11px;font-weight:800;letter-spacing:.02em;">' + safe + '</span>' +
  '</span>';
}

function __getTrailerTagFromCache(entry) {
  try {
    const key = __trailerCacheKey(entry);
    const c = __trailerCache.get(key);
    if (!c) return '';
    if (c.ok === false) return 'KO';
    return c.langTag || '';
  } catch (_) {
    return '';
  }
}
 // key -> { ok:boolean, youtubeKey?:string, movieId?:number, at:number, info?:string }

// Nettoyage très simple de titres venant d'une playlist
function __extractTitleYear(rawName) {
  const out = { title: '', year: '' };
  if (!rawName) return out;

  // base: normalise + remplace séparateurs
  let s = String(rawName);
  try { s = normalizeName(s); } catch {}
  s = s.replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim();

  // year: prend le DERNIER 19xx/20xx
  const years = s.match(/\b(19|20)\d{2}\b/g);
  if (years && years.length) out.year = years[years.length - 1];

  // vire les tags courants (qualité/lang)
  const junk = [
    /\b(480p|720p|1080p|2160p|4k|uhd|hdr|dv|x264|x265|hevc|aac|dts|truehd|bluray|brrip|webrip|web\-dl|hdtv)\b/ig,
    /\b(vf|vff|vfi|vostfr|truefrench|french|multi|subbed)\b/ig
  ];
  junk.forEach(rx => { s = s.replace(rx, ' '); });

  // enlève crochets/parenthèses (mais on garde l'année déjà extraite)
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^\)]*\)/g, ' ');

  // enlève l'année du titre
  if (out.year) {
    const ry = new RegExp('\\b' + out.year + '\\b', 'g');
    s = s.replace(ry, ' ');
  }

  // final
  s = s.replace(/\s+/g, ' ').trim();
  out.title = s;
  return out;
}

function __trailerCacheKey(entry) {
  const q = __extractTitleYear(entry?.name || '');
  const t = (q.title || '').toLowerCase().trim();
  const y = (q.year || '').trim();
  return (t || 'unknown') + '|' + y;
}

async function __tmdbJson(url) {
  const res = await fetch(url, { method: 'GET', cache: 'no-store' });
  if (!res.ok) throw new Error('TMDb HTTP ' + res.status);
  return await res.json();
}

function __pickBestYoutubeVideo(results, preferredIso) {
  if (!Array.isArray(results) || !results.length) return null;

  const pref = (preferredIso || '').toLowerCase().trim();

  // On garde YouTube uniquement
  const yt = results.filter(v => (v?.site === 'YouTube') && v?.key);
  if (!yt.length) return null;

  // Priorité (dans la langue préférée si possible):
  // - Trailer officiel > Trailer > Teaser
  // - + bonus langue (iso_639_1)
  const score = (v) => {
    let s = 0;

    // bonus langue
    const iso = String(v?.iso_639_1 || '').toLowerCase();
    if (pref && iso === pref) s += 80;

    // bonus "official"
    if (v.official) s += 100;

    const type = String(v.type || '').toLowerCase();
    if (type === 'trailer') s += 50;
    else if (type === 'teaser') s += 20;
    else s += 5;

    // "size" (720/1080) → bonus léger
    if (typeof v.size === 'number') s += Math.min(10, Math.floor(v.size / 120));

    // micro bonus si le nom contient "official trailer"
    const name = String(v.name || '').toLowerCase();
    if (name.includes('official') && name.includes('trailer')) s += 10;

    return s;
  };

  yt.sort((a, b) => score(b) - score(a));
  return yt[0] || null;
}

async function __resolveTrailerYoutubeKey(entry) {
  if (!TMDB_API_KEY) throw new Error('TMDB_API_KEY manquant');

  const q = __extractTitleYear(entry?.name || '');
  const query = q.title || entry?.name || '';
  if (!query) throw new Error('Titre introuvable');

  const year = q.year ? String(q.year) : '';
  const base = 'https://api.themoviedb.org/3';

  const buildSearchUrl = (lang) => {
    const params = new URLSearchParams();
    params.set('api_key', TMDB_API_KEY);
    params.set('query', query);
    params.set('include_adult', 'false');
    if (lang) params.set('language', lang);
    if (year) {
      // Selon les versions/clients TMDb, "year" et "primary_release_year" peuvent être utilisés.
      params.set('year', year);
      params.set('primary_release_year', year);
    }
    return base + '/search/movie?' + params.toString();
  };

  // 1) Search movie — priorité FR, puis fallback EN si aucun résultat
  let search = await __tmdbJson(buildSearchUrl(TMDB_LANG_PRIMARY));
  let results = Array.isArray(search?.results) ? search.results : [];

  if (!results.length && TMDB_LANG_FALLBACK && TMDB_LANG_FALLBACK !== TMDB_LANG_PRIMARY) {
    search = await __tmdbJson(buildSearchUrl(TMDB_LANG_FALLBACK));
    results = Array.isArray(search?.results) ? search.results : [];
  }

  if (!results.length) throw new Error('Aucun résultat TMDb');

  // Choix du meilleur candidat:
  // - si année: priorité aux films dont release_date commence par l'année
  // - sinon: 1er résultat
  let best = results[0];
  if (year) {
    const byYear = results.find(r => (r?.release_date || '').startsWith(year));
    if (byYear) best = byYear;
  }

  const movieId = best?.id;
  if (!movieId) throw new Error('ID TMDb introuvable');

  // 2) Videos — priorité FR, fallback EN, puis dernier essai "sans langue"
  const buildVideosUrl = (lang) => {
    const p = new URLSearchParams();
    p.set('api_key', TMDB_API_KEY);
    if (lang) p.set('language', lang);
    return base + '/movie/' + movieId + '/videos?' + p.toString();
  };

  const prefIso = (TMDB_LANG_PRIMARY || 'fr-FR').split('-')[0].toLowerCase();
  const fallbackIso = (TMDB_LANG_FALLBACK || 'en-US').split('-')[0].toLowerCase();

  let pickedLangParam = TMDB_LANG_PRIMARY || '';

  let vids = await __tmdbJson(buildVideosUrl(TMDB_LANG_PRIMARY));
  let pick = __pickBestYoutubeVideo(vids?.results, prefIso);

  if (!pick) {
    pickedLangParam = TMDB_LANG_FALLBACK || '';
    vids = await __tmdbJson(buildVideosUrl(TMDB_LANG_FALLBACK));
    pick = __pickBestYoutubeVideo(vids?.results, fallbackIso);
  }

  if (!pick) {
    // Certains catalogues renvoient mieux sans paramètre language
    pickedLangParam = '';
    vids = await __tmdbJson(buildVideosUrl(''));
    pick = __pickBestYoutubeVideo(vids?.results, prefIso);
  }

  if (!pick || !pick.key) throw new Error('Trailer YouTube introuvable');

  // Tag affiché dans le badge (FR prioritaire, sinon EN, sinon ??)
  const iso = (pick.iso_639_1 || '').toLowerCase();
  let langTag = '??';
  if (iso === 'fr' || (pickedLangParam || '').startsWith('fr')) langTag = 'FR';
  else if (iso === 'en' || (pickedLangParam || '').startsWith('en')) langTag = 'EN';
  else if (iso) langTag = iso.toUpperCase().slice(0, 2);

  return { youtubeKey: pick.key, movieId, info: best?.title || query, langTag, langIso: iso || '' };}

async function openTrailerFromEntry(entry, btnEl) {
  if (!entry) return;

  // petit feedback visuel
  if (btnEl) { btnEl.innerHTML = '⏳'; btnEl.disabled = true; }

  try {
    const key = __trailerCacheKey(entry);
    const cached = __trailerCache.get(key);

    let data = cached;
    if (!data || (Date.now() - (data.at || 0)) > 1000 * 60 * 60 * 24) {
      // refresh toutes les 24h (en mémoire, donc surtout utile pendant la session)
      data = null;
    }

    if (!data) {
      const resolved = await __resolveTrailerYoutubeKey(entry);
      data = {
        ok: true,
        youtubeKey: resolved.youtubeKey,
        movieId: resolved.movieId,
        langTag: resolved.langTag || '',
        at: Date.now(),
        info: resolved.info || ''
      };
      __trailerCache.set(key, data);
    }

    if (!data.ok || !data.youtubeKey) throw new Error(data.info || 'Trailer introuvable');

    // On joue le trailer en overlay sans modifier l'entrée d'origine
    const trailerEntry = Object.assign({}, entry, {
      // on garde le même id pour rester "active" dans la liste
      url: 'https://www.youtube-nocookie.com/embed/' + data.youtubeKey,
      isIframe: true,
      group: 'Bande-annonce',
    });

    // On conserve currentListType tel quel (utile si tu es sur l'onglet Favoris)
    activePlaybackMode = 'iframe';
    playEntryAsOverlay(trailerEntry);

    // Met à jour le badge (FR/EN/??)
    if (btnEl) btnEl.innerHTML = __trailerBadgeHTML(data.langTag);

    setStatus('Trailer: ' + (data.info || normalizeName(entry.name)));

    refreshActiveListsUI();
    if (favoriteListEl?.classList.contains('active')) renderFavoritesList();
    scrollToActiveItem();
  } catch (err) {
    const msg = err?.message ? String(err.message) : 'Erreur trailer';
    setStatus('Trailer: ' + msg);
    console.warn('[TRAILER]', msg);

    // Cache négatif (affiche KO sans retaper l’API à chaque clic)
    try {
      const key = __trailerCacheKey(entry);
      __trailerCache.set(key, { ok: false, at: Date.now(), info: msg, langTag: 'KO' });
    } catch (_) {}

    if (btnEl) btnEl.innerHTML = __trailerBadgeHTML('KO');
  } finally {
    if (btnEl) { btnEl.disabled = false; }
  }
}


let suspendRender = false;
let pendingRender = false;

function renderLists() {
  if (suspendRender) { pendingRender = true; return; }
  renderChannelList();
  renderChannelFrList();
  renderIframeList();
  renderFavoritesList();
}

function flushPendingRender() {
  if (!pendingRender) return;
  pendingRender = false;
  // Next frame → let UI breathe
  requestAnimationFrame(() => renderLists());
}

function refreshActiveListsUI() {
  if (currentListType === 'channels') renderChannelList();
  else if (currentListType === 'fr') renderChannelFrList();
  else if (currentListType === 'iframe') renderIframeList();
  else if (currentListType === 'favorites') renderFavoritesList();

  // si l’onglet Favoris est affiché (liste active), on refresh aussi
  if (favoriteListEl?.classList.contains('active') && currentListType !== 'favorites') {
    renderFavoritesList();
  }
}

function renderChannelFrList() {
  if (!channelFrListEl) return;
  channelFrListEl.innerHTML = '';
  frChannels.forEach((ch, idx) => {
    if (!matchesSearch(ch)) return;
    channelFrListEl.appendChild(createChannelElement(ch, idx, 'fr'));
  });
}

function renderChannelList() {
  if (!channelListEl) return;
  channelListEl.innerHTML = '';

  // Bouton visible uniquement sur l'onglet Films
  updateNewAdditionsButtonVisibility();

  // Mode "Derniers ajouts" : on affiche seulement les items dont tvg-id est dans le JSON
  if (newAdditionsMode) {
    const header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.gap = '8px';
    header.style.padding = '6px 6px 10px';

    const title = document.createElement('div');
    title.style.fontSize = '10px';
    title.style.textTransform = 'uppercase';
    title.style.letterSpacing = '.14em';
    title.style.color = 'var(--tron-muted)';
    title.textContent = 'Derniers ajouts';

    const backBtn = document.createElement('button');
    backBtn.className = 'btn btn-ghost';
    backBtn.type = 'button';
    backBtn.textContent = '↩ Retour Films';
    backBtn.addEventListener('click', () => {
      newAdditionsMode = false;
      renderChannelList();
      scrollToActiveItem();
    });

    header.appendChild(title);
    header.appendChild(backBtn);
    channelListEl.appendChild(header);

    const idxs = computeNewAdditionsIndexes();
    if (!idxs.length) {
      const empty = document.createElement('div');
      empty.style.textAlign = 'center';
      empty.style.padding = '14px 10px';
      empty.style.color = 'var(--tron-muted)';
            const hasIds = Array.isArray(newAdditionsIds) && newAdditionsIds.length > 0;
      if (hasIds) {
        empty.textContent = 'Aucun film trouvé pour les IDs indiqués dans nouveaux_items.json';
        const hint = document.createElement('div');
        hint.style.marginTop = '6px';
        hint.style.fontSize = '11px';
        hint.style.opacity = '0.9';
        hint.style.whiteSpace = 'pre-wrap';
        hint.style.wordBreak = 'break-word';
        hint.textContent = 'IDs: ' + newAdditionsIds.join(', ');
        channelListEl.appendChild(empty);
        channelListEl.appendChild(hint);
        return;
      }
      empty.textContent = 'Aucun nouveau film pour le moment 🎞️';
      channelListEl.appendChild(empty);
      return;
    }

    idxs.forEach((idx) => {
      const ch = channels[idx];
      if (!ch) return;
      if (!matchesSearch(ch)) return;
      channelListEl.appendChild(createChannelElement(ch, idx, 'channels'));
    });
    return;
  }

  channels.forEach((ch, idx) => {
    if (!matchesSearch(ch)) return;
    channelListEl.appendChild(createChannelElement(ch, idx, 'channels'));
  });
}

function renderIframeList() {
  if (!iframeListEl) return;
  iframeListEl.innerHTML = '';
  iframeItems.forEach((it, idx) => {
    if (!matchesSearch(it)) return;
    iframeListEl.appendChild(createChannelElement(it, idx, 'iframe'));
  });
}

function renderFavoritesList() {
  if (!favoriteListEl) return;
  favoriteListEl.innerHTML = '';

  const favs = [
    ...channels.filter(c => c.isFavorite).map(e => ({ entry: e, sourceType: 'channels' })),
    ...frChannels.filter(c => c.isFavorite).map(e => ({ entry: e, sourceType: 'fr' })),
    ...iframeItems.filter(i => i.isFavorite).map(e => ({ entry: e, sourceType: 'iframe' }))
  ].filter(({ entry }) => matchesSearch(entry));

  favoritesView = favs.map(({ entry, sourceType }) => {
    let sourceIndex = -1;
    if (sourceType === 'channels') sourceIndex = channels.findIndex(x => x.id === entry.id);
    else if (sourceType === 'fr') sourceIndex = frChannels.findIndex(x => x.id === entry.id);
    else if (sourceType === 'iframe') sourceIndex = iframeItems.findIndex(x => x.id === entry.id);
    return { id: entry.id, sourceType, sourceIndex, entry };
  }).filter(x => x.sourceIndex >= 0);

  // sync curseur favoris sur l’entrée réellement en lecture
  currentFavPos = currentEntry?.id ? favoritesView.findIndex(x => x.id === currentEntry.id) : -1;

  favoritesView.forEach((item, pos) => {
    const el = createChannelElement(item.entry, item.sourceIndex, item.sourceType);
    el.dataset.favpos = String(pos);

    el.addEventListener('click', () => {
      currentListType = 'favorites';
      currentFavPos = pos;

      // ✅ on joue directement l’entrée (currentEntry est la source de vérité)
      playUrl(item.entry);
      refreshActiveListsUI();
      renderFavoritesList();
      scrollToActiveItem();
    });

    favoriteListEl.appendChild(el);
  });
}

// =====================================================

// =====================================================
// QUALITÉ FILM (déduite du titre, ex: 1080p / 4K / HDR / WEB-DL)
// =====================================================
function __extractQualityChips(rawName) {
  try {
    const s0 = String(rawName || '');
    if (!s0) return [];
    const s = s0
      .toUpperCase()
      .replace(/[\[\]\(\)\{\}\|]/g, ' ')
      .replace(/[._]/g, ' ')
      .replace(/-/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Résolution (priorité au plus haut)
    let res = '';
    if (/\b(2160P|2160|4K|UHD)\b/.test(s)) res = '4K';
    else if (/\b1080P\b/.test(s) || /\b1080\b/.test(s)) res = '1080P';
    else if (/\b720P\b/.test(s) || /\b720\b/.test(s)) res = '720P';
    else if (/\b576P\b/.test(s) || /\b576\b/.test(s)) res = '576P';
    else if (/\b480P\b/.test(s) || /\b480\b/.test(s)) res = '480P';

    // HDR / Dolby Vision
    let hdr = '';
    if (/\bDOLBY\s*VISION\b/.test(s) || /\bDV\b/.test(s)) hdr = 'DV';
    else if (/\bHDR10\+\b/.test(s)) hdr = 'HDR10+';
    else if (/\bHDR10\b/.test(s)) hdr = 'HDR10';
    else if (/\bHDR\b/.test(s)) hdr = 'HDR';

    // Source (un seul tag max pour rester compact)
    let src = '';
    if (/\bREMUX\b/.test(s)) src = 'REMUX';
    else if (/\b(BLU\s*RAY|BLURAY|BDRIP|BRRIP)\b/.test(s)) src = 'BLURAY';
    else if (/\b(WEB[- ]?DL|WEBDL)\b/.test(s)) src = 'WEB-DL';
    else if (/\bWEBRIP\b/.test(s)) src = 'WEBRIP';
    else if (/\bHDTV\b/.test(s)) src = 'HDTV';
    else if (/\bDVDRIP\b/.test(s)) src = 'DVDRIP';
    else if (/\b(HDCAM|CAM)\b/.test(s)) src = 'CAM';
    else if (/\b(TELESYNC|TS)\b/.test(s)) src = 'TS';

    // Codec (si pas de "src" détecté)
    let codec = '';
    if (/\b(HEVC|X265|H\.?265)\b/.test(s)) codec = 'HEVC';
    else if (/\b(X264|H\.?264)\b/.test(s)) codec = 'H264';

    const chips = [];
    if (res) chips.push(res);
    if (hdr) chips.push(hdr);

    // 3e chip : source sinon codec (reste compact)
    if (src) chips.push(src);
    else if (codec) chips.push(codec);

    return chips;
  } catch (_) {
    return [];
  }
}

// --------- QUALITÉ (KALTURA / DASH MPD) ---------
// Objectif : si le titre ne contient pas d'info qualité, on essaie de lire le manifest.mpd (DASH)
// et d'en déduire résolution max + codec (H264/HEVC/AV1).
// ⚠️ Ça ne marche que si la ressource autorise le fetch cross-origin (CORS).
const __mpdQualityMemCache = new Map(); // url -> { chips: string[], lang?: string, ts: number }
const __MPD_CACHE_LS_KEY = 'tronAresMpdQualityCacheV1';
const __MPD_CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 jours

function __loadMpdQualityCacheFromLS() {
  try {
    const raw = localStorage.getItem(__MPD_CACHE_LS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return;
    const now = Date.now();
    for (const [url, v] of Object.entries(obj)) {
      if (!v || typeof v !== 'object') continue;
      if (v.ts && (now - v.ts) > __MPD_CACHE_TTL_MS) continue;
      if (Array.isArray(v.chips)) {
        v.chips = __uniquePreserveOrder(v.chips);
        __mpdQualityMemCache.set(url, v);
      }
    }
  } catch {}
}
function __saveMpdQualityCacheToLSThrottled() {
  // on sauvegarde rarement pour éviter de bloquer l'UI
  if (__saveMpdQualityCacheToLSThrottled._t) return;
  __saveMpdQualityCacheToLSThrottled._t = setTimeout(() => {
    __saveMpdQualityCacheToLSThrottled._t = null;
    try {
      const out = {};
      for (const [url, v] of __mpdQualityMemCache.entries()) {
        // limite de taille soft
        out[url] = v;
      }
      localStorage.setItem(__MPD_CACHE_LS_KEY, JSON.stringify(out));
    } catch {}
  }, 1200);
}
__loadMpdQualityCacheFromLS();
// --------- AFFICHAGE QUALITÉ DANS LE FOOTER (helper-text) ---------
// Objectif : éviter d'ajouter des tags dans chaque channel-item (trop serré sur mobile).
// On affiche la qualité du FILM sélectionné dans la zone helper-text (en bas).
const __helperTextEl = document.querySelector('.helper-text');
const __DEFAULT_HELPER_TEXT_HTML = __helperTextEl ? __helperTextEl.innerHTML : '';

function __setHelperTextHTML(html) {
  if (!__helperTextEl) return;
  __helperTextEl.innerHTML = String(html || '');
}


function __uniquePreserveOrder(arr) {
  const out = [];
  const seen = new Set();
  for (const v of (Array.isArray(arr) ? arr : [])) {
    const k = String(v);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}


function __formatQualityText(chips) {
  const u = __uniquePreserveOrder(chips);
  if (!u.length) return '—';
  return u.join(' • ');
}


function __updateHelperTextForEntry(entry) {
  if (!__helperTextEl) return;

  // On ne remplace le helper que pour la liste FILMS (channels)
  if (!entry || entry.listType !== 'channels') {
    __setHelperTextHTML(__DEFAULT_HELPER_TEXT_HTML);
    return;
  }

  const fromTitle = __extractQualityChips(entry?.name || '');
  if (fromTitle && fromTitle.length) {
    __setHelperTextHTML('Qualité : <span>' + __formatQualityText(fromTitle) + '</span>');
    return;
  }

  const url = String(entry?.url || '');
  if (!url || !__looksLikeDashMpdUrl(url)) {
    __setHelperTextHTML('Qualité : <span>—</span>');
    return;
  }

  // Cache immédiat si dispo
  const cached = __mpdQualityMemCache.get(url);
  if (cached && Array.isArray(cached.chips) && cached.chips.length) {
    __setHelperTextHTML('Qualité : <span>' + __formatQualityText(cached.chips) + '</span>');
    return;
  }

  // Sinon : placeholder + fetch MPD
  __setHelperTextHTML('Qualité : <span>…</span>');

  __getMpdQualityChips(url).then((chips) => {
    // Ne pas écraser si l'utilisateur a changé de film
    if (!currentEntry || currentEntry.id !== entry.id) return;
    if (chips && chips.length) __setHelperTextHTML('Qualité : <span>' + __formatQualityText(chips) + '</span>');
    else __setHelperTextHTML('Qualité : <span>—</span>');
  }).catch(() => {
    if (!currentEntry || currentEntry.id !== entry.id) return;
    __setHelperTextHTML('Qualité : <span>—</span>');
  });
}


function __looksLikeDashMpdUrl(url) {
  const u = String(url || '');
  if (!u) return false;
  // Kaltura/Akamai ou MPD générique
  return /\.mpd(\?|$)/i.test(u) || /manifest\.mpd/i.test(u);
}

function __codecLabelFromCodecs(codecs) {
  const c = String(codecs || '').toLowerCase();
  if (!c) return '';
  if (c.includes('av01')) return 'AV1';
  if (c.includes('hvc1') || c.includes('hev1')) return 'HEVC';
  if (c.includes('avc1')) return 'H264';
  return '';
}

function __resLabelFromHeight(h) {
  const height = Number(h || 0);
  if (!height) return '';
  if (height >= 2160) return '2160P';
  if (height >= 1440) return '1440P';
  if (height >= 1080) return '1080P';
  if (height >= 720)  return '720P';
  if (height >= 576)  return '576P';
  if (height >= 480)  return '480P';
  if (height >= 360)  return '360P';
  return String(height) + 'P';
}

function __parseMpdQualityChips(mpdXmlText) {
  const doc = new DOMParser().parseFromString(String(mpdXmlText || ''), 'application/xml');
  if (!doc || doc.querySelector('parsererror')) throw new Error('MPD parse error');

  const adaptationSets = Array.from(doc.querySelectorAll('AdaptationSet'));
  const reps = [];

  for (const as of adaptationSets) {
    const contentType = (as.getAttribute('contentType') || '').toLowerCase();
    const mimeType = (as.getAttribute('mimeType') || '').toLowerCase();
    // Si contentType est défini, on exige "video"
    if (contentType && contentType !== 'video') continue;
    // Si mimeType est défini, on exige "video/*"
    if (mimeType && !mimeType.includes('video')) continue;

    const asCodecs = as.getAttribute('codecs') || '';
    const asFrameRate = as.getAttribute('frameRate') || '';

    const asReps = Array.from(as.querySelectorAll('Representation'));
    for (const r of asReps) {
      const height = parseInt(r.getAttribute('height') || '0', 10);
      const width = parseInt(r.getAttribute('width') || '0', 10);
      const bandwidth = parseInt(r.getAttribute('bandwidth') || '0', 10);
      const codecs = r.getAttribute('codecs') || asCodecs;
      const frameRate = r.getAttribute('frameRate') || asFrameRate;
      reps.push({ height, width, bandwidth, codecs, frameRate });
    }
  }

  if (!reps.length) return [];

  // Représentation "best" = plus grande hauteur, puis meilleur bitrate
  reps.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  const best = reps[0];

  // Liste des résolutions disponibles (top 4), pour aider l'utilisateur
  const heights = Array.from(new Set(reps.map(r => r.height).filter(Boolean)));
  heights.sort((a, b) => b - a);
  const resList = heights.slice(0, 4).map(__resLabelFromHeight).filter(Boolean);

  const chips = [];
  // Ex: 2160P 1080P 720P 480P
  chips.push(...resList);

  // Codec (du best)
  const codec = __codecLabelFromCodecs(best.codecs);
  if (codec) chips.push(codec);

  // Bonus FPS si on peut (ex: "30000/1001" ou "60")
  const fr = String(best.frameRate || '').trim();
  if (fr) {
    let fps = 0;
    if (/^\d+\/\d+$/.test(fr)) {
      const [n, d] = fr.split('/').map(x => parseInt(x, 10));
      if (n > 0 && d > 0) fps = n / d;
    } else if (/^\d+(\.\d+)?$/.test(fr)) {
      fps = parseFloat(fr);
    }
    if (fps >= 50) chips.push(Math.round(fps) + 'FPS');
  }

  // Limite soft pour ne pas surcharger l'UI
  return __uniquePreserveOrder(chips).slice(0, 6);
}

async function __getMpdQualityChips(url) {
  const u = String(url || '');
  if (!__looksLikeDashMpdUrl(u)) return [];
  const now = Date.now();

  const cached = __mpdQualityMemCache.get(u);
  if (cached && Array.isArray(cached.chips) && (!cached.ts || (now - cached.ts) < __MPD_CACHE_TTL_MS)) {
    return cached.chips;
  }

  // fetch MPD (CORS requis)
  const res = await fetch(u, { method: 'GET', credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const xml = await res.text();
  const chips = __uniquePreserveOrder(__parseMpdQualityChips(xml));

  __mpdQualityMemCache.set(u, { chips, ts: now });
  __saveMpdQualityCacheToLSThrottled();
  return chips;
}






// CREATE CHANNEL ELEMENT (✅ 1 SEULE SOURCE D’ACTIVE : currentEntry.id)
// =====================================================
function createChannelElement(entry, index, sourceType) {
  const li = document.createElement('div');
  // Tooltip sur l'item complet (utile si le titre est tronqué)
  try { li.title = String(entry.name || ''); } catch {}
  li.className = 'channel-item';
  li.dataset.index = String(index);
  li.dataset.type = sourceType;
  li.dataset.url = entry?.url ? String(entry.url) : '';
  li.dataset.linkkey = linkKeyForEntry(entry);

  // ✅ Une seule source de vérité pour "active"
  const isActive = !!currentEntry && currentEntry.id === entry.id;
  if (isActive) li.classList.add('active');

  const logoDiv = document.createElement('div');
  logoDiv.className = 'channel-logo';

  if (entry.logo && entry.logo.type === 'image') {
    const img = document.createElement('img');
    img.src = entry.logo.value;
    img.alt = entry.name || '';
    try { img.loading = 'lazy'; } catch {}
    try { img.decoding = 'async'; } catch {}
    try { img.setAttribute('fetchpriority','low'); } catch {}
    logoDiv.appendChild(img);
  } else {
    logoDiv.textContent = entry.logo?.value ?? deriveLogoFromName(entry.name).value;
  }

  const metaDiv = document.createElement('div');
  metaDiv.className = 'channel-meta';

  const titleDiv = document.createElement('div');
  titleDiv.className = 'channel-title';
  titleDiv.textContent = normalizeName(entry.name);
  // Tooltip titre complet (utile quand c'est tronqué)
  try { titleDiv.title = String(entry.name || ''); } catch {}

  const statusBadge = document.createElement('span');
  statusBadge.className = 'link-status';

  // Numéro de chaîne (affichage)
  const numDiv = document.createElement('div');
  numDiv.className = 'channel-num';
  numDiv.textContent = String(index + 1);

  const titleRow = document.createElement('div');
  titleRow.className = 'channel-title-row';
  titleRow.appendChild(numDiv);
  titleRow.appendChild(titleDiv);
  titleRow.appendChild(statusBadge);
  titleRow.appendChild(statusBadge);
  titleRow.appendChild(statusBadge);

  const subDiv = document.createElement('div');
  subDiv.className = 'channel-sub';
  subDiv.textContent = entry.group || (entry.isIframe ? 'Overlay / iFrame' : 'Flux M3U');

  const tagsDiv = document.createElement('div');
  tagsDiv.className = 'channel-tags';

  const showIframe = !!entry.isIframe || (isActive && activePlaybackMode === 'iframe');

  const tag = document.createElement('div');
  tag.className = 'tag-chip' + (showIframe ? ' tag-chip--iframe' : '');
  tag.textContent = showIframe ? 'IFRAME' : 'STREAM';
  tagsDiv.appendChild(tag);

  if (isYoutubeUrl(entry.url)) {
    const ytTag = document.createElement('div');
    ytTag.className = 'tag-chip tag-chip--iframe';
    ytTag.textContent = 'YOUTUBE';
    tagsDiv.appendChild(ytTag);
  }

  metaDiv.appendChild(titleRow);
  metaDiv.appendChild(subDiv);
  metaDiv.appendChild(tagsDiv);

  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'channel-actions';

  // 🎞️ Badge "Trailer" (Films / channelList) — placé avant le bouton Favori
  // (uniquement sur la liste Films et ses favoris)
  if (sourceType === 'channels') {
    const trailerBtn = document.createElement('button');
    trailerBtn.className = 'icon-btn tmdb-trailer-btn';
    trailerBtn.style.width = '41px';
    trailerBtn.innerHTML = __trailerBadgeHTML(__getTrailerTagFromCache(entry));
    trailerBtn.title = 'Bande-annonce (TMDb)';
    trailerBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      openTrailerFromEntry(entry, trailerBtn);
    });
    actionsDiv.appendChild(trailerBtn);
  }

  const favBtn = document.createElement('button');
  favBtn.className = 'icon-btn';
  favBtn.innerHTML = '★';
  favBtn.title = 'Ajouter / enlever des favoris';
  favBtn.dataset.fav = entry.isFavorite ? 'true' : 'false';

  favBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    entry.isFavorite = !entry.isFavorite;
    favBtn.dataset.fav = entry.isFavorite ? 'true' : 'false';
    refreshActiveListsUI();
    renderFavoritesList();
  });

  const ovBtn = document.createElement('button');
  ovBtn.className = 'icon-btn';
  ovBtn.innerHTML = '⧉';
  ovBtn.title = 'Lire en overlay iFrame';

  ovBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();

    // garder l’onglet courant (sourceType) pour les indices (next/prev hors favoris)
    currentListType = sourceType;
    if (sourceType === 'channels') currentIndex = index;
    else if (sourceType === 'fr') currentFrIndex = index;
    else if (sourceType === 'iframe') currentIframeIndex = index;

    activePlaybackMode = 'iframe';
    playEntryAsOverlay(entry);

    refreshActiveListsUI();
    if (favoriteListEl?.classList.contains('active')) renderFavoritesList();
    scrollToActiveItem();
  });

  actionsDiv.appendChild(favBtn);
  actionsDiv.appendChild(ovBtn);

  li.appendChild(logoDiv);
  li.appendChild(metaDiv);
  li.appendChild(actionsDiv);

  li.addEventListener('click', () => {
    if (sourceType === 'channels') playChannel(index);
    else if (sourceType === 'fr') playFrChannel(index);
    else if (sourceType === 'iframe') playIframe(index);
  });

  hydrateBadgeFromCache(li, entry);
  return li;
}

// =====================================================
// NOW PLAYING BAR
// =====================================================
function updateNowPlaying(entry, modeLabel) {
  if (!npLogo || !npTitle || !npSub || !npBadge) return;

  if (!entry) {
    npLogo.textContent = '';
    npTitle.textContent = 'Aucune chaîne sélectionnée';
    npSub.textContent = 'Choisissez une chaîne dans la liste';
    npBadge.textContent = 'IDLE';
    return;
  }

  const logo = entry.logo || deriveLogoFromName(entry.name);
  npLogo.innerHTML = '';

  if (logo.type === 'image') {
    const img = document.createElement('img');
    img.src = logo.value;
    img.alt = entry.name || '';
    try { img.loading = 'lazy'; } catch {}
    try { img.decoding = 'async'; } catch {}
    try { img.setAttribute('fetchpriority','low'); } catch {}
    npLogo.appendChild(img);
  } else {
    npLogo.textContent = logo.value;
  }

  npTitle.textContent = normalizeName(entry.name);
  npSub.textContent = entry.group || (entry.isIframe ? 'Overlay / iFrame' : 'Flux M3U');
  npBadge.textContent = modeLabel;
}



function _entryMatch(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id && a.id === b.id) return true;
  if (a.url && b.url && a.url === b.url) return true;
  return false;
}

function syncPlaybackPositionFromEntry() {
  if (!currentEntry) return;

  const activeTab = document.querySelector('.tab-btn.active')?.dataset?.tab || currentListType || '';

  const tryList = (type) => {
    if (type === 'favorites') {
      const idx = favoritesView?.findIndex(x => _entryMatch(x?.entry, currentEntry)) ?? -1;
      if (idx >= 0) {
        currentListType = 'favorites';
        currentFavPos = idx;
        return true;
      }
    }

    if (type === 'fr') {
      const idx = frChannels.findIndex(x => _entryMatch(x, currentEntry));
      if (idx >= 0) {
        currentListType = 'fr';
        currentFrIndex = idx;
        return true;
      }
    }

    if (type === 'iframe') {
      const idx = iframeItems.findIndex(x => _entryMatch(x, currentEntry));
      if (idx >= 0) {
        currentListType = 'iframe';
        currentIframeIndex = idx;
        return true;
      }
    }

    if (type === 'channels') {
      const idx = channels.findIndex(x => _entryMatch(x, currentEntry));
      if (idx >= 0) {
        currentListType = 'channels';
        currentIndex = idx;
        return true;
      }
    }

    return false;
  };

  // 1) Priorité à l’onglet actif
  if (tryList(activeTab)) return;

  // 2) Puis au type courant
  if (tryList(currentListType)) return;

  // 3) Fallback: cherche partout
  if (tryList('fr')) return;
  if (tryList('channels')) return;
  if (tryList('iframe')) return;
  tryList('favorites');
}

function updateNowPlayingCounter() {
  if (!npCounter) return;

  // Synchronise indices/type à partir de currentEntry (robuste, même si playUrl() est appelé directement)
  syncPlaybackPositionFromEntry();

  let pos = 0;
  let total = 0;

  if (currentListType === 'favorites') {
    total = favoritesView?.length || 0;
    pos = currentFavPos >= 0 ? (currentFavPos + 1) : 0;
  } else if (currentListType === 'fr') {
    total = frChannels.length;
    pos = currentFrIndex >= 0 ? (currentFrIndex + 1) : 0;
  } else if (currentListType === 'iframe') {
    total = iframeItems.length;
    pos = currentIframeIndex >= 0 ? (currentIframeIndex + 1) : 0;
  } else {
    total = channels.length;
    pos = currentIndex >= 0 ? (currentIndex + 1) : 0;
  }

  const newText = total ? `${pos}/${total}` : '-/-';
  if (npCounter.textContent !== newText) {
    npCounter.textContent = newText;
    // Tick animation sans reflow de layout (transform/opacity seulement)
    npCounter.classList.remove('tick');
    void npCounter.offsetWidth; // restart animation
    npCounter.classList.add('tick');
  }
}





// =====================================================
// PISTES AUDIO / SOUS-TITRES (HLS) - MOVIE CONTEXT
// =====================================================
function closeAllTrackMenus() {
  audioTrackMenu?.classList.remove('open');
  subtitleTrackMenu?.classList.remove('open');
}

function buildAudioTrackMenu() {
  audioTrackMenu.innerHTML = '';

  // Header
  const header = document.createElement('div');
  header.className = 'np-track-menu-header';
  header.textContent = 'Audio';
  audioTrackMenu.appendChild(header);

  let provider = 'none';
  let tracks = [];
  let currentIndex = -1;

  // HLS (hls.js)
  if (hlsInstance && Array.isArray(hlsInstance.audioTracks)) {
    provider = 'hls';
    tracks = hlsInstance.audioTracks;
    currentIndex = (Number.isInteger(hlsInstance.audioTrack) && hlsInstance.audioTrack >= 0)
      ? hlsInstance.audioTrack
      : (tracks.length ? 0 : -1);
  }

  // DASH (dash.js)
  if (provider === 'none' && dashInstance && typeof dashInstance.getTracksFor === 'function') {
    provider = 'dash';
    tracks = dashInstance.getTracksFor('audio') || [];

    const currentTrack = (typeof dashInstance.getCurrentTrackFor === 'function')
      ? dashInstance.getCurrentTrackFor('audio')
      : null;

    if (currentTrack && tracks.length) {
      currentIndex = tracks.findIndex(t => {
        if (!t) return false;
        if (t === currentTrack) return true;
        if (t.id !== undefined && currentTrack.id !== undefined && t.id === currentTrack.id) return true;
        if (t.lang && currentTrack.lang && t.lang === currentTrack.lang) {
          const a = Array.isArray(t.roles) ? t.roles.join(',') : '';
          const b = Array.isArray(currentTrack.roles) ? currentTrack.roles.join(',') : '';
          return a === b;
        }
        return false;
      });
    }

    if (currentIndex < 0) currentIndex = tracks.length ? 0 : -1;
  }

  activeAudioIndex = currentIndex;
  // Build a simple language frequency map so we don't show internal ids when a language is unique
  const langCounts = {};
  (tracks || []).forEach((t) => {
    const l = (t && (t.lang || t.language || t.idLanguage))
      ? String(t.lang || t.language || t.idLanguage).trim().toLowerCase()
      : "";
    if (l) langCounts[l] = (langCounts[l] || 0) + 1;
  });

  // No tracks
  if (!tracks || tracks.length === 0) {
    const emptyItem = document.createElement('div');
    emptyItem.className = 'np-track-item';
    emptyItem.style.opacity = '0.7';
    emptyItem.style.pointerEvents = 'none';

    const emptyLabel = document.createElement('div');
    emptyLabel.className = 'np-track-item-label';
    emptyLabel.textContent = 'Aucune piste audio';
    emptyItem.appendChild(emptyLabel);

    audioTrackMenu.appendChild(emptyItem);
    return;
  }

  // Utility: bitrate formatting (DASH)
  const formatBitrate = (bps) => {
    const n = Number(bps);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n >= 1000 * 1000) return `${(n / (1000 * 1000)).toFixed(1)} Mbps`;
    if (n >= 1000) return `${Math.round(n / 1000)} kbps`;
    return `${Math.round(n)} bps`;
  };

  tracks.forEach((track, index) => {
    const item = document.createElement('div');
    item.className = 'np-track-item';
    item.dataset.index = index;

    if (index === currentIndex) item.classList.add('active');

    // Label + meta
    const labelEl = document.createElement('div');
    labelEl.className = 'np-track-item-label';

    const metaEl = document.createElement('div');
    metaEl.className = 'np-track-item-meta';

    if (provider === 'hls') {
      const lang = (track && (track.lang || track.language) ? String(track.lang || track.language) : '').trim();
      const name = (track && track.name ? String(track.name) : '').trim();
      const groupId = (track && track.groupId ? String(track.groupId) : '').trim();

      let label = name || lang || groupId || `Audio ${index + 1}`;
      if (name && lang && name !== lang) label = `${name} (${lang})`;

      labelEl.textContent = label;

      const parts = [];
      if (lang) parts.push(`Langue: ${lang}`);
      if (groupId) parts.push(`Groupe: ${groupId}`);
      metaEl.textContent = parts.join(' • ');
    } else if (provider === 'dash') {
      const lang = (track && (track.lang || track.language) ? String(track.lang || track.language) : '').trim();
      const langKey = lang ? lang.toLowerCase() : "";
      const roles = (track && Array.isArray(track.roles)) ? track.roles.filter(Boolean) : [];

      // Prefer label, then lang, then id
      const rawLabel = (track && track.label) ? String(track.label).trim() : '';
      const rawId = (track && track.id !== undefined) ? String(track.id).trim() : '';

      let label = rawLabel || lang || rawId || `Audio ${index + 1}`;
      if (rawLabel && lang && !rawLabel.toLowerCase().includes(lang.toLowerCase())) {
        label = `${rawLabel} (${lang})`;
      } else if (!rawLabel && rawId && lang) {
        label = (langKey && langCounts[langKey] > 1) ? `${lang} (${rawId})` : lang;
      }

      labelEl.textContent = label;

      const parts = [];
      if (lang) parts.push(`Langue: ${lang}`);
      if (roles.length) parts.push(`Rôle: ${roles.join(', ')}`);

      const bitrateList = (track && Array.isArray(track.bitrateList)) ? track.bitrateList : [];
      const bitrates = bitrateList
        .map(b => (b && (b.bitrate || b.bandwidth)) ? Number(b.bitrate || b.bandwidth) : NaN)
        .filter(Number.isFinite);

      if (bitrates.length) {
        const min = Math.min(...bitrates);
        const max = Math.max(...bitrates);
        if (min === max) parts.push(`Débit: ${formatBitrate(min)}`);
        else parts.push(`Débit: ${formatBitrate(min)} – ${formatBitrate(max)}`);
      }

      metaEl.textContent = parts.join(' • ');
    } else {
      labelEl.textContent = `Audio ${index + 1}`;
      metaEl.textContent = '';
    }

    item.appendChild(labelEl);
    if (metaEl.textContent) item.appendChild(metaEl);

    item.addEventListener('click', () => {
      setAudioTrack(index);
      closeAllTrackMenus();
    });

    audioTrackMenu.appendChild(item);
  });
}

function setAudioTrack(index) {
  // HLS (hls.js)
  if (hlsInstance && Array.isArray(hlsInstance.audioTracks)) {
    if (index < 0 || index >= hlsInstance.audioTracks.length) return;

    hlsInstance.audioTrack = index;
    activeAudioIndex = index;
    buildAudioTrackMenu();
    return;
  }

  // DASH (dash.js)
  if (dashInstance && typeof dashInstance.getTracksFor === 'function') {
    const tracks = dashInstance.getTracksFor('audio') || [];
    if (index < 0 || index >= tracks.length) return;

    const track = tracks[index];

    try {
      if (typeof dashInstance.setCurrentTrack === 'function') {
        dashInstance.setCurrentTrack(track);
      } else if (typeof dashInstance.setCurrentTrackFor === 'function') {
        dashInstance.setCurrentTrackFor('audio', track);
      } else if (typeof dashInstance.setCurrentTrackByIndex === 'function') {
        dashInstance.setCurrentTrackByIndex('audio', index);
      } else {
        console.warn('Impossible de changer la piste audio: API dash.js non trouvée.');
        return;
      }
    } catch (err) {
      console.error('Erreur lors du changement de piste audio (DASH):', err);
      return;
    }

    activeAudioIndex = index;
    buildAudioTrackMenu();
  }
}


function buildSubtitleTrackMenu() {
  if (!subtitleTrackMenu || !isMovieContext() || !videoEl) return;

  subtitleTrackMenu.innerHTML = '';

  let useHls = false;
  let tracks = [];
  let activeIndex = -1;

  if (hlsInstance && Array.isArray(hlsInstance.subtitleTracks) && hlsInstance.subtitleTracks.length > 0) {
    useHls = true;
    tracks = hlsInstance.subtitleTracks;
    activeIndex = hlsInstance.subtitleTrack;
  } else {
    const tt = Array.from(videoEl.textTracks || []).filter(t =>
      t.kind === 'subtitles' || t.kind === 'captions'
    );
    tracks = tt;
    if (tt.length) activeIndex = tt.findIndex(t => t.mode === 'showing');
  }

  activeSubtitleIndex = activeIndex;

  const header = document.createElement('div');
  header.className = 'np-track-menu-header';
  header.textContent = 'Sous-titres';
  subtitleTrackMenu.appendChild(header);

  const offItem = document.createElement('div');
  offItem.className = 'np-track-item';
  if (activeIndex === -1) offItem.classList.add('active');

  const offLabel = document.createElement('div');
  offLabel.className = 'np-track-item-label';
  offLabel.textContent = 'Aucun';
  offItem.appendChild(offLabel);

  offItem.addEventListener('click', () => {
    if (useHls && hlsInstance) {
      hlsInstance.subtitleTrack = -1;
    } else {
      Array.from(videoEl.textTracks || []).forEach(t => {
        if (t.kind === 'subtitles' || t.kind === 'captions') t.mode = 'disabled';
      });
    }
    activeSubtitleIndex = -1;
    buildSubtitleTrackMenu();
    closeAllTrackMenus();
  });

  subtitleTrackMenu.appendChild(offItem);

  if (!tracks.length) {
    const empty = document.createElement('div');
    empty.className = 'np-track-item';
    empty.textContent = 'Aucun sous-titre disponible';
    subtitleTrackMenu.appendChild(empty);
    return;
  }

  tracks.forEach((t, idx) => {
    const item = document.createElement('div');
    item.className = 'np-track-item';
    if (idx === activeIndex) item.classList.add('active');

    const label = document.createElement('div');
    label.className = 'np-track-item-label';
    label.textContent = t.name || t.label || t.lang || t.language || ('Sous-titres ' + (idx + 1));

    const meta = document.createElement('div');
    meta.className = 'np-track-item-meta';
    meta.textContent = (t.lang || t.language || '').toUpperCase();

    item.append(label, meta);

    item.addEventListener('click', () => {
      if (useHls && hlsInstance) {
        hlsInstance.subtitleTrack = idx;
      } else {
        const vt = Array.from(videoEl.textTracks || []);
        vt.forEach((track, i) => {
          if (track.kind === 'subtitles' || track.kind === 'captions') {
            track.mode = (i === idx ? 'showing' : 'disabled');
          }
        });
      }
      activeSubtitleIndex = idx;
      buildSubtitleTrackMenu();
      closeAllTrackMenus();
    });

    subtitleTrackMenu.appendChild(item);
  });
}

function updateTrackControlsVisibility() {
  if (!npTracks) return;

  if (!isMovieContext()) {
    npTracks.classList.add('hidden');
    return;
  }

  npTracks.classList.remove('hidden');
  audioGroup?.classList.remove('hidden');
  subtitleGroup?.classList.remove('hidden');
}

function refreshTrackMenus() {
  // Track menus are only shown for "Channel/Live" context in this project
  if (!isMovieContext()) {
    audioTrackMenu.innerHTML = '';
    subtitleTrackMenu.innerHTML = '';
    activeAudioIndex = -1;
    activeSubtitleIndex = -1;
    closeAllTrackMenus();
    updateTrackControlsVisibility();
    return;
  }

  buildAudioTrackMenu();
  buildSubtitleTrackMenu();
  updateTrackControlsVisibility();
}


// =====================================================
// PLAYER LOGIC
// =====================================================
function destroyHls() {
  if (hlsInstance) {
    try { hlsInstance.destroy(); } catch {}
    hlsInstance = null;
  }

  // Important : ne pas masquer #npTracks ici.
  // Sinon, à chaque changement de chaîne (Next/Prev), le bloc disparaît puis réapparaît
  // quand le manifest est prêt → effet de "saut" des boutons Audio / Sous-titres.
  closeAllTrackMenus();
  activeAudioIndex = -1;
  activeSubtitleIndex = -1;
  updateTrackControlsVisibility();
}


function destroyDash() {
  if (dashInstance) {
    try { dashInstance.reset(); } catch {}
    dashInstance = null;
  }
}

function showVideo() {
  overlayMode = false;
  iframeOverlay?.classList.add('hidden');
  if (iframeEl) iframeEl.src = 'about:blank';
  if (videoEl) videoEl.style.visibility = 'visible';
}

function showIframe() {
  overlayMode = true;
  // En overlay iFrame, on coupe le mode OFFLINE + les retentatives
  leaveOfflineMode();
  iframeOverlay?.classList.remove('hidden');
  try { videoEl?.pause(); } catch {}
  if (videoEl) videoEl.style.visibility = 'hidden';
}

function playEntryAsOverlay(entry) {
  if (!entry || !entry.url) return;

  currentEntry = entry;
  activePlaybackMode = 'iframe';

  updateNowPlayingCounter();

  let url = entry.url;

  // HLS/DASH brut → lecteur externe
  if (isProbablyHls(url) || isProbablyDash(url)) {
    fallbackToExternalPlayer(entry);
    refreshActiveListsUI();
    if (favoriteListEl?.classList.contains('active')) renderFavoritesList();
    return;
  }

  showIframe();

  if (isYoutubeUrl(url)) {
    url = youtubeToEmbed(url);

    // Prefer the nocookie embed domain (same content, often behaves better in iframes)
    try { url = url.replace('https://www.youtube.com/embed/', 'https://www.youtube-nocookie.com/embed/'); } catch {}

    // Mobile-friendly: stay inline + autoplay muted
    const extra = 'autoplay=1&mute=1&playsinline=1&rel=0&modestbranding=1';
    url += (url.includes('?') ? '&' : '?') + extra;

    // Some embed contexts behave better with an explicit origin
    try {
      if (!/([?&])origin=/.test(url)) url += '&origin=' + encodeURIComponent(window.location.origin);
    } catch {}
  }

  if (iframeEl) iframeEl.src = url;
  updateNowPlaying(entry, 'IFRAME');
  setStatus('Overlay iFrame actif');

  refreshTrackMenus();
}

function fallbackToExternalPlayer(entry) {
  if (!entry || !entry.url) return;

  showIframe();

  currentEntry = entry;
  updateNowPlayingCounter();

  const base = 'https://vsalema.github.io/play/?';
  if (iframeEl) iframeEl.src = base + encodeURIComponent(entry.url);

  updateNowPlaying(entry, 'EXT-PLAYER');
  setStatus('Lecture via lecteur externe');
}

function playUrl(entry) {
  if (!entry || !entry.url || !videoEl) return;

  // stop radio (Luna) si elle est active
if (typeof radioPlaying !== 'undefined' && radioPlaying) {
  stopLunaOverlayHard();
}

currentEntry = entry;
  // Met à jour la zone helper-text (qualité du film) dès la sélection
  try { __updateHelperTextForEntry(entry); } catch {}
  // Met à jour tout de suite l'affichage des contrôles pistes (évite tout clignotement)
  updateTrackControlsVisibility();
  updateNowPlayingCounter();
  activePlaybackMode = 'stream';
  externalFallbackTried = false;
  // Si on était en mode OFFLINE, on repasse en lecture normale
  leaveOfflineMode();
  // Lance un watchdog anti-freeze (flux mort / buffering infini)
  startStallWatchdog();
  markProgress();

  const url = entry.url;

  // RTP / SMIL => lecteur externe
  if (/rtp\.pt/i.test(url) || /smil:/i.test(url)) {
    fallbackToExternalPlayer(entry);
    refreshActiveListsUI();
    if (favoriteListEl?.classList.contains('active')) renderFavoritesList();
    return;
  }

  // Entrées iframe/youtube
  if (entry.isIframe || isYoutubeUrl(url)) {
    playEntryAsOverlay(entry);
    refreshActiveListsUI();
    if (favoriteListEl?.classList.contains('active')) renderFavoritesList();
    return;
  }

  // Lecture vidéo
  showVideo();
  destroyHls();
  destroyDash();

  videoEl.removeAttribute('src');
  videoEl.load();

  let modeLabel = 'VIDEO';

  if (isProbablyDash(url) && window.dashjs) {
    try {
      dashInstance = dashjs.MediaPlayer().create();
      dashInstance.initialize(videoEl, url, true);
      // Keep track menus in sync with DASH manifests and track changes
if (typeof dashjs !== 'undefined' && dashjs.MediaPlayer && dashjs.MediaPlayer.events) {
  const ev = dashjs.MediaPlayer.events;
  dashInstance.on(ev.STREAM_INITIALIZED, refreshTrackMenus);
  dashInstance.on(ev.TRACKS_ADDED, refreshTrackMenus);
  if (ev.TRACK_CHANGE_RENDERED) dashInstance.on(ev.TRACK_CHANGE_RENDERED, refreshTrackMenus);
}
modeLabel = 'DASH';
      dashInstance.on(dashjs.MediaPlayer.events.ERROR, e => {
        console.error('DASH error:', e);
        if (currentEntry && !offlineMode) {
          enterOfflineMode('DASH error');
        } else {
          setStatus('Erreur DASH');
        }
      });
    } catch (e) {
      console.error('DASH init error:', e);
      modeLabel = 'VIDEO';
      videoEl.src = url;
    }
  } else if (isProbablyHls(url) && window.Hls && Hls.isSupported()) {
    hlsInstance = new Hls();
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(videoEl);
    modeLabel = 'HLS';

    hlsInstance.on(Hls.Events.MANIFEST_PARSED, refreshTrackMenus);
    hlsInstance.on(Hls.Events.AUDIO_TRACKS_UPDATED, refreshTrackMenus);
    hlsInstance.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, refreshTrackMenus);
    hlsInstance.on(Hls.Events.AUDIO_TRACK_SWITCHED, refreshTrackMenus);
    hlsInstance.on(Hls.Events.SUBTITLE_TRACK_SWITCH, refreshTrackMenus);

    hlsInstance.on(Hls.Events.ERROR, (event, data) => {
      console.error('HLS error:', data);

      // Fatal = manifest introuvable / flux down / erreur média irréparable
      if (data && data.fatal && currentEntry && !offlineMode) {
        enterOfflineMode('HLS fatal');
      }
    });
  } else {
    videoEl.src = url;
    modeLabel = url.match(/\.(mp3|aac|ogg)(\?|$)/i) ? 'AUDIO' : 'VIDEO';
  }

  // ✅ reprise position basée sur l’entrée (pas sur l’onglet)
  videoEl.onloadedmetadata = () => {
    try {
      if (entry.listType !== 'channels') return;

      const key = entry.url;
      const savedPos = resumePositions[key];

      if (
        typeof savedPos === 'number' &&
        savedPos > 10 &&
        isFinite(videoEl.duration) &&
        savedPos < videoEl.duration - 5
      ) {
        videoEl.currentTime = savedPos;
      }


    } catch (e) {
      console.warn('Erreur reprise position', e);
    }
    refreshTrackMenus();
  };

  videoEl.play().catch(() => {});

  updateNowPlaying(entry, modeLabel);
  setStatus('Lecture en cours');

  // Chromecast: si une session est connectée, on tente d’envoyer le nouveau flux
  try {
    if (typeof CAST !== 'undefined' && CAST.isConnected) {
      castLoadCurrentEntry(true);
    }
  } catch {}

  refreshActiveListsUI();
  if (favoriteListEl?.classList.contains('active')) renderFavoritesList();
}

// =====================================================
// PLAYERS FOR EACH LIST + SCROLL AUTO
// =====================================================
function playChannel(index) {
  if (index < 0 || index >= channels.length) return;
  currentListType = 'channels';
  currentIndex = index;
  const entry = channels[index];
  playUrl(entry);
  renderChannelList();
  if (favoriteListEl?.classList.contains('active')) renderFavoritesList();
  scrollToActiveItem();
}

function playFrChannel(index) {
  if (index < 0 || index >= frChannels.length) return;
  currentListType = 'fr';
  currentFrIndex = index;
  const entry = frChannels[index];
  playUrl(entry);
  renderChannelFrList();
  if (favoriteListEl?.classList.contains('active')) renderFavoritesList();
  scrollToActiveItem();
}

function playIframe(index) {
  if (index < 0 || index >= iframeItems.length) return;
  currentListType = 'iframe';
  currentIframeIndex = index;
  const entry = iframeItems[index];
  playUrl(entry);
  renderIframeList();
  if (favoriteListEl?.classList.contains('active')) renderFavoritesList();
  scrollToActiveItem();
}

// =====================================================
// NEXT / PREV (avec support FAVORITES)
// =====================================================
function playNext() {
  if (currentListType === 'favorites') {
    if (!favoritesView.length) return;

    if (currentFavPos === -1) currentFavPos = 0;
    else currentFavPos = (currentFavPos + 1) % favoritesView.length;

    const item = favoritesView[currentFavPos];
    if (!item) return;

    playUrl(item.entry);
    renderFavoritesList();
    scrollToActiveItem();
    return;
  }

  if (currentListType === 'fr') {
    if (!frChannels.length) return;
    if (currentFrIndex === -1) playFrChannel(0);
    else playFrChannel((currentFrIndex + 1) % frChannels.length);
  } else if (currentListType === 'iframe') {
    if (!iframeItems.length) return;
    if (currentIframeIndex === -1) playIframe(0);
    else playIframe((currentIframeIndex + 1) % iframeItems.length);
  } else {
    if (!channels.length) return;
    if (currentIndex === -1) playChannel(0);
    else playChannel((currentIndex + 1) % channels.length);
  }
}

function playPrev() {
  if (currentListType === 'favorites') {
    if (!favoritesView.length) return;

    if (currentFavPos === -1) currentFavPos = favoritesView.length - 1;
    else currentFavPos = (currentFavPos - 1 + favoritesView.length) % favoritesView.length;

    const item = favoritesView[currentFavPos];
    if (!item) return;

    playUrl(item.entry);
    renderFavoritesList();
    scrollToActiveItem();
    return;
  }

  if (currentListType === 'fr') {
    if (!frChannels.length) return;
    if (currentFrIndex === -1) playFrChannel(frChannels.length - 1);
    else playFrChannel((currentFrIndex - 1 + frChannels.length) % frChannels.length);
  } else if (currentListType === 'iframe') {
    if (!iframeItems.length) return;
    if (currentIframeIndex === -1) playIframe(iframeItems.length - 1);
    else playIframe((currentIframeIndex - 1 + iframeItems.length) % iframeItems.length);
  } else {
    if (!channels.length) return;
    if (currentIndex === -1) playChannel(channels.length - 1);
    else playChannel((currentIndex - 1 + channels.length) % channels.length);
  }
}

// --- SCROLL AUTO SUR LA LISTE ACTIVE ---
function scrollToActiveItem() {
  let listEl = null;
  if (currentListType === 'channels') listEl = channelListEl;
  else if (currentListType === 'fr') listEl = channelFrListEl;
  else if (currentListType === 'iframe') listEl = iframeListEl;
  else if (currentListType === 'favorites') listEl = favoriteListEl;
  else return;

  if (!listEl) return;

  const activeItem = listEl.querySelector('.channel-item.active');
  if (!activeItem) return;

  const listRect = listEl.getBoundingClientRect();
  const itemRect = activeItem.getBoundingClientRect();

  const delta = (itemRect.top - listRect.top) - (listRect.height / 2 - itemRect.height / 2);
  listEl.scrollTop += delta;
}

// =====================================================
// M3U PARSER
// =====================================================
function parseM3U(content, listType = 'channels', defaultGroup = 'Playlist') {
  const lines = content.split(/\r?\n/);
  const results = [];
  let lastInf = null;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#EXTM3U')) continue;

    if (line.startsWith('#EXTINF')) {
      lastInf = line;
      continue;
    }

    if (line.startsWith('#')) continue;

    const url = line;
    let name = 'Sans titre';
    let logo = null;
    let group = defaultGroup;
    let tvgId = '';


    if (lastInf) {
      const nameMatch = lastInf.split(',').slice(-1)[0].trim();
      if (nameMatch) name = nameMatch;

      const logoMatch = lastInf.match(/tvg-logo="([^"]+)"/i);
      if (logoMatch) logo = { type: 'image', value: logoMatch[1] };

      const groupMatch = lastInf.match(/group-title="([^"]+)"/i);
      if (groupMatch) group = groupMatch[1];

      const tvgIdMatch = lastInf.match(/tvg-id="([^"]+)"/i);
      if (tvgIdMatch) tvgId = String(tvgIdMatch[1]).trim();
    }

    results.push({
      id: `${listType}-ch-${nextUid()}`,
      tvgId,
      name,
      url,
      logo: normalizeLogo(logo, name),
      group,
      isIframe: isYoutubeUrl(url),
      isFavorite: false,
      listType
    });

    lastInf = null;
  }

  return results;
}

// =====================================================
// LOADERS
// =====================================================
async function loadFromUrl(url, opts = {}) {
  const {
    silent = false,
    append = true,      // append into channels[]
    autoplay = true,    // auto-play first item only for manual load
    cacheBust = false   // add ?_=
  } = opts;

  if (!url) return;

  const finalUrl = cacheBust ? (url + (url.includes('?') ? '&' : '?') + '_=' + Date.now()) : url;

  if (!silent) setStatus('Chargement…');

  try {
    if (isProbablyPlaylist(finalUrl)) {
      const res = await fetch(finalUrl, { cache: 'no-store' });
      const text = await res.text();

      if (text.trim().startsWith('#EXTM3U')) {
        const parsed = parseM3U(text, 'channels', 'Playlist');

        if (!append) channels.splice(0, channels.length);
        channels.push(...parsed);

        renderLists();

        if (autoplay && parsed.length && currentIndex === -1) {
          playChannel(channels.length - parsed.length);
        }

        if (!silent) setStatus('Playlist chargée (' + parsed.length + ' entrées)');
      } else {
        const entry = {
          id: `single-url-${nextUid()}`,
          name: finalUrl,
          url: finalUrl,
          logo: deriveLogoFromName('S'),
          group: 'Single URL',
          isIframe: isYoutubeUrl(finalUrl),
          isFavorite: false,
          listType: 'channels'
        };
        if (!append) channels.splice(0, channels.length);
        channels.push(entry);
        renderLists();
        if (autoplay) playChannel(channels.length - 1);
        if (!silent) setStatus('Flux chargé');
      }
    } else {
      const entry = {
        id: `single-url-${nextUid()}`,
        name: finalUrl,
        url: finalUrl,
        logo: deriveLogoFromName('S'),
        group: 'Single URL',
        isIframe: isYoutubeUrl(finalUrl),
        isFavorite: false,
        listType: 'channels'
      };
      if (!append) channels.splice(0, channels.length);
      channels.push(entry);
      renderLists();
      if (autoplay) playChannel(channels.length - 1);
      if (!silent) setStatus('Flux chargé');
    }
  } catch (e) {
    console.error(e);
    if (!silent) {
      setStatus('Erreur de chargement (CORS / réseau)');
      alert(`Impossible de charger cette URL dans le navigateur.
Ça peut venir d’un blocage CORS ou d’un problème réseau.
Si c’est un flux IPTV, il est peut-être prévu pour une app native (VLC, box, etc.), pas pour le web.`);
    }
  }
}

async function loadFrM3u(url, opts = {}) {
  const {
    silent = false,
    append = true,
    cacheBust = false
  } = opts;

  if (!url) return;

  const finalUrl = cacheBust ? (url + (url.includes('?') ? '&' : '?') + '_=' + Date.now()) : url;

  try {
    const res = await fetch(finalUrl, { cache: 'no-store' });
    const text = await res.text();

    if (!text.trim().startsWith('#EXTM3U')) {
      console.error('Fichier FR non valide');
      return;
    }

    const parsed = parseM3U(text, 'fr', 'FR');

    if (!append) frChannels.splice(0, frChannels.length);
    frChannels.push(...parsed);

    renderLists();
    if (!silent) setStatus('Chaînes FR chargées : ' + parsed.length);
  } catch (e) {
    console.error('Erreur M3U FR', e);
    if (!silent) setStatus('Erreur M3U FR');
  }
}
function loadFromFile(file) {
  if (!file) return;
  if (fileNameLabel) fileNameLabel.textContent = file.name;
  setStatus('Lecture du fichier local…');

  const reader = new FileReader();

  if (/\.m3u8?$/i.test(file.name)) {
    reader.onload = () => {
      const text = String(reader.result || '');
      const parsed = parseM3U(text, 'channels', 'Playlist locale');
      channels.push(...parsed);
      renderLists();
      if (parsed.length && currentIndex === -1) {
        playChannel(channels.length - parsed.length);
      }
      setStatus('Playlist locale chargée (' + parsed.length + ' entrées)');
    };
    reader.readAsText(file);
  } else {
    const objectUrl = URL.createObjectURL(file);
    const entry = {
      id: `local-${nextUid()}`,
      name: file.name,
      url: objectUrl,
      logo: deriveLogoFromName(file.name),
      group: 'Local',
      isIframe: false,
      isFavorite: false,
      listType: 'channels'
    };
    channels.push(entry);
    renderLists();
    playChannel(channels.length - 1);
    setStatus('Fichier local prêt');
  }
}

function addIframeOverlay() {
  const title = iframeTitleInput?.value.trim() || 'Overlay iFrame';
  const url = iframeUrlInput?.value.trim();
  if (!url) return;

  const entry = {
    id: `iframe-${nextUid()}`,
    name: title,
    url,
    logo: deriveLogoFromName(title),
    group: 'Overlay',
    isIframe: true,
    isFavorite: false,
    listType: 'iframe'
  };

  iframeItems.push(entry);
  if (iframeTitleInput) iframeTitleInput.value = '';
  if (iframeUrlInput) iframeUrlInput.value = '';
  renderLists();
  playIframe(iframeItems.length - 1);
  showIframe();
  setStatus('Overlay ajouté');
}

// =====================================================
// JSON EXPORT / IMPORT
// =====================================================
function exportM3uToJson() {
  const payload = {
    type: 'm3u',
    version: 1,
    items: channels.map(ch => ({
      name: ch.name,
      url: ch.url,
      logo: ch.logo || deriveLogoFromName(ch.name),
      group: ch.group || '',
      isFavorite: !!ch.isFavorite,
      isIframe: !!ch.isIframe
    }))
  };
  if (jsonArea) jsonArea.value = JSON.stringify(payload, null, 2);
  setStatus('Export M3U → JSON prêt');
}

function exportIframeToJson() {
  const payload = {
    type: 'iframe',
    version: 1,
    items: iframeItems.map(it => ({
      name: it.name,
      url: it.url,
      logo: it.logo || deriveLogoFromName(it.name),
      group: it.group || 'Overlay',
      isFavorite: !!it.isFavorite
    }))
  };
  if (jsonArea) jsonArea.value = JSON.stringify(payload, null, 2);
  setStatus('Export iFrame → JSON prêt');
}

function importFromJson() {
  const text = (jsonArea?.value || '').trim();
  if (!text) {
    alert('Colle d’abord du JSON dans la zone prévue.');
    return;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    console.error(e);
    alert('JSON invalide : impossible de parser.');
    return;
  }

  if (!data || !Array.isArray(data.items)) {
    alert("Format JSON inattendu : il manque le tableau 'items'.");
    return;
  }

  const type = data.type || 'm3u';

  if (type === 'm3u') {
    data.items.forEach((item, idx) => {
      const name = item?.name || ('M3U ' + (channels.length + idx + 1));
      const url = item?.url;
      if (!url) return;

      channels.push({
        id: `json-${type}-${nextUid()}`,
        name,
        url,
        logo: normalizeLogo(item?.logo, name),
        group: item?.group || 'Playlist JSON',
        isIframe: !!item?.isIframe || isYoutubeUrl(url),
        isFavorite: !!item?.isFavorite,
        listType: 'channels'
      });
    });

    renderLists();
    setStatus('Import JSON M3U terminé (' + data.items.length + ' entrées)');
  } else if (type === 'iframe') {
    data.items.forEach((item, idx) => {
      const name = item?.name || ('Overlay ' + (iframeItems.length + idx + 1));
      const url = item?.url;
      if (!url) return;

      iframeItems.push({
        id: `json-${type}-${nextUid()}`,
        name,
        url,
        logo: normalizeLogo(item?.logo, name),
        group: item?.group || 'Overlay JSON',
        isIframe: true,
        isFavorite: !!item?.isFavorite,
        listType: 'iframe'
      });
    });

    renderLists();
    setStatus('Import JSON iFrame terminé (' + data.items.length + ' entrées)');
  } else {
    alert("Type JSON inconnu : '" + type + "'. Utilise 'm3u' ou 'iframe'.");
  }
}

// =====================================================
// EVENTS
// =====================================================


function autoplayFirstInList(listType) {
  // Ne pas interrompre la mini-radio si elle est en lecture
  if (typeof radioPlaying !== 'undefined' && radioPlaying) return;

  if (listType === 'favorites') {
    renderFavoritesList();
    if (!favoritesView.length) return;

    currentListType = 'favorites';
    currentFavPos = 0;

    const item = favoritesView[0];
    if (!item) return;

    playUrl(item.entry);
    renderFavoritesList();
    scrollToActiveItem();
    return;
  }

  if (listType === 'fr') {
    if (!frChannels.length) return;
    playFrChannel(0);
    return;
  }

  if (listType === 'iframe') {
    if (!iframeItems.length) return;
    playIframe(0);
    return;
  }

  // channels
  if (!channels.length) return;
  playChannel(0);
}


// Onglets
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const prevTab = document.querySelector('.tab-btn.active')?.dataset?.tab || '';

    // ✅ Même action que le bouton "⤺ Retour diffusion" du Radio Overlay
    // (radioOverlayBackBtn) : stop radio + restore playback.
    // Important : on évite l'autoplay automatique sur ce clic, sinon on écrase
    // le flux restauré par la 1ère chaîne de l'onglet.
    const radioOverlayOpen = !!radioOverlayLayer && radioOverlayLayer.style.display !== 'none';
    const skipAutoplay = (radioOverlayOpen || radioPlaying);
    if (skipAutoplay) {
      stopRadioAndRestore();
    }
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const tab = btn.dataset.tab;
    document.querySelectorAll('.list').forEach(l => l.classList.remove('active'));

    if (tab === 'channels') { currentListType = 'channels'; channelListEl?.classList.add('active'); }
    if (tab === 'fr') { currentListType = 'fr'; channelFrListEl?.classList.add('active'); }
    if (tab === 'iframes') { currentListType = 'iframe'; iframeListEl?.classList.add('active'); }
    if (tab === 'favorites') {
      currentListType = 'favorites';
      favoriteListEl?.classList.add('active');
      renderFavoritesList();
    }

    // Auto-diffuse la première chaîne quand on change de liste
    if (!skipAutoplay && tab && tab !== prevTab) {
      autoplayFirstInList(currentListType);
    }

        // 🆕 Derniers ajouts : bouton uniquement sur Films + refresh JSON quand on ouvre l'onglet
    if (btn.dataset.tab === 'channels') {
      fetchNewAdditionsIds().then(updateNewAdditionsButtonVisibility);
    } else {
      updateNewAdditionsButtonVisibility();
    }

scrollToActiveItem();
    updateNowPlayingCounter();
    updateTrackControlsVisibility();
  });
});

// Recherche globale + clear
if (globalSearchInput) {
  const wrapper = globalSearchInput.closest('.search-wrapper');
  const syncWrapper = () => {
    if (!wrapper) return;
    wrapper.classList.toggle('has-text', globalSearchInput.value.length > 0);
  };

  syncWrapper();
  globalSearchInput.addEventListener('input', () => {
    currentSearch = globalSearchInput.value.trim().toLowerCase();
    syncWrapper();

    // Debounce: avoid re-rendering everything on each keystroke
    if (globalSearchInput.__tronTimer) clearTimeout(globalSearchInput.__tronTimer);
    globalSearchInput.__tronTimer = setTimeout(() => {
      refreshActiveListsUI();
      scrollToActiveItem();
    }, 120);
  });
}

if (clearSearchBtn && globalSearchInput) {
  clearSearchBtn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    currentSearch = '';
    globalSearchInput.value = '';
    const wrapper = globalSearchInput.closest('.search-wrapper');
    if (wrapper) wrapper.classList.remove('has-text');
    refreshActiveListsUI();
    scrollToActiveItem();
  });
}
// Vérifier liens (liste active)
if (verifyLinksBtn) {
  verifyLinksBtn.addEventListener('click', async () => {
    const listEl = document.querySelector('.list.active');
    if (!listEl) return;

    const itemEls = Array.from(listEl.querySelectorAll('.channel-item'));
    if (itemEls.length === 0) return;

    // dédupe (si un même flux apparaît plusieurs fois)
    const unique = new Map(); // key -> entry
    itemEls.forEach((itemEl) => {
      const type = itemEl.dataset.type;
      const index = Number(itemEl.dataset.index);
      let entry = null;
      if (type === 'channels') entry = channels[index];
      else if (type === 'fr') entry = frChannels[index];
      else if (type === 'iframe') entry = iframeItems[index];

      const key = itemEl.dataset.linkkey || linkKeyForEntry(entry);
      if (entry && key && !unique.has(key)) unique.set(key, entry);
    });

    const total = unique.size;
    if (!total) return;

    const originalLabel = verifyLinksBtn.textContent;
    verifyLinksBtn.disabled = true;
    let done = 0;
    verifyLinksBtn.textContent = `Vérif… ${done}/${total}`;

    const tasks = Array.from(unique.entries()).map(([key, entry]) => async () => {
      setLinkStatus(key, 'pending', 'Vérification…');
      const r = await checkEntryLink(entry);
      setLinkStatus(key, r.ok ? 'ok' : 'ko', r.info || '');
      return r;
    });

    await runWithConcurrency(tasks, 5, () => {
      done += 1;
      verifyLinksBtn.textContent = `Vérif… ${done}/${total}`;
    });

    verifyLinksBtn.textContent = originalLabel;
    verifyLinksBtn.disabled = false;
  });
}



// Sections repliables
document.querySelectorAll('.loader-section .collapsible-label').forEach(label => {
  label.addEventListener('click', () => {
    const section = label.closest('.loader-section');
    section?.classList.toggle('open');
  });
});

// Sidebar
toggleSidebarBtn?.addEventListener('click', () => {
  const isCollapsed = sidebar?.classList.toggle('collapsed');
  toggleSidebarBtn.classList.toggle('active', !isCollapsed);
});
if (window.innerWidth <= 900) sidebar?.classList.add('collapsed');

// URL loader
loadUrlBtn?.addEventListener('click', () => loadFromUrl(urlInput?.value.trim()));
urlInput?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') loadFromUrl(urlInput.value.trim());
});

// File loader
openFileBtn?.addEventListener('click', () => fileInput?.click());
fileInput?.addEventListener('change', () => {
  if (fileInput.files && fileInput.files[0]) loadFromFile(fileInput.files[0]);
});

// Iframe overlay add
addIframeBtn?.addEventListener('click', () => addIframeOverlay());
iframeUrlInput?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') addIframeOverlay();
});

// Toggle overlay mode (chip STREAM/IFRAME)
toggleOverlayBtn?.addEventListener('click', () => {
  if (!currentEntry) {
    setStatus('Aucune entrée active');
    return;
  }

  if (overlayMode) {
    if (currentEntry.isIframe || isYoutubeUrl(currentEntry.url)) {
      setStatus('Cette entrée est un overlay (pas de mode vidéo)');
      return;
    }

    activePlaybackMode = 'stream';
    playUrl(currentEntry);
    refreshActiveListsUI();
    setStatus('Mode vidéo');
    return;
  }

  activePlaybackMode = 'iframe';
  playEntryAsOverlay(currentEntry);
  refreshActiveListsUI();
  setStatus('Mode iFrame');
});

// Fullscreen
fullPageBtn?.addEventListener('click', () => {
  const elem = appShell;
  if (!document.fullscreenElement) elem?.requestFullscreen?.();
  else document.exitFullscreen?.();
});

// Next / Prev
nextBtn?.addEventListener('click', playNext);
prevBtn?.addEventListener('click', playPrev);

// FX
fxToggleBtn?.addEventListener('click', () => {
  const active = appShell?.classList.toggle('fx-boost');
  playerContainer?.classList.toggle('fx-boost-edges', !!active);
  fxToggleBtn.classList.toggle('btn-accent', !!active);
});

// PiP
pipToggleBtn?.addEventListener('click', () => {
  const active = playerContainer?.classList.toggle('pip-mode');
  pipToggleBtn.classList.toggle('btn-accent', !!active);
});

// Stream URL panel
openStreamUrlBtn?.addEventListener('click', (ev) => {
  ev.preventDefault();
  ev.stopPropagation();
  openStreamUrlPanel(true);
});

streamUrlCloseBtn?.addEventListener('click', (ev) => {
  ev.preventDefault();
  closeStreamUrlPanel();
});

streamUrlOverlay?.addEventListener('click', (ev) => {
  if (ev.target === streamUrlOverlay) closeStreamUrlPanel();
});

document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && streamUrlOverlay && !streamUrlOverlay.classList.contains('hidden')) {
    closeStreamUrlPanel();
  }
});

streamUrlPlayBtn?.addEventListener('click', (ev) => {
  ev.preventDefault();
  const url = streamUrlInput?.value || '';
  const title = streamTitleInput?.value || '';
  closeStreamUrlPanel();
  playDirectStream(url, title, { updateUrl: true });
});

streamUrlCopyBtn?.addEventListener('click', async (ev) => {
  ev.preventDefault();
  const url = normalizeStreamUrl(streamUrlInput?.value || getQueryParams().get('streamUrl') || '');
  const title = (streamTitleInput?.value || getQueryParams().get('title') || '').trim();
  if (!url) { setStatus('Rien à copier'); return; }
  const link = buildStreamShareLink(url, title);
  try {
    await navigator.clipboard.writeText(link);
    setStatus('Lien copié');
  } catch {
    try { window.prompt('Copie le lien :', link); } catch {}
  }
});

// Thème
let currentTheme = 'classic';
themeToggleBtn?.addEventListener('click', () => {
  if (currentTheme === 'classic') {
    document.body.classList.add('theme-redblue');
    currentTheme = 'redblue';
    themeToggleBtn.textContent = 'Thème : Rouge/Bleu';
    themeToggleBtn.classList.add('btn-accent');
    setStatus('Thème Rouge/Bleu actif');
  } else {
    document.body.classList.remove('theme-redblue');
    currentTheme = 'classic';
    themeToggleBtn.textContent = 'Thème : Cyan/Orange';
    themeToggleBtn.classList.remove('btn-accent');
    setStatus('Thème Cyan/Orange actif');
  }
});

// JSON export/import
exportM3uJsonBtn?.addEventListener('click', exportM3uToJson);
exportIframeJsonBtn?.addEventListener('click', exportIframeToJson);
importJsonBtn?.addEventListener('click', importFromJson);

// Video events
videoEl?.addEventListener('playing', () => { markProgress(); setStatus('Lecture en cours'); });
videoEl?.addEventListener('pause', () => setStatus('Pause'));
videoEl?.addEventListener('waiting', () => setStatus('Buffering…'));
videoEl?.addEventListener('error', () => {
  const mediaError = videoEl.error;

  // Si le MP4 OFFLINE lui-même échoue, on n'insiste pas en boucle
  if (offlineMode) {
    setStatus('OFFLINE — erreur MP4');
    if (npBadge) npBadge.textContent = 'OFFLINE';
    return;
  }

  // Si le flux principal tombe, on passe sur le MP4 OFFLINE
  if (!offlineMode && currentEntry && !currentEntry.isIframe) {
    enterOfflineMode('Erreur de lecture');
    return;
  }


  let msg = 'Erreur vidéo';
  if (mediaError) {
    switch (mediaError.code) {
      case mediaError.MEDIA_ERR_NETWORK: msg = 'Erreur réseau ou CORS possible'; break;
      case mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED: msg = 'Format non supporté ou URL invalide'; break;
      default: msg = 'Erreur de lecture (code ' + mediaError.code + ')';
    }
  }
  setStatus(msg);
  if (npBadge) npBadge.textContent = 'ERREUR';
  console.error('Video error', mediaError);
});

// ✅ Sauvegarde reprise : basée sur l’entrée réellement en lecture
videoEl?.addEventListener('timeupdate', () => {
  markProgress();
  if (offlineMode) return;
if (!currentEntry) return;
  if (currentEntry.listType !== 'channels') return;

  const key = currentEntry.url;

  if (!videoEl.duration || !isFinite(videoEl.duration) || videoEl.duration < 60) return;

  const t = videoEl.currentTime;
  if (t < 10) return;

  if (videoEl.duration - t < 20) {
    delete resumePositions[key];
    __scheduleResumeSave(true);
    return;
  }

  resumePositions[key] = t;
  __scheduleResumeSave(false);
});


// Flush resume on user actions (prevents losing progress on abrupt close)
videoEl?.addEventListener('pause', () => __persistResumeNow());
videoEl?.addEventListener('ended', () => __persistResumeNow());
// Track menus
audioTrackBtn?.addEventListener('click', (ev) => {
  ev.stopPropagation();
  if (!isMovieContext()) return;
  buildAudioTrackMenu();
  const isOpen = audioTrackMenu?.classList.toggle('open');
  if (isOpen) subtitleTrackMenu?.classList.remove('open');
});

subtitleTrackBtn?.addEventListener('click', (ev) => {
  ev.stopPropagation();
  if (!isMovieContext()) return;
  buildSubtitleTrackMenu();
  const isOpen = subtitleTrackMenu?.classList.toggle('open');
  if (isOpen) audioTrackMenu?.classList.remove('open');
});

document.addEventListener('click', () => closeAllTrackMenus());

// =====================================================
// DEMO DE BASE + OVERLAYS CUSTOM
// =====================================================
(function seedDemo() {
  const customOverlays = [
    { title: "CMTV", logo: "https://vsalema.github.io/StreamPilot-X-Studio-S/logos/cmtv.png", url: "//popcdn.day/player.php?stream=CMTVPT" },
    { title: "TVI",  logo: "https://vsalema.github.io/StreamPilot-X-Studio-S/logos/TVI.png", url: "https://vsalema.github.io/tvi2/" },
    { title: "TVIR", logo: "https://vsalema.github.io/StreamPilot-X-Studio-S/logos/tvir.jpg", url: "https://vsalema.github.io/tvi-reality/" },
    { title: "TVIF", logo: "https://vsalema.github.io/StreamPilot-X-Studio-O/logos/tvif.png", url: "https://vsalema.github.io/tvi-ficcao/" },
    { title: "TVIA", logo: "https://vsalema.github.io/StreamPilot-X-Studio-S/logos/tvia.png", url: "https://vsalema.github.io/tvi-africa/" },
    { title: "SIC",  logo: "https://vsalema.github.io/StreamPilot-X-Studio-S/logos/sic.jpg", url: "https://vsalema.github.io/sic/" },
    { title: "CNN",  logo: "https://vsalema.github.io/StreamPilot-X-Studio-S/logos/cnn.png", url: "https://vsalema.github.io/CNN/" },
    { title: "RTP1", logo: "https://vsalema.github.io/StreamPilot-X-Studio-S/logos/rtp1.jpg", url: "https://vsalema.github.io/play/?https://streaming-live.rtp.pt/liverepeater/smil:rtp1HD.smil/playlist.m3u8" },
    { title: "RTPN", logo: "https://vsalema.github.io/StreamPilot-X-Studio-S/logos/rtpn.png", url: "https://vsalema.github.io/play/?https://streaming-live.rtp.pt/livetvhlsDVR/rtpnHDdvr.smil/playlist.m3u8?DVR" },
    { title: "RTPI", logo: "https://vsalema.github.io/StreamPilot-X-Studio-S/logos/rtpi.jpg", url: "https://vsalema.github.io/play/?https://streaming-live.rtp.pt/liverepeater/rtpi.smil/playlist.m3u8" },
    { title: "BTV", logo: "https://vsalema.github.io/StreamPilot-X-Studio-S/logos/btv.svg", url: "//popcdn.day/go.php?stream=BTV1" },
    { title: "SCP", logo: "https://pplware.sapo.pt/wp-content/uploads/2017/06/scp_00.jpg", url: "//popcdn.day/go.php?stream=SPT1" },
    { title: "11",  logo: "https://www.zupimages.net/up/24/13/qj99.jpg", url: "https://popcdn.day/go.php?stream=Canal11" },
    { title: "BOLA", logo: "https://www.telesatellite.com/images/actu/a/abolatv.jpg", url: "//popcdn.day/go.php?stream=ABOLA" },
    { title: "Sport tv 1", logo: "https://cdn.brandfetch.io/idKvjRibkN/w/400/h/400/theme/dark/icon.jpeg?c=1dxbfHSJFAPEGdCLU4o5B", url: "//popcdn.day/go.php?stream=SPT1" },
    { title: "Sport tv 2", logo: "https://cdn.brandfetch.io/idKvjRibkN/w/400/h/400/theme/dark/icon.jpeg?c=1dxbfHSJFAPEGdCLU4o5B", url: "//popcdn.day/go.php?stream=SPT2" },
    { title: "Sport tv 3", logo: "https://cdn.brandfetch.io/idKvjRibkN/w/400/h/400/theme/dark/icon.jpeg?c=1dxbfHSJFAPEGdCLU4o5B", url: "//popcdn.day/go.php?stream=SPT3" },
    { title: "Sport tv 4", logo: "https://cdn.brandfetch.io/idKvjRibkN/w/400/h/400/theme/dark/icon.jpeg?c=1dxbfHSJFAPEGdCLU4o5B", url: "//popcdn.day/go.php?stream=SPT4" },
    { title: "Sport tv 5", logo: "https://cdn.brandfetch.io/idKvjRibkN/w/400/h/400/theme/dark/icon.jpeg?c=1dxbfHSJFAPEGdCLU4o5B", url: "//popcdn.day/go.php?stream=SPT5" },
    { title: "DAZN 1 PT",  logo: "https://upload.wikimedia.org/wikipedia/commons/7/71/DAZN_logo.svg", url: "//popcdn.day/go.php?stream=ELEVEN1" },
    { title: "DAZN 2 PT",  logo: "https://upload.wikimedia.org/wikipedia/commons/7/71/DAZN_logo.svg", url: "//popcdn.day/go.php?stream=ELEVEN2" },
    { title: "DAZN 3 PT",  logo: "https://upload.wikimedia.org/wikipedia/commons/7/71/DAZN_logo.svg", url: "//popcdn.day/go.php?stream=ELEVEN3" },
    { title: "DAZN 4 PT",  logo: "https://upload.wikimedia.org/wikipedia/commons/7/71/DAZN_logo.svg", url: "//popcdn.day/go.php?stream=ELEVEN4" },
    { title: "DAZN 5 PT",  logo: "https://upload.wikimedia.org/wikipedia/commons/7/71/DAZN_logo.svg", url: "//popcdn.day/go.php?stream=ELEVEN5" }
  ];

  customOverlays.forEach((item) => {
    iframeItems.push({
      id: `custom-ov-${nextUid()}`,
      name: item.title,
      url: item.url,
      logo: { type: "image", value: item.logo },
      group: "Overlay",
      isIframe: true,
      isFavorite: false,
      listType: "iframe"
    });
  });

  renderLists();
  updateNowPlaying(null, 'IDLE');
})();


// =====================================================
// CHARGEMENT AUTOMATIQUE DES PLAYLISTS PRINCIPALES
// + Auto-refresh (mise à jour de la liste sans recharger la page)
// =====================================================

// URLs playlists (identiques à l'init)
const MAIN_PLAYLIST_URL = "https://vsalema.github.io/tvpt4/css/getFeed_grouped_tmdb_categories_v3.m3u";
const FR_PLAYLIST_URL   = "https://vsalema.github.io/tvpt4/css/playlist-tvf-r.m3u";

// ⏱️ Auto-refresh: change la valeur si tu veux (en ms)
// Exemple: 5 * 60 * 1000 = 5 minutes
const AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

let __autoRefreshTimer = null;
let __autoRefreshInFlight = false;

function __collectFavoriteUrls() {
  const set = new Set();
  for (const e of channels) if (e && e.isFavorite && e.url) set.add(e.url);
  for (const e of frChannels) if (e && e.isFavorite && e.url) set.add(e.url);
  for (const e of iframeItems) if (e && e.isFavorite && e.url) set.add(e.url);
  return set;
}

function __reapplyFavorites(urlSet) {
  if (!urlSet || !urlSet.size) return;
  const apply = (arr) => {
    for (const e of arr) {
      if (e && e.url && urlSet.has(e.url)) e.isFavorite = true;
    }
  };
  apply(channels);
  apply(frChannels);
  apply(iframeItems);
}

function __findIndexByUrl(arr, url) {
  if (!url) return -1;
  return arr.findIndex(e => e && e.url === url);
}

async function refreshPlaylistsSilently() {
  if (__autoRefreshInFlight) return;
  __autoRefreshInFlight = true;

  const playingUrl = currentEntry && currentEntry.url ? currentEntry.url : null;
  const playingListType = currentEntry && currentEntry.listType ? currentEntry.listType : currentListType;

  const favUrls = __collectFavoriteUrls();

  try {
    suspendRender = true;

    // Recharge proprement (sans autoplay)
    await Promise.all([
      loadFromUrl(MAIN_PLAYLIST_URL, { silent: true, append: false, autoplay: false, cacheBust: true }),
      loadFrM3u(FR_PLAYLIST_URL, { silent: true, append: false, cacheBust: true })
    ]);
  } catch (err) {
    console.warn('[Auto-refresh] échec', err);
  } finally {
    suspendRender = false;
  }

  flushPendingRender();

  // Réapplique les favoris + UI
  __reapplyFavorites(favUrls);
  try { refreshActiveListsUI(); } catch (_) {}
  try { renderFavoritesList(); } catch (_) {}

  // Restaure la sélection (sans relancer la lecture)
  if (playingUrl) {
    let found = null;

    const idxCh = __findIndexByUrl(channels, playingUrl);
    const idxFr = __findIndexByUrl(frChannels, playingUrl);
    const idxIf = __findIndexByUrl(iframeItems, playingUrl);

    if (playingListType === 'fr' && idxFr !== -1) {
      currentFrIndex = idxFr;
      currentIndex = -1; currentIframeIndex = -1;
      found = frChannels[idxFr];
    } else if (playingListType === 'iframe' && idxIf !== -1) {
      currentIframeIndex = idxIf;
      currentIndex = -1; currentFrIndex = -1;
      found = iframeItems[idxIf];
    } else if (idxCh !== -1) {
      currentIndex = idxCh;
      currentFrIndex = -1; currentIframeIndex = -1;
      found = channels[idxCh];
    } else if (idxFr !== -1) {
      currentFrIndex = idxFr;
      currentIndex = -1; currentIframeIndex = -1;
      found = frChannels[idxFr];
    } else if (idxIf !== -1) {
      currentIframeIndex = idxIf;
      currentIndex = -1; currentFrIndex = -1;
      found = iframeItems[idxIf];
    }

    if (found) {
      currentEntry = found;
      try { refreshActiveListsUI(); } catch (_) {}
      try { scrollToActiveItem(); } catch (_) {}
    }
  }

  __autoRefreshInFlight = false;
}

function startAutoPlaylistRefresh() {
  if (!AUTO_REFRESH_INTERVAL_MS || AUTO_REFRESH_INTERVAL_MS < 60_000) return;

  if (__autoRefreshTimer) {
    clearTimeout(__autoRefreshTimer);
    __autoRefreshTimer = null;
  }

  const tick = async () => {
    // Si l’onglet est en arrière-plan, on évite de spammer
    if (document.hidden) {
      __autoRefreshTimer = setTimeout(tick, 30_000);
      return;
    }

    await refreshPlaylistsSilently();
    __autoRefreshTimer = setTimeout(tick, AUTO_REFRESH_INTERVAL_MS);
  };

  __autoRefreshTimer = setTimeout(tick, AUTO_REFRESH_INTERVAL_MS);

  // Quand on revient sur l’onglet, on rafraîchit rapidement
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (__autoRefreshTimer) clearTimeout(__autoRefreshTimer);
      __autoRefreshTimer = setTimeout(tick, 1200);
    }
  }, { passive: true });
}

(async function loadMainPlaylists() {
  // Perf: fetch both playlists in parallel + render only once
  suspendRender = true;
  try {
    await Promise.all([
      loadFromUrl(MAIN_PLAYLIST_URL),
      loadFrM3u(FR_PLAYLIST_URL)
    ]);
  } finally {
    suspendRender = false;
  }
  flushPendingRender();

// ✅ Akamai-style: lecture directe via ?streamUrl=...
  const qs = getQueryParams();
  const directUrl = normalizeStreamUrl(qs.get('streamUrl'));
  if (directUrl) {
    const t = (qs.get('title') || '').trim();
    const muted = (qs.get('muted') === '1');
    const autoplayParam = qs.get('autoplay');
    const shouldAutoplay = (autoplayParam === null) ? true : (autoplayParam !== '0');

    if (muted && videoEl) {
      try { videoEl.muted = true; } catch {}
    }

    playDirectStream(directUrl, t, { updateUrl: false });

    if (!shouldAutoplay && videoEl) {
      try { videoEl.pause(); } catch {}
    }

    renderLists();
    updateNowPlaying(currentEntry, 'DIRECT');
    return;
  }


  if (frChannels.length > 0) {
    currentListType = 'fr';
    currentFrIndex = 0;

    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.remove('active');
      if (b.dataset.tab === 'fr') b.classList.add('active');
    });

    document.querySelectorAll('.list').forEach(l => l.classList.remove('active'));
    channelFrListEl?.classList.add('active');

    renderLists();
    playFrChannel(0);
  }
  startAutoPlaylistRefresh();
})();


// Init 🆕 Derniers ajouts
fetchNewAdditionsIds().then(updateNewAdditionsButtonVisibility);
