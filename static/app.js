/**
 * 文件下载中心前端脚本
 * 加载文件列表、渲染下载卡片、处理登录/注册、管理员操作
 */

// 全局错误兜底：任何未被捕获的 JS 错误都会在页面顶部以红条显示，
// 便于在「列表卡住」时快速定位是脚本报错还是单纯的冷启动慢。
window.addEventListener('error', (e) => {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#ef4444;color:#fff;padding:10px 14px;font-size:13px;font-family:monospace;white-space:pre-wrap;';
    banner.textContent = '页面脚本错误：' + (e.message || e.error || '未知错误');
    document.body && document.body.appendChild(banner);
});
window.addEventListener('unhandledrejection', (e) => {
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#f59e0b;color:#000;padding:10px 14px;font-size:13px;font-family:monospace;white-space:pre-wrap;';
    banner.textContent = '未处理的异步错误：' + (e.reason && e.reason.message ? e.reason.message : e.reason);
    document.body && document.body.appendChild(banner);
});

const listEl = document.getElementById('file-list');
const noticeModal = document.getElementById('notice-modal');
const noticeClose = document.getElementById('notice-close');
const authBtn = document.getElementById('auth-btn');
const headerAuth = document.getElementById('header-auth');
const authModal = document.getElementById('auth-modal');
const modalClose = document.getElementById('modal-close');
const modalTabs = document.querySelectorAll('.modal-tab');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const authMessage = document.getElementById('auth-message');
const adminPanel = document.getElementById('admin-panel');
const createSeriesForm = document.getElementById('create-series-form');
const uploadFileForm = document.getElementById('upload-file-form');
const uploadSeriesSelect = document.getElementById('upload-series-select');
const statsModal = document.getElementById('stats-modal');
const statsClose = document.getElementById('stats-close');
const connBanner = document.getElementById('conn-banner');

const TOKEN_KEY = 'download_site_token';
const USER_KEY = 'download_site_user';
const SESSION_KEY = 'download_site_session';

const ACTIVE_PING_INTERVAL = 20000;   // 每 20 秒发送一次心跳
const ONLINE_POLL_INTERVAL = 10000;   // 管理员每 10 秒刷新一次在线数

let activePingTimer = null;
let onlinePollTimer = null;
let sessionStatusTimer = null;   // 会话状态轮询定时器
let serverWarm = false;  // 后端是否已预热（冷启动完成后为 true）

// ALTCHA 人机验证（Proof-of-Work CAPTCHA）payload 暂存区
// 键分别对应登录 / 注册 / 行为复核表单中的 <altcha-widget>
const altchaStore = { login: '', register: '', behavior: '' };

/**
 * 绑定一个 ALTCHA 组件，监听其 statechange 事件并缓存解出的 payload。
 * 组件完成算力证明后会在 event.detail.payload 中回传 base64 凭证。
 * @param {string} formId - 所在表单 id
 * @param {string} key - altchaStore 中的键
 */
function bindAltchaWidget(formId, key) {
    const widget = document.querySelector(`#${formId} altcha-widget`);
    if (!widget) return;
    widget.addEventListener('statechange', (e) => {
        altchaStore[key] = (e.detail && e.detail.payload) ? e.detail.payload : '';
    });
}

/**
 * 读取某表单当前的 ALTCHA payload：
 * 优先取事件缓存，其次回退到组件自动注入的隐藏域 <input name="altcha">。
 * @param {string} formId
 * @param {string} key
 * @returns {string}
 */
function getAltchaPayload(formId, key) {
    if (altchaStore[key]) return altchaStore[key];
    const form = document.getElementById(formId);
    const input = form && form.querySelector('input[name="altcha"]');
    return input ? input.value : '';
}

// 客户端行为标记（由 /api/behavior/report 响应同步；复核通过后清除）
let behaviorFlagged = false;

/**
 * 客户端环境自动化指纹（BotDetector）
 * ------------------------------------------------------------
 * 检测 navigator.webdriver、无头浏览器特征、自动化框架注入的全局对象等，返回 0~1
 * 风险分。在登录/注册阶段随请求上报供服务端硬拦截；并作为行为分析的风险下界。
 * 关键：AI 浏览器（如 Tabbit/Kimi）虽能解算 ALTCHA PoW，但其自动化驱动环境
 * （Playwright/Puppeteer 等）通常令 navigator.webdriver=true，可被此处识别。
 */
const BotDetector = (function () {
    let cached = null;

    function compute() {
        if (cached !== null) return cached;
        let score = 0;
        const reasons = [];

        // 1. navigator.webdriver —— 自动化驱动的强信号
        try {
            if (navigator.webdriver === true) {
                score += 0.5;
                reasons.push('webdriver');
            }
        } catch (e) { /* 部分浏览器访问会抛错 */ }

        // 2. 自动化框架注入的全局对象
        const autoKeys = [
            '__nightmare', '__puppeteer', '_phantom', 'callPhantom',
            '__playwright', '__selenium_unwrapped', 'domAutomation',
            'domAutomationController', 'awesomium',
        ];
        for (const k of autoKeys) {
            if (typeof window !== 'undefined' && k in window) {
                score += 0.35;
                reasons.push(k);
                break;
            }
        }

        // 3. 无头浏览器线索：无插件且无语言列表
        try {
            const noPlugins = !navigator.plugins || navigator.plugins.length === 0;
            const noLang = !navigator.languages || navigator.languages.length === 0;
            if (noPlugins && noLang) {
                score += 0.2;
                reasons.push('headless-clue');
            }
        } catch (e) { /* ignore */ }

        // 4. Chrome 但缺失 window.chrome.runtime（无头特征）
        try {
            if (/Chrome/.test(navigator.userAgent) &&
                !(window.chrome && window.chrome.runtime)) {
                score += 0.15;
                reasons.push('no-chrome-runtime');
            }
        } catch (e) { /* ignore */ }

        cached = Math.min(1, round3(score));
        return cached;
    }

    return { compute };
})();

/**
 * 行为式人机认证（鼠标轨迹 + 交互真实性分析）
 * ------------------------------------------------------------
 * 登录后、在非登录页面持续采集鼠标移动轨迹与真实交互事件，提取速度连续性、方向变化
 * 自然度、机械化重复模式、轨迹真实性（瞬移/直线/定时间隔）、交互事件可信度
 * （isTrusted 过滤合成事件）、操作环境特征等，估算操作者为人/机器人的风险分，
 * 并定期上报后端。全程对用户透明：仅当风险达到阈值（后端标记）时，下一次受保护
 * 操作才会触发一次轻量二次验证（ALTCHA）。仅上报聚合特征，绝不发送原始坐标。
 *
 * 相较旧版的增强（针对 Tabbit 等 AI 浏览器）：
 * 1. isTrusted 过滤：JS dispatch 产生的合成事件 isTrusted=false，真人绝不会产生 → 强信号
 * 2. 交互多样性：跟踪真实 click/keydown/scroll/touch；登录后长时间零交互 → 可疑
 * 3. 轨迹真实性：瞬移（超人类速度）、近完美直线、定时间隔均判为机器人特征
 * 4. 修复"无移动=安全"漏洞：旧版样本不足直接返回 risk=0，机器人不移动鼠标即被放过
 * 5. 融合环境指纹：BotDetector 分作为风险下界
 */
const BehaviorMonitor = (function () {
    const SAMPLE_INTERVAL = 50;   // 采样间隔（ms）≈ 20Hz，兼顾性能与准确性
    const MAX_SAMPLES = 200;      // 环形缓冲上限（≈10s）
    const REPORT_INTERVAL = 5000; // 风险上报间隔（ms）
    const MIN_SAMPLES = 20;       // 轨迹分析所需最小样本数
    const MOVE_THRESHOLD = 400;   // 总位移阈值（px），过小视为未移动、不判定轨迹
    const IDLE_FLAG_SECONDS = 12;     // 登录后超过该时长仍无任何真实交互 → 可疑
    const TELEPORT_SPEED = 15;        // px/ms（≈15000px/s），超过视为瞬移（非人类）
    const SYNTHETIC_FLAG_THRESHOLD = 5; // 合成事件数超过该值 → 强机器人信号

    let samples = [];
    let lastT = 0;
    let active = false;
    let timer = null;
    let startedAt = 0;
    let interactionCount = 0;   // 真实（isTrusted）交互事件计数
    let syntheticCount = 0;     // 合成（isTrusted=false）事件计数

    function onMove(e) {
        // 过滤合成事件：JS dispatch 产生的事件 isTrusted=false，真实人工事件为 true
        if (e.isTrusted === false) {
            syntheticCount++;
            return;
        }
        const now = (e.timeStamp && e.timeStamp > 0) ? e.timeStamp : performance.now();
        if (now - lastT < SAMPLE_INTERVAL) return;  // 节流
        const x = e.clientX, y = e.clientY;
        samples.push({ x, y, t: now });
        if (samples.length > MAX_SAMPLES) samples.shift();
        lastT = now;
    }

    function onInteraction(e) {
        if (e.isTrusted === false) {
            syntheticCount++;
            return;
        }
        interactionCount++;
    }

    function analyze() {
        const n = samples.length;
        const envScore = BotDetector.compute();
        const idleSeconds = active ? (performance.now() - startedAt) / 1000 : 0;

        let risk = 0;
        const feats = {
            env_score: envScore,
            interactions: interactionCount,
            synthetic: syntheticCount,
            idle_seconds: round3(idleSeconds),
        };

        // (A) 合成事件 —— 真人绝不会产生 isTrusted=false 事件
        if (syntheticCount >= SYNTHETIC_FLAG_THRESHOLD) {
            risk += 0.7;
        } else if (syntheticCount > 0) {
            risk += 0.3;
        }

        // (B) 长时间无任何真实交互 —— 纯 API 调用型机器人（不产生鼠标/点击/滚动事件）
        if (active && idleSeconds > IDLE_FLAG_SECONDS && interactionCount === 0) {
            risk += 0.6;
        }

        // (C) 环境指纹 —— 取环境分作为风险下界
        risk = Math.max(risk, envScore);

        // 轨迹真实性分析（需足够样本）
        if (n >= MIN_SAMPLES) {
            const speeds = [];
            const dts = [];
            const dirChanges = [];
            let totalDist = 0;
            let teleported = false;
            const sx = samples[0].x, sy = samples[0].y;
            for (let i = 1; i < n; i++) {
                const a = samples[i - 1], b = samples[i];
                const dx = b.x - a.x, dy = b.y - a.y;
                const dt = b.t - a.t;
                if (dt <= 0) continue;
                const dist = Math.hypot(dx, dy);
                totalDist += dist;
                const sp = dist / dt;  // px/ms
                speeds.push(sp);
                dts.push(dt);
                if (sp > TELEPORT_SPEED) teleported = true;
                if (i >= 2) {
                    const t1 = Math.atan2(a.y - samples[i - 2].y, a.x - samples[i - 2].x);
                    const t2 = Math.atan2(dy, dx);
                    let d = t2 - t1;
                    while (d > Math.PI) d -= 2 * Math.PI;
                    while (d < -Math.PI) d += 2 * Math.PI;
                    dirChanges.push(d);
                }
            }
            const ex = samples[n - 1].x, ey = samples[n - 1].y;
            const netDisp = Math.hypot(ex - sx, ey - sy);

            if (speeds.length > 0) {
                const mean = avg(speeds);
                const variance = avg(speeds.map(s => (s - mean) * (s - mean)));
                const cv = mean > 0 ? Math.sqrt(variance) / mean : 0;        // 速度变异系数
                const speedEntropy = entropy(speeds, 8);                     // 速度分布熵
                const dirEntropy = entropy(dirChanges, 12);                  // 方向变化熵
                const periodicity = maxAutocorr(speeds, 6);                   // 速度序列周期性
                const straightness = totalDist > 0 ? netDisp / totalDist : 0; // 直线度
                const dtMean = avg(dts);
                const dtCv = dtMean > 0
                    ? Math.sqrt(avg(dts.map(d => (d - dtMean) * (d - dtMean)))) / dtMean
                    : 0;                                                       // 时间间隔变异系数

                const movedEnough = totalDist > MOVE_THRESHOLD;

                if (teleported) risk += 0.6;                                      // 瞬移
                if (movedEnough && cv < 0.05) risk += 0.45;                       // 机械式匀速
                if (periodicity > 0.85) risk += 0.4;                              // 机械化重复模式
                if (movedEnough && dirEntropy < 0.5 && cv < 0.12) risk += 0.25;   // 呆板直线+匀速
                if (movedEnough && straightness > 0.95 && n > 30) risk += 0.35;   // 近完美直线
                if (dts.length > 30 && dtCv < 0.1) risk += 0.3;                   // 定时间隔

                feats.cv = round3(cv);
                feats.speed_entropy = round3(speedEntropy);
                feats.dir_entropy = round3(dirEntropy);
                feats.periodicity = round3(periodicity);
                feats.straightness = round3(straightness);
                feats.dt_cv = round3(dtCv);
                feats.total_dist = Math.round(totalDist);
            }
        }

        risk = Math.min(1, risk);
        return {
            risk_score: round3(risk),
            verdict: risk >= 0.6 ? 'suspicious' : 'human',
            sample_count: n,
            features: feats,
        };
    }

    async function report() {
        const result = analyze();
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token) return;
        try {
            const res = await fetch('/api/behavior/report', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify(result),
            });
            if (res.ok) {
                const data = await res.json();
                behaviorFlagged = !!(data && data.flagged);
            }
        } catch (e) { /* 上报失败不影响使用 */ }
    }

    function start() {
        if (active) return;
        if (!localStorage.getItem(TOKEN_KEY)) return;
        active = true;
        samples = [];
        lastT = 0;
        startedAt = performance.now();
        interactionCount = 0;
        syntheticCount = 0;
        window.addEventListener('mousemove', onMove, { passive: true });
        window.addEventListener('click', onInteraction, { passive: true });
        window.addEventListener('keydown', onInteraction, { passive: true });
        window.addEventListener('scroll', onInteraction, { passive: true });
        window.addEventListener('touchstart', onInteraction, { passive: true });
        timer = setInterval(report, REPORT_INTERVAL);
    }

    function stop() {
        if (!active) return;
        active = false;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('click', onInteraction);
        window.removeEventListener('keydown', onInteraction);
        window.removeEventListener('scroll', onInteraction);
        window.removeEventListener('touchstart', onInteraction);
        if (timer) clearInterval(timer);
        timer = null;
        samples = [];
    }

    return { start, stop, report };
})();

/**
 * 鼠标轨迹人机验证（前端完成全部验证逻辑）
 * ------------------------------------------------------------
 * 收集鼠标移动轨迹（坐标/时间），提取路径、速度、加速度、方向变化、自然抖动等特征，
 * 融合人类行为先验（连续性、随机性、自然抖动）估算「人类相似度置信度」，达到阈值即判真人。
 * 全程在前端完成，实时绘制轨迹并提供视觉反馈，验证完成输出明确判定结果。
 * 不依赖按钮点击检测：判定完全由轨迹特征决定，按钮仅用于控制/提交已算出的结果。
 */
const MouseTrajectoryVerifier = (function () {
    const SAMPLE_MIN_INTERVAL = 33;  // 采样节流 ≈ 30Hz
    const MAX_POINTS = 400;
    const MIN_POINTS = 25;
    const MIN_PATH = 200;            // px，轨迹过短不终判
    const TELEPORT_SPEED = 12;       // px/ms，超过视为瞬移（非人类）
    const TARGET_POINTS = 90;        // 采样充足即终判
    const MAX_TIME_MS = 15000;       // 最长验证时长
    const CONF_STABLE_ROUNDS = 6;    // 置信度连续稳定轮数 → 终判
    const HUMAN_THRESHOLD = 0.6;     // 人类置信度阈值

    let canvas, ctx, hint, gaugeFill, confVal, resultBox, retryBtn, confirmBtn, confirmHint;
    let points = [];
    let lastT = 0;
    let active = false;
    let timer = null;
    let startedAt = 0;
    let mode = 'standalone';
    let onResult = null;
    let stableCount = 0;
    let lastConfidence = -1;
    let finalized = false;
    let pendingResult = null;

    function initDom() {
        canvas = document.getElementById('traj-canvas');
        if (canvas) ctx = canvas.getContext('2d');
        hint = document.getElementById('traj-hint');
        gaugeFill = document.getElementById('traj-gauge-fill');
        confVal = document.getElementById('traj-confidence-val');
        resultBox = document.getElementById('traj-result');
        retryBtn = document.getElementById('traj-retry');
        confirmBtn = document.getElementById('traj-confirm');
        confirmHint = document.getElementById('traj-confirm-hint');
        if (retryBtn) retryBtn.addEventListener('click', reset);
        if (confirmBtn) confirmBtn.addEventListener('click', onConfirm);
    }

    // ===== 持续自动后台检测（登录后永不停止，滑动窗口循环判定） =====
    // 设计原则：非一次性——用户验证通过后若行为转为机器人化，必须立即重新捕获。
    // 每次评估仅使用最近一段时间的轨迹数据（环形缓冲即天然滑动窗口），
    // 无终态机，始终在 human / observing / bot 三区间内持续循环判定。
    let autoActive = false;
    let autoPoints = [];
    let autoLastT = 0;
    let autoTimer = null;

    // 持续检测的区间与稳定性计数器
    const BOT_THRESHOLD = 0.35;       // 低于此且连续稳定 → 判定机器人
    const AUTO_STABLE = 4;            // 连续 N 轮处于同一区间才切换标记状态
    const AUTO_REPORT_MS = 8000;      // 风险上报间隔(ms)
    let autoHumanStreak = 0;          // 连续 ≥ HUMAN_THRESHOLD 的轮数
    let autoBotStreak = 0;            // 连续 ≤ BOT_THRESHOLD 的轮数
    let autoLastReportTime = 0;

    function autoOnMove(e) {
        if (!autoActive) return;
        if (e.isTrusted === false) return;  // 过滤自动化脚本注入的合成事件
        const now = (e.timeStamp && e.timeStamp > 0) ? e.timeStamp : performance.now();
        if (now - autoLastT < SAMPLE_MIN_INTERVAL) return;  // 节流 ≈ 30Hz
        autoPoints.push({ x: e.clientX, y: e.clientY, t: now });
        if (autoPoints.length > MAX_POINTS) autoPoints.shift();  // 环形缓冲 = 滑动窗口
        autoLastT = now;
    }

    /**
     * 尝试清除行为标记：前端判定为真人时调用。
     * 仅当当前确实被标记时才请求后端清标记（避免无效请求）。
     */
    async function tryClearBehaviorFlag(f, conf) {
        if (!behaviorFlagged) return;
        try {
            const res = await fetch('/api/behavior/reverify_trajectory', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem(TOKEN_KEY)}`,
                },
                body: JSON.stringify({ verdict: 'human', confidence: conf, samples: f.n, features: f }),
            });
            if (res.ok) behaviorFlagged = false;
        } catch (_) { /* 网络异常不影响前台持续检测 */ }
    }

    /**
     * 标记为机器人并上报：前端持续判定为机器人时调用。
     * 标记后后续受保护操作会自动触发二次验证弹窗。
     */
    async function tryFlagAsBot(f, conf) {
        if (behaviorFlagged) return;  // 已标记则跳过重复上报
        behaviorFlagged = true;
        try {
            await fetch('/api/behavior/report', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem(TOKEN_KEY)}`,
                },
                body: JSON.stringify({
                    risk_score: Math.max(0.6, conf),
                    verdict: 'suspicious',
                    sample_count: f.n,
                    features: f,
                }),
            });
        } catch (_) { /* 网络异常不影响前台标记 */ }
    }

    /**
     * 定期向后端上报当前风险分数（用于服务端记录和趋势分析）。
     * 不改变标记状态，仅做数据同步。
     */
    async function reportAutoRisk(conf, f) {
        if (!localStorage.getItem(TOKEN_KEY)) return;
        try {
            await fetch('/api/behavior/report', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${localStorage.getItem(TOKEN_KEY)}`,
                },
                body: JSON.stringify({
                    risk_score: round3(1 - conf),   // 置信度的补数作为风险分
                    verdict: conf >= HUMAN_THRESHOLD ? 'human' : 'suspicious',
                    sample_count: f.n,
                    features: f,
                }),
            });
        } catch (_) { /* 上报失败不阻断 */ }
    }

    /**
     * 核心：持续滑动窗口判定（每次 tick 都用最新窗口数据重算，无终态）。
     *
     * 区间划分：
     *   conf ≥ HUMAN_THRESHOLD(0.6) → human 区间 → 稳定后尝试清标记
     *   conf ≤ BOT_THRESHOLD(0.35)  → bot 区间   → 稳定后标记+上报
     *   其余                       → observing  → 不变更标记状态（保持现状）
     *
     * 关键特性：
     * - 即使之前判过 human，只要后续窗口持续落入 bot 区间就立刻标 bot；
     * - 即使之前判过 bot，只要后续窗口持续落入 human 区间就尝试清标记；
     * - 从不停止采集和判定，登录期间全程有效。
     */
    function autoTick() {
        if (!autoActive) return;

        const f = computeFeatures(autoPoints);
        const conf = f ? humanConfidence(f) : 0;

        // 数据不足不判定（但继续采集）
        if (!f || f.n < MIN_POINTS || f.totalDist < MIN_PATH) {
            autoHumanStreak = 0;
            autoBotStreak = 0;
            return;
        }

        // 三区间持续判定
        if (conf >= HUMAN_THRESHOLD) {
            // 落入 human 区间
            autoBotStreak = 0;
            autoHumanStreak++;
            if (autoHumanStreak >= AUTO_STABLE) {
                // 连续足够多轮都是人类特征 → 确认真人，尝试清标记
                tryClearBehaviorFlag(f, conf);
                autoHumanStreak = 0;  // 重置但保持监测（不清除 autoActive）
            }
        } else if (conf <= BOT_THRESHOLD) {
            // 落入 bot 区间
            autoHumanStreak = 0;
            autoBotStreak++;
            if (autoBotStreak >= AUTO_STABLE) {
                // 连续足够多轮都是机器人特征 → 确认机器人，标记+上报
                tryFlagAsBot(f, conf);
                autoBotStreak = 0;  // 重置但保持监测
            }
        } else {
            // 观察区间（BOT_THRESHOLD < conf < HUMAN_THRESHOLD）
            // 特征不明显，维持当前标记状态不变，重置两边 streak
            autoHumanStreak = 0;
            autoBotStreak = 0;
        }

        // 定期上报风险分数给后端（用于趋势分析和服务端兜底）
        const now = Date.now();
        if (now - autoLastReportTime >= AUTO_REPORT_MS) {
            autoLastReportTime = now;
            reportAutoRisk(conf, f);
        }
    }

    function beginAuto() {
        if (autoActive) return;
        if (!localStorage.getItem(TOKEN_KEY)) return;  // 仅登录用户启用
        autoActive = true;
        autoPoints = [];
        autoLastT = 0;
        autoHumanStreak = 0;
        autoBotStreak = 0;
        autoLastReportTime = Date.now();
        document.addEventListener('pointermove', autoOnMove, { passive: true });
        autoTimer = setInterval(autoTick, 300);  // 每 300ms 用滑动窗口数据重判一次
    }

    function endAuto() {
        if (!autoActive) return;
        autoActive = false;
        document.removeEventListener('pointermove', autoOnMove);
        if (autoTimer) clearInterval(autoTimer);
        autoTimer = null;
        autoPoints = [];  // 释放缓冲区
    }

    function sizeCanvas() {
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.round(rect.width * dpr));
        canvas.height = Math.max(1, Math.round(rect.height * dpr));
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function relPos(e) {
        const rect = canvas.getBoundingClientRect();
        return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function onMove(e) {
        if (!active) return;
        if (e.isTrusted === false) return;  // 过滤自动化脚本注入的合成事件
        const now = (e.timeStamp && e.timeStamp > 0) ? e.timeStamp : performance.now();
        if (now - lastT < SAMPLE_MIN_INTERVAL) return;
        const p = relPos(e);
        points.push({ x: p.x, y: p.y, t: now });
        if (points.length > MAX_POINTS) points.shift();
        lastT = now;
        if (hint) hint.style.opacity = '0';
    }

    function std(arr) {
        if (arr.length < 2) return 0;
        const m = avg(arr);
        let s = 0;
        for (const v of arr) s += (v - m) * (v - m);
        return Math.sqrt(s / arr.length);
    }

    function movingAverage(pts, w) {
        const out = [];
        for (let i = 0; i < pts.length; i++) {
            const s = Math.max(0, i - w), e = Math.min(pts.length - 1, i + w);
            let x = 0, y = 0, c = 0;
            for (let j = s; j <= e; j++) { x += pts[j].x; y += pts[j].y; c++; }
            out.push({ x: x / c, y: y / c });
        }
        return out;
    }

    function computeFeatures(pts) {
        const n = pts.length;
        if (n < 2) return null;
        const speeds = [], dts = [], dirChanges = [];
        let totalDist = 0, teleported = false;
        for (let i = 1; i < n; i++) {
            const a = pts[i - 1], b = pts[i];
            const dx = b.x - a.x, dy = b.y - a.y;
            const dt = b.t - a.t;
            if (dt <= 0) continue;
            const dist = Math.hypot(dx, dy);
            totalDist += dist;
            const sp = dist / dt;
            speeds.push(sp);
            dts.push(dt);
            if (sp > TELEPORT_SPEED) teleported = true;
            if (i >= 2) {
                const t1 = Math.atan2(a.y - pts[i - 2].y, a.x - pts[i - 2].x);
                const t2 = Math.atan2(dy, dx);
                let d = t2 - t1;
                while (d > Math.PI) d -= 2 * Math.PI;
                while (d < -Math.PI) d += 2 * Math.PI;
                dirChanges.push(d);
            }
        }
        // 加速度（速度变化率）反转次数：人类加减速频繁、方向多变
        let accelSignChanges = 0, lastSign = 0;
        for (let i = 1; i < speeds.length; i++) {
            const dt = dts[i] || dts[i - 1];
            if (!dt) continue;
            const acc = (speeds[i] - speeds[i - 1]) / dt;
            const s = Math.sign(acc);
            if (s !== 0 && lastSign !== 0 && s !== lastSign) accelSignChanges++;
            if (s !== 0) lastSign = s;
        }
        // 自然抖动：相对移动平均轨迹的高频残差
        const smoothed = movingAverage(pts, 4);
        let jitterSum = 0, jitterCnt = 0;
        for (let i = 2; i < n - 2; i++) {
            jitterSum += Math.hypot(pts[i].x - smoothed[i].x, pts[i].y - smoothed[i].y);
            jitterCnt++;
        }
        const jitterMean = jitterCnt ? jitterSum / jitterCnt : 0;
        const meanStep = totalDist / Math.max(1, n - 1);
        const jitterRatio = meanStep > 0 ? jitterMean / meanStep : 0;

        const sx = pts[0].x, sy = pts[0].y;
        const ex = pts[n - 1].x, ey = pts[n - 1].y;
        const netDisp = Math.hypot(ex - sx, ey - sy);
        const straightness = totalDist > 0 ? netDisp / totalDist : 0;

        const meanSpeed = avg(speeds);
        const speedCv = meanSpeed > 0 ? std(speeds) / meanSpeed : 0;
        const dtMean = avg(dts);
        const dtCv = dtMean > 0 ? std(dts) / dtMean : 0;
        const dirEntropy = entropy(dirChanges, 12);

        return {
            n, totalDist, straightness, speed_cv: speedCv, dt_cv: dtCv,
            dir_entropy: dirEntropy, jitter_ratio: jitterRatio, jitter_mean: jitterMean,
            accel_sign_changes: accelSignChanges, teleported, meanSpeed,
        };
    }

    function humanConfidence(f) {
        if (!f) return 0;
        let c = 0.5;  // 中性基线
        // 人类正向特征（推动置信度上升）
        if (f.speed_cv >= 0.2 && f.speed_cv <= 1.6) c += 0.12;
        if (f.dir_entropy > 1.2) c += 0.12;
        if (f.jitter_ratio > 0.02 && f.jitter_ratio < 0.45) c += 0.15;
        if (f.accel_sign_changes >= 3) c += 0.10;
        if (f.dt_cv > 0.15) c += 0.08;
        if (f.straightness > 0.3 && f.straightness < 0.98) c += 0.08;
        // 机器人负向特征（推动置信度下降）
        if (f.teleported) c -= 0.45;
        if (f.straightness > 0.97 && f.totalDist > 300) c -= 0.30;
        if (f.dt_cv < 0.03 && f.n > 30) c -= 0.18;
        if (f.jitter_ratio < 0.005 && f.n > 20) c -= 0.20;
        if (f.speed_cv < 0.04 && f.totalDist > 200) c -= 0.18;
        return Math.max(0, Math.min(1, c));
    }

    function confColor(c) {
        if (c >= 0.6) return 'linear-gradient(90deg,#22c55e,#16a34a)';
        if (c >= 0.4) return 'linear-gradient(90deg,#f59e0b,#d97706)';
        return 'linear-gradient(90deg,#ef4444,#dc2626)';
    }

    function setChip(id, val) {
        const el = document.getElementById(id);
        if (el) el.textContent = val;
    }

    function draw() {
        if (!ctx || !canvas) return;
        const w = canvas.clientWidth, h = canvas.clientHeight;
        ctx.clearRect(0, 0, w, h);
        if (points.length < 2) return;
        const grad = ctx.createLinearGradient(
            points[0].x, points[0].y,
            points[points.length - 1].x, points[points.length - 1].y);
        grad.addColorStop(0, '#5b8cff');
        grad.addColorStop(1, '#9b6bff');
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.strokeStyle = grad;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
        ctx.stroke();
        const lp = points[points.length - 1];
        ctx.fillStyle = '#9b6bff';
        ctx.beginPath();
        ctx.arc(lp.x, lp.y, 4, 0, Math.PI * 2);
        ctx.fill();
    }

    function tick() {
        if (!active) return;
        draw();
        const f = computeFeatures(points);
        const conf = f ? humanConfidence(f) : 0;
        const pct = Math.round(conf * 100);
        if (gaugeFill) {
            gaugeFill.style.width = (f ? pct : 0) + '%';
            gaugeFill.style.background = confColor(conf);
        }
        if (confVal) confVal.textContent = f ? pct + '%' : '采集中…';
        setChip('feat-samples', f ? f.n : 0);
        setChip('feat-cv', f ? round3(f.speed_cv).toFixed(3) : '--');
        setChip('feat-dir', f ? round3(f.dir_entropy).toFixed(2) : '--');
        setChip('feat-jitter', f ? round3(f.jitter_ratio).toFixed(3) : '--');
        setChip('feat-acc', f ? f.accel_sign_changes : '--');

        if (finalized) return;
        const ready = f && f.n >= MIN_POINTS && f.totalDist >= MIN_PATH;
        if (ready) {
            if (Math.abs(conf - lastConfidence) < 0.02) stableCount++; else stableCount = 0;
            lastConfidence = conf;
            const elapsed = performance.now() - startedAt;
            if (stableCount >= CONF_STABLE_ROUNDS || f.n >= TARGET_POINTS || elapsed > MAX_TIME_MS) {
                finalize(conf, f);
            }
        } else {
            stableCount = 0; lastConfidence = -1;
        }
    }

    function finalize(conf, f) {
        finalized = true;
        active = false;
        if (timer) clearInterval(timer);
        timer = null;
        canvas.removeEventListener('pointermove', onMove);
        const verdict = conf >= HUMAN_THRESHOLD ? 'human' : 'bot';
        pendingResult = { verdict, conf, f };
        if (resultBox) {
            resultBox.classList.remove('hidden');
            const isHuman = verdict === 'human';
            resultBox.className = 'traj-result ' + (isHuman ? 'human' : 'bot');
            resultBox.innerHTML = `
                <div class="traj-result-icon">${isHuman ? '✅' : '🤖'}</div>
                <div class="traj-result-title">${isHuman ? '验证通过：判定为真人' : '验证未通过：判定为自动化脚本'}</div>
                <div class="traj-result-desc">
                    ${isHuman
                        ? '轨迹特征符合人类行为模式（速度变化连续、方向自然多样、存在自然抖动）。'
                        : '轨迹呈现机械化特征（如近似直线、匀速、定时或缺乏自然抖动），疑似自动化脚本。'}
                </div>
                <div class="traj-result-stats">
                    <span>置信度 <b>${Math.round(conf * 100)}%</b></span>
                    <span>样本 <b>${f.n}</b></span>
                    <span>速度变异 <b>${round3(f.speed_cv).toFixed(2)}</b></span>
                    <span>方向熵 <b>${round3(f.dir_entropy).toFixed(2)}</b></span>
                    <span>自然抖动 <b>${round3(f.jitter_ratio).toFixed(3)}</b></span>
                </div>
            `;
        }
        if (verdict === 'human') {
            if (confirmBtn) confirmBtn.classList.remove('hidden');
            if (confirmHint) confirmHint.classList.remove('hidden');
        }
    }

    function onConfirm() {
        if (!pendingResult) return;
        const { verdict, conf, f } = pendingResult;
        if (verdict !== 'human') { reset(); return; }
        cleanup();
        if (onResult) {
            const cb = onResult;
            onResult = null;
            cb(true, { verdict, confidence: conf, samples: f.n, features: f });
        }
    }

    function reset() {
        points = [];
        lastT = 0;
        finalized = false;
        pendingResult = null;
        stableCount = 0;
        lastConfidence = -1;
        if (resultBox) { resultBox.classList.add('hidden'); resultBox.innerHTML = ''; }
        if (confirmBtn) confirmBtn.classList.add('hidden');
        if (confirmHint) confirmHint.classList.add('hidden');
        if (hint) hint.style.opacity = '1';
        if (gaugeFill) gaugeFill.style.width = '0%';
        if (confVal) confVal.textContent = '采集中…';
        ['feat-samples', 'feat-cv', 'feat-dir', 'feat-jitter', 'feat-acc']
            .forEach(id => setChip(id, id === 'feat-samples' ? 0 : '--'));
        start();
    }

    function start() {
        if (active) return;
        active = true;
        startedAt = performance.now();
        requestAnimationFrame(sizeCanvas);
        canvas.addEventListener('pointermove', onMove, { passive: true });
        timer = setInterval(tick, 60);
    }

    function cleanup() {
        if (timer) clearInterval(timer);
        timer = null;
        active = false;
        if (canvas) canvas.removeEventListener('pointermove', onMove);
        const modal = document.getElementById('trajectory-modal');
        if (modal) modal.classList.remove('active');
    }

    function cancel() {
        cleanup();
        if (onResult) {
            const cb = onResult;
            onResult = null;
            cb(false);
        }
    }

    function open(opts) {
        initDom();
        mode = (opts && opts.mode) || 'standalone';
        onResult = (opts && opts.onResult) || null;
        const modal = document.getElementById('trajectory-modal');
        if (modal) modal.classList.add('active');
        reset();
        const closeBtn = document.getElementById('traj-close');
        if (closeBtn) closeBtn.addEventListener('click', cancel, { once: true });
        if (modal) modal.addEventListener('click', (e) => { if (e.target === modal) cancel(); }, { once: true });
    }

    return { open, close: cleanup, beginAuto, endAuto };
})();

/**
 * 当受保护操作因行为异常被拦截（401 BEHAVIOR_REVERIFY）时，弹出鼠标轨迹二次验证。
 * 用户在弹窗区域内自然移动鼠标，前端完成轨迹分析并判定 human 后，调用
 * /api/behavior/reverify_trajectory 清除行为标记，再自动重试原请求。
 * 返回一个 Promise：用户通过验证 resolve(true)，关闭/取消 resolve(false)。
 * @returns {Promise<boolean>}
 */
function requestTrajectoryReverify() {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (val) => {
            if (settled) return;
            settled = true;
            MouseTrajectoryVerifier.close();
            resolve(val);
        };

        const launch = () => {
            MouseTrajectoryVerifier.open({
                mode: 'challenge',
                onResult: async (ok, payload) => {
                    if (!ok) { finish(false); return; }
                    try {
                        const res = await fetch('/api/behavior/reverify_trajectory', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Authorization': `Bearer ${localStorage.getItem(TOKEN_KEY)}`,
                            },
                            body: JSON.stringify(payload),
                        });
                        if (!res.ok) {
                            // 后端特征复核未过：重新打开让用户重试
                            launch();
                            return;
                        }
                        behaviorFlagged = false;  // 复核通过，清除客户端行为标记
                        // 同步重置自动后台检测状态，使徽标回到重新评估
                        MouseTrajectoryVerifier.endAuto();
                        MouseTrajectoryVerifier.beginAuto();
                        finish(true);
                    } catch (e) {
                        finish(false);
                    }
                },
            });
        };
        launch();
    });
}

/**
 * 初始化页面
 */
(async function init() {
    const token = localStorage.getItem(TOKEN_KEY);
    // 始终向服务端重新校验令牌有效性（而非仅依赖 localStorage 缓存）：
    // 这样账号被删除/令牌失效后，刷新页面即可同步为登出态（跨浏览器一致）。
    if (token) {
        await fetchCurrentUser();
    } else {
        updateAuthUI();
    }

    // 预热后端：免费实例休眠后首个请求需等待冷启动（20~40s）。
    // 在页面打开阶段先发一次请求并展示「连接中」，把等待吸收在此处，
    // 而不是用户点击登录之后；预热完成前禁用登录按钮，避免登录看似卡死。
    try {
        if (connBanner) connBanner.classList.remove('hidden');
        if (authBtn) authBtn.disabled = true;
        await warmUpServer();
    } finally {
        if (connBanner) connBanner.classList.add('hidden');
        if (authBtn) authBtn.disabled = false;
    }

    await refreshFiles();

    bindNoticeModal();
    showNotice();

    authBtn.addEventListener('click', openAuthModal);
    modalClose.addEventListener('click', closeAuthModal);
    authModal.addEventListener('click', (e) => {
        if (e.target === authModal) closeAuthModal();
    });

    statsClose.addEventListener('click', closeStatsModal);
    statsModal.addEventListener('click', (e) => {
        if (e.target === statsModal) closeStatsModal();
    });

    // 会话异常弹窗确认 → 强制登出
    const anomalyConfirm = document.getElementById('anomaly-confirm');
    if (anomalyConfirm) {
        anomalyConfirm.addEventListener('click', () => {
            const am = document.getElementById('session-anomaly-modal');
            if (am) am.classList.remove('active');
            logout();
        });
    }

    // 未登录下载 → 弹窗提示，并提供「去登录 / 去注册」入口
    const loginRequiredModal = document.getElementById('login-required-modal');
    if (loginRequiredModal) {
        const hideLoginRequired = () => loginRequiredModal.classList.remove('active');
        const goLogin = () => { hideLoginRequired(); switchTab('login'); openAuthModal(); };
        const goRegister = () => { hideLoginRequired(); switchTab('register'); openAuthModal(); };
        document.getElementById('login-required-close').addEventListener('click', hideLoginRequired);
        document.getElementById('login-required-go').addEventListener('click', goLogin);
        document.getElementById('login-required-register').addEventListener('click', goRegister);
        loginRequiredModal.addEventListener('click', (e) => {
            if (e.target === loginRequiredModal) hideLoginRequired();
        });
    }
    document.getElementById('stats-back').addEventListener('click', showStatsContentView);
    document.getElementById('stats-history-sort').addEventListener('click', toggleHistorySort);

    startActivePing();

    modalTabs.forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    loginForm.addEventListener('submit', handleLogin);
    registerForm.addEventListener('submit', handleRegister);
    bindAltchaWidget('login-form', 'login');
    bindAltchaWidget('register-form', 'register');
    bindAltchaWidget('behavior-modal', 'behavior');
    createSeriesForm.addEventListener('submit', handleCreateSeries);
    uploadFileForm.addEventListener('submit', handleUploadFile);
})();

/**
 * 从后端刷新文件列表
 */
// 文件列表加载超时（毫秒）：Render 免费实例与数据库都会休眠，
// 首个依赖 DB 的查询可能阻塞很久（30~60s 冷启动）。超过该时间视为加载失败并提示重试，
// 避免界面看起来「永久卡死」。该值独立于 warmUpServer 的预热超时。
const FILES_LOAD_TIMEOUT_MS = 45000;

async function refreshFiles() {
    // 立即给出明确的「正在唤醒」反馈，避免空白导致的卡死观感。
    // 免费实例（Web+数据库）闲置后会休眠，首次访问需冷启动，可能耗时 30~60 秒，
    // 这里明确告知用户「在等」，避免误以为卡死而反复刷新（刷新会重启冷启动计时）。
    listEl.innerHTML = `
        <div class="loading">
            <div class="spinner" aria-hidden="true"></div>
            正在连接服务器…（首次访问免费服务需冷启动，可能需 30~60 秒，请稍候不要刷新）
        </div>`;
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FILES_LOAD_TIMEOUT_MS);
        let response;
        try {
            response = await fetch('/files', { signal: controller.signal, cache: 'no-store' });
        } finally {
            clearTimeout(timer);
        }
        if (!response.ok) {
            throw new Error(`服务器返回 ${response.status}`);
        }
        const files = await response.json();
        renderFiles(files);
        updateUploadSeriesSelect(files);
    } catch (error) {
        const msg = (error && error.name === 'AbortError')
            ? '加载超时：服务器或数据库可能正在冷启动，请稍后重试'
            : (error && error.message ? error.message : '获取文件列表失败');
        listEl.innerHTML = `
            <div class="empty file-list-error">
                <span>⚠️ ${escapeHtml(msg)}</span>
                <button class="btn btn-primary btn-sm" id="retry-files-btn" type="button">重试</button>
            </div>`;
        const retryBtn = document.getElementById('retry-files-btn');
        if (retryBtn) retryBtn.addEventListener('click', refreshFiles);
    }
}

/**
 * 预热后端：发送一次轻量健康检查请求，触发（或等待）实例冷启动完成。
 * 冷启动期间该请求会阻塞直到实例就绪，从而把等待时间吸收在页面打开阶段。
 */
async function warmUpServer() {
    try {
        // 1) 探活：等待 Web 实例冷启动完成（最多 60s）
        const hc = new AbortController();
        const t1 = setTimeout(() => hc.abort(), 60000);
        await fetch('/api/health', { signal: hc.signal, cache: 'no-store' });
        clearTimeout(t1);

        // 2) 唤醒数据库：Render 免费实例的 Postgres 也会休眠，首个查询会阻塞很久。
        //    未登录用户不会走 fetchCurrentUser（不触库），所以这里主动打一次 /files，
        //    把 DB 唤醒的等待吸收在预热阶段，后续 refreshFiles 命中已唤醒的连接即快速返回。
        const dbc = new AbortController();
        const t2 = setTimeout(() => dbc.abort(), 60000);
        await fetch('/files', { signal: dbc.signal, cache: 'no-store' }).catch(() => {});
        clearTimeout(t2);
    } catch (e) {
        // 即使失败也继续：后续操作会自行重试/报错
    } finally {
        serverWarm = true;
    }
}

/**
 * 渲染文件列表
 * @param {Array} files - 系列分组数据
 */
function renderFiles(files) {
    if (!Array.isArray(files) || files.length === 0) {
        listEl.innerHTML = '<div class="empty">暂无示例文件</div>';
        return;
    }

    const isAdmin = currentUserIsAdmin();

    listEl.innerHTML = files.map(group => `
        <section class="series-group" data-series="${escapeHtml(group.series)}">
            <div class="series-header">
                <h2 class="series-title">${escapeHtml(group.series)}</h2>
                ${isAdmin ? `
                    <button class="btn btn-danger delete-series-btn" data-series="${escapeHtml(group.series)}">
                        删除系列
                    </button>
                ` : ''}
            </div>
            <div class="versions-grid">
                ${group.versions.map(file => `
                    <article class="file-card">
                        <div class="file-info">
                            <span class="file-name">${escapeHtml(file.version)}</span>
                            <span class="file-size">${escapeHtml(file.size)}</span>
                        </div>
                        <div class="file-actions">
                            <a class="download-btn" href="/download/${encodeURIComponent(file.name)}" download data-filename="${escapeHtml(file.name)}">
                                <svg viewBox="0 0 24 24" aria-hidden="true">
                                    <path d="M12 16l-5-5h3V4h4v7h3l-5 5zm-6 2h12v2H6v-2z"/>
                                </svg>
                                下载
                            </a>
                            ${isAdmin ? `
                                <button class="btn btn-danger delete-file-btn" data-series="${escapeHtml(group.series)}" data-filename="${escapeHtml(file.name)}">
                                    删除
                                </button>
                            ` : ''}
                        </div>
                    </article>
                `).join('')}
            </div>
        </section>
    `).join('');

    if (isAdmin) {
        bindAdminFileActions();
    }
    bindDownloadTracking();
}

/**
 * 绑定管理员删除按钮事件
 */
function bindAdminFileActions() {
    document.querySelectorAll('.delete-file-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const series = btn.dataset.series;
            const filename = btn.dataset.filename;
            if (!confirm(`确定要删除文件 ${filename} 吗？`)) return;
            await deleteFile(series, filename);
        });
    });

    document.querySelectorAll('.delete-series-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const series = btn.dataset.series;
            if (!confirm(`确定要删除整个系列 ${series} 及其所有文件吗？`)) return;
            await deleteSeries(series);
        });
    });
}

/**
 * 下载状态提示弹窗（非阻塞）。
 * state: 'downloading' | 'done' | 'warn'
 */
const DOWNLOAD_COOLDOWN_MS = 3000;  // 同一文件下载冷却期，期间拦截重复点击，避免重复打服务器
const DOWNLOAD_HIDE_MS = 2600;      // 提示弹窗自动消失延时
let downloadToastTimer = null;

function showDownloadToast(filename, state, title) {
    const toast = document.getElementById('download-toast');
    const icon = document.getElementById('download-toast-icon');
    const titleEl = document.getElementById('download-toast-title');
    const fileEl = document.getElementById('download-toast-file');
    if (!toast) return;
    const icons = { downloading: '⏳', done: '✅', warn: '⚠️' };
    toast.classList.remove('hidden', 'warn', 'done');
    if (state === 'warn') toast.classList.add('warn');
    if (state === 'done') toast.classList.add('done');
    icon.textContent = icons[state] || '⏳';
    if (state === 'downloading') {
        icon.innerHTML = '<span class="spin">⏳</span>';
    }
    titleEl.textContent = title;
    fileEl.textContent = filename || '';
    // 重新触发入场动画
    toast.style.animation = 'none';
    void toast.offsetWidth;
    toast.style.animation = '';
    if (downloadToastTimer) clearTimeout(downloadToastTimer);
    if (state !== 'downloading') {
        downloadToastTimer = setTimeout(() => toast.classList.add('hidden'), DOWNLOAD_HIDE_MS);
    }
}

/**
 * 程序化触发真实文件下载。
 * 下载接口要求登录（后端校验 Bearer 令牌），故用 fetch 携带 Authorization 头，
 * 取回二进制后通过 Blob + 临时锚点触发下载（避免把 JWT 暴露在 URL 中）。
 * @returns {Promise<boolean>} 下载是否成功发起
 */
async function triggerDownload(url, fallbackName) {
    const token = localStorage.getItem(TOKEN_KEY);
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let resp;
    try {
        resp = await fetch(url, { headers, credentials: 'same-origin' });
    } catch (e) {
        return false;
    }
    if (resp.status === 401 || resp.status === 403) {
        // 未登录 / 令牌失效：由调用方拦截并提示，这里兜底返回失败
        return false;
    }
    if (!resp.ok) {
        return false;
    }
    // 从 Content-Disposition 解析服务端指定的原始文件名（UTF-8 形式）
    let dlName = fallbackName || '';
    const cd = resp.headers.get('Content-Disposition');
    if (cd) {
        const m = cd.match(/filename\*=UTF-8''([^;]+)/);
        if (m) dlName = decodeURIComponent(m[1]);
    }
    try {
        const blob = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = dlName || '';
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * 绑定文件下载按钮：
 * 1) 拦截点击并弹出「下载状态」提示，让用户明确知道下载已开始，避免反复点击；
 * 2) 通过 data-downloading 标记 + 冷却期，在冷却期内拦截对同一文件的重复点击，
 *    杜绝重复触发 GET /download（每次都会累加下载量并重传文件，徒增服务器压力）；
 * 3) 登录用户仍异步上报一次下载行为（账号历史统计），为 fire-and-forget，不阻塞下载；
 *    若被行为认证标记为异常，authFetch 会自动弹出二次验证并在通过后重试上报。
 */
function bindDownloadTracking() {
    document.querySelectorAll('.download-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();  // 由我们控制实际下载触发，便于防抖与提示
            if (btn.dataset.downloading === '1') {
                // 冷却期内重复点击：直接提示，不再触发服务器请求
                showDownloadToast(btn.dataset.filename, 'warn', '下载已在进行，请稍候…');
                return;
            }
            const filename = btn.dataset.filename;
            const url = btn.getAttribute('href');
            if (!filename || !url) return;

            // 未登录拦截：下载需登录，未登录直接弹出提示弹窗并放弃，不触发服务器请求
            if (!localStorage.getItem(TOKEN_KEY) || !tokenIsUnexpired()) {
                showLoginRequired();
                return;
            }

            // 标记下载中：禁用按钮 + 弹窗反馈
            btn.dataset.downloading = '1';
            btn.classList.add('downloading');
            showDownloadToast(filename, 'downloading', '正在准备下载…');

            // 真正触发下载（fetch 携带令牌，未登录/失效由服务端 401 兜底）
            const ok = await triggerDownload(url, filename);

            if (ok) {
                // 登录用户上报下载行为（不影响下载本体）
                authFetch(`/api/download-log/${encodeURIComponent(filename)}`, {
                    method: 'POST',
                }).catch(() => { /* 统计失败不影响下载 */ });
                showDownloadToast(filename, 'done', '✅ 下载已开始，请到下载列表查看');
            } else {
                showDownloadToast(filename, 'warn', '下载失败，请先登录后重试');
            }

            // 冷却结束：恢复按钮，允许必要时再次下载
            setTimeout(() => {
                btn.dataset.downloading = '0';
                btn.classList.remove('downloading');
            }, DOWNLOAD_COOLDOWN_MS);
        });
    });
}

/**
 * 更新上传文件系列下拉框
 * @param {Array} files
 */
function updateUploadSeriesSelect(files) {
    const currentValue = uploadSeriesSelect.value;
    uploadSeriesSelect.innerHTML = '<option value="">选择系列</option>';
    if (!Array.isArray(files)) return;

    files.forEach(group => {
        const option = document.createElement('option');
        option.value = group.series;
        option.textContent = group.series;
        uploadSeriesSelect.appendChild(option);
    });

    if (currentValue) {
        uploadSeriesSelect.value = currentValue;
    }
}

/**
 * 绑定提示弹窗的手动关闭事件
 */
function bindNoticeModal() {
    noticeClose.addEventListener('click', closeNotice);
    noticeModal.addEventListener('click', (e) => {
        if (e.target === noticeModal) closeNotice();
    });
}

/**
 * 显示提示弹窗，5 秒后自动关闭
 */
function showNotice() {
    noticeModal.classList.add('active');
    if (window.__noticeTimer) clearTimeout(window.__noticeTimer);
    window.__noticeTimer = setTimeout(closeNotice, 5000);
}

/**
 * 关闭提示弹窗并停止倒计时
 */
function closeNotice() {
    noticeModal.classList.remove('active');
    if (window.__noticeTimer) {
        clearTimeout(window.__noticeTimer);
        window.__noticeTimer = null;
    }
}

/**
 * 打开登录弹窗
 */
function openAuthModal() {
    authModal.classList.add('active');
    authMessage.textContent = '';
    authMessage.className = 'auth-message';
}

/**
 * 关闭登录弹窗
 */
function closeAuthModal() {
    authModal.classList.remove('active');
    loginForm.reset();
    registerForm.reset();
    authMessage.textContent = '';
    authMessage.className = 'auth-message';
}

/**
 * 打开数据记录弹窗并加载统计数据
 */
function openStatsModal() {
    showStatsContentView();  // 每次打开都重置到总览视图
    statsModal.classList.add('active');
    fetchStats();
}

/**
 * 关闭数据记录弹窗
 */
function closeStatsModal() {
    statsModal.classList.remove('active');
    showStatsContentView();  // 关闭后复位，避免下次打开停留在历史视图
}

/**
 * 从后端获取统计数据（管理员专用）
 */
async function fetchStats() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;

    try {
        const response = await authFetch('/api/admin/stats');
        if (!response.ok) {
            throw new Error('获取统计数据失败');
        }
        const data = await response.json();
        renderStats(data);
    } catch (error) {
        console.error(error);
        const box = document.getElementById('stats-files');
        if (box) box.innerHTML = `<div class="stats-empty">${escapeHtml(error.message)}</div>`;
    }
}

/**
 * 将统计数据渲染到弹窗
 * @param {object} data - /api/admin/stats 返回的数据
 */
function renderStats(data) {
    document.getElementById('stats-total-downloads').textContent = data.total_downloads;
    document.getElementById('stats-total-visitors').textContent = data.total_visitors;

    renderQuota(data);

    const filesBox = document.getElementById('stats-files');
    if (!Array.isArray(data.files) || data.files.length === 0) {
        filesBox.innerHTML = '<div class="stats-empty">暂无文件下载记录</div>';
    } else {
        filesBox.innerHTML = data.files.map(file => `
            <div class="stats-file-row">
                <div class="stats-file-head">
                    <span class="stats-file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
                    <span class="stats-file-series">${escapeHtml(file.series)}</span>
                    <span class="stats-file-count">${file.downloads} 次</span>
                </div>
                <div class="stats-bar">
                    <span class="stats-bar-fill" style="width:${file.ratio}%"></span>
                </div>
                <span class="stats-file-ratio">占比 ${file.ratio}%</span>
            </div>
        `).join('');
    }

    const userBox = document.getElementById('stats-users');
    document.getElementById('stats-user-count').textContent = data.users.length;
    if (!Array.isArray(data.users) || data.users.length === 0) {
        userBox.innerHTML = '<li class="stats-empty">暂无注册账号</li>';
    } else {
        userBox.innerHTML = data.users.map(u => `
            <li class="stats-user-row" data-username="${escapeHtml(u.username)}">
                <span class="stats-user-info" role="button" tabindex="0" title="查看下载记录">
                    <span class="stats-user-name">${escapeHtml(u.username)}</span>
                    <span class="stats-user-role ${escapeHtml(u.role)}">${escapeHtml(u.role === 'admin' ? '管理员' : '用户')}</span>
                    ${u.high_risk ? '<span class="stats-user-risk" title="长期未上线且从未下载，已被标记为高危账号">高危</span>' : ''}
                    ${u.ip_location ? `<span class="stats-user-loc" title="最近登录 IP 地理位置">📍 ${escapeHtml(u.ip_location)}</span>` : ''}
                </span>
                <button class="btn btn-danger btn-sm stats-user-del" data-user="${escapeHtml(u.username)}">删除</button>
            </li>
        `).join('');

        // 绑定账号名点击 → 查看该用户的历史下载记录
        userBox.querySelectorAll('.stats-user-info').forEach(el => {
            const uname = el.closest('.stats-user-row').dataset.username;
            el.addEventListener('click', () => openUserHistory(uname));
            el.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openUserHistory(uname);
                }
            });
        });

        // 绑定删除按钮事件
        userBox.querySelectorAll('.stats-user-del').forEach(btn => {
            btn.addEventListener('click', async () => {
                const uname = btn.dataset.user;
                if (!confirm(`确定要删除用户「${uname}」吗？此操作不可恢复。`)) return;
                try {
                    const token = localStorage.getItem(TOKEN_KEY);
                    const res = await fetch(`/api/admin/users/${encodeURIComponent(uname)}`, {
                        method: 'DELETE',
                        headers: { 'Authorization': `Bearer ${token}` },
                    });
                    if (res.ok) {
                        fetchStats();  // 刷新列表
                    } else {
                        const err = await res.json().catch(() => ({ detail: '删除失败' }));
                        alert(err.detail || '删除失败');
                    }
                } catch (e) {
                    alert('请求失败，请重试');
                }
            });
        });
    }
}

/**
 * 将字节数格式化为易读文本（自动选择 KB / MB / GB）
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    const val = bytes / Math.pow(1024, i);
    const fixed = i === 0 ? 0 : (val >= 100 || Number.isInteger(val) ? 0 : 1);
    return `${val.toFixed(fixed)} ${units[i]}`;
}

/**
 * 渲染数据库额度进度条
 * @param {object} data - /api/admin/stats 返回的数据（含 db_size_bytes / db_quota_bytes）
 */
function renderQuota(data) {
    const usedEl = document.getElementById('quota-used');
    const remainingEl = document.getElementById('quota-remaining');
    const fillEl = document.getElementById('quota-bar-fill');
    const hintEl = document.getElementById('quota-hint');
    if (!usedEl || !remainingEl || !fillEl || !hintEl) return;

    const used = Number(data.db_size_bytes) || 0;
    const quota = Number(data.db_quota_bytes) || 0;

    usedEl.textContent = formatBytes(used);

    if (quota <= 0) {
        // 未配置额度：仅显示已用空间，不画进度比例
        remainingEl.textContent = '未配置额度';
        fillEl.style.width = '0%';
        hintEl.textContent = used > 0 ? `当前数据库占用 ${formatBytes(used)}` : '暂无额度信息';
        return;
    }

    const remaining = Math.max(0, quota - used);
    const pct = Math.min(100, (used / quota) * 100);
    remainingEl.textContent = formatBytes(remaining);
    fillEl.style.width = `${pct}%`;

    // 用量越高颜色越警示：<70% 正常（accent）/ <90% 警告（橙）/ >=90% 危险（红）
    fillEl.classList.remove('warn', 'danger');
    if (pct >= 90) fillEl.classList.add('danger');
    else if (pct >= 70) fillEl.classList.add('warn');

    hintEl.textContent = `已使用 ${(quota ? (used / quota * 100) : 0).toFixed(1)}% / 总额度 ${formatBytes(quota)}`;
}

/**
 * 视图切换：切换到历史记录面板 / 回到总览
 */
function showStatsHistoryView() {
    document.getElementById('stats-content').classList.add('hidden');
    document.getElementById('stats-history').classList.remove('hidden');
    document.getElementById('stats-back').classList.remove('hidden');
}

function showStatsContentView() {
    document.getElementById('stats-history').classList.add('hidden');
    document.getElementById('stats-content').classList.remove('hidden');
    document.getElementById('stats-back').classList.add('hidden');
}

/**
 * 打开指定账号的历史下载记录面板
 * @param {string} username
 */
let currentHistoryUser = '';
let historyOrder = 'desc';

async function openUserHistory(username) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;

    currentHistoryUser = username;
    showStatsHistoryView();
    setHistoryLoading();

    try {
        const res = await authFetch(
            `/api/admin/users/${encodeURIComponent(username)}/downloads?order=${historyOrder}`,
        );
        if (!res.ok) {
            const err = await res.json().catch(() => ({ detail: '获取下载记录失败' }));
            throw new Error(err.detail || '获取下载记录失败');
        }
        const data = await res.json();
        renderUserHistory(data);
    } catch (error) {
        document.getElementById('stats-history-body').innerHTML =
            `<tr><td colspan="3" class="stats-empty">${escapeHtml(error.message)}</td></tr>`;
        document.getElementById('stats-history-empty').classList.add('hidden');
    }
}

/**
 * 历史面板加载中占位
 */
function setHistoryLoading() {
    document.getElementById('stats-history-name').textContent = currentHistoryUser;
    document.getElementById('stats-history-sub').textContent = '';
    document.getElementById('stats-history-ratio').textContent = '';
    document.getElementById('stats-history-count').textContent = '加载中…';
    document.getElementById('stats-history-body').innerHTML =
        '<tr><td colspan="3" class="stats-empty">加载中…</td></tr>';
    document.getElementById('stats-history-empty').classList.add('hidden');
}

/**
 * 将某账号的历史下载记录渲染到面板
 * @param {object} data - /api/admin/users/{username}/downloads 返回
 */
function renderUserHistory(data) {
    document.getElementById('stats-history-name').textContent = data.username;
    document.getElementById('stats-history-sub').textContent =
        `已下载 ${data.downloaded_files} / 共 ${data.total_files} 个文件`;
    document.getElementById('stats-history-ratio').textContent = `下载比例 ${data.ratio}%`;

    const body = document.getElementById('stats-history-body');
    const emptyEl = document.getElementById('stats-history-empty');
    const countEl = document.getElementById('stats-history-count');

    if (!Array.isArray(data.history) || data.history.length === 0) {
        body.innerHTML = '';
        emptyEl.classList.remove('hidden');
        countEl.textContent = '';
        return;
    }

    emptyEl.classList.add('hidden');
    countEl.textContent = `共 ${data.history.length} 条记录`;
    body.innerHTML = data.history.map(item => `
        <tr>
            <td class="col-name" title="${escapeHtml(item.file_name)}">${escapeHtml(item.file_name)}</td>
            <td class="col-series">${escapeHtml(item.series)}</td>
            <td class="col-time">${escapeHtml(formatDateTime(item.downloaded_at))}</td>
        </tr>
    `).join('');

    // 排序按钮文案
    const sortBtn = document.getElementById('stats-history-sort');
    sortBtn.textContent = historyOrder === 'desc' ? '按时间 ↓ 最新优先' : '按时间 ↑ 最早优先';
}

/**
 * 格式化 ISO 时间为本地可读字符串
 * @param {string} iso
 * @returns {string}
 */
function formatDateTime(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
        `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * 切换历史记录排序（最新/最早），并重新拉取
 */
function toggleHistorySort() {
    historyOrder = historyOrder === 'desc' ? 'asc' : 'desc';
    if (currentHistoryUser) openUserHistory(currentHistoryUser);
}

/**
 * 切换登录/注册标签
 * @param {string} tab - 'login' 或 'register'
 */
function switchTab(tab) {
    modalTabs.forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    loginForm.classList.toggle('hidden', tab !== 'login');
    registerForm.classList.toggle('hidden', tab !== 'register');
    authMessage.textContent = '';
    authMessage.className = 'auth-message';
}

/**
 * 处理登录表单提交
 * @param {Event} event
 */
async function handleLogin(event) {
    event.preventDefault();
    const payload = getAltchaPayload('login-form', 'login');
    if (!payload) {
        showAuthMessage('请先完成人机验证', false);
        return;
    }
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    try {
        const response = await fetch('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                username,
                password,
                altcha: payload,
                bot_score: String(BotDetector.compute()),
            }),
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || '登录失败');
        }

        const data = await response.json();
        localStorage.setItem(TOKEN_KEY, data.access_token);
        await fetchCurrentUser();
        showAuthMessage('登录成功', true);
        setTimeout(closeAuthModal, 600);
    } catch (error) {
        showAuthMessage(error.message, false);
    }
}

/**
 * 处理注册表单提交
 * @param {Event} event
 */
async function handleRegister(event) {
    event.preventDefault();
    const payload = getAltchaPayload('register-form', 'register');
    if (!payload) {
        showAuthMessage('请先完成人机验证', false);
        return;
    }
    const username = document.getElementById('register-username').value.trim();
    const password = document.getElementById('register-password').value;

    try {
        const response = await fetch('/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                username,
                password,
                altcha: payload,
                bot_score: BotDetector.compute(),
            }),
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || '注册失败');
        }

        const data = await response.json();
        showAuthMessage(data.message || '注册成功，请登录', true);
        switchTab('login');
    } catch (error) {
        showAuthMessage(error.message, false);
    }
}

/**
 * 处理创建系列
 * @param {Event} event
 */
async function handleCreateSeries(event) {
    event.preventDefault();
    const nameInput = document.getElementById('new-series-name');
    const name = nameInput.value.trim();

    try {
        const response = await authFetch('/api/series', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ name }),
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || '创建失败');
        }

        const data = await response.json();
        showToast(data.message || '系列创建成功');
        nameInput.value = '';
        await refreshFiles();
    } catch (error) {
        showToast(error.message, true);
    }
}

/**
 * 处理上传文件
 * @param {Event} event
 */
async function handleUploadFile(event) {
    event.preventDefault();
    const series = uploadSeriesSelect.value;
    const fileInput = document.getElementById('upload-file-input');
    const file = fileInput.files[0];

    if (!series || !file) {
        showToast('请选择系列和文件', true);
        return;
    }

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await authFetch(`/api/series/${encodeURIComponent(series)}/files`, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || '上传失败');
        }

        const data = await response.json();
        showToast(data.message || '上传成功');
        fileInput.value = '';
        await refreshFiles();
    } catch (error) {
        showToast(error.message, true);
    }
}

/**
 * 删除文件
 * @param {string} series
 * @param {string} filename
 */
async function deleteFile(series, filename) {
    try {
        const response = await authFetch(`/api/series/${encodeURIComponent(series)}/files/${encodeURIComponent(filename)}`, {
            method: 'DELETE',
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || '删除失败');
        }

        const data = await response.json();
        showToast(data.message || '文件已删除');
        await refreshFiles();
    } catch (error) {
        showToast(error.message, true);
    }
}

/**
 * 删除系列
 * @param {string} series
 */
async function deleteSeries(series) {
    try {
        const response = await authFetch(`/api/series/${encodeURIComponent(series)}`, {
            method: 'DELETE',
        });

        if (!response.ok) {
            const data = await response.json();
            throw new Error(data.detail || '删除失败');
        }

        const data = await response.json();
        showToast(data.message || '系列已删除');
        await refreshFiles();
    } catch (error) {
        showToast(error.message, true);
    }
}

/**
 * 带认证头的 fetch 封装
 * @param {string} url
 * @param {object} options
 * @returns {Promise<Response>}
 */
function authFetch(url, options = {}) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) {
        throw new Error('未登录');
    }

    options.headers = options.headers || {};
    options.headers['Authorization'] = `Bearer ${token}`;
    return handleBehaviorChallenge(fetch(url, options), url, options);
}

/**
 * 包装一次 fetch Promise：若返回 401 且为行为验证异常（BEHAVIOR_REVERIFY），
 * 弹出轻量二次验证（ALTCHA），用户通过后再自动重试一次原请求。
 * 对用户透明：仅在被判定为异常时才出现，正常操作无感。
 * @param {Promise<Response>} responsePromise
 * @param {string} url
 * @param {object} options
 * @returns {Promise<Response>}
 */
async function handleBehaviorChallenge(responsePromise, url, options) {
    const res = await responsePromise;
    if (res.status === 401) {
        let detail = '';
        try {
            const data = await res.json();
            detail = (data && data.detail) || '';
        } catch (e) { /* 非 JSON 响应，忽略 */ }
        if (typeof detail === 'string' && detail.startsWith('BEHAVIOR_REVERIFY')) {
            const verified = await requestTrajectoryReverify();
            if (verified) {
                // 重新发起原请求（带最新 token）
                const token = localStorage.getItem(TOKEN_KEY);
                const opts = options || {};
                opts.headers = opts.headers || {};
                opts.headers['Authorization'] = `Bearer ${token}`;
                return fetch(url, opts);
            }
        }
    }
    return res;
}

/**
 * 获取当前登录用户信息
 */
async function fetchCurrentUser() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;

    try {
        const response = await fetch('/auth/me', {
            headers: { 'Authorization': `Bearer ${token}` },
        });

        if (!response.ok) {
            throw new Error('获取用户信息失败');
        }

        const user = await response.json();
        localStorage.setItem(USER_KEY, JSON.stringify(user));
        updateAuthUI();
    } catch (error) {
        console.error(error);
        logout();
    }
}

/**
 * 更新顶部认证状态 UI
 */
function updateAuthUI() {
    const userJson = localStorage.getItem(USER_KEY);
    if (userJson) {
        const user = JSON.parse(userJson);
        const isAdmin = user.role === 'admin';
        headerAuth.innerHTML = `
            <div class="user-info">
                <span class="user-name">${escapeHtml(user.username)}</span>
                <span class="user-role ${escapeHtml(user.role)}">${escapeHtml(isAdmin ? '管理员' : '用户')}</span>
            </div>
            ${isAdmin ? '<button class="btn btn-secondary" id="stats-btn">数据记录</button>' : ''}
            <button class="btn btn-primary" id="logout-btn">退出</button>
        `;
        // 「数据记录」为管理员专属，普通用户不渲染、不绑定
        const statsBtn = document.getElementById('stats-btn');
        if (statsBtn) statsBtn.addEventListener('click', openStatsModal);
        document.getElementById('logout-btn').addEventListener('click', logout);
    } else {
        headerAuth.innerHTML = `<button class="btn btn-primary" id="auth-btn">登录 / 注册</button>`;
        document.getElementById('auth-btn').addEventListener('click', openAuthModal);
    }

    updateAdminPanel();
    updateOnlineBadge();

    // 行为式人机认证：登录后开始采集轨迹，登出后停止
    if (userJson) {
        BehaviorMonitor.start();
        // 鼠标轨迹人机验证（自动后台检测，无需按钮）：登录后于网站内持续采集并判定
        MouseTrajectoryVerifier.beginAuto();
        // 启动会话状态轮询：实时感知账号被删除/撤销（数秒内弹出异常提示）
        startSessionStatusPoll();
    } else {
        BehaviorMonitor.stop();
        MouseTrajectoryVerifier.endAuto();
        stopSessionStatusPoll();
    }
}

/**
 * 获取或生成本机唯一的会话 ID（用于统计在线访问数）
 * @returns {string}
 */
function getSessionId() {
    let sid = localStorage.getItem(SESSION_KEY);
    if (!sid) {
        sid = (crypto.randomUUID && crypto.randomUUID())
            ? crypto.randomUUID()
            : 's-' + Date.now() + '-' + Math.random().toString(36).slice(2);
        localStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
}

/**
 * 向后端发送一次活动心跳，标记本会话当前在线
 */
async function pingActive() {
    try {
        await fetch('/api/active-ping', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ session_id: getSessionId() }),
        });
    } catch (error) {
        // 网络异常时静默忽略，下次心跳会重试
    }
}

/**
 * 启动访问心跳：页面加载后先发一次，之后定时发送
 */
function startActivePing() {
    pingActive();
    if (activePingTimer) clearInterval(activePingTimer);
    activePingTimer = setInterval(pingActive, ACTIVE_PING_INTERVAL);
}

/**
 * 拉取当前在线访问数并刷新左上角徽标（管理员专用）
 */
async function refreshOnlineCount() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    try {
        const response = await fetch('/api/admin/active-users', {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (response.status === 401) {
            // 令牌已过期：重新校验会话；若确实失效会自动登出并收起徽标，
            // 避免一直显示误导性的「0」
            fetchCurrentUser();
            return;
        }
        if (!response.ok) return;
        const data = await response.json();
        const countEl = document.getElementById('online-count');
        if (countEl) countEl.textContent = data.active_users;
    } catch (error) {
        // 忽略临时网络错误
    }
}

/**
 * 根据管理员身份显示/隐藏在线人数徽标并控制轮询
 */
function updateOnlineBadge() {
    const badge = document.getElementById('online-badge');
    if (!badge) return;

    if (currentUserIsAdmin()) {
        badge.classList.remove('hidden');
        refreshOnlineCount();
        if (!onlinePollTimer) {
            onlinePollTimer = setInterval(refreshOnlineCount, ONLINE_POLL_INTERVAL);
        }
    } else {
        badge.classList.add('hidden');
        if (onlinePollTimer) {
            clearInterval(onlinePollTimer);
            onlinePollTimer = null;
        }
    }
}

/**
 * 会话状态轮询：已登录用户定期向服务端确认账号仍有效。
 * - 账号被管理员删除后，/api/session/status 返回 401（get_current_user 找不到用户）。
 *   若此时 JWT 尚未过期 → 判定为账号被移除/撤销，弹出「异常行为检测」提示并登出。
 * - 正常返回时同步 behaviorFlagged 状态。
 */
const SESSION_STATUS_INTERVAL = 5000;  // 每 5 秒探一次（数秒内感知账号失效）

/**
 * 解析 JWT 判断令牌是否仍在有效期内（不验签，仅读 exp）。
 * 用于区分 401 的成因：令牌未过期却被拒 → 账号被删/撤销；令牌已过期 → 自然失效。
 */
function tokenIsUnexpired() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return false;
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return false;
        const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
        if (!payload.exp) return true;
        return payload.exp * 1000 > Date.now();
    } catch (e) {
        return false;
    }
}

async function pollSessionStatus() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;
    try {
        const res = await fetch('/api/session/status', {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        if (res.status === 401) {
            stopSessionStatusPoll();
            if (tokenIsUnexpired()) {
                // 令牌未过期却被拒 → 账号被删除/撤销，弹出异常行为检测提示
                showSessionAnomaly();
            } else {
                // 令牌自然过期 → 静默登出
                logout();
            }
            return;
        }
        if (res.ok) {
            const data = await res.json();
            if (data && data.flagged) behaviorFlagged = true;
        }
    } catch (e) { /* 网络错误忽略，下次重试 */ }
}

function startSessionStatusPoll() {
    stopSessionStatusPoll();
    pollSessionStatus();
    sessionStatusTimer = setInterval(pollSessionStatus, SESSION_STATUS_INTERVAL);
}

function stopSessionStatusPoll() {
    if (sessionStatusTimer) clearInterval(sessionStatusTimer);
    sessionStatusTimer = null;
}

/**
 * 显示会话异常（账号失效）弹窗并停止行为采集
 */
function showSessionAnomaly() {
    const modal = document.getElementById('session-anomaly-modal');
    if (modal) modal.classList.add('active');
    BehaviorMonitor.stop();
}

/**
 * 显示「请先登录后再下载」弹窗（未登录用户点击下载按钮时触发）
 */
function showLoginRequired() {
    const modal = document.getElementById('login-required-modal');
    if (modal) modal.classList.add('active');
}

/**
 * 更新管理员面板显示状态
 */
function updateAdminPanel() {
    if (currentUserIsAdmin()) {
        adminPanel.classList.remove('hidden');
    } else {
        adminPanel.classList.add('hidden');
    }
}

/**
 * 判断当前用户是否为管理员
 * @returns {boolean}
 */
function currentUserIsAdmin() {
    const userJson = localStorage.getItem(USER_KEY);
    if (!userJson) return false;
    const user = JSON.parse(userJson);
    return user.role === 'admin';
}

/**
 * 退出登录
 */
function logout() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    updateAuthUI();
    refreshFiles();
}

/**
 * 在弹窗中显示提示消息
 * @param {string} message
 * @param {boolean} success
 */
function showAuthMessage(message, success) {
    authMessage.textContent = message;
    authMessage.className = `auth-message ${success ? 'success' : ''}`;
}

/**
 * 显示 Toast 提示
 * @param {string} message
 * @param {boolean} isError
 */
function showToast(message, isError = false) {
    let toast = document.getElementById('toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'toast';
        toast.className = 'toast';
        document.body.appendChild(toast);
    }

    toast.textContent = message;
    toast.className = `toast ${isError ? 'error' : ''}`;
    requestAnimationFrame(() => toast.classList.add('show'));

    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

/**
 * 行为分析用数值工具（函数声明，已提升，可在 BehaviorMonitor 中直接调用）
 */
function avg(arr) {
    if (!arr.length) return 0;
    let s = 0;
    for (const v of arr) s += v;
    return s / arr.length;
}

function round3(n) {
    return Math.round(n * 1000) / 1000;
}

/**
 * 计算序列的直方图熵（以 2 为底），衡量取值的多样性。
 * 人类轨迹特征多样 → 熵高；机械化重复 → 熵低（趋近 0）。
 * @param {number[]} arr
 * @param {number} buckets
 * @returns {number}
 */
function entropy(arr, buckets) {
    if (!arr.length) return 0;
    let min = Infinity, max = -Infinity;
    for (const v of arr) {
        if (v < min) min = v;
        if (v > max) max = v;
    }
    if (min === max) return 0;  // 全部相同 → 无信息量
    const counts = new Array(buckets).fill(0);
    for (const v of arr) {
        let idx = Math.floor(((v - min) / (max - min)) * buckets);
        if (idx >= buckets) idx = buckets - 1;
        if (idx < 0) idx = 0;
        counts[idx]++;
    }
    let e = 0;
    for (const c of counts) {
        if (c === 0) continue;
        const p = c / arr.length;
        e -= p * Math.log2(p);
    }
    return e;
}

/**
 * 计算序列在指定滞后下的皮尔逊自相关系数（检测周期性/重复模式）。
 * @param {number[]} arr
 * @param {number} lag
 * @returns {number}
 */
function autocorr(arr, lag) {
    const n = arr.length;
    if (n <= lag + 1) return 0;
    const a = arr.slice(0, n - lag);
    const b = arr.slice(lag);
    const ma = avg(a), mb = avg(b);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < a.length; i++) {
        const va = a[i] - ma, vb = b[i] - mb;
        num += va * vb;
        da += va * va;
        db += vb * vb;
    }
    if (da === 0 || db === 0) return 0;
    return num / Math.sqrt(da * db);
}

function maxAutocorr(arr, maxLag) {
    let m = 0;
    for (let lag = 1; lag <= maxLag; lag++) {
        const c = Math.abs(autocorr(arr, lag));
        if (c > m) m = c;
    }
    return m;
}

/**
 * 转义 HTML 特殊字符，防止 XSS
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}
