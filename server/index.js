require('dotenv').config({ quiet: true });
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { migrate, isMysql } = require('./db');
const { problems, report } = require('./diagnostics');
const auth = require('./auth');
const maps = require('./maps');
const admin = require('./admin');
const folders = require('./folders');

const app = express();
const PUBLIC = path.join(__dirname, '..', 'public');

app.set('trust proxy', 1); // derrière le proxy Hostinger
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  next();
});
// État de la base : tant qu'elle n'est pas prête, on affiche une page de diagnostic au lieu de planter.
let dbReady = false;
let dbProblem = null;

// Empreinte du code du navigateur : elle change dès qu'un script ou une feuille de style change.
const isProd = process.env.NODE_ENV === 'production';
function computeBuild() {
  const h = crypto.createHash('sha1');
  ['js', 'css'].forEach((dir) => {
    fs.readdirSync(path.join(PUBLIC, dir)).sort().forEach((f) => h.update(f).update(fs.readFileSync(path.join(PUBLIC, dir, f))));
  });
  return h.digest('hex').slice(0, 10);
}
let BUILD = computeBuild();

app.get('/health', (req, res) => {
  res.status(dbReady ? 200 : 503).json({ ok: dbReady, version: BUILD, database: dbReady ? 'ok' : dbProblem, problems });
});

app.use((req, res, next) => {
  if (dbReady) return next();
  if (req.path.startsWith('/api')) return res.status(503).json({ error: 'Service en cours de démarrage ou mal configuré' });
  const list = (dbProblem ? [dbProblem] : []).concat(problems);
  res.status(503).type('html').send(`<!doctype html><meta charset="utf-8"><title>Configuration</title>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:0 16px;color:#1226AA">
<h1>Le serveur démarre mais n'est pas prêt</h1>
${list.length ? '<ul>' + list.map((p) => `<li><b>${p.code}</b> : ${escapeHtml(p.message)}</li>`).join('') + '</ul>' : '<p>Connexion à la base de données en cours… rechargez dans quelques secondes.</p>'}
<p>Corrigez les variables d'environnement dans l'hébergeur puis redémarrez l'application.</p></body>`);
});

app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(auth.loadUser);

// Les requêtes d'écriture doivent être en JSON ou multipart : bloque les formulaires cross-site.
app.use('/api', (req, res, next) => {
  if (['POST', 'PATCH', 'DELETE', 'PUT'].includes(req.method)) {
    const type = req.get('content-type') || '';
    if (req.method !== 'DELETE' && !/^(application\/json|multipart\/form-data)/.test(type))
      return res.status(415).json({ error: 'Type de contenu non pris en charge' });
  }
  next();
});

app.use('/api/auth', auth.router);
app.use('/api/admin', admin.router);
app.use('/api', maps.router);
app.use('/api', folders.router);
app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));

// Scripts, styles et pages : le navigateur revérifie à chaque visite (réponse 304 légère si rien n'a changé),
// pour qu'une mise à jour soit visible immédiatement. Polices, images et bibliothèques changent rarement.
app.use(express.static(PUBLIC, {
  index: false,
  setHeaders: (res, filePath) => {
    const rel = path.relative(PUBLIC, filePath);
    res.set('Cache-Control', /^(fonts|img|vendor)[\\/]/.test(rel) ? 'public, max-age=604800' : 'no-cache');
  }
}));

// Pages HTML : les adresses des scripts et styles reçoivent ?v=<empreinte>, si bien qu'aucun cache
// (navigateur ou CDN de l'hébergeur) ne peut servir une ancienne version après une mise à jour.
const pages = {};
function page(file, status) {
  return (req, res) => {
    if (!isProd) BUILD = computeBuild();
    if (!pages[file] || !isProd) {
      pages[file] = fs.readFileSync(path.join(PUBLIC, file), 'utf8')
        .replace(/((?:src|href)="\/(?:js|css)\/[\w.-]+\.(?:js|css))"/g, `$1?v=${BUILD}"`);
    }
    res.status(status || 200).set('Cache-Control', 'no-cache').type('html').send(pages[file]);
  };
}
app.get(['/m/:id', '/s/:token'], page('map.html'));
app.get(['/', '/login', '/register', '/admin', '/account'], page('index.html'));
app.use(page('index.html', 404));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur' });
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function explainDbError(e) {
  const known = {
    ER_ACCESS_DENIED_ERROR: 'Identifiant ou mot de passe MySQL refusé : vérifiez DB_USER et DB_PASSWORD.',
    ER_DBACCESS_DENIED_ERROR: 'Cet utilisateur MySQL n\'a pas accès à la base : vérifiez DB_NAME et DB_USER.',
    ER_BAD_DB_ERROR: 'Base de données introuvable : vérifiez DB_NAME.',
    ECONNREFUSED: 'Serveur MySQL injoignable : vérifiez DB_HOST et DB_PORT.',
    ENOTFOUND: 'Adresse du serveur MySQL inconnue : vérifiez DB_HOST.',
    ETIMEDOUT: 'Le serveur MySQL ne répond pas : vérifiez DB_HOST et DB_PORT.'
  };
  return { code: e.code || 'BASE_DE_DONNEES', message: known[e.code] || 'Impossible d\'initialiser la base de données.' };
}

async function connectDatabase() {
  try {
    await migrate();
    dbReady = true;
    dbProblem = null;
    console.log('Base de données prête');
  } catch (e) {
    dbProblem = explainDbError(e);
    console.error('Base de données indisponible :', e.code || '', e.message);
    setTimeout(connectDatabase, 30000); // nouvel essai automatique
  }
}

if (isMysql) {
  ['DB_NAME', 'DB_USER', 'DB_PASSWORD'].forEach((k) => { if (!process.env[k]) report(k, `La variable ${k} est vide.`); });
} else if (process.env.NODE_ENV === 'production') {
  report('DB_CLIENT', 'DB_CLIENT n\'est pas « mysql » : les données sont stockées dans un fichier SQLite local.');
}

// PORT est transmis tel quel : certains hébergeurs fournissent un nom de socket et non un numéro.
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Mindmap démarré (port ${PORT})`));
connectDatabase();
