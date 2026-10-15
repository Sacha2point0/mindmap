const express = require('express');
const { db } = require('./db');
const { requireUser } = require('./auth');

const router = express.Router();
router.use('/folders', requireUser);

/** Vérifie qu'un dossier appartient à l'utilisateur. null = racine (« Mes cartes »). */
async function ownedFolder(ownerId, folderId) {
  if (folderId == null || folderId === '') return { ok: true, id: null };
  const f = await db('folders').where({ id: Number(folderId), owner_id: ownerId }).first();
  return f ? { ok: true, id: f.id } : { ok: false };
}

router.get('/folders', async (req, res) => {
  const folders = await db('folders').where({ owner_id: req.user.id }).select('id', 'name', 'parent_id', 'created_at').orderBy('name');
  res.json({ folders });
});

router.post('/folders', async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: 'Donnez un nom au dossier' });
  const parent = await ownedFolder(req.user.id, req.body.parentId);
  if (!parent.ok) return res.status(400).json({ error: 'Dossier parent introuvable' });
  const [id] = await db('folders').insert({ owner_id: req.user.id, name, parent_id: parent.id });
  res.json({ id });
});

router.patch('/folders/:id', async (req, res) => {
  const folder = await db('folders').where({ id: req.params.id, owner_id: req.user.id }).first();
  if (!folder) return res.status(404).json({ error: 'Dossier introuvable' });
  const patch = {};
  if (typeof req.body.name === 'string') {
    patch.name = req.body.name.trim().slice(0, 120);
    if (!patch.name) return res.status(400).json({ error: 'Donnez un nom au dossier' });
  }
  if ('parentId' in req.body) {
    const parent = await ownedFolder(req.user.id, req.body.parentId);
    if (!parent.ok) return res.status(400).json({ error: 'Dossier de destination introuvable' });
    // Interdit de placer un dossier dans lui-même ou dans un de ses sous-dossiers.
    const all = await db('folders').where({ owner_id: req.user.id }).select('id', 'parent_id');
    const parentOf = new Map(all.map((f) => [f.id, f.parent_id]));
    for (let c = parent.id; c != null; c = parentOf.get(c))
      if (c === folder.id) return res.status(400).json({ error: 'Impossible de déplacer un dossier dans lui-même' });
    patch.parent_id = parent.id;
  }
  if (Object.keys(patch).length) await db('folders').where({ id: folder.id }).update(patch);
  res.json({ ok: true });
});

/** Supprime le dossier ; son contenu (cartes et sous-dossiers) remonte d'un niveau. */
router.delete('/folders/:id', async (req, res) => {
  const folder = await db('folders').where({ id: req.params.id, owner_id: req.user.id }).first();
  if (!folder) return res.status(404).json({ error: 'Dossier introuvable' });
  await db.transaction(async (trx) => {
    await trx('maps').where({ folder_id: folder.id, owner_id: req.user.id }).update({ folder_id: folder.parent_id });
    await trx('folders').where({ parent_id: folder.id, owner_id: req.user.id }).update({ parent_id: folder.parent_id });
    await trx('folders').where({ id: folder.id }).del();
  });
  res.json({ ok: true });
});

module.exports = { router, ownedFolder };
