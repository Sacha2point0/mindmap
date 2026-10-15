require('dotenv').config({ quiet: true });
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const { migrate } = require('./db');
const auth = require('./auth');
const maps = require('./maps');
const admin = require('./admin');

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
app.use('/api', (req, res) => res.status(404).json({ error: 'Route inconnue' }));

app.use(express.static(PUBLIC, { index: false, maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

const page = (file) => (req, res) => res.sendFile(path.join(PUBLIC, file));
app.get(['/m/:id', '/s/:token'], page('map.html'));
app.get(['/', '/login', '/register', '/admin', '/account'], page('index.html'));
app.use((req, res) => res.status(404).sendFile(path.join(PUBLIC, 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Erreur serveur' });
});

const PORT = Number(process.env.PORT || 3000);
migrate()
  .then(() => app.listen(PORT, () => console.log(`Mindmap prêt sur http://localhost:${PORT}`)))
  .catch((e) => {
    console.error('Impossible d\'initialiser la base de données :', e.message);
    process.exit(1);
  });
