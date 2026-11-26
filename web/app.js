/* Keepstack single-page client. Vanilla JS, no build step. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const initialFilters = { q: "", media: "", includeTags: [], excludeTags: [], sort: "newest", collection: "" };
const state = { token: localStorage.getItem("keepstack_token"), user: null, ...initialFilters };
let sessionVersion = 0;
let tagCatalog = [];
let recentTags = [];
let filterOptionsVersion = 0;
let collectionCatalog = [], collectionCatalogVersion = 0;
let collectionViewId = null, collectionOffset = 0, collectionTotal = 0, collectionVersion = 0;
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
    throw Object.assign(new Error("unauthorised"), { status: res.status });
  }
  if (!res.ok) {
    const text = await res.text();
    let message = text || res.statusText;
    try {
      const detail = JSON.parse(text).detail;
      if (typeof detail === "string") message = detail;
    } catch {}
    throw Object.assign(new Error(message), { status: res.status });
  }
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
  } catch (error) {
    const message = {
      401: "Invalid credentials",
      429: "Too many failed attempts. Try again later.",
    }[error.status] || "Could not sign in. Please try again.";
    $("#login-error").textContent = message;
    $("#login-error").classList.remove("hidden");
  }
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
  recentTags = [];
  collectionCatalog = [];
  collectionViewId = null;
  collectionOffset = collectionTotal = 0;
  $("#collection-create-dialog").close();
  $("#collection-asset-picker").close();
  $("#filter-collection").replaceChildren(new Option("All collections", ""));
  $("#filter-error").classList.add("hidden");
  for (const picker of $$(".tag-filter details")) {
    picker.open = false;
    picker.dataset.page = "0";
    $("input", picker).value = "";
    $(".tag-options", picker).replaceChildren();
  }
  syncFilters();
  $("#empty").classList.add("hidden");
  $("#library-loading").classList.add("hidden");
  $("#library-error").classList.add("hidden");
  $("#result-title").textContent = "Library";
  for (const selector of ["#grid", "#drawer-body", "#collection-list", "#collection-grid", "#collection-picker-grid",
    "#stat-cards", "#fixity-result", "#user-rows", "#audit-rows", "#upload-list", "#user-label"]) {
    $(selector).replaceChildren();
  }
  $("#file-input").value = "";
  uploadBatch = [];
  uploadBusy = false;
  syncUploadBatch();
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
  for (const selector of ["#btn-upload", "#btn-new-collection", "#collection-add-assets"]) {
    $(selector).classList.toggle("hidden", !canEditAssets());
  }
  showView("library");
}

// ---------- navigation ----------
function canEditAssets() {
  return ["admin", "editor", "contributor"].includes(state.user?.role);
}

function canDeleteAssets() {
  return ["admin", "editor"].includes(state.user?.role);
}

$$(".nav-item").forEach(btn => btn.addEventListener("click", () => showView(btn.dataset.view)));
function showView(view) {
  $$(".nav-item").forEach(btn => btn.classList.toggle("active", btn.dataset.view === view));
  $$(".view").forEach(panel => panel.classList.toggle("hidden", panel.id !== "view-" + view));
  if (view === "library") {
    loadFilterOptions();
    loadLibrary();
  }
  if (view === "collections") showCollectionList();
  if (view === "dashboard") loadDashboard();
  if (view === "users") loadUsers();
  if (view === "audit") loadAudit();
}

// ---------- library / search ----------
let searchTimer;
const tagPickers = { includeTags: $("#include-tags"), excludeTags: $("#exclude-tags") };
const tagPageSize = 8;
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
    $(".tag-selection-count", picker).textContent = sign + (state[key].length
      ? " " + state[key].length + " selected · Edit" : " Choose tags");
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
  const names = [...new Set([...recentTags, ...tagCatalog])].filter(name => name.toLowerCase().includes(query));
  renderPickerPage(picker, names, query ? "No tag names found." : "No tags available.", name => {
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
    return button;
  });
}

function renderPickerPage(picker, items, emptyText, createOption) {
  const list = $(".tag-options", picker);
  const pageCount = Math.max(1, Math.ceil(items.length / tagPageSize));
  const page = Math.max(0, Math.min(Number(picker.dataset.page || 0), pageCount - 1));
  picker.dataset.page = String(page);
  list.replaceChildren(...items.slice(page * tagPageSize, (page + 1) * tagPageSize).map(createOption));
  if (!items.length) list.textContent = emptyText;
  $(".tag-prev", picker).disabled = page === 0;
  $(".tag-next", picker).disabled = page + 1 === pageCount;
  $(".tag-page", picker).textContent = items.length ? `${page + 1} / ${pageCount}` : "0 results";
}

function bindPickerPages(picker, render) {
  $("input", picker).addEventListener("input", () => { picker.dataset.page = "0"; render(); });
  for (const [selector, step] of [[".tag-prev", -1], [".tag-next", 1]]) {
    $(selector, picker).addEventListener("click", () => {
      picker.dataset.page = String(Number(picker.dataset.page) + step);
      render();
    });
  }
}

for (const [key, picker] of Object.entries(tagPickers)) {
  const closePicker = () => { picker.open = false; $("summary", picker).focus(); };
  $("summary", picker).addEventListener("click", () => {
    if (!picker.open) {
      Object.values(tagPickers).filter(other => other !== picker).forEach(other => { other.open = false; });
      $("input", picker).value = "";
      picker.dataset.page = "0";
      renderTagOptions(key);
    }
  });
  bindPickerPages(picker, () => renderTagOptions(key));
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
  const version = ++filterOptionsVersion;
  try {
    const [catalogLoaded, tags] = await Promise.all([loadCollectionCatalog(), api("/api/tags", { cache: "no-store" })]);
    if (session !== sessionVersion || version !== filterOptionsVersion) return;
    tagCatalog = tags.tags.map(tag => tag.name);
    Object.keys(tagPickers).forEach(renderTagOptions);
    $("#filter-error").textContent = "Could not load collections. Reopen Library to retry.";
    $("#filter-error").classList.toggle("hidden", catalogLoaded);
    syncFilters();
  } catch {
    if (session !== sessionVersion || version !== filterOptionsVersion) return;
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
  renderAssetCards($("#grid"), items);
}

function renderAssetCards(grid, items) {
  grid.innerHTML = items.map(a => `
    <button class="card asset-card" data-uuid="${a.uuid}" type="button">
      <img class="thumb" loading="lazy" src="/api/assets/${a.uuid}/thumb" alt="${esc(a.alt_text || a.title)}">
      <span class="meta">
        <span class="title" title="${esc(a.title)}">${esc(a.title)}</span>
        <span class="sub"><span class="badge">${a.media_type}</span><span>${fmtBytes(a.size)}</span></span>
      </span>
    </button>`).join("");
  $$(".card", grid).forEach(card => card.addEventListener("click", () => openAsset(card.dataset.uuid)));
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

function editPickerMarkup(kind, plural) {
  return `<details class="edit-picker" id="edit-${kind}-picker">
    <summary>＋ Add ${plural}</summary>
    <div class="tag-picker">
      <label class="filter-field">Find ${plural}<input id="edit-${kind}-search" type="search"
        placeholder="Search ${kind} names" autocomplete="off"></label>
      <div class="tag-options"></div>
      <div class="tag-picker-actions">
        <button class="btn tag-prev" type="button">Previous</button>
        <span class="tag-page muted" aria-live="polite"></span>
        <button class="btn tag-next" type="button">Next</button>
      </div>
      <div class="btn-row edit-picker-actions">
        ${kind === "tag" ? '<button class="btn edit-picker-create hidden" type="button"></button>' : ""}
        <button class="btn edit-picker-cancel" type="button">Cancel</button>
        <button class="btn btn-primary edit-picker-apply" type="button" disabled>Add selected</button>
      </div>
    </div>
  </details>`;
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
  const canEdit = canEditAssets();
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
      ${canDeleteAssets()?`<button class="btn btn-danger" id="d-delete">Delete</button>`:""}
    </div>

    ${canEdit ? `<form class="detail-section" id="asset-edit"><fieldset>
      <legend>Edit asset</legend>
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
        ${editPickerMarkup("tag", "tags")}
      </div>
      <div class="edit-tags edit-collections">
        <h4>Collections</h4>
        <div class="tag-row" id="asset-collection-row"></div>
        ${editPickerMarkup("collection", "collections")}
        <p class="muted edit-tag-help">Save to apply tag and collection changes. Removing a collection here does not delete the asset.</p>
      </div>
      <div class="btn-row"><button class="btn btn-primary" id="d-save" type="submit" disabled>Save changes</button>
        <span id="edit-message" role="status"></span></div>
    </fieldset></form>` : `<div class="detail-section"><h4>Tags</h4><div class="tag-row" id="tag-row"></div></div>
      <div class="detail-section"><h4>Collections</h4><div class="tag-row" id="asset-collection-row"></div></div>`}

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
    bindAssetEditor(uuid, d.tags, d.collections);
    $("#d-share")?.addEventListener("click", async () => {
      const r = await api("/api/shares", { json: { target_type: "asset", target_id: a.id, permission: "download" } });
      await navigator.clipboard?.writeText(r.url).catch(()=>{});
      toast("Share link copied: " + r.url);
    });
  } else {
    renderDetailChips($("#tag-row"), d.tags, "tag");
    renderDetailChips($("#asset-collection-row"), d.collections, "collection");
  }
  $("#d-delete")?.addEventListener("click", async () => {
    if ($("#asset-edit fieldset")?.disabled) return;
    if (!confirm("Delete this asset?")) return;
    await api("/api/assets/"+uuid, { method: "DELETE" });
    if (session !== sessionVersion) return;
    toast("Deleted");
    if (version === drawerVersion) resetDrawer();
    refreshAssetViews({collections: true});
  });
}

function renderDetailChips(row, items, kind, removeItem) {
  row.replaceChildren();
  if (!items.length) row.textContent = kind === "tag" ? "No tags" : "No collections";
  for (const item of items) {
    const chip = document.createElement("span");
    chip.className = "tag";
    chip.textContent = item.name;
    if (removeItem) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "rm";
      if (kind === "tag") remove.dataset.tag = item.name;
      remove.textContent = "×";
      remove.setAttribute("aria-label", (kind === "tag" ? "Remove tag: " : "Remove from collection: ") + item.name);
      remove.addEventListener("click", () => removeItem(item));
      chip.append(remove);
    }
    row.append(chip);
  }
}

function bindEditPicker(picker, options, alreadyAdded, apply, create) {
  const summary = $("summary", picker);
  const input = $("input", picker);
  const add = $(".edit-picker-apply", picker);
  const createButton = $(".edit-picker-create", picker);
  const pending = new Map();
  const close = () => {
    picker.open = false;
    pending.clear();
    summary.focus({ preventScroll: true });
  };
  const render = () => {
    const text = input.value.trim().toLowerCase();
    const items = options();
    const matches = items.filter(item => item.name.toLowerCase().includes(text));
    renderPickerPage(picker, matches, text ? "No matches found." : "No options available.", item => {
      const present = alreadyAdded(item);
      const button = document.createElement("button");
      button.className = "btn";
      button.type = "button";
      button.textContent = present ? item.name + " · Already added" : item.name;
      button.disabled = present;
      button.setAttribute("aria-pressed", String(pending.has(item.key)));
      button.addEventListener("click", () => {
        if (pending.has(item.key)) pending.delete(item.key);
        else pending.set(item.key, item);
        button.setAttribute("aria-pressed", String(pending.has(item.key)));
        syncPending();
      });
      return button;
    });
    if (createButton) {
      createButton.classList.toggle("hidden", !text || items.some(item => item.name.toLowerCase() === text)
        || alreadyAdded({ name: text }));
      createButton.textContent = `Create “${text}”`;
    }
    syncPending();
  };
  function syncPending() {
    add.disabled = pending.size === 0;
    add.textContent = pending.size ? `Add selected (${pending.size})` : "Add selected";
  }
  bindPickerPages(picker, render);
  summary.addEventListener("click", () => {
    if (picker.open) return;
    $$(".edit-picker", picker.closest("form")).filter(other => other !== picker).forEach(other => { other.open = false; });
    input.value = "";
    pending.clear();
    picker.dataset.page = "0";
    render();
  });
  picker.addEventListener("keydown", event => {
    if (event.key === "Escape" && picker.open) {
      event.preventDefault();
      close();
    } else if (event.key === "Enter" && event.target === input && !event.isComposing) {
      event.preventDefault();
    }
  });
  $(".edit-picker-cancel", picker).addEventListener("click", close);
  add.addEventListener("click", () => {
    apply([...pending.values()]);
    close();
  });
  createButton?.addEventListener("click", () => {
    apply([...pending.values(), create(input.value.trim().toLowerCase())]);
    close();
  });
  return () => { if (picker.open) render(); };
}

function bindAssetEditor(uuid, tags, collections) {
  const form = $("#asset-edit");
  const fieldset = $("fieldset", form);
  const save = $("#d-save");
  const tagPicker = $("#edit-tag-picker");
  const collectionPicker = $("#edit-collection-picker");
  const message = $("#edit-message");
  const fields = ["title", "description", "alt_text", "dc_creator", "rights_statement", "retention_until"];
  const readFields = () => Object.fromEntries(fields.map(name => [name, $("#e-" + name, form).value]));
  const names = () => tags.map(tag => tag.name).sort();
  const collectionIds = () => collections.map(item => item.id).sort((left, right) => left - right);
  let savedFields = readFields(), savedNames = names(), savedTags = tags;
  let savedCollectionIds = collectionIds();
  const tagsChanged = () => JSON.stringify(names()) !== JSON.stringify(savedNames);
  const collectionsChanged = () => JSON.stringify(collectionIds()) !== JSON.stringify(savedCollectionIds);
  const dirty = () => tagsChanged() || collectionsChanged()
    || fields.some(name => $("#e-" + name, form).value !== savedFields[name]);
  canLeaveAsset = () => !fieldset.disabled && (!dirty() || confirm("Discard unsaved changes?"));
  const sync = () => { save.disabled = fieldset.disabled || !dirty(); };
  const changed = () => { message.textContent = ""; sync(); };
  const renderTags = () => renderDetailChips($("#tag-row"), tags, "tag", item => {
    tags = tags.filter(tag => tag.name !== item.name);
    renderTags();
    $("summary", tagPicker).focus({ preventScroll: true });
    refreshTagPicker();
    changed();
  });
  const renderCollections = () => renderDetailChips($("#asset-collection-row"), collections, "collection", item => {
    collections = collections.filter(collection => collection.id !== item.id);
    renderCollections();
    $("summary", collectionPicker).focus({ preventScroll: true });
    refreshCollectionPicker();
    changed();
  });
  const newTag = name => savedTags.find(tag => tag.name === name) || { name, source: "manual" };
  const refreshTagPicker = bindEditPicker(tagPicker,
    () => [...new Set([...recentTags, ...tagCatalog, ...names()])].map(name => ({ ...newTag(name), key: name })),
    item => tags.some(tag => tag.name === item.name), items => {
      for (const item of items) if (!tags.some(tag => tag.name === item.name)) tags = [...tags, item];
      renderTags();
      changed();
    }, newTag);
  const refreshCollectionPicker = bindEditPicker(collectionPicker,
    () => collectionCatalog.map(item => ({ ...item, key: item.id })),
    item => collections.some(collection => collection.id === item.id), items => {
      for (const item of items) if (!collections.some(collection => collection.id === item.id)) collections = [...collections, item];
      renderCollections();
      changed();
    });
  form.addEventListener("input", event => {
    if (!event.target.closest(".edit-picker")) changed();
  });
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (fieldset.disabled) return;
    if (!dirty()) return;
    const values = readFields();
    const body = Object.fromEntries(fields.filter(name => values[name] !== savedFields[name])
      .map(name => [name, values[name]]));
    const changedTags = tagsChanged();
    const changedCollections = collectionsChanged();
    if (changedTags) body.tags = names();
    if (changedCollections) body.collection_ids = collectionIds();
    fieldset.disabled = true;
    message.textContent = "Saving…";
    message.className = "muted";
    try {
      const updated = await api("/api/assets/" + uuid, { method: "PATCH", json: body });
      if (!form.isConnected) return;
      savedFields = values;
      tags = savedTags = updated.tags;
      if (changedTags) {
        const added = names().filter(name => !savedNames.includes(name));
        recentTags = [...new Set([...added, ...recentTags])].slice(0, tagPageSize);
        Object.keys(tagPickers).forEach(renderTagOptions);
      }
      savedNames = names();
      collections = updated.collections;
      savedCollectionIds = collectionIds();
      message.textContent = "Saved";
      $(".detail-title").textContent = updated.asset.title;
      $(".detail-preview").alt = updated.asset.alt_text || updated.asset.title;
      $("#dublin-core-values").innerHTML = dublinCoreRows(updated.asset.dublin_core);
      renderTags();
      renderCollections();
      refreshAssetViews({tags: changedTags, collections: changedCollections});
    } catch {
      message.className = "error";
      message.textContent = "Could not save. Your changes are still here.";
    } finally {
      fieldset.disabled = false;
      sync();
    }
  });
  renderTags();
  renderCollections();
  loadFilterOptions().then(() => {
    if (form.isConnected) { refreshTagPicker(); refreshCollectionPicker(); }
  });
  sync();
}

// ---------- upload ----------
const uploadModal = $("#upload-modal");
let uploadBatch = [], uploadBusy = false;
$("#btn-upload").addEventListener("click", () => {
  uploadModal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  (dz.disabled ? $("#upload-cancel") : dz).focus();
});
function closeUpload() {
  uploadModal.classList.add("hidden");
  document.body.classList.remove("modal-open");
  $("#btn-upload").focus();
}
$("#upload-cancel").addEventListener("click", closeUpload);
$(".modal-backdrop").addEventListener("click", closeUpload);
const dz = $("#dropzone"), fileInput = $("#file-input");
dz.addEventListener("click", () => fileInput.click());
dz.addEventListener("dragover", e => { e.preventDefault(); dz.classList.add("drag"); });
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", e => { e.preventDefault(); dz.classList.remove("drag"); uploadFiles(e.dataTransfer.files); });
fileInput.addEventListener("change", () => {
  const files = [...fileInput.files];
  fileInput.value = "";
  uploadFiles(files);
});
uploadModal.addEventListener("keydown", event => { if (event.key === "Escape") closeUpload(); });

function uploadFiles(files) {
  if (uploadBusy || !files.length) return;
  const list = $("#upload-list");
  list.replaceChildren();
  uploadBatch = [...files].map(file => {
    const row = document.createElement("div");
    row.className = "upload-item";
    row.innerHTML = `<span>${esc(file.name)}</span><span class="upload-status"></span><button type="button" class="btn hidden">Retry</button>`;
    list.append(row);
    const item = { file, row, state: "queued", error: "", runAI: $("#ai-toggle").checked };
    $("button", row).setAttribute("aria-label", "Retry " + file.name);
    $("button", row).addEventListener("click", () => uploadItems([item]));
    return item;
  });
  uploadItems(uploadBatch);
}

function syncUploadBatch() {
  const counts = { ok: 0, dup: 0, err: 0, pending: 0 };
  dz.disabled = uploadBusy;
  for (const item of uploadBatch) {
    item.row.className = "upload-item " + item.state;
    $(".upload-status", item.row).textContent = {
      queued: "Queued", sending: "Uploading…", ok: "Uploaded", dup: "Already exists", err: "Failed — " + item.error,
    }[item.state];
    $("button", item.row).classList.toggle("hidden", item.state !== "err");
    $("button", item.row).disabled = uploadBusy;
    if (item.state in counts) counts[item.state]++;
    else counts.pending++;
  }
  $("#upload-summary").textContent = !uploadBatch.length ? "" : [
    `${counts.ok} uploaded`, `${counts.dup} already exists`, `${counts.err} failed`,
    ...(counts.pending ? [`${counts.pending} pending`] : []),
  ].join(" · ");
}

async function uploadItems(items) {
  if (uploadBusy) return;
  const session = sessionVersion;
  uploadBusy = true;
  let added = false;
  for (const item of items) {
    item.state = "sending";
    syncUploadBatch();
    const body = new FormData();
    body.append("files", item.file);
    body.append("run_ai", item.runAI);
    try {
      const result = await api("/api/assets", { method: "POST", body });
      if (session !== sessionVersion) return;
      item.state = result.created[0].duplicate ? "dup" : "ok";
      added ||= item.state === "ok";
    } catch (error) {
      if (session !== sessionVersion) return;
      item.state = "err";
      item.error = error.message.length <= 150 && error.message || "Upload failed. Please try again.";
    }
  }
  uploadBusy = false;
  syncUploadBatch();
  if (added && session === sessionVersion) {
    refreshAssetViews({ tags: true });
    if (!$("#view-audit").classList.contains("hidden")) loadAudit();
  }
}

// ---------- collections ----------
async function loadCollectionCatalog() {
  const session = sessionVersion;
  const version = ++collectionCatalogVersion;
  try {
    const data = await api("/api/collections", { cache: "no-store" });
    if (session !== sessionVersion || version !== collectionCatalogVersion) return true;
    collectionCatalog = data.collections;
    $("#filter-collection").replaceChildren(new Option("All collections", ""),
      ...collectionCatalog.map(item => new Option(item.name, item.id)));
    if (state.collection && !collectionCatalog.some(item => String(item.id) === state.collection)) {
      state.collection = "";
      if (!$("#view-library").classList.contains("hidden")) updateFilters();
      else offset = 0;
    }
    syncFilters();
    if (collectionViewId === null) renderCollectionList();
    return true;
  } catch {
    if (session !== sessionVersion || version !== collectionCatalogVersion) return true;
    if (!$("#view-collections").classList.contains("hidden") && collectionViewId === null) {
      $("#collection-list").innerHTML = '<button type="button" class="btn">Could not load collections. Retry</button>';
      $("#collection-list button").addEventListener("click", showCollectionList);
    }
    return false;
  }
}

const collectionLabel = count => `${count} ${count === 1 ? "asset" : "assets"}`;

function renderCollectionList() {
  $("#collection-list").innerHTML = collectionCatalog.map(item => `
    <div class="collection-tile">
      <button type="button" class="collection-card" data-id="${item.id}">
        <span class="n">${esc(item.name)}</span><span class="muted">${collectionLabel(item.asset_count)}</span>
        ${item.description ? `<span class="muted">${esc(item.description)}</span>` : ""}
      </button>
      ${canDeleteAssets() ? `<button class="btn btn-ghost collection-delete" type="button"
        data-id="${item.id}" aria-label="Delete collection: ${esc(item.name)}">×</button>` : ""}
    </div>`).join("")
    || '<p class="muted">No collections yet.</p>';
  $$(".collection-card").forEach(button => button.addEventListener("click", () => {
    const item = collectionCatalog.find(collection => collection.id === Number(button.dataset.id));
    if (!item) return;
    collectionViewId = item.id;
    collectionOffset = 0;
    $("#collection-overview").classList.add("hidden");
    $("#collection-members").classList.remove("hidden");
    $("#collection-name").textContent = item.name;
    loadCollectionAssets();
  }));
  $$(".collection-delete").forEach(button => button.addEventListener("click", async () => {
    const item = collectionCatalog.find(collection => collection.id === Number(button.dataset.id));
    if (!item || !confirm(`Delete “${item.name}”?\n\nThis deletes the collection only. Its assets stay in Library and other collections.`)) return;
    const session = sessionVersion;
    button.disabled = true;
    try {
      await api("/api/collections/" + item.id, { method: "DELETE" });
      if (session !== sessionVersion) return;
      const wasFiltered = state.collection === String(item.id);
      collectionCatalog = collectionCatalog.filter(collection => collection.id !== item.id);
      if (wasFiltered) {
        state.collection = "";
        offset = 0;
      }
      renderCollectionList();
      refreshAssetViews({ collections: true });
      toast(wasFiltered ? "Collection deleted. Library collection filter cleared." : "Collection deleted. Assets kept.");
    } catch {
      if (session === sessionVersion) toast("Could not delete collection. Try again.", "err");
    } finally {
      button.disabled = false;
    }
  }));
}

function showCollectionList() {
  collectionViewId = null;
  collectionVersion++;
  $("#collection-members").classList.add("hidden");
  $("#collection-overview").classList.remove("hidden");
  renderCollectionList();
  loadCollectionCatalog();
}
$("#collection-back").addEventListener("click", showCollectionList);

function syncCollectionPages(ready) {
  $("#collection-prev").disabled = !ready || collectionOffset === 0;
  $("#collection-next").disabled = !ready || collectionOffset + pageSize >= collectionTotal;
  $("#collection-page-summary").textContent =
    `${collectionOffset + 1}–${Math.min(collectionOffset + pageSize, collectionTotal)} of ${collectionTotal}`;
  $("#collection-pages").classList.toggle("hidden", !ready || collectionTotal <= pageSize);
}

async function loadCollectionAssets() {
  if (collectionViewId === null || $("#view-collections").classList.contains("hidden")) return;
  const session = sessionVersion, version = ++collectionVersion, id = collectionViewId;
  const status = $("#collection-status");
  const grid = $("#collection-grid");
  grid.replaceChildren();
  status.textContent = "Loading assets…";
  status.classList.remove("hidden");
  $("#collection-count").textContent = "";
  syncCollectionPages(false);
  try {
    const data = await api(`/api/assets?collection_id=${id}&limit=${pageSize}&offset=${collectionOffset}`);
    if (session !== sessionVersion || version !== collectionVersion) return;
    if (collectionOffset && collectionOffset >= data.total) {
      collectionOffset = Math.max(0, Math.floor((data.total - 1) / pageSize) * pageSize);
      loadCollectionAssets();
      return;
    }
    collectionTotal = data.total;
    $("#collection-count").textContent = collectionLabel(data.total);
    status.textContent = canEditAssets() ? "No assets yet. Use Add assets to select items from Library." : "No assets in this collection.";
    status.classList.toggle("hidden", data.items.length > 0);
    renderAssetCards(grid, data.items);
    syncCollectionPages(true);
  } catch {
    if (session !== sessionVersion || version !== collectionVersion) return;
    status.innerHTML = '<p>Could not load collection assets.</p><button class="btn" type="button">Retry</button>';
    $("button", status).addEventListener("click", loadCollectionAssets);
  }
}

for (const [selector, step] of [["#collection-prev", -pageSize], ["#collection-next", pageSize]]) {
  $(selector).addEventListener("click", () => { collectionOffset += step; loadCollectionAssets(); });
}

function refreshAssetViews({ tags = false, collections = false } = {}) {
  loadLibrary();
  loadCollectionAssets();
  if (tags) loadFilterOptions();
  else if (collections) loadCollectionCatalog();
}

const createCollectionDialog = $("#collection-create-dialog");
const createCollectionName = $("#collection-new-name");
const createCollectionError = $("#collection-create-error");
$("#btn-new-collection").addEventListener("click", () => {
  createCollectionName.value = "";
  createCollectionError.textContent = "";
  createCollectionDialog.showModal();
  createCollectionName.focus();
});
$("#collection-create-cancel").addEventListener("click", () => createCollectionDialog.close());
createCollectionDialog.addEventListener("cancel", event => {
  if ($("button[type=submit]", createCollectionDialog).disabled) event.preventDefault();
});
$("#collection-create-form").addEventListener("submit", async event => {
  event.preventDefault();
  const name = createCollectionName.value.trim();
  if (!name) { createCollectionError.textContent = "Enter a collection name."; return; }
  const session = sessionVersion;
  const buttons = $$("button", createCollectionDialog);
  buttons.forEach(button => { button.disabled = true; });
  createCollectionName.disabled = true;
  createCollectionError.textContent = "";
  try {
    await api("/api/collections", { json: { name } });
    if (session !== sessionVersion) return;
    createCollectionDialog.close();
    loadCollectionCatalog();
    toast("Collection created");
  } catch (error) {
    if (session === sessionVersion) createCollectionError.textContent =
      error.message.includes("already exists") ? "A collection with this name already exists." : "Could not create collection. Try again.";
  } finally {
    buttons.forEach(button => { button.disabled = false; });
    createCollectionName.disabled = false;
  }
});

const assetPicker = $("#collection-asset-picker");
const pickerGrid = $("#collection-picker-grid");
const pickerStatus = $("#collection-picker-status");
const pickerAdd = $("#collection-picker-add");
const pickedAssets = new Set();
let pickerOffset = 0, pickerTotal = 0, pickerVersion = 0, pickerSaving = false;

function syncAssetPicker(ready) {
  pickerAdd.disabled = pickerSaving || pickedAssets.size === 0;
  pickerAdd.textContent = pickerSaving ? "Adding…" : pickedAssets.size ? `Add ${collectionLabel(pickedAssets.size)}` : "Add selected assets";
  $("#collection-picker-prev").disabled = !ready || pickerSaving || pickerOffset === 0;
  $("#collection-picker-next").disabled = !ready || pickerSaving || pickerOffset + pageSize >= pickerTotal;
  $("#collection-picker-page").textContent = ready && pickerTotal
    ? `${pickerOffset + 1}–${Math.min(pickerOffset + pageSize, pickerTotal)} of ${pickerTotal}` : "";
}

async function loadAssetChoices() {
  const session = sessionVersion, version = ++pickerVersion, id = collectionViewId;
  pickerGrid.replaceChildren();
  pickerStatus.textContent = "Loading assets…";
  syncAssetPicker(false);
  try {
    const data = await api(`/api/collections/${id}/candidates?limit=${pageSize}&offset=${pickerOffset}`);
    if (session !== sessionVersion || version !== pickerVersion || !assetPicker.open) return;
    if (pickerOffset && pickerOffset >= data.total) {
      pickerOffset = Math.max(0, Math.floor((data.total - 1) / pageSize) * pageSize);
      loadAssetChoices();
      return;
    }
    pickerTotal = data.total;
    for (const item of data.items) if (item.already_added) pickedAssets.delete(item.uuid);
    pickerGrid.innerHTML = data.items.map(item => `<label class="picker-choice">
      <img src="/api/assets/${item.uuid}/thumb" alt="" loading="lazy">
      <input type="checkbox" value="${item.uuid}" ${item.already_added ? "disabled" : pickedAssets.has(item.uuid) ? "checked" : ""}>
      <span>${esc(item.title)}</span><small class="muted">${item.already_added ? "Already added" : esc(item.media_type)}</small>
    </label>`).join("");
    pickerStatus.textContent = data.total ? "" : "No Library assets available.";
    syncAssetPicker(true);
  } catch {
    if (session !== sessionVersion || version !== pickerVersion || !assetPicker.open) return;
    pickerStatus.innerHTML = 'Could not load assets. <button class="btn" type="button">Retry</button>';
    $("button", pickerStatus).addEventListener("click", loadAssetChoices);
  }
}

$("#collection-add-assets").addEventListener("click", () => {
  const item = collectionCatalog.find(collection => collection.id === collectionViewId);
  if (!item) return;
  pickedAssets.clear();
  pickerOffset = pickerTotal = 0;
  $("#collection-picker-title").textContent = `Add assets to ${item.name}`;
  assetPicker.showModal();
  loadAssetChoices();
});
assetPicker.addEventListener("cancel", event => { if (pickerSaving) event.preventDefault(); });
$("#collection-picker-cancel").addEventListener("click", () => { if (!pickerSaving) assetPicker.close(); });
pickerGrid.addEventListener("change", event => {
  const input = event.target;
  if (input.checked) pickedAssets.add(input.value);
  else pickedAssets.delete(input.value);
  syncAssetPicker(true);
});
for (const [selector, step] of [["#collection-picker-prev", -pageSize], ["#collection-picker-next", pageSize]]) {
  $(selector).addEventListener("click", () => { pickerOffset += step; loadAssetChoices(); });
}
pickerAdd.addEventListener("click", async () => {
  if (pickerSaving || !pickedAssets.size) return;
  const session = sessionVersion;
  pickerSaving = true;
  const cancel = $("#collection-picker-cancel");
  cancel.disabled = true;
  const inputs = $$("input:not(:disabled)", pickerGrid);
  inputs.forEach(input => { input.disabled = true; });
  syncAssetPicker(false);
  try {
    const result = await api(`/api/collections/${collectionViewId}/assets`, { json: { uuids: [...pickedAssets] } });
    if (session !== sessionVersion) return;
    assetPicker.close();
    refreshAssetViews({ collections: true });
    toast(result.added ? `Added ${collectionLabel(result.added)}` : "Selected assets already added");
  } catch {
    if (session === sessionVersion) pickerStatus.textContent = "Could not add assets. Your selection is still here.";
  } finally {
    pickerSaving = false;
    cancel.disabled = false;
    inputs.forEach(input => { input.disabled = false; });
    syncAssetPicker(true);
  }
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
let auditVersion = 0;
async function loadAudit() {
  const session = sessionVersion;
  const version = ++auditVersion;
  let data;
  try {
    data = await api("/api/audit", { cache: "no-store" });
  } catch {
    if (session === sessionVersion && version === auditVersion) toast("Could not load the audit log. Try again.", "err");
    return;
  }
  if (session !== sessionVersion || version !== auditVersion) return;
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
