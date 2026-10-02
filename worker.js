// worker.js - دستیار کدنویسی تلگرام + پنل ادمین (نسخه نهایی)
// امکانات: دیباگ کد با AI، جستجوی وب، تحلیل عکس، خواندن فایل، تحلیل ZIP
// مدل: anthropic/claude-sonnet-4 | Base URL: bedrock-mantle

// =============== تنظیمات پیش‌فرض هوش مصنوعی ===============
const DEFAULT_AI_BASE_URL = 'https://bedrock-mantle.us-east-2.api.aws/v1';
const DEFAULT_AI_MODEL = 'anthropic/claude-sonnet-4';

// =============== پرامپت‌های سیستمی ===============
const PROMPTS = {
debug: `تو یک مهندس نرم‌افزار خبره هستی. کد کاربر را بررسی کن:
۱) باگ‌ها و خطاهای احتمالی را پیدا کن
۲) نسخه اصلاح‌شده کامل کد را داخل بلوک کد ارائه بده
۳) هر باگ را در یک خط توضیح بده
۴) در صورت نیاز پیشنهاد بهبود کوتاه بده
پاسخ به زبان فارسی باشد و خود کد انگلیسی بماند.`,

chat: `تو یک دستیار برنامه‌نویسی حرفه‌ای هستی. به سوال کاربر دقیق و کاربردی پاسخ بده و در صورت نیاز مثال کد بزن. پاسخ به زبان فارسی باشد.`,

photo: `این تصویر را تحلیل کن:
- اگر کد، اسکرین‌شات خطا، ترمینال یا IDE است: متن داخل آن را بخوان، مشکل را توضیح بده و راه‌حل بده
- در غیر این صورت محتوای تصویر را توضیح بده
پاسخ به زبان فارسی باشد.`,

file: `تو دستیار کدنویسی هستی. محتوای فایل زیر را بررسی کن:
۱) این فایل چه کاری انجام می‌دهد (خلاصه کوتاه)
۲) باگ‌ها و مشکلات احتمالی
۳) نسخه اصلاح‌شده کد (در صورت کد بودن)
پاسخ به زبان فارسی باشد.`,

zip: `تو مهندس نرم‌افزار هستی. فایل‌های ارسالی این پروژه را بررسی کن:
۱) ساختار و هدف پروژه
۲) باگ‌ها و مشکلات احتمالی
۳) مهم‌ترین پیشنهادهای بهبود
خلاصه و مفید، به زبان فارسی پاسخ بده.`
};

// =============== تنظیمات پیش‌فرض ===============
const DEFAULT_SETTINGS = {
max_code_length: 5000,
default_language: 'python',
welcome_message: 'به دستیار کدنویسی خوش آمدید! 🤖',
search_enabled: true,
ai_api_key: '',
ai_base_url: DEFAULT_AI_BASE_URL,
ai_model: DEFAULT_AI_MODEL,
ai_vision_model: DEFAULT_AI_MODEL
};

// پسوندهای فایل متنی/کد قابل تحلیل
const TEXT_EXTENSIONS = new Set([
'txt','js','ts','jsx','tsx','py','java','c','h','cpp','hpp','cc','cs','go',
'rb','rs','php','html','htm','css','scss','less','json','xml','yml','yaml',
'md','markdown','sql','sh','bash','bat','ps1','kt','kts','swift','dart',
'vue','svelte','ini','cfg','conf','toml','env','log','csv','tsv','r','m',
'pl','lua','gradle','properties','dockerfile','makefile','gitignore'
]);

export default {
async fetch(request, env, ctx) {
// CORS
if (request.method === 'OPTIONS') {
return new Response(null, {
headers: {
'Access-Control-Allow-Origin': '*',
'Access-Control-Allow-Methods': 'POST, GET, PUT, DELETE',
'Access-Control-Allow-Headers': 'Content-Type, Authorization',
},
});
}

const url = new URL(request.url);

// ============ مسیرهای Webhook ============
if (url.pathname === '/webhook' && request.method === 'POST') {
const update = await request.json();
await handleUpdate(update, env);
return new Response('OK', { status: 200 });
}

if (url.pathname === '/setup' && request.method === 'GET') {
return await setupWebhook(url, env);
}

// ============ احراز هویت اختیاری پنل ============
const isAdminPath = url.pathname.startsWith('/admin') || url.pathname.startsWith('/api');
if (isAdminPath && env.ADMIN_SECRET) {
const cookieToken = (request.headers.get('Cookie') || '').match(/admin_token=([^;]+)/)?.[1] || '';
const urlToken = url.searchParams.get('key') || '';
const headerToken = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
const token = cookieToken || urlToken || headerToken;
if (token !== env.ADMIN_SECRET) {
return new Response('🔒 دسترسی غیرمجاز. با ?key=YOUR_SECRET وارد شوید.', { status: 401 });
}
}

// ============ Admin Panel Routes ============
if (url.pathname === '/admin' || url.pathname === '/admin/') {
const res = await renderAdminPanel(env);
const key = url.searchParams.get('key');
if (key) {
res.headers.append('Set-Cookie', `admin_token=${encodeURIComponent(key)}; Path=/; HttpOnly; Secure; Max-Age=86400`);
}
return res;
}

if (url.pathname === '/api/stats' && request.method === 'GET') return await getStats(env);
if (url.pathname === '/api/users' && request.method === 'GET') return await getUsers(env);

if (url.pathname === '/api/user' && request.method === 'GET') {
return await getUserDetail(url.searchParams.get('id'), env);
}
if (url.pathname === '/api/user' && request.method === 'DELETE') {
return await deleteUser(url.searchParams.get('id'), env);
}

if (url.pathname === '/api/broadcast' && request.method === 'POST') {
const { message, type } = await request.json();
return await broadcastMessage(message, type, env);
}

if (url.pathname === '/api/settings' && request.method === 'GET') return await getSettings(env);
if (url.pathname === '/api/settings' && request.method === 'POST') {
const settings = await request.json();
return await saveSettings(settings, env);
}

// تست اتصال به هوش مصنوعی
if (url.pathname === '/api/test-ai' && request.method === 'POST') {
return await testAIConnection(env);
}

if (url.pathname === '/api/files' && request.method === 'GET') return await getFilesList(env);
if (url.pathname === '/api/file' && request.method === 'DELETE') {
return await deleteFile(url.searchParams.get('key'), env);
}
if (url.pathname === '/api/system' && request.method === 'GET') return await getSystemStatus(env);

return new Response('Bot is running! 🤖', { status: 200 });
}
};


// =============== Admin Panel HTML ===============

function escapeHtml(str) {
return String(str ?? '').replace(/[&<>"']/g, c => ({
'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
}[c]));
}

function maskApiKey(key) {
if (!key) return '';
if (key.length <= 10) return '••••••••';
return key.slice(0, 5) + '••••••••' + key.slice(-4);
}

async function renderAdminPanel(env) {
const stats = await getStatsData(env);
const users = await getUsersData(env);
const settings = await getSettingsData(env);

const html = `
<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>🤖 پنل مدیریت دستیار کدنویسی</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: 'Segoe UI', Tahoma, sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; padding: 20px; }
.container { max-width: 1400px; margin: 0 auto; }
.header { background: white; border-radius: 15px; padding: 20px; margin-bottom: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.1); display: flex; justify-content: space-between; align-items: center; }
.header h1 { color: #333; font-size: 24px; }
.header .status { padding: 8px 15px; border-radius: 20px; background: #4caf50; color: white; font-weight: bold; }
.stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 20px; }
.stat-card { background: white; border-radius: 15px; padding: 20px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); transition: transform 0.3s; }
.stat-card:hover { transform: translateY(-5px); }
.stat-card .icon { font-size: 40px; margin-bottom: 10px; }
.stat-card .value { font-size: 28px; font-weight: bold; color: #667eea; }
.stat-card .label { color: #666; margin-top: 5px; }
.panel { background: white; border-radius: 15px; padding: 20px; margin-bottom: 20px; box-shadow: 0 5px 15px rgba(0,0,0,0.1); }
.panel h2 { color: #333; margin-bottom: 15px; padding-bottom: 10px; border-bottom: 2px solid #f0f0f0; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 12px; text-align: right; border-bottom: 1px solid #f0f0f0; }
th { background: #f8f9fa; color: #333; font-weight: bold; }
tr:hover { background: #f8f9fa; }
.btn { padding: 8px 15px; border: none; border-radius: 5px; cursor: pointer; font-size: 14px; margin: 0 5px; transition: all 0.3s; }
.btn-danger { background: #f44336; color: white; }
.btn-success { background: #4caf50; color: white; }
.btn-info { background: #2196f3; color: white; }
.btn-warning { background: #ff9800; color: white; }
.btn:hover { opacity: 0.8; transform: scale(1.05); }
.modal { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 1000; }
.modal-content { background: white; margin: 10% auto; padding: 20px; border-radius: 15px; max-width: 500px; position: relative; }
.close { position: absolute; top: 10px; left: 15px; font-size: 24px; cursor: pointer; }
input, textarea, select { width: 100%; padding: 10px; margin: 10px 0; border: 1px solid #ddd; border-radius: 5px; font-size: 14px; }
.tab { display: inline-block; padding: 10px 20px; cursor: pointer; background: #f8f9fa; border-radius: 5px 5px 0 0; margin-right: 5px; }
.tab.active { background: #667eea; color: white; }
.tab-content { display: none; padding: 20px; background: white; border-radius: 0 0 15px 15px; }
.tab-content.active { display: block; }
.badge { padding: 5px 10px; border-radius: 15px; font-size: 12px; font-weight: bold; }
.badge-success { background: #4caf50; color: white; }
.badge-danger { background: #f44336; color: white; }
.badge-warning { background: #ff9800; color: white; }
.hint { color: #777; font-size: 13px; margin: 5px 0; }
code { background: #f0f0f0; padding: 2px 6px; border-radius: 4px; direction: ltr; display: inline-block; }
@media (max-width: 768px) {
.stats-grid { grid-template-columns: 1fr; }
.header { flex-direction: column; text-align: center; }
table { font-size: 12px; }
}
</style>
</head>
<body>
<div class="container">
<div class="header">
<h1>🤖 پنل مدیریت دستیار کدنویسی</h1>
<div class="status">🟢 آنلاین</div>
</div>

<div class="stats-grid">
<div class="stat-card"><div class="icon">👥</div><div class="value" id="totalUsers">${stats.total_users}</div><div class="label">کل کاربران</div></div>
<div class="stat-card"><div class="icon">💬</div><div class="value" id="totalMessages">${stats.total_messages}</div><div class="label">کل پیام‌ها</div></div>
<div class="stat-card"><div class="icon">📝</div><div class="value" id="totalCode">${stats.total_code}</div><div class="label">تحلیل کد</div></div>
<div class="stat-card"><div class="icon">🌐</div><div class="value" id="totalSearch">${stats.total_search}</div><div class="label">جستجوها</div></div>
<div class="stat-card"><div class="icon">📦</div><div class="value" id="totalFiles">${stats.total_files}</div><div class="label">فایل‌ها</div></div>
</div>

<div class="panel">
<div class="tab active" onclick="showTab('users')">👥 کاربران</div>
<div class="tab" onclick="showTab('files')">📦 فایل‌ها</div>
<div class="tab" onclick="showTab('settings')">⚙️ تنظیمات</div>
<div class="tab" onclick="showTab('ai')">🤖 هوش مصنوعی</div>
<div class="tab" onclick="showTab('broadcast')">📢 ارسال پیام</div>
</div>

<!-- Users Tab -->
<div id="users-tab" class="tab-content active">
<div class="panel">
<h2>👥 مدیریت کاربران</h2>
<div style="margin-bottom: 15px;">
<input type="text" id="searchUser" placeholder="🔍 جستجوی کاربر..." onkeyup="filterUsers()">
</div>
<table id="usersTable">
<thead>
<tr>
<th>ID</th><th>نام کاربری</th><th>زبان</th><th>تاریخ عضویت</th><th>عملیات</th>
</tr>
</thead>
<tbody>
${users.map(user => `
<tr>
<td>${user.id}</td>
<td>@${escapeHtml(user.username || 'کاربر')}</td>
<td>${escapeHtml(user.preferred_language || '-')}</td>
<td>${escapeHtml(user.created_at || '')}</td>
<td>
<button class="btn btn-info" onclick="viewUser('${user.id}')">👁️</button>
<button class="btn btn-danger" onclick="deleteUser('${user.id}')">🗑️</button>
</td>
</tr>
`).join('')}
</tbody>
</table>
</div>
</div>

<!-- Files Tab -->
<div id="files-tab" class="tab-content">
<div class="panel">
<h2>📦 مدیریت فایل‌ها</h2>
<table>
<thead><tr><th>نام فایل</th><th>نوع</th><th>سایز</th><th>تاریخ</th><th>عملیات</th></tr></thead>
<tbody id="filesTable"></tbody>
</table>
</div>
</div>

<!-- Settings Tab -->
<div id="settings-tab" class="tab-content">
<div class="panel">
<h2>⚙️ تنظیمات بات</h2>
<form onsubmit="saveSettings(event)">
<label>حداکثر طول کد:</label>
<input type="number" id="maxCodeLength" value="${settings.max_code_length || 5000}">

<label>زبان پیش‌فرض:</label>
<select id="defaultLanguage">
<option value="python" ${settings.default_language === 'python' ? 'selected' : ''}>Python</option>
<option value="javascript" ${settings.default_language === 'javascript' ? 'selected' : ''}>JavaScript</option>
<option value="html" ${settings.default_language === 'html' ? 'selected' : ''}>HTML</option>
<option value="java" ${settings.default_language === 'java' ? 'selected' : ''}>Java</option>
<option value="cpp" ${settings.default_language === 'cpp' ? 'selected' : ''}>C++</option>
</select>

<label>پیام خوش‌آمدگویی:</label>
<textarea id="welcomeMessage" rows="4">${escapeHtml(settings.welcome_message)}</textarea>

<label>فعال بودن جستجو:</label>
<select id="searchEnabled">
<option value="true" ${settings.search_enabled ? 'selected' : ''}>فعال</option>
<option value="false" ${!settings.search_enabled ? 'selected' : ''}>غیرفعال</option>
</select>

<button type="submit" class="btn btn-success">💾 ذخیره تنظیمات</button>
</form>
</div>
</div>

<!-- AI Tab -->
<div id="ai-tab" class="tab-content">
<div class="panel">
<h2>🤖 اتصال به هوش مصنوعی</h2>
<p class="hint">✅ مدل پیش‌فرض: <code>${DEFAULT_AI_MODEL}</code> — این مدل هم متن/کد و هم تصویر (عکس) را پشتیبانی می‌کند</p>
<p class="hint">Base URL پیش‌فرض پروژه: <code>${DEFAULT_AI_BASE_URL}</code></p>
<form onsubmit="saveAISettings(event)">
<label>Base URL:</label>
<input type="text" id="aiBaseUrl" value="${escapeHtml(settings.ai_base_url)}">

<label>API Key:</label>
<input type="text" id="aiApiKey" placeholder="کلید خود را وارد کنید (برای حفظ کلید قبلی خالی بگذارید)" value="${escapeHtml(maskApiKey(settings.ai_api_key))}">

<label>نام مدل (متن و کد):</label>
<input type="text" id="aiModel" value="${escapeHtml(settings.ai_model)}">

<label>نام مدل (بینایی — برای تحلیل عکس):</label>
<input type="text" id="aiVisionModel" value="${escapeHtml(settings.ai_vision_model)}">
<p class="hint">Claude Sonnet 4 قابلیت بینایی دارد؛ همان مدل برای تحلیل عکس هم استفاده می‌شود.</p>

<button type="submit" class="btn btn-success">💾 ذخیره</button>
<button type="button" class="btn btn-info" onclick="testAI()">🔌 تست اتصال</button>
</form>
<div id="aiTestResult" style="margin-top: 10px;"></div>
</div>
</div>

<!-- Broadcast Tab -->
<div id="broadcast-tab" class="tab-content">
<div class="panel">
<h2>📢 ارسال پیام به همه کاربران</h2>
<form onsubmit="sendBroadcast(event)">
<label>پیام:</label>
<textarea id="broadcastMessage" rows="4" placeholder="پیام خود را بنویسید..."></textarea>

<label>نوع ارسال:</label>
<select id="broadcastType">
<option value="all">همه کاربران</option>
<option value="active">کاربران فعال</option>
<option value="inactive">کاربران غیرفعال</option>
</select>

<button type="submit" class="btn btn-warning">📤 ارسال</button>
</form>
<div id="broadcastResult"></div>
</div>
</div>
</div>

<div id="userModal" class="modal">
<div class="modal-content">
<span class="close" onclick="closeModal()">&times;</span>
<h2 id="modalTitle">جزئیات کاربر</h2>
<div id="modalContent"></div>
</div>
</div>

<script>
function showTab(tabName) {
document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
event.target.classList.add('active');
document.getElementById(tabName + '-tab').classList.add('active');
if (tabName === 'files') loadFiles();
}

function filterUsers() {
const search = document.getElementById('searchUser').value.toLowerCase();
document.querySelectorAll('#usersTable tbody tr').forEach(row => {
row.style.display = row.textContent.toLowerCase().includes(search) ? '' : 'none';
});
}

async function viewUser(userId) {
const response = await fetch('/api/user?id=' + userId);
const data = await response.json();
document.getElementById('modalTitle').textContent = 'جزئیات کاربر';
document.getElementById('modalContent').innerHTML =
'<p><b>ID:</b> ' + data.user.id + '</p>' +
'<p><b>نام کاربری:</b> @' + (data.user.username || 'کاربر') + '</p>' +
'<p><b>زبان:</b> ' + (data.user.preferred_language || '-') + '</p>' +
'<p><b>تاریخ عضویت:</b> ' + (data.user.created_at || '-') + '</p>';
document.getElementById('userModal').style.display = 'block';
}

async function deleteUser(userId) {
if (!confirm('آیا از حذف این کاربر مطمئن هستید؟')) return;
const response = await fetch('/api/user?id=' + userId, { method: 'DELETE' });
const result = await response.json();
alert(result.message);
location.reload();
}

async function loadFiles() {
const response = await fetch('/api/files');
const data = await response.json();
const table = document.getElementById('filesTable');
table.innerHTML = data.files.map(file => \`
<tr>
<td>\${file.name}</td>
<td>\${file.type || 'file'}</td>
<td>\${formatSize(file.size)}</td>
<td>\${file.date}</td>
<td><button class="btn btn-danger" onclick="deleteFile('\${file.key}')">🗑️</button></td>
</tr>
\`).join('');
}

async function deleteFile(key) {
if (!confirm('حذف فایل؟')) return;
const response = await fetch('/api/file?key=' + encodeURIComponent(key), { method: 'DELETE' });
const result = await response.json();
alert(result.message);
loadFiles();
}

function formatSize(bytes) {
if (bytes < 1024) return bytes + ' B';
if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

async function saveSettings(event) {
event.preventDefault();
const settings = {
max_code_length: document.getElementById('maxCodeLength').value,
default_language: document.getElementById('defaultLanguage').value,
welcome_message: document.getElementById('welcomeMessage').value,
search_enabled: document.getElementById('searchEnabled').value === 'true'
};
const response = await fetch('/api/settings', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(settings)
});
const result = await response.json();
alert(result.message);
}

async function saveAISettings(event) {
event.preventDefault();
const settings = {
ai_base_url: document.getElementById('aiBaseUrl').value.trim(),
ai_api_key: document.getElementById('aiApiKey').value.trim(),
ai_model: document.getElementById('aiModel').value.trim(),
ai_vision_model: document.getElementById('aiVisionModel').value.trim()
};
const response = await fetch('/api/settings', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(settings)
});
const result = await response.json();
alert(result.message);
location.reload();
}

async function testAI() {
const el = document.getElementById('aiTestResult');
el.innerHTML = '<div class="badge badge-warning">⏳ در حال تست اتصال...</div>';
try {
const response = await fetch('/api/test-ai', { method: 'POST' });
const result = await response.json();
el.innerHTML = result.ok
? '<div class="badge badge-success">✅ ' + result.message + '</div>'
: '<div class="badge badge-danger">❌ ' + result.message + '</div>';
} catch (e) {
el.innerHTML = '<div class="badge badge-danger">❌ خطا: ' + e.message + '</div>';
}
}

async function sendBroadcast(event) {
event.preventDefault();
const message = document.getElementById('broadcastMessage').value;
const type = document.getElementById('broadcastType').value;
if (!message) { alert('لطفاً پیام را وارد کنید'); return; }
const response = await fetch('/api/broadcast', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ message, type })
});
const result = await response.json();
document.getElementById('broadcastResult').innerHTML =
'<div class="badge badge-success">' + result.message + '</div>';
}

function closeModal() {
document.getElementById('userModal').style.display = 'none';
}

// به‌روزرسانی خودکار آمار هر ۳۰ ثانیه
setInterval(async () => {
const response = await fetch('/api/stats');
const data = await response.json();
document.getElementById('totalUsers').textContent = data.total_users;
document.getElementById('totalMessages').textContent = data.total_messages;
document.getElementById('totalCode').textContent = data.total_code;
document.getElementById('totalSearch').textContent = data.total_search;
document.getElementById('totalFiles').textContent = data.total_files;
}, 30000);
</script>
</body>
</html>
`;

return new Response(html, {
headers: { 'Content-Type': 'text/html; charset=utf-8' }
});
}


// =============== موتور هوش مصنوعی (سازگار با OpenAI API) ===============

async function callAI(messages, env, options = {}) {
const settings = await getSettingsData(env);
const apiKey = settings.ai_api_key || env.OPENAI_API_KEY || '';
// اولویت: پنل → متغیر محیطی → مقدار پیش‌فرض پروژه
const baseUrl = (settings.ai_base_url || env.OPENAI_BASE_URL || DEFAULT_AI_BASE_URL).replace(/\/+$/, '');
const model = options.model || settings.ai_model || DEFAULT_AI_MODEL;

if (!apiKey) {
throw new Error('کلید API هوش مصنوعی تنظیم نشده. از پنل ادمین (تب هوش مصنوعی) وارد کنید.');
}

const res = await fetch(`${baseUrl}/chat/completions`, {
method: 'POST',
headers: {
'Content-Type': 'application/json',
'Authorization': `Bearer ${apiKey}`
},
body: JSON.stringify({
model: model,
messages: messages,
temperature: options.temperature ?? 0.3,
max_tokens: options.max_tokens || 2500
})
});

const data = await res.json().catch(() => ({}));
if (!res.ok) {
throw new Error(data.error?.message || `خطای سرویس هوش مصنوعی (کد ${res.status})`);
}

const content = data.choices?.[0]?.message?.content;
if (!content) throw new Error('پاسخی از هوش مصنوعی دریافت نشد');
return content;
}

async function testAIConnection(env) {
try {
const reply = await callAI(
[{ role: 'user', content: 'Reply with exactly: OK' }],
env,
{ max_tokens: 10 }
);
return jsonResponse({ ok: true, message: 'اتصال موفق! پاسخ مدل: ' + String(reply).trim().substring(0, 60) });
} catch (e) {
return jsonResponse({ ok: false, message: e.message });
}
}


// =============== مدیریت پیام‌های تلگرام ===============

async function handleUpdate(update, env) {
if (!update.message) return;

const chatId = update.message.chat.id;
const userId = update.message.from.id;
const username = update.message.from.username || 'کاربر';
const text = update.message.text || '';
const photo = update.message.photo;
const document = update.message.document;

try {
await saveUser(userId, username, chatId, env);

await incrementStat('total_messages', env);

if (photo) {
await handlePhoto(chatId, photo, env);
await incrementStat('total_files', env);
} else if (document) {
await handleDocument(chatId, document, env);
await incrementStat('total_files', env);
} else if (text.startsWith('/')) {
await handleCommand(chatId, userId, text, env);
} else {
await handleText(chatId, userId, text, env);
}
} catch (error) {
console.error('Error:', error);
await sendMessage(chatId, `❌ خطا: ${error.message}`, env);
}
}

// دستورات
async function handleCommand(chatId, userId, text, env) {
const parts = text.trim().split(/\s+/);
const command = parts[0].toLowerCase();
const args = parts.slice(1);
const settings = await getSettingsData(env);

switch (command) {
case '/start': {
await sendMessage(chatId, settings.welcome_message || 'به دستیار کدنویسی خوش آمدید! 🤖', env);
break;
}

case '/help': {
let help = '📋 راهنما:\n\n' +
'/start - شروع مجدد\n' +
'/help - نمایش این راهنما\n' +
'/lang <زبان> - تنظیم زبان پیش‌فرض\n\n' +
'🤖 قابلیت‌ها:\n' +
'• ارسال کد (متنی) → دیباگ خودکار با هوش مصنوعی\n' +
'• ارسال سوال → پاسخ از هوش مصنوعی\n' +
'• search: عبارت → جستجوی وب\n' +
'• 📷 ارسال عکس → تحلیل تصویر و خواندن کد/خطا از عکس\n' +
'• 📄 ارسال فایل کد → تحلیل و دیباگ فایل\n' +
'• 🗜️ ارسال فایل ZIP → تحلیل ساختار و کد پروژه';
if (!settings.ai_api_key && !env.OPENAI_API_KEY) {
help += '\n\n⚠️ هوش مصنوعی هنوز تنظیم نشده است!';
}
await sendMessage(chatId, help, env);
break;
}

case '/lang': {
if (args.length === 0) {
await sendMessage(chatId, '⚠️ لطفا زبان را مشخص کنید. مثال: /lang python', env);
} else {
const lang = args[0].toLowerCase();
await env.DB.prepare('UPDATE users SET preferred_language = ? WHERE id = ?').bind(lang, userId).run();
await sendMessage(chatId, `✅ زبان پیش‌فرض شما به «${lang}» تغییر یافت.`, env);
}
break;
}

default: {
await sendMessage(chatId, '❓ دستور ناشناخته است. برای راهنما /help را ارسال کنید.', env);
}
}
}

// پیام‌های متنی: جستجو، دیباگ کد با AI، یا چت با AI
async function handleText(chatId, userId, text, env) {
if (!text) return;
const settings = await getSettingsData(env);

// ۱) جستجوی وب: "search: عبارت" یا "جستجو: عبارت"
const searchMatch = text.match(/^\s*(search|جستجو)\s*:\s*(.+)$/i);
if (searchMatch) {
if (!settings.search_enabled) {
await sendMessage(chatId, '⚠️ قابلیت جستجو در حال حاضر غیرفعال است.', env);
return;
}
const query = searchMatch[2].trim();
await sendChatAction(chatId, 'typing', env);
const result = await webSearch(query);
await incrementStat('total_search', env);
await sendLongMessage(chatId, `🌐 نتیجه جستجو برای «${query}»:\n\n${result}`, env);
return;
}

// ۲) محدودیت طول
const maxLen = settings.max_code_length || 5000;
if (text.length > maxLen) {
await sendMessage(chatId, `⚠️ متن ارسالی بیش از حد مجاز (${maxLen} کاراکتر) است.`, env);
return;
}

await sendChatAction(chatId, 'typing', env);

// ۳) ارسال به هوش مصنوعی (کد → دیباگ / سوال → چت)
if (settings.ai_api_key || env.OPENAI_API_KEY) {
const isCode = detectLanguage(text) !== null;
try {
const reply = await callAI([
{ role: 'system', content: isCode ? PROMPTS.debug : PROMPTS.chat },
{ role: 'user', content: text }
], env);
if (isCode) await incrementStat('total_code', env);
await sendLongMessage(chatId, reply, env);
} catch (e) {
await sendLongMessage(chatId, '❌ خطا در هوش مصنوعی: ' + e.message, env);
}
return;
}

// ۴) بدون AI → تحلیل محلی ساده
const report = analyzeCode(text, settings.default_language);
await incrementStat('total_code', env);
await sendLongMessage(chatId, report + '\n\n💡 برای دیباگ واقعی، کلید API هوش مصنوعی را در پنل ادمین تنظیم کنید.', env);
}

// تحلیل عکس با مدل بینایی (Vision)
async function handlePhoto(chatId, photo, env) {
const settings = await getSettingsData(env);
const largest = photo[photo.length - 1];

try {
await sendChatAction(chatId, 'typing', env);
const fileInfo = await getTelegramFile(largest.file_id, env);

// ذخیره متادیتا
const key = `photo_${Date.now()}_${largest.file_id}`;
await env.FILES.put(key, JSON.stringify({
key,
name: (fileInfo.file_path || `${largest.file_id}.jpg`).split('/').pop(),
size: largest.file_size || fileInfo.file_size || 0,
date: new Date().toISOString(),
file_id: largest.file_id,
type: 'photo'
}));

if (!settings.ai_api_key && !env.OPENAI_API_KEY) {
await sendMessage(chatId, '📸 عکس ذخیره شد.\n💡 برای تحلیل عکس با هوش مصنوعی، کلید API را در پنل ادمین تنظیم کنید.', env);
return;
}

const buffer = await downloadTelegramFile(fileInfo.file_path, env);
if (buffer.byteLength > 8 * 1024 * 1024) {
await sendMessage(chatId, '⚠️ حجم عکس برای تحلیل زیاد است (حداکثر ۸ مگابایت).', env);
return;
}

const mime = (fileInfo.file_path || '').toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
const base64 = arrayBufferToBase64(buffer);

const reply = await callAI([{
role: 'user',
content: [
{ type: 'text', text: PROMPTS.photo },
{ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } }
]
}], env, {
model: settings.ai_vision_model || settings.ai_model,
max_tokens: 2000
});

await sendLongMessage(chatId, '📸 تحلیل عکس:\n\n' + reply, env);
} catch (error) {
await sendLongMessage(chatId, `❌ خطا در پردازش عکس: ${error.message}`, env);
}
}

// مدیریت فایل‌ها: فایل کد → تحلیل | ZIP → استخراج و تحلیل
async function handleDocument(chatId, document, env) {
const settings = await getSettingsData(env);
const fileName = document.file_name || 'file';
const ext = (fileName.split('.').pop() || '').toLowerCase();
const isZip = ext === 'zip' ||
document.mime_type === 'application/zip' ||
document.mime_type === 'application/x-zip-compressed';

// محدودیت API تلگرام: ۲۰ مگابایت
if ((document.file_size || 0) > 20 * 1024 * 1024) {
await sendMessage(chatId, '⚠️ حجم فایل بیش از ۲۰ مگابایت است و قابل پردازش نیست.', env);
return;
}

await sendChatAction(chatId, 'typing', env);

try {
const fileInfo = await getTelegramFile(document.file_id, env);
const buffer = await downloadTelegramFile(fileInfo.file_path, env);

// ذخیره متادیتا
const key = `doc_${Date.now()}_${document.file_id}`;
await env.FILES.put(key, JSON.stringify({
key,
name: fileName,
size: document.file_size || buffer.byteLength,
date: new Date().toISOString(),
file_id: document.file_id,
mime_type: document.mime_type || '',
type: isZip ? 'zip' : 'document'
}));

if (isZip) {
await handleZipFile(chatId, buffer, fileName, env, settings);
} else if (isTextFile(ext, document.mime_type)) {
await handleTextFile(chatId, buffer, fileName, env, settings);
} else {
await sendMessage(chatId, `📦 فایل «${fileName}» (${formatSizeClient(buffer.byteLength)}) ذخیره شد.\n💡 فقط فایل‌های متنی/کد و ZIP تحلیل می‌شوند.`, env);
}
} catch (error) {
await sendMessage(chatId, `❌ خطا در پردازش فایل: ${error.message}`, env);
}
}

// خواندن و تحلیل فایل متنی/کد
async function handleTextFile(chatId, buffer, fileName, env, settings) {
const text = new TextDecoder().decode(buffer);

if (!settings.ai_api_key && !env.OPENAI_API_KEY) {
const report = analyzeCode(text, null);
await sendLongMessage(chatId, `📄 فایل «${fileName}»:\n\n${report}\n\n💡 برای تحلیل کامل، کلید API هوش مصنوعی را در پنل تنظیم کنید.`, env);
return;
}

// محدود کردن حجم متن ارسالی به AI
const truncated = text.length > 150000
? text.substring(0, 150000) + '\n\n... [بخشی از فایل به دلیل حجم حذف شد]'
: text;

const reply = await callAI([
{ role: 'system', content: PROMPTS.file },
{ role: 'user', content: `نام فایل: ${fileName}\nمحتوا:\n${truncated}` }
], env, { max_tokens: 3000 });

await sendLongMessage(chatId, `📄 تحلیل «${fileName}»:\n\n${reply}`, env);
}

// استخراج و تحلیل فایل ZIP
async function handleZipFile(chatId, buffer, fileName, env, settings) {
let files;
try {
files = await extractZip(buffer);
} catch (e) {
await sendMessage(chatId, `❌ باز کردن ZIP ناموفق بود: ${e.message}`, env);
return;
}

// خلاصه محتویات
let summary = `🗜️ «${fileName}» شامل ${files.length} فایل:\n\n`;
summary += files.slice(0, 30).map(f => `• ${f.name} (${formatSizeClient(f.size)})`).join('\n');
if (files.length > 30) summary += `\n... و ${files.length - 30} فایل دیگر`;
await sendLongMessage(chatId, summary, env);

if (!settings.ai_api_key && !env.OPENAI_API_KEY) {
await sendMessage(chatId, '💡 برای تحلیل محتوای پروژه، کلید API هوش مصنوعی را در پنل تنظیم کنید.', env);
return;
}

// انتخاب فایل‌های متنی (حداکثر ۱۵ فایل / ۱۵۰هزار کاراکتر)
let combined = '';
let usedCount = 0;
let totalChars = 0;

for (const f of files) {
if (usedCount >= 15 || totalChars >= 150000) break;
const ext = (f.name.split('.').pop() || '').toLowerCase();
if (!f.content || !isTextFile(ext, '') || f.size > 100 * 1024) continue;
const content = new TextDecoder().decode(f.content);
if (totalChars + content.length > 150000) continue;
combined += `\n\n===== فایل: ${f.name} =====\n${content}`;
totalChars += content.length;
usedCount++;
}

if (usedCount === 0) {
await sendMessage(chatId, '⚠️ فایل متنی/کدی قابل تحلیل داخل ZIP پیدا نشد.', env);
return;
}

await sendChatAction(chatId, 'typing', env);

const reply = await callAI([
{ role: 'system', content: PROMPTS.zip },
{ role: 'user', content: `پروژه ZIP با نام «${fileName}» — فایل‌های خوانده‌شده:${combined}` }
], env, { max_tokens: 3000 });

await sendLongMessage(chatId, `🔍 تحلیل پروژه:\n\n${reply}`, env);
}

// استخراج ZIP با DecompressionStream داخلی Workers (بدون کتابخانه خارجی)
async function extractZip(buffer) {
const view = new DataView(buffer);
const decoder = new TextDecoder();

// جستجوی امضای End of Central Directory
let eocd = -1;
const minPos = Math.max(0, buffer.byteLength - 22 - 65536);
for (let i = buffer.byteLength - 22; i >= minPos; i--) {
if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
}
if (eocd < 0) throw new Error('ساختار فایل ZIP معتبر نیست');

let count = view.getUint16(eocd + 10, true);
let offset = view.getUint32(eocd + 16, true);
if (count > 500) count = 500; // محدودیت امنیتی

const files = [];

for (let i = 0; i < count; i++) {
if (view.getUint32(offset, true) !== 0x02014b50) break;

const method = view.getUint16(offset + 10, true);
const compressedSize = view.getUint32(offset + 20, true);
const uncompressedSize = view.getUint32(offset + 24, true);
const nameLen = view.getUint16(offset + 28, true);
const extraLen = view.getUint16(offset + 30, true);
const commentLen = view.getUint16(offset + 32, true);
const localOffset = view.getUint32(offset + 42, true);

const name = decoder.decode(new Uint8Array(buffer, offset + 46, nameLen));

if (!name.endsWith('/')) { // پوشه‌ها را رد کن
const lNameLen = view.getUint16(localOffset + 26, true);
const lExtraLen = view.getUint16(localOffset + 28, true);
const dataStart = localOffset + 30 + lNameLen + lExtraLen;
const rawData = new Uint8Array(buffer, dataStart, compressedSize);

let content = null;
if (method === 0) {
content = rawData; // بدون فشرده‌سازی
} else if (method === 8) {
const stream = new Blob([rawData]).stream()
.pipeThrough(new DecompressionStream('deflate-raw'));
content = new Uint8Array(await new Response(stream).arrayBuffer());
}

files.push({ name, size: uncompressedSize, content });
}

offset += 46 + nameLen + extraLen + commentLen;
}

return files;
}

// =============== جستجوی وب ===============

async function webSearch(query) {
try {
const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
const res = await fetch(url);
const data = await res.json();

let result = data.AbstractText || data.Answer || data.Definition || '';
if (data.AbstractURL) result += `\n🔗 ${data.AbstractURL}`;

if (data.RelatedTopics && data.RelatedTopics.length > 0) {
const related = data.RelatedTopics.filter(t => t.Text).slice(0, 5);
if (related.length > 0) {
result += '\n\n📌 موضوعات مرتبط:\n' +
related.map(t => `• ${t.Text}${t.FirstURL ? '\n ' + t.FirstURL : ''}`).join('\n');
}
}

return result || 'نتیجه مشخصی برای این عبارت پیدا نشد. عبارت دیگری را امتحان کنید.';
} catch (error) {
return `خطا در جستجو: ${error.message}`;
}
}


// =============== توابع کمکی ===============

function jsonResponse(data, status = 200) {
return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

function isTextFile(ext, mime) {
if (ext && TEXT_EXTENSIONS.has(ext)) return true;
if (mime && (mime.startsWith('text/') || mime.includes('json') ||
mime.includes('javascript') || mime.includes('xml') || mime.includes('yaml'))) return true;
return false;
}

function formatSizeClient(bytes) {
if (bytes < 1024) return bytes + ' B';
if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function arrayBufferToBase64(buffer) {
const bytes = new Uint8Array(buffer);
let binary = '';
const CHUNK = 0x8000;
for (let i = 0; i < bytes.length; i += CHUNK) {
binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
}
return btoa(binary);
}

function detectLanguage(code) {
if (/^\s*#include\s*<.+>/m.test(code)) return 'C/C++';
if (/<\?php/.test(code)) return 'PHP';
if (/public\s+(class|static\s+void\s+main)/.test(code)) return 'Java';
if (/def\s+\w+\s*\(.*\)\s*:/.test(code) || /^\s*import\s+\w+/m.test(code)) return 'Python';
if (/<html[\s>]|<div[\s>]|<!DOCTYPE/i.test(code)) return 'HTML';
if (/function\s+\w+\s*\(|=>|const\s+\w+\s*=|let\s+\w+\s*=/.test(code)) return 'JavaScript';
return null;
}

// تحلیل محلی ساده (fallback وقتی AI تنظیم نیست)
function analyzeCode(code, defaultLanguage) {
const language = detectLanguage(code) || defaultLanguage || 'نامشخص';
const lines = code.split('\n');
const issues = [];

const closers = { '(': ')', '[': ']', '{': '}' };
const openers = Object.keys(closers);
const closerSet = new Set(Object.values(closers));
const stack = [];
let unbalanced = false;

for (const ch of code) {
if (openers.includes(ch)) stack.push(closers[ch]);
else if (closerSet.has(ch)) {
if (stack.pop() !== ch) { unbalanced = true; break; }
}
}
if (unbalanced || stack.length > 0) {
issues.push('پرانتز / آکولاد / براکت نامتعادل یا بسته‌نشده پیدا شد.');
}

const todoCount = (code.match(/TODO|FIXME/gi) || []).length;
if (todoCount > 0) issues.push(`${todoCount} مورد TODO/FIXME در کد یافت شد.`);

const longLines = lines.filter(l => l.length > 120).length;
if (longLines > 0) issues.push(`${longLines} خط طولانی‌تر از ۱۲۰ کاراکتر وجود دارد.`);

let report = `🔍 نتیجه تحلیل کد:\n\n`;
report += `زبان تشخیص داده‌شده: ${language}\n`;
report += `تعداد خطوط: ${lines.length}\n`;
report += `تعداد کاراکتر: ${code.length}\n\n`;
report += issues.length > 0
? 'مشکلات یافت‌شده:\n' + issues.map(i => '• ' + i).join('\n')
: '✅ مشکل ساختاری مشخصی پیدا نشد.';

return report;
}

async function saveUser(userId, username, chatId, env) {
await env.DB.prepare(
`INSERT OR IGNORE INTO users (id, username, chat_id) VALUES (?, ?, ?)`
).bind(userId, username, chatId).run();
}

async function incrementStat(statName, env) {
const current = await env.STATS.get(statName);
const newValue = (parseInt(current) || 0) + 1;
await env.STATS.put(statName, newValue.toString());
}

async function sendMessage(chatId, text, env) {
const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
return await fetch(url, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ chat_id: chatId, text: text })
});
}

// ارسال پیام‌های طولانی (محدودیت تلگرام: ۴۰۹۶ کاراکتر)
async function sendLongMessage(chatId, text, env) {
const MAX = 4000;
if (!text) return;
if (text.length <= MAX) return sendMessage(chatId, text, env);
for (let i = 0; i < text.length; i += MAX) {
await sendMessage(chatId, text.substring(i, i + MAX), env);
}
}

async function sendChatAction(chatId, action, env) {
const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`;
await fetch(url, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ chat_id: chatId, action: action })
}).catch(() => {});
}

async function getTelegramFile(fileId, env) {
const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`;
const res = await fetch(url);
const data = await res.json();
return data.result || {};
}

async function downloadTelegramFile(filePath, env) {
const url = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
const res = await fetch(url);
if (!res.ok) throw new Error('دانلود فایل از تلگرام ناموفق بود');
return await res.arrayBuffer();
}

// =============== توابع API پنل ===============

async function getStats(env) {
return jsonResponse(await getStatsData(env));
}

async function getStatsData(env) {
const totalMessages = await env.STATS.get('total_messages') || '0';
const totalCode = await env.STATS.get('total_code') || '0';
const totalSearch = await env.STATS.get('total_search') || '0';
const totalFiles = await env.STATS.get('total_files') || '0';
const totalUsersRow = await env.DB.prepare('SELECT COUNT(*) as total FROM users').first();
return {
total_users: totalUsersRow?.total || 0,
total_messages: totalMessages,
total_code: totalCode,
total_search: totalSearch,
total_files: totalFiles
};
}

async function getUsers(env) {
return jsonResponse({ users: await getUsersData(env) });
}

async function getUsersData(env) {
const { results } = await env.DB.prepare(
'SELECT * FROM users ORDER BY created_at DESC LIMIT 100'
).all();
return results;
}

async function getUserDetail(userId, env) {
const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
return jsonResponse({
user: user || { id: userId, username: 'کاربر' }
});
}

async function deleteUser(userId, env) {
await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId).run();
return jsonResponse({ message: 'کاربر حذف شد' });
}

async function broadcastMessage(message, type, env) {
if (!message) return jsonResponse({ message: 'متن پیام خالی است' }, 400);

const stmt = (type && type !== 'all')
? env.DB.prepare('SELECT chat_id FROM users WHERE preferred_language = ?').bind(type)
: env.DB.prepare('SELECT chat_id FROM users');
const { results: users } = await stmt.all();

let sent = 0, failed = 0;
for (const user of users) {
try {
await sendMessage(user.chat_id, message, env);
sent++;
} catch (error) {
failed++;
}
}
return jsonResponse({ message: `ارسال شد: ${sent}، ناموفق: ${failed}`, sent, failed });
}

async function getSettings(env) {
return jsonResponse(await getSettingsData(env));
}

async function getSettingsData(env) {
const settings = await env.STATS.get('settings');
if (!settings) return { ...DEFAULT_SETTINGS };
return { ...DEFAULT_SETTINGS, ...JSON.parse(settings) };
}

// ذخیره تنظیمات با merge — کلید API ماسک‌شده یا خالی یعنی «تغییر نکن»
async function saveSettings(newSettings, env) {
const current = await getSettingsData(env);
if (!newSettings.ai_api_key || newSettings.ai_api_key.includes('••••')) {
newSettings.ai_api_key = current.ai_api_key || '';
}
const merged = { ...current, ...newSettings };
await env.STATS.put('settings', JSON.stringify(merged));
return jsonResponse({ message: 'تنظیمات ذخیره شد' });
}

async function getFilesList(env) {
const files = [];
const list = await env.FILES.list();
for (const key of list.keys) {
const metadata = await env.FILES.get(key.name);
if (metadata) files.push(JSON.parse(metadata));
}
return jsonResponse({ files });
}

async function deleteFile(fileKey, env) {
await env.FILES.delete(fileKey);
return jsonResponse({ message: 'فایل حذف شد' });
}

async function getSystemStatus(env) {
return jsonResponse({
status: 'healthy',
ai_base_url: DEFAULT_AI_BASE_URL,
ai_model: DEFAULT_AI_MODEL,
timestamp: new Date().toISOString()
});
}

async function setupWebhook(url, env) {
const workerUrl = `${url.origin}/webhook`;
const apiUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(workerUrl)}`;
const response = await fetch(apiUrl);
const data = await response.json();
return new Response(JSON.stringify(data, null, 2), {
headers: { 'Content-Type': 'application/json' }
});
}
