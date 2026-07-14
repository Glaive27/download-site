/*
 * Liquid Glass —— 移植自 Glass.py (moderngl 透镜折射着色器)
 * - 背景: macOS Tahoe 壁纸 (带 CORS 兜底, 失败则用程序化深色渐变)
 * - 3 个液体玻璃球, 各自带速度, 碰屏幕边缘反弹
 * - 折射核心: 球面透镜位移 + 边缘 rebound 高光 (见 Glass_Frag)
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

  var WALLPAPER_URL =
    "https://static.applewalls.com/macOS/macOS%2026%20Tahoe/compress/26-Tahoe-Dark-6K.webp";

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
    "  gl_FragColor = texture2D(tex, vec2(texCoord.x, 1.0 - texCoord.y));",
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
    "uniform float refract;",
    "uniform sampler2D img;",
    "uniform vec4 color;",
    "vec4 sampleWall(vec2 tc) { return texture2D(img, vec2(tc.x, 1.0 - tc.y)); }",
    "void main() {",
    "  float dist = distance(crCoord, vec2(0.0));",
    "  vec2 center = pos / resolution;",
    "  vec2 tex = texCoord - center;",
    "  float dis2x = dist * 2.0;",
    "  float sq = sqrt(max(1.0 - dis2x * dis2x, 0.0));",
    "  float num = refract / max(sq, 0.001) - refract;",
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
    "  fragColor = mix(vec4(0.0, 0.0, 0.0, clamp(0.53125 - dist, 0.0, 1.0)),",
    "                  vec4(col, 1.0), clamp((0.5 - dist) * diameter * 0.5, 0.0, 1.0));",
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

  // 单位四边形: 顶点 + 纹理坐标
  var quad = new Float32Array([
    -0.5, -0.5, -0.5, 0.5,
     0.5, -0.5,  0.5, 0.5,
     0.5,  0.5,  0.5, -0.5,
    -0.5,  0.5, -0.5, -0.5
  ]);
  var vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);

  function bindAttribs(prog) {
    var aVert = gl.getAttribLocation(prog, "in_vert");
    var aTex = gl.getAttribLocation(prog, "in_tex");
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

  function uploadTextureFromSource(src) {
    try {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      texReady = true;
    } catch (e) {
      console.warn("[glass] 纹理上传失败 (可能 CORS 限制):", e);
      texReady = false;
    }
  }

  // 程序化深色渐变 (Tahoe 风格兜底, 不依赖外网)
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
    var rg = g.createRadialGradient(180, 160, 20, 180, 160, 360);
    rg.addColorStop(0, "rgba(80,160,220,0.35)");
    rg.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = rg;
    g.fillRect(0, 0, 512, 512);
    uploadTextureFromSource(c);
  }

  var img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = function () {
    uploadTextureFromSource(img);
    if (!texReady) makeFallbackTexture();
  };
  img.onerror = function () {
    console.warn("[glass] 壁纸加载失败, 使用程序化兜底");
    makeFallbackTexture();
  };
  img.src = WALLPAPER_URL;
  // 兜底: 若 4 秒内既无 onload 也无 onerror (如网络挂起), 先用渐变顶上
  setTimeout(function () {
    if (!texReady) makeFallbackTexture();
  }, 4000);

  // ---------- 3 个反弹玻璃球 ----------
  var orbs = [];
  function initOrbs() {
    orbs = [
      { r: 150, refract: 0.30, vx: 90, vy: 70, color: [0.55, 0.8, 1.0, 0.0] },
      { r: 120, refract: 0.26, vx: -75, vy: 95, color: [0.7, 0.6, 1.0, 0.0] },
      { r: 180, refract: 0.34, vx: 60, vy: -85, color: [0.6, 1.0, 0.85, 0.0] }
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

    // 物理: 反弹
    for (var i = 0; i < orbs.length; i++) {
      var o = orbs[i];
      o.x += o.vx * dt;
      o.y += o.vy * dt;
      if (o.x < o.r) { o.x = o.r; o.vx = Math.abs(o.vx); }
      else if (o.x > W - o.r) { o.x = W - o.r; o.vx = -Math.abs(o.vx); }
      if (o.y < o.r) { o.y = o.r; o.vy = Math.abs(o.vy); }
      else if (o.y > H - o.r) { o.y = H - o.r; o.vy = -Math.abs(o.vy); }
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (texReady) {
      // 背景: 全屏铺壁纸
      gl.useProgram(bgProg);
      bindAttribs(bgProg);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(bgProg, "tex"), 0);
      gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

      // 3 个玻璃球
      gl.useProgram(glassProg);
      bindAttribs(glassProg);
      gl.uniform1i(gl.getUniformLocation(glassProg, "img"), 0);
      gl.uniform2f(gl.getUniformLocation(glassProg, "resolution"), W, H);
      for (var j = 0; j < orbs.length; j++) {
        var b = orbs[j];
        var dia = b.r * 2 * (1 + Math.sin(now / 1000 + j) * 0.012);
        gl.uniform2f(gl.getUniformLocation(glassProg, "pos"), b.x, b.y);
        gl.uniform1f(gl.getUniformLocation(glassProg, "diameter"), dia);
        gl.uniform1f(
          gl.getUniformLocation(glassProg, "refract"),
          b.refract + Math.sin(now / 1400 + j) * 0.02
        );
        gl.uniform4f(
          gl.getUniformLocation(glassProg, "color"),
          b.color[0], b.color[1], b.color[2], b.color[3]
        );
        gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
      }
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // 页面隐藏时暂停渲染, 省电
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) {
      last = performance.now();
    }
  });
})();
