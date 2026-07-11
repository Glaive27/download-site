/**
 * 文件下载中心前端脚本
 * 加载文件列表、渲染下载卡片、处理登录/注册、管理员操作
 */

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
let serverWarm = false;  // 后端是否已预热（冷启动完成后为 true）

/**
 * 初始化页面
 */
(async function init() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token && !localStorage.getItem(USER_KEY)) {
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

    startActivePing();

    modalTabs.forEach(tab => {
        tab.addEventListener('click', () => switchTab(tab.dataset.tab));
    });

    loginForm.addEventListener('submit', handleLogin);
    registerForm.addEventListener('submit', handleRegister);
    createSeriesForm.addEventListener('submit', handleCreateSeries);
    uploadFileForm.addEventListener('submit', handleUploadFile);
})();

/**
 * 从后端刷新文件列表
 */
async function refreshFiles() {
    try {
        const response = await fetch('/files');
        if (!response.ok) {
            throw new Error('获取文件列表失败');
        }
        const files = await response.json();
        renderFiles(files);
        updateUploadSeriesSelect(files);
    } catch (error) {
        listEl.innerHTML = `<div class="empty">加载失败：${escapeHtml(error.message)}</div>`;
    }
}

/**
 * 预热后端：发送一次轻量健康检查请求，触发（或等待）实例冷启动完成。
 * 冷启动期间该请求会阻塞直到实例就绪，从而把等待时间吸收在页面打开阶段。
 */
async function warmUpServer() {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 60000);  // 最多等 60s
        await fetch('/api/health', { signal: controller.signal, cache: 'no-store' });
        clearTimeout(timer);
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
                            <a class="download-btn" href="/download/${encodeURIComponent(file.name)}" download>
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
    statsModal.classList.add('active');
    fetchStats();
}

/**
 * 关闭数据记录弹窗
 */
function closeStatsModal() {
    statsModal.classList.remove('active');
}

/**
 * 从后端获取统计数据（管理员专用）
 */
async function fetchStats() {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return;

    try {
        const response = await fetch('/api/admin/stats', {
            headers: { 'Authorization': `Bearer ${token}` },
        });
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
                <span class="stats-user-info">
                    <span class="stats-user-name">${escapeHtml(u.username)}</span>
                    <span class="stats-user-role ${escapeHtml(u.role)}">${escapeHtml(u.role === 'admin' ? '管理员' : '用户')}</span>
                </span>
                <button class="btn btn-danger btn-sm stats-user-del" data-user="${escapeHtml(u.username)}">删除</button>
            </li>
        `).join('');

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
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    try {
        const response = await fetch('/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ username, password }),
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
    const username = document.getElementById('register-username').value.trim();
    const password = document.getElementById('register-password').value;

    try {
        const response = await fetch('/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
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
    return fetch(url, options);
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
        headerAuth.innerHTML = `
            <div class="user-info">
                <span class="user-name">${escapeHtml(user.username)}</span>
                <span class="user-role ${escapeHtml(user.role)}">${escapeHtml(user.role === 'admin' ? '管理员' : '用户')}</span>
            </div>
            <button class="btn btn-secondary" id="stats-btn">数据记录</button>
            <button class="btn btn-primary" id="logout-btn">退出</button>
        `;
        document.getElementById('stats-btn').addEventListener('click', openStatsModal);
        document.getElementById('logout-btn').addEventListener('click', logout);
    } else {
        headerAuth.innerHTML = `<button class="btn btn-primary" id="auth-btn">登录 / 注册</button>`;
        document.getElementById('auth-btn').addEventListener('click', openAuthModal);
    }

    updateAdminPanel();
    updateOnlineBadge();
    BotGuard.sync();   // 登录态变化时同步人机验证监控（非管理员启动，管理员/登出停止）
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
 * 转义 HTML 特殊字符，防止 XSS
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = String(text);
    return div.innerHTML;
}

/* ===================== 人机验证（反机器人）机制 ===================== */
/*
 * 检测方式：前端行为分析
 *   - 采集用户交互事件：mousemove / click / scroll / keydown / touchstart
 *   - 若 navigator.webdriver === true（无头浏览器 / 自动化框架）直接判定为机器人
 *   - 若在采样窗口内没有任何交互事件，判定为机器人（脚本 / 挂机 / 无操作）
 *   - 否则判定为正常人类
 * 管理员账号豁免：不监控、不弹窗、不注销。
 *
 * 状态机：
 *   idle --(首次检测为机器人)--> warn1(阻断10s) --自动关闭--> monitor(监控10s)
 *   monitor --(仍判定为机器人)--> warn2(阻断5s) --自动--> 自动注销(清除全部信息)
 *   monitor --(人类)--> idle(周期复检) ; warn1期间人类无法操作（弹窗阻断）
 *
 * 各阶段时间参数集中可配置（见 BOT_GUARD_CONFIG），修改即生效。
 */
const BOT_GUARD_CONFIG = {
    firstDetectMs: 10000,   // 首次检测前的采样窗口：登录后先采集交互，再判定
    firstWarnMs: 10000,     // 首次警告弹窗显示时长，结束后进入持续监控
    monitorMs: 10000,       // 冷却后持续监控时长，结束后再次判定
    secondWarnMs: 5000,     // 二次违规弹窗显示时长，结束后自动注销
    checkIntervalMs: 10000, // 正常状态下周期性复检间隔
};

const BotGuard = (() => {
    let active = false;
    let state = 'idle';        // idle | warn1 | monitor | warn2
    let events = [];           // 交互事件采样（存时间戳）
    let timers = [];           // setTimeout 句柄集合
    let countdownTimer = null; // 弹窗倒计时句柄
    let overlay = null;        // 当前阻断弹窗 DOM

    const EVENT_TYPES = ['mousemove', 'click', 'scroll', 'keydown', 'touchstart'];

    function clearTimers() {
        timers.forEach(clearTimeout);
        timers = [];
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
    }

    function schedule(fn, ms) {
        const id = setTimeout(fn, ms);
        timers.push(id);
        return id;
    }

    function onInteract() {
        if (!active) return;
        events.push(Date.now());
        if (events.length > 1000) events.shift();
    }

    function bindListeners() {
        EVENT_TYPES.forEach(ev =>
            window.addEventListener(ev, onInteract, { passive: true }));
    }

    function unbindListeners() {
        EVENT_TYPES.forEach(ev =>
            window.removeEventListener(ev, onInteract));
    }

    function isBot() {
        // 无头 / 自动化环境（如 Puppeteer、Playwright 无头模式）
        if (navigator.webdriver === true) return true;
        // 采样窗口内无任何交互 -> 判定为机器人 / 挂机 / 无操作
        return events.length === 0;
    }

    function resetEvents() { events = []; }

    /* ---- 阻断式弹窗（覆盖全屏，倒计时结束前阻断操作）---- */
    function showBlockModal(title, bodyHtml, totalMs, onCountdownEnd) {
        closeBlockModal();
        overlay = document.createElement('div');
        overlay.className = 'botguard-overlay';
        overlay.innerHTML = `
            <div class="botguard-card">
                <div class="botguard-icon">⚠️</div>
                <h2 class="botguard-title">${title}</h2>
                <div class="botguard-body">${bodyHtml}</div>
                <div class="botguard-count" id="botguard-count">${Math.ceil(totalMs / 1000)}</div>
                <div class="botguard-bar"><div class="botguard-bar-fill" id="botguard-bar"></div></div>
            </div>`;
        document.body.appendChild(overlay);

        const bar = overlay.querySelector('#botguard-bar');
        const count = overlay.querySelector('#botguard-count');
        const start = Date.now();
        countdownTimer = setInterval(() => {
            const remain = Math.max(0, totalMs - (Date.now() - start));
            count.textContent = Math.ceil(remain / 1000);
            bar.style.width = (remain / totalMs * 100) + '%';
            if (remain <= 0) {
                clearInterval(countdownTimer);
                countdownTimer = null;
                onCountdownEnd();
            }
        }, 100);
    }

    function closeBlockModal() {
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        overlay = null;
    }

    /* ---- 状态流转 ---- */
    function startMonitorLoop() {
        state = 'idle';
        resetEvents();
        schedule(() => {
            if (isBot()) enterWarn1();
            else startMonitorLoop();
        }, BOT_GUARD_CONFIG.checkIntervalMs);
    }

    function enterWarn1() {
        state = 'warn1';
        showBlockModal(
            '疑似机器人行为',
            '系统检测到当前会话可能存在自动化或无操作行为。<br>本警告 <b>10 秒</b> 后自动关闭，随后将进行持续监控。',
            BOT_GUARD_CONFIG.firstWarnMs,
            () => {
                closeBlockModal();
                enterMonitor();
            }
        );
    }

    function enterMonitor() {
        state = 'monitor';
        resetEvents();
        schedule(() => {
            if (isBot()) enterWarn2();
            else startMonitorLoop();
        }, BOT_GUARD_CONFIG.monitorMs);
    }

    function enterWarn2() {
        state = 'warn2';
        showBlockModal(
            '账号将被自动注销',
            '系统再次检测到疑似机器人行为。<br>出于安全考虑，<b>5 秒后您的账号将被自动注销，所有信息将被清除且不可恢复</b>。',
            BOT_GUARD_CONFIG.secondWarnMs,
            () => {
                closeBlockModal();
                performAutoLogout();
            }
        );
    }

    async function performAutoLogout() {
        const token = localStorage.getItem(TOKEN_KEY);
        // 尽力通知后端注销账号（清除服务器侧全部信息）
        if (token) {
            try {
                await fetch('/api/account', {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${token}` },
                });
            } catch (e) {
                // 忽略网络错误，前端仍执行本地注销
            }
        }
        stop();
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(SESSION_KEY);
        updateAuthUI();
        refreshFiles();
        showToast('账号因疑似机器人行为已被自动注销，全部信息已清除', true);
    }

    /* ---- 启停 ---- */
    function start() {
        if (active) return;
        if (currentUserIsAdmin()) return;   // 管理员豁免
        active = true;
        state = 'idle';
        resetEvents();
        bindListeners();
        // 首次检测：先采样 firstDetectMs，再判定
        schedule(() => {
            if (isBot()) enterWarn1();
            else startMonitorLoop();
        }, BOT_GUARD_CONFIG.firstDetectMs);
    }

    function stop() {
        active = false;
        state = 'idle';
        clearTimers();
        closeBlockModal();
        unbindListeners();
    }

    // 登录态变化时同步：登录且非管理员 -> 启动；否则停止
    function sync() {
        const userJson = localStorage.getItem(USER_KEY);
        if (userJson && !currentUserIsAdmin() && !active) {
            start();
        } else if ((!userJson || currentUserIsAdmin()) && active) {
            stop();
        }
    }

    return { start, stop, sync };
})();
