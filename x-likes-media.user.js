// ==UserScript==
// @name         X Likes Media Downloader
// @namespace    mikebug
// @version      1.3
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_download
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const seen = new Set(), posts = new Map(), videos = new Map(); // id -> best mp4 url
  let running = false, count = 0;

  // ---- sniff mp4 URLs out of X's API responses ----
  function harvest(obj, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 40) return;
    if (Array.isArray(obj)) return obj.forEach(o => harvest(o, depth + 1));
    const media = obj.extended_entities?.media;
    if (obj.id_str && Array.isArray(media)) {
      for (const m of media) {
        const vs = (m.video_info?.variants || []).filter(v => v.content_type === 'video/mp4');
        if (vs.length) videos.set(obj.id_str, vs.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0].url);
      }
    }
    for (const k in obj) harvest(obj[k], depth + 1);
  }
  const tryParse = t => { if (typeof t === 'string' && t[0] === '{') { try { harvest(JSON.parse(t)); } catch {} } };

  const W = unsafeWindow;
  const origOpen = W.XMLHttpRequest.prototype.open;
  W.XMLHttpRequest.prototype.open = function () {
    this.addEventListener('load', () => tryParse(this.responseText));
    return origOpen.apply(this, arguments);
  };
  const origFetch = W.fetch;
  W.fetch = async function () {
    const r = await origFetch.apply(this, arguments);
    try { if ((r.headers.get('content-type') || '').includes('json')) r.clone().text().then(tryParse); } catch {}
    return r;
  };

  // ---- scrape visible tweets ----
  // key on the media filename, not the URL, so ?format/?name variants don't slip through
  const mediaKey = u => (u.match(/\/(?:media|ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\/([^?]+)/) || u.match(/\/([^/?]+\.mp4)/) || [, u])[1];
  const dl = (u, name) => { const k = mediaKey(u); if (seen.has(k)) return; seen.add(k); GM_download(u, name); count++; };

  function grab() {
    for (const a of document.querySelectorAll('article[data-testid="tweet"]')) {
      const link = [...a.querySelectorAll('a[href*="/status/"]')].map(x => x.getAttribute('href')).find(h => /^\/[^/]+\/status\/\d+$/.test(h));
      if (!link) continue;
      const id = link.split('/').pop();
      if (!posts.has(id)) posts.set(id, {
        id, url: 'https://x.com' + link, handle: link.split('/')[1],
        time: a.querySelector('time')?.getAttribute('datetime') || null,
        text: a.querySelector('[data-testid="tweetText"]')?.innerText || '',
        images: [], video: null,
      });
      const p = posts.get(id);

      [...a.querySelectorAll('[data-testid="tweetPhoto"] img')]
        .filter(i => !i.closest('div[role="link"]'))            // skip media belonging to a quoted tweet
        .map(i => i.src).filter(s => s.includes('pbs.twimg.com/media')).forEach(u => {
          u = u.includes('name=') ? u.replace(/name=\w+/, 'name=orig') : u + '&name=orig';
          const key = mediaKey(u);
          if (!p.images.some(x => mediaKey(x) === key)) p.images.push(u);
          dl(u, `media/${id}_${key}.${(u.match(/format=(\w+)/) || [])[1] || 'jpg'}`);
        });

      const v = [...a.querySelectorAll('video')].find(v => !v.closest('div[role="link"]'));
      if (v) {
        p.video = p.video || { mp4: null, poster: v.poster || null };
        if (!p.video.mp4 && videos.has(id)) p.video.mp4 = videos.get(id);
      }
    }
    // videos: mp4 if we've sniffed it, otherwise poster (and retry later)
    for (const p of posts.values()) {
      if (!p.video) continue;
      if (!p.video.mp4 && videos.has(p.id)) p.video.mp4 = videos.get(p.id);
      if (p.video.mp4) dl(p.video.mp4, `media/${p.id}_v.mp4`);
    }
  }

  function finish(btn) {
    grab();
    for (const p of posts.values()) if (p.video && !p.video.mp4 && p.video.poster) dl(p.video.poster, `media/${p.id}_poster.jpg`);
    const blob = new Blob([JSON.stringify([...posts.values()], null, 2)], { type: 'application/json' });
    Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'likes.json' }).click();
    const missing = [...posts.values()].filter(p => p.video && !p.video.mp4).length;
    btn.textContent = `Done — ${count} files, ${posts.size} posts${missing ? `, ${missing} videos missing` : ''}`;
  }

  function addButton() {
    if (!document.body || document.getElementById('xmd-btn')) return;
    const btn = document.createElement('button');
    btn.id = 'xmd-btn';
    btn.textContent = '⬇ Download likes media';
    btn.style.cssText = 'position:fixed;top:80px;right:20px;z-index:999999;padding:10px 16px;background:#1d9bf0;color:#fff;border:0;border-radius:8px;font-size:14px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.3)';
    document.body.appendChild(btn);
    btn.onclick = async () => {
      if (running) { running = false; return; }
      running = true;
      let stuck = 0, last = 0;
      while (running && stuck < 12) {
        grab();
        btn.textContent = `Stop — ${count} files, ${videos.size} videos found`;
        window.scrollBy(0, 3000);
        await sleep(2000);
        if (document.body.scrollHeight === last) stuck++; else { stuck = 0; last = document.body.scrollHeight; }
      }
      running = false;
      finish(btn);
    };
  }

  new MutationObserver(addButton).observe(document.documentElement, { childList: true, subtree: true });
  addButton();
})();
