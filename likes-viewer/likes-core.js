/* Shared plumbing for the X Likes viewers: data loading with real progress,
   media path resolution, a bounded image cache, the filter model, URL state,
   and the detail popup. */
(function (global) {
  'use strict';

  var state = {
    posts: [],       // every liked post, in likes.json order
    byId: {},
    graph: null,     // graph.json, if the analysis pass has been run
    nodes: [],       // graph nodes joined to their post
    clusters: [],
    edges: [],
    tagList: [],     // [{tag, count}] sorted by count
    categories: [],  // [{name, count}] once labels.json is present
    labelled: false,
    dims: null,      // {postId: [w, h]} for thumbnails
    media: '../media',
    base: '..',
    thumbs: null,
    offline: localStorage.getItem('xl-offline') === '1',
    restore: {}      // camera / open post recovered from the URL
  };

  /* ---------------------------------------------------------------- paths */

  function mediaId(url) {
    var m = String(url).match(/\/media\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  function imageExt(url) {
    var q = String(url).match(/[?&]format=(\w+)/);
    if (q) return q[1];
    var p = String(url).match(/\/media\/[A-Za-z0-9_-]+\.(\w+)/);
    return p ? p[1] : 'jpg';
  }

  // Some scraped URLs use the malformed `.../ID.jpg&name=orig` form; rebuild
  // them from the id so the remote fallback actually resolves.
  function remoteImage(url, size) {
    var id = mediaId(url);
    if (!id) return url;
    return 'https://pbs.twimg.com/media/' + id + '?format=' + imageExt(url) +
           '&name=' + (size || 'orig');
  }

  function localImage(post, i) {
    var url = post.images[i || 0], id = url && mediaId(url);
    return id ? state.media + '/' + post.id + '_' + id + '.' + imageExt(url) : null;
  }

  function kindOf(post) {
    if (post.video) return 'video';
    if (post.images && post.images.length) return 'image';
    return 'text';
  }

  function push(a, v) { if (v) a.push(v); }

  // The thumbnail pass writes one small jpg per post; everything else here is
  // a fallback for an archive where that pass has not been run.
  function thumbSources(post) {
    var out = [];
    if (post.kind === 'video') {
      if (state.thumbs) push(out, state.thumbs + '/' + post.id + '_v.jpg');
      push(out, state.media + '/' + post.id + '_poster.jpg');
      if (!state.offline && post.video && post.video.poster) push(out, post.video.poster);
      return out;
    }
    if (post.kind === 'image') {
      var id = mediaId(post.images[0]);
      if (state.thumbs && id) push(out, state.thumbs + '/' + post.id + '_' + id + '.jpg');
      if (!state.offline) push(out, remoteImage(post.images[0], 'small'));
      push(out, localImage(post, 0));
      return out;
    }
    return out;
  }

  function fullImageSources(post, i) {
    var out = [];
    push(out, localImage(post, i));
    if (!state.offline) {
      push(out, remoteImage(post.images[i], 'orig'));
      push(out, post.images[i]);
    }
    if (state.thumbs && i === 0) push(out, thumbSources(post)[0]);
    return out;
  }

  function videoSources(post) {
    var out = [];
    push(out, state.media + '/' + post.id + '_v.mp4');
    if (!state.offline && post.video && post.video.mp4) push(out, post.video.mp4);
    return out;
  }

  /* -------------------------------------------------------------- loading */

  function fetchJSON(url) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status + ' ' + url);
      return r.json();
    });
  }

  // likes.json is 1.5 MB and graph.json 0.6 MB, which is long enough that a
  // static "loading..." is a lie. Stream them and report bytes.
  function fetchProgress(url, stage, onProgress) {
    return fetch(url).then(function (r) {
      if (!r.ok) throw new Error(r.status + ' ' + url);
      var total = +(r.headers.get('Content-Length') || 0);
      if (!r.body || !total || !r.body.getReader) return r.json();
      var reader = r.body.getReader(), chunks = [], loaded = 0;
      return (function pump() {
        return reader.read().then(function (res) {
          if (res.done) {
            var buf = new Uint8Array(loaded), at = 0;
            for (var i = 0; i < chunks.length; i++) {
              buf.set(chunks[i], at);
              at += chunks[i].length;
            }
            return JSON.parse(new TextDecoder('utf-8').decode(buf));
          }
          chunks.push(res.value);
          loaded += res.value.length;
          if (onProgress) onProgress({ stage: stage, loaded: loaded, total: total });
          return pump();
        });
      })();
    });
  }

  function probe(url) {
    return fetch(url, { method: 'HEAD' })
      .then(function (r) { return r.ok; })
      .catch(function () { return false; });
  }

  // likes.json sits next to media/, which is either this folder or its parent.
  function load(onProgress) {
    var report = onProgress || function () {};
    return fetchProgress('../likes.json', 'likes', report)
      .then(function (d) { state.base = '..'; state.media = '../media'; return d; })
      .catch(function (e) {
        if (e && /^404/.test(e.message || '')) {
          return fetchProgress('likes.json', 'likes', report).then(function (d) {
            state.base = '.'; state.media = './media'; return d;
          });
        }
        throw e;
      })
      .then(adopt)
      .then(function () {
        return probe(state.media + '/thumbs/.ok').then(function (ok) {
          if (ok) state.thumbs = state.media + '/thumbs';
        });
      })
      .then(function () {
        if (!state.thumbs) return;
        return fetchJSON(state.thumbs + '/dims.json')
          .then(function (d) { state.dims = d; applyDims(); })
          .catch(function () { state.dims = null; });
      })
      .then(function () {
        report({ stage: 'graph', loaded: 0, total: 1 });
        return fetchProgress(state.base + '/graph.json', 'graph', report)
          .then(joinGraph)
          .catch(function () { state.graph = null; });
      })
      .then(function () {
        report({ stage: 'labels', loaded: 0, total: 1 });
        return fetchJSON(state.base + '/labels.json')
          .then(joinLabels)
          .catch(function () { state.labelled = false; });
      })
      .then(function () { url.read(); return state; });
  }

  function adopt(data) {
    state.posts = (data || []).filter(function (p) { return p && p.id; });
    state.byId = {};
    state.posts.forEach(function (p, i) {
      p.images = p.images || [];
      p.index = i;
      p.date = p.time ? new Date(p.time) : null;
      p.t = p.date ? p.date.getTime() : 0;
      p.kind = kindOf(p);
      p.tags = [];
      p.cluster = -1;
      p.haystack = ((p.handle || '') + ' ' + (p.text || '')).toLowerCase();
      state.byId[p.id] = p;
    });
    return state.posts;
  }

  function applyDims() {
    if (!state.dims) return;
    state.posts.forEach(function (p) {
      var d = state.dims[p.id];
      if (d) { p.w = d[0]; p.h = d[1]; }
    });
  }

  function joinGraph(g) {
    state.graph = g;
    state.clusters = g.clusters || [];
    state.edges = g.edges || [];
    state.nodes = [];
    var counts = {};
    (g.nodes || []).forEach(function (n) {
      var post = state.byId[n.id];
      if (!post) return;
      post.cluster = n.c;
      post.tags = n.tags || [];
      post.node = n;
      post.tags.forEach(function (t) { counts[t] = (counts[t] || 0) + 1; });
      n.post = post;
      state.nodes.push(n);
    });
    state.tagList = Object.keys(counts)
      .map(function (t) { return { tag: t, count: counts[t] }; })
      .sort(function (a, b) { return b.count - a.count; });
    state.clusters.forEach(function (c) { c.color = clusterColor(c.id); });
    return g;
  }

  // Claude's labels, when tools/label.py has been run. They replace the CLIP
  // zero-shot tags for filtering (the originals stay on post.clipTags), and
  // add a category axis the vectors alone don't give us.
  function joinLabels(map) {
    state.labelled = true;
    var tagCounts = {}, catCounts = {};
    Object.keys(map).forEach(function (id) {
      var post = state.byId[id];
      if (!post) return;
      var l = map[id];
      post.clipTags = post.tags;
      post.tags = l.tags || [];
      post.category = l.category || 'other';
      post.caption = l.caption || '';
      post.haystack += ' ' + post.tags.join(' ') + ' ' + post.category +
                       ' ' + post.caption.toLowerCase();
      post.tags.forEach(function (t) { tagCounts[t] = (tagCounts[t] || 0) + 1; });
      catCounts[post.category] = (catCounts[post.category] || 0) + 1;
    });
    state.tagList = Object.keys(tagCounts)
      .map(function (t) { return { tag: t, count: tagCounts[t] }; })
      .sort(function (a, b) { return b.count - a.count; });
    state.categories = Object.keys(catCounts)
      .map(function (c) { return { name: c, count: catCounts[c] }; })
      .sort(function (a, b) { return b.count - a.count; });
    return map;
  }

  // The vectors' payoff: the posts nearest this one in CLIP space.
  function neighbours(post) {
    if (!post.node || !post.node.nn || !state.graph) return [];
    var out = [];
    post.node.nn.forEach(function (pair) {
      var n = state.graph.nodes[pair[0]];
      if (n && n.post) out.push({ post: n.post, w: pair[1] });
    });
    return out;
  }

  function clusterColor(i) {
    // Even hue spacing with alternating lightness keeps neighbouring cluster
    // ids visually distinct without a hand-picked palette.
    var hue = (i * 137.508) % 360;
    var light = i % 2 ? 66 : 56;
    return 'hsl(' + hue.toFixed(1) + ' 65% ' + light + '%)';
  }

  /* ---------------------------------------------------------- image cache */

  var CACHE_MAX = 900, CONCURRENCY = 10;
  var cache = new Map(), queue = [], active = 0;

  function touch(url) {
    var img = cache.get(url);
    if (img) { cache.delete(url); cache.set(url, img); }
    return img;
  }

  function evict() {
    // Drop the reference and let GC do the rest. Blanking the Image with
    // src='' frees its memory sooner but corrupts it for anyone still holding
    // it - the map kept drawing evicted images and they came out black.
    while (cache.size > CACHE_MAX) {
      cache.delete(cache.keys().next().value);
    }
  }

  function cached(post) {
    return post._thumb ? touch(post._thumb) || null : null;
  }

  var waiting = new Map();   // post id -> callbacks awaiting the same fetch

  function thumb(post, cb) {
    if (post._thumb === null) return cb(null);
    if (post._thumb) {
      var hit = touch(post._thumb);
      if (hit) return cb(hit);
    }
    // The same post is often wanted from several places at once - the map, the
    // grid, the "more like this" strip. Queue every caller against the one
    // fetch instead of dropping all but the first, which left the strip blank.
    var list = waiting.get(post.id);
    if (list) { list.push(cb); return; }
    var sources = thumbSources(post);
    if (!sources.length) { post._thumb = null; return cb(null); }
    waiting.set(post.id, [cb]);
    queue.push({ post: post, sources: sources });
    pump();
  }

  function settle(post, img) {
    var list = waiting.get(post.id);
    waiting.delete(post.id);
    if (!list) return;
    for (var i = 0; i < list.length; i++) list[i](img);
  }

  function pump() {
    while (active < CONCURRENCY && queue.length) {
      var job = queue.shift();
      active++;
      tryNext(job.sources, 0, function (img, u) {
        active--;
        if (img) { job.post._thumb = u; cache.set(u, img); evict(); }
        else job.post._thumb = null;
        settle(job.post, img);
        pump();
      });
    }
  }

  function tryNext(sources, i, done) {
    if (i >= sources.length) return done(null, null);
    var u = sources[i], known = cache.get(u);
    if (known) return done(known, u);
    var img = new Image();
    img.decoding = 'async';
    if (/^https?:/.test(u)) img.crossOrigin = 'anonymous';
    img.onload = function () { done(img, u); };
    img.onerror = function () { tryNext(sources, i + 1, done); };
    img.src = u;
  }

  function cancelPending() {
    queue.forEach(function (j) { waiting.delete(j.post.id); });
    queue.length = 0;
  }

  /* --------------------------------------------------------------- filter */

  var filter = {
    query: '',
    tags: [],
    tagMode: 'and',
    categories: [],
    clusters: [],
    kinds: [],         // empty means all
    range: null,       // [tMin, tMax] in ms
    lasso: null,       // Set of post ids
    lassoKey: null
  };

  function matches(post) {
    if (filter.kinds.length && filter.kinds.indexOf(post.kind) === -1) return false;
    if (filter.clusters.length && filter.clusters.indexOf(post.cluster) === -1) return false;
    if (filter.categories.length &&
        filter.categories.indexOf(post.category) === -1) return false;
    if (filter.range && (post.t < filter.range[0] || post.t > filter.range[1])) return false;
    if (filter.lasso && !filter.lasso.has(post.id)) return false;
    if (filter.tags.length) {
      var hits = 0;
      for (var i = 0; i < filter.tags.length; i++) {
        if (post.tags.indexOf(filter.tags[i]) !== -1) hits++;
      }
      if (filter.tagMode === 'and' ? hits < filter.tags.length : hits === 0) return false;
    }
    if (filter.query) {
      var terms = filter.query.toLowerCase().split(/\s+/);
      for (var j = 0; j < terms.length; j++) {
        if (post.haystack.indexOf(terms[j]) === -1) return false;
      }
    }
    return true;
  }

  function filterActive() {
    return !!(filter.query || filter.tags.length || filter.clusters.length ||
              filter.categories.length || filter.kinds.length || filter.range ||
              filter.lasso);
  }

  function toggle(list, value) {
    var i = list.indexOf(value);
    if (i === -1) list.push(value); else list.splice(i, 1);
    return list;
  }

  function clearAll() {
    filter.query = '';
    filter.tags.length = 0;
    filter.categories.length = 0;
    filter.clusters.length = 0;
    filter.kinds.length = 0;
    filter.range = null;
    setLasso(null);
  }

  // Thousands of ids will not fit in a URL, so the set lives in sessionStorage
  // and only its key travels in the hash.
  function setLasso(ids) {
    if (!ids || !ids.length) {
      filter.lasso = null;
      filter.lassoKey = null;
    } else {
      filter.lasso = new Set(ids);
      filter.lassoKey = 'xl-lasso-' + Date.now().toString(36);
      try {
        sessionStorage.setItem(filter.lassoKey, JSON.stringify(ids));
      } catch (e) { /* private mode: the filter still works this session */ }
    }
    url.write();
  }

  /* ------------------------------------------------------------ url state */

  var writeTimer = null;

  var url = {
    read: function () {
      var h = location.hash.replace(/^#/, '');
      if (!h) return;
      var p = new URLSearchParams(h);
      var split = function (v) { return v ? v.split(',').filter(Boolean) : []; };
      filter.query = p.get('q') || '';
      filter.tags = split(p.get('tags'));
      filter.tagMode = p.get('mode') === 'or' ? 'or' : 'and';
      filter.categories = split(p.get('cats'));
      filter.clusters = split(p.get('cl')).map(Number);
      filter.kinds = split(p.get('kinds'));
      var from = p.get('from'), to = p.get('to');
      if (from || to) {
        filter.range = [from ? +from : -Infinity, to ? +to : Infinity];
      }
      var key = p.get('lasso');
      if (key) {
        try {
          var ids = JSON.parse(sessionStorage.getItem(key) || 'null');
          if (ids && ids.length) { filter.lasso = new Set(ids); filter.lassoKey = key; }
        } catch (e) { /* ignore a stale key */ }
      }
      state.restore.post = p.get('p') || null;
      state.restore.camera = p.get('z') || null;
    },

    // `extra` carries view-specific bits (camera, open post) the core has no
    // opinion about.
    write: function (extra) {
      if (extra) {
        Object.keys(extra).forEach(function (k) { state.restore[k] = extra[k]; });
      }
      clearTimeout(writeTimer);
      writeTimer = setTimeout(function () {
        var p = new URLSearchParams();
        if (filter.query) p.set('q', filter.query);
        if (filter.tags.length) p.set('tags', filter.tags.join(','));
        if (filter.tags.length > 1 && filter.tagMode === 'or') p.set('mode', 'or');
        if (filter.categories.length) p.set('cats', filter.categories.join(','));
        if (filter.clusters.length) p.set('cl', filter.clusters.join(','));
        if (filter.kinds.length) p.set('kinds', filter.kinds.join(','));
        if (filter.range) {
          if (isFinite(filter.range[0])) p.set('from', String(filter.range[0]));
          if (isFinite(filter.range[1])) p.set('to', String(filter.range[1]));
        }
        if (filter.lassoKey) p.set('lasso', filter.lassoKey);
        if (state.restore.camera) p.set('z', state.restore.camera);
        if (state.restore.post) p.set('p', state.restore.post);
        // Keep the query string: replacing the URL with just the pathname
        // silently drops things like ?nogl.
        var s = p.toString();
        history.replaceState(null, '',
                             location.pathname + location.search + (s ? '#' + s : ''));
      }, 120);
    },

    // Carries the whole view across to the other page.
    link: function (href) { return href + location.hash; }
  };

  /* ---------------------------------------------------------------- popup */

  var popup, popupPost, navigator_ = null;

  function buildPopup() {
    popup = document.createElement('div');
    popup.className = 'xl-popup';
    popup.hidden = true;
    popup.innerHTML =
      '<div class="xl-backdrop"></div>' +
      '<button class="xl-nav xl-prev" title="Previous (←)">&lsaquo;</button>' +
      '<button class="xl-nav xl-next" title="Next (→)">&rsaquo;</button>' +
      '<div class="xl-panel" role="dialog" aria-modal="true">' +
        '<button class="xl-close" title="Close (Esc)">&times;</button>' +
        '<div class="xl-media"></div>' +
        '<div class="xl-galwrap"></div>' +
        '<div class="xl-meta">' +
          '<div class="xl-head">' +
            '<a class="xl-handle" target="_blank" rel="noopener"></a>' +
            '<span class="xl-time"></span></div>' +
          '<div class="xl-text"></div>' +
          '<div class="xl-tags"></div>' +
          '<a class="xl-link" target="_blank" rel="noopener">Open on X ↗</a>' +
          '<div class="xl-more" hidden>' +
            '<h3>More like this</h3><div class="xl-strip"></div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(popup);
    popup.querySelector('.xl-backdrop').onclick = close;
    popup.querySelector('.xl-close').onclick = close;
    popup.querySelector('.xl-prev').onclick = function (e) { e.stopPropagation(); step(-1); };
    popup.querySelector('.xl-next').onclick = function (e) { e.stopPropagation(); step(1); };
    document.addEventListener('keydown', function (e) {
      if (popup.hidden) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    });
  }

  function step(d) { if (navigator_) navigator_(d, popupPost); }

  function open(post, nav) {
    if (!popup) buildPopup();
    popupPost = post;
    navigator_ = nav || navigator_;
    popup.querySelector('.xl-prev').hidden = !navigator_;
    popup.querySelector('.xl-next').hidden = !navigator_;

    var handle = popup.querySelector('.xl-handle');
    handle.textContent = '@' + (post.handle || 'unknown');
    handle.href = 'https://x.com/' + (post.handle || '');
    popup.querySelector('.xl-time').textContent =
      post.date ? post.date.toLocaleDateString(undefined,
        { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    setText(popup.querySelector('.xl-text'), post.text || post.caption || '');

    var tagBox = popup.querySelector('.xl-tags');
    tagBox.innerHTML = '';
    if (post.category) {
      var cat = document.createElement('span');
      cat.className = 'xl-tag xl-cat';
      cat.textContent = post.category;
      tagBox.appendChild(cat);
    }
    (post.tags || []).forEach(function (t) {
      var el = document.createElement('span');
      el.className = 'xl-tag';
      el.textContent = t;
      tagBox.appendChild(el);
    });

    popup.querySelector('.xl-link').href =
      post.url || ('https://x.com/i/status/' + post.id);

    fillMedia(post);
    fillStrip(post);

    popup.hidden = false;
    document.body.classList.add('xl-locked');
    url.write({ post: post.id });
  }

  // Sizing the panel to the media's own aspect is what stops a portrait video
  // sitting in a 1060px-wide box between two slabs of black.
  function sizePanel(post) {
    var panel = popup.querySelector('.xl-panel');
    var media = popup.querySelector('.xl-media');
    var w = post.w, h = post.h;
    panel.classList.toggle('xl-textpost', post.kind === 'text');
    if (!w || !h || post.kind === 'text') {
      panel.style.width = '';
      media.style.height = '';
      return;
    }
    var maxH = window.innerHeight * (post.images.length > 1 ? 0.60 : 0.66);
    var width = Math.max(380, Math.min(window.innerWidth * 0.94, maxH * (w / h), 1100));
    panel.style.width = Math.round(width) + 'px';
    // Giving the media box an exact height means the picture always fits it,
    // and the filmstrip and metadata below are never pushed off screen.
    media.style.height = Math.round(Math.min(maxH, width * h / w)) + 'px';
  }

  function videoShot(post) {
    var shot = document.createElement('div');
    shot.className = 'xl-shot';
    if (post.w) shot.style.aspectRatio = post.w + ' / ' + post.h;
    var spin = document.createElement('div');
    spin.className = 'xl-spin';
    var v = document.createElement('video');
    v.controls = true; v.autoplay = true; v.loop = true; v.playsInline = true;
    // Zoomed out the map draws dots and never loads thumbnails, so the poster
    // has to be fetched here rather than assumed to be in the cache.
    var placeholder = cached(post);
    if (placeholder) v.poster = placeholder.src;
    else thumb(post, function (img) { if (img && !v.poster) v.poster = img.src; });
    var vs = videoSources(post), vi = 0;
    v.onerror = function () {
      if (++vi < vs.length) v.src = vs[vi];
      else { spin.remove(); shot.classList.add('xl-failed'); }
    };
    v.oncanplay = function () { spin.remove(); shot.style.aspectRatio = ''; };
    v.src = vs[0];
    shot.appendChild(v);
    shot.appendChild(spin);
    return shot;
  }

  function imageShot(post, i) {
    var shot = document.createElement('div');
    shot.className = 'xl-shot';
    // Only the first image has recorded dimensions; holding that ratio for the
    // rest keeps the panel from jumping around as you step through a set.
    if (post.w) shot.style.aspectRatio = post.w + ' / ' + post.h;
    shot.appendChild(Object.assign(document.createElement('div'),
                                   { className: 'xl-spin' }));

    var im = document.createElement('img');
    im.className = 'xl-full';
    var srcs = fullImageSources(post, i), si = 0;
    var done = false;

    // Blur-up: paint the small thumbnail behind the original so something is on
    // screen immediately, then drop it once the full image has decoded.
    function blurUp(src) {
      if (done || shot.querySelector('.xl-ph')) return;
      var ph = document.createElement('img');
      ph.className = 'xl-ph';
      ph.src = src;
      shot.insertBefore(ph, shot.firstChild);
    }
    if (i === 0) {
      var placeholder = cached(post);
      if (placeholder) blurUp(placeholder.src);
      else thumb(post, function (img) { if (img) blurUp(img.src); });
    }

    im.onload = function () {
      done = true;
      im.classList.add('on');
      shot.style.aspectRatio = '';
      var sp = shot.querySelector('.xl-spin');
      if (sp) sp.remove();
      var old = shot.querySelector('.xl-ph');
      if (old) setTimeout(function () { old.remove(); }, 400);
    };
    im.onerror = function () {
      if (++si < srcs.length) im.src = srcs[si];
      else { shot.classList.add('xl-failed'); var sp2 = shot.querySelector('.xl-spin'); if (sp2) sp2.remove(); }
    };
    im.src = srcs[0];
    shot.appendChild(im);

    if (post.images.length > 1) {
      var badge = document.createElement('span');
      badge.className = 'xl-count';
      badge.textContent = (i + 1) + ' / ' + post.images.length;
      shot.appendChild(badge);
    }
    return shot;
  }

  // 396 posts carry more than one image. Stacking them vertically meant
  // scrolling past each; a filmstrip keeps the whole set in view.
  function galleryRow(post, onPick) {
    var row = document.createElement('div');
    row.className = 'xl-gallery';
    post.images.forEach(function (_, i) {
      var b = document.createElement('button');
      b.className = 'xl-gt' + (i === 0 ? ' on' : '');
      b.title = 'Image ' + (i + 1);
      var im = document.createElement('img');
      im.alt = '';
      im.loading = 'lazy';
      b.classList.add('skel');
      // Only image 0 has a generated thumbnail; the rest fall back through the
      // usual chain, which prefers a small remote copy over the local original.
      var srcs = i === 0 ? thumbSources(post) : fullImageSources(post, i).slice();
      var si = 0;
      im.onload = function () { b.classList.remove('skel'); };
      im.onerror = function () {
        if (++si < srcs.length) im.src = srcs[si];
        else b.classList.remove('skel');
      };
      im.src = srcs[0];
      b.appendChild(im);
      b.onclick = function (e) {
        e.stopPropagation();
        row.parentNode.querySelectorAll('.xl-gt').forEach(function (o) {
          o.classList.remove('on');
        });
        b.classList.add('on');
        onPick(i);
      };
      row.appendChild(b);
    });
    return row;
  }

  // A blank line between paragraphs renders at a full line-height under
  // pre-wrap, which leaves a chasm between them. Real paragraphs let the gap be
  // set typographically instead.
  function setText(el, text) {
    el.innerHTML = '';
    String(text).split(/\n{2,}/).forEach(function (block) {
      if (!block.trim()) return;
      var para = document.createElement('p');
      block.split('\n').forEach(function (line, i) {
        if (i) para.appendChild(document.createElement('br'));
        para.appendChild(document.createTextNode(line));
      });
      el.appendChild(para);
    });
  }

  function fillMedia(post) {
    var box = popup.querySelector('.xl-media');
    var gal = popup.querySelector('.xl-galwrap');
    box.innerHTML = '';
    gal.innerHTML = '';
    box.classList.toggle('xl-textonly', post.kind === 'text');
    sizePanel(post);
    if (post.kind === 'text') return;

    if (post.kind === 'video') {
      box.appendChild(videoShot(post));
      return;
    }

    box.appendChild(imageShot(post, 0));
    if (post.images.length > 1) {
      gal.appendChild(galleryRow(post, function (i) {
        box.replaceChild(imageShot(post, i), box.querySelector('.xl-shot'));
      }));
    }
  }

  function fillStrip(post) {
    var wrap = popup.querySelector('.xl-more');
    var strip = popup.querySelector('.xl-strip');
    strip.innerHTML = '';
    var near = neighbours(post);
    wrap.hidden = !near.length;
    if (!near.length) return;
    near.forEach(function (n) {
      var b = document.createElement('button');
      b.className = 'xl-near';
      b.title = '@' + (n.post.handle || '') + '  ·  ' +
                Math.round(n.w * 100) + '% similar';
      var im = document.createElement('img');
      im.alt = '';
      b.appendChild(im);
      b.classList.add('skel');
      im.onload = function () { b.classList.remove('skel'); };
      thumb(n.post, function (img) {
        if (img) { im.src = img.src; return; }
        b.classList.remove('skel');
        // Every text-only post's nearest neighbours are also text-only - they
        // are embedded from words alone and cluster away from everything with
        // a picture - so the tile has to carry the text itself.
        b.classList.add('xl-near-text');
        im.remove();
        var t = document.createElement('span');
        t.textContent = (n.post.text || n.post.caption || '').slice(0, 70);
        b.appendChild(t);
      });
      b.onclick = function () { open(n.post); };
      strip.appendChild(b);
    });
  }

  function close() {
    if (!popup) return;
    popup.querySelector('.xl-media').innerHTML = '';
    popup.hidden = true;
    document.body.classList.remove('xl-locked');
    state.restore.post = null;
    url.write();
  }

  function isOpen() { return !!(popup && !popup.hidden); }

  /* --------------------------------------------------------------- misc */

  function setOffline(on) {
    state.offline = !!on;
    localStorage.setItem('xl-offline', on ? '1' : '0');
    state.posts.forEach(function (p) { delete p._thumb; });
  }

  function fmtCount(n) { return n.toLocaleString(); }

  // `/` to search, `m`/`g` to switch view - ignored while typing.
  function shortcuts(opts) {
    document.addEventListener('keydown', function (e) {
      var el = document.activeElement, tag = el && el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') el.blur();
        return;
      }
      if (isOpen()) return;
      if (e.key === '/') { e.preventDefault(); if (opts.search) opts.search.focus(); }
      else if (e.key === 'm') location.href = url.link('index.html');
      else if (e.key === 'g') location.href = url.link('grid.html');
      else if (e.key === 'Escape' && opts.clear) opts.clear();
    });
  }

  // Tell the launcher this window is still open, so it can shut the server
  // down once it is closed. Served by tools/serve.py; harmless anywhere else.
  setInterval(function () {
    fetch('/__alive', { cache: 'no-store' }).catch(function () {});
  }, 2000);

  global.XL = {
    state: state, filter: filter, url: url, load: load, adopt: adopt,
    thumb: thumb, cached: cached, cancelPending: cancelPending,
    matches: matches, filterActive: filterActive, toggle: toggle,
    clearAll: clearAll, setLasso: setLasso, neighbours: neighbours,
    open: open, close: close, isOpen: isOpen, setOffline: setOffline,
    clusterColor: clusterColor, videoSources: videoSources,
    fullImageSources: fullImageSources, fmtCount: fmtCount,
    shortcuts: shortcuts
  };
})(window);
