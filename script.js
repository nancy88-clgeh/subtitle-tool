// API_BASE：前端托管在 Vercel / Netlify / GitHub Pages 等第三方静态平台（免备案、免费子域名），
// 通过绝对地址调用北京后端 JSON API。后端已开 CORS *，fetch 不关心 attachment 头，跨域正常。
const API_BASE = "https://gegevidsubtitle-oohnkwnnat.cn-beijing.fcapp.run";  // 前端静态托管，固定指向北京后端

// 前端浏览器提取音频的内存安全阈值：超过 1GB 走云端直传处理
const MAX_BROWSER_SIZE = 1024 * 1024 * 1024; // 1GB

const $ = (id) => document.getElementById(id);

// 当前可见面板（三个 tab 各自独立勾选项）
function currentPanel() {
  return { video: "#panel-video", audio: "#panel-audio", text: "#panel-text" }[currentTab] || "#panel-video";
}

// 当前可见面板勾选的文案平台（不勾=只出字幕/文字）
function getPlatforms() {
  return [...document.querySelectorAll(currentPanel() + " .plat-cb:checked")].map((c) => c.value);
}

// 当前可见面板勾选的翻译目标语言（不勾=不翻译）
function getTargetLangs() {
  return [...document.querySelectorAll(currentPanel() + " .lang-cb:checked")].map((c) => c.value);
}

// ---------- 登录态 ----------
const TOKEN_KEY = "subtitle_tool_token";
function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }
function authHeaders(h) {
  h = h || {};
  const t = getToken();
  if (t) h["Authorization"] = "Bearer " + t;
  return h;
}

let ffmpeg = null;
async function loadFFmpeg() {
  if (ffmpeg) return;
  const { createFFmpeg, fetchFile } = FFmpeg;
  ffmpeg = createFFmpeg({
    log: false,
    // 单线程核心 core-st：无需 SharedArrayBuffer / COOP-COEP，GitHub Pages 可直接用
    mainName: "main",
    corePath: "https://ffmpeg-core-0801.oss-cn-beijing.aliyuncs.com/ffmpeg-core.js",
  });
  await ffmpeg.load();
}

function setProgress(msg, percent) {
  $("progress").textContent = msg;
  const bar = $("progressBar");
  const fill = $("progressFill");
  if (percent === undefined || percent === null) {
    bar.style.display = "none";
    fill.style.width = "0%";
  } else {
    bar.style.display = "block";
    fill.style.width = Math.max(0, Math.min(100, percent)) + "%";
  }
}

// 浏览器内统一转码：视频 / 音频 -> mp3 (16k 单声道，Paraformer 标准输入)
async function extractAudio(file) {
  await loadFFmpeg();
  // 输入名保留真实扩展名，ffmpeg 按扩展名 + 内容探测格式（mp3/wav/m4a/aac 等直接可解）
  const dot = file.name.lastIndexOf(".");
  let ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : "";
  ext = ext.replace(/[^a-z0-9]/g, "");
  const inputName = "input." + (ext || "mp4");
  // 清理上一次可能残留的虚拟文件：连续处理不刷新时 FS 会保留旧文件，
  // 若 output.mp3 已存在且缺少 -y，ffmpeg 会交互询问覆盖导致 wasm worker 卡死/崩溃
  for (const f of ["input.mp4", "input.mp3", "input.wav", "input.m4a", inputName, "output.mp3"]) {
    try { ffmpeg.FS("unlink", f); } catch (e) {}
  }
  ffmpeg.FS("writeFile", inputName, await FFmpeg.fetchFile(file));
  await ffmpeg.run(
    "-y",  // 覆盖已存在输出，避免 wasm 下交互询问导致 worker 终止
    "-i", inputName,
    "-vn", "-ac", "1", "-ar", "16000",
    "-b:a", "64k",
    "output.mp3"
  );
  const data = ffmpeg.FS("readFile", "output.mp3");
  const blob = new Blob([data.buffer], { type: "audio/mpeg" });
  // 用后释放，避免连续处理时 worker 内存累积导致崩溃
  for (const f of [inputName, "output.mp3"]) {
    try { ffmpeg.FS("unlink", f); } catch (e) {}
  }
  return blob;
}

// ---- XHR 上传（带进度）----
function xhrPostForm(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    const _t = getToken();
    if (_t) xhr.setRequestHeader("Authorization", "Bearer " + _t);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch (err) { reject(new Error("返回解析失败")); }
      } else {
        reject(new Error("服务器返回 " + xhr.status));
      }
    };
    xhr.onerror = () => reject(new Error("网络错误"));
    xhr.send(formData);
  });
}

function xhrPutFile(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new Error("上传失败 " + xhr.status));
    };
    xhr.onerror = () => reject(new Error("网络错误"));
    xhr.send(file);
  });
}

// 向后端申请视频直传的预签名 URL
async function getUploadUrl(filename) {
  const resp = await fetch(API_BASE + "/api/get-upload-url", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ filename }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error);
  return json; // { upload_url, object_key }
}

// ---- 小文件流程：浏览器转码音频后 POST（视频 / 纯音频通用）----
async function processSmall(file) {
  setProgress("① 正在浏览器内转码音频...", 5);
  const audioBlob = await extractAudio(file);
  setProgress("② 正在上传并生成内容...", 30);
  const form = new FormData();
  form.append("audio", audioBlob, "audio.mp3");
  form.append("duration_sec", String(window.__mediaDuration || 0));
  form.append("platforms", JSON.stringify(getPlatforms()));
  form.append("target_langs", JSON.stringify(getTargetLangs()));
  const json = await xhrPostForm(
    API_BASE + "/api/process",
    form,
    (p) => setProgress("② 上传中 " + Math.round(p * 100) + "%", 30 + p * 60)
  );
  if (json.error) throw new Error(json.error);
  return json;
}

// ---- 大文件流程：直传 OSS + 云端处理 ----
async function processLarge(file) {
  setProgress("① 正在获取上传凭证...", 0);
  const { upload_url, object_key } = await getUploadUrl(file.name);
  setProgress("② 正在上传视频到云端（大文件直传）...", 2);
  await xhrPutFile(
    upload_url,
    file,
    (p) => setProgress("② 上传中 " + Math.round(p * 100) + "%", 2 + p * 78)
  );
  setProgress("③ 云端提取音频并生成文案，请稍候...", 82);
  const resp = await fetch(API_BASE + "/api/process-video", {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ object_key, duration_sec: window.__mediaDuration || 0, platforms: getPlatforms(), target_langs: getTargetLangs() }),
  });
  const json = await resp.json();
  if (json.error) throw new Error(json.error);
  return json;
}

// ---- Tab 切换 ----
let currentTab = "video";
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    currentTab = t.dataset.tab;
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $("panel-video").style.display = currentTab === "video" ? "block" : "none";
    $("panel-audio").style.display = currentTab === "audio" ? "block" : "none";
    $("panel-text").style.display = currentTab === "text" ? "block" : "none";
  });
});

// ---- 主流程 ----
$("videoFile").addEventListener("change", (e) => {
  const f = e.target.files[0];
  $("fileName").textContent = f ? f.name : "选择视频文件";
  $("modeHint").textContent = "";
  window.__mediaDuration = 0;
  if (f && f.type.startsWith("video/")) {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => { window.__mediaDuration = v.duration || 0; };
    v.src = URL.createObjectURL(f);
  }
});

// 音频文件选择：用 <audio> 元素读取时长（用于额度计算）
$("audioFile").addEventListener("change", (e) => {
  const f = e.target.files[0];
  $("audioFileName").textContent = f ? f.name : "选择音频文件（mp3 / wav / m4a / 录音）";
  $("audioModeHint").textContent = "";
  window.__mediaDuration = 0;
  if (f) {
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.onloadedmetadata = () => { window.__mediaDuration = a.duration || 0; };
    a.src = URL.createObjectURL(f);
  }
});

// 字幕文件读取（.srt / .txt）：读成文本填进输入框
$("subtitleFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const text = await f.text();
  $("subtitleInput").value = text;
  $("textFileName").textContent = f.name;
});

async function onProcess(btn) {
  if (!getToken()) { alert("请先登录后再处理"); showLogin(); return; }
  btn.disabled = true;
  try {
    let json;
    if (currentTab === "video" || currentTab === "audio") {
      // 视频 / 纯音频共用流程：浏览器转码（或大文件云端转码）-> /api/process(-video)
      const isAudioTab = currentTab === "audio";
      const file = $(isAudioTab ? "audioFile" : "videoFile").files[0];
      const hintEl = $(isAudioTab ? "audioModeHint" : "modeHint");
      if (!file) {
        alert(isAudioTab ? "请先选择音频文件" : "请先选择视频文件");
        btn.disabled = false; return;
      }
      const platHint = (() => {
        const n = getPlatforms().length;
        return n ? `，将生成 ${n} 篇文案` : (isAudioTab ? "，仅转文字" : "，仅生成字幕");
      })();
      if (file.size <= MAX_BROWSER_SIZE) {
        hintEl.textContent = "本地模式：浏览器内转码（快、省流量）" + platHint;
        json = await processSmall(file);
      } else {
        hintEl.textContent = "大文件模式：直传云端处理（>1GB 自动切换）" + platHint;
        json = await processLarge(file);
      }
    } else {
      // 文本模式：直接把字幕文本发给后端生成文案
      const text = $("subtitleInput").value.trim();
      if (!text) { alert("请粘贴字幕或上传 .srt/.txt 文件"); btn.disabled = false; return; }
      setProgress("正在根据字幕生成文案...", 30);
      const resp = await fetch(API_BASE + "/api/from-text", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ text, platforms: getPlatforms(), target_langs: getTargetLangs() }),
      });
      const j = await resp.json();
      if (j.error) throw new Error(j.error);
      json = j;
    }
    setProgress("✅ 完成！", 100);
    renderResult(json);
  } catch (err) {
    console.error(err);
    setProgress("处理失败：" + err.message, null);
  } finally {
    btn.disabled = false;
    refreshQuota(); // 处理完立即刷新额度显示（扣减在服务端已生效）
  }
}

$("processBtn").addEventListener("click", () => onProcess($("processBtn")));
$("processAudioBtn").addEventListener("click", () => onProcess($("processAudioBtn")));
$("processTextBtn").addEventListener("click", () => onProcess($("processTextBtn")));

function makeCard(title, text) {
  const card = document.createElement("div");
  card.className = "card";
  const head = document.createElement("div");
  head.className = "card-head";
  const h3 = document.createElement("h3");
  h3.textContent = title;
  const btn = document.createElement("button");
  btn.className = "copy-btn";
  btn.textContent = "复制";
  btn.addEventListener("click", () => {
    navigator.clipboard.writeText(text).then(() => {
      const old = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(() => (btn.textContent = old), 1200);
    });
  });
  head.appendChild(h3);
  head.appendChild(btn);
  const pre = document.createElement("pre");
  pre.className = "content";
  pre.textContent = text;
  card.appendChild(head);
  card.appendChild(pre);
  return card;
}

function renderResult(json) {
  $("subtitleText").textContent = json.subtitle || "";
  $("srtText").textContent = json.srt || "(本次识别未产生时间轴信息，SRT 为空)";
  const c = json.content || {};
  $("xhsText").textContent = c.xiaohongshu || "（未生成：处理前勾选平台）";
  $("gzhText").textContent = c.gongzhonghao || "（未生成：处理前勾选平台）";
  $("dyText").textContent = c.douyin || "（未生成：处理前勾选平台）";
  // 渲染翻译结果（如有）
  window.__lastTranslations = json.translations || {};
  const ta = $("translationsArea");
  ta.innerHTML = "";
  const LANG_NAMES_FE = { zh: "中文", en: "英语", ja: "日语", ko: "韩语", fr: "法语", es: "西班牙语", de: "德语", ru: "俄语", pt: "葡萄牙语", it: "意大利语" };
  const PLAT_NAMES = { xiaohongshu: "小红书文案", gongzhonghao: "公众号文章", douyin: "抖音口播脚本" };
  for (const [lang, data] of Object.entries(window.__lastTranslations)) {
    const ln = LANG_NAMES_FE[lang] || lang;
    if (data && data.subtitle) {
      ta.appendChild(makeCard(`🌐 ${ln}字幕译文`, data.subtitle));
    }
    for (const pk of ["xiaohongshu", "gongzhonghao", "douyin"]) {
      if (data && data[pk]) {
        ta.appendChild(makeCard(`🌐 ${ln}${PLAT_NAMES[pk]}`, data[pk]));
      }
    }
  }
  // 双语字幕 SRT（如有）：视频/带时间轴字幕翻译
  window.__lastSrtBilingual = json.srt_bilingual || {};
  for (const [lang, srt] of Object.entries(window.__lastSrtBilingual)) {
    if (srt) {
      ta.appendChild(makeCard(`🌐 ${LANG_NAMES_FE[lang] || lang}双语字幕(SRT)`, srt));
    }
  }
  $("resultArea").style.display = "block";
  $("resultArea").scrollIntoView({ behavior: "smooth" });
}

// 复制按钮
document.querySelectorAll(".copy-btn").forEach((b) => {
  b.addEventListener("click", () => {
    const text = $(b.dataset.target).textContent;
    navigator.clipboard.writeText(text).then(() => {
      const old = b.textContent;
      b.textContent = "已复制";
      setTimeout(() => (b.textContent = old), 1200);
    });
  });
});

// 下载 SRT 字幕文件
$("downloadSrtBtn").addEventListener("click", () => {
  const srt = $("srtText").textContent;
  if (!srt || srt.startsWith("(本次识别")) { alert("暂无可下载的 SRT 字幕"); return; }
  const blob = new Blob([srt], { type: "application/x-subrip;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "字幕.srt";
  a.click();
  URL.revokeObjectURL(a.href);
});

// 下载全部
$("downloadAllBtn").addEventListener("click", () => {
  const c = {
    "字幕": $("subtitleText").textContent,
    "小红书文案": $("xhsText").textContent,
    "公众号文章": $("gzhText").textContent,
    "抖音口播脚本": $("dyText").textContent,
  };
  let out = "";
  for (const [k, v] of Object.entries(c)) {
    out += "========== " + k + " ==========\n\n" + v + "\n\n";
  }
  // 翻译内容（如有）
  const tr = (window.__lastTranslations || {});
  const LANG_NAMES_FE = { zh: "中文", en: "英语", ja: "日语", ko: "韩语", fr: "法语", es: "西班牙语", de: "德语", ru: "俄语", pt: "葡萄牙语", it: "意大利语" };
  const PLAT_NAMES = { subtitle: "字幕", xiaohongshu: "小红书文案", gongzhonghao: "公众号文章", douyin: "抖音口播脚本" };
  for (const [lang, data] of Object.entries(tr)) {
    const ln = LANG_NAMES_FE[lang] || lang;
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === "string" && v) {
        out += "========== " + ln + (PLAT_NAMES[k] || k) + " ==========\n\n" + v + "\n\n";
      }
    }
  }
  // 双语字幕 SRT（如有）
  for (const [lang, srt] of Object.entries(window.__lastSrtBilingual || {})) {
    if (srt) {
      out += "========== " + (LANG_NAMES_FE[lang] || lang) + "双语字幕(SRT) ==========\n\n" + srt + "\n\n";
    }
  }
  const blob = new Blob([out], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "字幕与多平台文案.txt";
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- 登录 / 额度 ----------
function showLogin() {
  $("authCard").style.display = "block";
  $("quotaBar").style.display = "none";
}
function showQuota(j) {
  $("authCard").style.display = "none";
  $("quotaBar").style.display = "flex";
  $("quotaUser").textContent = j.username;
  $("quotaRemain").textContent = Math.max(0, j.quota_minutes - j.used_minutes).toFixed(2);
  $("quotaTotal").textContent = j.quota_minutes;
  // admin 账号显示管理入口
  $("adminBtn").style.display = j.username === "admin" ? "inline-block" : "none";
  if (j.username !== "admin") $("adminPanel").style.display = "none";
}
async function refreshQuota() {
  if (!getToken()) { showLogin(); return; }
  try {
    const r = await fetch(API_BASE + "/api/me", { headers: authHeaders() });
    if (r.status === 401) { localStorage.removeItem(TOKEN_KEY); showLogin(); return; }
    const j = await r.json();
    if (j.error) { showLogin(); return; }
    showQuota(j);
  } catch (e) { /* 网络异常忽略，保持当前态 */ }
}
$("loginBtn").addEventListener("click", async () => {
  const u = $("loginUser").value.trim();
  const p = $("loginPass").value;
  if (!u || !p) { $("authMsg").textContent = "请输入用户名和密码"; return; }
  try {
    const r = await fetch(API_BASE + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p }),
    });
    const j = await r.json();
    if (j.error) { $("authMsg").textContent = j.error; return; }
    localStorage.setItem(TOKEN_KEY, j.token);
    showQuota(j);
  } catch (e) { $("authMsg").textContent = "登录请求失败"; }
});
$("logoutBtn").addEventListener("click", () => {
  localStorage.removeItem(TOKEN_KEY);
  showLogin();
});

// ---------- 管理员面板 ----------
async function apiAdmin(path, body) {
  const resp = await fetch(API_BASE + path, {
    method: body ? "POST" : "GET",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: body ? JSON.stringify(body) : undefined,
  });
  return resp.json();
}

async function loadAdmUsers() {
  try {
    const j = await apiAdmin("/api/admin/list-users");
    if (j.error) { $("admMsg").textContent = j.error; return; }
    const tbody = $("admTbody");
    tbody.innerHTML = "";
    (j.users || []).forEach((u) => {
      const tr = document.createElement("tr");
      const delBtn = u.username === "admin"
        ? ""
        : `<button class="copy-btn" data-op="del" data-user="${u.username}">删除</button>`;
      tr.innerHTML = `
        <td>${u.username}</td>
        <td>${u.used_minutes} / ${u.quota_minutes}</td>
        <td>${u.max_single_min}</td>
        <td>${u.created_at || "-"}</td>
        <td>
          <button class="copy-btn" data-op="quota" data-user="${u.username}">+10分钟</button>
          ${delBtn}
        </td>`;
      tbody.appendChild(tr);
    });
    tbody.querySelectorAll("button").forEach((b) => b.addEventListener("click", async () => {
      const user = b.dataset.user;
      if (b.dataset.op === "del") {
        if (!confirm("确认删除用户 " + user + "？此操作不可恢复。")) return;
        const r = await apiAdmin("/api/admin/delete-user", { username: user });
        $("admMsg").textContent = r.ok ? "已删除用户 " + user : (r.error || "删除失败");
      } else if (b.dataset.op === "quota") {
        const r = await apiAdmin("/api/admin/add-quota", { username: user, add_minutes: 10 });
        $("admMsg").textContent = r.ok
          ? user + " 配额 +10 分钟（现 " + r.quota_minutes + "）"
          : (r.error || "加配额失败");
      }
      loadAdmUsers();
    }));
  } catch (e) {
    $("admMsg").textContent = "加载用户列表失败：" + e.message;
  }
}

$("adminBtn").addEventListener("click", () => {
  const p = $("adminPanel");
  const show = p.style.display === "none";
  p.style.display = show ? "block" : "none";
  if (show) loadAdmUsers();
});

$("admCreateBtn").addEventListener("click", async () => {
  const username = $("admNewUser").value.trim();
  const password = $("admNewPass").value;
  const quota = parseFloat($("admNewQuota").value) || 180;
  const maxSingle = parseFloat($("admNewMax").value) || 0;
  if (!username || !password) { $("admMsg").textContent = "用户名和密码必填"; return; }
  // max_single_min 传 0 = 后端默认与总配额一致
  const r = await apiAdmin("/api/admin/create-user", {
    username, password, quota_minutes: quota, max_single_min: maxSingle,
  });
  $("admMsg").textContent = r.ok ? "已创建用户 " + username : (r.error || "创建失败");
  if (r.ok) {
    $("admNewUser").value = ""; $("admNewPass").value = "";
    $("admNewQuota").value = ""; $("admNewMax").value = "";
  }
  loadAdmUsers();
});
refreshQuota();
