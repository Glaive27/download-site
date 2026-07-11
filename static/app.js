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

const TOKEN_KEY = 'download_site_token';
const USER_KEY = 'download_site_user';
const SESSION_KEY = 'download_site_session';

const ACTIVE_PING_INTERVAL = 20000;   // 每 20 秒发送一次心跳
const ONLINE_POLL_INTERVAL = 10000;   // 管理员每 10 秒刷新一次在线数

let activePingTimer = null;
let onlinePollTimer = null;

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
    await refreshFiles();

    bindNoticeModal();
    showNotice();

    authBtn.addEventListener('click', openAuthModal);
    modalClose.addEventListener('click', closeAuthModal);
    authModal.addEventListener('click', (e) => {
        if (e.target === authModal) closeAuthModal();
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
            <button class="btn btn-primary" id="logout-btn">退出</button>
        `;
        document.getElementById('logout-btn').addEventListener('click', logout);
    } else {
        headerAuth.innerHTML = `<button class="btn btn-primary" id="auth-btn">登录 / 注册</button>`;
        document.getElementById('auth-btn').addEventListener('click', openAuthModal);
    }

    updateAdminPanel();
    updateOnlineBadge();
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
