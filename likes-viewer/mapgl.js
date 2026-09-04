/* WebGL2 renderer for the topic map.

   Canvas 2D draws each post with save/clip/arc/drawImage/restore, which is why
   it could only afford thumbnails once they were big enough to be worth it.
   Here every post is one instance of a unit quad sampling a shared atlas, so
   the whole archive draws in a single call and every post can show its picture
   at any zoom.

   Three programs: hulls (triangle fans, radial falloff), edges (additive
   lines), and nodes (instanced quads, circle mask in the fragment shader).
   Text and the lasso stay on a 2D overlay above this canvas. */
(function (global) {
  'use strict';

  var NODE_VS = `#version 300 es
  precision highp float;
  in vec2 a_corner;          // unit quad, -1..1
  in vec2 a_pos;             // world position
  in float a_radius;
  in vec2 a_tile;            // atlas tile origin, normalised
  in vec3 a_color;
  in float a_flags;          // 1 = has image, 2 = video, 4 = text
  in float a_alpha;
  in float a_hover;

  uniform vec2 u_res;
  uniform vec3 u_view;       // k, tx, ty
  uniform vec2 u_tileScale;  // tile size / sheet size

  out vec2 v_local;
  out vec2 v_uv;
  out vec3 v_color;
  out float v_alpha;
  out float v_flags;
  out float v_hover;
  out float v_screenR;

  void main() {
    float r = a_radius * (1.0 + 0.14 * a_hover);
    vec2 world = a_pos + a_corner * r;
    vec2 screen = world * u_view.x + u_view.yz;
    gl_Position = vec4(screen.x / u_res.x * 2.0 - 1.0,
                       1.0 - screen.y / u_res.y * 2.0, 0.0, 1.0);
    v_local = a_corner;
    v_uv = a_tile + (a_corner * 0.5 + 0.5) * u_tileScale;
    v_color = a_color;
    v_alpha = a_alpha;
    v_flags = a_flags;
    v_hover = a_hover;
    v_screenR = r * u_view.x;
  }`;

  var NODE_FS = `#version 300 es
  precision highp float;
  in vec2 v_local;
  in vec2 v_uv;
  in vec3 v_color;
  in float v_alpha;
  in float v_flags;
  in float v_hover;
  in float v_screenR;

  uniform sampler2D u_atlas;
  out vec4 outColor;

  // signed area test, used for the little play triangle
  float side(vec2 p, vec2 a, vec2 b) {
    return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
  }

  void main() {
    float d = length(v_local);
    float aa = fwidth(d) * 1.2;
    if (d > 1.0 + aa) discard;

    bool hasImage = mod(v_flags, 2.0) >= 1.0;
    bool isVideo = mod(floor(v_flags / 2.0), 2.0) >= 1.0;

    // A 5px photo is mush, and 3,500 of them bury the topic structure. Fade
    // from a solid cluster-coloured point into the real picture as it grows
    // large enough to read.
    float show = smoothstep(4.0, 13.0, v_screenR);
    vec3 col = v_color * 0.34;
    if (hasImage) col = mix(col, texture(u_atlas, v_uv).rgb, show);
    col = mix(v_color, col, max(show, 0.15));

    float ringW = clamp(2.2 / max(v_screenR, 1.0), 0.06, 0.9);
    float ring = smoothstep(1.0 - ringW - aa, 1.0 - ringW, d);
    col = mix(col, v_color, ring * 0.85 * show);

    if (isVideo && v_screenR > 9.0) {
      float bd = d / 0.30;
      if (bd < 1.0) col = mix(col, vec3(0.0), 0.5);
      vec2 p = v_local / 0.30;
      vec2 a = vec2(-0.34, -0.46), b = vec2(0.5, 0.0), c = vec2(-0.34, 0.46);
      if (side(p, a, b) >= 0.0 && side(p, b, c) >= 0.0 && side(p, c, a) >= 0.0) {
        col = vec3(1.0);
      }
    }

    float alpha = v_alpha * (1.0 - smoothstep(1.0 - aa, 1.0, d));
    if (v_hover > 0.0) col = mix(col, vec3(0.72, 0.84, 1.0), 0.18 * v_hover);
    outColor = vec4(col, alpha);
  }`;

  var EDGE_VS = `#version 300 es
  precision highp float;
  in vec2 a_pos;
  in float a_alpha;
  uniform vec2 u_res;
  uniform vec3 u_view;
  out float v_alpha;
  void main() {
    vec2 s = a_pos * u_view.x + u_view.yz;
    gl_Position = vec4(s.x / u_res.x * 2.0 - 1.0, 1.0 - s.y / u_res.y * 2.0, 0.0, 1.0);
    v_alpha = a_alpha;
  }`;

  var EDGE_FS = `#version 300 es
  precision highp float;
  in float v_alpha;
  uniform float u_gain;
  out vec4 outColor;
  void main() {
    outColor = vec4(vec3(0.35, 0.47, 0.66) * v_alpha * u_gain, 1.0);
  }`;

  var HULL_VS = `#version 300 es
  precision highp float;
  in vec2 a_pos;
  in vec3 a_color;
  in float a_t;        // 0 at the centroid, 1 at the rim
  in float a_alpha;
  uniform vec2 u_res;
  uniform vec3 u_view;
  out vec3 v_color;
  out float v_fade;
  void main() {
    vec2 s = a_pos * u_view.x + u_view.yz;
    gl_Position = vec4(s.x / u_res.x * 2.0 - 1.0, 1.0 - s.y / u_res.y * 2.0, 0.0, 1.0);
    v_color = a_color;
    v_fade = (1.0 - a_t) * a_alpha;
  }`;

  var HULL_FS = `#version 300 es
  precision highp float;
  in vec3 v_color;
  in float v_fade;
  out vec4 outColor;
  void main() { outColor = vec4(v_color, v_fade * 0.16); }`;

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src.replace(/^\s+/, ''));
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed');
    }
    return sh;
  }

  function program(gl, vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || 'link failed');
    }
    var loc = { program: p, a: {}, u: {} };
    var na = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (var i = 0; i < na; i++) {
      var an = gl.getActiveAttrib(p, i).name;
      loc.a[an] = gl.getAttribLocation(p, an);
    }
    var nu = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var j = 0; j < nu; j++) {
      var un = gl.getActiveUniform(p, j).name;
      loc.u[un] = gl.getUniformLocation(p, un);
    }
    return loc;
  }

  function create(canvas) {
    var gl = canvas.getContext('webgl2', {
      alpha: false, antialias: false, depth: false,
      premultipliedAlpha: false, powerPreference: 'high-performance'
    });
    if (!gl) return null;

    var progs;
    try {
      progs = {
        node: program(gl, NODE_VS, NODE_FS),
        edge: program(gl, EDGE_VS, EDGE_FS),
        hull: program(gl, HULL_VS, HULL_FS)
      };
    } catch (e) {
      console.warn('WebGL setup failed, falling back to canvas 2D:', e.message);
      return null;
    }

    var quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER,
                  new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    var state = {
      gl: gl, progs: progs, quad: quad,
      atlas: null, tileScale: [1, 1],
      nodes: [], count: 0,
      vaoNodes: null, bStatic: null, bAlpha: null, bHover: null,
      alpha: null, hover: null,
      vaoEdges: null, bEdgePos: null, bEdgeAlpha: null, edgeCount: 0,
      edgeAlpha: null, edges: [],
      vaoHulls: null, bHullPos: null, bHullAlpha: null, hullCount: 0,
      hullAlpha: null, hullRanges: [],
      detail: new Map(), detailOrder: []
    };

    /* ------------------------------------------------------------- atlas */

    function setAtlas(image, meta) {
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      state.atlas = tex;
      state.tileScale = [meta.tile / meta.sheet, meta.tile / meta.sheet];
    }

    /* ------------------------------------------------------------- nodes */

    // rgb 0..1 from the 'hsl(h s% l%)' strings clusterColor() produces
    function rgb(css) {
      var m = css.match(/hsl\(([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/);
      if (!m) return [0.4, 0.5, 0.6];
      var h = +m[1] / 360, s = +m[2] / 100, l = +m[3] / 100;
      var c = (1 - Math.abs(2 * l - 1)) * s;
      var x = c * (1 - Math.abs(((h * 6) % 2) - 1));
      var mm = l - c / 2, r = 0, g2 = 0, b = 0;
      var seg = Math.floor(h * 6) % 6;
      if (seg === 0) { r = c; g2 = x; }
      else if (seg === 1) { r = x; g2 = c; }
      else if (seg === 2) { g2 = c; b = x; }
      else if (seg === 3) { g2 = x; b = c; }
      else if (seg === 4) { r = x; b = c; }
      else { r = c; b = x; }
      return [r + mm, g2 + mm, b + mm];
    }

    // pos(2) radius(1) tile(2) color(3) flags(1) = 9 floats per instance
    var STRIDE = 9;

    function setNodes(nodes, atlasIndex, colorOf) {
      state.nodes = nodes;
      state.count = nodes.length;
      var data = new Float32Array(nodes.length * STRIDE);
      state.alpha = new Float32Array(nodes.length);
      state.hover = new Float32Array(nodes.length);

      var ts = state.tileScale[0];
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i], o = i * STRIDE;
        var col = rgb(colorOf(n));
        var tile = atlasIndex ? atlasIndex[n.post.id] : null;
        var flags = 0;
        if (tile) flags |= 1;
        if (n.post.kind === 'video') flags |= 2;
        if (n.post.kind === 'text') flags |= 4;

        data[o] = n.x; data[o + 1] = n.y;
        data[o + 2] = n.r;
        data[o + 3] = tile ? tile[1] * ts : 0;
        data[o + 4] = tile ? tile[2] * ts : 0;
        data[o + 5] = col[0]; data[o + 6] = col[1]; data[o + 7] = col[2];
        data[o + 8] = flags;
        state.alpha[i] = 1;
      }

      var a = progs.node.a;
      state.vaoNodes = gl.createVertexArray();
      gl.bindVertexArray(state.vaoNodes);

      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(a.a_corner);
      gl.vertexAttribPointer(a.a_corner, 2, gl.FLOAT, false, 0, 0);

      state.bStatic = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, state.bStatic);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      state.staticData = data;
      var S = STRIDE * 4;
      attr(a.a_pos, 2, S, 0);
      attr(a.a_radius, 1, S, 8);
      attr(a.a_tile, 2, S, 12);
      attr(a.a_color, 3, S, 20);
      attr(a.a_flags, 1, S, 32);

      state.bAlpha = dynamic(a.a_alpha, state.alpha);
      state.bHover = dynamic(a.a_hover, state.hover);
      gl.bindVertexArray(null);
    }

    function attr(loc, size, stride, offset) {
      if (loc === undefined || loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
      gl.vertexAttribDivisor(loc, 1);
    }

    function dynamic(loc, arr) {
      var b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.DYNAMIC_DRAW);
      if (loc !== undefined && loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 1, gl.FLOAT, false, 0, 0);
        gl.vertexAttribDivisor(loc, 1);
      }
      return b;
    }

    function setAlpha(values) {
      state.alpha.set(values);
      gl.bindBuffer(gl.ARRAY_BUFFER, state.bAlpha);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, state.alpha);
    }

    function setHover(index) {
      state.hover.fill(0);
      if (index >= 0) state.hover[index] = 1;
      gl.bindBuffer(gl.ARRAY_BUFFER, state.bHover);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, state.hover);
    }

    /* ------------------------------------------------------------- edges */

    function setEdges(edges, indexOf) {
      state.edges = edges;
      state.edgeCount = edges.length * 2;
      var pos = new Float32Array(edges.length * 4);
      state.edgeAlpha = new Float32Array(edges.length * 2);
      state.edgeIdx = new Int32Array(edges.length * 2);
      for (var i = 0; i < edges.length; i++) {
        var e = edges[i];
        pos[i * 4] = e.a.x; pos[i * 4 + 1] = e.a.y;
        pos[i * 4 + 2] = e.b.x; pos[i * 4 + 3] = e.b.y;
        var w = Math.max(0, e.w - 0.55) * 2.2;
        state.edgeAlpha[i * 2] = w;
        state.edgeAlpha[i * 2 + 1] = w;
        state.edgeIdx[i * 2] = indexOf(e.a);
        state.edgeIdx[i * 2 + 1] = indexOf(e.b);
      }
      state.edgeBase = Float32Array.from(state.edgeAlpha);

      var a = progs.edge.a;
      state.vaoEdges = gl.createVertexArray();
      gl.bindVertexArray(state.vaoEdges);
      state.bEdgePos = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, state.bEdgePos);
      gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(a.a_pos);
      gl.vertexAttribPointer(a.a_pos, 2, gl.FLOAT, false, 0, 0);

      state.bEdgeAlpha = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, state.bEdgeAlpha);
      gl.bufferData(gl.ARRAY_BUFFER, state.edgeAlpha, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(a.a_alpha);
      gl.vertexAttribPointer(a.a_alpha, 1, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }

    // An edge is only as visible as its dimmer end.
    function refreshEdges(nodeAlpha, hoverIdx) {
      if (!state.edgeAlpha) return;
      for (var i = 0; i < state.edgeAlpha.length; i += 2) {
        var ia = state.edgeIdx[i], ib = state.edgeIdx[i + 1];
        var v = Math.min(nodeAlpha[ia], nodeAlpha[ib]);
        // links touching the hovered post light right up
        var w = (hoverIdx >= 0 && (ia === hoverIdx || ib === hoverIdx))
          ? 2.4 : state.edgeBase[i];
        state.edgeAlpha[i] = w * v;
        state.edgeAlpha[i + 1] = w * v;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, state.bEdgeAlpha);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, state.edgeAlpha);
    }

    /* ------------------------------------------------------------- hulls */

    function setHulls(hulls) {
      var pos = [], colr = [], ts = [], al = [];
      state.hullRanges = [];
      hulls.forEach(function (h) {
        var start = ts.length;
        var c = rgb(h.css);
        // triangle fan: centroid, then the rim, closing back on the first point
        pos.push(h.cx, h.cy); colr.push(c[0], c[1], c[2]); ts.push(0); al.push(1);
        for (var i = 0; i <= h.pts.length; i++) {
          var p = h.pts[i % h.pts.length];
          pos.push(p[0], p[1]);
          colr.push(c[0], c[1], c[2]);
          ts.push(1);
          al.push(1);
        }
        state.hullRanges.push({ c: h.c, start: start, count: ts.length - start });
      });
      state.hullCount = ts.length;
      state.hullAlpha = new Float32Array(al);

      var a = progs.hull.a;
      state.vaoHulls = gl.createVertexArray();
      gl.bindVertexArray(state.vaoHulls);
      buf(a.a_pos, new Float32Array(pos), 2);
      buf(a.a_color, new Float32Array(colr), 3);
      buf(a.a_t, new Float32Array(ts), 1);
      state.bHullAlpha = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, state.bHullAlpha);
      gl.bufferData(gl.ARRAY_BUFFER, state.hullAlpha, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(a.a_alpha);
      gl.vertexAttribPointer(a.a_alpha, 1, gl.FLOAT, false, 0, 0);
      gl.bindVertexArray(null);
    }

    function buf(loc, arr, size) {
      var b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
      if (loc !== undefined && loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      }
      return b;
    }

    function setHullAlpha(fn) {
      if (!state.hullAlpha) return;
      state.hullRanges.forEach(function (r) {
        var v = fn(r.c);
        for (var i = r.start; i < r.start + r.count; i++) state.hullAlpha[i] = v;
      });
      gl.bindBuffer(gl.ARRAY_BUFFER, state.bHullAlpha);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, state.hullAlpha);
    }

    /* -------------------------------------------------- crisp close-ups */

    // The atlas is 64px a tile; once a post is drawn much bigger than that it
    // gets its own texture from the full thumbnail.
    var DETAIL_MAX = 48;

    function detailTexture(post, img) {
      var t = state.detail.get(post.id);
      if (t) return t;
      if (state.detailOrder.length >= DETAIL_MAX) {
        var old = state.detailOrder.shift();
        gl.deleteTexture(state.detail.get(old));
        state.detail.delete(old);
      }
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      state.detail.set(post.id, tex);
      state.detailOrder.push(post.id);
      return tex;
    }

    function hasDetail(post) { return state.detail.has(post.id); }

    // WebGL2's drawArraysInstanced has no base-instance parameter, so a
    // close-up cannot just index into the main buffer. It gets a one-instance
    // VAO that is rewritten immediately before each draw.
    var one = null;
    function detailVAO() {
      if (one) return one;
      var a = progs.node.a;
      one = { vao: gl.createVertexArray(), data: new Float32Array(STRIDE),
              alpha: new Float32Array(1), hover: new Float32Array(1) };
      gl.bindVertexArray(one.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(a.a_corner);
      gl.vertexAttribPointer(a.a_corner, 2, gl.FLOAT, false, 0, 0);
      one.bStatic = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, one.bStatic);
      gl.bufferData(gl.ARRAY_BUFFER, one.data, gl.DYNAMIC_DRAW);
      var S = STRIDE * 4;
      attr(a.a_pos, 2, S, 0);
      attr(a.a_radius, 1, S, 8);
      attr(a.a_tile, 2, S, 12);
      attr(a.a_color, 3, S, 20);
      attr(a.a_flags, 1, S, 32);
      one.bAlpha = dynamic(a.a_alpha, one.alpha);
      one.bHover = dynamic(a.a_hover, one.hover);
      gl.bindVertexArray(null);
      return one;
    }

    /* -------------------------------------------------------------- draw */

    function resize(w, h, dpr) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    function draw(view, opts) {
      var w = canvas.width, h = canvas.height, dpr = opts.dpr || 1;
      var u = [view.k * dpr, view.x * dpr, view.y * dpr];

      gl.clearColor(0.039, 0.055, 0.078, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);

      if (state.hullCount) {
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.useProgram(progs.hull.program);
        gl.uniform2f(progs.hull.u.u_res, w, h);
        gl.uniform3f(progs.hull.u.u_view, u[0], u[1], u[2]);
        gl.bindVertexArray(state.vaoHulls);
        state.hullRanges.forEach(function (r) {
          gl.drawArrays(gl.TRIANGLE_FAN, r.start, r.count);
        });
      }

      if (state.edgeCount && view.k > 0.24) {
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE);   // additive: links stack like light
        gl.useProgram(progs.edge.program);
        gl.uniform2f(progs.edge.u.u_res, w, h);
        gl.uniform3f(progs.edge.u.u_view, u[0], u[1], u[2]);
        gl.uniform1f(progs.edge.u.u_gain, Math.min(0.5, (view.k - 0.24) * 0.9));
        gl.bindVertexArray(state.vaoEdges);
        gl.drawArrays(gl.LINES, 0, state.edgeCount);
      }

      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(progs.node.program);
      gl.uniform2f(progs.node.u.u_res, w, h);
      gl.uniform3f(progs.node.u.u_view, u[0], u[1], u[2]);
      gl.uniform1i(progs.node.u.u_atlas, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, state.atlas);
      gl.uniform2f(progs.node.u.u_tileScale, state.tileScale[0], state.tileScale[1]);
      gl.bindVertexArray(state.vaoNodes);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, state.count);

      // close-ups, drawn over their atlas versions
      if (opts.detail && opts.detail.length) {
        var o = detailVAO();
        gl.bindVertexArray(o.vao);
        gl.uniform2f(progs.node.u.u_tileScale, 1, 1);
        for (var i = 0; i < opts.detail.length; i++) {
          var d = opts.detail[i], src = d.index * STRIDE;
          for (var k = 0; k < STRIDE; k++) o.data[k] = state.staticData[src + k];
          o.data[3] = 0; o.data[4] = 0;          // whole texture, not a tile
          o.alpha[0] = state.alpha[d.index];
          o.hover[0] = state.hover[d.index];
          gl.bindBuffer(gl.ARRAY_BUFFER, o.bStatic);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, o.data);
          gl.bindBuffer(gl.ARRAY_BUFFER, o.bAlpha);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, o.alpha);
          gl.bindBuffer(gl.ARRAY_BUFFER, o.bHover);
          gl.bufferSubData(gl.ARRAY_BUFFER, 0, o.hover);
          gl.bindTexture(gl.TEXTURE_2D, d.tex);
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
        }
      }
      gl.bindVertexArray(null);
    }

    return {
      gl: gl, setAtlas: setAtlas, setNodes: setNodes, setEdges: setEdges,
      setHulls: setHulls, setAlpha: setAlpha, setHover: setHover,
      refreshEdges: refreshEdges, setHullAlpha: setHullAlpha,
      detailTexture: detailTexture, hasDetail: hasDetail,
      resize: resize, draw: draw
    };
  }

  global.XLGL = { create: create };
})(window);
