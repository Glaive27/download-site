/*
 * Liquid Glass —— 移植自 Glass.py (moderngl 透镜折射着色器)
 * - 启动即用程序化深色渐变初始化纹理, 保证第一帧就渲染背景 + 玻璃球
 * - 壁纸加载成功 (CORS 干净) 则无缝替换为 Tahoe 壁纸; 失败保留渐变
 * - 3 个液体玻璃球, 各自带速度, 碰屏幕边缘反弹
 */
(function () {
  "use strict";

  var canvas = document.createElement("canvas");
  canvas.id = "glass-canvas";
  document.body.appendChild(canvas);

  var gl =
    canvas.getContext("webgl", { alpha: true, antialias: true, premultipliedAlpha: false }) ||
    canvas.getContext("experimental-webgl", { alpha: true });
  if (!gl) {
    console.warn("[glass] WebGL 不可用, 回退到 CSS 壁纸");
    canvas.remove();
    return;
  }

  var WALLPAPER_URL = "/api/wallpaper";

  // ---------- 着色器 ----------
  var BG_VERT = [
    "attribute vec2 in_vert;",
    "attribute vec2 in_tex;",
    "varying vec2 texCoord;",
    "void main() {",
    "  gl_Position = vec4(in_vert * 2.0, 0.0, 1.0);",
    "  texCoord = in_tex + 0.5;",
    "}"
  ].join("\n");

  var BG_FRAG = [
    "precision highp float;",
    "varying vec2 texCoord;",
    "uniform sampler2D tex;",
    "void main() {",
    "  gl_FragColor = texture2D(tex, texCoord);",
    "}"
  ].join("\n");

  var GLASS_VERT = [
    "attribute vec2 in_vert;",
    "attribute vec2 in_tex;",
    "varying vec2 texCoord;",
    "varying vec2 crCoord;",
    "uniform vec2 pos;",
    "uniform float diameter;",
    "uniform vec2 resolution;",
    "void main() {",
    "  vec2 vert = pos + in_vert * diameter * 1.0625;",
    "  vert = (vert / resolution) * 2.0 - 1.0;",
    "  vert = vec2(vert.x, -vert.y);",
    "  gl_Position = vec4(vert, 0.0, 1.0);",
    "  texCoord = vec2(vert.x, -vert.y) * 0.5 + 0.5;",
    "  crCoord = in_tex * 1.0625;",
    "}"
  ].join("\n");

  var GLASS_FRAG = [
    "precision highp float;",
    "varying vec2 texCoord;",
    "varying vec2 crCoord;",
    "uniform vec2 pos;",
    "uniform vec2 resolution;",
    "uniform float diameter;",
    "uniform float refr;",
    "uniform sampler2D img;",
    "uniform vec4 color;",
    "vec4 sampleWall(vec2 tc) { return texture2D(img, tc); }",
    "void main() {",
    "  float dist = distance(crCoord, vec2(0.0));",
    "  vec2 center = pos / resolution;",
    "  vec2 tex = texCoord - center;",
    "  float dis2x = dist * 2.0;",
    "  float sq = sqrt(max(1.0 - dis2x * dis2x, 0.0));",
    "  float num = refr / max(sq, 0.001) - refr;",
    "  vec3 col = sampleWall(tex * (1.0 - num) + center).rgb;",
    "  vec3 reb = sampleWall(tex * (1.0 + num) + center).rgb;",
    "  num = abs(num);",
    "  col *= clamp(1.03125 - num * 0.25, 0.625, 1.0) + clamp(num * 0.125 - 0.0625, 0.0, 0.25);",
    "  if (color.a > 0.0) {",
    "    float cnum = dot(col, color.rgb) / (color.r + color.g + color.b);",
    "    cnum = sqrt(cnum);",
    "    col += (color.rgb * cnum - col) * color.a;",
    "  }",
    "  col = mix(col + clamp(num * 0.25 - 0.0625, 0.0, 0.5) * 0.5,",
    "            reb, clamp(dist * (1.0 + num) - 0.5625, 0.0, 1.0) * 0.75);",
    "  float alpha = clamp((0.5 - dist) * diameter * 0.5, 0.0, 1.0);",
    "  float rim = smoothstep(0.40, 0.5, dist) * (1.0 - smoothstep(0.5, 0.52, dist));",
    "  col += rim * 0.18;",
    "  gl_FragColor = mix(vec4(0.0, 0.0, 0.0, clamp(0.53125 - dist, 0.0, 1.0)),",
    "                  vec4(col, 1.0), alpha);",
    "}"
  ].join("\n");

  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error("[glass] shader error:", gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }
  function program(vs, fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error("[glass] link error:", gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  }

  var bgProg = program(BG_VERT, BG_FRAG);
  var glassProg = program(GLASS_VERT, GLASS_FRAG);
  if (!bgProg || !glassProg) {
    console.warn("[glass] 着色器编译失败, 回退 CSS 壁纸");
    canvas.remove();
    return;
  }

  var quad = new Float32Array([
    -0.5, -0.5, -0.5, 0.5,
     0.5, -0.5,  0.5, 0.5,
     0.5,  0.5,  0.5, -0.5,
    -0.5,  0.5, -0.5, -0.5
  ]);
  var vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

  function bindAttribs(p) {
    var aVert = gl.getAttribLocation(p, "in_vert");
    var aTex = gl.getAttribLocation(p, "in_tex");
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.enableVertexAttribArray(aVert);
    gl.vertexAttribPointer(aVert, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aTex);
    gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);
  }

  gl.disable(gl.DEPTH_TEST);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // ---------- 纹理 ----------
  var tex = gl.createTexture();
  var texReady = false;

  function uploadTexture(src) {
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      texReady = true;
      return true;
    } catch (e) {
      console.warn("[glass] 纹理上传失败:", e);
      return false;
    }
  }

  // 程序化深色渐变 (Tahoe 风格兜底, 启动即用)
  function makeFallbackTexture() {
    var c = document.createElement("canvas");
    c.width = 512; c.height = 512;
    var g = c.getContext("2d");
    var lin = g.createLinearGradient(0, 0, 512, 512);
    lin.addColorStop(0.0, "#0a1230");
    lin.addColorStop(0.45, "#0e2a3a");
    lin.addColorStop(0.75, "#241433");
    lin.addColorStop(1.0, "#0a0f24");
    g.fillStyle = lin;
    g.fillRect(0, 0, 512, 512);
    var rg = g.createRadialGradient(150, 140, 10, 150, 140, 380);
    rg.addColorStop(0, "rgba(90,170,230,0.40)");
    rg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rg;
    g.fillRect(0, 0, 512, 512);
    uploadTexture(c);
  }

  // 启动立即有背景, 保证第一帧就渲染
  makeFallbackTexture();

  // 异步尝试加载真实壁纸, CORS 干净才替换
  var img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = function () {
    if (uploadTexture(img)) {
      console.info("[glass] 已加载壁纸纹理");
    } else {
      console.warn("[glass] 壁纸被 CORS 限制, 保留渐变兜底");
    }
  };
  img.onerror = function () {
    console.warn("[glass] 壁纸加载失败, 保留渐变兜底");
  };
  img.src = WALLPAPER_URL;

  // ---------- 3 个反弹玻璃球 ----------
  var orbs = [];
  function initOrbs() {
    orbs = [
      { r: 160, refract: 0.32, vx: 90, vy: 70, color: [0.55, 0.8, 1.0, 0.10] },
      { r: 130, refract: 0.28, vx: -75, vy: 95, color: [0.7, 0.6, 1.0, 0.10] },
      { r: 190, refract: 0.36, vx: 60, vy: -85, color: [0.6, 1.0, 0.85, 0.10] }
    ];
    var W = canvas.width, H = canvas.height;
    orbs[0].x = W * 0.30; orbs[0].y = H * 0.35;
    orbs[1].x = W * 0.65; orbs[1].y = H * 0.55;
    orbs[2].x = W * 0.50; orbs[2].y = H * 0.75;
  }

  // ---------- 尺寸 ----------
  var dpr = Math.min(window.devicePixelRatio || 1, 2);
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
    gl.viewport(0, 0, canvas.width, canvas.height);
    if (orbs.length === 0) initOrbs();
  }
  window.addEventListener("resize", resize);
  resize();

  // ---------- 渲染循环 ----------
  var last = performance.now();
  function frame(now) {
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    var W = canvas.width, H = canvas.height;

    for (var i = 0; i < orbs.length; i++) {
      var o = orbs[i];
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      if (o.x < o.r) { o.x = o.r; o.vx = Math.abs(o.vx); }
      else if (o.x > W - o.r) { o.x = W - o.r; o.vx = -Math.abs(o.vx); }
      if (o.y < o.r) { o.y = o.r; o.vy = Math.abs(o.vy); }
      else if (o.y > H - o.r) { o.y = H - o.r; o.vy = -Math.abs(o.vy); }
    }

    // 球体互相反弹 (二维弹性碰撞, 质量正比于半径平方)
    var REST = 1.0; // 完全弹性
    for (var a = 0; a < orbs.length; a++) {
      for (var b = a + 1; b < orbs.length; b++) {
        var A = orbs[a], B = orbs[b];
        var dx = B.x - A.x, dy = B.y - A.y;
        var dist = Math.sqrt(dx * dx + dy * dy);
        var minD = A.r + B.r;
        if (dist > 0 && dist < minD) {
          var nx = dx / dist, ny = dy / dist;
          // 位置分离, 按质量反比推开, 避免粘连
          var ma = A.r * A.r, mb = B.r * B.r, tot = ma + mb;
          var overlap = minD - dist;
          A.x -= nx * overlap * (mb / tot);
          A.y -= ny * overlap * (mb / tot);
          B.x += nx * overlap * (ma / tot);
          B.y += ny * overlap * (ma / tot);
          // 沿法向的相对速度 (A 相对 B)
          var vn = (A.vx - B.vx) * nx + (A.vy - B.vy) * ny;
          if (vn > 0) {
            // 正在靠近, 施加冲量
            var j = -(1 + REST) * vn / (1 / ma + 1 / mb);
            A.vx += (j / ma) * nx; A.vy += (j / ma) * ny;
            B.vx -= (j / mb) * nx; B.vy -= (j / mb) * ny;
          }
        }
      }
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (!texReady) {
      // 极端兜底: 纹理仍不可用, 用纯色背景至少让球可见
      gl.clearColor(0.02, 0.05, 0.12, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      gl.useProgram(bgProg);
      bindAttribs(bgProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(bgProg, "tex"), 0);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    }

    gl.useProgram(glassProg);
    bindAttribs(glassProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(glassProg, "img"), 0);
    gl.uniform2f(gl.getUniformLocation(glassProg, "resolution"), W, H);
    for (var j = 0; j < orbs.length; j++) {
      var b = orbs[j];
      var dia = b.r * 2 * (1 + Math.sin(now / 1000 + j) * 0.012);
      gl.uniform2f(gl.getUniformLocation(glassProg, "pos"), b.x, b.y);
      gl.uniform1f(gl.getUniformLocation(glassProg, "diameter"), dia);
      gl.uniform1f(
        gl.getUniformLocation(glassProg, "refr"),
        b.refract + Math.sin(now / 1400 + j) * 0.02
      );
      gl.uniform4f(
        gl.getUniformLocation(glassProg, "color"),
        b.color[0], b.color[1], b.color[2], b.color[3]
      );
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) last = performance.now();
  });

  console.info("[glass] 初始化完成, texReady=", texReady);
})();
