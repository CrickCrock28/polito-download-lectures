// ==UserScript==
// @name         Polito VC – lecture checkboxes & download
// @namespace    https://tampermonkey.net/
// @version      1.3
// @description  Lecture completion checkboxes & video download for Polito Virtual Classroom
// @match        https://didattica.polito.it/pls/portal30/sviluppo.pagina_corso_2023.main*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @connect      video.polito.it
// @connect      didattica.polito.it
// @connect      ssrweb.zoom.us
// @connect      *.zoom.us
// @updateURL    https://raw.githubusercontent.com/CrickCrock28/polito-download-lectures/main/polito-download-lectures.user.js
// @downloadURL  https://raw.githubusercontent.com/CrickCrock28/polito-download-lectures/main/polito-download-lectures.user.js
// ==/UserScript==

(function () {
  'use strict';

  const style = document.createElement('style');
  style.textContent = `
    @font-face {
      font-family: DXIcons;
      src: url("https://didattica.polito.it/pls/static/assets/2.0/css/icons/dxiconsmaterial.woff2") format("woff2"),
           url("https://didattica.polito.it/pls/static/assets/2.0/css/icons/dxiconsmaterial.woff") format("woff");
      font-weight: 400;
      font-style: normal;
    }
    .polito-vc-cb {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(18, 24, 28, 0.54);
      border-radius: 0.25em;
      background: transparent;
      cursor: pointer;
      vertical-align: middle;
      position: relative;
      box-sizing: border-box;
    }
    .polito-vc-cb.checked {
      background: rgb(0, 43, 73);
      border: none;
      font: 16px/1 DXIcons;
      color: rgb(249, 250, 251);
    }
    .polito-vc-cb.checked::before {
      content: "\\f005";
      display: block;
      width: 16px;
      height: 16px;
      font-size: 14px;
      text-align: center;
      line-height: 16px;
    }
    .polito-vc-pct {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
  `;
  document.head.appendChild(style);

  const STORAGE_KEY = 'polito_vc_lesson_completed_v1';
  const VC_TPL_URL = 'https://didattica.polito.it/pls/portal30/sviluppo.virtual_classroom.getVCTpl';
  const CHUNK_SIZE = 8 * 1024 * 1024;
  const activeDownloads = new Map();

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
    catch { return {}; }
  }

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function gmRequest(details) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest(Object.assign({
        onload: (resp) => resolve(resp),
        onerror: () => reject(new Error('request failed')),
        ontimeout: () => reject(new Error('request timed out')),
      }, details));
    });
  }

  function headerValue(resp, name) {
    const raw = resp.responseHeaders || '';
    const lines = Array.isArray(raw) ? raw : String(raw).split('\n');
    const lower = name.toLowerCase();
    for (const line of lines) {
      const idx = line.indexOf(':');
      if (idx > 0 && line.slice(0, idx).trim().toLowerCase() === lower) {
        return line.slice(idx + 1).trim();
      }
    }
    return null;
  }

  function fetchVCTpl(bbbId, idInc, idIncProv) {
    return gmRequest({
      method: 'POST',
      url: VC_TPL_URL,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: 'p_bbbid=' + encodeURIComponent(bbbId) +
            '&p_id_inc=' + encodeURIComponent(idInc) +
            '&p_id_inc_prov=' + encodeURIComponent(idIncProv),
    }).then((resp) => resp.responseText);
  }

  function parseMedia(html) {
    const mp4 = html.match(/<source[^>]+src="([^"]+)"/);
    if (mp4) return { kind: 'mp4', url: mp4[1] };
    const zoom = html.match(/href="(https:\/\/[^"]*?zoom\.us\/rec\/play\/[^"]+)"/);
    if (zoom) return { kind: 'zoom', url: zoom[1] };
    return null;
  }

  function resolveZoomMp4(playUrl) {
    const host = new URL(playUrl).host;
    return gmRequest({ method: 'GET', url: playUrl })
      .then((resp) => {
        const m = resp.responseText.match(/fileId\s*:\s*'([^']+)'/);
        if (!m) throw new Error('Zoom token not found');
        const infoUrl = 'https://' + host + '/nws/recording/1.0/play/info/' +
          encodeURIComponent(m[1]) + '?originDomain=' + host;
        return gmRequest({ method: 'GET', url: infoUrl });
      })
      .then((resp) => {
        const data = JSON.parse(resp.responseText);
        const url = data && data.result && data.result.mp4Url;
        if (!url) throw new Error('Zoom MP4 URL not available');
        return url;
      });
  }

  function saveBlob(blob, name) {
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  }

  function fetchWhole(url, dlCtx) {
    return gmRequest({
      method: 'GET',
      url: url,
      responseType: 'blob',
      onprogress: (p) => {
        if (p.total > 0) {
          dlCtx.pct = Math.round((p.loaded / p.total) * 100);
          dlCtx.setVisual('refresh', dlCtx.pct + '%');
        } else {
          dlCtx.setVisual('refresh', '…');
        }
      },
    }).then((resp) => resp.response);
  }

  function fetchChunked(url, dlCtx) {
    return gmRequest({
      method: 'GET',
      url: url,
      responseType: 'arraybuffer',
      headers: { Range: 'bytes=0-0' },
    }).then((probe) => {
      const range = headerValue(probe, 'content-range');
      const total = range ? Number(range.split('/')[1]) : 0;
      if (!total) throw new Error('server does not support ranged download');

      const parts = [];
      let received = 0;

      const next = (start) => {
        if (start >= total) {
          dlCtx.pct = 100;
          dlCtx.setVisual('refresh', '100%');
          return Promise.resolve(new Blob(parts, { type: 'video/mp4' }));
        }
        const end = Math.min(start + CHUNK_SIZE - 1, total - 1);
        return gmRequest({
          method: 'GET',
          url: url,
          responseType: 'arraybuffer',
          headers: { Range: 'bytes=' + start + '-' + end },
        }).then((resp) => {
          parts.push(resp.response);
          received += end - start + 1;
          dlCtx.pct = Math.round(Math.min(received, total) / total * 100);
          dlCtx.setVisual('refresh', dlCtx.pct + '%');
          return next(start + CHUNK_SIZE);
        });
      };

      return next(0);
    });
  }

  function gmDownload(url, name, onprogress) {
    return new Promise((resolve, reject) => {
      if (typeof GM_download !== 'function') { reject(new Error('GM_download unavailable')); return; }
      const details = {
        url: url,
        name: name,
        saveAs: false,
        onload: () => resolve('ok'),
        onerror: () => reject(new Error('GM_download failed')),
        ontimeout: () => reject(new Error('GM_download timed out')),
      };
      if (onprogress) details.onprogress = onprogress;
      GM_download(details);
    });
  }

  function fetchMedia(url, name, dlCtx) {
    const progress = (p) => {
      const total = p && (p.total || 0);
      if (total > 0) {
        dlCtx.pct = Math.round((p.loaded / total) * 100);
        dlCtx.setVisual('refresh', dlCtx.pct + '%');
      } else {
        dlCtx.setVisual('refresh', '…');
      }
    };
    return gmDownload(url, name, null)
      .catch(() => gmDownload(url, name, progress))
      .catch(() => fetchWhole(url, dlCtx).then((blob) => {
        saveBlob(blob, name);
        return 'ok';
      }));
  }

  const ICON_CLS = {
    save: 'glyphicon glyphicon-save',
    refresh: 'glyphicon glyphicon-refresh',
    ok: 'glyphicon glyphicon-ok',
    fail: 'glyphicon glyphicon-remove',
  };

  function buildDlButton(bbbId, idInc, idIncProv, a) {
    const dlBtn = document.createElement('span');
    dlBtn.title = 'Download lecture';
    dlBtn.style.cssText = 'cursor:pointer;font-size:14px;padding:0 2px;';

    const icon = document.createElement('i');
    icon.className = ICON_CLS.save;

    const pctSpan = document.createElement('span');
    pctSpan.className = 'polito-vc-pct';

    dlBtn.appendChild(icon);
    dlBtn.appendChild(pctSpan);

    function setVisual(state, pctText) {
      icon.className = ICON_CLS[state] || ICON_CLS.save;
      pctSpan.textContent = pctText ? ' ' + pctText : '';
      pctSpan.style.display = pctText ? 'inline-block' : 'none';
      pctSpan.style.width = pctText ? '3em' : '';
    }

    const dl = activeDownloads.get(bbbId);
    if (dl) {
      setVisual('refresh', dl.pct != null ? dl.pct + '%' : '…');
      dl.setVisual = setVisual;
    }

    dlBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (activeDownloads.has(bbbId)) return;

      const dlCtx = { pct: null, setVisual };
      activeDownloads.set(bbbId, dlCtx);
      setVisual('refresh');

      const allLinks = [...document.querySelectorAll('a.link_vc_date[data-bbb-id]')];
      const idx = allLinks.indexOf(a) + 1;
      const prefix = String(idx).padStart(2, '0');
      const lessonName = prefix + '_' + a.textContent.trim().replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_');

      fetchVCTpl(bbbId, idInc, idIncProv)
        .then((html) => {
          const media = parseMedia(html);
          if (!media) throw new Error('no downloadable media found');
          if (media.kind === 'zoom') {
            dlCtx.setVisual('refresh', '…');
            const playUrl = media.url;
            return resolveZoomMp4(playUrl)
              .then((mp4Url) => fetchMedia(mp4Url, lessonName + '.mp4', dlCtx))
              .catch(() => { window.open(playUrl, '_blank', 'noopener'); });
          }
          return fetchMedia(media.url, lessonName + '.mp4', dlCtx);
        })
        .then(() => {
          activeDownloads.delete(bbbId);
          dlCtx.setVisual('ok');
          setTimeout(() => dlCtx.setVisual('save'), 3000);
        })
        .catch((err) => {
          activeDownloads.delete(bbbId);
          dlCtx.setVisual('fail');
          alert('Download failed: ' + err.message);
          setTimeout(() => dlCtx.setVisual('save'), 3000);
        });
    });

    return dlBtn;
  }

  function attachControls() {
    const list = document.querySelector('ul[id^="navbar_left_menu_"]');
    if (list) list.style.listStyle = 'none';

    document.querySelectorAll('a.link_vc_date[data-bbb-id]').forEach((a) => {
      const bbbId = a.getAttribute('data-bbb-id');
      const idInc = a.getAttribute('data-id_inc') || '0';
      const idIncProv = a.getAttribute('data-id_inc-prov') || '0';
      if (!bbbId) return;

      const li = a.closest('li');
      if (!li || li.querySelector('.polito-vc-controls')) return;

      const state = loadState();

      const wrap = document.createElement('span');
      wrap.className = 'polito-vc-controls';
      wrap.style.cssText =
        'display:inline-flex;align-items:center;gap:4px;margin-right:6px;vertical-align:middle;';

      const cb = document.createElement('span');
      cb.className = 'polito-vc-cb' + (state[bbbId] ? ' checked' : '');
      cb.title = 'Lecture completed';

      cb.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        e.stopImmediatePropagation();
        cb.classList.toggle('checked');
        const s = loadState();
        if (cb.classList.contains('checked')) s[bbbId] = true;
        else delete s[bbbId];
        saveState(s);
      });

      wrap.appendChild(cb);
      wrap.appendChild(buildDlButton(bbbId, idInc, idIncProv, a));
      li.insertBefore(wrap, li.firstChild);
    });
  }

  attachControls();

  setInterval(() => {
    const pending = [...document.querySelectorAll('a.link_vc_date[data-bbb-id]')].some((a) => {
      const li = a.closest('li');
      return li && !li.querySelector('.polito-vc-controls');
    });
    if (pending) attachControls();
  }, 500);
})();
