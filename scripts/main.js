const MODULE_ID = "sidebar-reorder";
const { ApplicationV2 } = foundry.applications.api;
const ROOT = "__root__";
/** documentName -> undo snapshot of the last save (window or sidebar drag). */
const LAST_UNDO = new Map();

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const t = (key, data) => data ? game.i18n.format(`SR.${key}`, data) : game.i18n.localize(`SR.${key}`);
const byName = (a, b) => a.name.localeCompare(b.name, game.i18n.lang);
const bySort = (a, b) => a.sort - b.sort;

function rootSortingMode(documentName) {
  const collection = game.collections.get(documentName);
  if (collection?.sortingMode) return collection.sortingMode;
  return game.settings.get("core", "collectionSortingModes")?.[documentName] ?? "a";
}

async function setRootSortingMode(documentName, mode) {
  if (rootSortingMode(documentName) === mode) return;
  const modes = foundry.utils.deepClone(game.settings.get("core", "collectionSortingModes") ?? {});
  modes[documentName] = mode;
  await game.settings.set("core", "collectionSortingModes", modes);
}

function entryImage(doc) {
  return doc.thumb || doc.img || null;
}

/* -------------------------------------------- */
/*  Working model of one directory              */
/* -------------------------------------------- */

/**
 * A plain-data copy of a directory tree that can be rearranged freely and then
 * written back to the world in one go.
 */
class ReorderModel {
  constructor(documentName) {
    this.documentName = documentName;
    this.build();
  }

  get collection() { return game.collections.get(this.documentName); }
  get maxDepth() { return this.collection?.maxFolderDepth ?? CONST.FOLDER_MAX_DEPTH ?? 4; }

  build() {
    /** @type {Map<string, object>} key -> node */
    this.nodes = new Map();
    /** @type {Map<string, {mode: string, folders: string[], entries: string[]}>} parentKey -> contents */
    this.parents = new Map();
    this.dirty = new Set();

    const folders = game.folders.filter(f => f.type === this.documentName && !f.pack);
    const entries = this.collection?.contents ?? [];

    this.parents.set(ROOT, { mode: rootSortingMode(this.documentName), folders: [], entries: [] });
    for (const f of folders) this.parents.set(f.id, { mode: f.sorting ?? "a", folders: [], entries: [] });

    const parentOf = (doc) => {
      const pid = doc.folder?.id ?? doc.folder ?? null;
      return (pid && this.parents.has(pid)) ? pid : ROOT;
    };

    const sortFor = (pk) => this.parents.get(pk).mode === "a" ? byName : bySort;

    const folderBuckets = new Map();
    for (const f of folders) {
      const pk = parentOf(f);
      this.nodes.set(f.id, {
        key: f.id, kind: "folder", id: f.id, name: f.name,
        color: f.color ? (f.color.css ?? f.color.toString?.() ?? String(f.color)) : null,
        parent: pk, origParent: pk, origSort: f.sort
      });
      if (!folderBuckets.has(pk)) folderBuckets.set(pk, []);
      folderBuckets.get(pk).push(f);
    }
    const entryBuckets = new Map();
    for (const e of entries) {
      const pk = parentOf(e);
      this.nodes.set(e.id, {
        key: e.id, kind: "entry", id: e.id, name: e.name, img: entryImage(e),
        parent: pk, origParent: pk, origSort: e.sort
      });
      if (!entryBuckets.has(pk)) entryBuckets.set(pk, []);
      entryBuckets.get(pk).push(e);
    }
    for (const [pk, p] of this.parents) {
      p.origMode = p.mode;
      p.folders = (folderBuckets.get(pk) ?? []).sort(sortFor(pk)).map(d => d.id);
      p.entries = (entryBuckets.get(pk) ?? []).sort(sortFor(pk)).map(d => d.id);
      p.origFolders = [...p.folders];
      p.origEntries = [...p.entries];
    }
  }

  listOf(node) {
    const p = this.parents.get(node.parent);
    return node.kind === "folder" ? p.folders : p.entries;
  }

  depthOf(parentKey) {
    let d = 0, k = parentKey;
    while (k !== ROOT) { d++; k = this.nodes.get(k).parent; }
    return d;
  }

  /** Number of folder levels in a folder's subtree, counting itself. */
  heightOf(folderKey) {
    const kids = this.parents.get(folderKey).folders;
    return 1 + (kids.length ? Math.max(...kids.map(k => this.heightOf(k))) : 0);
  }

  isDescendant(candidateKey, ancestorKey) {
    let k = candidateKey;
    while (k !== ROOT) {
      if (k === ancestorKey) return true;
      k = this.nodes.get(k).parent;
    }
    return false;
  }

  /** Can `key` be placed inside `parentKey`? Returns an error string or null. */
  canPlace(key, parentKey) {
    const node = this.nodes.get(key);
    if (node.kind !== "folder") return null;
    if (parentKey !== ROOT && this.isDescendant(parentKey, key)) return t("ErrorIntoSelf");
    if (this.depthOf(parentKey) + this.heightOf(key) > this.maxDepth) return t("ErrorDepth", { max: this.maxDepth });
    return null;
  }

  markManual(parentKey) {
    this.parents.get(parentKey).mode = "m";
    this.dirty.add(parentKey);
  }

  /** Move a node to `parentKey` at `index` (index within the target list, before removal). */
  move(key, parentKey, index) {
    const node = this.nodes.get(key);
    const err = this.canPlace(key, parentKey);
    if (err) { ui.notifications.warn(err); return false; }
    const from = this.listOf(node);
    const oldIndex = from.indexOf(key);
    const oldParent = node.parent;
    from.splice(oldIndex, 1);
    node.parent = parentKey;
    const to = this.listOf(node);
    if (oldParent === parentKey && oldIndex < index) index--;
    index = Math.max(0, Math.min(index, to.length));
    to.splice(index, 0, key);
    this.markManual(oldParent);
    this.markManual(parentKey);
    return true;
  }

  step(key, how) {
    const node = this.nodes.get(key);
    const list = this.listOf(node);
    const i = list.indexOf(key);
    const target = { top: 0, up: i - 1, down: i + 2, bottom: list.length }[how];
    if (target === undefined || (how === "up" && i === 0) || (how === "down" && i === list.length - 1)) return false;
    return this.move(key, node.parent, target);
  }

  sortAlpha(parentKey) {
    const p = this.parents.get(parentKey);
    const names = k => this.nodes.get(k);
    p.folders.sort((a, b) => byName(names(a), names(b)));
    p.entries.sort((a, b) => byName(names(a), names(b)));
    p.mode = "a";
    this.dirty.add(parentKey);
  }

  /** Parents whose final state differs from the world. */
  changedParents() {
    const out = [];
    for (const pk of this.dirty) {
      const p = this.parents.get(pk);
      if (!p) continue;
      const same = p.mode === p.origMode
        && p.folders.join() === p.origFolders.join()
        && p.entries.join() === p.origEntries.join();
      if (!same) out.push(pk);
    }
    return out;
  }

  get hasChanges() { return this.changedParents().length > 0; }

  /** Write changes to the world. Returns an undo snapshot. */
  async save() {
    const changed = this.changedParents();
    if (!changed.length) return null;
    const D = CONST.SORT_INTEGER_DENSITY ?? 100000;
    const folderUpdates = new Map();
    const entryUpdates = new Map();
    const up = (map, id) => { if (!map.has(id)) map.set(id, { _id: id }); return map.get(id); };
    let rootMode = null;

    for (const pk of changed) {
      const p = this.parents.get(pk);
      const parentId = pk === ROOT ? null : pk;
      if (pk === ROOT) rootMode = p.mode;
      else if (p.mode !== p.origMode) up(folderUpdates, pk).sorting = p.mode;

      p.folders.forEach((k, i) => {
        const n = this.nodes.get(k);
        const u = up(folderUpdates, n.id);
        if (n.parent !== n.origParent) u.folder = parentId;
        if (p.mode === "m") u.sort = (i + 1) * D;
      });
      p.entries.forEach((k, i) => {
        const n = this.nodes.get(k);
        const u = up(entryUpdates, n.id);
        if (n.parent !== n.origParent) u.folder = parentId;
        if (p.mode === "m") u.sort = (i + 1) * D;
      });
    }

    // Drop no-op updates and anything that was deleted meanwhile.
    const cls = getDocumentClass(this.documentName);
    const fUpdates = [...folderUpdates.values()].filter(u => Object.keys(u).length > 1 && game.folders.has(u._id));
    const eUpdates = [...entryUpdates.values()].filter(u => Object.keys(u).length > 1 && this.collection.has(u._id));

    // Undo snapshot of every field we are about to touch.
    const undo = {
      documentName: this.documentName,
      rootMode: rootMode !== null ? rootSortingMode(this.documentName) : null,
      folders: fUpdates.map(u => {
        const f = game.folders.get(u._id);
        return { _id: f.id, sort: f.sort, sorting: f.sorting, folder: f.folder?.id ?? null };
      }),
      entries: eUpdates.map(u => {
        const e = this.collection.get(u._id);
        return { _id: e.id, sort: e.sort, folder: e.folder?.id ?? null };
      })
    };

    // Root mode first, then folders (so moved entries land in folders that are already in place).
    if (rootMode !== null) await setRootSortingMode(this.documentName, rootMode);
    if (fUpdates.length) await Folder.implementation.updateDocuments(fUpdates);
    if (eUpdates.length) await cls.updateDocuments(eUpdates);
    refreshDirectory(this.documentName);
    return undo;
  }
}

/** Undo the most recent reorder in the currently open sidebar tab. */
async function undoLastSidebarChange() {
  const active = ui.sidebar?.tabGroups?.primary ?? ui.sidebar?.activeTab;
  const tab = active ? ui[active] : null;
  const documentName = tab?.documentName ?? tab?.constructor?.documentName;
  const undo = documentName && LAST_UNDO.get(documentName);
  if (!undo) return ui.notifications.info(t("NothingToUndo"));
  LAST_UNDO.delete(documentName);
  await applyUndo(undo);
  SidebarReorder.instances.get(documentName)?.reload();
  ui.notifications.info(t("Undone"));
}

async function applyUndo(undo) {
  const cls = getDocumentClass(undo.documentName);
  const collection = game.collections.get(undo.documentName);
  const folders = undo.folders.filter(u => game.folders.has(u._id));
  const entries = undo.entries.filter(u => collection.has(u._id));
  if (undo.rootMode) await setRootSortingMode(undo.documentName, undo.rootMode);
  if (folders.length) await Folder.implementation.updateDocuments(folders);
  if (entries.length) await cls.updateDocuments(entries);
  refreshDirectory(undo.documentName);
}

/**
 * The sidebar caches its folder tree. Changing the sorting-mode setting only redraws it,
 * so rebuild the tree and re-render the directory after any save.
 */
function refreshDirectory(documentName) {
  const collection = game.collections.get(documentName);
  if (!collection) return;
  try { collection.initializeTree?.(); } catch (err) { console.warn(`${MODULE_ID} | initializeTree failed`, err); }
  collection.render?.(true);
  for (const app of Object.values(ui)) {
    if (app?.collection === collection && app.rendered) app.render();
  }
}

/* -------------------------------------------- */
/*  Application                                 */
/* -------------------------------------------- */

class SidebarReorder extends ApplicationV2 {
  static #instances = new Map();
  static get instances() { return this.#instances; }

  static open(documentName) {
    if (!game.user.isGM) return;
    if (!game.collections.get(documentName)) {
      ui.notifications.warn(t("ErrorType", { type: documentName }));
      return;
    }
    let app = this.#instances.get(documentName);
    if (!app) {
      app = new SidebarReorder({ documentName, id: `sidebar-reorder-${documentName}` });
      this.#instances.set(documentName, app);
    }
    app.render({ force: true });
    return app;
  }

  constructor(options) {
    super(options);
    this.documentName = options.documentName;
    this.model = new ReorderModel(this.documentName);
    this.collapsed = new Set();
    this.stale = false;
    this.busy = false;
  }

  /** Undo snapshots are shared with sidebar drag-and-drop. */
  get undo() { return LAST_UNDO.get(this.documentName) ?? null; }
  set undo(v) { if (v) LAST_UNDO.set(this.documentName, v); else LAST_UNDO.delete(this.documentName); }

  static DEFAULT_OPTIONS = {
    classes: ["sidebar-reorder"],
    tag: "div",
    window: { icon: "fa-solid fa-arrow-down-up-across-line", resizable: true },
    position: { width: 480, height: 720 },
    actions: {
      step: SidebarReorder.#onStep,
      toggle: SidebarReorder.#onToggle,
      sortAlpha: SidebarReorder.#onSortAlpha,
      expandAll: SidebarReorder.#onExpandAll,
      collapseAll: SidebarReorder.#onCollapseAll,
      save: SidebarReorder.#onSave,
      discard: SidebarReorder.#onDiscard,
      undo: SidebarReorder.#onUndo
    }
  };

  get title() {
    const label = game.i18n.localize(CONFIG[this.documentName]?.documentClass?.metadata?.labelPlural ?? this.documentName);
    return t("Title", { type: label });
  }

  /* ---------- Rendering ---------- */

  async _prepareContext() { return {}; }

  async _renderHTML() {
    const m = this.model;
    const changes = m.changedParents().length;
    const html = `
      <div class="sr-toolbar">
        <button type="button" data-action="expandAll" data-tooltip="${esc(t("ExpandAll"))}"><i class="fa-solid fa-folder-open"></i></button>
        <button type="button" data-action="collapseAll" data-tooltip="${esc(t("CollapseAll"))}"><i class="fa-solid fa-folder"></i></button>
        <button type="button" data-action="sortAlpha" data-parent="${ROOT}" data-tooltip="${esc(t("SortRootTip"))}"><i class="fa-solid fa-arrow-down-a-z"></i> ${esc(t("SortRoot"))}</button>
        <span class="sr-mode">${this.#modeBadge(ROOT)}</span>
      </div>
      <p class="sr-hint">${esc(t("Hint"))}</p>
      ${this.stale ? `<div class="sr-stale"><i class="fa-solid fa-triangle-exclamation"></i> ${esc(t("Stale"))}</div>` : ""}
      <div class="sr-tree">${this.#renderContents(ROOT)}</div>
      <footer class="sr-footer">
        <button type="button" data-action="undo" ${this.undo && !changes ? "" : "disabled"} data-tooltip="${esc(t("UndoTip"))}"><i class="fa-solid fa-rotate-left"></i> ${esc(t("Undo"))}</button>
        <button type="button" data-action="discard" ${changes ? "" : "disabled"}><i class="fa-solid fa-xmark"></i> ${esc(t("Discard"))}</button>
        <button type="button" data-action="save" class="sr-save" ${changes && !this.busy ? "" : "disabled"}><i class="fa-solid fa-floppy-disk"></i> ${esc(changes ? t("SaveN", { n: changes }) : t("Save"))}</button>
      </footer>`;
    return html;
  }

  _replaceHTML(result, content) {
    const tree = content.querySelector(".sr-tree");
    const scroll = tree?.scrollTop ?? 0;
    content.innerHTML = result;
    const newTree = content.querySelector(".sr-tree");
    if (newTree) newTree.scrollTop = scroll;
  }

  #modeBadge(parentKey) {
    const p = this.model.parents.get(parentKey);
    return p.mode === "a"
      ? `<span class="sr-badge sr-alpha" data-tooltip="${esc(t("ModeAlphaTip"))}">A–Z</span>`
      : `<span class="sr-badge sr-manual" data-tooltip="${esc(t("ModeManualTip"))}">${esc(t("ModeManual"))}</span>`;
  }

  #controls(key) {
    const b = (how, icon, tip) => `<button type="button" class="sr-btn" data-action="step" data-how="${how}" data-key="${key}" data-tooltip="${esc(t(tip))}"><i class="fa-solid ${icon}"></i></button>`;
    return `<span class="sr-controls">${b("top", "fa-angles-up", "Top")}${b("up", "fa-angle-up", "Up")}${b("down", "fa-angle-down", "Down")}${b("bottom", "fa-angles-down", "Bottom")}</span>`;
  }

  #renderContents(parentKey) {
    const p = this.model.parents.get(parentKey);
    const folders = p.folders.map(k => this.#renderFolder(k)).join("");
    const entries = p.entries.map(k => this.#renderEntry(k)).join("");
    return `<ol class="sr-list sr-folders" data-parent="${parentKey}" data-kind="folder">${folders}</ol>`
         + `<ol class="sr-list sr-entries" data-parent="${parentKey}" data-kind="entry">${entries}</ol>`;
  }

  #renderFolder(key) {
    const n = this.model.nodes.get(key);
    const p = this.model.parents.get(key);
    const collapsed = this.collapsed.has(key);
    const count = p.folders.length + p.entries.length;
    const moved = n.parent !== n.origParent || this.#positionChanged(n);
    const style = n.color ? ` style="--sr-folder-color:${esc(n.color)}"` : "";
    return `<li class="sr-node sr-folder ${collapsed ? "collapsed" : ""}" data-key="${key}" data-kind="folder">
      <div class="sr-row ${moved ? "sr-moved" : ""}" draggable="true"${style}>
        <i class="fa-solid fa-grip-vertical sr-grip"></i>
        <a class="sr-toggle" data-action="toggle" data-key="${key}"><i class="fa-solid ${collapsed ? "fa-caret-right" : "fa-caret-down"}"></i></a>
        <i class="fa-solid ${collapsed ? "fa-folder" : "fa-folder-open"} sr-folder-icon"></i>
        <span class="sr-name">${esc(n.name)}</span>
        <span class="sr-count">${count}</span>
        ${this.#modeBadge(key)}
        <button type="button" class="sr-btn" data-action="sortAlpha" data-parent="${key}" data-tooltip="${esc(t("SortFolderTip"))}"><i class="fa-solid fa-arrow-down-a-z"></i></button>
        ${this.#controls(key)}
      </div>
      ${collapsed ? "" : `<div class="sr-children">${this.#renderContents(key)}</div>`}
    </li>`;
  }

  #renderEntry(key) {
    const n = this.model.nodes.get(key);
    const moved = n.parent !== n.origParent || this.#positionChanged(n);
    const img = n.img ? `<img class="sr-thumb" src="${esc(n.img)}" alt="">` : `<i class="fa-solid fa-file sr-thumb sr-noimg"></i>`;
    return `<li class="sr-node sr-entry" data-key="${key}" data-kind="entry">
      <div class="sr-row ${moved ? "sr-moved" : ""}" draggable="true">
        <i class="fa-solid fa-grip-vertical sr-grip"></i>
        ${img}
        <span class="sr-name">${esc(n.name)}</span>
        ${this.#controls(key)}
      </div>
    </li>`;
  }

  #positionChanged(n) {
    const p = this.model.parents.get(n.parent);
    const list = n.kind === "folder" ? p.folders : p.entries;
    const orig = n.kind === "folder" ? p.origFolders : p.origEntries;
    return list.indexOf(n.key) !== orig.indexOf(n.key);
  }

  /* ---------- Drag & drop ---------- */

  _onRender(context, options) {
    super._onRender?.(context, options);
    const tree = this.element.querySelector(".sr-tree");
    if (!tree) return;
    tree.addEventListener("dragstart", this.#onDragStart.bind(this));
    tree.addEventListener("dragover", this.#onDragOver.bind(this));
    tree.addEventListener("dragleave", ev => { if (!tree.contains(ev.relatedTarget)) this.#clearIndicator(); });
    tree.addEventListener("drop", this.#onDrop.bind(this));
    tree.addEventListener("dragend", () => { this.dragKey = null; this.#clearIndicator(); });
  }

  #onDragStart(ev) {
    const node = ev.target.closest?.(".sr-node");
    if (!node || ev.target.closest(".sr-btn, .sr-toggle")) return;
    ev.stopPropagation();
    this.dragKey = node.dataset.key;
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", this.dragKey);
    node.classList.add("sr-dragging");
  }

  /** Work out where a drop at this event would go. */
  #dropTarget(ev) {
    if (!this.dragKey) return null;
    const dragged = this.model.nodes.get(this.dragKey);
    const row = ev.target.closest?.(".sr-row");
    const tree = this.element.querySelector(".sr-tree");

    // Empty space below the tree: append at root.
    if (!row) {
      if (ev.target === tree) {
        const list = dragged.kind === "folder" ? this.model.parents.get(ROOT).folders : this.model.parents.get(ROOT).entries;
        return { parent: ROOT, index: list.length, el: null, pos: "end" };
      }
      return null;
    }
    const li = row.closest(".sr-node");
    const target = this.model.nodes.get(li.dataset.key);
    if (target.key === dragged.key) return null;
    const rect = row.getBoundingClientRect();
    const y = (ev.clientY - rect.top) / rect.height;

    if (target.kind === "folder") {
      // Entries dropped on a folder always go inside it; folders use top/middle/bottom zones.
      const into = dragged.kind === "entry" || (y > 0.25 && y < 0.75);
      if (into) {
        const p = this.model.parents.get(target.key);
        const list = dragged.kind === "folder" ? p.folders : p.entries;
        return { parent: target.key, index: list.length, el: row, pos: "into" };
      }
    } else if (dragged.kind === "folder") {
      return null; // folders can't sit among entries
    }
    const list = this.model.listOf(target);
    const idx = list.indexOf(target.key);
    const before = y < 0.5;
    return { parent: target.parent, index: before ? idx : idx + 1, el: row, pos: before ? "before" : "after" };
  }

  #onDragOver(ev) {
    const drop = this.#dropTarget(ev);
    this.#clearIndicator();
    if (!drop) return;
    if (this.model.canPlace(this.dragKey, drop.parent)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "move";
    drop.el?.classList.add(`sr-drop-${drop.pos}`);
  }

  #clearIndicator() {
    this.element?.querySelectorAll(".sr-drop-before, .sr-drop-after, .sr-drop-into")
      .forEach(el => el.classList.remove("sr-drop-before", "sr-drop-after", "sr-drop-into"));
  }

  #onDrop(ev) {
    ev.preventDefault();
    const drop = this.#dropTarget(ev);
    this.#clearIndicator();
    const key = this.dragKey;
    this.dragKey = null;
    if (!drop || !key) return;
    if (drop.pos === "into") this.collapsed.delete(drop.parent);
    if (this.model.move(key, drop.parent, drop.index)) this.render();
  }

  /* ---------- Actions ---------- */

  static #onStep(ev, target) {
    if (this.model.step(target.dataset.key, target.dataset.how)) this.render();
  }

  static #onToggle(ev, target) {
    const k = target.dataset.key;
    if (this.collapsed.has(k)) this.collapsed.delete(k); else this.collapsed.add(k);
    this.render();
  }

  static #onSortAlpha(ev, target) {
    this.model.sortAlpha(target.dataset.parent);
    this.render();
  }

  static #onExpandAll() {
    this.collapsed.clear();
    this.render();
  }

  static #onCollapseAll() {
    for (const [k, n] of this.model.nodes) if (n.kind === "folder") this.collapsed.add(k);
    this.render();
  }

  static async #onSave() {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      const undo = await this.model.save();
      if (undo) this.undo = undo;
      ui.notifications.info(t("Saved"));
    } catch (err) {
      console.error(`${MODULE_ID} | save failed`, err);
      ui.notifications.error(t("SaveFailed"));
    } finally {
      this.busy = false;
      this.reload();
    }
  }

  static #onDiscard() {
    this.reload();
  }

  static async #onUndo() {
    if (!this.undo) return;
    const undo = this.undo;
    this.undo = null;
    try {
      await applyUndo(undo);
      ui.notifications.info(t("Undone"));
    } catch (err) {
      console.error(`${MODULE_ID} | undo failed`, err);
      ui.notifications.error(t("SaveFailed"));
    }
    this.reload();
  }

  /** Rebuild from the world, dropping any unsaved edits. */
  reload() {
    this.model.build();
    this.stale = false;
    if (this.rendered) this.render();
  }

  /** Called when the world changes underneath us. */
  worldChanged() {
    if (this.busy) return;
    if (this.model.hasChanges) {
      if (!this.stale) { this.stale = true; this.render(); }
    } else this.reload();
  }

  _onClose(options) {
    super._onClose?.(options);
    SidebarReorder.instances.delete(this.documentName);
  }
}

/* -------------------------------------------- */
/*  Up/down buttons + grip in the sidebar rows  */
/* -------------------------------------------- */

/**
 * Adds ▲ ▼ buttons and a grip to every folder and entry row in a sidebar tab.
 * - ▲ / ▼ move one step within the same folder (Shift = to top / bottom)
 * - hold the grip and slide up/down to move it anywhere within the same folder
 * Moving between folders is left to Foundry's normal drag & drop.
 */
class SidebarRows {
  static ROW_SEL = "[data-folder-id], [data-entry-id], [data-document-id]";
  static busy = false;
  static slide = null;

  static #info(li) {
    if (li.dataset.folderId) return { kind: "folder", key: li.dataset.folderId };
    const key = li.dataset.entryId ?? li.dataset.documentId;
    return key ? { kind: "entry", key } : null;
  }

  static #header(li) {
    return li.querySelector(":scope > header, :scope > .folder-header") ?? li.firstElementChild ?? li;
  }

  static #isVisible(root, kind, key) {
    const li = this.#rowOf(root, kind, key)?.li;
    return !!li && li.offsetParent !== null && getComputedStyle(li).display !== "none";
  }

  /** Remove any leftover slide styling (e.g. if a render happened mid-animation). */
  static clean(root) {
    if (this.slide) return;
    root.querySelectorAll(".sr-shift, .sr-sliding, .sr-settling").forEach(el => {
      el.classList.remove("sr-shift", "sr-sliding", "sr-settling");
      el.style.transform = "";
    });
  }

  static #rowOf(root, kind, key) {
    const li = root.querySelector(kind === "folder" ? `[data-folder-id="${key}"]` : `[data-entry-id="${key}"], [data-document-id="${key}"]`);
    return li ? { li, row: kind === "folder" ? this.#header(li) : li } : null;
  }

  /** Inject controls into any row that doesn't have them yet. */
  static decorate(root, documentName) {
    if (!root.dataset.srRows) {
      root.dataset.srRows = "1";
      // Never let a press on our controls start Foundry's drag.
      root.addEventListener("dragstart", ev => {
        if (this.slide || ev.target.closest?.(".sr-ctl")) { ev.preventDefault(); ev.stopPropagation(); }
      }, true);
    }
    for (const li of root.querySelectorAll(this.ROW_SEL)) {
      if (li.closest(".directory-header, .header-actions")) continue;
      const info = this.#info(li);
      if (!info) continue;
      const host = info.kind === "folder" ? this.#header(li) : li;
      if (host.querySelector(":scope > .sr-ctl")) continue;
      host.classList.add("sr-host", `sr-host-${info.kind}`);
      const ctl = this.#controls(root, documentName, li, info);
      // On folders, sit just left of the "create" icon at the end of the header.
      const last = host.lastElementChild;
      if (info.kind === "folder" && last?.matches("a, button")) host.insertBefore(ctl, last);
      else host.append(ctl);
    }
  }

  /** Re-decorate when Foundry adds rows without a full render (e.g. lazy folder contents). */
  static observe(root, documentName) {
    if (root.srObserver) return;
    const run = foundry.utils.debounce(() => this.decorate(root, documentName), 50);
    root.srObserver = new MutationObserver(muts => {
      if (muts.some(m => [...m.addedNodes].some(n => n.nodeType === 1 && !n.classList?.contains("sr-ctl")))) run();
    });
    root.srObserver.observe(root, { childList: true, subtree: true });
  }

  static #controls(root, documentName, li, info) {
    const ctl = document.createElement("span");
    ctl.className = "sr-ctl";
    ctl.draggable = false;
    ctl.innerHTML = `
      <a class="sr-ctl-btn" data-dir="up"><i class="fa-solid fa-chevron-up"></i></a>
      <a class="sr-ctl-btn" data-dir="down"><i class="fa-solid fa-chevron-down"></i></a>
      <a class="sr-ctl-grip"><i class="fa-solid fa-grip-lines"></i></a>`;
    // Swallow clicks so folders don't toggle and entries don't open.
    for (const type of ["click", "dblclick", "mousedown", "contextmenu"]) {
      ctl.addEventListener(type, ev => { ev.stopPropagation(); if (type !== "mousedown") ev.preventDefault(); });
    }
    for (const btn of ctl.querySelectorAll(".sr-ctl-btn")) {
      btn.addEventListener("click", ev => {
        const dir = btn.dataset.dir;
        if (ev.shiftKey) return this.#apply(documentName, model => model.step(info.key, dir === "up" ? "top" : "bottom"));
        // Step past the next *visible* row, so it behaves while the sidebar search is filtering.
        this.#apply(documentName, model => {
          const node = model.nodes.get(info.key);
          if (!node) return false;
          const list = model.listOf(node);
          const visible = list.filter(k => k === info.key || this.#isVisible(root, info.kind, k));
          const i = visible.indexOf(info.key);
          const neighbour = visible[dir === "up" ? i - 1 : i + 1];
          if (!neighbour) return false;
          const ni = list.indexOf(neighbour);
          return model.move(info.key, node.parent, dir === "up" ? ni : ni + 1);
        });
      });
    }
    ctl.querySelector(".sr-ctl-grip").addEventListener("pointerdown", ev => this.#startSlide(ev, root, documentName, li, info));
    return ctl;
  }

  static async #apply(documentName, mutate) {
    if (this.busy) return;
    const model = new ReorderModel(documentName);
    if (!mutate(model)) return;
    this.busy = true;
    try {
      const undo = await model.save();
      if (undo) LAST_UNDO.set(documentName, undo);
      SidebarReorder.instances.get(documentName)?.reload();
    } catch (err) {
      console.error(`${MODULE_ID} | reorder failed`, err);
      ui.notifications.error(t("SaveFailed"));
    } finally {
      this.busy = false;
    }
  }

  /* ---------- Grip: slide within the same folder ---------- */

  static #startSlide(ev, root, documentName, li, info) {
    if (ev.button !== 0 || this.busy || this.slide) return;
    ev.preventDefault();
    ev.stopPropagation();
    const model = new ReorderModel(documentName);
    const node = model.nodes.get(info.key);
    if (!node) return;

    // All visible rows of the same kind in this folder, in order, measured once.
    const items = model.listOf(node)
      .map(k => ({ key: k, li: this.#rowOf(root, info.kind, k)?.li }))
      .filter(it => it.li && this.#isVisible(root, info.kind, it.key))
      .map(it => {
        const r = it.li.getBoundingClientRect();
        return { ...it, top: r.top, height: r.height };
      });
    const from = items.findIndex(it => it.key === info.key);
    if (from < 0 || items.length < 2) return;
    const gap = Math.max(0, items[1].top - (items[0].top + items[0].height));
    const self = items[from];
    const others = items.filter((_, i) => i !== from);

    const grip = ev.currentTarget;
    grip.setPointerCapture?.(ev.pointerId);
    const scroller = this.#scroller(li);
    li.classList.add("sr-sliding");
    for (const o of others) o.li.classList.add("sr-shift");

    this.slide = {
      documentName, info, li, root, grip, pointerId: ev.pointerId, scroller,
      startY: ev.clientY, startScroll: scroller?.scrollTop ?? 0,
      self, others, from, gap, index: from, lastY: ev.clientY, raf: null
    };

    const move = e => { this.slide.lastY = e.clientY; this.#queue(); };
    const end = e => { cleanup(); this.#endSlide(e.type === "pointerup"); };
    const key = e => { if (e.key === "Escape") { e.preventDefault(); cleanup(); this.#endSlide(false); } };
    const cleanup = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      window.removeEventListener("keydown", key, true);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    window.addEventListener("keydown", key, true);
  }

  static #scroller(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const o = getComputedStyle(p).overflowY;
      if ((o === "auto" || o === "scroll") && p.scrollHeight > p.clientHeight) return p;
    }
    return null;
  }

  /** One update per animation frame; keeps going while auto-scrolling near the edges. */
  static #queue() {
    const s = this.slide;
    if (!s || s.raf) return;
    s.raf = requestAnimationFrame(() => {
      s.raf = null;
      if (this.slide !== s) return;
      let again = false;
      if (s.scroller) {
        const r = s.scroller.getBoundingClientRect();
        const edge = 40;
        let d = 0;
        if (s.lastY < r.top + edge) d = -Math.ceil((r.top + edge - s.lastY) / 4);
        else if (s.lastY > r.bottom - edge) d = Math.ceil((s.lastY - (r.bottom - edge)) / 4);
        if (d) {
          const before = s.scroller.scrollTop;
          s.scroller.scrollTop += d;
          again = s.scroller.scrollTop !== before;
        }
      }
      this.#layout();
      if (again) this.#queue();
    });
  }

  static #layout() {
    const s = this.slide;
    const scrolled = (s.scroller?.scrollTop ?? 0) - s.startScroll;
    // Position in the list's own coordinates (unaffected by scrolling).
    const dy = s.lastY - s.startY + scrolled;
    s.li.style.transform = `translate3d(0, ${dy}px, 0)`;

    // New slot = number of other rows whose middle is above the dragged row's middle.
    const centre = s.self.top + s.self.height / 2 + dy;
    let index = 0;
    for (const o of s.others) if (o.top + o.height / 2 < centre) index++;
    s.index = index;

    const step = s.self.height + s.gap;
    s.others.forEach((o, p) => {
      const k = p < s.from ? p : p + 1;   // original position
      let shift = 0;
      if (k > s.from && p < index) shift = -step;      // dragged moved below it → slide up
      else if (k < s.from && p >= index) shift = step; // dragged moved above it → slide down
      o.li.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : "";
    });
  }

  /** Where the dragged row ends up, relative to where it started. */
  static #restingOffset(s) {
    let off = 0;
    s.others.forEach((o, p) => {
      const k = p < s.from ? p : p + 1;
      if (k > s.from && p < s.index) off += o.height + s.gap;
      else if (k < s.from && p >= s.index) off -= o.height + s.gap;
    });
    return off;
  }

  static #endSlide(commit) {
    const s = this.slide;
    this.slide = null;
    if (!s) return;
    if (s.raf) cancelAnimationFrame(s.raf);
    s.grip.releasePointerCapture?.(s.pointerId);
    const moved = commit && s.index !== s.from;
    const reset = () => {
      s.li.classList.remove("sr-sliding", "sr-settling");
      s.li.style.transform = "";
      for (const o of s.others) { o.li.classList.remove("sr-shift"); o.li.style.transform = ""; }
    };

    // Glide the dragged row into its slot (or back home).
    const target = moved ? this.#restingOffset(s) : 0;
    s.li.classList.add("sr-settling");
    s.li.style.transform = `translate3d(0, ${target}px, 0)`;
    if (!moved) for (const o of s.others) o.li.style.transform = "";

    setTimeout(() => {
      if (!moved) return reset();
      const beforeKey = s.others[s.index]?.key ?? null;
      const lastKey = s.others.at(-1)?.key;
      this.#apply(s.documentName, model => {
        const node = model.nodes.get(s.info.key);
        if (!node) return false;
        const list = model.listOf(node);
        const index = beforeKey ? list.indexOf(beforeKey) : list.indexOf(lastKey) + 1;
        if (index < 0) return false;
        return model.move(s.info.key, node.parent, index);
      }).finally(() => {
        // Usually the sidebar has re-rendered by now; tidy up whatever is left either way.
        reset();
        this.clean(s.root);
      });
    }, 160);
  }
}

/* -------------------------------------------- */
/*  Hooks                                       */
/* -------------------------------------------- */

const SUPPORTED = ["Actor", "Item", "Scene", "JournalEntry", "RollTable", "Cards", "Playlist", "Macro"];

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "rowControls", {
    name: "SR.SettingRows",
    hint: "SR.SettingRowsHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => foundry.utils.debounce(() => window.location.reload(), 100)()
  });
  game.settings.register(MODULE_ID, "showButton", {
    name: "SR.SettingButton",
    hint: "SR.SettingButtonHint",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => { for (const type of SUPPORTED) refreshDirectory(type); }
  });
  game.keybindings.register(MODULE_ID, "undo", {
    name: "SR.KeyUndo",
    hint: "SR.KeyUndoHint",
    editable: [{ key: "KeyZ", modifiers: ["Alt"] }],
    restricted: true,
    onDown: () => { undoLastSidebarChange(); return true; }
  });
  game.modules.get(MODULE_ID).api = {
    open: (documentName = "Scene") => SidebarReorder.open(documentName)
  };
});

// "Reorder" button in each sidebar directory header (GM only).
Hooks.on("renderDocumentDirectory", (app, html) => {
  if (!game.user.isGM) return;
  const documentName = app.documentName ?? app.constructor.documentName;
  if (!SUPPORTED.includes(documentName) || !game.collections.get(documentName)) return;
  const root = html instanceof HTMLElement ? html : html?.[0] ?? app.element;
  if (!root) return;
  if (game.settings.get(MODULE_ID, "rowControls")) {
    SidebarRows.clean(app.element ?? root);
    SidebarRows.decorate(app.element ?? root, documentName);
    SidebarRows.observe(app.element ?? root, documentName);
  }
  if (!game.settings.get(MODULE_ID, "showButton") || root.querySelector(".sr-open")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sr-open";
  btn.dataset.tooltip = t("OpenTip");
  btn.innerHTML = `<i class="fa-solid fa-arrow-down-up-across-line"></i> ${esc(t("OpenButton"))}`;
  btn.addEventListener("click", () => SidebarReorder.open(documentName));
  const container = root.querySelector(".header-actions") ?? root.querySelector(".directory-header");
  container?.append(btn);
});

// Keep open windows in sync with changes made elsewhere.
const notifiers = new Map();
function notify(documentName) {
  if (!SidebarReorder.instances.has(documentName)) return;
  if (!notifiers.has(documentName)) {
    notifiers.set(documentName, foundry.utils.debounce(() => SidebarReorder.instances.get(documentName)?.worldChanged(), 150));
  }
  notifiers.get(documentName)();
}

const RELEVANT = ["name", "folder", "sort", "sorting", "color", "img", "thumb"];
const touches = (changes) => RELEVANT.some(k => k in changes);

for (const type of SUPPORTED) {
  Hooks.on(`create${type}`, () => notify(type));
  Hooks.on(`delete${type}`, () => notify(type));
  Hooks.on(`update${type}`, (doc, changes) => { if (touches(changes)) notify(type); });
}
for (const hook of ["createFolder", "deleteFolder", "updateFolder"]) {
  Hooks.on(hook, (folder, changes) => {
    if (hook === "updateFolder" && !touches(changes)) return;
    if (SUPPORTED.includes(folder.type)) notify(folder.type);
  });
}
Hooks.on("updateSetting", (setting) => {
  if (setting.key !== "core.collectionSortingModes") return;
  for (const type of SUPPORTED) {
    refreshDirectory(type); // every client, so players' sidebars follow too
    notify(type);
  }
});
