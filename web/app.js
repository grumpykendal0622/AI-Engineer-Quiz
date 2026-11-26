/* Keepstack single-page client. Vanilla JS, no build step. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const initialFilters = { q: "", media: "", includeTags: [], excludeTags: [], sort: "newest", collection: "" };
const state = { token: localStorage.getItem("keepstack_token"), user: null, ...initialFilters };
let sessionVersion = 0;
let tagCatalog = [];
let fromCollections = false;
const pageSize = 12;
let offset = 0, matchTotal = 0, libraryVersion = 0, libraryReady = false;
let exporting = false;

// ---------- API helper ----------
async function api(path, opts = {}) {
  const headers = opts.headers || {};
  const session = sessionVersion;
  if (state.token) headers["Authorization"] = "Bearer " + state.token;
  // A JSON body needs a body-carrying method; fetch() rejects GET/HEAD with a body.
  if (opts.json) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); opts.method = opts.method || "POST"; }
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) {
    if (session === sessionVersion) {
      const expired = Boolean(state.user);
      logout();
      if (expired) {
        $("#login-error").textContent = "Session expired. Sign in again.";
        $("#login-error").classList.remove("hidden");
      }
    }
    throw new Error("unauthorised");
  }
  if (!res.ok) { const t = await res.text(); throw new Error(t || res.statusText); }
  return !opts.raw && res.headers.get("content-type")?.includes("json") ? res.json() : res;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toast(msg, kind = "ok") {
  const t = $("#toast"); t.textContent = msg; t.className = "toast " + kind;
  setTimeout(() => t.classList.add("hidden"), 2600);
}
const fmtBytes = (b) => { if (!b) return "0 B"; const u = ["B","KB","MB","GB","TB"]; const i = Math.floor(Math.log(b)/Math.log(1024)); return (b/Math.pow(1024,i)).toFixed(i?1:0)+" "+u[i]; };
const esc = (s) => (s ?? "").toString().replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));

// ---------- auth ----------
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("/api/auth/login", { json: { username: $("#login-user").value, password: $("#login-pass").value } });
    state.token = r.token; localStorage.setItem("keepstack_token", r.token);
    state.user = r.user; enterApp();
  } catch { $("#login-error").textContent = "Invalid credentials"; $("#login-error").classList.remove("hidden"); }
});
$("#btn-logout").addEventListener("click", () => { if (canLeaveAsset()) logout(); });
function logout() {
  sessionVersion++;
  localStorage.removeItem("keepstack_token");
  Object.assign(state, initialFilters, { token: null, user: null });
  clearTimeout(searchTimer);
  offset = 0;
  matchTotal = 0;
  libraryReady = false;
  exporting = false;
  syncPages();
  resetDrawer();
  $("#upload-modal").classList.add("hidden");
  $("#toast").classList.add("hidden");
  $("#search").value = "";
  $("#sort").value = "newest";
  tagCatalog = [];
  fromCollections = false;
  $("#filter-collection").replaceChildren(new Option("All collections", ""));
  $("#filter-error").classList.add("hidden");
  for (const picker of $$(".tag-filter details")) {
    picker.open = false;
    $("input", picker).value = "";
    $(".tag-options", picker).replaceChildren();
  }
  syncFilters();
  $("#empty").classList.add("hidden");
  $("#library-loading").classList.add("hidden");
  $("#library-error").classList.add("hidden");
  $("#result-title").textContent = "Library";
  for (const selector of ["#grid", "#drawer-body", "#collection-list",
    "#stat-cards", "#fixity-result", "#user-rows", "#audit-rows", "#upload-list", "#user-label"]) {
    $(selector).replaceChildren();
  }
  $("#file-input").value = "";
  $$(".admin-only").forEach(element => element.classList.add("hidden"));
  $("#app").classList.add("hidden");
  $("#login-error").classList.add("hidden");
  $("#login").classList.remove("hidden");
}

function enterApp() {
  $("#login-error").classList.add("hidden");
  $("#login").classList.add("hidden"); $("#app").classList.remove("hidden");
  $("#user-label").textContent = `${state.user.username} (${state.user.role})`;
  const isAdmin = state.user.role === "admin";
  $$(".admin-only").forEach(el => el.classList.toggle("hidden", !isAdmin));
  $("#btn-upload").classList.toggle("hidden", state.user.role === "viewer");
  showView("library");
}

// ---------- navigation ----------
$$(".nav-item").forEach(btn => btn.addEventListener("click", () => showView(btn.dataset.view)));
function showView(view) {
  $$(".nav-item").forEach(btn => btn.classList.toggle("active", btn.dataset.view === view));
  $$(".view").forEach(panel => panel.classList.toggle("hidden", panel.id !== "view-" + view));
  if (view === "library") {
    $("#back-to-collections").classList.toggle("hidden", !fromCollections);
    loadFilterOptions();
    loadLibrary();
  }
  if (view === "collections") loadCollections();
  if (view === "dashboard") loadDashboard();
  if (view === "users") loadUsers();
  if (view === "audit") loadAudit();
}

// ---------- library / search ----------
let searchTimer;
const tagPickers = { includeTags: $("#include-tags"), excludeTags: $("#exclude-tags") };
$("#search").addEventListener("input", event => {
  state.q = event.target.value;
  updateFilters(250);
});
$("#filter-collection").addEventListener("change", event => { state.collection = event.target.value; updateFilters(); });
$("#filter-media").addEventListener("change", event => { state.media = event.target.value; updateFilters(); });
$("#sort").addEventListener("change", event => { state.sort = event.target.value; updateFilters(); });
$("#filter-clear").addEventListener("click", () => {
  const { sort } = state;
  Object.assign(state, initialFilters, { sort });
  updateFilters();
});
$("#back-to-collections").addEventListener("click", () => showView("collections"));
$("#page-prev").addEventListener("click", () => movePage(-pageSize));
$("#page-next").addEventListener("click", () => movePage(pageSize));
$("#library-retry").addEventListener("click", loadLibrary);
$("#export-csv").addEventListener("click", exportLibrary);

function updateFilters(delay = 0) {
  clearTimeout(searchTimer);
  offset = 0;
  libraryVersion++;
  startLibraryLoading();
  syncFilters();
  if (delay) searchTimer = setTimeout(loadLibrary, delay);
  else loadLibrary();
}

function movePage(step) {
  const next = offset + step;
  if (!libraryReady || next < 0 || next >= matchTotal) return;
  offset = next;
  loadLibrary();
}

function syncPages() {
  $("#page-prev").disabled = !libraryReady || offset === 0;
  $("#page-next").disabled = !libraryReady || offset + pageSize >= matchTotal;
  $("#page-summary").textContent = libraryReady && matchTotal
    ? `${offset + 1}–${Math.min(offset + pageSize, matchTotal)} of ${matchTotal}` : "";
  syncExport();
}

function syncExport() {
  $("#export-csv").disabled = !libraryReady || exporting;
  $("#export-csv").textContent = exporting ? "Exporting…"
    : libraryReady ? `↓ Export all ${matchTotal} (CSV)` : "Export CSV";
}

async function exportLibrary() {
  if (!libraryReady || exporting) return;
  const session = sessionVersion;
  exporting = true;
  syncExport();
  try {
    const response = await api("/api/assets/export.csv?" + searchParams(), { raw: true });
    const blob = await response.blob();
    if (session === sessionVersion) downloadBlob(blob, "keepstack-assets.csv");
  } catch {
    if (session === sessionVersion) toast("CSV export failed. Try again.", "err");
  } finally {
    if (session === sessionVersion) {
      exporting = false;
      syncExport();
    }
  }
}

function startLibraryLoading() {
  libraryReady = false;
  $("#grid").replaceChildren();
  $("#result-title").textContent = state.q.trim() ? "Results" : "Library";
  $("#empty").classList.add("hidden");
  $("#library-error").classList.add("hidden");
  $("#library-loading").classList.remove("hidden");
  syncPages();
}

function syncFilters() {
  $("#search").value = state.q;
  $("#filter-collection").value = state.collection;
  $("#filter-media").value = state.media;
  const chips = $("#active-filters");
  chips.replaceChildren();
  const chip = (key, label, remove) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.dataset.kind = key;
    button.textContent = label + " ×";
    button.setAttribute("aria-label", "Remove " + label);
    button.addEventListener("click", () => { remove(); updateFilters(); });
    chips.append(button);
  };
  if (state.q.trim()) chip("q", "Keyword: " + state.q.trim(), () => { state.q = ""; });
  if (state.collection) {
    const label = $("#filter-collection").selectedOptions[0]?.textContent;
    if (label) chip("collection", "Collection: " + label, () => { state.collection = ""; });
  }
  if (state.media) chip("media", "Type: " + state.media, () => { state.media = ""; });
  for (const [key, picker] of Object.entries(tagPickers)) {
    const sign = key === "includeTags" ? "＋" : "−";
    $(".tag-selection-count", picker).textContent = state[key].length
      ? state[key].length + " selected · Edit" : sign + " Choose tags";
    for (const name of state[key]) {
      const prefix = key === "includeTags" ? "Include: " : "Exclude: ";
      chip(key, prefix + name, () => { state[key] = state[key].filter(tag => tag !== name); });
    }
    $$(".tag-options button", picker).forEach(button => {
      button.setAttribute("aria-pressed", String(state[key].includes(button.dataset.tag)));
    });
  }
  $("#filter-clear").classList.toggle("hidden", !chips.childElementCount);
}

function renderTagOptions(key) {
  const picker = tagPickers[key];
  const query = $("input", picker).value.trim().toLowerCase();
  const names = tagCatalog.filter(name => name.toLowerCase().includes(query));
  const list = $(".tag-options", picker);
  const limit = Number(picker.dataset.limit || 8);
  list.replaceChildren();
  for (const name of names.slice(0, limit)) {
    const button = document.createElement("button");
    button.className = "btn";
    button.type = "button";
    button.textContent = name;
    button.dataset.tag = name;
    button.setAttribute("aria-pressed", String(state[key].includes(name)));
    button.addEventListener("click", () => {
      if (state[key].includes(name)) state[key] = state[key].filter(tag => tag !== name);
      else if (state[key].length < 100) state[key] = [...state[key], name];
      else { toast("Choose at most 100 tags per group", "err"); return; }
      updateFilters();
    });
    list.append(button);
  }
  if (!names.length) list.textContent = query ? "No tag names found." : "No tags available.";
  $(".more-tags", picker).classList.toggle("hidden", names.length <= limit);
}

for (const [key, picker] of Object.entries(tagPickers)) {
  const closePicker = () => { picker.open = false; $("summary", picker).focus(); };
  $("summary", picker).addEventListener("click", () => {
    if (!picker.open) {
      Object.values(tagPickers).filter(other => other !== picker).forEach(other => { other.open = false; });
      renderTagOptions(key);
    }
  });
  $("input", picker).addEventListener("input", () => { picker.dataset.limit = "8"; renderTagOptions(key); });
  $(".more-tags", picker).addEventListener("click", () => {
    picker.dataset.limit = String(Number(picker.dataset.limit || 8) + 8);
    renderTagOptions(key);
  });
  $(".tag-done", picker).addEventListener("click", closePicker);
  picker.addEventListener("keydown", event => {
    if (event.key === "Escape") closePicker();
  });
}
document.addEventListener("click", event => {
  if (!event.target.closest(".tag-filter")) Object.values(tagPickers).forEach(picker => { picker.open = false; });
});

async function loadFilterOptions() {
  const session = sessionVersion;
  try {
    const [collections, tags] = await Promise.all([api("/api/collections"), api("/api/tags")]);
    if (session !== sessionVersion) return;
    $("#filter-collection").replaceChildren(new Option("All collections", ""),
      ...collections.collections.map(item => new Option(item.name, item.id)));
    tagCatalog = tags.tags.map(tag => tag.name);
    Object.keys(tagPickers).forEach(renderTagOptions);
    $("#filter-error").classList.add("hidden");
    syncFilters();
  } catch {
    if (session !== sessionVersion) return;
    $("#filter-error").textContent = "Could not load filter options. Reopen Library to retry.";
    $("#filter-error").classList.remove("hidden");
  }
}

function searchParams() {
  const params = new URLSearchParams({ q: state.q, sort: state.sort });
  if (state.media) params.set("media_type", state.media);
  if (state.collection) params.set("collection_id", state.collection);
  state.includeTags.forEach(name => params.append("include_tag", name));
  state.excludeTags.forEach(name => params.append("exclude_tag", name));
  return params;
}

async function loadLibrary() {
  if (!state.user || $("#view-library").classList.contains("hidden")) return;
  clearTimeout(searchTimer);
  const session = sessionVersion;
  const version = ++libraryVersion;
  const params = searchParams();
  params.set("limit", String(pageSize));
  params.set("offset", String(offset));
  startLibraryLoading();
  try {
    const data = await api("/api/assets?" + params);
    if (session !== sessionVersion || version !== libraryVersion) return;
    if (offset && offset >= data.total) {
      offset = Math.max(0, Math.floor((data.total - 1) / pageSize) * pageSize);
      loadLibrary();
      return;
    }
    matchTotal = data.total;
    libraryReady = true;
    $("#library-loading").classList.add("hidden");
    renderGrid(data.items, data.total);
    syncPages();
  } catch {
    if (session !== sessionVersion || version !== libraryVersion) return;
    $("#library-loading").classList.add("hidden");
    $("#library-error").classList.remove("hidden");
  }
}

function renderGrid(items, total) {
  $("#result-title").textContent = state.q.trim() ? `Results (${total})` : `Library (${total})`;
  const conflict = state.includeTags.find(name => state.excludeTags.includes(name));
  $("#empty").textContent = conflict ? `“${conflict}” is both included and excluded. Remove one condition.`
    : $("#active-filters").childElementCount ? "No assets match these filters. Try removing a condition." : "No assets yet. Click Upload to get started.";
  $("#empty").classList.toggle("hidden", items.length > 0);
  $("#grid").innerHTML = items.map(a => `
    <div class="card" data-uuid="${a.uuid}">
      <img class="thumb" loading="lazy" src="/api/assets/${a.uuid}/thumb" alt="${esc(a.alt_text || a.title)}">
      <div class="meta">
        <span class="title" title="${esc(a.title)}">${esc(a.title)}</span>
        <span class="sub"><span class="badge">${a.media_type}</span><span>${fmtBytes(a.size)}</span></span>
      </div>
    </div>`).join("");
  $$("#grid .card").forEach(c => c.addEventListener("click", () => openAsset(c.dataset.uuid)));
}

// ---------- asset detail drawer ----------
const drawer = $("#drawer");
let drawerVersion = 0;
let canLeaveAsset = () => true;
$("#drawer-close").addEventListener("click", closeDrawer);
$(".drawer-backdrop").addEventListener("click", closeDrawer);
function closeDrawer() {
  if (canLeaveAsset()) resetDrawer();
}

function resetDrawer() {
  drawerVersion++;
  canLeaveAsset = () => true;
  drawer.classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function dublinCoreRows(dc) {
  return Object.entries(dc || {}).filter(([, value]) => value).map(([key, value]) =>
    `<div class="field-row"><span class="k">${esc(key)}</span><span class="v">${esc(value)}</span></div>`).join("");
}

async function openAsset(uuid) {
  if (!canLeaveAsset()) return;
  canLeaveAsset = () => true;
  const version = ++drawerVersion;
  const session = sessionVersion;
  drawer.classList.remove("hidden");
  document.body.classList.add("modal-open");
  $(".drawer-panel").scrollTop = 0;
  $("#drawer-body").innerHTML = '<p class="muted">Loading...</p>';
  const [d, meta, sim] = await Promise.all([
    api("/api/assets/" + uuid),
    api("/api/assets/" + uuid + "/metadata"),
    api("/api/assets/" + uuid + "/similar"),
  ]);
  if (session !== sessionVersion || version !== drawerVersion) return;
  const a = d.asset;
  const canEdit = ["admin","editor","contributor"].includes(state.user.role);
  const preview = a.media_type === "image"
    ? `<img class="detail-preview" src="/api/assets/${uuid}/preview" alt="${esc(a.alt_text||a.title)}">`
    : `<img class="detail-preview" src="/api/assets/${uuid}/thumb" alt="${esc(a.title)}">`;
  $("#drawer-body").innerHTML = `
    ${preview}
    <h2 class="detail-title">${esc(a.title)}</h2>
    <p class="muted">${a.media_type} &middot; ${a.ext?.toUpperCase()} &middot; ${fmtBytes(a.size)} ${a.width?`&middot; ${a.width}&times;${a.height}`:""}</p>
    <div class="btn-row">
      <button class="btn" id="d-download" type="button">Download original</button>
      ${canEdit?`<button class="btn" id="d-share">Create share link</button>`:""}
      ${["admin","editor"].includes(state.user.role)?`<button class="btn btn-danger" id="d-delete">Delete</button>`:""}
    </div>

    ${canEdit ? `<form class="detail-section" id="asset-edit"><fieldset>
      <legend>Edit metadata &amp; tags</legend>
      <div class="edit-grid">
        <label>Title<input id="e-title" value="${esc(a.title)}"></label>
        <label>Description<textarea id="e-description" rows="2">${esc(a.description)}</textarea></label>
        <label>Alt text (accessibility)<input id="e-alt_text" value="${esc(a.alt_text)}"></label>
        <label>Creator<input id="e-dc_creator" value="${esc(a.dc_creator)}"></label>
        <label>Rights / license<input id="e-rights_statement" value="${esc(a.rights_statement)}"></label>
        <label>Retention until<input id="e-retention_until" type="date" value="${esc((a.retention_until||'').slice(0,10))}"></label>
      </div>
      <div class="edit-tags">
        <h4>Tags</h4>
        <div class="tag-row" id="tag-row"></div>
        <div class="btn-row">
          <input class="tag-add" id="tag-add" aria-label="New tag" placeholder="Enter a tag" autocomplete="off">
          <button class="btn" id="tag-stage" type="button">Add tag</button>
        </div>
        <p class="muted edit-tag-help">Tag changes apply when you save.</p>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="d-save" type="submit" disabled>Save changes</button>
        <span id="edit-message" role="status"></span></div>
    </fieldset></form>` : `<div class="detail-section"><h4>Tags</h4><div class="tag-row" id="tag-row"></div></div>`}

    ${sim.items.length?`<div class="detail-section"><h4>Similar assets</h4>
      <div class="similar-strip">${sim.items.slice(0,8).map(s=>`<img src="/api/assets/${s.uuid}/thumb" data-uuid="${s.uuid}" title="${esc(s.title)}">`).join("")}</div></div>`:""}

    <div class="detail-section"><h4>Dublin Core</h4>
      <div id="dublin-core-values">${dublinCoreRows(a.dublin_core)}</div>
      <div class="btn-row"><a class="btn btn-ghost" href="/oai?verb=GetRecord&metadataPrefix=oai_dc&identifier=oai::${a.uuid}" target="_blank">View OAI-PMH XML</a></div>
    </div>

    ${Object.keys(meta.exif||{}).length||Object.keys(meta.iptc||{}).length?`<div class="detail-section"><h4>Embedded metadata (EXIF / IPTC)</h4>
      <div class="kv-scroll">${[...Object.entries(meta.iptc||{}),...Object.entries(meta.exif||{})].slice(0,40).map(([k,v])=>`<div class="field-row"><span class="k">${esc(k)}</span><span class="v">${esc(typeof v==='object'?JSON.stringify(v):v)}</span></div>`).join("")}</div></div>`:""}

    ${d.versions.length?`<div class="detail-section"><h4>Versions</h4>${d.versions.map(v=>`<div class="field-row"><span class="k">v${v.version_no}</span><span class="v">${esc(v.note||'')} &middot; ${fmtBytes(v.size)} &middot; ${(v.created_at||'').slice(0,10)}</span></div>`).join("")}</div>`:""}
  `;

  // wire detail actions
  $("#d-download").addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const response = await api("/api/assets/" + uuid + "/file", { raw: true });
      const blob = await response.blob();
      if (session === sessionVersion) downloadBlob(blob, a.filename);
    } catch {
      if (session === sessionVersion) toast("Download failed", "err");
    } finally {
      button.disabled = false;
    }
  });
  $$("#drawer-body .similar-strip img").forEach(img => img.addEventListener("click", () => openAsset(img.dataset.uuid)));
  if (canEdit) {
    bindAssetEditor(uuid, d.tags);
    $("#d-share")?.addEventListener("click", async () => {
      const r = await api("/api/shares", { json: { target_type: "asset", target_id: a.id, permission: "download" } });
      await navigator.clipboard?.writeText(r.url).catch(()=>{});
      toast("Share link copied: " + r.url);
    });
  } else renderDetailTags(d.tags);
  $("#d-delete")?.addEventListener("click", async () => {
    if ($("#asset-edit fieldset")?.disabled) return;
    if (!confirm("Delete this asset?")) return;
    await api("/api/assets/"+uuid, { method: "DELETE" });
    if (session !== sessionVersion) return;
    toast("Deleted");
    if (version === drawerVersion) resetDrawer();
    loadLibrary();
  });
}

function renderDetailTags(tags, removeTag) {
  const row = $("#tag-row");
  row.replaceChildren();
  if (!tags.length) row.textContent = "No tags";
  for (const tag of tags) {
    const chip = document.createElement("span");
    chip.className = tag.source === "ai" ? "tag ai" : "tag";
    chip.textContent = tag.name;
    if (removeTag) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "rm";
      remove.dataset.tag = tag.name;
      remove.textContent = "×";
      remove.setAttribute("aria-label", "Remove tag: " + tag.name);
      remove.addEventListener("click", () => removeTag(tag.name));
      chip.append(remove);
    }
    row.append(chip);
  }
}

function bindAssetEditor(uuid, tags) {
  const form = $("#asset-edit");
  const fieldset = $("fieldset", form);
  const input = $("#tag-add");
  const save = $("#d-save");
  const add = $("#tag-stage");
  const message = $("#edit-message");
  const fields = ["title", "description", "alt_text", "dc_creator", "rights_statement", "retention_until"];
  const readFields = () => Object.fromEntries(fields.map(name => [name, $("#e-" + name, form).value]));
  const names = () => tags.map(tag => tag.name).sort();
  let savedFields = readFields(), savedNames = names(), savedTags = tags;
  const tagsChanged = () => JSON.stringify(names()) !== JSON.stringify(savedNames);
  const dirty = () => Boolean(input.value.trim()) || tagsChanged()
    || fields.some(name => $("#e-" + name, form).value !== savedFields[name]);
  canLeaveAsset = () => !fieldset.disabled && (!dirty() || confirm("Discard unsaved changes?"));
  const sync = () => { save.disabled = fieldset.disabled || !dirty(); add.disabled = !input.value.trim(); };
  const renderTags = () => renderDetailTags(tags, name => {
    tags = tags.filter(tag => tag.name !== name);
    renderTags();
    input.focus({ preventScroll: true });
    sync();
  });
  const stageTag = () => {
    const name = input.value.trim().toLowerCase();
    if (!name) return;
    if (!tags.some(tag => tag.name === name)) {
      tags = [...tags, savedTags.find(tag => tag.name === name) || { name, source: "manual" }];
      renderTags();
    }
    input.value = "";
    sync();
  };
  add.addEventListener("click", () => { stageTag(); input.focus({ preventScroll: true }); });
  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.isComposing) {
      event.preventDefault();
      stageTag();
    }
  });
  form.addEventListener("input", () => { message.textContent = ""; sync(); });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (fieldset.disabled) return;
    stageTag();
    if (!dirty()) return;
    const values = readFields();
    const body = Object.fromEntries(fields.filter(name => values[name] !== savedFields[name])
      .map(name => [name, values[name]]));
    const changedTags = tagsChanged();
    if (changedTags) body.tags = names();
    fieldset.disabled = true;
    message.textContent = "Saving…";
    message.className = "muted";
    try {
      const updated = await api("/api/assets/" + uuid, { method: "PATCH", json: body });
      if (!form.isConnected) return;
      savedFields = values;
      tags = savedTags = updated.tags;
      savedNames = names();
      message.textContent = "Saved";
      $(".detail-title").textContent = updated.asset.title;
      $(".detail-preview").alt = updated.asset.alt_text || updated.asset.title;
      $("#dublin-core-values").innerHTML = dublinCoreRows(updated.asset.dublin_core);
      renderTags();
      loadLibrary();
      if (changedTags) loadFilterOptions();
    } catch {
      message.className = "error";
      message.textContent = "Could not save. Your changes are still here.";
    } finally {
      fieldset.disabled = false;
      sync();
    }
  });
  renderTags();
  sync();
}

// ---------- upload ----------
const uploadModal = $("#upload-modal");
$("#btn-upload").addEventListener("click", () => { uploadModal.classList.remove("hidden"); document.body.classList.add("modal-open"); });
function closeUpload() {
  uploadModal.classList.add("hidden");
  document.body.classList.remove("modal-open");
}
$("#upload-cancel").addEventListener("click", closeUpload);
$(".modal-backdrop").addEventListener("click", closeUpload);
const dz = $("#dropzone"), fileInput = $("#file-input");
dz.addEventListener("click", () => fileInput.click());
dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("drag"); uploadFiles(e.dataTransfer.files); });
fileInput.addEventListener("change", () => uploadFiles(fileInput.files));

async function uploadFiles(files) {
  const session = sessionVersion;
  let added = false;
  const list = $("#upload-list");
  for (const file of files) {
    const row = document.createElement("div");
    row.className = "upload-item"; row.innerHTML = `<span>${esc(file.name)}</span><span>uploading...</span>`;
    list.prepend(row);
    const fd = new FormData(); fd.append("files", file); fd.append("run_ai", $("#ai-toggle").checked);
    try {
      const r = await api("/api/assets", { method: "POST", body: fd });
      if (session !== sessionVersion) return;
      const created = r.created[0];
      added ||= !created.duplicate;
      row.classList.add(created.duplicate ? "dup" : "ok");
      row.lastChild.textContent = created.duplicate ? "duplicate (deduped)" : "done";
    } catch (err) { row.classList.add("err"); row.lastChild.textContent = "failed"; }
  }
  if (added && session === sessionVersion) { loadLibrary(); loadFilterOptions(); }
}

// ---------- collections ----------
async function loadCollections() {
  const session = sessionVersion;
  const data = await api("/api/collections");
  if (session !== sessionVersion) return;
  $("#collection-list").innerHTML = data.collections.map(c =>
    `<button type="button" class="collection-card" data-id="${c.id}"><span class="n">${esc(c.name)}</span><span class="muted">${c.asset_count} assets</span><span class="muted">${esc(c.description||"")}</span></button>`).join("")
    || '<p class="muted">No collections yet.</p>';
  $$("#collection-list .collection-card").forEach(card => card.addEventListener("click", () => {
    state.collection = card.dataset.id;
    offset = 0;
    fromCollections = true;
    showView("library");
  }));
}
$("#btn-new-collection").addEventListener("click", async () => {
  const name = prompt("Collection name"); if (!name) return;
  await api("/api/collections", { json: { name } }); loadCollections();
});

// ---------- dashboard ----------
async function loadDashboard() {
  const session = sessionVersion;
  const s = await api("/api/stats");
  if (session !== sessionVersion) return;
  const cards = [
    ["Total assets", s.total_assets], ["Storage used", fmtBytes(s.total_bytes)],
    ["Saved by dedup", fmtBytes(s.dedup_saved_bytes)], ["Tags", s.tags], ["Collections", s.collections],
    ...Object.entries(s.by_type).map(([k,v]) => [k.charAt(0).toUpperCase()+k.slice(1), v]),
  ];
  $("#stat-cards").innerHTML = cards.map(([l,n]) => `<div class="stat-card"><div class="n">${n}</div><div class="l">${l}</div></div>`).join("");
}
$("#btn-fixity").addEventListener("click", async () => {
  const session = sessionVersion;
  $("#fixity-result").textContent = "Checking...";
  const r = await api("/api/admin/fixity", { method: "POST" });
  if (session !== sessionVersion) return;
  $("#fixity-result").textContent = r.ok ? `All ${r.checked} blobs verified. Integrity intact.` : `${r.failures.length} of ${r.checked} failed fixity.`;
});

// ---------- users ----------
async function loadUsers() {
  const session = sessionVersion;
  const data = await api("/api/users");
  if (session !== sessionVersion) return;
  $("#user-rows").innerHTML = data.users.map(u =>
    `<tr><td>${esc(u.username)}</td><td>${esc(u.email||"")}</td><td>${u.role}</td><td>${u.is_active?"Yes":"No"}</td><td>${(u.last_login||"").slice(0,16).replace("T"," ")}</td></tr>`).join("");
}
$("#btn-new-user").addEventListener("click", async () => {
  const username = prompt("Username"); if (!username) return;
  const password = prompt("Temporary password"); if (!password) return;
  const role = prompt("Role (admin/editor/contributor/viewer)", "contributor") || "viewer";
  await api("/api/users", { json: { username, password, role } }); loadUsers();
});

// ---------- audit ----------
async function loadAudit() {
  const session = sessionVersion;
  const data = await api("/api/audit");
  if (session !== sessionVersion) return;
  $("#audit-rows").innerHTML = data.entries.map(e =>
    `<tr><td>${(e.ts||"").slice(0,19).replace("T"," ")}</td><td>${esc(e.username||"-")}</td><td>${esc(e.action)}</td>
     <td>${esc(e.target_type||"")} ${esc((e.target_id||"").slice(0,8))}</td><td>${esc(e.detail||"")}</td><td>${esc(e.ip||"")}</td></tr>`).join("");
}

// ---------- boot ----------
(async function boot() {
  if (state.token) {
    try { state.user = await api("/api/auth/me"); enterApp(); return; } catch {}
  }
  $("#login").classList.remove("hidden");
})();
