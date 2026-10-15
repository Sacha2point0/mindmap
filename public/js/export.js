/*
 * Exports de la carte : image PNG, PDF, page HTML autonome et fichier XMind.
 * Tout est produit dans le navigateur ; les bibliothèques lourdes sont chargées à la demande.
 *
 * ctx = { doc, pos, nodesLayer, svg, fileUrl(id), title }
 */
(function () {
  'use strict';

  const SIZE_PT = { s: '12pt', m: '14pt', l: '18pt', xl: '24pt' };
  const XMIND_SHAPES = {
    rounded: 'org.xmind.topicShape.roundedRect',
    rect: 'org.xmind.topicShape.rect',
    pill: 'org.xmind.topicShape.ellipserect',
    line: 'org.xmind.topicShape.underline'
  };

  // ------------------------------------------------------------ Utilitaires

  const loaded = {};
  function loadScript(src) {
    if (!loaded[src]) loaded[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Impossible de charger ' + src));
      document.head.append(s);
    });
    return loaded[src];
  }

  function fileName(title, ext) {
    const base = (title || 'carte').normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-zA-Z0-9 _-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'carte';
    return base + '.' + ext;
  }

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  async function fetchFile(ctx, id) {
    const res = await fetch(ctx.fileUrl(id), { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Fichier inaccessible');
    return res.blob();
  }

  function kidsOf(doc) {
    const map = {};
    Object.values(doc.nodes).forEach((n) => { if (n.parent != null) (map[n.parent] = map[n.parent] || []).push(n); });
    Object.values(map).forEach((a) => a.sort((x, y) => x.order - y.order || (x.id < y.id ? -1 : 1)));
    return map;
  }

  // ------------------------------------------------------------ Rendu en image

  /**
   * Recopie la carte (branches visibles) dans un cadre hors écran à l'échelle 1,
   * puis la convertit en canvas. Renvoie aussi l'emplacement des liens pour le PDF.
   */
  async function renderCanvas(ctx, maxScale) {
    await loadScript('/vendor/html-to-image.js');
    const ps = Object.values(ctx.pos);
    const pad = 40;
    const minX = Math.min(...ps.map((p) => p.x)), maxX = Math.max(...ps.map((p) => p.x + p.w));
    const minY = Math.min(...ps.map((p) => p.y)), maxY = Math.max(...ps.map((p) => p.y + p.h));
    const W = Math.ceil(maxX - minX + 2 * pad), H = Math.ceil(maxY - minY + 2 * pad);

    const box = document.createElement('div');
    // Le cadre doit rester dans la fenêtre pour être rendu : on le place derrière la zone de travail.
    box.style.cssText = `position:fixed;left:0;top:0;width:${W}px;height:${H}px;background:#fff;overflow:hidden;z-index:-1;pointer-events:none;`;
    const inner = document.createElement('div');
    inner.style.cssText = `position:absolute;left:0;top:0;transform:translate(${pad - minX}px,${pad - minY}px);`;
    inner.append(ctx.svg.cloneNode(true), ctx.nodesLayer.cloneNode(true));
    // Retire tout ce qui relève de l'interface : sélection, présence, poignées, boutons.
    inner.querySelectorAll('.peer, .img-handle, .collapse:not(.closed)').forEach((n) => n.remove());
    inner.querySelectorAll('.node').forEach((n) => n.classList.remove('selected', 'peer-sel', 'dragging', 'editing', 'drop-child', 'drop-before', 'drop-after'));
    inner.querySelectorAll('.collapse.closed').forEach((n) => { n.style.opacity = '1'; });
    box.append(inner);
    document.body.append(box);

    try {
      await document.fonts.ready;
      const links = [];
      const origin = box.getBoundingClientRect();
      inner.querySelectorAll('a.chip[href^="http"], a.chip[href^="mailto"]').forEach((a) => {
        const r = a.getBoundingClientRect();
        links.push({ url: a.href, x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height });
      });
      // Les navigateurs limitent la taille des canvas : on réduit l'échelle pour les très grandes cartes.
      const scale = Math.max(0.5, Math.min(maxScale, 14000 / Math.max(W, H), Math.sqrt(120e6 / (W * H))));
      const canvas = await window.htmlToImage.toCanvas(box, {
        pixelRatio: scale, backgroundColor: '#ffffff', width: W, height: H,
        style: { left: '0', top: '0', position: 'relative', zIndex: 'auto' }
      });
      return { canvas, W, H, links };
    } finally {
      box.remove();
    }
  }

  async function exportPng(ctx) {
    const { canvas } = await renderCanvas(ctx, 2);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    download(blob, fileName(ctx.title, 'png'));
  }

  async function exportPdf(ctx) {
    const [{ canvas, W, H, links }] = await Promise.all([renderCanvas(ctx, 2), loadScript('/vendor/jspdf.umd.min.js')]);
    const { jsPDF } = window.jspdf;
    // Une page à la taille de la carte (1 px = 0,75 pt) : nette à l'écran et ajustable à l'impression.
    const k = 0.75;
    const pdf = new jsPDF({ orientation: W >= H ? 'landscape' : 'portrait', unit: 'pt', format: [W * k, H * k], compress: true });
    pdf.setProperties({ title: ctx.title, creator: 'Worklab Mindmap' });
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, W * k, H * k);
    links.forEach((l) => pdf.link(l.x * k, l.y * k, l.w * k, l.h * k, { url: l.url }));
    download(pdf.output('blob'), fileName(ctx.title, 'pdf'));
  }

  // ------------------------------------------------------------ Page HTML autonome

  async function exportHtml(ctx) {
    const { canvas } = await renderCanvas(ctx, 1.5);
    const mapImage = canvas.toDataURL('image/png');
    const doc = ctx.doc, kids = kidsOf(doc);
    const embedded = {};
    const MAX_EMBED = 15 * 1024 * 1024;
    for (const n of Object.values(doc.nodes)) {
      const ids = [];
      if (n.image) ids.push(n.image.id);
      (n.attachments || []).forEach((a) => { if (a.size <= MAX_EMBED) ids.push(a.id); });
      for (const id of ids) {
        try { embedded[id] = await blobToDataUrl(await fetchFile(ctx, id)); } catch (e) { /* fichier ignoré */ }
      }
    }

    const item = (n, depth) => {
      const s = n.style || {};
      const css = [s.color && 'color:' + s.color, s.bold && 'font-weight:800', s.italic && 'font-style:italic', s.underline && 'text-decoration:underline'].filter(Boolean).join(';');
      let h = `<li><div class="t"${css ? ` style="${escapeHtml(css)}"` : ''}>${escapeHtml(n.text || '(sans titre)').replace(/\n/g, '<br>')}</div>`;
      if (n.note) h += `<div class="n">📝 ${escapeHtml(n.note)}</div>`;
      if (n.image && embedded[n.image.id]) h += `<img src="${embedded[n.image.id]}" alt="" style="width:${Math.min(n.image.w || 200, 600)}px">`;
      const meta = [];
      if (n.link) meta.push(`<a href="${escapeHtml(n.link)}" target="_blank" rel="noopener">🔗 ${escapeHtml(n.link)}</a>`);
      (n.attachments || []).forEach((a) => meta.push(embedded[a.id]
        ? `<a href="${embedded[a.id]}" download="${escapeHtml(a.name)}">📎 ${escapeHtml(a.name)}</a>`
        : `<span>📎 ${escapeHtml(a.name)} (non inclus)</span>`));
      if (meta.length) h += `<div class="m">${meta.join('')}</div>`;
      const c = kids[n.id] || [];
      if (c.length) h += `<ul>${c.map((k) => item(k, depth + 1)).join('')}</ul>`;
      return h + '</li>';
    };
    const root = doc.nodes[doc.rootId];
    const date = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });

    const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(ctx.title)}</title>
<style>
body{font-family:Nunito,-apple-system,"Segoe UI",sans-serif;color:#1226AA;background:#F6F7FC;margin:0;padding:32px 16px}
main{max-width:1100px;margin:0 auto}
h1{font-weight:900;margin:0 0 4px}.date{color:#5B66A8;margin:0 0 24px}
.map{background:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(18,38,170,.1);padding:12px;overflow:auto;margin-bottom:32px}
.map img{display:block;max-width:100%;height:auto;margin:0 auto;cursor:zoom-in}.map.full img{max-width:none;cursor:zoom-out}
h2{font-weight:900}.outline{background:#fff;border-radius:14px;padding:20px 24px;box-shadow:0 6px 24px rgba(18,38,170,.1)}
ul{list-style:none;padding-left:22px;border-left:2px solid #DADFF2;margin:6px 0}.outline>ul{border:0;padding:0}
li{margin:8px 0}.t{font-weight:600;white-space:pre-wrap}li img{display:block;max-width:100%;border-radius:8px;margin:6px 0}
.m{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}.m a,.m span{font-size:13px;background:#E8EBF8;color:#1226AA;border-radius:999px;padding:2px 10px;text-decoration:none;word-break:break-all}
.m a:hover{background:#3BD4AE}
.n{white-space:pre-wrap;font-size:14px;background:#FFFBEA;border:1px solid #F2E38A;border-radius:10px;padding:6px 10px;margin:4px 0;max-width:640px}
</style></head><body><main>
<h1>${escapeHtml(ctx.title)}</h1><p class="date">Exporté le ${escapeHtml(date)}</p>
<div class="map" onclick="this.classList.toggle('full')"><img src="${mapImage}" alt="Carte mentale"></div>
<h2>Plan détaillé</h2>
<div class="outline"><ul>${item(root, 0)}</ul></div>
</main></body></html>`;
    download(new Blob([html], { type: 'text/html;charset=utf-8' }), fileName(ctx.title, 'html'));
  }

  // ------------------------------------------------------------ XMind

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Archive ZIP sans compression (suffisant pour XMind). files : [{ name, data: Uint8Array }] */
  function makeZip(files, type) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    files.forEach((f) => {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // noms en UTF-8
      local.setUint16(8, 0, true);
      local.setUint16(10, 0, true);
      local.setUint16(12, 33, true); // 1er janvier 1980
      local.setUint32(14, crc, true);
      local.setUint32(18, f.data.length, true);
      local.setUint32(22, f.data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(local, name, f.data);

      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true);
      cd.setUint16(4, 20, true);
      cd.setUint16(6, 20, true);
      cd.setUint16(8, 0x0800, true);
      cd.setUint16(10, 0, true);
      cd.setUint16(12, 0, true);
      cd.setUint16(14, 33, true);
      cd.setUint32(16, crc, true);
      cd.setUint32(20, f.data.length, true);
      cd.setUint32(24, f.data.length, true);
      cd.setUint16(28, name.length, true);
      cd.setUint32(42, offset, true);
      central.push(cd, name);
      offset += 30 + name.length + f.data.length;
    });
    const centralSize = central.reduce((a, p) => a + p.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, end], { type });
  }

  function imageSize(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight }); URL.revokeObjectURL(url); };
      img.onerror = () => { resolve({ w: 1, h: 1 }); URL.revokeObjectURL(url); };
      img.src = url;
    });
  }

  async function exportXmind(ctx) {
    const doc = ctx.doc, kids = kidsOf(doc);
    const enc = new TextEncoder();
    const files = [];
    const entries = {};
    const uid = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
    const extOf = (name, mime) => {
      const m = /\.([a-z0-9]{1,8})$/i.exec(name || '');
      return m ? m[1].toLowerCase() : ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[mime] || 'bin');
    };
    const addFile = async (dir, id, name, mime) => {
      const blob = await fetchFile(ctx, id);
      const path = `${dir}/${id}.${extOf(name, mime || blob.type)}`;
      files.push({ name: path, data: new Uint8Array(await blob.arrayBuffer()) });
      entries[path] = {};
      return { path, blob };
    };

    const topic = async (n, depth) => {
      const s = n.style || {};
      const t = { id: n.id + uid().slice(0, 6), class: 'topic', title: n.text || '' };
      const props = {};
      if (s.bg) props['svg:fill'] = s.bg;
      if (s.color) props['fo:color'] = s.color;
      if (s.bold) props['fo:font-weight'] = 'bold';
      if (s.italic) props['fo:font-style'] = 'italic';
      if (s.underline) props['fo:text-decoration'] = 'underline';
      if (s.size) props['fo:font-size'] = SIZE_PT[s.size];
      if (s.border) props['border-line-color'] = s.border;
      if (s.branch) props['line-color'] = s.branch;
      if (s.shape && XMIND_SHAPES[s.shape]) props['shape-class'] = XMIND_SHAPES[s.shape];
      if (Object.keys(props).length) t.style = { id: uid(), properties: props };
      if (n.link) t.href = n.link;
      if (n.collapsed) t.branch = 'folded';
      if (n.note) t.notes = { plain: { content: n.note } };
      if (n.image) {
        try {
          const { path, blob } = await addFile('resources', n.image.id, '', '');
          const nat = await imageSize(blob);
          const w = n.image.w || 200;
          t.image = { src: 'xap:' + path, width: w, height: Math.round(w * nat.h / nat.w) };
        } catch (e) { /* image ignorée */ }
      }
      const children = [];
      // XMind n'accepte qu'un lien par sujet : chaque document joint devient une sous-branche.
      for (const a of n.attachments || []) {
        try {
          const { path } = await addFile('attachments', a.id, a.name, a.mime);
          children.push({ id: uid(), class: 'topic', title: a.name, href: 'xap:' + path });
        } catch (e) { /* document ignoré */ }
      }
      for (const k of kids[n.id] || []) children.push(await topic(k, depth + 1));
      if (children.length) t.children = { attached: children };
      return t;
    };

    const rootTopic = await topic(doc.nodes[doc.rootId], 0);
    rootTopic.structureClass = 'org.xmind.ui.map.unbalanced';
    const content = [{ id: uid(), class: 'sheet', title: ctx.title || 'Carte', rootTopic, topicPositioning: 'fixed' }];
    const metadata = { creator: { name: 'Worklab Mindmap', version: '1.0' } };

    // Version XML simplifiée pour les anciennes versions de XMind (8 et antérieures).
    const xmlTopic = (t) => `<topic id="${escapeHtml(t.id)}"${t.href ? ` xlink:href="${escapeHtml(t.href)}"` : ''}${t.branch ? ' branch="folded"' : ''}><title>${escapeHtml(t.title)}</title>` +
      (t.notes ? `<notes><plain>${escapeHtml(t.notes.plain.content)}</plain></notes>` : '') +
      (t.children ? `<children><topics type="attached">${t.children.attached.map(xmlTopic).join('')}</topics></children>` : '') + '</topic>';
    const xml = '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' +
      '<xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:fo="http://www.w3.org/1999/XSL/Format" xmlns:svg="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0">' +
      `<sheet id="${content[0].id}">${xmlTopic(rootTopic).replace('<topic ', '<topic structure-class="org.xmind.ui.map.unbalanced" ')}<title>${escapeHtml(content[0].title)}</title></sheet></xmap-content>`;
    const manifestXml = '<?xml version="1.0" encoding="UTF-8" standalone="no"?><manifest xmlns="urn:xmind:xmap:xmlns:manifest:1.0">' +
      ['content.xml', 'META-INF/', 'META-INF/manifest.xml', ...Object.keys(entries)].map((p) => `<file-entry full-path="${escapeHtml(p)}" media-type=""/>`).join('') + '</manifest>';

    const manifest = { 'file-entries': Object.assign({ 'content.json': {}, 'metadata.json': {}, 'content.xml': {} }, entries) };
    const zipFiles = [
      { name: 'content.json', data: enc.encode(JSON.stringify(content)) },
      { name: 'metadata.json', data: enc.encode(JSON.stringify(metadata)) },
      { name: 'manifest.json', data: enc.encode(JSON.stringify(manifest)) },
      { name: 'content.xml', data: enc.encode(xml) },
      { name: 'META-INF/manifest.xml', data: enc.encode(manifestXml) },
      ...files
    ];
    download(makeZip(zipFiles, 'application/vnd.xmind.workbook'), fileName(ctx.title, 'xmind'));
  }

  window.MindExport = { png: exportPng, pdf: exportPdf, html: exportHtml, xmind: exportXmind, _makeZip: makeZip };
})();
