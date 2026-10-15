const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db, DATA_DIR } = require('./db');

const COOKIE = 'mm_session';
const SESSION_DAYS = 14;
const isProd = process.env.NODE_ENV === 'production';

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (isProd) throw new Error('JWT_SECRET doit être défini en production (voir .env.example)');
  const file = path.join(DATA_DIR, '.dev-secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'));
  return fs.readFileSync(file, 'utf8');
}
const SECRET = loadSecret();

function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, role: u.role };
}

function setSession(res, user) {
  const token = jwt.sign({ uid: user.id, tv: user.token_version }, SECRET, { expiresIn: SESSION_DAYS + 'd' });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProd,
    maxAge: SESSION_DAYS * 24 * 3600 * 1000
  });
}

/** Middleware : renseigne req.user si la session est valide. */
async function loadUser(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE];
  if (!token) return next();
  try {
    const payload = jwt.verify(token, SECRET);
    const user = await db('users').where({ id: payload.uid }).first();
    if (user && !user.disabled && user.token_version === payload.tv) req.user = user;
    else res.clearCookie(COOKIE);
  } catch (e) {
    res.clearCookie(COOKIE);
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Connexion requise' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Connexion requise' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Réservé aux administrateurs' });
  next();
}

// Limitation simple des tentatives de connexion (mémoire du processus).
const attempts = new Map();
function tooManyAttempts(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  attempts.set(key, list);
  return list.length >= 10;
}
function recordAttempt(key) {
  attempts.get(key).push(Date.now());
}

function validEmail(e) {
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 191;
}

const router = express.Router();

router.post('/register', async (req, res) => {
  if (process.env.ALLOW_SIGNUP === 'false') return res.status(403).json({ error: 'Les inscriptions sont fermées' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 120);
  const password = String(req.body.password || '');
  if (!validEmail(email)) return res.status(400).json({ error: 'Adresse e-mail invalide' });
  if (password.length < 8) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères' });
  if (await db('users').where({ email }).first()) return res.status(409).json({ error: 'Un compte existe déjà avec cet e-mail' });

  // Le premier compte créé, ou celui dont l'e-mail est ADMIN_EMAIL, devient administrateur.
  const count = Number((await db('users').count({ c: '*' }).first()).c);
  const isAdmin = count === 0 || (process.env.ADMIN_EMAIL && process.env.ADMIN_EMAIL.toLowerCase() === email);

  const [id] = await db('users').insert({
    email,
    name: name || email.split('@')[0],
    password_hash: await bcrypt.hash(password, 10),
    role: isAdmin ? 'admin' : 'user'
  });
  const user = await db('users').where({ id }).first();
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const key = req.ip + '|' + email;
  if (tooManyAttempts(key)) return res.status(429).json({ error: 'Trop de tentatives, réessayez dans 15 minutes' });
  const user = await db('users').where({ email }).first();
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    recordAttempt(key);
    return res.status(401).json({ error: 'E-mail ou mot de passe incorrect' });
  }
  if (user.disabled) return res.status(403).json({ error: 'Ce compte est désactivé' });
  await db('users').where({ id: user.id }).update({ last_login_at: db.fn.now() });
  setSession(res, user);
  res.json({ user: publicUser(user) });
});

router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

router.get('/me', (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null, signupOpen: process.env.ALLOW_SIGNUP !== 'false' });
});

router.patch('/me', requireUser, async (req, res) => {
  const patch = {};
  if (typeof req.body.name === 'string') patch.name = req.body.name.trim().slice(0, 120);
  if (req.body.newPassword) {
    if (!(await bcrypt.compare(String(req.body.currentPassword || ''), req.user.password_hash)))
      return res.status(400).json({ error: 'Mot de passe actuel incorrect' });
    if (String(req.body.newPassword).length < 8) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères' });
    patch.password_hash = await bcrypt.hash(String(req.body.newPassword), 10);
    patch.token_version = req.user.token_version + 1;
  }
  if (Object.keys(patch).length) await db('users').where({ id: req.user.id }).update(patch);
  const user = await db('users').where({ id: req.user.id }).first();
  if (patch.token_version) setSession(res, user);
  res.json({ user: publicUser(user) });
});

module.exports = { router, loadUser, requireUser, requireAdmin, publicUser };
