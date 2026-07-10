/**
 * 液体玻璃 WebGL 背景
 * 基于 /Users/glaive/Desktop/液体玻璃ai/Gemini.html 的渲染原理移植
 * 作为文件下载中心的动态背景运行
 */

(function () {
    // ==========================================
    // 顶点着色器（全屏四边形）
    // ==========================================
    const vertexShaderSource = `
    #version 300 es
    in vec2 position;
    out vec2 v_uv;
    void main() {
        v_uv = position * 0.5 + 0.5;
        gl_Position = vec4(position, 0.0, 1.0);
    }
    `.trim();

    // ==========================================
    // Pass 1: 动态流体背景 (FBM)
    // ==========================================
    const bgFragmentShaderSource = `
    #version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform vec2 u_resolution;
    uniform float u_time;

    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
    float noise(vec2 p) {
        vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(hash(i + vec2(0.0,0.0)), hash(i + vec2(1.0,0.0)), u.x),
                   mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);
    }
    float fbm(vec2 p) {
        float v = 0.0; float a = 0.5;
        mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
        for (int i = 0; i < 3; ++i) { v += a * noise(p); p = rot * p * 2.1 + vec2(10.0); a *= 0.5; }
        return v;
    }

    void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution;
        vec2 p = uv * 2.5;
        float t = u_time * 0.15;

        vec2 q = vec2(fbm(p + vec2(t, -t)), fbm(p + vec2(-t * 0.8, t * 1.2)));
        vec2 r = vec2(fbm(p + 3.0 * q + vec2(1.7, 9.2) + t * 0.5), fbm(p + 2.5 * q + vec2(8.3, 2.8) - t * 0.3));
        float f = fbm(p + 4.0 * r);

        vec3 darkBase = vec3(0.03, 0.02, 0.08);
        vec3 electricBlue = vec3(0.12, 0.38, 0.94);
        vec3 deepPurple = vec3(0.38, 0.08, 0.75);
        vec3 vibrantPink = vec3(0.92, 0.18, 0.55);

        vec3 color = mix(darkBase, electricBlue, clamp(length(q), 0.0, 1.0));
        color = mix(color, deepPurple, clamp(abs(r.x), 0.0, 1.0));
        color = mix(color, vibrantPink, clamp(f * 1.2, 0.0, 1.0));
        color += vec3(0.05, 0.08, 0.15) * f;

        fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
    }
    `.trim();

    // ==========================================
    // Pass 2: 圆形玻璃材质
    // ==========================================
    const glassFragmentShaderSource = `
    #version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;

    uniform sampler2D u_bg_texture;
    uniform vec2 u_resolution;
    uniform float u_time;
    uniform vec2 u_card_pos;
    uniform float u_card_radius;
    uniform vec2 u_card_vel;
    uniform float u_refraction_strength;

    float ign(vec2 p) {
        vec3 magic = vec3(0.06711056, 0.00583715, 52.9829189);
        return fract(magic.z * fract(dot(p, magic.xy)));
    }

    float circleSDF(vec2 p, float radius) {
        return length(p) - radius;
    }

    vec2 applyLiquidWarp(vec2 p, float speed, float radius) {
        if (speed < 0.1) return p;
        vec2 velDir = normalize(u_card_vel);
        float dist = length(p);
        float edgeWeight = smoothstep(radius * 0.6, radius, dist);
        float wave = sin(dist * 0.08 - u_time * 12.0 + dot(p, velDir) * 0.02) * min(speed * 0.04, 8.0);
        p += normalize(p) * wave * edgeWeight * 0.6;
        float stretch = min(speed * 0.0006, 0.12) * edgeWeight;
        float proj = dot(p, velDir);
        p -= velDir * proj * (stretch / (1.0 + stretch));
        return p;
    }

    float getThickness(float signedDist, float radius) {
        if (signedDist >= 0.0) return 0.0;
        float x = clamp(-signedDist / (radius * 0.18), 0.0, 1.0);
        return x * x * (3.0 - 2.0 * x);
    }

    void main() {
        vec2 pixelCoords = gl_FragCoord.xy;
        vec2 screenUV = pixelCoords / u_resolution;

        vec2 p = pixelCoords - u_card_pos;
        float radius = u_card_radius;
        float speed = length(u_card_vel);

        p = applyLiquidWarp(p, speed, radius);
        float sdfVal = circleSDF(p, radius);
        float distPixels = sdfVal;

        if (distPixels > 2.0) {
            fragColor = vec4(0.0, 0.0, 0.0, 0.0);
            return;
        }

        float hC = getThickness(distPixels, radius);
        float hR = getThickness(circleSDF(p + vec2(1.0, 0.0), radius), radius);
        float hL = getThickness(circleSDF(p - vec2(1.0, 0.0), radius), radius);
        float hU = getThickness(circleSDF(p + vec2(0.0, 1.0), radius), radius);
        float hD = getThickness(circleSDF(p - vec2(0.0, 1.0), radius), radius);

        vec3 normal = normalize(vec3(hL - hR, hD - hU, 0.06));
        vec3 viewDir = vec3(0.0, 0.0, 1.0);
        float viewDotNormal = max(dot(normal, viewDir), 0.0);

        float edgeFactor = pow(1.0 - hC, 3.5);
        vec2 refractOffset = normal.xy * (0.006 + 0.28 * edgeFactor) * u_refraction_strength;

        float chromaticScale = 1.0 + 0.18 * edgeFactor;
        vec3 refractedColor;
        refractedColor.r = texture(u_bg_texture, screenUV + refractOffset * (chromaticScale + 0.07)).r;
        refractedColor.g = texture(u_bg_texture, screenUV + refractOffset * chromaticScale).g;
        refractedColor.b = texture(u_bg_texture, screenUV + refractOffset * (chromaticScale - 0.07)).b;

        vec3 reflectDir = reflect(-viewDir, normal);
        vec2 internalUV1 = screenUV + reflectDir.xy * 0.32 * (1.0 - hC);
        vec2 internalUV2 = screenUV + reflectDir.xy * 0.62 * (1.0 - hC);
        vec3 internalColor = mix(
            texture(u_bg_texture, internalUV1).rgb,
            texture(u_bg_texture, internalUV2).rgb,
            0.4
        );
        refractedColor += internalColor * pow(1.0 - hC, 2.5) * 0.22;

        float fresnelOuter = pow(1.0 - viewDotNormal, 4.5);
        float fresnelInner = pow(1.0 - viewDotNormal, 2.0) * 0.45;

        vec2 envReflectUV = screenUV - normal.xy * 0.55;
        vec3 envReflectColor = texture(u_bg_texture, envReflectUV).rgb;
        float upperHighlight = pow(max(normal.y * 0.5 + 0.5, 0.0), 3.0);
        float lowerBounce = pow(max(-normal.y * 0.5 + 0.5, 0.0), 5.0);
        vec3 specular = envReflectColor * (upperHighlight * 0.35 + lowerBounce * 0.12 + fresnelInner * 0.3) * (0.65 + fresnelOuter);

        float edgeGlowRegion = smoothstep(-4.0, 0.0, distPixels) * (1.0 - smoothstep(0.0, 2.0, distPixels));
        vec3 edgeGlow = vec3(1.0) * edgeGlowRegion * fresnelOuter * 1.25;

        float frostNoise = (ign(pixelCoords * 0.75 + u_time * 6.0) - 0.5) * 0.038;

        vec3 glassBaseTint = vec3(0.97, 0.98, 1.0) * 0.025;
        vec3 finalGlassColor = refractedColor + glassBaseTint;
        finalGlassColor += vec3(fresnelOuter * 0.55 + fresnelInner * 0.18);
        finalGlassColor += specular;
        finalGlassColor += edgeGlow;
        finalGlassColor += vec3(frostNoise);

        float alpha = 1.0 - smoothstep(-2.0, 0.0, distPixels);
        fragColor = vec4(finalGlassColor, alpha);
    }
    `.trim();

    // ==========================================
    // Pass 3: 可分离高斯模糊
    // ==========================================
    const blurFragmentShaderSource = `
    #version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_source_texture;
    uniform vec2 u_resolution;
    uniform float u_blur_amount;
    uniform vec2 u_direction;
    void main() {
        vec2 uv = gl_FragCoord.xy / u_resolution;
        if (u_blur_amount <= 0.0) {
            fragColor = texture(u_source_texture, uv);
            return;
        }
        vec2 texel = u_direction / u_resolution * u_blur_amount;
        vec4 color = texture(u_source_texture, uv) * 0.2270270270;
        color += texture(u_source_texture, uv + texel * 1.3846153846) * 0.3162162162;
        color += texture(u_source_texture, uv - texel * 1.3846153846) * 0.3162162162;
        color += texture(u_source_texture, uv + texel * 3.2307692308) * 0.0702702703;
        color += texture(u_source_texture, uv - texel * 3.2307692308) * 0.0702702703;
        fragColor = color;
    }
    `.trim();

    // ==========================================
    // Pass 4: 简单纹理复制
    // ==========================================
    const copyFragmentShaderSource = `
    #version 300 es
    precision highp float;
    in vec2 v_uv;
    out vec4 fragColor;
    uniform sampler2D u_texture;
    void main() {
        fragColor = texture(u_texture, v_uv);
    }
    `.trim();

    // ==========================================
    // WebGL 引擎初始化
    // ==========================================
    const canvas = document.createElement('canvas');
    canvas.id = 'glass-canvas';
    document.body.insertBefore(canvas, document.body.firstChild);

    const gl = canvas.getContext('webgl2', {
        alpha: false,
        antialias: true,
        depth: false,
        stencil: false,
        powerPreference: 'high-performance',
    });
    if (!gl) {
        console.warn('WebGL2 不可用，液体玻璃背景未启用');
        return;
    }

    function createShader(type, source) {
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error(gl.getShaderInfoLog(shader));
            throw new Error('Shader compile failed');
        }
        return shader;
    }

    function createProgram(vsSource, fsSource) {
        const vs = createShader(gl.VERTEX_SHADER, vsSource);
        const fs = createShader(gl.FRAGMENT_SHADER, fsSource);
        const prog = gl.createProgram();
        gl.bindAttribLocation(prog, 0, 'position');
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error(gl.getProgramInfoLog(prog));
            throw new Error('Program link failed');
        }
        return prog;
    }

    const bgProgram = createProgram(vertexShaderSource, bgFragmentShaderSource);
    const blurProgram = createProgram(vertexShaderSource, blurFragmentShaderSource);
    const glassProgram = createProgram(vertexShaderSource, glassFragmentShaderSource);
    const copyProgram = createProgram(vertexShaderSource, copyFragmentShaderSource);

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const posBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1,
    ]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const bgLocs = {
        res: gl.getUniformLocation(bgProgram, 'u_resolution'),
        time: gl.getUniformLocation(bgProgram, 'u_time'),
    };
    const blurLocs = {
        res: gl.getUniformLocation(blurProgram, 'u_resolution'),
        sourceTex: gl.getUniformLocation(blurProgram, 'u_source_texture'),
        blurAmount: gl.getUniformLocation(blurProgram, 'u_blur_amount'),
        direction: gl.getUniformLocation(blurProgram, 'u_direction'),
    };
    const glassLocs = {
        res: gl.getUniformLocation(glassProgram, 'u_resolution'),
        time: gl.getUniformLocation(glassProgram, 'u_time'),
        cardPos: gl.getUniformLocation(glassProgram, 'u_card_pos'),
        cardRadius: gl.getUniformLocation(glassProgram, 'u_card_radius'),
        cardVel: gl.getUniformLocation(glassProgram, 'u_card_vel'),
        bgTex: gl.getUniformLocation(glassProgram, 'u_bg_texture'),
        refractionStrength: gl.getUniformLocation(glassProgram, 'u_refraction_strength'),
    };
    const copyLocs = {
        texture: gl.getUniformLocation(copyProgram, 'u_texture'),
    };

    function createFBOTexture() {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
    }

    const bgTexture = createFBOTexture();
    const blurHTexture = createFBOTexture();
    const blurVTexture = createFBOTexture();

    const fbo = gl.createFramebuffer();
    const fboBlurH = gl.createFramebuffer();
    const fboBlurV = gl.createFramebuffer();

    function attachTexture(framebuffer, tex) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    }
    attachTexture(fbo, bgTexture);
    attachTexture(fboBlurH, blurHTexture);
    attachTexture(fboBlurV, blurVTexture);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    // ==========================================
    // 多玻璃管理（自动漂浮）
    // ==========================================
    const glasses = [];
    const GLASS_COUNT = 3;
    let radius = 170;

    function createGlass(x, y) {
        return {
            pos: { x, y },
            vel: { x: 0, y: 0 },
            target: { x, y },
            floatVel: {
                x: (Math.random() - 0.5) * 80,
                y: (Math.random() - 0.5) * 80,
            },
        };
    }

    function initGlasses() {
        glasses.length = 0;
        const margin = radius + 20;
        for (let i = 0; i < GLASS_COUNT; i++) {
            const x = margin + Math.random() * (window.innerWidth - margin * 2);
            const y = margin + Math.random() * (window.innerHeight - margin * 2);
            glasses.push(createGlass(x, y));
        }
    }

    function resize() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2.0);
        const w = window.innerWidth * dpr;
        const h = window.innerHeight * dpr;
        canvas.width = w;
        canvas.height = h;

        [bgTexture, blurHTexture, blurVTexture].forEach((tex) => {
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        });

        const base = Math.min(window.innerWidth, window.innerHeight) * 0.22;
        radius = Math.max(80, Math.min(220, base));
    }
    window.addEventListener('resize', resize);
    resize();
    initGlasses();

    // ==========================================
    // 主渲染循环
    // ==========================================
    const REFRACTION_STRENGTH = 0.9;
    const BLUR_AMOUNT = 1.2;
    let startTime = performance.now();
    let lastTime = startTime;

    function update(now) {
        requestAnimationFrame(update);

        let dt = (now - lastTime) / 1000.0;
        lastTime = now;
        if (dt > 0.032) dt = 0.032;

        const dpr = Math.min(window.devicePixelRatio || 1, 2.0);
        const stiffness = 180.0;
        const damping = 16.0;

        for (const g of glasses) {
            const margin = radius + 20;
            g.target.x += g.floatVel.x * dt;
            g.target.y += g.floatVel.y * dt;

            if (g.target.x < margin || g.target.x > window.innerWidth - margin) {
                g.floatVel.x *= -1;
                g.target.x = Math.max(margin, Math.min(window.innerWidth - margin, g.target.x));
            }
            if (g.target.y < margin || g.target.y > window.innerHeight - margin) {
                g.floatVel.y *= -1;
                g.target.y = Math.max(margin, Math.min(window.innerHeight - margin, g.target.y));
            }

            const forceX = stiffness * (g.target.x - g.pos.x);
            const forceY = stiffness * (g.target.y - g.pos.y);
            g.vel.x += (forceX - damping * g.vel.x) * dt;
            g.vel.y += (forceY - damping * g.vel.y) * dt;
            g.pos.x += g.vel.x * dt;
            g.pos.y += g.vel.y * dt;
        }

        const timeSec = (now - startTime) * 0.001;

        // --- Pass 1: 生成背景到 FBO ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.useProgram(bgProgram);
        gl.uniform2f(bgLocs.res, canvas.width, canvas.height);
        gl.uniform1f(bgLocs.time, timeSec);
        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // --- Pass 2: 模糊背景 ---
        let bgTexForGlass = bgTexture;
        if (BLUR_AMOUNT > 0.0) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurH);
            gl.viewport(0, 0, canvas.width, canvas.height);
            gl.useProgram(blurProgram);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, bgTexture);
            gl.uniform1i(blurLocs.sourceTex, 0);
            gl.uniform2f(blurLocs.res, canvas.width, canvas.height);
            gl.uniform1f(blurLocs.blurAmount, BLUR_AMOUNT);
            gl.uniform2f(blurLocs.direction, 1.0, 0.0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);

            gl.bindFramebuffer(gl.FRAMEBUFFER, fboBlurV);
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, blurHTexture);
            gl.uniform1i(blurLocs.sourceTex, 0);
            gl.uniform2f(blurLocs.direction, 0.0, 1.0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
            bgTexForGlass = blurVTexture;
        }

        // --- Pass 3: 绘制背景到屏幕 ---
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.disable(gl.BLEND);
        gl.useProgram(copyProgram);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, bgTexForGlass);
        gl.uniform1i(copyLocs.texture, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // --- Pass 4: 混合绘制所有玻璃 ---
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.useProgram(glassProgram);
        gl.uniform2f(glassLocs.res, canvas.width, canvas.height);
        gl.uniform1f(glassLocs.time, timeSec);
        gl.uniform1f(glassLocs.refractionStrength, REFRACTION_STRENGTH);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, bgTexForGlass);
        gl.uniform1i(glassLocs.bgTex, 0);

        for (const g of glasses) {
            const posX = g.pos.x * dpr;
            const posY = (window.innerHeight - g.pos.y) * dpr;
            gl.uniform2f(glassLocs.cardPos, posX, posY);
            gl.uniform1f(glassLocs.cardRadius, radius * dpr);
            gl.uniform2f(glassLocs.cardVel, g.vel.x * dpr, -g.vel.y * dpr);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
        }

        gl.disable(gl.BLEND);
    }

    requestAnimationFrame(update);
})();
