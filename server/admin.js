const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { requireAdmin } = require('./auth');
const { deleteMapCompletely } = require('./maps');

const router = express.Router();
router.use(requireAdmin);

router.get('/stats', async (req, res) => {
  const count = async (t) => Number((await db(t).count({ c: '*' }).first()).c);
  const size = await db('files').sum({ s: 'size' }).first();
  res.json({ users: await count('users'), maps: await count('maps'), files: await count('files'), storage: Number(size.s) || 0 });
});

router.get('/users', async (req, res) => {
  const users = await db('users')
    .leftJoin('maps', 'maps.owner_id', 'users.id')
    .groupBy('users.id', 'users.email', 'users.name', 'users.role', 'users.disabled', 'users.created_at', 'users.last_login_at')
    .select('users.id', 'users.email', 'users.name', 'users.role', 'users.disabled', 'users.created_at', 'users.last_login_at')
    .count({ maps: 'maps.id' })
    .orderBy('users.created_at', 'desc');
  res.json({ users: users.map((u) => ({ ...u, disabled: !!u.disabled, maps: Number(u.maps) })) });
});

async function adminCount() {
  return Number((await db('users').where({ role: 'admin', disabled: false }).count({ c: '*' }).first()).c);
}

router.patch('/users/:id', async (req, res) => {
  const user = await db('users').where({ id: req.params.id }).first();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const patch = {};
  const losesAdmin = (req.body.role === 'user' && user.role === 'admin') || (req.body.disabled === true && user.role === 'admin');
  if (losesAdmin && (await adminCount()) <= 1) return res.status(400).json({ error: 'Il doit rester au moins un administrateur actif' });

  if (req.body.role === 'admin' || req.body.role === 'user') patch.role = req.body.role;
  if (typeof req.body.disabled === 'boolean') {
    if (user.id === req.user.id && req.body.disabled) return res.status(400).json({ error: 'Vous ne pouvez pas désactiver votre propre compte' });
    patch.disabled = req.body.disabled;
    patch.token_version = user.token_version + 1; // déconnecte les sessions ouvertes
  }
  if (req.body.password) {
    if (String(req.body.password).length < 8) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères' });
    patch.password_hash = await bcrypt.hash(String(req.body.password), 10);
    patch.token_version = user.token_version + 1;
  }
  if (Object.keys(patch).length) await db('users').where({ id: user.id }).update(patch);
  res.json({ ok: true });
});

router.delete('/users/:id', async (req, res) => {
  const user = await db('users').where({ id: req.params.id }).first();
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  if (user.id === req.user.id) return res.status(400).json({ error: 'Vous ne pouvez pas supprimer votre propre compte' });
  const maps = await db('maps').where({ owner_id: user.id }).select('id');
  for (const m of maps) await deleteMapCompletely(m.id);
  await db('folders').where({ owner_id: user.id }).del();
  await db('users').where({ id: user.id }).del();
  res.json({ ok: true });
});

module.exports = { router };
