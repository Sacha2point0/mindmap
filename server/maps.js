const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { db, DATA_DIR } = require('./db');
const { requireUser } = require('./auth');
const MindOps = require('../public/js/ops.js');

const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const KEEP_OPS = 1000; // nombre d'opérations conservées par carte pour la synchro
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const router = express.Router();

// ---------------------------------------------------------------- Droits d'accès

/**
 * Renvoie le niveau d'accès à une carte : 'owner', 'edit', 'view' ou null.
 * Le jeton de partage arrive par l'en-tête X-Share-Token (API) ou ?t= (images, téléchargements).
 */
async function accessFor(req, map) {
  if (!map) return null;
  if (req.user && (req.user.id === map.owner_id || req.user.role === 'admin')) return 'owner';
  const token = req.get('X-Share-Token') || req.query.t;
  if (!token) return null;
  const link = await db('share_links').where({ token: String(token), map_id: map.id }).first();
  if (!link || link.revoked) return null;
  return link.permission === 'edit' ? 'edit' : 'view';
}

const RANK = { view: 1, edit: 2, owner: 3 };
function guard(level) {
  return async (req, res, next) => {
    try {
      const map = await db('maps').where({ id: req.params.id }).first();
      const access = await accessFor(req, map);
      if (!access) return res.status(map ? 403 : 404).json({ error: map ? 'Accès refusé' : 'Carte introuvable' });
      if (RANK[access] < RANK[level]) return res.status(403).json({ error: 'Droits insuffisants' });
      req.map = map;
      req.access = access;
      next();
    } catch (e) { next(e); }
  };
}

// Sérialise les écritures sur une même carte (le serveur Node tourne en un seul processus).
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.then(() => fn());
  const tail = run.catch(() => {});
  locks.set(key, tail);
  tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

// Présence : qui regarde la carte en ce moment (mémoire du processus).
const presence = new Map();
function touchPresence(mapId, q) {
  if (!q.client) return [];
  const now = Date.now();
  const room = presence.get(mapId) || new Map();
  presence.set(mapId, room);
  room.set(String(q.client).slice(0, 64), {
    client: String(q.client).slice(0, 64),
    name: String(q.name || 'Invité').slice(0, 60),
    color: /^#[0-9a-f]{6}$/i.test(q.color || '') ? q.color : '#1226AA',
    sel: q.sel ? String(q.sel).slice(0, 40) : null,
    ts: now
  });
  const out = [];
  for (const [id, p] of room) {
    if (now - p.ts > 8000) room.delete(id);
    else if (id !== q.client) out.push(p);
  }
  return out;
}

async function deleteMapCompletely(mapId) {
  const files = await db('files').where({ map_id: mapId });
  for (const f of files) fs.rm(path.join(UPLOAD_DIR, f.stored_name), { force: true }, () => {});
  await db('files').where({ map_id: mapId }).del();
  await db('map_ops').where({ map_id: mapId }).del();
  await db('share_links').where({ map_id: mapId }).del();
  await db('maps').where({ id: mapId }).del();
}

// ---------------------------------------------------------------- Cartes

router.get('/maps', requireUser, async (req, res) => {
  const maps = await db('maps').where({ owner_id: req.user.id })
    .select('id', 'title', 'created_at', 'updated_at').orderBy('updated_at', 'desc');
  res.json({ maps });
});

router.post('/maps', requireUser, async (req, res) => {
  const id = crypto.randomUUID();
  const title = String(req.body.title || 'Nouvelle carte').trim().slice(0, 200) || 'Nouvelle carte';
  await db('maps').insert({ id, owner_id: req.user.id, title, doc: JSON.stringify(MindOps.newDoc(title)), version: 0 });
  res.json({ id });
});

router.get('/maps/:id', guard('view'), async (req, res) => {
  const m = req.map;
  res.json({ id: m.id, title: m.title, doc: JSON.parse(m.doc), version: m.version, access: req.access });
});

router.post('/maps/:id/duplicate', requireUser, guard('owner'), async (req, res) => {
  const id = crypto.randomUUID();
  const doc = JSON.parse(req.map.doc);
  const title = (req.map.title + ' (copie)').slice(0, 200);
  doc.nodes[doc.rootId].text = title;
  // Les fichiers sont copiés pour que les deux cartes restent indépendantes.
  const files = await db('files').where({ map_id: req.map.id });
  const remap = {};
  for (const f of files) {
    const nid = crypto.randomUUID();
    const stored = nid + path.extname(f.stored_name);
    fs.copyFileSync(path.join(UPLOAD_DIR, f.stored_name), path.join(UPLOAD_DIR, stored));
    const { created_at, ...rest } = f;
    await db('files').insert({ ...rest, id: nid, map_id: id, stored_name: stored });
    remap[f.id] = nid;
  }
  Object.values(doc.nodes).forEach((n) => {
    if (n.image && remap[n.image.id]) n.image.id = remap[n.image.id];
    (n.attachments || []).forEach((a) => { if (remap[a.id]) a.id = remap[a.id]; });
  });
  await db('maps').insert({ id, owner_id: req.user.id, title, doc: JSON.stringify(doc), version: 0 });
  res.json({ id });
});

router.delete('/maps/:id', guard('owner'), async (req, res) => {
  await withLock(req.map.id, () => deleteMapCompletely(req.map.id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Synchronisation

/**
 * Le client envoie des opérations ; le serveur les applique dans l'ordre d'arrivée,
 * les numérote (version) et les journalise. Les autres clients les récupèrent par GET.
 */
router.post('/maps/:id/ops', guard('edit'), async (req, res, next) => {
  const ops = Array.isArray(req.body.ops) ? req.body.ops.slice(0, 500) : [];
  const clientId = String(req.body.clientId || '').slice(0, 64);
  try {
    const result = await withLock(req.map.id, async () => {
      const map = await db('maps').where({ id: req.map.id }).first();
      if (!map) return null;
      const doc = JSON.parse(map.doc);
      let version = map.version;
      const rows = [];
      for (const op of ops) {
        // Chaque op est journalisée même si elle est sans effet, pour que le client puisse l'acquitter.
        const changed = MindOps.applyOp(doc, op);
        version++;
        rows.push({ map_id: map.id, version, op: JSON.stringify({ ...op, noop: !changed || undefined }), client_id: clientId });
      }
      if (!rows.length) return { version };
      const title = String(doc.nodes[doc.rootId].text || 'Sans titre').replace(/\s+/g, ' ').slice(0, 200);
      await db.transaction(async (trx) => {
        await trx('maps').where({ id: map.id }).update({ doc: JSON.stringify(doc), version, title, updated_at: db.fn.now() });
        for (let i = 0; i < rows.length; i += 100) await trx('map_ops').insert(rows.slice(i, i + 100));
        if (Math.floor(version / 200) !== Math.floor(map.version / 200))
          await trx('map_ops').where('map_id', map.id).andWhere('version', '<=', version - KEEP_OPS).del();
      });
      return { version };
    });
    if (!result) return res.status(404).json({ error: 'Carte introuvable' });
    res.json(result);
  } catch (e) { next(e); }
});

router.get('/maps/:id/ops', guard('view'), async (req, res) => {
  const since = Number(req.query.since) || 0;
  const others = touchPresence(req.map.id, req.query);
  const map = await db('maps').where({ id: req.map.id }).select('version', 'doc').first();
  if (!map) return res.status(404).json({ error: 'Carte introuvable' });
  if (since >= map.version) return res.json({ version: map.version, ops: [], presence: others });

  const rows = await db('map_ops').where('map_id', req.map.id).andWhere('version', '>', since)
    .orderBy('version').select('version', 'op', 'client_id');
  // Trou dans le journal (trop ancien ou purgé) : on renvoie le document complet.
  if (rows.length !== map.version - since || (rows.length && rows[0].version !== since + 1))
    return res.json({ version: map.version, reset: true, doc: JSON.parse(map.doc), presence: others });

  res.json({
    version: map.version,
    ops: rows.map((r) => ({ v: r.version, c: r.client_id, op: JSON.parse(r.op) })),
    presence: others
  });
});

// ---------------------------------------------------------------- Liens de partage

router.get('/maps/:id/shares', guard('owner'), async (req, res) => {
  const links = await db('share_links').where({ map_id: req.map.id, revoked: false })
    .select('id', 'token', 'permission', 'label', 'created_at').orderBy('created_at', 'desc');
  res.json({ links });
});

router.post('/maps/:id/shares', guard('owner'), async (req, res) => {
  const permission = req.body.permission === 'edit' ? 'edit' : 'view';
  const token = crypto.randomBytes(18).toString('base64url');
  const label = String(req.body.label || '').slice(0, 120);
  await db('share_links').insert({ map_id: req.map.id, token, permission, label });
  res.json({ token, permission, label });
});

router.delete('/maps/:id/shares/:linkId', guard('owner'), async (req, res) => {
  await db('share_links').where({ id: req.params.linkId, map_id: req.map.id }).update({ revoked: true });
  res.json({ ok: true });
});

router.get('/share/:token', async (req, res) => {
  const link = await db('share_links').where({ token: req.params.token }).first();
  if (!link || link.revoked) return res.status(404).json({ error: 'Ce lien de partage n\'est plus valide' });
  res.json({ mapId: link.map_id, permission: link.permission });
});

// ---------------------------------------------------------------- Fichiers (images et documents)

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
      cb(null, crypto.randomUUID() + ext);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 }
});

router.post('/maps/:id/files', guard('edit'), (req, res, next) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Fichier trop volumineux (max ${MAX_UPLOAD_MB} Mo)` : 'Échec de l\'envoi';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' });
    try {
      // multer décode les noms en latin1 : on les remet en UTF-8 pour les accents.
      const name = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 255);
      const id = path.parse(req.file.filename).name;
      await db('files').insert({
        id, map_id: req.map.id, original_name: name, mime: req.file.mimetype.slice(0, 120),
        size: req.file.size, stored_name: req.file.filename, uploaded_by: req.user ? req.user.id : null
      });
      res.json({ id, name, size: req.file.size, mime: req.file.mimetype, isImage: IMAGE_TYPES.includes(req.file.mimetype) });
    } catch (e) { next(e); }
  });
});

router.get('/files/:fileId', async (req, res) => {
  const file = await db('files').where({ id: req.params.fileId }).first();
  if (!file) return res.status(404).end();
  const map = await db('maps').where({ id: file.map_id }).first();
  if (!(await accessFor(req, map))) return res.status(403).end();
  const isImage = IMAGE_TYPES.includes(file.mime);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Cache-Control', 'private, max-age=86400');
  // Seules les images sûres s'affichent dans le navigateur ; le reste est toujours téléchargé.
  res.type(isImage ? file.mime : 'application/octet-stream');
  res.set('Content-Disposition', `${isImage && !req.query.download ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
  res.sendFile(path.join(UPLOAD_DIR, file.stored_name), (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

module.exports = { router, deleteMapCompletely, UPLOAD_DIR };
