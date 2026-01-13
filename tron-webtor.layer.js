// Tron Ares IPTV Player — Webtor torrents addon (direct overlay layer)
// - Adds a dedicated "Torrents" tab + list
// - Renders Webtor directly in a new overlay layer (no nested iframe)
// - Keeps existing video + iframe overlays working

(() => {
  'use strict';

  const LS_KEY = 'tronAresWebtorTorrents.v2';

  const safeParse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
  const nextId = () => 'tw-' + Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);

  const isProbablyMagnetOrTorrentUrl = (s) => {
    const v = (s || '').trim();
    return v.startsWith('magnet:?') || v.endsWith('.torrent') || v.startsWith('http://') || v.startsWith('https://');
  };

  const loadItems = () => {
    const raw = localStorage.getItem(LS_KEY);
    const data = safeParse(raw, []);
    return Array.isArray(data) ? data : [];
  };

  const saveItems = (items) => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(items)); } catch {}
  };

  let torrentItems = loadItems();
  let currentTorrentIndex = -1;

  const tabsEl = document.querySelector('.tabs');
  const listsContainer = document.querySelector('.lists-container');
  const loaderPanel = document.querySelector('.loader-panel');
  const playerInner = document.querySelector('.player-inner');

  if (!tabsEl || !listsContainer || !loaderPanel || !playerInner) return;

  // Ensure Webtor SDK is queued
  window.webtor = window.webtor || [];

  // ---- Create Webtor overlay layer
  const ensureWebtorLayer = () => {
    let layer = document.getElementById('webtorOverlay');
    if (layer) return layer;

    layer = document.createElement('div');
    layer.className = 'webtor-overlay hidden';
    layer.id = 'webtorOverlay';

    const host = document.createElement('div');
    host.className = 'webtor-host';
    host.id = 'webtorHost';

    const status = document.createElement('div');
    status.className = 'webtor-status';
    status.id = 'webtorStatus';
    status.textContent = 'Webtor: prêt.';

    layer.appendChild(host);
    layer.appendChild(status);

    // Insert above iframe overlay for guaranteed visibility
    playerInner.appendChild(layer);
    return layer;
  };

  const setWebtorStatus = (msg) => {
    const el = document.getElementById('webtorStatus');
    if (el) el.textContent = String(msg || '');
  };

  const resetWebtorHost = () => {
    const host = document.getElementById('webtorHost');
    if (!host) return;
    host.innerHTML = '';

    const div = document.createElement('div');
    div.id = 'webtorPlayer';
    div.className = 'webtor';
    host.appendChild(div);
  };

  const hideWebtorLayer = () => {
    const layer = document.getElementById('webtorOverlay');
    if (layer) layer.classList.add('hidden');
  };

  const showWebtorLayer = () => {
    const layer = ensureWebtorLayer();
    layer.classList.remove('hidden');
  };

  // ---- Make sure other modes hide Webtor
  const wrap = (name, fn) => {
    try {
      const orig = window[name];
      if (typeof orig !== 'function') return;
      window[name] = fn(orig);
    } catch {}
  };

  // When base app switches to video/iframe, hide our layer
  wrap('showVideo', (orig) => function() {
    hideWebtorLayer();
    return orig();
  });

  wrap('showIframe', (orig) => function() {
    hideWebtorLayer();
    return orig();
  });

  wrap('playUrl', (orig) => function(entryOrUrl) {
    hideWebtorLayer();
    return orig(entryOrUrl);
  });

  wrap('playEntryAsOverlay', (orig) => function(entry) {
    // If it's a webtor entry, don't use iframe overlay; use our layer
    try {
      if (entry && entry.__webtor === true && entry.url) {
        playTorrentByEntry(entry);
        return;
      }
    } catch {}
    hideWebtorLayer();
    return orig(entry);
  });

  // ---- Create tab
  const torrentTabBtn = document.createElement('button');
  torrentTabBtn.className = 'tab-btn';
  torrentTabBtn.dataset.tab = 'torrents';
  torrentTabBtn.innerHTML = '<span>🧲</span>Torrents';

  const favBtn = tabsEl.querySelector('.tab-btn[data-tab="favorites"]');
  if (favBtn) tabsEl.insertBefore(torrentTabBtn, favBtn);
  else tabsEl.appendChild(torrentTabBtn);

  // ---- Create list
  const torrentListEl = document.createElement('div');
  torrentListEl.className = 'list';
  torrentListEl.id = 'torrentList';
  listsContainer.appendChild(torrentListEl);

  // ---- Loader UI
  const section = document.createElement('div');
  section.className = 'loader-section open';
  section.dataset.section = 'webtor';

  section.innerHTML = `
    <div class="loader-label collapsible-label">
      <span>Torrents (Webtor)</span>
      <span class="loader-toggle-icon">▸</span>
    </div>

    <div class="loader-section-body">
      <div class="loader-row">
        <input id="twTitleInput" class="input" placeholder="Titre (ex: Mon film…)" />
      </div>
      <div class="loader-row">
        <input id="twSrcInput" class="input" placeholder="magnet:?… ou URL .torrent" />
        <button class="btn btn-accent" id="twAddBtn">+ Ajouter</button>
      </div>
      <div class="loader-subrow" style="justify-content:flex-start;">
        <span style="opacity:.85;">Astuce: MP4 (H.264 + AAC) pour compatibilité.</span>
      </div>
    </div>
  `;

  loaderPanel.appendChild(section);

  const collLabel = section.querySelector('.collapsible-label');
  if (collLabel) collLabel.addEventListener('click', () => section.classList.toggle('open'));

  const titleInput = section.querySelector('#twTitleInput');
  const srcInput = section.querySelector('#twSrcInput');
  const addBtn = section.querySelector('#twAddBtn');

  // ---- Rendering
  const matchesSearchLocal = (entry) => {
    try {
      if (typeof currentSearch === 'string' && currentSearch.trim()) {
        const q = currentSearch.trim().toLowerCase();
        const hay = (String(entry.name || '') + ' ' + String(entry.url || '')).toLowerCase();
        return hay.includes(q);
      }
    } catch {}
    return true;
  };

  const activateList = () => {
    document.querySelectorAll('.list').forEach(l => l.classList.remove('active'));
    torrentListEl.classList.add('active');
  };

  const deriveLogoSafe = (name) => {
    try {
      if (typeof deriveLogoFromName === 'function') return deriveLogoFromName(name);
    } catch {}
    return { type: 'text', value: (String(name || '?').trim().slice(0, 1) || '?').toUpperCase() };
  };

  const renderTorrentList = () => {
    torrentListEl.innerHTML = '';

    const visible = torrentItems.filter(matchesSearchLocal);
    if (!visible.length) {
      const empty = document.createElement('div');
      empty.className = 'torrent-empty';
      empty.textContent = torrentItems.length ? 'Aucun résultat.' : 'Aucun torrent ajouté.';
      torrentListEl.appendChild(empty);
      return;
    }

    visible.forEach((it) => {
      const realIndex = torrentItems.findIndex(x => x && x.id === it.id);
      const li = document.createElement('div');
      li.className = 'channel-item';
      li.dataset.index = String(realIndex);
      li.dataset.type = 'torrents';

      try {
        if (typeof currentEntry !== 'undefined' && currentEntry && currentEntry.id === it.id) li.classList.add('active');
      } catch {}

      const logoDiv = document.createElement('div');
      logoDiv.className = 'channel-logo';
      const logo = it.logo || deriveLogoSafe(it.name);
      if (logo.type === 'image') {
        const img = document.createElement('img');
        img.src = logo.value;
        img.alt = it.name || '';
        try { img.loading = 'lazy'; } catch {}
        try { img.decoding = 'async'; } catch {}
        logoDiv.appendChild(img);
      } else {
        logoDiv.textContent = logo.value;
      }

      const metaDiv = document.createElement('div');
      metaDiv.className = 'channel-meta';

      const titleRow = document.createElement('div');
      titleRow.className = 'channel-title-row';

      const numDiv = document.createElement('div');
      numDiv.className = 'channel-num';
      numDiv.textContent = String(realIndex + 1);

      const titleDiv = document.createElement('div');
      titleDiv.className = 'channel-title';
      titleDiv.textContent = (typeof normalizeName === 'function') ? normalizeName(it.name) : (it.name || 'Torrent');

      const statusBadge = document.createElement('span');
      statusBadge.className = 'link-status';

      titleRow.appendChild(numDiv);
      titleRow.appendChild(titleDiv);
      titleRow.appendChild(statusBadge);

      const subDiv = document.createElement('div');
      subDiv.className = 'channel-sub';
      subDiv.textContent = 'Torrent (Webtor)';

      const tagsDiv = document.createElement('div');
      tagsDiv.className = 'channel-tags';

      const tagIframe = document.createElement('div');
      tagIframe.className = 'tag-chip tag-chip--iframe';
      tagIframe.textContent = 'OVERLAY';

      const tagTorrent = document.createElement('div');
      tagTorrent.className = 'tag-chip tag-chip--torrent';
      tagTorrent.textContent = 'TORRENT';

      tagsDiv.appendChild(tagIframe);
      tagsDiv.appendChild(tagTorrent);

      metaDiv.appendChild(titleRow);
      metaDiv.appendChild(subDiv);
      metaDiv.appendChild(tagsDiv);

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'channel-actions';

      const playBtn = document.createElement('button');
      playBtn.className = 'icon-btn';
      playBtn.innerHTML = '▶';
      playBtn.title = 'Lire (Webtor)';
      playBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        playTorrent(realIndex);
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'icon-btn';
      delBtn.innerHTML = '🗑';
      delBtn.title = 'Supprimer';
      delBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        torrentItems = torrentItems.filter(x => x && x.id !== it.id);
        saveItems(torrentItems);
        if (currentTorrentIndex >= torrentItems.length) currentTorrentIndex = torrentItems.length - 1;
        renderTorrentList();
        try { if (typeof refreshActiveListsUI === 'function') refreshActiveListsUI(); } catch {}
      });

      actionsDiv.appendChild(playBtn);
      actionsDiv.appendChild(delBtn);

      li.appendChild(logoDiv);
      li.appendChild(metaDiv);
      li.appendChild(actionsDiv);

      li.addEventListener('click', () => playTorrent(realIndex));

      torrentListEl.appendChild(li);
    });
  };

  // ---- Playback
  const showWebtor = () => {
    // mimic iframe overlay mode (so the existing toggle button doesn't try to switch to video)
    try { overlayMode = true; } catch {}

    // Hide iframe overlay and video
    try { iframeOverlay?.classList.add('hidden'); } catch {}
    try { if (iframeEl) iframeEl.src = 'about:blank'; } catch {}
    try { videoEl?.pause?.(); } catch {}
    try { if (videoEl) videoEl.style.visibility = 'hidden'; } catch {}

    showWebtorLayer();
  };

  const playTorrentByEntry = (entry) => {
    if (!entry || !entry.url) return;

    // currentEntry is used by the rest of the UI
    try { currentEntry = entry; } catch {}
    try { activePlaybackMode = 'iframe'; } catch {} // keep existing semantics
    try { currentListType = 'torrents'; } catch {}

    showWebtor();

    resetWebtorHost();

    const input = String(entry.url || '').trim();
    setWebtorStatus('Webtor: initialisation…');

    window.webtor.push({
      id: 'webtorPlayer',
      magnet: input.startsWith('magnet:?') ? input : undefined,
      torrentUrl: input.startsWith('magnet:?') ? undefined : input,
      width: '100%',
      height: '100%',
      controls: true,
      on: function(e) {
        try {
          const name = e && e.name ? e.name : 'EVENT';
          if (name) setWebtorStatus('Webtor: ' + name);
        } catch {}
      }
    });

    try { if (typeof updateNowPlaying === 'function') updateNowPlaying(entry, 'WEBTOR'); } catch {}
    try { if (typeof setStatus === 'function') setStatus('Lecture torrent (Webtor)'); } catch {}
    try { if (typeof refreshTrackMenus === 'function') refreshTrackMenus(); } catch {}
  };

  const playTorrent = (index) => {
    if (index < 0 || index >= torrentItems.length) return;
    const it = torrentItems[index];
    if (!it || !it.url) return;

    currentTorrentIndex = index;

    it.__webtor = true;
    it.isIframe = true;
    it.group = it.group || 'Torrent (Webtor)';

    playTorrentByEntry(it);

    renderTorrentList();
    try { if (typeof updateNowPlayingCounter === 'function') updateNowPlayingCounter(); } catch {}
    try { if (typeof scrollToActiveItem === 'function') scrollToActiveItem(); } catch {}
  };

  window.__tronWebtor = { playTorrent };

  // ---- Tab click
  torrentTabBtn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    torrentTabBtn.classList.add('active');
    activateList();
    try { currentListType = 'torrents'; } catch {}
    renderTorrentList();

    // autoplay first
    try {
      if ((!currentEntry || currentListType === 'torrents') && torrentItems.length) playTorrent(0);
    } catch {}
  });

  // ---- Extend Next/Prev + counter
  wrap('playNext', (orig) => function() {
    try {
      if (typeof currentListType !== 'undefined' && currentListType === 'torrents') {
        if (!torrentItems.length) return;
        if (currentTorrentIndex === -1) currentTorrentIndex = 0;
        else currentTorrentIndex = (currentTorrentIndex + 1) % torrentItems.length;
        playTorrent(currentTorrentIndex);
        return;
      }
    } catch {}
    return orig();
  });

  wrap('playPrev', (orig) => function() {
    try {
      if (typeof currentListType !== 'undefined' && currentListType === 'torrents') {
        if (!torrentItems.length) return;
        if (currentTorrentIndex === -1) currentTorrentIndex = torrentItems.length - 1;
        else currentTorrentIndex = (currentTorrentIndex - 1 + torrentItems.length) % torrentItems.length;
        playTorrent(currentTorrentIndex);
        return;
      }
    } catch {}
    return orig();
  });

  wrap('updateNowPlayingCounter', (orig) => function() {
    try {
      if (typeof currentListType !== 'undefined' && currentListType === 'torrents') {
        if (typeof npCounter !== 'undefined' && npCounter) {
          const total = torrentItems.length;
          const pos = currentTorrentIndex >= 0 ? (currentTorrentIndex + 1) : 0;
          const newText = total ? `${pos}/${total}` : '-/-';
          if (npCounter.textContent !== newText) npCounter.textContent = newText;
        }
        return;
      }
    } catch {}
    return orig();
  });

  // ---- Add action
  const addTorrent = () => {
    const title = (titleInput?.value || '').trim() || 'Torrent';
    const src = (srcInput?.value || '').trim();

    if (!src) {
      try { if (typeof setStatus === 'function') setStatus('Colle un magnet (magnet:?) ou une URL .torrent'); } catch {}
      return;
    }
    if (!isProbablyMagnetOrTorrentUrl(src)) {
      try { if (typeof setStatus === 'function') setStatus('Ça ne ressemble pas à un magnet ni à une URL .torrent'); } catch {}
      return;
    }

    const entry = {
      id: nextId(),
      name: title,
      url: src,
      logo: deriveLogoSafe(title),
      group: 'Torrent (Webtor)',
      isIframe: true,
      __webtor: true
    };

    torrentItems.push(entry);
    saveItems(torrentItems);

    if (titleInput) titleInput.value = '';
    if (srcInput) srcInput.value = '';

    renderTorrentList();
    playTorrent(torrentItems.length - 1);
  };

  addBtn?.addEventListener('click', addTorrent);
  srcInput?.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') addTorrent(); });

  // Initial
  ensureWebtorLayer();
  renderTorrentList();
})();
