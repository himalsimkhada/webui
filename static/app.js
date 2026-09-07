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

// ── modal dialog ▸──────────────────────────────────────────────────────────
function openModal(title, html) {
  $("modal-title").textContent = title;
  $("modal-body").innerHTML = html;
  $("modal-mask").classList.add("open");
  const auto = $("modal-body").querySelector("[autofocus]");
  if (auto) auto.focus();
}
function closeModal() {
  $("modal-mask").classList.remove("open");
  $("modal-body").innerHTML = "";
}
function maskClick(e) {
  if (e.target === $("modal-mask")) closeModal();
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });

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
let EDIT_CAN_FORM = false;               // current site editable as a form
let EDIT_SITE_VIEW = "config";           // current view inside edit modal
let NCONF_UNLOCKED = new Set();          // config files explicitly unlocked for editing
let SSL_CERTS = [];                      // saved nginx cert/key pairs

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
function switchBindInstance() {
  SVC.bind = $("bind-instance").value;
  BZ.configFile = null;
  bindConfigFiles = [];
  bindSection(BZ.sub || "overview");
}

async function enterNginx() {
  await loadServicesSilently();
  populateInstances();
  await loadNginxFiles();
  await loadSslCerts();
  loadNginx();
}
async function enterBind() {
  await loadServicesSilently();
  populateInstances();
  bindSection(BZ.sub || "overview");
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
          <button class="secondary" onclick="openEditService('${esc(s.name)}')">Edit</button>
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

function pickScheme(btn, val) {
  const seg = $("svc-scheme");
  seg.dataset.val = val;
  seg.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
  svcPreview();
}

function svcPreview() {
  const el = $("svc-preview");
  if (!el) return "";
  const host = $("svc-host").value.trim();
  const port = $("svc-port").value.trim();
  const scheme = ($("svc-scheme").dataset.val || "http");
  let url = host ? scheme + "://" + host : "";
  if (host && port) url += ":" + port;
  el.textContent = url || "enter a host";
  el.classList.toggle("dim", !host);
  return url;
}

function splitUrl(url) {
  const m = /^([a-z]+):\/\/([^:/]+)(?::(\d+))?/i.exec(url || "");
  return m ? { scheme: m[1].toLowerCase(), host: m[2], port: m[3] || "" }
           : { scheme: "http", host: (url || "").split("/")[0] || "", port: "" };
}

function svcForm(svc) {
  const edit = !!svc;
  const hp = splitUrl(edit ? svc.url : "");
  return `
    <div class="modal-form">
      <div class="form-row">
        <div class="field">
          <label>Name</label>
          <input id="svc-name" value="${edit ? esc(svc.name) : ""}" ${edit ? "" : "placeholder=\"e.g. nginx-us-e\" autofocus"}>
          <span class="svc-hint">${edit ? "Renames the service." : "Unique handle shown across the portal."}</span>
        </div>
        <div class="field">
          <label>Type</label>
          <select id="svc-type">
            <option value="nginx" ${edit && svc.type === "nginx" ? "selected" : ""}>nginx</option>
            <option value="bind" ${edit && svc.type === "bind" ? "selected" : ""}>BIND</option>
            <option value="other" ${!edit || svc.type === "other" ? "selected" : ""}>other</option>
          </select>
          <span class="svc-hint">Decides which panel manages it.</span>
        </div>
      </div>
      <div class="field">
        <label>Scheme</label>
        <div class="seg" id="svc-scheme" data-val="${hp.scheme}">
          <button type="button" class="seg-btn ${hp.scheme === "http" ? "active" : ""}" onclick="pickScheme(this,'http')">http</button>
          <button type="button" class="seg-btn ${hp.scheme === "https" ? "active" : ""}" onclick="pickScheme(this,'https')">https</button>
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>Host</label>
          <input id="svc-host" value="${edit ? esc(hp.host) : ""}" placeholder="e.g. 192.168.1.10" oninput="svcPreview()">
          <span class="svc-hint">IP or DNS name of the backend.</span>
        </div>
        <div class="field">
          <label>Port</label>
          <input id="svc-port" type="number" value="${edit ? esc(hp.port) : ""}" placeholder="e.g. 8400" oninput="svcPreview()">
          <span class="svc-hint">Backend port, e.g. 8400.</span>
        </div>
      </div>
      ${edit ? `<label class="svc-check"><input type="checkbox" id="svc-enabled" ${svc.enabled ? "checked" : ""}> Enabled</label>` : ""}
      <div class="url-preview">It will connect to <code id="svc-preview"></code></div>
      <div id="svc-form-error" class="status-error hidden"></div>
      <div class="modal-actions">
        <button class="primary" onclick="${edit ? "updateService('" + svc.name + "')" : "addService()"}">${edit ? "Save changes" : "Register service"}</button>
        <button class="secondary" onclick="closeModal()">Cancel</button>
      </div>
    </div>`;
}

function openAddService() {
  openModal("Register a service", svcForm(null));
  svcPreview();
}

async function openEditService(name) {
  const svc = SERVICES.find((s) => s.name === name);
  if (!svc) { toast("Unknown service", false); return; }
  openModal("Edit service · " + name, svcForm(svc));
  svcPreview();
}

async function addService() {
  const name = $("svc-name").value.trim();
  const type = $("svc-type").value;
  const host = $("svc-host").value.trim();
  const port = $("svc-port").value.trim();
  const errEl = $("svc-form-error");
  const fail = (msg) => { errEl.textContent = msg; errEl.classList.remove("hidden"); };
  errEl.classList.add("hidden");
  if (!name || !host) { fail("Name and Host are required."); return; }
  if (!/^[\w-]+$/.test(name)) { fail("Name may only contain letters, digits, '-' or '_'."); return; }
  if (port && !/^\d{1,5}$/.test(port)) { fail("Port must be a number (1-65535)."); return; }
  const scheme = $("svc-scheme").dataset.val || "http";
  let url = scheme + "://" + host;
  if (port) url += ":" + port;
  try {
    await api("/api/services", { method: "POST", body: JSON.stringify({ name, type, url }) });
    toast("Service registered");
    closeModal();
    loadServices();
  } catch (e) { fail(e.message); }
}

async function updateService(name) {
  const newName = $("svc-name").value.trim();
  const type = $("svc-type").value;
  const host = $("svc-host").value.trim();
  const port = $("svc-port").value.trim();
  const errEl = $("svc-form-error");
  const fail = (msg) => { errEl.textContent = msg; errEl.classList.remove("hidden"); };
  errEl.classList.add("hidden");
  if (!newName || !host) { fail("Name and Host are required."); return; }
  if (!/^[\w-]+$/.test(newName)) { fail("Name may only contain letters, digits, '-' or '_'."); return; }
  if (port && !/^\d{1,5}$/.test(port)) { fail("Port must be a number (1-65535)."); return; }
  const scheme = $("svc-scheme").dataset.val || "http";
  let url = scheme + "://" + host;
  if (port) url += ":" + port;
  try {
    const res = await api("/api/services/" + encodeURIComponent(name), {
      method: "PUT",
      body: JSON.stringify({ name: newName, type, url, enabled: $("svc-enabled").checked }),
    });
    const actual = (res.data && res.data.name) || name;
    toast(actual !== name ? "Renamed to " + actual : "Service updated");
    closeModal();
    loadServices();
  } catch (e) { fail(e.message); }
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
  const src = s.status_source === "agent" ? "host agent" : s.status_source === "http" ? "http probe" : "local /proc";
  $("nstat-grid").innerHTML = [
    statBox("Version", s.version || "--"),
    statBox("Running", s.running ? "running" : "stopped", s.running ? "green" : "red"),
    statBox("Workers", s.workers),
    statBox("Master pid", s.master_pid),
    statBox("Config", s.config_file || "--"),
    statBox("Status via", src),
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
    loadNginxFile(true);
  } catch (e) {
    $("nconf-action-output").textContent = e.message;
    $("nconf-content").value = "";
  }
}

function isNginxConf(name) { return name === "nginx.conf"; }

async function loadNginxFile(readOnly) {
  const name = $("nconf-files").value;
  if (!name) return;
  try {
    const r = await api(NX("api/config/file/" + encodeURIComponent(name)));
    EDIT = { kind: "file", name };
    const ro = (readOnly === true) || (isNginxConf(name) && !NCONF_UNLOCKED.has(name));
    const envHint = name === ".env"
      ? "nginx-webui settings (NGINX_STATUS_URL / NGINX_CTL_URL …) — restart the service to apply. "
      : "";
    $("nconf-content").value = r.data.content || "";
    $("nconf-meta").textContent = (isNginxConf(name) ? "⚠ nginx.conf — change with care. " : "")
      + envHint
      + (r.data.path || name)
      + (ro ? " · read-only (click Edit to unlock)" : " · editable");
    $("nconf-content").readOnly = ro;
    $("nconf-action-output").textContent = "";
  } catch (e) {
    $("nconf-action-output").textContent = e.message;
  }
}

// re-edit a file explicitly (unlocks nginx.conf)
async function editNginxFile() {
  const name = $("nconf-files").value;
  if (isNginxConf(name)) NCONF_UNLOCKED.add(name);
  $("nconf-content").readOnly = false;
  await loadNginxFile(false);
  toast("Editing " + name);
}

async function saveNginxFile() {
  const content = $("nconf-content").value;
  if (EDIT.kind === "file" && isNginxConf(EDIT.name) && !NCONF_UNLOCKED.has(EDIT.name)) {
    $("nconf-action-output").textContent = "nginx.conf is read-only — click Edit to unlock it.";
    toast("nginx.conf is read-only — click Edit to unlock", false);
    return;
  }
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

async function saveAndCheck() {
  await saveNginxFile();
  const out = $("nginx-action-output");
  out.textContent = "...";
  try {
    const r = await api(NX("api/check"), { method: "POST", body: "{}" });
    const d = r.data || {};
    out.textContent = d.output || d.error || "OK";
    toast(d.valid ? "Config OK" : "Config invalid", d.valid !== false);
  } catch (e) { out.textContent = e.message; toast(e.message, false); }
  $("nginx-action-output").scrollIntoView({ block: "nearest" });
}

async function ngxSites() {
  const r = await api(NX("api/sites"));
  const sites = r.data || [];
  $("sites-body").innerHTML = sites.length
    ? sites.map((s) => `
      <tr>
        <td>${esc(s.name)}</td>
        <td class="small-text">${esc(s.path || "—")}</td>
        <td><span class="badge ${s.enabled ? "green" : ""}">${s.enabled ? "enabled" : "disabled"}</span></td>
        <td class="btn-row" style="margin:0">
          <button class="secondary" onclick="ngxToggleSite('${esc(s.name)}')">${s.enabled ? "Disable" : "Enable"}</button>
          <button class="primary" onclick="openEditSite('${esc(s.name)}')">Edit</button>
          <button class="danger" onclick="deleteNginxSite('${esc(s.name)}')">Delete</button>
        </td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="small-text">No sites found. Use “New reverse-proxy site” to add one.</td></tr>`;
}

async function ngxToggleSite(name) {
  try {
    await api(NX("api/site/" + encodeURIComponent(name) + "/toggle"), { method: "POST", body: "{}" });
    toast("Site toggled");
    ngxSites();
  } catch (e) { toast(e.message, false); }
}

// ── reverse-proxy create ─────────────────────────────────────────────────────
function proxyTlsToggle(p) {
  const on = $(p + "-tls").checked;
  $(p + "-tls-sec").classList.toggle("hidden", !on);
  if (on) {
    const sslEl = $(p + "-ssl");
    const fields = $(p + "-ssl-fields");
    if (sslEl && sslEl.value === "none") sslEl.value = "manual";
    if (fields) fields.classList.toggle("hidden", !(sslEl && sslEl.value === "manual"));
    const httpsEl = $(p + "-https-port");
    if (httpsEl) {
      const cur = httpsEl.value.trim();
      const n = parseInt(cur, 10);
      if (!cur || isNaN(n) || n <= 0) httpsEl.value = 443;
    }
  }
}

function sslDefault(v, tlsOn) {
  v = v || {};
  const matched = SSL_CERTS.find((c) => c.cert === v.cert && c.key === v.key);
  if (matched) return matched.name;
  if (v.cert || v.key) return "manual";
  return tlsOn ? "manual" : "none";
}

function sslOptions(v, tlsOn) {
  const cur = sslDefault(v, tlsOn);
  const sel = (val) => val === cur ? " selected" : "";
  const list = SSL_CERTS.map((c) =>
    `<option value="${esc(c.name)}"${sel(c.name)}>${esc(c.name)}</option>`).join("");
  return `<option value="none"${sel("none")}>None</option>` +
         `<option value="manual"${sel("manual")}>Manual</option>` + list;
}

function applySslChoice(p) {
  const sel = $(p + "-ssl").value;
  const fields = $(p + "-ssl-fields");
  const info = $(p + "-ssl-info");
  const setInfo = (show, text) => {
    if (!info) return;
    if (show && text) { info.innerHTML = text; info.classList.remove("hidden"); }
    else info.classList.add("hidden");
  };
  if (sel === "none") {
    $(p + "-tls").checked = false;
    $(p + "-cert").value = "";
    $(p + "-key").value = "";
    proxyTlsToggle(p);
    return;
  }
  $(p + "-tls").checked = true;
  proxyTlsToggle(p);
  if (sel === "manual") {
    $(p + "-cert").value = "";
    $(p + "-key").value = "";
    if (fields) fields.classList.remove("hidden");
    setInfo(false);
    $(p + "-cert").focus();
    return;
  }
  const c = SSL_CERTS.find((x) => x.name === sel);
  if (fields) fields.classList.add("hidden");
  if (c) {
    $(p + "-cert").value = c.cert;
    $(p + "-key").value = c.key;
    setInfo(true, esc(c.cert) + "<br>" + esc(c.key));
  }
}

function proxyTlsFields(p, v) {
  v = v || {};
  const on = !!(v.tls || v.cert || v.key || v.redirect);
  const sval = sslDefault(v, on);
  const saved = SSL_CERTS.find((c) => c.name === sval);
  const infoHtml = saved ? esc(saved.cert) + "<br>" + esc(saved.key) : "";
  return `
    <label class="svc-check"><input type="checkbox" id="${p}-tls" ${on ? "checked" : ""} onchange="proxyTlsToggle('${p}')"> Enable TLS (https)</label>
    <div class="form-row ${on ? "" : "hidden"}" id="${p}-tls-sec">
      <div class="form-row" style="grid-column:1/-1;grid-template-columns:1fr 140px">
        <div class="field">
          <label>Certificate</label>
          <select id="${p}-ssl" onchange="applySslChoice('${p}')">
            ${sslOptions(v, on)}
          </select>
        </div>
        <div class="field">
          <label>HTTPS port</label>
          <input id="${p}-https-port" type="number" value="${esc(v.https_port || "443")}">
        </div>
      </div>
      <div class="form-row ${sval === "manual" ? "" : "hidden"}" id="${p}-ssl-fields" style="grid-column:1/-1">
        <div class="field">
          <label>Certificate path</label>
          <input id="${p}-cert" placeholder="/etc/letsencrypt/live/…/fullchain.pem" value="${esc(v.cert || "")}">
        </div>
        <div class="field">
          <label>Key path</label>
          <input id="${p}-key" placeholder="/etc/letsencrypt/live/…/privkey.pem" value="${esc(v.key || "")}">
        </div>
      </div>
      <div class="small-text ${saved ? "" : "hidden"}" id="${p}-ssl-info" style="grid-column:1/-1">${infoHtml}</div>
      <label class="svc-check" style="grid-column:1/-1">
        <input type="checkbox" id="${p}-redirect" ${v.redirect ? "checked" : ""}> Redirect HTTP → HTTPS
      </label>
    </div>
    <div class="form-row">
      <div class="field">
        <label>Max upload size</label>
        <input id="${p}-body" placeholder="10m" value="${esc(v.body || "")}">
      </div>
      <div class="field">
        <label>Upstream timeout</label>
        <input id="${p}-timeout" placeholder="60s" value="${esc(v.timeout || "")}">
      </div>
    </div>`;
}

async function loadSslCerts() {
  try {
    const r = await api(NX("api/ssl"));
    SSL_CERTS = r.data || [];
  } catch (e) { SSL_CERTS = []; }
  renderSslCerts();
}

function renderSslCerts() {
  const body = $("ssl-body");
  if (!body) return;
  body.innerHTML = SSL_CERTS.length
    ? SSL_CERTS.map((c) => `
      <tr>
        <td>${esc(c.name)} ${c.mode === "content" ? `<span class="badge" title="PEM content saved to ${esc(c.cert)}">PEM</span>` : ""}</td>
        <td class="small-text">${esc(c.cert)}</td>
        <td class="small-text">${esc(c.key)}</td>
        <td class="btn-row" style="margin:0">
          <button class="primary" onclick="openEditSsl('${esc(c.name)}')">Edit</button>
          <button class="danger" onclick="deleteSslCert('${esc(c.name)}')">Delete</button>
        </td>
      </tr>`).join("")
    : `<tr><td colspan="4" class="small-text">No saved certificates. Add one to reuse it in the site forms.</td></tr>`;
}

function sslModal(title, v) {
  v = v || {};
  const mode = v.mode === "content" ? "content" : "path";
  openModal(title, `
    <div class="modal-form">
      <div class="field">
        <label>Name</label>
        <input id="ssl-name" value="${esc(v.name || "")}" ${v.name ? "disabled" : ""} placeholder="e.g. letsencrypt-main" autofocus>
        <span class="svc-hint">Shown in the site form dropdown.</span>
      </div>
      <div>
        <div class="seg">
          <button type="button" class="seg-btn ${mode === "path" ? "active" : ""}" id="ssl-mode-path" onclick="sslMode('path')">File paths</button>
          <button type="button" class="seg-btn ${mode === "content" ? "active" : ""}" id="ssl-mode-content" onclick="sslMode('content')">Paste PEM</button>
        </div>
      </div>
      <div id="ssl-panel-path" class="modal-form ${mode === "path" ? "" : "hidden"}">
        <div class="field">
          <label>Certificate path</label>
          <input id="ssl-cert" value="${esc(v.cert || "")}" placeholder="/etc/letsencrypt/live/…/fullchain.pem">
        </div>
        <div class="field">
          <label>Key path</label>
          <input id="ssl-key" value="${esc(v.key || "")}" placeholder="/etc/letsencrypt/live/…/privkey.pem">
        </div>
      </div>
      <div id="ssl-panel-content" class="modal-form ${mode === "content" ? "" : "hidden"}">
        <div class="field">
          <label>Certificate content (PEM)</label>
          <textarea id="ssl-cert-content" class="pem-textarea" rows="6" spellcheck="false" placeholder="-----BEGIN CERTIFICATE-----…">${esc(v.cert_content || "")}</textarea>
        </div>
        <div class="field">
          <label>Key content (PEM)</label>
          <textarea id="ssl-key-content" class="pem-textarea" rows="6" spellcheck="false" placeholder="-----BEGIN PRIVATE KEY-----…">${esc(v.key_content || "")}</textarea>
        </div>
        <p class="svc-hint">Saved to ${esc("ssl/<name>/")} under the nginx config dir so both nginx and this manager can read them.</p>
      </div>
      <div id="ssl-form-error" class="status-error hidden"></div>
      <div class="modal-actions">
        <button class="primary" onclick="saveSsl(${v.name ? `'${esc(v.name)}'` : "null"})">${v.name ? "Save changes" : "Add certificate"}</button>
        <button class="secondary" onclick="closeModal()">Cancel</button>
      </div>
    </div>`);
}

function sslMode(v) {
  $("ssl-panel-path").classList.toggle("hidden", v !== "path");
  $("ssl-panel-content").classList.toggle("hidden", v !== "content");
  $("ssl-mode-path").classList.toggle("active", v === "path");
  $("ssl-mode-content").classList.toggle("active", v === "content");
}

function openAddSsl() { sslModal("Add SSL certificate", {}); }

function openEditSsl(name) {
  const c = SSL_CERTS.find((x) => x.name === name);
  if (c) sslModal("Edit SSL certificate", c);
}

async function saveSsl(editName) {
  const errEl = $("ssl-form-error");
  const fail = (m) => { errEl.textContent = m; errEl.classList.remove("hidden"); };
  errEl.classList.add("hidden");
  const name = $("ssl-name").value.trim();
  if (!name) { fail("Name is required."); return; }
  const contentMode = !$("ssl-panel-content").classList.contains("hidden");
  const body = { name };
  if (contentMode) {
    body.cert_content = $("ssl-cert-content").value;
    body.key_content = $("ssl-key-content").value;
    if (!body.cert_content.trim() || !body.key_content.trim()) { fail("Paste both the certificate and key content."); return; }
  } else {
    body.cert = $("ssl-cert").value.trim();
    body.key = $("ssl-key").value.trim();
    if (!body.cert || !body.key) { fail("Certificate and key paths are required."); return; }
  }
  try {
    if (editName) {
      await api(NX("api/ssl/" + encodeURIComponent(editName)), { method: "PUT", body: JSON.stringify(body) });
      toast("Certificate updated");
    } else {
      await api(NX("api/ssl"), { method: "POST", body: JSON.stringify(body) });
      toast("Certificate added");
    }
    closeModal();
    await loadSslCerts();
  } catch (e) { fail(e.message); }
}

async function deleteSslCert(name) {
  if (!confirm(`Delete saved certificate '${name}'?`)) return;
  try {
    await api(NX("api/ssl/" + encodeURIComponent(name)), { method: "DELETE", body: "{}" });
    toast("Certificate deleted");
    await loadSslCerts();
  } catch (e) { toast(e.message, false); }
}

function openNewSite() {
  openModal("New reverse-proxy site", `
    <div class="modal-form">
      <div class="form-row">
        <div class="field">
          <label>Application name</label>
          <input id="nsite-name" placeholder="optional — defaults from domain" autofocus>
        </div>
        <div class="field">
          <label>HTTP port</label>
          <input id="nsite-http-port" type="number" value="80">
        </div>
      </div>
      <div class="form-row">
        <div class="field">
          <label>Domain (server_name)</label>
          <input id="nsite-domain" placeholder="app.example.com">
        </div>
        <div class="field">
          <label>Upstream (proxy_pass)</label>
          <input id="nsite-upstream" placeholder="http://127.0.0.1:3000">
        </div>
      </div>
      <label class="svc-check"><input type="checkbox" id="nsite-ws"> Enable websocket upgrade</label>
      ${proxyTlsFields("nsite")}
      <div id="nsite-form-error" class="status-error hidden"></div>
      <div class="modal-actions">
        <button class="primary" onclick="nginxCreateSite()">Create site</button>
        <button class="secondary" onclick="closeModal()">Cancel</button>
      </div>
    </div>`);
}

async function openEditSite(name) {
  try {
    const r = await api(NX("api/site/" + encodeURIComponent(name)));
    const d = r.data || {};
    const f = d.fields || {};
    const canForm = !!(f.server_name && f.proxy_pass);
    EDIT = { kind: "site", name };
    EDIT_CAN_FORM = canForm;
    EDIT_SITE_VIEW = canForm ? "form" : "config";
    openModal("Edit site · " + name, `
      <div id="edit-form-sec" class="modal-form ${canForm ? "" : "hidden"}">
        ${canForm ? `
        <div class="form-row">
          <div class="field">
            <label>Application name</label>
            <input id="esite-name" value="${esc(name)}" autofocus>
          </div>
          <div class="field">
            <label>HTTP port</label>
            <input id="esite-http-port" type="number" value="${f.http_listen == null ? (f.listen == null ? 80 : f.listen) : f.http_listen}">
          </div>
        </div>
        <div class="form-row">
          <div class="field">
            <label>Domain (server_name)</label>
            <input id="esite-domain" value="${esc(f.server_name)}">
          </div>
          <div class="field">
            <label>Upstream (proxy_pass)</label>
            <input id="esite-upstream" value="${esc(f.proxy_pass)}">
          </div>
        </div>
        <label class="svc-check"><input type="checkbox" id="esite-ws" ${f.websocket ? "checked" : ""}> Enable websocket upgrade</label>
        ${proxyTlsFields("esite", {
          tls: f.ssl, cert: f.ssl_certificate, key: f.ssl_certificate_key,
          redirect: f.redirect_http, body: f.client_max_body_size, timeout: f.proxy_read_timeout,
          https_port: f.ssl ? (f.listen || "443") : "443",
        })}
        <div id="esite-form-error" class="status-error hidden"></div>
        <div class="modal-actions">
          <button class="primary" onclick="saveEditedSite()">Save changes</button>
          <button class="secondary" onclick="closeModal()">Cancel</button>
        </div>` : `
        <p class="svc-hint">This config has no simple proxy_pass to edit as a form. Use the raw config view.</p>`}
      </div>
      <div id="edit-config-sec" class="modal-form ${canForm ? "hidden" : ""}">
        <p class="svc-hint">Raw nginx config for ${esc(d.path || name)}.</p>
        <textarea id="esite-content" class="editor-textarea" rows="18" spellcheck="false">${esc(d.content || "")}</textarea>
        <div class="modal-actions">
          <button class="primary" onclick="saveSiteConfig()">Save config</button>
          <button class="secondary" onclick="closeModal()">Cancel</button>
        </div>
      </div>
      ${canForm ? `
      <div class="edit-view-seg">
        <div class="seg">
          <button type="button" class="seg-btn active" id="edit-link-form" onclick="editSiteView('form')">Form</button>
          <button type="button" class="seg-btn" id="edit-link-config" onclick="editSiteView('config')">Raw config</button>
        </div>
        <span class="small-text">Form covers the essentials — use the raw config for anything else.</span>
      </div>` : ""}`);
  } catch (e) { toast(e.message, false); }
}

function editSiteView(v) {
  if (v === "form" && !EDIT_CAN_FORM) return;
  EDIT_SITE_VIEW = v;
  $("edit-form-sec").classList.toggle("hidden", v !== "form");
  $("edit-config-sec").classList.toggle("hidden", v !== "config");
  $("edit-link-form").classList.toggle("active", v === "form");
  $("edit-link-config").classList.toggle("active", v === "config");
}

async function saveEditedSite() {
  const errEl = $("esite-form-error");
  const fail = (m) => { errEl.textContent = m; errEl.classList.remove("hidden"); };
  errEl.classList.add("hidden");
  const name = $("esite-name").value.trim();
  const domain = $("esite-domain").value.trim();
  const upstream = $("esite-upstream").value.trim();
  const tls = $("esite-tls").checked;
  const httpPort = parseInt($("esite-http-port").value || "80", 10);
  const httpsPort = parseInt($("esite-https-port").value || "443", 10);
  const port = tls ? httpsPort : httpPort;
  const badPort = (p) => isNaN(p) || p < 1 || p > 65535;
  if (!name) { fail("Application name is required."); return; }
  if (!/^[\w.-]+$/.test(name)) { fail("Application name may only contain letters, digits, '.' , '-' or '_'."); return; }
  if (!domain) { fail("Domain is required."); return; }
  if (!upstream) { fail("Upstream URL is required."); return; }
  if (badPort(httpPort) || badPort(httpsPort)) { fail("HTTP and HTTPS ports must be between 1 and 65535."); return; }
  try {
    const res = await api(NX("api/site/" + encodeURIComponent(EDIT.name)), {
      method: "PUT",
      body: JSON.stringify({
        domain, upstream, port, http_port: httpPort, websocket: $("esite-ws").checked, new_name: name,
        tls,
        cert: $("esite-cert").value.trim() || null,
        key: $("esite-key").value.trim() || null,
        redirect_http: $("esite-redirect").checked,
        client_max_body_size: $("esite-body").value.trim() || null,
        proxy_read_timeout: $("esite-timeout").value.trim() || null,
      }),
    });
    const newName = (res.data && res.data.name) || EDIT.name;
    toast(newName !== EDIT.name ? "Renamed to " + newName : "Saved " + EDIT.name);
    closeModal();
    ngxSites();
  } catch (e) { fail(e.message); }
}

async function saveSiteConfig() {
  try {
    const res = await api(NX("api/site/" + encodeURIComponent(EDIT.name)), {
      method: "PUT", body: JSON.stringify({ content: $("esite-content").value, new_name: EDIT.name }),
    });
    const newName = (res.data && res.data.name) || EDIT.name;
    toast(newName !== EDIT.name ? "Renamed to " + newName : "Saved " + EDIT.name);
    closeModal();
    ngxSites();
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
  const errEl = $("nsite-form-error");
  const name = $("nsite-name").value.trim();
  const domain = $("nsite-domain").value.trim();
  const up = $("nsite-upstream").value.trim();
  const tls = $("nsite-tls").checked;
  const httpPort = parseInt($("nsite-http-port").value || "80", 10);
  const httpsPort = parseInt($("nsite-https-port").value || "443", 10);
  const port = tls ? httpsPort : httpPort;
  const badPort = (p) => isNaN(p) || p < 1 || p > 65535;
  const fail = (msg) => {
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
  };
  errEl.classList.add("hidden");
  if (!domain) { fail("Domain is required."); return; }
  if (!up) { fail("Upstream URL is required."); return; }
  if (name && !/^[\w.-]+$/.test(name)) { fail("Site name may only contain letters, digits, '.' , '-' or '_'."); return; }
  if (badPort(httpPort) || badPort(httpsPort)) { fail("HTTP and HTTPS ports must be between 1 and 65535."); return; }
  if (!/^https?:\/\//.test(up)) { fail("Upstream must start with http:// or https://"); return; }
  try {
    await api(NX("api/site"), {
      method: "POST",
      body: JSON.stringify({
        name, domain, upstream: up, port, http_port: httpPort, websocket: $("nsite-ws").checked,
        tls,
        cert: $("nsite-cert").value.trim() || null,
        key: $("nsite-key").value.trim() || null,
        redirect_http: $("nsite-redirect").checked,
        client_max_body_size: $("nsite-body").value.trim() || null,
        proxy_read_timeout: $("nsite-timeout").value.trim() || null,
      }),
    });
    toast("Site created");
    closeModal();
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
const BZ = { zone: null, doc: null, mode: "records", configFile: null, sub: "overview" };

function bindSection(sub) {
  BZ.sub = sub;
  document.querySelectorAll(".bind-subnav-btn").forEach((b) => b.classList.toggle("active", b.dataset.bsub === sub));
  document.querySelectorAll(".bind-sub").forEach((s) => s.classList.add("hidden"));
  const el = $("bsub-" + sub);
  if (el) el.classList.remove("hidden");
  if (sub === "overview") bindStatus();
  if (sub === "zones") loadBindZones();
  if (sub === "config") initBindConfig(false);
  if (sub === "logs") loadBindLogs();
}

async function loadBind() {
  try {
    await Promise.all([bindStatus(), loadBindZones()]);
    if (BZ.sub === "config") initBindConfig(true);
    if (BZ.sub === "logs") loadBindLogs();
  } catch (e) { toast("BIND module: " + e.message, false); }
}

async function bindStatus() {
  let st = {};
  try {
    const r = await api(BD("api/status/structured"));
    st = r.data || {};
  } catch (e) { /* keep empty */ }
  $("bstat-grid").innerHTML = [
    statBox("Status", st.running ? "Running" : "--", st.running ? "green" : ""),
    statBox("Version", st.version || "--"),
    statBox("Zones", st.zones || "--"),
    statBox("Workers", st.workers || "--"),
    statBox("Boot time", st.boot_time || "--"),
    statBox("Query log", st.query_logging || "--"),
  ].join("");
  $("bind-action-output").textContent = "";
}

async function bindAction(action) {
  const out = $("bind-action-output");
  out.textContent = "...";
  try {
    const r = await api(BD("api/control/" + action), { method: "POST", body: "{}" });
    out.textContent = r.data || r.message || "OK";
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

// ── BIND zones: master/detail ─────────────────────────────────────────────
function bindZonesDetail(mode) {
  BZ.mode = mode;
  $("bsw-records").classList.toggle("active", mode === "records");
  $("bsw-mapper").classList.toggle("active", mode === "mapper");
  $("bmapper-panel").classList.toggle("hidden", mode !== "mapper");
  if (mode === "mapper") {
    $("bzone-detail").classList.add("hidden");
    $("bzone-placeholder").classList.add("hidden");
  } else {
    const has = !!(BZ.zone && BZ.doc);
    $("bzone-detail").classList.toggle("hidden", !has);
    $("bzone-placeholder").classList.toggle("hidden", has);
  }
}

async function loadBindZones() {
  try {
    const r = await api(BD("api/zones"));
    const all = r.data || [];
    const q = ($("bzone-search").value || "").trim().toLowerCase();
    const f = $("bzone-filter").value;
    const filtered = all.filter((z) => (f === "all" || z.source === f) && (!q || z.name.toLowerCase().includes(q)));
    $("bcount").textContent = "· " + filtered.length + (filtered.length === 1 ? " zone" : " zones");
    $("bzone-empty").classList.toggle("hidden", filtered.length > 0);
    const list = $("bzone-list");
    list.innerHTML = "";
    filtered.forEach((z) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "zone-item" + (z.name === BZ.zone ? " active" : "");
      const srcCls = z.source === "default" ? "default" : "local";
      item.innerHTML = `<span class="zone-item-name">${esc(z.name)}</span>
        <span class="zone-item-tags">
          <span class="zone-item-type">${esc(z.type)}</span>
          <span class="zone-item-src ${srcCls}">${esc(z.source)}</span>
        </span>`;
      item.dataset.zone = z.name;
      item.onclick = () => viewBindZone(z.name);
      list.appendChild(item);
    });
    if (BZ.zone && !all.some((z) => z.name === BZ.zone)) {
      BZ.zone = null;
      BZ.doc = null;
    }
    bindZonesDetail(BZ.mode);
  } catch (e) {
    $("bzone-empty").classList.remove("hidden");
    $("bzone-empty").textContent = "Zones unavailable: " + e.message;
  }
}

// ── BIND add-zone wizard ──────────────────────────────────────────────────
let bindWizardMode = "simple";
let _bindWzPreviewTimer = null;

function showBindAddZone() {
  bindWizardMode = "simple";
  $("bwz-status").classList.add("hidden");
  $("bind-addzone-mask").classList.remove("hidden");
  $("bwizard-simple").classList.remove("hidden");
  $("bwizard-advanced").classList.add("hidden");
  $("btab-simple").classList.add("active");
  $("btab-advanced").classList.remove("active");
  updateBindWizardPreview();
  $("bwz-name").focus();
}

function hideBindAddZone() { $("bind-addzone-mask").classList.add("hidden"); }

function bindWizardTab(mode) {
  bindWizardMode = mode;
  $("bwizard-simple").classList.toggle("hidden", mode !== "simple");
  $("bwizard-advanced").classList.toggle("hidden", mode !== "advanced");
  $("btab-simple").classList.toggle("active", mode === "simple");
  $("btab-advanced").classList.toggle("active", mode === "advanced");
  if (mode === "advanced") $("bwz-name-adv").focus();
  else updateBindWizardPreview();
}

function bindWizardZoneName() {
  return (bindWizardMode === "simple" ? $("bwz-name").value : $("bwz-name-adv").value).trim();
}

function bindWizardRecords(name) {
  const ttl = parseInt($("bwz-ttl").value, 10) || 3600;
  const ip = ($("bwz-ip").value || "").trim() || "127.0.0.1";
  const recs = [];
  if ($("bp-ns").checked) {
    recs.push({ name: "@", type: "NS", value: "ns1." + name + "." });
    recs.push({ name: "ns1", type: "A", value: ip });
  }
  if ($("bp-ns2").checked) recs.push({ name: "ns2", type: "A", value: ip });
  if ($("bp-www").checked) recs.push({ name: "www", type: "A", value: ip });
  if ($("bp-mail").checked) {
    recs.push({ name: "mail", type: "A", value: ip });
    recs.push({ name: "@", type: "MX", value: "10 mail." + name + "." });
  }
  if ($("bp-txt").checked) recs.push({ name: "@", type: "TXT", value: "v=spf1 ip4:" + ip + " -all" });
  return recs;
}

function updateBindWizardPreview() {
  const name = $("bwz-name").value.trim();
  const el = $("bwz-preview");
  if (!name) { el.textContent = "Enter a zone name to see it live."; return; }
  if (!/^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+\.?$/.test(name)) {
    el.textContent = "Zone names look like example.com (letters, numbers, hyphens, dots).";
    return;
  }
  clearTimeout(_bindWzPreviewTimer);
  _bindWzPreviewTimer = setTimeout(() => {
    api(BD("api/zone/preview"), {
      method: "POST",
      body: JSON.stringify({
        name,
        ttl: parseInt($("bwz-ttl").value, 10) || 3600,
        records: bindWizardRecords(name),
      }),
    }).then((r) => {
      el.textContent = r.data && r.data.body ? r.data.body : "Preview error: " + (r.error || "");
    }).catch((e) => { el.textContent = "Preview error: " + e.message; });
  }, 150);
}

function showBindWzError(msg) {
  const el = $("bwz-status");
  el.textContent = msg;
  el.classList.remove("hidden");
}

async function createBindZone() {
  const name = bindWizardZoneName();
  if (!name) return showBindWzError("Enter a zone name");
  $("bwz-status").classList.add("hidden");
  const payload = { name, type: bindWizardMode === "simple" ? $("bwz-type").value : "master" };
  if (bindWizardMode === "simple") {
    payload.records = bindWizardRecords(name);
    payload.ttl = parseInt($("bwz-ttl").value, 10) || 3600;
  } else {
    payload.body = $("bwz-raw").value;
    if (!payload.body.trim()) return showBindWzError("Paste a zone file first, or use the Simple tab");
  }
  try {
    await api(BD("api/zone"), { method: "POST", body: JSON.stringify(payload) });
    toast("Zone created");
    hideBindAddZone();
    loadBindZones();
    viewBindZone(name);
  } catch (e) { showBindWzError(e.message); }
}

// ── BIND zone detail ──────────────────────────────────────────────────────
async function viewBindZone(name) {
  BZ.zone = name;
  bindZonesDetail("records");
  document.querySelectorAll(".zone-item").forEach((el) => el.classList.toggle("active", el.dataset.zone === name));
  try {
    const r = await api(BD("api/zone/" + encodeURIComponent(name)));
    BZ.doc = r.data;
    $("bzone-detail").classList.remove("hidden");
    $("bzone-detail-name").textContent = name;
    $("bzone-info").innerHTML = `<span class="zone-info-path">File: <code>${esc(r.data.path)}</code></span>`;
    renderBindZoneSource(r.data.source);
    $("bzone-raw-editor").value = r.data.raw;
    $("bzone-raw-wrap").classList.add("hidden");
    $("bzone-raw-status").textContent = "";
    $("bzone-check-output").textContent = "";
    const body = $("brecords-body");
    body.innerHTML = "";
    (r.data.records || []).forEach((rec, i) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${esc(rec.name)}</td><td>${esc(rec.ttl)}</td><td>${esc(rec.type)}</td>
        <td>${esc(rec.value)}</td>
        <td><button class="danger" style="padding:2px 8px" onclick="deleteBindRecord(${i})">x</button></td>`;
      body.appendChild(tr);
    });
  } catch (e) { toast(e.message, false); }
}

function renderBindZoneSource(source) {
  const el = $("bzone-source");
  if (BZ.doc.protected) {
    el.innerHTML = `<span class="zone-source-tag default">Protected system zone in named.conf.default-zones</span>
      <span class="small-text">Cannot be moved or deleted</span>`;
  } else if (source === "default") {
    el.innerHTML = `<span class="zone-source-tag default">In named.conf.default-zones</span>
      <button class="secondary" style="margin-left:8px" onclick="moveBindZoneSource('local')">Move back to local</button>
      <span class="small-text">Zone block lives in named.conf.default-zones</span>`;
  } else {
    el.innerHTML = `<span class="zone-source-tag local">In named.conf.local</span>
      <button class="secondary" style="margin-left:8px" onclick="moveBindZoneSource('default')">Move to default-zones</button>
      <span class="small-text">Automatically adds the zone block to named.conf.default-zones</span>`;
  }
}

async function moveBindZoneSource(target) {
  if (!BZ.zone) return;
  try {
    const r = await api(BD("api/zone/" + encodeURIComponent(BZ.zone) + "/source"), {
      method: "POST", body: JSON.stringify({ target }),
    });
    toast(r.message || "Moved");
    viewBindZone(BZ.zone);
  } catch (e) { toast(e.message, false); }
}

async function addBindRecord() {
  if (!BZ.zone) return;
  const data = {
    name: $("brec-name").value.trim() || "@",
    type: $("brec-type").value,
    value: $("brec-value").value.trim(),
    ttl: parseInt($("brec-ttl").value, 10) || 3600,
  };
  if (!data.value) return toast("Value required", false);
  try {
    await api(BD("api/zone/" + encodeURIComponent(BZ.zone) + "/record"), {
      method: "POST", body: JSON.stringify(data),
    });
    toast("Record added");
    $("brec-name").value = "";
    $("brec-value").value = "";
    viewBindZone(BZ.zone);
  } catch (e) { toast(e.message, false); }
}

async function deleteBindRecord(idx) {
  if (!BZ.zone) return;
  try {
    await api(BD("api/zone/" + encodeURIComponent(BZ.zone) + "/record/" + idx), { method: "DELETE", body: "{}" });
    toast("Record removed");
    viewBindZone(BZ.zone);
  } catch (e) { toast(e.message, false); }
}

async function deleteBindZone() {
  if (!BZ.zone) return;
  if (!confirm("Delete zone " + BZ.zone + "?")) return;
  try {
    await api(BD("api/zone/" + encodeURIComponent(BZ.zone)), { method: "DELETE", body: "{}" });
    toast("Zone deleted");
    BZ.zone = null;
    BZ.doc = null;
    bindZonesDetail("records");
    loadBindZones();
  } catch (e) { toast(e.message, false); }
}

function toggleBindRaw() {
  const wrap = $("bzone-raw-wrap");
  const hidden = wrap.classList.contains("hidden");
  wrap.classList.toggle("hidden");
  if (hidden) {
    $("bzone-raw-editor").value = (BZ.doc && BZ.doc.raw) || "";
    $("bzone-raw-status").textContent = "";
  }
}

async function saveBindRawZone() {
  if (!BZ.zone) return;
  try {
    await api(BD("api/zone/" + encodeURIComponent(BZ.zone) + "/file"), {
      method: "PUT", body: JSON.stringify({ content: $("bzone-raw-editor").value }),
    });
    toast("Zone file saved");
    $("bzone-raw-status").textContent = "Saved. Reloaded BIND.";
    viewBindZone(BZ.zone);
  } catch (e) {
    toast(e.message, false);
    $("bzone-raw-status").textContent = "Error: " + e.message;
  }
}

async function revertBindRawZone() {
  if (!BZ.zone) return;
  try {
    const r = await api(BD("api/zone/" + encodeURIComponent(BZ.zone)));
    BZ.doc = r.data;
    $("bzone-raw-editor").value = r.data.raw;
    $("bzone-raw-status").textContent = "Reverted to saved version.";
  } catch (e) { toast(e.message, false); }
}

async function checkBindZone() {
  if (!BZ.zone) return;
  const el = $("bzone-check-output");
  try {
    const r = await api(BD("api/zone/" + encodeURIComponent(BZ.zone) + "/check"));
    const d = r.data || {};
    el.textContent = d.output || (d.valid ? "Zone is valid" : "Error: " + (d.error || ""));
    el.style.color = d.valid ? "var(--green)" : "var(--red)";
  } catch (e) {
    el.textContent = e.message;
    el.style.color = "var(--red)";
  }
}

// ── BIND host mapper ──────────────────────────────────────────────────────
function clearBindMapper() {
  $("bmapper-input").value = "";
  $("bmapper-output").classList.add("hidden");
  $("bmapper-output").textContent = "";
}

async function runBindMapper() {
  const text = $("bmapper-input").value;
  if (!text.trim()) return toast("Enter host lines first", false);
  const out = $("bmapper-output");
  out.classList.remove("hidden");
  out.textContent = "Mapping...";
  try {
    const r = await api(BD("api/map-hosts"), { method: "POST", body: JSON.stringify({ text }) });
    const s = r.data.summary;
    const lines = [];
    lines.push(`=== Summary: ${s.created} added, ${s.duplicates_skipped} duplicates skipped, ${s.missing_zones} missing zone(s), ${s.bad_lines} bad line(s) ===`);
    if ((s.missing_zone_names || []).length) {
      lines.push("Missing zones (create them first or skip): " + s.missing_zone_names.join(", "));
    }
    lines.push("");
    (r.data.results || []).forEach((res) => lines.push(`[${res.type}] ${res.message}`));
    out.textContent = lines.join("\n");
    toast(s.created + " records added");
    loadBindZones();
  } catch (e) {
    out.textContent = "Error: " + e.message;
  }
}

// ── BIND dig ──────────────────────────────────────────────────────────────
async function runBindDig() {
  const q = $("bdig-q").value.trim();
  if (!q) return toast("Enter a name to look up", false);
  const type = $("bdig-type").value;
  const server = $("bdig-server").value.trim();
  const el = $("bdig-output");
  el.textContent = "Querying...";
  try {
    const r = await api(BD("api/dig"), { method: "POST", body: JSON.stringify({ q, type, server }) });
    const d = r.data;
    el.textContent = `> dig @${d.server} ${d.query} ${d.type}\n\n` + d.output;
  } catch (e) { el.textContent = "Error: " + e.message; }
}

// ── BIND config editor ────────────────────────────────────────────────────
let bindConfigFiles = [];

async function initBindConfig(force) {
  if (force) { $("bconfig-tabs").innerHTML = ""; bindConfigFiles = []; }
  if (bindConfigFiles.length) return;
  try {
    const r = await api(BD("api/config/files"));
    bindConfigFiles = r.data || [];
    const tabs = $("bconfig-tabs");
    tabs.innerHTML = "";
    bindConfigFiles.forEach((f, i) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tab" + (i === 0 ? " active" : "");
      btn.textContent = f;
      btn.onclick = () => switchBindConfigTab(f, btn);
      tabs.appendChild(btn);
    });
    if (bindConfigFiles.length) {
      BZ.configFile = bindConfigFiles[0];
      await loadBindConfig(false);
    }
  } catch (e) {
    $("bconfig-output").textContent = e.message;
  }
}

function switchBindConfigTab(name, btn) {
  document.querySelectorAll("#bconfig-tabs .tab").forEach((b) => b.classList.remove("active"));
  btn.classList.add("active");
  BZ.configFile = name;
  loadBindConfig(false);
}

async function loadBindConfig() {
  if (!BZ.configFile) return;
  $("bconfig-output").textContent = "";
  try {
    const r = await api(BD("api/config/file/" + encodeURIComponent(BZ.configFile)));
    $("bconfig-editor").value = r.data && typeof r.data === "string" ? r.data
      : (r.data && r.data.content != null ? r.data.content : (r.data || ""));
  } catch (e) {
    $("bconfig-output").textContent = e.message;
  }
}

async function saveBindConfig() {
  if (!BZ.configFile) return;
  try {
    const r = await api(BD("api/config/file/" + encodeURIComponent(BZ.configFile)), {
      method: "PUT", body: JSON.stringify({ content: $("bconfig-editor").value }),
    });
    toast(r.message || "Saved");
    $("bconfig-output").textContent = (r.message || "Saved") + ". Reload to apply.";
  } catch (e) {
    toast(e.message, false);
    $("bconfig-output").textContent = e.message;
  }
}

async function checkBindConfig() {
  try {
    const r = await api(BD("api/config/check"));
    const d = r.data || {};
    const output = $("bconfig-output");
    output.textContent = d.valid ? "Config is valid" : "Error: " + (d.error || "");
    output.style.color = d.valid ? "var(--green)" : "var(--red)";
  } catch (e) { $("bconfig-output").textContent = e.message; }
}

// ── BIND logs ─────────────────────────────────────────────────────────────
async function loadBindLogs() {
  const lines = $("blog-lines").value;
  const query = $("blog-filter").value;
  const el = $("blog-output");
  el.textContent = "Loading...";
  try {
    const r = await api(BD("api/logs?lines=" + lines + "&query=" + encodeURIComponent(query)));
    const text = r.data || "No logs.";
    el.innerHTML = "";
    String(text).split("\n").forEach((line) => {
      let cls = "log-info";
      if (/error|fail|denied|fatal/i.test(line)) cls = "log-error";
      else if (/warn|warning/i.test(line)) cls = "log-warn";
      const span = document.createElement("span");
      span.className = cls;
      span.textContent = line + "\n";
      el.appendChild(span);
    });
  } catch (e) {
    el.textContent = "Error: " + e.message;
  }
}

// ── wire up file inputs ──────────────────────────────────────────────────
$("nrestore-file").addEventListener("change", () => restoreFrom($("nrestore-file"), NX("api/restore"), "nbackup-status", true));
$("brestore-file").addEventListener("change", () => restoreFrom($("brestore-file"), BD("api/restore"), "bbackup-status", false));
$("login-remember").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
$("login-password").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });

// ── BIND zone list + wizard + dig wiring ─────────────────────────────────
$("bzone-search").addEventListener("input", loadBindZones);
$("bzone-filter").addEventListener("change", loadBindZones);
["bwz-name", "bwz-ttl", "bwz-ip"].forEach((id) => $(id).addEventListener("input", updateBindWizardPreview));
["bp-ns", "bp-www", "bp-mail", "bp-txt", "bp-ns2"].forEach((id) => $(id).addEventListener("change", updateBindWizardPreview));
["bwz-name", "bwz-name-adv"].forEach((id) => $(id).addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); createBindZone(); }
}));
$("bind-addzone-mask").addEventListener("keydown", (e) => { if (e.key === "Escape") hideBindAddZone(); });
$("bdig-q").addEventListener("keydown", (e) => { if (e.key === "Enter") runBindDig(); });
$("blog-filter").addEventListener("keydown", (e) => { if (e.key === "Enter") loadBindLogs(); });
$("bmapper-file").addEventListener("change", function () {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    $("bmapper-input").value = e.target.result;
    toast("File loaded. Click Map Hosts.");
  };
  reader.readAsText(file);
  this.value = "";
});

init();