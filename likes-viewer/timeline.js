/* Brushable histogram of likes over time, shared by both views.

   Bars are drawn in two tones: the whole archive behind, the current filter
   result in front, so the strip doubles as a readout of *when* you liked
   whatever you are currently looking at. */
(function (global) {
  'use strict';

  var MS_LABEL = 22;      // room under the bars for year ticks

  function create(opts) {
    var canvas = opts.canvas;
    var ctx = canvas.getContext('2d');
    var onChange = opts.onChange || function () {};
    var bins = [];
    var range = null;       // committed [t0, t1]
    var drag = null;        // {x0, x1} while the pointer is down
    var hover = -1;

    function monthStart(d) { return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1); }

    function build(posts) {
      var dated = posts.filter(function (p) { return p.t; });
      if (!dated.length) { bins = []; return; }
      var lo = Infinity, hi = -Infinity;
      dated.forEach(function (p) {
        if (p.t < lo) lo = p.t;
        if (p.t > hi) hi = p.t;
      });
      var start = monthStart(new Date(lo)), end = monthStart(new Date(hi));
      bins = [];
      var d = new Date(start);
      while (d.getTime() <= end) {
        var t0 = d.getTime();
        d.setUTCMonth(d.getUTCMonth() + 1);
        bins.push({ t0: t0, t1: d.getTime() - 1, total: 0, hit: 0 });
      }
      dated.forEach(function (p) {
        var i = indexOf(p.t);
        if (i >= 0) bins[i].total++;
      });
    }

    function indexOf(t) {
      // Months are uneven, so walk rather than divide. Cheap at ~140 bins.
      for (var i = bins.length - 1; i >= 0; i--) {
        if (t >= bins[i].t0) return i;
      }
      return -1;
    }

    function update(matched) {
      bins.forEach(function (b) { b.hit = 0; });
      matched.forEach(function (p) {
        if (!p.t) return;
        var i = indexOf(p.t);
        if (i >= 0) bins[i].hit++;
      });
      draw();
    }

    function resize() {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    }

    function xOf(i) { return i / bins.length * canvas.clientWidth; }
    function binAt(x) {
      return Math.max(0, Math.min(bins.length - 1,
        Math.floor(x / canvas.clientWidth * bins.length)));
    }

    function draw() {
      var w = canvas.clientWidth, h = canvas.clientHeight;
      var bh = h - MS_LABEL;
      ctx.clearRect(0, 0, w, h);
      if (!bins.length) return;

      var max = 0;
      bins.forEach(function (b) { if (b.total > max) max = b.total; });
      if (!max) return;

      var bw = w / bins.length;
      var sel = selection();

      for (var i = 0; i < bins.length; i++) {
        var b = bins[i];
        var x = xOf(i);
        var inSel = !sel || (b.t1 >= sel[0] && b.t0 <= sel[1]);
        var th = Math.max(1, b.total / max * (bh - 2));
        ctx.fillStyle = inSel ? 'rgba(138,155,175,.30)' : 'rgba(138,155,175,.10)';
        ctx.fillRect(x, bh - th, Math.max(1, bw - 0.5), th);
        if (b.hit) {
          var hh = Math.max(1, b.hit / max * (bh - 2));
          ctx.fillStyle = inSel ? '#6ea8fe' : 'rgba(110,168,254,.22)';
          ctx.fillRect(x, bh - hh, Math.max(1, bw - 0.5), hh);
        }
        if (i === hover) {
          ctx.fillStyle = 'rgba(255,255,255,.14)';
          ctx.fillRect(x, 0, Math.max(1, bw - 0.5), bh);
        }
      }

      // year ticks
      ctx.font = '9px "Segoe UI", system-ui, sans-serif';
      ctx.fillStyle = '#6b7785';
      ctx.textAlign = 'center';
      var lastYear = null, lastLabelX = -Infinity;
      for (var j = 0; j < bins.length; j++) {
        var y = new Date(bins[j].t0).getUTCFullYear();
        if (y === lastYear) continue;
        lastYear = y;
        var xx = xOf(j);
        ctx.fillStyle = 'rgba(138,155,175,.22)';
        ctx.fillRect(xx, bh, 1, 3);
        // Early years hold a handful of posts each and their ticks bunch up;
        // only label one when there is room for the text.
        var lx = xx + bw * 3;
        if (bins.length - j > 6 && lx - lastLabelX > 20) {
          lastLabelX = lx;
          ctx.fillStyle = '#6b7785';
          ctx.fillText("'" + String(y).slice(2), lx, h - 4);
        }
      }
      ctx.textAlign = 'start';

      if (sel) {
        var a = clampX(sel[0]), bx = clampX(sel[1]);
        ctx.strokeStyle = '#6ea8fe';
        ctx.lineWidth = 1;
        ctx.strokeRect(a + .5, .5, Math.max(1, bx - a - 1), bh - 1);
        ctx.fillStyle = 'rgba(110,168,254,.09)';
        ctx.fillRect(a, 0, Math.max(1, bx - a), bh);
      }
    }

    function clampX(t) {
      var i = indexOf(t);
      if (i < 0) return 0;
      return xOf(i);
    }

    function selection() {
      if (drag) {
        var i0 = binAt(Math.min(drag.x0, drag.x1));
        var i1 = binAt(Math.max(drag.x0, drag.x1));
        return [bins[i0].t0, bins[i1].t1];
      }
      return range;
    }

    function commit() {
      var sel = selection();
      // A whole-span selection is the same as no filter; treat it as a clear.
      if (sel && bins.length && sel[0] <= bins[0].t0 && sel[1] >= bins[bins.length - 1].t1) {
        sel = null;
      }
      range = sel;
      draw();
      onChange(range);
    }

    canvas.addEventListener('pointerdown', function (e) {
      var r = canvas.getBoundingClientRect();
      var x = e.clientX - r.left;
      drag = { x0: x, x1: x };
      canvas.setPointerCapture(e.pointerId);
      draw();
    });

    canvas.addEventListener('pointermove', function (e) {
      var r = canvas.getBoundingClientRect();
      var x = e.clientX - r.left;
      if (drag) { drag.x1 = x; draw(); return; }
      var i = bins.length ? binAt(x) : -1;
      if (i !== hover) {
        hover = i;
        if (bins[i]) {
          var d = new Date(bins[i].t0);
          canvas.title = d.toLocaleString(undefined,
            { month: 'short', year: 'numeric', timeZone: 'UTC' }) +
            ' — ' + bins[i].total + ' liked';
        }
        draw();
      }
    });

    canvas.addEventListener('pointerup', function (e) {
      if (!drag) return;
      canvas.releasePointerCapture(e.pointerId);
      var moved = Math.abs(drag.x1 - drag.x0) > 3;
      if (!moved) {
        // A click with no drag selects that single month.
        var i = binAt(drag.x0);
        drag = null;
        range = bins[i] ? [bins[i].t0, bins[i].t1] : null;
        draw();
        onChange(range);
        return;
      }
      drag = null;
      commit();
    });

    canvas.addEventListener('pointerleave', function () {
      if (hover !== -1) { hover = -1; draw(); }
    });

    canvas.addEventListener('dblclick', function () {
      range = null;
      draw();
      onChange(null);
    });

    window.addEventListener('resize', resize);

    return {
      build: function (posts) { build(posts); resize(); },
      update: update,
      setRange: function (r) { range = r; draw(); },
      range: function () { return range; }
    };
  }

  global.XLTimeline = { create: create };
})(window);
