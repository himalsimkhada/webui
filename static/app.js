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
function switchBindInstance() { SVC.bind = $("bind-instance").value; loadBind(); }

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
    $("nconf-content").value = r.data.content || "";
    $("nconf-meta").textContent = (isNginxConf(name) ? "⚠ nginx.conf — change with care. " : "")
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
  $(p + "-redirect-row").classList.toggle("hidden", !on);
}

function proxyTlsFields(p, v) {
  v = v || {};
  const on = !!(v.tls || v.cert || v.key || v.redirect);
  return `
    <label class="svc-check"><input type="checkbox" id="${p}-tls" ${on ? "checked" : ""} onchange="proxyTlsToggle('${p}')"> Enable TLS (https)</label>
    <div class="form-row ${on ? "" : "hidden"}" id="${p}-tls-sec">
      <div class="field" style="grid-column:1/-1">
        <label>Saved certificate</label>
        <select id="${p}-ssl" onchange="applySslChoice('${p}')">
          ${sslOptions(v)}
        </select>
        <span class="svc-hint">Pick a named certificate to auto-fill the paths, or type them manually below.</span>
      </div>
      <div class="field">
        <label>Certificate path</label>
        <input id="${p}-cert" placeholder="/etc/letsencrypt/live/…/fullchain.pem" value="${esc(v.cert || "")}">
      </div>
      <div class="field">
        <label>Key path</label>
        <input id="${p}-key" placeholder="/etc/letsencrypt/live/…/privkey.pem" value="${esc(v.key || "")}">
      </div>
    </div>
    <label class="svc-check ${on ? "" : "hidden"}" id="${p}-redirect-row">
      <input type="checkbox" id="${p}-redirect" ${v.redirect ? "checked" : ""}> Redirect HTTP → HTTPS (port 80)
    </label>
    <div class="form-row">
      <div class="field">
        <label>Max upload size</label>
        <input id="${p}-body" placeholder="e.g. 10m" value="${esc(v.body || "")}">
        <span class="svc-hint">client_max_body_size — leave empty for nginx default.</span>
      </div>
      <div class="field">
        <label>Upstream timeout</label>
        <input id="${p}-timeout" placeholder="e.g. 60s" value="${esc(v.timeout || "")}">
        <span class="svc-hint">proxy_read_timeout, default is 60s.</span>
      </div>
    </div>`;
}

function sslOptions(v) {
  v = v || {};
  const matched = SSL_CERTS.find((c) => c.cert === v.cert && c.key === v.key);
  const list = SSL_CERTS.map((c) =>
    `<option value="${esc(c.name)}" ${matched && c.name === matched.name ? "selected" : ""}>${esc(c.name)}</option>`).join("");
  return `<option value="">— type paths manually —</option>` + list;
}

function applySslChoice(p) {
  const c = SSL_CERTS.find((x) => x.name === $(p + "-ssl").value);
  if (!c) return;
  $(p + "-tls").checked = true;
  proxyTlsToggle(p);
  $(p + "-cert").value = c.cert;
  $(p + "-key").value = c.key;
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
        <td>${esc(c.name)}</td>
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
  openModal(title, `
    <div class="modal-form">
      <div class="field">
        <label>Name</label>
        <input id="ssl-name" value="${esc(v.name || "")}" ${v.name ? "disabled" : ""} placeholder="e.g. letsencrypt-main" autofocus>
        <span class="svc-hint">Shown in the site form dropdown.</span>
      </div>
      <div class="field">
        <label>Certificate path</label>
        <input id="ssl-cert" value="${esc(v.cert || "")}" placeholder="/etc/letsencrypt/live/…/fullchain.pem">
      </div>
      <div class="field">
        <label>Key path</label>
        <input id="ssl-key" value="${esc(v.key || "")}" placeholder="/etc/letsencrypt/live/…/privkey.pem">
      </div>
      <div id="ssl-form-error" class="status-error hidden"></div>
      <div class="modal-actions">
        <button class="primary" onclick="saveSsl(${v.name ? `'${esc(v.name)}'` : "null"})">${v.name ? "Save changes" : "Add certificate"}</button>
        <button class="secondary" onclick="closeModal()">Cancel</button>
      </div>
    </div>`);
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
  const cert = $("ssl-cert").value.trim();
  const key = $("ssl-key").value.trim();
  if (!name) { fail("Name is required."); return; }
  if (!cert) { fail("Certificate path is required."); return; }
  if (!key) { fail("Key path is required."); return; }
  try {
    if (editName) {
      await api(NX("api/ssl/" + encodeURIComponent(editName)), { method: "PUT", body: JSON.stringify({ cert, key }) });
      toast("Certificate updated");
    } else {
      await api(NX("api/ssl"), { method: "POST", body: JSON.stringify({ name, cert, key }) });
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
          <input id="nsite-name" placeholder="e.g. myapp" autofocus>
          <span class="svc-hint">Config file id — optional, defaults from the domain.</span>
        </div>
        <div class="field">
          <label>Listen port</label>
          <input id="nsite-port" type="number" value="80">
          <span class="svc-hint">External port of the server block.</span>
        </div>
      </div>
      <div class="field">
        <label>Domain (server_name)</label>
        <input id="nsite-domain" placeholder="e.g. app.example.com">
        <span class="svc-hint">The server_name nginx will match on.</span>
      </div>
      <div class="field">
        <label>Upstream (proxy_pass)</label>
        <input id="nsite-upstream" placeholder="e.g. http://127.0.0.1:3000">
        <span class="svc-hint">Where nginx forwards requests.</span>
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
            <span class="svc-hint">Config file id — changing it renames the site file.</span>
          </div>
          <div class="field">
            <label>Listen port</label>
            <input id="esite-port" type="number" value="${f.listen === null || f.listen === undefined ? "" : f.listen}">
            <span class="svc-hint">External port of the server block.</span>
          </div>
        </div>
        <div class="field">
          <label>Domain (server_name)</label>
          <input id="esite-domain" value="${esc(f.server_name)}">
        </div>
        <div class="field">
          <label>Upstream (proxy_pass)</label>
          <input id="esite-upstream" value="${esc(f.proxy_pass)}">
          <span class="svc-hint">Where nginx forwards requests.</span>
        </div>
        <label class="svc-check"><input type="checkbox" id="esite-ws" ${f.websocket ? "checked" : ""}> Enable websocket upgrade</label>
        ${proxyTlsFields("esite", {
          tls: f.ssl, cert: f.ssl_certificate, key: f.ssl_certificate_key,
          redirect: f.redirect_http, body: f.client_max_body_size, timeout: f.proxy_read_timeout,
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
  const port = parseInt($("esite-port").value || "80", 10);
  if (!name) { fail("Application name is required."); return; }
  if (!/^[\w.-]+$/.test(name)) { fail("Application name may only contain letters, digits, '.' , '-' or '_'."); return; }
  if (!domain) { fail("Domain is required."); return; }
  if (!upstream) { fail("Upstream URL is required."); return; }
  try {
    const res = await api(NX("api/site/" + encodeURIComponent(EDIT.name)), {
      method: "PUT",
      body: JSON.stringify({
        domain, upstream, port, websocket: $("esite-ws").checked, new_name: name,
        tls: $("esite-tls").checked,
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
  const port = parseInt($("nsite-port").value || "80", 10);
  const fail = (msg) => {
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
  };
  errEl.classList.add("hidden");
  if (!domain) { fail("Domain is required."); return; }
  if (!up) { fail("Upstream URL is required."); return; }
  if (name && !/^[\w.-]+$/.test(name)) { fail("Site name may only contain letters, digits, '.' , '-' or '_'."); return; }
  if (port < 1 || port > 65535) { fail("Listen port must be between 1 and 65535."); return; }
  if (!/^https?:\/\//.test(up)) { fail("Upstream must start with http:// or https://"); return; }
  try {
    await api(NX("api/site"), {
      method: "POST",
      body: JSON.stringify({
        name, domain, upstream: up, port, websocket: $("nsite-ws").checked,
        tls: $("nsite-tls").checked,
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