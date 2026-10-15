/*
 * Import de fichiers XMind (.xmind) : versions récentes (content.json) et XMind 8 (content.xml).
 * Le fichier est lu dans le navigateur, puis chaque feuille devient une carte créée via l'API
 * (images et pièces jointes envoyées comme fichiers de la carte).
 */
(function () {
  'use strict';
  const { api } = window.App;
  const M = window.MindOps;

  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf' };
  const SHAPES = {
    'org.xmind.topicShape.roundedRect': 'rounded',
    'org.xmind.topicShape.rect': 'rect',
    'org.xmind.topicShape.ellipserect': 'pill',
    'org.xmind.topicShape.ellipse': 'pill',
    'org.xmind.topicShape.underline': 'line'
  };

  // ------------------------------------------------------------ Lecture de l'archive ZIP

  async function readZip(file) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('ce fichier n\'est pas un fichier XMind valide');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const entries = new Map();
    const dec = new TextDecoder();
    for (let n = 0; n < count; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), commentLen = dv.getUint16(p + 32, true);
      const localOffset = dv.getUint32(p + 42, true);
      const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
      entries.set(name, { method, compSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return {
      names: () => Array.from(entries.keys()),
      has: (name) => entries.has(name),
      async read(name) {
        const e = entries.get(name);
        if (!e) return null;
        const start = e.localOffset + 30 + dv.getUint16(e.localOffset + 26, true) + dv.getUint16(e.localOffset + 28, true);
        const data = buf.subarray(start, start + e.compSize);
        if (e.method === 0) return data;
        if (e.method !== 8) throw new Error('format de compression non pris en charge');
        if (typeof DecompressionStream === 'undefined') throw new Error('navigateur trop ancien pour lire ce fichier');
        const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      }
    };
  }

  // ------------------------------------------------------------ Conversion vers un arbre commun

  const isColor = (v) => typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim());

  function styleFrom(props) {
    const s = {};
    if (!props) return s;
    if (isColor(props['svg:fill'])) s.bg = props['svg:fill'];
    if (isColor(props['fo:color'])) s.color = props['fo:color'];
    if (/bold|[6-9]00/.test(props['fo:font-weight'] || '')) s.bold = true;
    if (/italic/.test(props['fo:font-style'] || '')) s.italic = true;
    if (/underline/.test(props['fo:text-decoration'] || '')) s.underline = true;
    const pt = parseFloat(props['fo:font-size']);
    if (pt) s.size = pt <= 12 ? 's' : pt <= 15 ? 'm' : pt <= 20 ? 'l' : 'xl';
    if (isColor(props['border-line-color'])) s.border = props['border-line-color'];
    if (isColor(props['line-color'])) s.branch = props['line-color'];
    if (SHAPES[props['shape-class']]) s.shape = SHAPES[props['shape-class']];
    return s;
  }

  function fromJsonTopic(t) {
    const kids = [].concat((t.children && t.children.attached) || [], (t.children && t.children.detached) || []);
    const note = t.notes && t.notes.plain && t.notes.plain.content;
    return {
      title: t.title || '',
      href: t.href || null,
      image: t.image && t.image.src ? { src: t.image.src, w: t.image.width } : null,
      style: styleFrom(t.style && t.style.properties),
      folded: t.branch === 'folded',
      note: note || null,
      children: kids.map(fromJsonTopic)
    };
  }

  function fromXml(text) {
    const xml = new DOMParser().parseFromString(text, 'application/xml');
    if (xml.getElementsByTagName('parsererror').length) throw new Error('contenu XMind illisible');
    const kids = (el, name) => Array.from(el.children).filter((c) => c.localName === name);
    const attr = (el, local) => {
      for (const a of Array.from(el.attributes)) if (a.localName === local) return a.value;
      return null;
    };
    const topic = (el) => {
      const title = kids(el, 'title')[0];
      const img = Array.from(el.children).find((c) => c.localName === 'img');
      const children = [];
      kids(el, 'children').forEach((c) => kids(c, 'topics').forEach((ts) => kids(ts, 'topic').forEach((t) => children.push(topic(t)))));
      const notes = kids(el, 'notes')[0];
      const plain = notes && kids(notes, 'plain')[0];
      return {
        title: title ? title.textContent : '',
        href: attr(el, 'href'),
        image: img && attr(img, 'src') ? { src: attr(img, 'src'), w: parseFloat(attr(img, 'width')) || null } : null,
        style: {},
        folded: el.getAttribute('branch') === 'folded',
        note: plain ? plain.textContent : null,
        children
      };
    };
    return Array.from(xml.getElementsByTagName('sheet')).map((sheet) => {
      const t = kids(sheet, 'topic')[0];
      const title = kids(sheet, 'title')[0];
      return { title: title ? title.textContent : '', root: t ? topic(t) : { title: '', children: [], style: {} } };
    });
  }

  async function parseXmind(file) {
    const zip = await readZip(file);
    const dec = new TextDecoder();
    let sheets = null;
    const json = await zip.read('content.json');
    if (json) {
      const data = JSON.parse(dec.decode(json));
      sheets = (Array.isArray(data) ? data : [data]).filter((s) => s && s.rootTopic)
        .map((s) => ({ title: s.title || '', root: fromJsonTopic(s.rootTopic) }));
    }
    if (!sheets || !sheets.length) {
      const xml = await zip.read('content.xml');
      if (!xml) throw new Error('aucune carte trouvée dans ce fichier');
      sheets = fromXml(dec.decode(xml));
    }
    if (!sheets.length) throw new Error('aucune carte trouvée dans ce fichier');
    return { sheets, zip };
  }

  // ------------------------------------------------------------ Création des cartes

  const isAttachmentTopic = (t) => t.href && /^xap:/.test(t.href) && !t.children.length && !t.image;

  async function createMap(sheet, title, zip, folderId, onProgress) {
    const { id: mapId } = await api('POST', '/api/maps', { title, folderId });
    const uploaded = new Map();
    let count = 0;

    async function upload(xapPath, name) {
      let path = xapPath.replace(/^xap:/, '');
      if (!zip.has(path) && zip.has(decodeURIComponent(path))) path = decodeURIComponent(path);
      if (uploaded.has(path)) return uploaded.get(path);
      const data = await zip.read(path);
      if (!data) return null;
      const fname = name || path.split('/').pop();
      const ext = (fname.split('.').pop() || '').toLowerCase();
      const fd = new FormData();
      fd.append('file', new Blob([data], { type: MIME[ext] || 'application/octet-stream' }), fname);
      try {
        const r = await api('POST', `/api/maps/${mapId}/files`, fd);
        uploaded.set(path, r);
        return r;
      } catch (e) { return null; } // fichier trop gros ou refusé : on continue sans lui
    }

    const ops = [];
    async function visit(t, nodeId, parentId, order, depth) {
      const fields = { text: t.title || '', style: t.style || {} };
      if (t.href && !/^xap:/.test(t.href) && M.safeLink(t.href)) fields.link = t.href;
      if (t.folded && depth > 0) fields.collapsed = true;
      if (t.note) fields.note = t.note;
      if (t.image && /^xap:/.test(t.image.src)) {
        const r = await upload(t.image.src);
        if (r && r.isImage) fields.image = { id: r.id, w: Math.round(Math.min(900, Math.max(60, t.image.w || 200))) };
      }
      // Pièces jointes : lien xap du sujet lui-même, et sous-sujets qui ne sont qu'un fichier joint.
      const attachments = [];
      if (t.href && /^xap:/.test(t.href)) {
        const r = await upload(t.href, t.title);
        if (r) attachments.push({ id: r.id, name: r.name, size: r.size, mime: r.mime });
      }
      const children = [];
      for (const c of t.children) {
        if (isAttachmentTopic(c)) {
          const r = await upload(c.href, c.title);
          if (r) { attachments.push({ id: r.id, name: r.name, size: r.size, mime: r.mime }); continue; }
        }
        children.push(c);
      }
      if (attachments.length) fields.attachments = attachments;

      if (nodeId === 'root') ops.push({ type: 'update', id: 'root', patch: fields });
      else {
        const node = Object.assign({ id: nodeId, parent: parentId, order }, fields);
        if (depth === 1) node.side = order % 2 ? 'right' : 'left';
        ops.push({ type: 'add', node });
      }
      if (++count % 50 === 0 && onProgress) onProgress(`Import : ${count} branches…`);
      for (let i = 0; i < children.length; i++) await visit(children[i], M.uid(), nodeId, i + 1, depth + 1);
    }
    await visit(sheet.root, 'root', null, 0, 0);

    for (let i = 0; i < ops.length; i += 400)
      await api('POST', `/api/maps/${mapId}/ops`, { clientId: 'import-' + M.uid(), ops: ops.slice(i, i + 400) });
    return mapId;
  }

  /** Importe un fichier .xmind ; renvoie la liste des identifiants de cartes créées. */
  async function importFile(file, opts) {
    const { folderId = null, onProgress } = opts || {};
    const { sheets, zip } = await parseXmind(file);
    const base = file.name.replace(/\.xmind$/i, '');
    const ids = [];
    for (let i = 0; i < sheets.length; i++) {
      const s = sheets[i];
      const title = sheets.length > 1 ? `${base} – ${s.title || 'Feuille ' + (i + 1)}` : (s.root.title || s.title || base);
      ids.push(await createMap(s, title, zip, folderId, onProgress));
    }
    return ids;
  }

  window.XmindImport = { importFile, parseXmind };
})();
