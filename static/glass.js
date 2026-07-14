/*
 * Liquid Glass —— 移植自 Glass.py (moderngl 透镜折射着色器)
 * 动态昼夜背景: 根据访问者 IP 所在地的日出/日落 (wttr.in) 在
 *   - 白天:  macOS Tahoe Light 壁纸
 *   - 夜晚:  macOS Tahoe Dark 壁纸
 * 之间平滑交叉淡入淡出 (crossfade)。玻璃球折射当前(混合后的)壁纸。
 * - 启动即用程序化渐变初始化两张纹理, 保证第一帧就渲染
 * - 两张壁纸经同源代理加载 (CORS 干净); 失败保留渐变兜底
 * - 背景与玻璃折射均做 cover (等比裁剪铺满), 自适应各种屏幕
 * - wttr.in 直连获取日出日落, 每 10 分钟刷新, 每 30 秒本地判定昼夜
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

  var WALL_LIGHT = "/api/wallpaper?variant=light";
  var WALL_DARK = "/api/wallpaper?variant=dark";

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

  // 背景: 两张壁纸按 uNight 混合 (0=白天, 1=夜晚), cover 裁剪铺满
  var BG_FRAG = [
    "precision highp float;",
    "varying vec2 texCoord;",
    "uniform sampler2D texLight;",
    "uniform sampler2D texDark;",
    "uniform float uNight;",
    "uniform float uCanvasAspect;",
    "uniform float uImgAspect;",
    "vec2 coverUV(vec2 uv) {",
    "  vec2 c = uv - 0.5;",
    "  if (uCanvasAspect > uImgAspect) c.y *= uImgAspect / uCanvasAspect;",
    "  else c.x *= uCanvasAspect / uImgAspect;",
    "  return c + 0.5;",
    "}",
    "void main() {",
    "  vec2 uv = coverUV(texCoord);",
    "  vec4 a = texture2D(texLight, uv);",
    "  vec4 b = texture2D(texDark, uv);",
    "  gl_FragColor = mix(a, b, uNight);",
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
    "uniform sampler2D imgLight;",
    "uniform sampler2D imgDark;",
    "uniform float uNight;",
    "uniform float uCanvasAspect;",
    "uniform float uImgAspect;",
    "uniform vec4 color;",
    "vec2 coverUV(vec2 uv) {",
    "  vec2 c = uv - 0.5;",
    "  if (uCanvasAspect > uImgAspect) c.y *= uImgAspect / uCanvasAspect;",
    "  else c.x *= uCanvasAspect / uImgAspect;",
    "  return c + 0.5;",
    "}",
    "vec4 sampleWall(vec2 tc) {",
    "  vec2 uv = coverUV(tc);",
    "  return mix(texture2D(imgLight, uv), texture2D(imgDark, uv), uNight);",
    "}",
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

  // ---------- 纹理 (白天 + 黑夜 各一张) ----------
  var texLight = gl.createTexture();
  var texDark = gl.createTexture();
  var imgAspect = 16.0 / 9.0; // 壁纸宽高比, 加载后更新

  function uploadTexture(texObj, src) {
    try {
      gl.bindTexture(gl.TEXTURE_2D, texObj);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      return true;
    } catch (e) {
      console.warn("[glass] 纹理上传失败:", e);
      return false;
    }
  }

  // 程序化中性渐变 (兜底, 启动即用, 白天黑夜都不过分突兀)
  function makeFallbackTexture() {
    var c = document.createElement("canvas");
    c.width = 512; c.height = 512;
    var g = c.getContext("2d");
    var lin = g.createLinearGradient(0, 0, 512, 512);
    lin.addColorStop(0.0, "#243049");
    lin.addColorStop(0.5, "#2a3b54");
    lin.addColorStop(1.0, "#1a2236");
    g.fillStyle = lin;
    g.fillRect(0, 0, 512, 512);
    return c;
  }
  var fb = makeFallbackTexture();
  uploadTexture(texLight, fb);
  uploadTexture(texDark, fb);

  // 异步加载真实壁纸 (CORS 干净才替换), 并取宽高比
  function loadWall(url, texObj) {
    var img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = function () {
      if (uploadTexture(texObj, img)) {
        if (img.naturalWidth && img.naturalHeight) {
          imgAspect = img.naturalWidth / img.naturalHeight;
        }
        console.info("[glass] 壁纸纹理已加载:", url);
      } else {
        console.warn("[glass] 壁纸被 CORS 限制, 保留渐变兜底");
      }
    };
    img.onerror = function () {
      console.warn("[glass] 壁纸加载失败, 保留渐变兜底:", url);
    };
    img.src = url;
  }
  loadWall(WALL_LIGHT, texLight);
  loadWall(WALL_DARK, texDark);

  // ---------- 昼夜判定 (wttr.in 日出/日落) ----------
  var nightTarget = -1;   // -1 表示尚未获取; 0=白天, 1=夜晚
  var nightFactor = 0;    // 实际渲染值 (向 nightTarget 平滑过渡)
  var firstSun = true;    // 首次获取时直接吸附, 不做过渡
  var sun = { sr: null, ss: null, ok: false };
  var SUN_FETCH_MS = 10 * 60 * 1000; // 每 10 分钟重新获取日出日落
  var SUN_TICK_MS = 30 * 1000;       // 每 30 秒本地判定一次昼夜

  function toMin(hms) {
    var p = String(hms).split(":").map(Number);
    return (p[0] || 0) * 60 + (p[1] || 0) + (p[2] || 0) / 60;
  }
  function evalDay() {
    if (!sun.ok) return;
    var now = new Date();
    var cur = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    var isDay = cur >= sun.sr && cur < sun.ss;
    nightTarget = isDay ? 0 : 1;
  }
  function fetchSun() {
    fetch("https://wttr.in/?format=%S|%s")
      .then(function (r) { return r.text(); })
      .then(function (t) {
        var parts = t.trim().split("|");
        if (parts.length !== 2) throw new Error("格式异常: " + t);
        sun.sr = toMin(parts[0]);
        sun.ss = toMin(parts[1]);
        sun.ok = true;
        evalDay();
        if (firstSun) {
          nightFactor = nightTarget; // 首次吸附, 避免加载闪一下
          firstSun = false;
        }
        console.info("[glass] 日出/日落:", parts[0], parts[1], "夜晚=", nightTarget === 1);
      })
      .catch(function (e) {
        console.warn("[glass] 获取日出日落失败, 沿用上次结果:", e);
      });
  }
  fetchSun();
  setInterval(fetchSun, SUN_FETCH_MS);
  setInterval(evalDay, SUN_TICK_MS);

  // ---------- 1 个跟随鼠标的玻璃球 ----------
  var orbs = [];
  function initOrbs() {
    var W = canvas.width, H = canvas.height;
    orbs = [
      { r: 340, refract: 0.34, x: W * 0.5, y: H * 0.5, vx: 0, vy: 0, color: [0.6, 0.85, 1.0, 0.10] }
    ];
  }

  // 鼠标目标位置 (设备像素坐标), 初始居中
  var target = { x: 0, y: 0 };
  var mouseInit = false;
  window.addEventListener("mousemove", function (e) {
    target.x = e.clientX * dpr;
    target.y = e.clientY * dpr;
    mouseInit = true;
  });
  window.addEventListener("touchmove", function (e) {
    if (e.touches && e.touches.length) {
      target.x = e.touches[0].clientX * dpr;
      target.y = e.touches[0].clientY * dpr;
      mouseInit = true;
    }
  }, { passive: true });

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
    if (!mouseInit) { target.x = canvas.width * 0.5; target.y = canvas.height * 0.5; }
  }
  window.addEventListener("resize", resize);
  resize();

  // ---------- 渲染循环 ----------
  var last = performance.now();
  var TRANSITION_SECONDS = 2.5; // 昼夜切换交叉淡入时长

  function frame(now) {
    var dt = Math.min((now - last) / 1000, 0.05);
    last = now;

    var W = canvas.width, H = canvas.height;

    // 昼夜过渡: nightFactor 以固定速率向 nightTarget 逼近 (平滑 crossfade)
    if (nightTarget >= 0) {
      var step = dt / TRANSITION_SECONDS;
      if (nightFactor < nightTarget) nightFactor = Math.min(nightFactor + step, nightTarget);
      else if (nightFactor > nightTarget) nightFactor = Math.max(nightFactor - step, nightTarget);
    }
    // smoothstep 缓动, 让过渡更自然
    var eased = nightFactor * nightFactor * (3.0 - 2.0 * nightFactor);
    var canvasAspect = W / H;

    // 移植自 Glass.py 的惯性模型 (第 290-299 行): 速度积分, 顺滑拖尾, 明显惯性
    var o = orbs[0];
    var num = Math.min(dt * 12, 1);   // 位置积分系数 (越大越跟手)
    var dnum = Math.min(dt * 3, 1);   // 速度平滑系数 (越小惯性越强)
    o.vx += (target.x - o.x - o.vx) * dnum;
    o.vy += (target.y - o.y - o.vy) * dnum;
    o.x += o.vx * num;
    o.y += o.vy * num;
    // 跟随鼠标, 触边贴边 (不反弹, 与 Glass.py 一致)
    if (o.x < o.r) o.x = o.r; else if (o.x > W - o.r) o.x = W - o.r;
    if (o.y < o.r) o.y = o.r; else if (o.y > H - o.r) o.y = H - o.r;

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // 背景: 两张壁纸混合
    gl.useProgram(bgProg);
    bindAttribs(bgProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texLight);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texDark);
    gl.uniform1i(gl.getUniformLocation(bgProg, "texLight"), 0);
    gl.uniform1i(gl.getUniformLocation(bgProg, "texDark"), 1);
    gl.uniform1f(gl.getUniformLocation(bgProg, "uNight"), eased);
    gl.uniform1f(gl.getUniformLocation(bgProg, "uCanvasAspect"), canvasAspect);
    gl.uniform1f(gl.getUniformLocation(bgProg, "uImgAspect"), imgAspect);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

    // 玻璃球: 折射混合后的壁纸
    gl.useProgram(glassProg);
    bindAttribs(glassProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texLight);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texDark);
    gl.uniform1i(gl.getUniformLocation(glassProg, "imgLight"), 0);
    gl.uniform1i(gl.getUniformLocation(glassProg, "imgDark"), 1);
    gl.uniform1f(gl.getUniformLocation(glassProg, "uNight"), eased);
    gl.uniform1f(gl.getUniformLocation(glassProg, "uCanvasAspect"), canvasAspect);
    gl.uniform1f(gl.getUniformLocation(glassProg, "uImgAspect"), imgAspect);
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

  console.info("[glass] 初始化完成 (昼夜动态壁纸)");
})();
