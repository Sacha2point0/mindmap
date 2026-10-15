/*
 * Modèle de données de la carte et opérations d'édition.
 * Fichier partagé : chargé par le navigateur (window.MindOps) et par le serveur (require).
 *
 * Document : { rootId, nodes: { [id]: Node } }
 * Node : { id, parent, order, text, side, collapsed, style, link, image, attachments }
 */
(function (root) {
  'use strict';

  var MAX_TEXT = 5000;
  var STYLE_KEYS = ['color', 'bg', 'border', 'branch', 'bold', 'italic', 'underline', 'size', 'shape', 'align'];
  var NODE_KEYS = ['text', 'side', 'collapsed', 'style', 'link', 'image', 'attachments', 'note'];

  function newDoc(title) {
    return {
      rootId: 'root',
      nodes: {
        root: { id: 'root', parent: null, order: 0, text: title || 'Idée centrale', style: {} }
      }
    };
  }

  function uid() {
    var s = '';
    for (var i = 0; i < 12; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36));
    return s;
  }

  function safeLink(url) {
    if (typeof url !== 'string') return null;
    url = url.trim();
    if (!url) return null;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = 'https://' + url;
    return /^(https?:|mailto:)/i.test(url) ? url.slice(0, 2000) : null;
  }

  function cleanStyle(style, base) {
    var out = Object.assign({}, base || {});
    if (!style || typeof style !== 'object') return out;
    STYLE_KEYS.forEach(function (k) {
      if (!(k in style)) return;
      var v = style[k];
      if (v === null || v === '' || v === false) delete out[k];
      else if (typeof v === 'string') out[k] = v.slice(0, 40);
      else if (typeof v === 'boolean' || typeof v === 'number') out[k] = v;
    });
    return out;
  }

  function cleanAttachments(list) {
    if (!Array.isArray(list)) return [];
    return list.slice(0, 50).filter(function (a) { return a && typeof a.id === 'string'; }).map(function (a) {
      return { id: a.id.slice(0, 40), name: String(a.name || 'fichier').slice(0, 255), size: Number(a.size) || 0, mime: String(a.mime || '').slice(0, 120) };
    });
  }

  function cleanImage(img) {
    if (!img || typeof img.id !== 'string') return null;
    return { id: img.id.slice(0, 40), w: Number(img.w) || 0, h: Number(img.h) || 0 };
  }

  function setField(n, k, v) {
    switch (k) {
      case 'text': n.text = String(v == null ? '' : v).slice(0, MAX_TEXT); break;
      case 'note': if (v) n.note = String(v).slice(0, 20000); else delete n.note; break;
      case 'side': if (v === 'left' || v === 'right') n.side = v; else delete n.side; break;
      case 'collapsed': if (v) n.collapsed = true; else delete n.collapsed; break;
      case 'style': n.style = cleanStyle(v, n.style); break;
      case 'link': var l = safeLink(v); if (l) n.link = l; else delete n.link; break;
      case 'image': var im = cleanImage(v); if (im) n.image = im; else delete n.image; break;
      case 'attachments': var at = cleanAttachments(v); if (at.length) n.attachments = at; else delete n.attachments; break;
    }
  }

  function subtreeIds(doc, id) {
    var ids = [id];
    var byParent = {};
    Object.keys(doc.nodes).forEach(function (k) {
      var p = doc.nodes[k].parent;
      (byParent[p] = byParent[p] || []).push(k);
    });
    for (var i = 0; i < ids.length; i++) (byParent[ids[i]] || []).forEach(function (c) { ids.push(c); });
    return ids;
  }

  function children(doc, id) {
    return Object.keys(doc.nodes)
      .map(function (k) { return doc.nodes[k]; })
      .filter(function (n) { return n.parent === id; })
      .sort(function (a, b) { return a.order - b.order || (a.id < b.id ? -1 : 1); });
  }

  /** Applique une opération en place. Renvoie true si le document a changé. */
  function applyOp(doc, op) {
    if (!op || typeof op !== 'object') return false;
    var nodes = doc.nodes;
    switch (op.type) {
      case 'add': {
        var src = op.node;
        if (!src || typeof src.id !== 'string' || nodes[src.id] || !nodes[src.parent]) return false;
        var n = { id: src.id.slice(0, 40), parent: src.parent, order: Number(src.order) || 0, text: '', style: {} };
        NODE_KEYS.forEach(function (k) { if (k in src) setField(n, k, src[k]); });
        nodes[n.id] = n;
        return true;
      }
      case 'update': {
        var u = nodes[op.id];
        if (!u || !op.patch || typeof op.patch !== 'object') return false;
        Object.keys(op.patch).forEach(function (k) { if (NODE_KEYS.indexOf(k) >= 0) setField(u, k, op.patch[k]); });
        return true;
      }
      case 'delete': {
        if (op.id === doc.rootId || !nodes[op.id]) return false;
        subtreeIds(doc, op.id).forEach(function (k) { delete nodes[k]; });
        return true;
      }
      case 'move': {
        var m = nodes[op.id];
        if (!m || !nodes[op.parent] || op.id === doc.rootId) return false;
        for (var c = op.parent; c; c = nodes[c] && nodes[c].parent) if (c === op.id) return false; // pas de cycle
        m.parent = op.parent;
        m.order = Number(op.order) || 0;
        if ('side' in op) setField(m, 'side', op.side);
        return true;
      }
    }
    return false;
  }

  /** Ordre à donner à un nœud placé entre deux frères (null = extrémité). */
  function orderBetween(a, b) {
    if (a == null && b == null) return 1;
    if (a == null) return b - 1;
    if (b == null) return a + 1;
    return (a + b) / 2;
  }

  /** Liste des fichiers référencés par le document (images + pièces jointes). */
  function fileIds(doc) {
    var ids = [];
    Object.keys(doc.nodes).forEach(function (k) {
      var n = doc.nodes[k];
      if (n.image) ids.push(n.image.id);
      (n.attachments || []).forEach(function (a) { ids.push(a.id); });
    });
    return ids;
  }

  var api = {
    newDoc: newDoc, uid: uid, applyOp: applyOp, children: children, subtreeIds: subtreeIds,
    orderBetween: orderBetween, safeLink: safeLink, fileIds: fileIds, STYLE_KEYS: STYLE_KEYS
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MindOps = api;
})(this);
