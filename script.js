// API_BASE：前端托管在 Vercel / Netlify / GitHub Pages 等第三方静态平台（免备案、免费子域名），
// 通过绝对地址调用北京后端 JSON API。后端已开 CORS *，fetch 不关心 attachment 头，跨域正常。
const API_BASE = "https://gegevidsubtitle-oohnkwnnat.cn-beijing.fcapp.run";  // 前端静态托管，固定指向北京后端

// 前端浏览器提取音频的内存安全阈值：超过 1GB 走云端直传处理
const MAX_BROWSER_SIZE = 1024 * 1024 * 1024; // 1GB

const $ = (id) => document.getElementById(id);

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
    corePath: "https://unpkg.com/@ffmpeg/ffmpeg@0.11.0/dist/ffmpeg-core.js",
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

// 浏览器内提取音频：视频 -> mp3 (16k 单声道，省体积)
async function extractAudio(file) {
  await loadFFmpeg();
  ffmpeg.FS("writeFile", "input.mp4", await fetchFile(file));
  await ffmpeg.run(
    "-i", "input.mp4",
    "-vn", "-ac", "1", "-ar", "16000",
    "-b:a", "64k",
    "output.mp3"
  );
  const data = ffmpeg.FS("readFile", "output.mp3");
  return new Blob([data.buffer], { type: "audio/mpeg" });
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

// ---- 小文件流程：浏览器提取音频后 POST ----
async function processSmall(file) {
  setProgress("① 正在浏览器内提取音频...", 5);
  const audioBlob = await extractAudio(file);
  setProgress("② 正在上传并生成文案...", 30);
  const form = new FormData();
  form.append("audio", audioBlob, "audio.mp3");
  form.append("duration_sec", String(window.__videoDuration || 0));
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
    body: JSON.stringify({ object_key, duration_sec: window.__videoDuration || 0 }),
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
    $("panel-text").style.display = currentTab === "text" ? "block" : "none";
  });
});

// ---- 主流程 ----
$("videoFile").addEventListener("change", (e) => {
  const f = e.target.files[0];
  $("fileName").textContent = f ? f.name : "选择视频文件";
  $("modeHint").textContent = "";
  window.__videoDuration = 0;
  if (f && f.type.startsWith("video/")) {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => { window.__videoDuration = v.duration || 0; };
    v.src = URL.createObjectURL(f);
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
    if (currentTab === "video") {
      const file = $("videoFile").files[0];
      if (!file) { alert("请先选择视频文件"); btn.disabled = false; return; }
      if (file.size <= MAX_BROWSER_SIZE) {
        $("modeHint").textContent = "小文件模式：浏览器本地提取音频（快、省）";
        json = await processSmall(file);
      } else {
        $("modeHint").textContent = "大文件模式：直传云端处理（>1GB 自动切换）";
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
        body: JSON.stringify({ text }),
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
  }
}

$("processBtn").addEventListener("click", () => onProcess($("processBtn")));
$("processTextBtn").addEventListener("click", () => onProcess($("processTextBtn")));

function renderResult(json) {
  $("subtitleText").textContent = json.subtitle || "";
  const c = json.content || {};
  $("xhsText").textContent = c.xiaohongshu || "";
  $("gzhText").textContent = c.gongzhonghao || "";
  $("dyText").textContent = c.douyin || "";
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
refreshQuota();
