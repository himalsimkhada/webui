/* keep in sync with style.css vars / selectors */
const $ = (id) => document.getElementById(id);

let currentTheme = localStorage.getItem("bind9-theme") || "dark";
function applyTheme() {
  document.documentElement.setAttribute("data-theme", currentTheme);
  const btn = $("theme-btn");
  if (btn) btn.textContent = currentTheme === "dark" ? "\u263E" : "\u263C";
}
function toggleTheme() {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  localStorage.setItem("bind9-theme", currentTheme);
  applyTheme();
}

function toast(msg, ok = true) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("status-error", !ok);
  t.classList.remove("hidden");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add("hidden"), 3200);
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    credentials: "same-origin",
    ...opts,
  });
  if (r.status === 401) { showLogin(); throw new Error("Unauthorized"); }
  if (r.status === 429) { const d = await r.json().catch(() => ({})); throw new Error(d.error || "Locked"); }
  if (opts.raw) return r;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ("HTTP " + r.status));
  return data;
}

// ── session handling ──────────────────────────────────────────────────────
let AUTHD = null;

function showLogin() {
  $("view-login").classList.remove("hidden");
  $("app-main").classList.add("hidden");
  $("logout-btn").classList.add("hidden");
}
function showApp() {
  $("view-login").classList.add("hidden");
  $("app-main").classList.remove("hidden");
  $("logout-btn").classList.remove("hidden");
}

async function init() {
  applyTheme();
  try {
    const r = await api("/api/session");
    AUTHD = r.data;
    if (!AUTHD.auth) { showLogin(); return; }
    showApp();
    switchView("dashboard");
  } catch (e) { showLogin(); }
}
async function login() {
  try {
    await api("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: $("login-password").value, remember: $("login-remember").checked }),
    });
    $("login-error").classList.add("hidden");
    showApp();
    switchView("dashboard");
  } catch (e) {
    $("login-error").textContent = e.message;
    $("login-error").classList.remove("hidden");
  }
}
async function logout() {
  try { await api("/api/logout", { method: "POST", body: "{}" }); } catch (e) {}
  showLogin();
}

// ── service registry state ─────────────────────────────────────────────────
let SERVICES = [];
let SVC = { nginx: "", bind: "" };
let EDIT = { kind: "file", name: "" };   // config editor target

function servicesOf(type) {
  return SERVICES.filter((s) => s.type === type && s.enabled);
}
function currentModule(type) {
  return SVC[type] || (servicesOf(type)[0] && servicesOf(type)[0].name) || "";
}
function NX(sub) { return "/api/module/" + currentModule("nginx") + "/proxy/" + sub; }
function BD(sub) { return "/api/module/" + currentModule("bind") + "/proxy/" + sub; }

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── views ─────────────────────────────────────────────────────────────────
function switchView(view) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $("view-" + view).classList.add("active");
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (view === "dashboard") loadDashboard();
  if (view === "services") { loadServices(); }
  if (view === "nginx") enterNginx();
  if (view === "bind") enterBind();
}

function populateInstances() {
  const fill = (sel, type) => {
    const names = servicesOf(type).map((s) => s.name);
    if (!names.includes(SVC[type]) && names.length) SVC[type] = names[0];
    $(sel).innerHTML = names.length
      ? names.map((n) => `<option value="${esc(n)}" ${n === SVC[type] ? "selected" : ""}>${esc(n)}</option>`).join("")
      : `<option value="">none</option>`;
  };
  fill("nginx-instance", "nginx");
  fill("bind-instance", "bind");
}

function switchNginxInstance() { SVC.nginx = $("nginx-instance").value; loadNginx(); }
function switchBindInstance() { SVC.bind = $("bind-instance").value; loadBind(); }

async function enterNginx() {
  await loadServicesSilently();
  populateInstances();
  await loadNginxFiles();
  loadNginx();
}
async function enterBind() {
  await loadServicesSilently();
  populateInstances();
  loadBind();
}

function openModule(name, type) {
  if (type === "nginx") { SVC.nginx = name; populateInstances(); switchView("nginx"); }
  else if (type === "bind") { SVC.bind = name; populateInstances(); switchView("bind"); }
  else viewModule(name);
}

// ── formatting ─────────────────────────────────────────────────────────────
function fmtBytes(n) {
  if (n == null || isNaN(n)) return "--";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i > 1 ? 1 : 0) + " " + u[i];
}
function fmtDur(sec) {
  if (sec == null || isNaN(sec)) return "--";
  if (sec < 60) return sec.toFixed(0) + "s";
  if (sec < 3600) return Math.floor(sec / 60) + "m " + Math.floor(sec % 60) + "s";
  if (sec < 86400) return Math.floor(sec / 3600) + "h " + Math.floor((sec % 3600) / 60) + "m";
  return Math.floor(sec / 86400) + "d " + Math.floor((sec % 86400) / 3600) + "h";
}
function statBox(label, value, cls) {
  return `<div class="stat-box"><div class="label">${label}</div><div class="value ${cls || ""}">${value}</div></div>`;
}

// ── Dashboard ─────────────────────────────────────────────────────────────
async function loadDashboard() {
  try {
    const [modules, sys, portal] = await Promise.all([
      api("/api/modules"),
      api("/api/system"),
      api("/api/metrics/portal"),
    ]);
    SERVICES = modules.data || [];
    renderModules(SERVICES);
    renderSystem(sys.data);
    renderPortal(portal.data);
  } catch (e) {
    $("modules-error").textContent = "Dashboard load failed: " + e.message;
    $("modules-error").classList.remove("hidden");
  }
}

function renderModules(mods) {
  const grid = $("modules-grid");
  grid.innerHTML = "";
  if (!mods.length) {
    grid.innerHTML = `<p class="small-text">No services registered. Add one on the <a href="#" onclick="switchView('services')">Services</a> page.</p>`;
    return;
  }
  for (const m of mods) {
    const online = m.online;
    const cls = online ? "green" : "red";
    const ready = m.ready ? "ready" : "not-ready";
    const typeBadge = m.type && m.type !== "other"
      ? `<span class="badge type-badge">${esc(m.type)}</span>` : "";
    grid.insertAdjacentHTML("beforeend", `
      <div class="module-tile card">
        <div class="module-head">
          <div>
            <h4>${esc(m.name)} ${typeBadge}${m.enabled ? "" : `<span class="badge">disabled</span>`}</h4>
            <span class="small-text">${esc(m.url)}</span>
          </div>
          <span class="badge ${cls}" title="${online ? "online" : (m.error || "offline")}">
            ${online ? "online" : "offline"}
          </span>
        </div>
        <div class="module-meta small-text">
          <span>ready: <b class="${ready === "ready" ? "green" : "red"}">${ready}</b></span>
        </div>
        <div class="module-actions btn-row">
          ${(m.type === "nginx" || m.type === "bind") && m.enabled
            ? `<button class="secondary" onclick="openModule('${esc(m.name)}', '${esc(m.type)}')">Manage</button>` : ""}
          <button class="secondary" onclick="viewModule('${esc(m.name)}')">Metrics</button>
        </div>
      </div>`);
  }
}

async function viewModule(name) {
  try {
    const r = await api("/api/module/" + name + "/metrics/parsed");
    const g = r.data || {};
    const rows = [
      ["Memory (RSS)", fmtBytes(g.process_resident_memory_bytes)],
      ["Virtual memory", fmtBytes(g.process_virtual_memory_bytes)],
      ["CPU time", g.process_cpu_seconds_total != null ? (+g.process_cpu_seconds_total).toFixed(1) + "s" : "--"],
      ["Uptime", fmtDur(g.process_uptime_seconds)],
      ["I/O read", fmtBytes(g.process_io_read_bytes)],
      ["I/O write", fmtBytes(g.process_io_write_bytes)],
      ["Open fds", g.process_open_fds],
      ["Threads", g.process_threads],
      ["Requests", g.http_requests_total],
    ];
    $("modules-error").classList.add("hidden");
    toast(rows.map(([k, v]) => `${k}: ${v}`).join(" · "));
  } catch (e) {
    toast(e.message, false);
  }
}

function renderSystem(s) {
  const grid = $("sys-grid");
  const memPct = s.memory_total ? Math.round((s.memory_used / s.memory_total) * 100) : 0;
  const swapPct = s.swap_total ? Math.round((s.swap_used / s.swap_total) * 100) : 0;
  const diskPct = s.disk && s.disk.total ? Math.round((s.disk.used / s.disk.total) * 100) : 0;
  grid.innerHTML = [
    statBox("Host", s.host),
    statBox("Platform", s.platform || "--"),
    statBox("Uptime", fmtDur(s.uptime_seconds)),
    statBox("CPU cores", s.cpu_cores),
    statBox("Load (1m)", s.load_1m != null ? s.load_1m.toFixed(2) : "--"),
    statBox("Memory", fmtBytes(s.memory_used) + ` / ${fmtBytes(s.memory_total)} <small>${memPct}%</small>`),
    statBox("Swap", fmtBytes(s.swap_used) + ` / ${fmtBytes(s.swap_total)} <small>${swapPct}%</small>`),
    statBox("Disk /", fmtBytes(s.disk ? s.disk.used : 0) + ` / ${fmtBytes(s.disk ? s.disk.total : 0)} <small>${diskPct}%</small>`),
    statBox("Python", s.python),
  ].join("");
}

function renderPortal(p) {
  const rows = [
    ["Memory (RSS)", fmtBytes(p.process_resident_memory_bytes)],
    ["CPU time", p.process_cpu_seconds_total != null ? (+p.process_cpu_seconds_total).toFixed(1) + "s" : "--"],
    ["Uptime", fmtDur(p.process_uptime_seconds)],
    ["I/O read", fmtBytes(p.process_io_read_bytes)],
    ["I/O write", fmtBytes(p.process_io_write_bytes)],
    ["Requests", p.http_requests_total],
    ["Open fds", p.process_open_fds],
  ];
  $("portal-metrics").innerHTML = rows.map(([k, v]) =>
    `<div class="portal-row"><span>${k}</span><b>${v}</b></div>`).join("");
}

// ── Services registry ──────────────────────────────────────────────────────
async function loadServicesSilently() {
  try { SERVICES = (await api("/api/services")).data || []; } catch (e) {}
}

async function loadServices() {
  try {
    SERVICES = (await api("/api/services")).data || [];
    const body = $("services-body");
    body.innerHTML = SERVICES.map((s) => {
      const cls = s.enabled ? (s.online ? "green" : "red") : "";
      const status = s.enabled ? (s.online ? "online" : "offline") : "disabled";
      const manage = (s.type === "nginx" || s.type === "bind") && s.enabled;
      return `
      <tr>
        <td><b>${esc(s.name)}</b></td>
        <td><span class="badge type-badge">${esc(s.type)}</span></td>
        <td class="small-text">${esc(s.url)}</td>
        <td><span class="badge ${cls}" title="${esc(s.error || "")}">${status}</span></td>
        <td class="btn-row" style="margin:0">
          ${manage ? `<button class="secondary" onclick="openModule('${esc(s.name)}','${esc(s.type)}')">Manage</button>` : ""}
          <button class="secondary" onclick="viewModule('${esc(s.name)}')">Metrics</button>
          <button class="secondary" onclick="testService('${esc(s.name)}')">Test</button>
          <button class="secondary" onclick="toggleService('${esc(s.name)}')">${s.enabled ? "Disable" : "Enable"}</button>
          <button class="danger" onclick="deleteService('${esc(s.name)}')">Delete</button>
        </td>
      </tr>`;
    }).join("") || `<tr><td colspan="5" class="small-text">No services registered.</td></tr>`;
    $("services-note").textContent = SERVICES.filter((s) => s.enabled).length + " enabled · " +
      SERVICES.filter((s) => s.enabled && s.online).length + " online";
  } catch (e) {
    $("services-note").textContent = "Failed to load services: " + e.message;
  }
}

async function addService() {
  const name = $("svc-name").value.trim();
  const type = $("svc-type").value;
  let url = $("svc-url").value.trim();
  const port = $("svc-port").value.trim();
  if (!name || !url) {
    $("svc-form-error").textContent = "Name and URL/Host are required.";
    $("svc-form-error").classList.remove("hidden");
    return;
  }
  $("svc-form-error").classList.add("hidden");
  if (/^[\w.-]+[A-Za-z]$/.test(url) && !url.includes("://") && !url.includes(":")) {
    url = ($("svc-https").checked ? "https://" : "http://") + url;
  } else if (!url.includes("://")) {
    url = ($("svc-https").checked ? "https://" : "http://") + url;
  }
  if (port && !/:(\d+)\s*$/.test(url.split("/")[2] || "")) {
    url = url + ":" + port;
  }
  try {
    await api("/api/services", {
      method: "POST",
      body: JSON.stringify({ name, type, url }),
    });
    $("svc-name").value = ""; $("svc-url").value = ""; $("svc-port").value = "";
    toast("Service added");
    loadServices();
  } catch (e) {
    $("svc-form-error").textContent = e.message;
    $("svc-form-error").classList.remove("hidden");
  }
}

async function toggleService(name) {
  const s = SERVICES.find((x) => x.name === name);
  if (!s) return;
  try {
    await api("/api/services/" + encodeURIComponent(name), {
      method: "PUT",
      body: JSON.stringify({ enabled: !s.enabled }),
    });
    toast((s.enabled ? "Disabled" : "Enabled") + " " + name);
    loadServices();
  } catch (e) { toast(e.message, false); }
}

async function deleteService(name) {
  if (!confirm(`Remove service '${name}'?`)) return;
  try {
    await api("/api/services/" + encodeURIComponent(name), { method: "DELETE", body: "{}" });
    if (SVC.nginx === name) SVC.nginx = "";
    if (SVC.bind === name) SVC.bind = "";
    toast("Service removed");
    loadServices();
  } catch (e) { toast(e.message, false); }
}

async function testService(name) {
  try {
    const d = (await api("/api/services/" + encodeURIComponent(name) + "/test", { method: "POST", body: "{}" })).data;
    toast(name + " : " + (d.online ? "online" : "offline") + (d.error ? " — " + d.error : ""));
    loadServices();
  } catch (e) { toast(e.message, false); }
}

// ── Nginx module ───────────────────────────────────────────────────────────
async function loadNginx() {
  try {
    await Promise.all([ngxStatus(), ngxSites(), loadNginxLogs()]);
  } catch (e) { toast("Nginx module: " + e.message, false); }
}

async function ngxStatus() {
  const r = await api(NX("api/status"));
  const s = r.data || {};
  $("nstat-grid").innerHTML = [
    statBox("Version", s.version || "--"),
    statBox("Running", s.running ? "running" : "stopped", s.running ? "green" : "red"),
    statBox("Workers", s.workers),
    statBox("Master pid", s.master_pid),
    statBox("Config", s.config_file || "--"),
  ].join("");
}

async function loadNginxFiles() {
  try {
    const r = await api(NX("api/config/files"));
    const files = r.data || [];
    const sel = $("nconf-files");
    sel.innerHTML = files.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join("");
    if (!files.length) {
      sel.innerHTML = `<option value="">no files</option>`;
      $("nconf-content").value = "";
      return;
    }
    loadNginxFile();
  } catch (e) {
    $("nconf-action-output").textContent = e.message;
    $("nconf-content").value = "";
  }
}

async function loadNginxFile() {
  const name = $("nconf-files").value;
  if (!name) return;
  try {
    const r = await api(NX("api/config/file/" + encodeURIComponent(name)));
    EDIT = { kind: "file", name };
    $("nconf-content").value = r.data.content || "";
    $("nconf-meta").textContent = r.data.path || name;
    $("nconf-action-output").textContent = "";
  } catch (e) {
    $("nconf-action-output").textContent = e.message;
  }
}

async function saveNginxFile() {
  const content = $("nconf-content").value;
  try {
    if (EDIT.kind === "site") {
      await api(NX("api/site/" + encodeURIComponent(EDIT.name)), {
        method: "PUT", body: JSON.stringify({ content }),
      });
    } else {
      await api(NX("api/config/file/" + encodeURIComponent(EDIT.name)), {
        method: "PUT", body: JSON.stringify({ content }),
      });
    }
    $("nconf-action-output").textContent = "Saved " + EDIT.name;
    toast("Saved " + EDIT.name);
    if (EDIT.kind === "site") ngxSites();
  } catch (e) {
    $("nconf-action-output").textContent = e.message;
    toast(e.message, false);
  }
}

async function ngxSites() {
  const r = await api(NX("api/sites"));
  const sites = r.data || [];
  $("sites-body").innerHTML = sites.length
    ? sites.map((s) => `
      <tr>
        <td>${esc(s.name)}</td>
        <td><span class="badge ${s.enabled ? "green" : ""}">${s.enabled ? "enabled" : "disabled"}</span></td>
        <td class="btn-row" style="margin:0">
          <button class="secondary" onclick="ngxToggleSite('${esc(s.name)}')">${s.enabled ? "Disable" : "Enable"}</button>
          <button class="secondary" onclick="editNginxSite('${esc(s.name)}')">Edit</button>
          <button class="danger" onclick="deleteNginxSite('${esc(s.name)}')">Delete</button>
        </td>
      </tr>`).join("")
    : `<tr><td colspan="3" class="small-text">No sites found.</td></tr>`;
}

async function ngxToggleSite(name) {
  try {
    await api(NX("api/site/" + encodeURIComponent(name) + "/toggle"), { method: "POST", body: "{}" });
    toast("Site toggled");
    ngxSites();
  } catch (e) { toast(e.message, false); }
}

async function editNginxSite(name) {
  try {
    const r = await api(NX("api/site/" + encodeURIComponent(name)));
    EDIT = { kind: "site", name };
    $("nconf-content").value = r.data.content || "";
    $("nconf-meta").textContent = "Editing site: " + r.data.path + " (Save writes it back)";
    $("nconf-action-output").textContent = "";
    toast("Editing site " + name + " — Save writes it back");
  } catch (e) { toast(e.message, false); }
}

async function deleteNginxSite(name) {
  if (!confirm(`Delete site '${name}'?`)) return;
  try {
    await api(NX("api/site/" + encodeURIComponent(name)), { method: "DELETE", body: "{}" });
    toast("Site deleted");
    ngxSites();
  } catch (e) { toast(e.message, false); }
}

async function nginxCreateSite() {
  const payload = {
    name: $("nsite-name").value.trim(),
    domain: $("nsite-domain").value.trim(),
    upstream: $("nsite-upstream").value.trim(),
    port: parseInt($("nsite-port").value || "80", 10),
    websocket: $("nsite-ws").checked,
  };
  if (!payload.domain || !payload.upstream) { toast("Domain and upstream are required", false); return; }
  try {
    await api(NX("api/site"), { method: "POST", body: JSON.stringify(payload) });
    toast("Site created");
    $("nsite-name").value = ""; $("nsite-domain").value = ""; $("nsite-upstream").value = "";
    ngxSites();
  } catch (e) { toast(e.message, false); }
}

async function nginxAction(action) {
  const out = $("nginx-action-output");
  out.textContent = "..." ;
  try {
    const r = await api(NX("api/control/" + action), { method: "POST", body: "{}" });
    const d = r.data || {};
    if (action === "check") out.textContent = d.output || d.error || "OK";
    else out.textContent = d.output || r.message || "OK";
    toast(action === "check" ? (d.valid ? "Config OK" : "Config invalid") : "Done", action === "check" ? d.valid !== false : true);
    ngxStatus();
  } catch (e) {
    out.textContent = e.message;
    toast(e.message, false);
  }
}

async function loadNginxLogs() {
  const lines = $("nlog-lines").value;
  const q = $("nlog-filter").value.trim();
  try {
    const r = await api(NX("api/logs?lines=" + lines + "&query=" + encodeURIComponent(q)));
    $("nlog-output").textContent = r.data || "No logs.";
  } catch (e) {
    $("nlog-output").textContent = e.message;
  }
}

async function downloadFromProxy(url, filename) {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const blob = await r.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function nginxBackup() {
  try {
    await downloadFromProxy(NX("api/backup"), "nginx-backup.tar.gz");
    toast("Backup downloaded");
  } catch (e) { toast(e.message, false); }
}

async function fileToBase64(f) {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function restoreFrom(fileInput, url, statusId, jsonB64) {
  const f = fileInput.files[0];
  if (!f) { toast("Choose a backup file", false); return; }
  let body, headers;
  if (jsonB64) {
    body = JSON.stringify({ data: await fileToBase64(f) });
    headers = { "Content-Type": "application/json" };
  } else {
    body = new FormData();
    body.append("file", f);
  }
  try {
    const r = await fetch(url, { method: "POST", body, headers, credentials: "same-origin" });
    const d = await r.json().catch(() => ({}));
    $(statusId).textContent = d.message || (r.ok ? "Restored" : d.error);
    toast(d.message || "Restored", r.ok);
  } catch (e) { toast(e.message, false); }
}

// ── BIND module ────────────────────────────────────────────────────────────
async function loadBind() {
  try {
    await Promise.all([bindStatus(), bindZones()]);
  } catch (e) { toast("BIND module: " + e.message, false); }
}

async function bindStatus() {
  let st = {};
  try {
    const r = await api(BD("api/status/structured"));
    st = r.data || {};
  } catch (e) { /* keep empty */ }
  $("bstat-grid").innerHTML = [
    statBox("Status", st.running ? "running" : "--", st.running ? "green" : ""),
    statBox("Version", st.version || "--"),
    statBox("Zones", st.zones || "--"),
    statBox("Workers", st.workers || "--"),
    statBox("Query log", st.query_logging || "--"),
    statBox("Host", st.host || "--"),
  ].join("");
}

async function bindZones() {
  try {
    const r = await api(BD("api/zones"));
    const z = r.data || [];
    $("bzone-body").innerHTML = z.map((x) => `
      <tr><td>${esc(x.name)}</td><td>${esc(x.source)}</td><td>${x.records || "--"}</td></tr>`).join("");
    $("bzone-note").textContent = z.length + " zone(s)";
  } catch (e) {
    $("bzone-note").textContent = "Zones unavailable: " + e.message;
  }
}

async function bindAction(action) {
  const out = $("bind-action-output");
  out.textContent = "...";
  try {
    const r = await api(BD("api/control/" + action), { method: "POST", body: "{}" });
    out.textContent = r.message || "OK";
    bindStatus();
  } catch (e) { out.textContent = e.message; toast(e.message, false); }
}

async function bindCheckConfig() {
  try {
    const r = await api(BD("api/config/check"));
    const d = r.data || {};
    $("bind-action-output").textContent = (d.valid ? "OK" : "INVALID") + "\n" + (d.error || "");
    toast(d.valid ? "Config OK" : "Config invalid", d.valid);
  } catch (e) { toast(e.message, false); }
}

async function bindBackup() {
  try {
    await downloadFromProxy(BD("api/backup"), "bind9-backup.tar.gz");
    toast("Backup downloaded");
  } catch (e) { toast(e.message, false); }
}

// ── wire up file inputs ──────────────────────────────────────────────────
$("nrestore-file").addEventListener("change", () => restoreFrom($("nrestore-file"), NX("api/restore"), "nbackup-status", true));
$("brestore-file").addEventListener("change", () => restoreFrom($("brestore-file"), BD("api/restore"), "bbackup-status", false));
$("login-remember").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
$("login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });

init();