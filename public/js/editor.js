/* Éditeur de carte mentale : rendu, interactions, mise en forme, fichiers et synchronisation. */
(function () {
  'use strict';
  const { api, el, toast, modal, confirmBox, promptBox, formatSize } = window.App;
  const M = window.MindOps;

  const PALETTE = ['#FF8672', '#3BD4AE', '#1226AA', '#ECD925', '#FFBE9F', '#A8CF45'];
  const SWATCHES = ['#1226AA', '#FF8672', '#3BD4AE', '#D2EA8E', '#ECD925', '#FFBE9F', '#FFFFFF', '#2B2B2B'];
  const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
  const HGAP = 48, VGAP = 14, ROOT_GAP = 64;

  const $ = (id) => document.getElementById(id);
  const stage = $('stage'), world = $('world'), nodesLayer = $('nodes'), svg = $('links'), panel = $('panel');
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const clientId = M.uid() + M.uid();

  const state = {
    mapId: null, shareToken: null, access: 'view', user: null,
    confirmed: null, version: 0, pending: [], view: null, viewDirty: true,
    info: {}, pos: {}, selected: null, editing: null, pendingEdit: null,
    peers: [], localCollapse: new Map(),
    zoom: 1, panX: 0, panY: 0,
    undo: [], redo: [], offline: false
  };
  const me = { name: 'Invité', color: PALETTE[Math.floor(Math.random() * 3)] };
  const els = new Map();

  const canEdit = () => state.access === 'edit' || state.access === 'owner';
  const headers = () => (state.shareToken ? { 'X-Share-Token': state.shareToken } : {});
  const fileUrl = (id, download) => {
    const q = new URLSearchParams();
    if (state.shareToken) q.set('t', state.shareToken);
    if (download) q.set('download', '1');
    const s = q.toString();
    return '/api/files/' + encodeURIComponent(id) + (s ? '?' + s : '');
  };
  const isImageFile = (f) => IMAGE_TYPES.includes(f.type);

  // ================================================================ Document et synchronisation

  function viewDoc() {
    if (state.viewDirty) {
      const d = clone(state.confirmed);
      state.pending.forEach((p) => M.applyOp(d, p.op));
      state.view = d;
      state.viewDirty = false;
    }
    return state.view;
  }

  function changed() {
    state.viewDirty = true;
    scheduleRender();
  }

  let seq = 0, flushTimer = null, flushing = false, failCount = 0;

  function send(ops) {
    ops.forEach((op) => {
      const o = clone(op);
      o.opId = clientId + '.' + (++seq);
      state.pending.push({ op: o, sent: false });
    });
    changed();
    updateStatus();
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 120);
  }

  async function flush() {
    if (flushing) return;
    const batch = state.pending.filter((p) => !p.sent);
    if (!batch.length) return;
    flushing = true;
    batch.forEach((p) => { p.sent = true; });
    try {
      await api('POST', `/api/maps/${state.mapId}/ops`, { clientId, ops: batch.map((p) => p.op) }, headers());
      failCount = 0;
      state.offline = false;
      poll();
    } catch (e) {
      batch.forEach((p) => { p.sent = false; });
      if (e.status === 403 || e.status === 404) return accessLost();
      failCount++;
      state.offline = true;
      setTimeout(flush, Math.min(15000, 1000 * 2 ** failCount));
    } finally {
      flushing = false;
      updateStatus();
      if (!state.offline && state.pending.some((p) => !p.sent)) flushTimer = setTimeout(flush, 50);
    }
  }

  let pollTimer = null, polling = false, stopped = false;

  async function poll() {
    clearTimeout(pollTimer);
    if (polling || stopped) return;
    polling = true;
    try {
      const q = new URLSearchParams({ since: state.version, client: clientId, name: me.name, color: me.color, sel: state.selected || '' });
      const r = await api('GET', `/api/maps/${state.mapId}/ops?${q}`, undefined, headers());
      let dirty = false;
      if (r.reset) {
        state.confirmed = r.doc;
        if (!flushing) state.pending = state.pending.filter((p) => !p.sent);
        dirty = true;
      } else {
        for (const row of r.ops) {
          M.applyOp(state.confirmed, row.op);
          if (row.c === clientId) {
            const i = state.pending.findIndex((p) => p.op.opId === row.op.opId);
            if (i >= 0) state.pending.splice(i, 1);
          }
          dirty = true;
        }
      }
      state.version = r.version;
      const peers = (r.presence || []).map((p) => ({ client: p.client, name: p.name, color: p.color, sel: p.sel }));
      if (JSON.stringify(peers) !== JSON.stringify(state.peers)) {
        state.peers = peers;
        renderPresence();
        dirty = true;
      }
      if (dirty) changed();
      if (state.offline && !state.pending.some((p) => !p.sent)) state.offline = false;
    } catch (e) {
      if (e.status === 403 || e.status === 404) { polling = false; return accessLost(); }
      state.offline = true;
    } finally {
      polling = false;
      updateStatus();
    }
    pollTimer = setTimeout(poll, document.hidden ? 6000 : 1500);
  }

  function accessLost() {
    stopped = true;
    clearTimeout(pollTimer);
    const l = $('loading') || document.body.appendChild(el('div', { id: 'loading', class: 'loading' }));
    l.replaceChildren(el('div', { style: 'text-align:center' }, [
      el('p', { text: 'Cette carte n\'est plus accessible (lien révoqué ou carte supprimée).' }),
      el('a', { class: 'btn', href: '/', text: 'Retour à l\'accueil' })
    ]));
  }

  function updateStatus() {
    const s = $('sync-status');
    if (state.access === 'view') { s.hidden = true; return; }
    s.className = 'sync hide-sm' + (state.offline ? ' error' : state.pending.length ? ' saving' : '');
    s.textContent = state.offline ? 'Hors ligne, nouvel essai…' : state.pending.length ? 'Enregistrement…' : 'Enregistré';
  }

  // ================================================================ Historique (annuler / rétablir)

  function invert(op, doc) {
    const id = op.type === 'add' ? op.node.id : op.id;
    const n = doc.nodes[id];
    switch (op.type) {
      case 'add': return [{ type: 'delete', id }];
      case 'delete': return n ? M.subtreeIds(doc, id).map((k) => ({ type: 'add', node: clone(doc.nodes[k]) })) : [];
      case 'move': return n ? [{ type: 'move', id, parent: n.parent, order: n.order, side: n.side || null }] : [];
      case 'update': {
        if (!n) return [];
        const patch = {};
        Object.keys(op.patch).forEach((k) => {
          if (k === 'style') {
            patch.style = {};
            Object.keys(op.patch.style).forEach((sk) => { patch.style[sk] = n.style && sk in n.style ? n.style[sk] : null; });
          } else patch[k] = k in n ? clone(n[k]) : null;
        });
        return [{ type: 'update', id, patch }];
      }
    }
    return [];
  }

  function commit(ops) {
    if (!canEdit() || !ops.length) return;
    const tmp = clone(viewDoc());
    let inv = [];
    ops.forEach((op) => { inv = invert(op, tmp).concat(inv); M.applyOp(tmp, op); });
    state.undo.push({ ops: clone(ops), inv });
    if (state.undo.length > 200) state.undo.shift();
    state.redo = [];
    send(ops);
  }

  function undo() {
    const h = state.undo.pop();
    if (!h || !canEdit()) return;
    send(h.inv);
    state.redo.push(h);
  }

  function redo() {
    const h = state.redo.pop();
    if (!h || !canEdit()) return;
    send(h.ops);
    state.undo.push(h);
  }

  // ================================================================ Rendu

  let renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  }

  function isCollapsed(n) {
    if (!canEdit() && state.localCollapse.has(n.id)) return state.localCollapse.get(n.id);
    return !!n.collapsed;
  }

  /** Parcourt l'arbre visible : profondeur, côté, couleur de branche et enfants affichés. */
  function walk(doc) {
    const kidsOf = {};
    Object.values(doc.nodes).forEach((n) => { if (n.parent != null) (kidsOf[n.parent] = kidsOf[n.parent] || []).push(n); });
    Object.values(kidsOf).forEach((a) => a.sort((x, y) => x.order - y.order || (x.id < y.id ? -1 : 1)));
    const info = {}, order = [];
    (function visit(n, depth, branch, side) {
      const kids = kidsOf[n.id] || [];
      const collapsed = depth > 0 && isCollapsed(n);
      info[n.id] = { depth, branch, side, kids: collapsed ? [] : kids.map((k) => k.id), childCount: kids.length, collapsed };
      order.push(n.id);
      if (collapsed) return;
      kids.forEach((k, i) => {
        let s = side, b = branch;
        if (depth === 0) { s = k.side || (i % 2 === 0 ? 'right' : 'left'); b = PALETTE[i % PALETTE.length]; }
        if (k.style && k.style.branch) b = k.style.branch;
        visit(k, depth + 1, b, s);
      });
    })(doc.nodes[doc.rootId], 0, (doc.nodes[doc.rootId].style || {}).branch || '#1226AA', 'right');
    return { info, order };
  }

  function createNodeEl(id) {
    const e = el('div', { class: 'node', 'data-id': id });
    e._text = el('div', { class: 'node-text' });
    e._meta = el('div', { class: 'node-meta' });
    e._col = el('button', { class: 'collapse', type: 'button', title: 'Replier / déplier' });
    e._col.addEventListener('click', (ev) => { ev.stopPropagation(); toggleCollapse(id); });
    e.append(e._text, e._meta, e._col);
    if (canEdit()) {
      const wh = el('span', { class: 'width-handle', title: 'Largeur de la branche (double-clic : automatique)' });
      wh.addEventListener('dblclick', (ev) => { ev.stopPropagation(); commit([{ type: 'update', id, patch: { width: null } }]); });
      e.append(wh);
    }
    e.addEventListener('dblclick', (ev) => { if (!ev.target.closest('a, button, .width-handle')) startEdit(id); });
    return e;
  }

  function defaultShape(depth) {
    return depth === 0 ? null : depth === 1 ? 'rounded' : 'line';
  }

  function updateNodeEl(e, n, inf) {
    const s = n.style || {};
    const editing = state.editing === n.id;
    const sig = JSON.stringify([n.text, s, n.link, n.image, n.attachments, !!n.note, n.width, inf.depth, inf.branch, inf.side, inf.collapsed, inf.childCount, editing]);
    if (e._sig === sig) return;
    e._sig = sig;

    const shape = s.shape || defaultShape(inf.depth);
    e.className = ['node', inf.depth === 0 && 'root', shape && 'shape-' + shape, 'side-' + inf.side, s.size && 'size-' + s.size,
      s.bold && 'bold', s.italic && 'italic', s.underline && 'underline', editing && 'editing'].filter(Boolean).join(' ');
    e.style.setProperty('--branch', inf.branch);
    e.style.background = s.bg || '';
    e.style.color = s.color || '';
    e.style.borderColor = s.border || '';

    // Image
    if (n.image) {
      if (!e._img) {
        e._imgEl = el('img', { class: 'node-img', alt: '', draggable: 'false', title: canEdit() ? 'Glisser vers une autre branche pour déplacer l\'image' : null });
        e._imgEl.addEventListener('load', scheduleRender);
        e._img = el('div', { class: 'node-img-wrap' }, [e._imgEl, canEdit() ? el('span', { class: 'img-handle', title: 'Redimensionner' }) : null]);
        e.insertBefore(e._img, e._text);
      }
      const src = fileUrl(n.image.id);
      if (e._imgEl.getAttribute('src') !== src) e._imgEl.src = src;
      setImageWidth(e, n.image.w || 200);
    } else if (e._img) { e._img.remove(); e._img = e._imgEl = null; e._imgW = 0; }
    e._fixedW = n.width || 0;
    applyWidths(e);

    if (!editing) e._text.textContent = n.text || '';

    // Lien et pièces jointes
    const meta = [];
    const link = n.link && M.safeLink(n.link);
    if (link) {
      let label = link;
      try { label = new URL(link).hostname.replace(/^www\./, '') || link; } catch (err) { /* lien mailto */ }
      meta.push(el('a', { class: 'chip', href: link, target: '_blank', rel: 'noopener noreferrer', title: link }, ['🔗 ', label]));
    }
    if (n.note) meta.push(el('button', { class: 'chip note-chip', type: 'button', title: 'Afficher la note',
      onclick: (ev) => { ev.stopPropagation(); toggleNote(n.id, ev.currentTarget); } }, ['📝 Note']));
    (n.attachments || []).forEach((a) => meta.push(el('a', { class: 'chip', href: fileUrl(a.id, true), title: a.name + ' · ' + formatSize(a.size) }, ['📎 ', a.name])));
    e._meta.replaceChildren(...meta);

    e._col.hidden = inf.depth === 0 || inf.childCount === 0;
    e._col.classList.toggle('closed', inf.collapsed);
    e._col.textContent = inf.collapsed ? '+' + inf.childCount : '−';
  }

  const IMG_MIN = 60, IMG_MAX = 900;

  /**
   * Largeur du nœud : fixée par l'utilisateur (le texte passe à la ligne) ou automatique
   * (jusqu'à 340 px). Dans les deux cas, le nœud s'élargit pour contenir son image.
   */
  function applyWidths(e) {
    const imgW = e._imgW || 0, fixed = e._fixedW || 0;
    if (fixed) { e.style.width = Math.max(fixed, imgW ? imgW + 40 : 0) + 'px'; e.style.maxWidth = 'none'; }
    else { e.style.width = ''; e.style.maxWidth = imgW ? Math.max(340, imgW + 40) + 'px' : ''; }
  }

  function setImageWidth(e, w) {
    e._imgEl.style.width = w + 'px';
    e._imgW = w;
    applyWidths(e);
  }

  /** Aperçu en direct d'une largeur, sans l'enregistrer. */
  function previewWidth(id, w) {
    const nodeEl = els.get(id);
    if (!nodeEl) return;
    nodeEl._fixedW = w;
    applyWidths(nodeEl);
    layout(viewDoc(), state.info);
    drawLinks(viewDoc(), state.info);
  }

  function render() {
    if (!state.confirmed) return;
    const doc = viewDoc();
    const { info, order } = walk(doc);
    state.info = info;

    const seen = new Set(order);
    order.forEach((id) => {
      let e = els.get(id);
      if (!e) { e = createNodeEl(id); els.set(id, e); nodesLayer.append(e); }
      updateNodeEl(e, doc.nodes[id], info[id]);
    });
    for (const [id, e] of els) if (!seen.has(id)) { e.remove(); els.delete(id); }

    if (state.editing && !info[state.editing]) state.editing = null;
    if (state.selected && !info[state.selected]) {
      // Sélection supprimée ou repliée : on remonte au premier ancêtre visible.
      let p = doc.nodes[state.selected] && doc.nodes[state.selected].parent;
      while (p && !info[p]) p = doc.nodes[p] && doc.nodes[p].parent;
      state.selected = p || null;
    }

    layout(doc, info);
    drawLinks(doc, info);
    updateSelectionClasses();
    renderPanel();
    refreshNote(doc);
    updateChrome(doc);

    if (state.pendingEdit && els.get(state.pendingEdit)) {
      const id = state.pendingEdit;
      state.pendingEdit = null;
      ensureVisible(id);
      startEdit(id);
    }
  }

  function layout(doc, info) {
    const size = {};
    for (const id in info) { const e = els.get(id); size[id] = { w: e.offsetWidth, h: e.offsetHeight }; }
    const sub = {};
    const subH = (id) => {
      if (sub[id] != null) return sub[id];
      const k = info[id].kids;
      const t = k.length ? k.reduce((a, c) => a + subH(c), 0) + VGAP * (k.length - 1) : 0;
      return (sub[id] = Math.max(size[id].h, t));
    };
    const pos = {};
    const stack = (kids, side, edgeX, cy) => {
      const total = kids.reduce((a, c) => a + subH(c), 0) + VGAP * (kids.length - 1);
      let y = cy - total / 2;
      kids.forEach((c) => { const sh = subH(c); place(c, side, edgeX, y + sh / 2); y += sh + VGAP; });
    };
    const place = (id, side, edgeX, cy) => {
      const { w, h } = size[id];
      const x = side === 'right' ? edgeX : edgeX - w;
      pos[id] = { x, y: cy - h / 2, w, h, side };
      if (info[id].kids.length) stack(info[id].kids, side, side === 'right' ? x + w + HGAP : x - HGAP, cy);
    };
    const rootId = doc.rootId, r = size[rootId];
    pos[rootId] = { x: -r.w / 2, y: -r.h / 2, w: r.w, h: r.h, side: 'right' };
    ['right', 'left'].forEach((side) => {
      const kids = info[rootId].kids.filter((c) => info[c].side === side);
      if (kids.length) stack(kids, side, side === 'right' ? r.w / 2 + ROOT_GAP : -r.w / 2 - ROOT_GAP, 0);
    });
    for (const id in pos) els.get(id).style.transform = `translate(${Math.round(pos[id].x)}px, ${Math.round(pos[id].y)}px)`;
    state.pos = pos;
  }

  function anchorY(id) {
    const p = state.pos[id];
    return els.get(id).classList.contains('shape-line') ? p.y + p.h - 1 : p.y + p.h / 2;
  }

  function drawLinks(doc, info) {
    const NS = 'http://www.w3.org/2000/svg';
    const frag = document.createDocumentFragment();
    for (const id in state.pos) {
      const n = doc.nodes[id];
      if (n.parent == null) continue;
      const pp = state.pos[n.parent], cp = state.pos[id];
      const fromRoot = n.parent === doc.rootId;
      const sx = fromRoot ? pp.x + pp.w / 2 : (cp.side === 'right' ? pp.x + pp.w : pp.x);
      const sy = fromRoot ? pp.y + pp.h / 2 : anchorY(n.parent);
      const ex = cp.side === 'right' ? cp.x : cp.x + cp.w;
      const ey = anchorY(id);
      const dx = ex - sx;
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', `M${sx},${sy} C${sx + dx * 0.5},${sy} ${ex - dx * 0.5},${ey} ${ex},${ey}`);
      path.setAttribute('stroke', info[id].branch);
      path.setAttribute('stroke-width', info[id].depth === 1 ? 3.5 : info[id].depth === 2 ? 2.5 : 2);
      frag.append(path);
    }
    svg.replaceChildren(frag);
  }

  function updateSelectionClasses() {
    for (const [id, e] of els) {
      e.classList.toggle('selected', id === state.selected);
      e.classList.remove('peer-sel');
      e.querySelectorAll(':scope > .peer').forEach((p) => p.remove());
    }
    state.peers.forEach((p) => {
      const e = p.sel && els.get(p.sel);
      if (!e) return;
      e.classList.add('peer-sel');
      e.style.setProperty('--peer', p.color);
      e.append(el('span', { class: 'peer', style: 'background:' + p.color, text: p.name }));
    });
  }

  function updateChrome(doc) {
    const title = (doc.nodes[doc.rootId].text || 'Sans titre').replace(/\s+/g, ' ');
    $('map-title').textContent = title;
    document.title = title + ' · Worklab Mindmap';
    $('undo').disabled = !state.undo.length;
    $('redo').disabled = !state.redo.length;
  }

  function renderPresence() {
    const seen = new Set();
    $('presence').replaceChildren(...state.peers.filter((p) => !seen.has(p.name) && seen.add(p.name)).slice(0, 8).map((p) =>
      el('span', { class: 'avatar', style: 'background:' + p.color, title: p.name + ' est sur la carte', text: (p.name || '?').trim().charAt(0) || '?' })));
  }

  // ================================================================ Vue (zoom et déplacement)

  function applyTransform() {
    world.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
    $('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
  }

  function setZoom(z, cx, cy) {
    z = Math.min(2.5, Math.max(0.2, z));
    const r = stage.getBoundingClientRect();
    if (cx == null) { cx = r.width / 2; cy = r.height / 2; }
    const wx = (cx - state.panX) / state.zoom, wy = (cy - state.panY) / state.zoom;
    state.zoom = z;
    state.panX = cx - wx * z;
    state.panY = cy - wy * z;
    applyTransform();
  }

  function visibleWidth() {
    const r = stage.getBoundingClientRect();
    return r.width - (!panel.hidden && window.innerWidth > 600 ? 300 : 0);
  }

  function fit(maxZoom) {
    const ps = Object.values(state.pos);
    if (!ps.length) return;
    const minX = Math.min(...ps.map((p) => p.x)), maxX = Math.max(...ps.map((p) => p.x + p.w));
    const minY = Math.min(...ps.map((p) => p.y)), maxY = Math.max(...ps.map((p) => p.y + p.h));
    const r = stage.getBoundingClientRect(), w = visibleWidth(), pad = 50;
    const z = Math.min(maxZoom || 1.2, (w - 2 * pad) / (maxX - minX), (r.height - 2 * pad) / (maxY - minY));
    state.zoom = Math.min(2.5, Math.max(0.2, z));
    state.panX = (w - (maxX - minX) * state.zoom) / 2 - minX * state.zoom;
    state.panY = (r.height - (maxY - minY) * state.zoom) / 2 - minY * state.zoom;
    applyTransform();
  }

  function ensureVisible(id) {
    const p = state.pos[id];
    if (!p) return;
    const r = stage.getBoundingClientRect(), w = visibleWidth(), m = 40;
    const x1 = p.x * state.zoom + state.panX, x2 = (p.x + p.w) * state.zoom + state.panX;
    const y1 = p.y * state.zoom + state.panY, y2 = (p.y + p.h) * state.zoom + state.panY;
    if (x1 < m) state.panX += m - x1; else if (x2 > w - m) state.panX -= x2 - (w - m);
    if (y1 < m) state.panY += m - y1; else if (y2 > r.height - m) state.panY -= y2 - (r.height - m);
    applyTransform();
  }

  // ================================================================ Sélection et édition du texte

  function select(id, silent) {
    if (state.selected === id) return;
    state.selected = id;
    updateSelectionClasses();
    renderPanel();
    if (!silent) { clearTimeout(pollTimer); pollTimer = setTimeout(poll, 300); } // partage la sélection rapidement
  }

  function startEdit(id, initial) {
    if (!canEdit()) return;
    if (!els.get(id)) render();
    const e = els.get(id);
    if (!e) return;
    if (state.editing && state.editing !== id) finishEdit(true);
    select(id, true);
    state.editing = id;
    e.classList.add('editing');
    const t = e._text;
    try { t.contentEditable = 'plaintext-only'; } catch (err) { /* navigateur ancien */ }
    if (t.contentEditable !== 'plaintext-only') t.contentEditable = 'true';
    if (initial != null) t.textContent = initial;
    t.focus();
    const range = document.createRange();
    range.selectNodeContents(t);
    if (initial != null) range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    t.onkeydown = (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); finishEdit(true); }
      else if (ev.key === 'Tab') { ev.preventDefault(); finishEdit(true); addChild(id); }
      else if (ev.key === 'Escape') { ev.preventDefault(); finishEdit(false); }
    };
    t.oninput = () => layout(viewDoc(), state.info) || drawLinks(viewDoc(), state.info);
    t.onblur = () => finishEdit(true);
    t.onpaste = (ev) => {
      ev.preventDefault();
      document.execCommand('insertText', false, (ev.clipboardData || window.clipboardData).getData('text/plain'));
    };
  }

  function finishEdit(save) {
    const id = state.editing;
    if (!id) return;
    state.editing = null;
    const e = els.get(id);
    if (!e) return;
    const t = e._text;
    t.onkeydown = t.oninput = t.onblur = t.onpaste = null;
    t.contentEditable = 'false';
    t.blur();
    const text = t.innerText.replace(/\n+$/, '');
    const n = viewDoc().nodes[id];
    e._sig = null;
    if (save && n && text !== n.text) commit([{ type: 'update', id, patch: { text } }]);
    else changed();
  }

  // ================================================================ Actions sur les nœuds

  function addChild(pid, text, select_) {
    const doc = viewDoc();
    if (!doc.nodes[pid]) return null;
    const kids = M.children(doc, pid);
    const id = M.uid();
    const node = { id, parent: pid, order: kids.length ? kids[kids.length - 1].order + 1 : 1, text: text || '' };
    if (pid === doc.rootId) {
      const right = kids.filter((k) => (k.side || (state.info[k.id] || {}).side) === 'right').length;
      node.side = right <= kids.length - right ? 'right' : 'left';
    }
    const ops = [];
    if (pid !== doc.rootId && isCollapsed(doc.nodes[pid])) ops.push({ type: 'update', id: pid, patch: { collapsed: false } });
    ops.push({ type: 'add', node });
    commit(ops);
    if (select_ !== false) { state.selected = id; state.pendingEdit = id; render(); }
    return id;
  }

  function addSibling(id) {
    const doc = viewDoc();
    const n = doc.nodes[id];
    if (!n || n.parent == null) return addChild(id);
    const sibs = M.children(doc, n.parent);
    const i = sibs.findIndex((s) => s.id === id);
    const nid = M.uid();
    const node = { id: nid, parent: n.parent, order: M.orderBetween(n.order, sibs[i + 1] ? sibs[i + 1].order : null), text: '' };
    if (n.parent === doc.rootId) node.side = n.side || (state.info[id] || {}).side || 'right';
    commit([{ type: 'add', node }]);
    state.selected = nid;
    state.pendingEdit = nid;
    render(); // rendu immédiat : la frappe qui suit doit arriver dans le nouveau nœud
  }

  function removeNode(id) {
    const doc = viewDoc();
    const n = doc.nodes[id];
    if (!n || id === doc.rootId) return;
    const sibs = (state.info[n.parent] || { kids: [] }).kids;
    const i = sibs.indexOf(id);
    state.selected = sibs[i + 1] || sibs[i - 1] || n.parent;
    commit([{ type: 'delete', id }]);
  }

  function toggleCollapse(id) {
    const n = viewDoc().nodes[id];
    if (!n) return;
    if (canEdit()) commit([{ type: 'update', id, patch: { collapsed: !n.collapsed } }]);
    else { state.localCollapse.set(id, !isCollapsed(n)); changed(); }
  }

  function navigate(key) {
    const doc = viewDoc(), inf = state.info, id = state.selected, rootId = doc.rootId;
    if (!inf[id]) return;
    const middle = (k) => k[Math.floor((k.length - 1) / 2)];
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const dir = key === 'ArrowRight' ? 'right' : 'left';
      if (id === rootId) { const k = inf[rootId].kids.filter((c) => inf[c].side === dir); if (k.length) select(middle(k)); }
      else if (inf[id].side === dir) { if (inf[id].kids.length) select(middle(inf[id].kids)); }
      else select(doc.nodes[id].parent);
    } else if (id !== rootId) {
      const parent = doc.nodes[id].parent;
      const sibs = inf[parent].kids.filter((c) => parent !== rootId || inf[c].side === inf[id].side);
      const j = sibs.indexOf(id) + (key === 'ArrowUp' ? -1 : 1);
      if (sibs[j]) select(sibs[j]);
    }
    if (state.selected) ensureVisible(state.selected);
  }

  // ================================================================ Fichiers

  function chooseFile(accept, cb) {
    const inp = $('file-input');
    inp.value = '';
    inp.accept = accept || '';
    inp.onchange = () => { if (inp.files[0]) cb(inp.files[0]); };
    inp.click();
  }

  async function uploadTo(id, file, asImage) {
    if (asImage && !isImageFile(file)) { toast('Format d\'image non pris en charge (PNG, JPG, GIF ou WebP)', true); return; }
    const fd = new FormData();
    fd.append('file', file);
    toast('Envoi de « ' + file.name + ' »…');
    try {
      const r = await api('POST', `/api/maps/${state.mapId}/files`, fd, headers());
      const n = viewDoc().nodes[id];
      if (!n) return;
      if (asImage) commit([{ type: 'update', id, patch: { image: { id: r.id, w: 200 } } }]);
      else commit([{ type: 'update', id, patch: { attachments: (n.attachments || []).concat({ id: r.id, name: r.name, size: r.size, mime: r.mime }) } }]);
      toast(asImage ? 'Image ajoutée' : 'Document joint');
    } catch (e) { toast(e.message, true); }
  }

  async function dropFiles(files, targetId) {
    for (const f of files) {
      let id = targetId;
      if (!id) id = addChild(state.selected || viewDoc().rootId, f.name.replace(/\.[^.]+$/, ''), false);
      const n = viewDoc().nodes[id];
      await uploadTo(id, f, isImageFile(f) && n && !n.image);
    }
  }

  // ================================================================ Notes

  let notePop = null;

  /** Texte de note avec les adresses web rendues cliquables. */
  function noteContent(text) {
    const frag = document.createDocumentFragment();
    String(text).split(/(https?:\/\/[^\s<>"']+)/g).forEach((part, i) => {
      if (i % 2) frag.append(el('a', { href: part, target: '_blank', rel: 'noopener noreferrer', text: part }));
      else if (part) frag.append(part);
    });
    return frag;
  }

  function closeNote() {
    if (notePop) { notePop.remove(); notePop = null; }
  }

  function toggleNote(id, anchor) {
    if (notePop && notePop.dataset.id === id) return closeNote();
    closeNote();
    const n = viewDoc().nodes[id];
    if (!n || !n.note) return;
    notePop = el('div', { class: 'note-pop', 'data-id': id, role: 'dialog', 'aria-label': 'Note' }, [
      el('div', { class: 'note-head' }, [
        el('b', { text: '📝 Note' }),
        el('span', { class: 'spacer' }),
        canEdit() ? el('button', { class: 'btn sm ghost', text: 'Modifier', onclick: () => { closeNote(); select(id); focusNoteField(); } }) : null,
        el('button', { class: 'btn ghost icon', 'aria-label': 'Fermer la note', text: '✕', onclick: closeNote })
      ]),
      el('div', { class: 'note-body' }, noteContent(n.note))
    ]);
    document.body.append(notePop);
    const r = anchor.getBoundingClientRect();
    const w = notePop.offsetWidth, h = notePop.offsetHeight;
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 12) top = Math.max(70, r.top - h - 8);
    notePop.style.left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) + 'px';
    notePop.style.top = top + 'px';
  }

  /** Après une modification (locale ou distante), la bulle suit le contenu de la note. */
  function refreshNote(doc) {
    if (!notePop) return;
    const n = doc.nodes[notePop.dataset.id];
    if (!n || !n.note || !state.info[n.id]) return closeNote();
    const body = notePop.querySelector('.note-body');
    if (body.textContent !== n.note) body.replaceChildren(noteContent(n.note));
  }

  function focusNoteField() {
    const f = panel.querySelector('.note-field');
    if (f) { f.scrollIntoView({ block: 'center' }); f.focus(); }
  }

  document.addEventListener('pointerdown', (e) => {
    if (notePop && !e.target.closest('.note-pop, .note-chip')) closeNote();
  });

  // ================================================================ Panneau de mise en forme

  function renderPanel() {
    const doc = viewDoc();
    const id = state.selected;
    const n = id && doc.nodes[id];
    if (!n || !canEdit()) { panel.hidden = true; panel._sig = null; return; }
    const inf = state.info[id] || {};
    const sig = id + JSON.stringify(n) + inf.branch;
    if (panel._sig === sig && !panel.hidden) return;
    // Saisie en cours dans le panneau : on attend qu'elle se termine pour ne rien effacer.
    if (panel._id === id && !panel.hidden && panel.contains(document.activeElement) && document.activeElement.matches('input, textarea')) { panel._stale = true; return; }
    panel._id = id;
    panel._stale = false;
    panel._sig = sig;
    panel.hidden = false;

    const s = n.style || {};
    const isRoot = id === doc.rootId;
    const setStyle = (patch) => commit([{ type: 'update', id, patch: { style: patch } }]);
    const toggle = (k, title, label, css) => el('button', { class: s[k] ? 'on' : '', title, style: css, text: label, onclick: () => setStyle({ [k]: !s[k] }) });
    const seg = (key, options, current) => el('div', { class: 'seg' }, options.map(([v, label]) =>
      el('button', { class: current === v ? 'on' : '', text: label, onclick: () => setStyle({ [key]: v }) })));
    const swatches = (key, current) => el('div', { class: 'swatches' }, [
      el('button', { class: 'swatch auto' + (!current ? ' on' : ''), title: 'Automatique', 'aria-label': 'Automatique', onclick: () => setStyle({ [key]: null }) }),
      ...SWATCHES.map((c) => el('button', {
        class: 'swatch' + (current && current.toLowerCase() === c.toLowerCase() ? ' on' : ''), style: 'background:' + c, title: c, 'aria-label': c,
        onclick: () => setStyle({ [key]: c })
      })),
      el('label', { class: 'swatch custom', title: 'Autre couleur' }, el('input', {
        type: 'color', value: /^#[0-9a-f]{6}$/i.test(current || '') ? current : '#1226aa', onchange: (e) => setStyle({ [key]: e.target.value })
      }))
    ]);

    const linkInput = el('input', { type: 'text', placeholder: 'https://…', value: n.link || '', 'aria-label': 'Adresse du lien' });
    const linkForm = el('form', { class: 'link-row' }, [linkInput, el('button', { class: 'btn sm', type: 'submit', text: 'OK' })]);
    linkForm.onsubmit = (e) => {
      e.preventDefault();
      const v = linkInput.value.trim();
      if (v && !M.safeLink(v)) return toast('Adresse invalide', true);
      commit([{ type: 'update', id, patch: { link: v || null } }]);
      if (v) toast('Lien ajouté');
    };

    const nodeEl = els.get(id);
    const curW = n.width || (nodeEl ? nodeEl.offsetWidth : 160);
    const widthLabel = el('span', { class: 'width-label', text: n.width ? n.width + ' px' : 'Auto' });
    const widthRange = el('input', { type: 'range', min: M.WIDTH_MIN, max: 800, step: 10, value: Math.min(800, curW), 'aria-label': 'Largeur de la branche' });
    widthRange.addEventListener('input', () => { widthLabel.textContent = widthRange.value + ' px'; previewWidth(id, Number(widthRange.value)); });
    widthRange.addEventListener('change', () => { commit([{ type: 'update', id, patch: { width: Number(widthRange.value) } }]); widthRange.blur(); });
    const widthRow = el('div', { class: 'row width-row' }, [
      widthRange, widthLabel,
      el('button', { class: 'btn sm' + (n.width ? '' : ' on-auto'), text: 'Auto', title: 'Largeur automatique selon le texte', onclick: () => commit([{ type: 'update', id, patch: { width: null } }]) })
    ]);

    const noteField = el('textarea', { class: 'note-field', rows: 4, placeholder: 'Ajoutez une note : elle s\'affichera en cliquant sur l\'icône 📝 de la branche.', 'aria-label': 'Note' });
    noteField.value = n.note || '';
    noteField.addEventListener('change', () => {
      const v = noteField.value.replace(/\s+$/, '');
      if (v !== (n.note || '')) commit([{ type: 'update', id, patch: { note: v || null } }]);
    });
    noteField.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) noteField.blur(); });

    const imgSection = n.image
      ? [el('div', { class: 'row' }, [
          el('div', { class: 'seg' }, [[120, 'Petite'], [200, 'Moyenne'], [320, 'Grande']].map(([w, label]) =>
            el('button', { class: (n.image.w || 200) === w ? 'on' : '', text: label, onclick: () => commit([{ type: 'update', id, patch: { image: Object.assign({}, n.image, { w }) } }]) }))),
        ]),
        el('p', { class: 'muted small', style: 'margin:6px 0', text: 'Tirez le coin de l\'image pour la redimensionner, ou glissez l\'image sur une autre branche pour la déplacer.' }),
        el('div', { class: 'row', style: 'margin-top:6px' }, [
          el('button', { class: 'btn sm', text: 'Remplacer', onclick: () => chooseFile('image/*', (f) => uploadTo(id, f, true)) }),
          el('button', { class: 'btn sm danger', text: 'Retirer', onclick: () => commit([{ type: 'update', id, patch: { image: null } }]) })
        ])]
      : [el('button', { class: 'btn sm', text: '+ Ajouter une image', onclick: () => chooseFile('image/png,image/jpeg,image/gif,image/webp', (f) => uploadTo(id, f, true)) })];

    const files = (n.attachments || []).map((a) => el('div', { class: 'file-item' }, [
      el('span', { text: '📎' }),
      el('a', { href: fileUrl(a.id, true), title: a.name, text: a.name }),
      el('span', { class: 'muted small', text: formatSize(a.size) }),
      el('button', { title: 'Retirer', 'aria-label': 'Retirer ' + a.name, text: '✕', onclick: () =>
        commit([{ type: 'update', id, patch: { attachments: n.attachments.filter((x) => x.id !== a.id) } }]) })
    ]));

    panel.replaceChildren(...[
      el('button', { class: 'btn ghost icon close', title: 'Fermer', 'aria-label': 'Fermer le panneau', text: '✕', onclick: () => select(null) }),
      el('h3', { text: 'Branche' }),
      el('div', { class: 'actions' }, [
        el('button', { class: 'btn', text: '+ Sous-branche', title: 'Tab', onclick: () => addChild(id) }),
        isRoot ? null : el('button', { class: 'btn', text: '+ Branche sœur', title: 'Entrée', onclick: () => addSibling(id) }),
        el('button', { class: 'btn', text: 'Modifier le texte', onclick: () => startEdit(id) }),
        isRoot ? null : el('button', { class: 'btn danger', text: 'Supprimer', title: 'Suppr', onclick: () => removeNode(id) })
      ]),

      el('h3', { text: 'Texte' }),
      el('div', { class: 'row' }, [
        el('div', { class: 'seg' }, [toggle('bold', 'Gras', 'G', 'font-weight:900'), toggle('italic', 'Italique', 'I', 'font-style:italic'), toggle('underline', 'Souligné', 'S', 'text-decoration:underline')]),
        seg('size', [['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']], s.size || (isRoot ? null : 'm'))
      ]),
      el('h3', { text: 'Couleur du texte' }), swatches('color', s.color),

      el('h3', { text: 'Forme' }),
      seg('shape', [['rounded', 'Arrondi'], ['rect', 'Carré'], ['pill', 'Pilule']].concat(isRoot ? [] : [['line', 'Souligné']]), s.shape || defaultShape(inf.depth)),
      el('h3', { text: 'Largeur' }), widthRow,
      el('h3', { text: 'Fond' }), swatches('bg', s.bg),
      el('h3', { text: 'Bordure' }), swatches('border', s.border),
      isRoot ? null : el('h3', { text: 'Couleur de la branche' }),
      isRoot ? null : swatches('branch', s.branch),

      el('h3', { text: 'Lien' }), linkForm,
      n.link ? el('div', { class: 'row', style: 'margin-top:6px' }, [
        el('a', { class: 'btn sm', href: M.safeLink(n.link), target: '_blank', rel: 'noopener noreferrer', text: 'Ouvrir ↗' }),
        el('button', { class: 'btn sm danger', text: 'Retirer', onclick: () => commit([{ type: 'update', id, patch: { link: null } }]) })
      ]) : null,

      el('h3', { text: 'Note' }), noteField,

      el('h3', { text: 'Image' }), ...imgSection,

      el('h3', { text: 'Documents' }),
      files.length ? el('div', { class: 'file-list' }, files) : null,
      el('button', { class: 'btn sm', text: '+ Joindre un document', onclick: () => chooseFile('', (f) => uploadTo(id, f, false)) }),

      el('h3', { text: ' ' }),
      el('button', { class: 'btn sm ghost', text: 'Réinitialiser la mise en forme', onclick: () => {
        const reset = {};
        M.STYLE_KEYS.forEach((k) => { reset[k] = null; });
        setStyle(reset);
      } })
    ].filter(Boolean));
  }

  // Après un clic dans le panneau, on rend la main aux raccourcis clavier de la carte.
  panel.addEventListener('focusout', () => setTimeout(() => { if (panel._stale) { panel._sig = null; renderPanel(); } }, 0));
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) b.blur();
  });

  // ================================================================ Partage

  async function openShare() {
    const list = el('div', { class: 'share-list' });
    const copy = (url) => navigator.clipboard.writeText(url).then(() => toast('Lien copié'), () => toast('Copiez le lien manuellement', true));
    const refresh = async () => {
      const { links } = await api('GET', `/api/maps/${state.mapId}/shares`);
      list.replaceChildren(...(links.length ? links.map((l) => {
        const url = location.origin + '/s/' + l.token;
        return el('div', { class: 'share-item' }, [
          el('span', { class: 'badge' + (l.permission === 'edit' ? ' edit' : ''), text: l.permission === 'edit' ? 'Modification' : 'Lecture seule' }),
          el('input', { type: 'text', readonly: true, value: url, onfocus: (e) => e.target.select() }),
          el('button', { class: 'btn sm', text: 'Copier', onclick: () => copy(url) }),
          el('button', { class: 'btn sm danger', text: 'Révoquer', title: 'Désactiver ce lien', onclick: async () => {
            if (!(await confirmBox('Désactiver ce lien ? Les personnes qui l\'utilisent perdront l\'accès.', 'Désactiver'))) return;
            await api('DELETE', `/api/maps/${state.mapId}/shares/${l.id}`);
            refresh();
          } })
        ]);
      }) : [el('p', { class: 'muted small', text: 'Aucun lien actif pour le moment.' })]));
    };
    const create = async (permission) => {
      const r = await api('POST', `/api/maps/${state.mapId}/shares`, { permission });
      await refresh();
      copy(location.origin + '/s/' + r.token);
    };
    const m = modal(el('div', null, [
      el('h2', { text: 'Partager la carte' }),
      el('p', { class: 'muted small', text: 'Toute personne disposant du lien peut ouvrir la carte, sans créer de compte. Vous pouvez révoquer un lien à tout moment.' }),
      el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, [
        el('button', { class: 'btn', text: '+ Lien en lecture seule', onclick: () => create('view') }),
        el('button', { class: 'btn primary', text: '+ Lien de modification', onclick: () => create('edit') })
      ]),
      list,
      el('div', { class: 'row' }, el('button', { class: 'btn', text: 'Fermer', onclick: () => m.close() }))
    ]));
    refresh().catch((e) => toast(e.message, true));
  }

  // ================================================================ Évènements

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('a, button')) return;
    const nodeEl = e.target.closest('.node');
    if (nodeEl) {
      const id = nodeEl.dataset.id;
      if (state.editing === id) return;
      if (state.editing) finishEdit(true);
      select(id);
      if (!canEdit()) return;
      if (e.target.closest('.width-handle')) return beginWidthResize(e, id);
      if (e.target.closest('.img-handle')) return beginImageResize(e, id);
      if (e.target.closest('.node-img')) return beginImageDrag(e, id);
      if (id !== viewDoc().rootId) beginDrag(e, id);
      return;
    }
    if (state.editing) finishEdit(true);
    select(null);
    beginPan(e);
  });

  function beginPan(e) {
    const sx = e.clientX, sy = e.clientY, px = state.panX, py = state.panY;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('panning');
    const move = (ev) => { state.panX = px + ev.clientX - sx; state.panY = py + ev.clientY - sy; applyTransform(); };
    const up = () => {
      stage.classList.remove('panning');
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerup', up);
      stage.removeEventListener('pointercancel', up);
    };
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);
  }

  /** Suit le pointeur jusqu'au relâchement (move reçoit l'évènement, up reçoit l'évènement final). */
  function track(move, up) {
    const end = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      up(ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  function beginWidthResize(e, id) {
    e.preventDefault();
    const nodeEl = els.get(id);
    const startW = nodeEl.offsetWidth, sx = e.clientX;
    // Sur une branche à gauche, la poignée est à gauche : tirer vers la gauche élargit.
    const dir = id !== viewDoc().rootId && state.info[id] && state.info[id].side === 'left' ? -1 : 1;
    let w = startW;
    nodeEl.classList.add('resizing');
    track((ev) => {
      w = Math.round(Math.min(M.WIDTH_MAX, Math.max(M.WIDTH_MIN, startW + dir * (ev.clientX - sx) / state.zoom)));
      previewWidth(id, w);
    }, (ev) => {
      nodeEl.classList.remove('resizing');
      if (ev.type === 'pointerup' && Math.abs(w - startW) > 1) commit([{ type: 'update', id, patch: { width: w } }]);
      else { nodeEl._sig = null; changed(); }
    });
  }

  function beginImageResize(e, id) {
    e.preventDefault();
    const nodeEl = els.get(id);
    const image = viewDoc().nodes[id].image;
    const startW = nodeEl._imgEl.offsetWidth, sx = e.clientX;
    // Sur une branche à gauche, la poignée est à gauche : tirer vers la gauche agrandit.
    const dir = state.info[id] && state.info[id].side === 'left' ? -1 : 1;
    let w = startW;
    nodeEl.classList.add('resizing');
    track((ev) => {
      w = Math.round(Math.min(IMG_MAX, Math.max(IMG_MIN, startW + dir * (ev.clientX - sx) / state.zoom)));
      setImageWidth(nodeEl, w);
      layout(viewDoc(), state.info);
      drawLinks(viewDoc(), state.info);
    }, (ev) => {
      nodeEl.classList.remove('resizing');
      if (ev.type === 'pointerup' && w !== (image.w || 200)) commit([{ type: 'update', id, patch: { image: Object.assign({}, image, { w }) } }]);
      else { nodeEl._sig = null; changed(); }
    });
  }

  function beginImageDrag(e, id) {
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const src = els.get(id)._imgEl;
    let ghost = null, target = null;
    const clearDrop = () => document.querySelectorAll('.drop-child').forEach((n) => n.classList.remove('drop-child'));
    track((ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        ghost = el('img', { class: 'drag-ghost img-ghost', src: src.src, alt: '' });
        ghost.style.width = Math.min(160, src.offsetWidth * state.zoom) + 'px';
        document.body.append(ghost);
        src.classList.add('dragging');
      }
      ghost.style.left = ev.clientX + 10 + 'px';
      ghost.style.top = ev.clientY + 10 + 'px';
      clearDrop();
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const tEl = under && under.closest('#nodes .node');
      target = tEl && tEl.dataset.id !== id ? tEl.dataset.id : null;
      if (target) tEl.classList.add('drop-child');
    }, (ev) => {
      if (!ghost) return;
      ghost.remove();
      src.classList.remove('dragging');
      clearDrop();
      if (ev.type !== 'pointerup' || !target) return;
      const doc = viewDoc();
      const moved = doc.nodes[id].image, existing = doc.nodes[target].image;
      // Si la branche cible a déjà une image, les deux images sont échangées.
      commit([
        { type: 'update', id: target, patch: { image: moved } },
        { type: 'update', id, patch: { image: existing || null } }
      ]);
      select(target);
      toast(existing ? 'Images échangées' : 'Image déplacée');
    });
  }

  function beginDrag(e, id) {
    const sx = e.clientX, sy = e.clientY, src = els.get(id);
    const doc = viewDoc();
    const forbidden = new Set(M.subtreeIds(doc, id));
    let ghost = null, target = null, mode = null;
    const clearDrop = () => document.querySelectorAll('.drop-child, .drop-before, .drop-after').forEach((n) => n.classList.remove('drop-child', 'drop-before', 'drop-after'));
    const move = (ev) => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 6) return;
        ghost = src.cloneNode(true);
        ghost.className += ' drag-ghost';
        ghost.classList.remove('selected', 'peer-sel');
        ghost.style.transform = `scale(${state.zoom})`;
        document.body.append(ghost);
        src.classList.add('dragging');
      }
      ghost.style.left = ev.clientX + 10 + 'px';
      ghost.style.top = ev.clientY + 10 + 'px';
      clearDrop();
      const under = document.elementFromPoint(ev.clientX, ev.clientY);
      const tEl = under && under.closest('#nodes .node');
      target = null;
      mode = null;
      if (tEl && !forbidden.has(tEl.dataset.id)) {
        target = tEl.dataset.id;
        const r = tEl.getBoundingClientRect(), rel = (ev.clientY - r.top) / r.height;
        mode = target === doc.rootId ? 'child' : rel < 0.25 ? 'before' : rel > 0.75 ? 'after' : 'child';
        tEl.classList.add('drop-' + mode);
      } else if (doc.nodes[id].parent === doc.rootId) mode = 'side';
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (!ghost) return;
      ghost.remove();
      src.classList.remove('dragging');
      clearDrop();
      if (mode && ev.type === 'pointerup') dropNode(id, target, mode, ev);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  function dropNode(id, target, mode, ev) {
    const doc = viewDoc(), n = doc.nodes[id], rootId = doc.rootId;
    const r = stage.getBoundingClientRect();
    const sideAt = (ev.clientX - r.left - state.panX) / state.zoom < 0 ? 'left' : 'right';
    const ops = [];
    if (mode === 'side') {
      if (sideAt === state.info[id].side) return;
      ops.push({ type: 'move', id, parent: rootId, order: n.order, side: sideAt });
    } else if (mode === 'child') {
      const kids = M.children(doc, target).filter((k) => k.id !== id);
      if (target !== rootId && isCollapsed(doc.nodes[target])) ops.push({ type: 'update', id: target, patch: { collapsed: false } });
      ops.push({ type: 'move', id, parent: target, order: kids.length ? kids[kids.length - 1].order + 1 : 1, side: target === rootId ? sideAt : null });
    } else {
      const t = doc.nodes[target];
      const sibs = M.children(doc, t.parent).filter((s) => s.id !== id);
      const i = sibs.findIndex((s) => s.id === target);
      const order = mode === 'before'
        ? M.orderBetween(i > 0 ? sibs[i - 1].order : null, t.order)
        : M.orderBetween(t.order, i < sibs.length - 1 ? sibs[i + 1].order : null);
      ops.push({ type: 'move', id, parent: t.parent, order, side: t.parent === rootId ? state.info[target].side : null });
    }
    commit(ops);
  }

  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    closeNote();
    const r = stage.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey) setZoom(state.zoom * Math.exp(-e.deltaY * 0.01), e.clientX - r.left, e.clientY - r.top);
    else { state.panX -= e.deltaX; state.panY -= e.deltaY; applyTransform(); }
  }, { passive: false });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && notePop) { closeNote(); return; }
    if (state.editing || !state.confirmed) return;
    if (e.target.closest && e.target.closest('input, textarea, select, .modal-back, #panel')) return;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key.toLowerCase();
    if (mod && key === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
    if (mod && key === 'y') { e.preventDefault(); return redo(); }
    if (mod && (key === '=' || key === '+')) { e.preventDefault(); return setZoom(state.zoom * 1.2); }
    if (mod && key === '-') { e.preventDefault(); return setZoom(state.zoom / 1.2); }
    if (mod && key === '0') { e.preventDefault(); return fit(); }
    const doc = viewDoc(), id = state.selected;
    if (!id) {
      if (['Tab', 'Enter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); select(doc.rootId); }
      return;
    }
    switch (e.key) {
      case 'Tab': e.preventDefault(); if (canEdit()) addChild(id); break;
      case 'Enter': e.preventDefault(); if (canEdit()) (id === doc.rootId ? addChild(id) : addSibling(id)); break;
      case 'F2': case ' ': e.preventDefault(); startEdit(id); break;
      case 'Delete': case 'Backspace': e.preventDefault(); if (canEdit()) removeNode(id); break;
      case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight': e.preventDefault(); navigate(e.key); break;
      case 'Escape': select(null); break;
      default:
        // Taper directement remplace le texte du nœud sélectionné.
        if (canEdit() && e.key.length === 1 && !mod && !e.altKey) { e.preventDefault(); startEdit(id, e.key); }
    }
  });

  document.addEventListener('paste', (e) => {
    if (state.editing || !canEdit() || !state.selected) return;
    if (e.target.closest && e.target.closest('input, textarea, .modal-back')) return;
    const file = Array.from((e.clipboardData && e.clipboardData.files) || [])[0];
    if (file) { e.preventDefault(); uploadTo(state.selected, file, isImageFile(file)); return; }
    // Coller une liste : chaque ligne devient une sous-branche.
    const lines = (e.clipboardData.getData('text/plain') || '').split(/\r?\n/).map((l) => l.replace(/^\s*([-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean).slice(0, 200);
    if (!lines.length) return;
    e.preventDefault();
    const doc = viewDoc();
    const kids = M.children(doc, state.selected);
    let order = kids.length ? kids[kids.length - 1].order : 0;
    const ops = lines.map((text) => {
      const node = { id: M.uid(), parent: state.selected, order: ++order, text };
      if (state.selected === doc.rootId) node.side = order % 2 ? 'right' : 'left';
      return { type: 'add', node };
    });
    commit(ops);
    toast(lines.length + ' branche(s) ajoutée(s)');
  });

  // Fichiers glissés depuis l'ordinateur
  let dragDepth = 0;
  const overlay = el('div', { class: 'drop-overlay', hidden: true });
  document.body.append(overlay);
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  stage.addEventListener('dragenter', (e) => { if (canEdit() && hasFiles(e)) { dragDepth++; overlay.hidden = false; } });
  stage.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; overlay.hidden = true; } });
  stage.addEventListener('dragover', (e) => { if (canEdit() && hasFiles(e)) e.preventDefault(); });
  stage.addEventListener('drop', (e) => {
    if (!canEdit() || !hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const tEl = under && under.closest('#nodes .node');
    dropFiles(Array.from(e.dataTransfer.files), tEl ? tEl.dataset.id : null);
  });

  $('zoom-in').onclick = () => setZoom(state.zoom * 1.2);
  $('zoom-out').onclick = () => setZoom(state.zoom / 1.2);
  $('zoom-fit').onclick = () => fit();
  $('undo').onclick = undo;
  $('redo').onclick = redo;
  $('share-btn').onclick = openShare;

  // ---------------------------------------------------------------- Export
  const exportList = document.querySelector('#export-menu .menu-list');
  $('export-btn').onclick = (e) => { e.stopPropagation(); exportList.hidden = !exportList.hidden; };
  document.addEventListener('click', () => { exportList.hidden = true; });
  let exporting = false;
  exportList.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-export]');
    if (!b || exporting) return;
    exportList.hidden = true;
    if (state.editing) finishEdit(true);
    exporting = true;
    $('export-btn').disabled = true;
    toast('Préparation de l\'export…');
    try {
      render();
      const doc = viewDoc();
      await window.MindExport[b.dataset.export]({
        doc, pos: state.pos, nodesLayer, svg, fileUrl,
        title: (doc.nodes[doc.rootId].text || 'Carte').replace(/\s+/g, ' ').trim()
      });
      toast('Export terminé');
    } catch (err) {
      console.error(err);
      toast('L\'export a échoué : ' + err.message, true);
    } finally {
      exporting = false;
      $('export-btn').disabled = false;
    }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  window.addEventListener('beforeunload', (e) => {
    if (state.editing) finishEdit(true);
    if (state.pending.length) { flush(); e.preventDefault(); e.returnValue = ''; }
  });
  window.addEventListener('resize', scheduleRender);

  // ================================================================ Démarrage

  async function guestName() {
    let name = '';
    try { name = localStorage.getItem('mm_guest_name') || ''; } catch (e) { /* stockage indisponible */ }
    if (!name) {
      name = (await promptBox('Comment vous appelez-vous ? (visible par les autres participants)', '', 'Rejoindre la carte')) || 'Invité';
      try { localStorage.setItem('mm_guest_name', name); } catch (e) { /* stockage indisponible */ }
    }
    return name.slice(0, 60);
  }

  function fatal(msg) {
    $('loading').replaceChildren(el('div', { style: 'text-align:center' }, [el('p', { text: msg }), el('a', { class: 'btn', href: '/', text: 'Retour à l\'accueil' })]));
  }

  async function init() {
    const parts = location.pathname.split('/');
    const meRes = await api('GET', '/api/auth/me').catch(() => ({ user: null }));
    state.user = meRes.user;

    if (parts[1] === 's') {
      state.shareToken = decodeURIComponent(parts[2] || '');
      try { state.mapId = (await api('GET', '/api/share/' + encodeURIComponent(state.shareToken))).mapId; }
      catch (e) { return fatal(e.message); }
    } else state.mapId = decodeURIComponent(parts[2] || '');

    let data;
    try { data = await api('GET', '/api/maps/' + encodeURIComponent(state.mapId), undefined, headers()); }
    catch (e) {
      if (!state.user && !state.shareToken) { location.href = '/login?next=' + encodeURIComponent(location.pathname); return; }
      return fatal(e.status === 404 ? 'Cette carte n\'existe pas ou a été supprimée.' : 'Vous n\'avez pas accès à cette carte.');
    }

    state.access = data.access;
    state.confirmed = data.doc;
    state.version = data.version;
    me.name = state.user ? state.user.name : await guestName();
    try {
      const c = localStorage.getItem('mm_color');
      if (c) me.color = c; else localStorage.setItem('mm_color', me.color);
    } catch (e) { /* stockage indisponible */ }

    $('back').hidden = !state.user;
    $('share-btn').hidden = state.access !== 'owner';
    if (!canEdit()) {
      $('undo').hidden = $('redo').hidden = true;
      $('hint').hidden = true;
      $('mode-badge').hidden = false;
      $('mode-badge').textContent = 'Lecture seule';
    } else if (state.access === 'edit') {
      $('mode-badge').hidden = false;
      $('mode-badge').className = 'badge edit hide-sm';
      $('mode-badge').textContent = 'Invité · modification';
    }
    updateStatus();
    $('loading').remove();

    render();
    const r = stage.getBoundingClientRect();
    state.panX = r.width / 2;
    state.panY = r.height / 2;
    applyTransform();
    if (Object.keys(state.pos).length > 1) fit(1);
    if (canEdit() && Object.keys(viewDoc().nodes).length === 1) select(viewDoc().rootId);
    poll();
  }

  init().catch((e) => { console.error(e); fatal('Impossible de charger la carte.'); });
})();
