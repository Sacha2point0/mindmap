/* Pages hors éditeur : connexion, inscription, tableau de bord, compte, administration. */
(function () {
  'use strict';
  const { api, el, toast, modal, confirmBox, promptBox, formatDate, formatSize } = window.App;
  const view = document.getElementById('view');
  let me = null;
  let signupOpen = true;

  function go(path) {
    history.pushState(null, '', path);
    route();
  }
  window.addEventListener('popstate', route);
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-link]');
    if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.getAttribute('href')); }
  });

  // ------------------------------------------------------------ Barre du haut

  function renderUserArea() {
    const area = document.getElementById('user-area');
    area.innerHTML = '';
    if (!me) return;
    const list = el('div', { class: 'menu-list', hidden: true }, [
      el('div', { class: 'who' }, [el('b', { text: me.name }), el('br'), me.email]),
      el('a', { href: '/', 'data-link': true, text: 'Mes cartes' }),
      el('a', { href: '/account', 'data-link': true, text: 'Mon compte' }),
      me.role === 'admin' ? el('a', { href: '/admin', 'data-link': true, text: 'Administration' }) : null,
      el('button', { text: 'Se déconnecter', onclick: logout })
    ]);
    const btn = el('button', { class: 'btn', 'aria-haspopup': 'true' }, [me.name, ' ▾']);
    btn.onclick = (e) => { e.stopPropagation(); list.hidden = !list.hidden; };
    document.addEventListener('click', () => { list.hidden = true; });
    area.append(el('div', { class: 'menu' }, [btn, list]));
  }

  async function logout() {
    await api('POST', '/api/auth/logout', {});
    me = null;
    renderUserArea();
    go('/login');
  }

  // ------------------------------------------------------------ Authentification

  function authPage(mode) {
    const isLogin = mode === 'login';
    const err = el('div', { class: 'error' });
    const fields = [];
    if (!isLogin) fields.push(el('label', { class: 'field' }, ['Nom', el('input', { type: 'text', name: 'name', autocomplete: 'name' })]));
    fields.push(el('label', { class: 'field' }, ['E-mail', el('input', { type: 'email', name: 'email', required: true, autocomplete: 'email' })]));
    fields.push(el('label', { class: 'field' }, ['Mot de passe', el('input', {
      type: 'password', name: 'password', required: true, minlength: isLogin ? null : 8,
      autocomplete: isLogin ? 'current-password' : 'new-password'
    })]));
    if (!isLogin) fields.push(el('p', { class: 'muted small', text: '8 caractères minimum.' }));

    const form = el('form', null, [
      el('h1', { text: isLogin ? 'Connexion' : 'Créer un compte' }),
      el('p', { class: 'muted', text: isLogin ? 'Retrouvez vos cartes mentales.' : 'Créez et partagez vos cartes mentales.' }),
      ...fields, err,
      el('button', { class: 'btn primary', type: 'submit', style: 'width:100%;justify-content:center', text: isLogin ? 'Se connecter' : 'Créer mon compte' }),
      el('p', { class: 'small', style: 'text-align:center;margin-top:18px' }, isLogin
        ? (signupOpen ? ['Pas encore de compte ? ', el('a', { href: '/register', 'data-link': true, text: 'Inscrivez-vous' })] : [])
        : ['Déjà un compte ? ', el('a', { href: '/login', 'data-link': true, text: 'Connectez-vous' })])
    ]);
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      const data = Object.fromEntries(new FormData(form));
      try {
        const r = await api('POST', '/api/auth/' + (isLogin ? 'login' : 'register'), data);
        me = r.user;
        renderUserArea();
        const next = new URLSearchParams(location.search).get('next');
        if (next && next.startsWith('/') && !next.startsWith('//')) location.href = next;
        else go('/');
      } catch (ex) { err.textContent = ex.message; }
    };
    view.replaceChildren(el('div', { class: 'auth-wrap' }, [el('div', { class: 'blob a' }), el('div', { class: 'blob b' }), el('div', { class: 'card' }, form)]));
  }

  // ------------------------------------------------------------ Tableau de bord (cartes et dossiers)

  let dashSearch = '';
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  function currentFolderId() {
    const v = new URLSearchParams(location.search).get('dossier');
    return v ? Number(v) : null;
  }

  async function dashboard() {
    const folderId = currentFolderId();
    const [{ maps }, { folders }] = await Promise.all([api('GET', '/api/maps'), api('GET', '/api/folders')]);
    const byId = new Map(folders.map((f) => [f.id, f]));
    if (folderId && !byId.has(folderId)) return go('/');
    const pathOf = (id) => { const t = []; for (let f = byId.get(id); f; f = byId.get(f.parent_id)) t.unshift(f); return t; };

    // Glisser-déposer : une carte ou un dossier vers un dossier ou le fil d'Ariane.
    const DND = 'application/x-mindmap-item';
    const makeDraggable = (node, item) => {
      node.draggable = true;
      node.addEventListener('dragstart', (e) => { e.dataTransfer.setData(DND, JSON.stringify(item)); e.dataTransfer.effectAllowed = 'move'; node.classList.add('dragging'); });
      node.addEventListener('dragend', () => node.classList.remove('dragging'));
    };
    const makeDropTarget = (node, targetId) => {
      node.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes(DND)) { e.preventDefault(); node.classList.add('drop-target'); } });
      node.addEventListener('dragleave', () => node.classList.remove('drop-target'));
      node.addEventListener('drop', (e) => {
        node.classList.remove('drop-target');
        const raw = e.dataTransfer.getData(DND);
        if (!raw) return;
        e.preventDefault();
        const item = JSON.parse(raw);
        if (item.type === 'folder' && item.id === targetId) return;
        moveItem(item, targetId);
      });
    };

    const crumb = (id, label) => {
      const a = el('a', { class: 'crumb', href: id ? '/?dossier=' + id : '/', 'data-link': true, text: label });
      makeDropTarget(a, id);
      return a;
    };
    const trail = pathOf(folderId);
    const crumbs = el('nav', { class: 'crumbs', 'aria-label': 'Emplacement' }, [crumb(null, 'Mes cartes'), ...trail.flatMap((f) => [el('span', { class: 'sep', text: '›' }), crumb(f.id, f.name)])]);

    const importInput = el('input', { type: 'file', accept: '.xmind', multiple: true, hidden: true });
    importInput.onchange = () => importFiles(Array.from(importInput.files), folderId);

    const grid = el('div', { class: 'maps-grid' });
    const search = el('input', { type: 'search', class: 'search', placeholder: 'Rechercher une carte…', value: dashSearch, 'aria-label': 'Rechercher une carte' });

    function folderCard(f) {
      const nMaps = maps.filter((m) => m.folder_id === f.id).length;
      const nSub = folders.filter((x) => x.parent_id === f.id).length;
      const card = el('div', { class: 'map-card folder' }, [
        el('a', { class: 'title', href: '/?dossier=' + f.id, 'data-link': true }, [el('span', { class: 'folder-icon', 'aria-hidden': 'true' }), f.name]),
        el('div', { class: 'muted small', text: [nMaps + (nMaps > 1 ? ' cartes' : ' carte'), nSub ? nSub + (nSub > 1 ? ' dossiers' : ' dossier') : null].filter(Boolean).join(' · ') }),
        el('div', { class: 'actions' }, [
          el('button', { class: 'btn sm', text: 'Renommer', onclick: async () => {
            const name = await promptBox('Renommer le dossier', f.name, 'Renommer');
            if (name) { await api('PATCH', '/api/folders/' + f.id, { name }); dashboard(); }
          } }),
          el('button', { class: 'btn sm', text: 'Déplacer', onclick: () => chooseFolder(folders, { type: 'folder', id: f.id }) }),
          el('button', { class: 'btn sm danger', text: 'Supprimer', onclick: async () => {
            if (!(await confirmBox(`Supprimer le dossier « ${f.name} » ? Son contenu (cartes et sous-dossiers) sera remonté d'un niveau, rien n'est effacé.`, 'Supprimer le dossier'))) return;
            await api('DELETE', '/api/folders/' + f.id); toast('Dossier supprimé'); dashboard();
          } })
        ])
      ]);
      makeDraggable(card, { type: 'folder', id: f.id });
      makeDropTarget(card, f.id);
      return card;
    }

    function mapCard(m, showPath) {
      const where = showPath ? pathOf(m.folder_id).map((f) => f.name).join(' › ') : '';
      const card = el('div', { class: 'map-card' }, [
        el('a', { class: 'title', href: '/m/' + m.id, text: m.title || 'Sans titre' }),
        showPath ? el('div', { class: 'muted small', text: '📁 ' + (where || 'Mes cartes') }) : null,
        el('div', { class: 'muted small', text: 'Modifiée le ' + formatDate(m.updated_at) }),
        el('div', { class: 'actions' }, [
          el('button', { class: 'btn sm', text: 'Déplacer', onclick: () => chooseFolder(folders, { type: 'map', id: m.id }) }),
          el('button', { class: 'btn sm', text: 'Dupliquer', onclick: async () => { await api('POST', `/api/maps/${m.id}/duplicate`, {}); toast('Carte dupliquée'); dashboard(); } }),
          el('button', { class: 'btn sm danger', text: 'Supprimer', onclick: async () => {
            if (!(await confirmBox(`Supprimer « ${m.title} » et tous ses fichiers ? Cette action est définitive.`, 'Supprimer'))) return;
            await api('DELETE', '/api/maps/' + m.id); toast('Carte supprimée'); dashboard();
          } })
        ])
      ]);
      makeDraggable(card, { type: 'map', id: m.id });
      return card;
    }

    function renderGrid() {
      grid.replaceChildren();
      const q = norm(dashSearch.trim());
      if (q) {
        const found = maps.filter((m) => norm(m.title).includes(q));
        found.forEach((m) => grid.append(mapCard(m, true)));
        if (!found.length) grid.append(el('p', { class: 'muted', text: 'Aucune carte ne correspond à « ' + dashSearch.trim() + ' ».' }));
        return;
      }
      grid.append(el('div', { class: 'map-card new', tabindex: 0, onclick: () => createMap(folderId), onkeydown: (e) => { if (e.key === 'Enter') createMap(folderId); } }, '+ Nouvelle carte'));
      folders.filter((f) => f.parent_id === folderId).forEach((f) => grid.append(folderCard(f)));
      const here = maps.filter((m) => (m.folder_id == null ? null : m.folder_id) === folderId);
      here.forEach((m) => grid.append(mapCard(m, false)));
      if (!here.length && !folders.some((f) => f.parent_id === folderId))
        grid.append(el('p', { class: 'muted', style: 'align-self:center', text: folderId ? 'Ce dossier est vide : créez une carte ou glissez-en une sur son nom dans le fil d\'Ariane.' : 'Créez votre première carte ou importez un fichier XMind.' }));
    }
    search.addEventListener('input', () => { dashSearch = search.value; renderGrid(); });

    view.replaceChildren(el('div', { class: 'container' }, [
      el('div', { class: 'dash-head' }, [
        el('h1', { style: 'margin:0', text: trail.length ? trail[trail.length - 1].name : 'Mes cartes' }),
        el('span', { class: 'spacer' }),
        search
      ]),
      el('div', { class: 'toolbar' }, [
        crumbs,
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn', text: '+ Nouveau dossier', onclick: async () => {
          const name = await promptBox('Nouveau dossier', '', 'Créer');
          if (name) { await api('POST', '/api/folders', { name, parentId: folderId }); dashboard(); }
        } }),
        el('button', { class: 'btn', text: 'Importer XMind', onclick: () => importInput.click() }),
        el('button', { class: 'btn primary', text: '+ Nouvelle carte', onclick: () => createMap(folderId) }),
        importInput
      ]),
      grid
    ]));
    renderGrid();
  }

  async function moveItem(item, folderId) {
    try {
      if (item.type === 'map') await api('PATCH', '/api/maps/' + item.id, { folderId });
      else await api('PATCH', '/api/folders/' + item.id, { parentId: folderId });
      toast(item.type === 'map' ? 'Carte déplacée' : 'Dossier déplacé');
      dashboard();
    } catch (e) { toast(e.message, true); }
  }

  /** Fenêtre de choix du dossier de destination (arborescence complète). */
  function chooseFolder(folders, item) {
    const excluded = new Set();
    if (item.type === 'folder') {
      excluded.add(item.id);
      let added = true;
      while (added) { added = false; folders.forEach((f) => { if (excluded.has(f.parent_id) && !excluded.has(f.id)) { excluded.add(f.id); added = true; } }); }
    }
    const options = [el('option', { value: '', text: 'Mes cartes (racine)' })];
    (function walk(parent, depth) {
      folders.filter((f) => f.parent_id === parent && !excluded.has(f.id)).forEach((f) => {
        options.push(el('option', { value: String(f.id), text: '  '.repeat(depth + 1) + '📁 ' + f.name }));
        walk(f.id, depth + 1);
      });
    })(null, 0);
    const select = el('select', null, options);
    const ok = el('button', { class: 'btn primary', type: 'submit', text: 'Déplacer' });
    const form = el('form', null, [el('h2', { text: item.type === 'map' ? 'Déplacer la carte' : 'Déplacer le dossier' }), el('label', { class: 'field' }, ['Destination', select]),
      el('div', { class: 'row' }, [el('button', { class: 'btn', type: 'button', text: 'Annuler', onclick: () => m.close() }), ok])]);
    const m = modal(form);
    form.onsubmit = (e) => { e.preventDefault(); m.close(); moveItem(item, select.value ? Number(select.value) : null); };
  }

  async function importFiles(files, folderId) {
    if (!files.length) return;
    const ids = [];
    for (const f of files) {
      toast('Import de « ' + f.name + ' »…');
      try { ids.push(...(await window.XmindImport.importFile(f, { folderId, onProgress: (msg) => toast(msg) }))); }
      catch (e) { console.error(e); toast('Import impossible : ' + e.message, true); }
    }
    if (ids.length === 1) { location.href = '/m/' + ids[0]; return; }
    if (ids.length) toast(ids.length + ' cartes importées');
    dashboard();
  }

  async function createMap(folderId) {
    const title = await promptBox('Nouvelle carte', 'Idée centrale', 'Créer');
    if (title === null) return;
    const { id } = await api('POST', '/api/maps', { title: title || 'Idée centrale', folderId: folderId || null });
    location.href = '/m/' + id;
  }

  // ------------------------------------------------------------ Mon compte

  function account() {
    const err = el('div', { class: 'error' });
    const form = el('form', { class: 'card', style: 'max-width:460px' }, [
      el('h1', { text: 'Mon compte' }),
      el('p', { class: 'muted', text: me.email }),
      el('label', { class: 'field' }, ['Nom affiché', el('input', { type: 'text', name: 'name', value: me.name })]),
      el('h2', { style: 'margin-top:24px', text: 'Changer de mot de passe' }),
      el('label', { class: 'field' }, ['Mot de passe actuel', el('input', { type: 'password', name: 'currentPassword', autocomplete: 'current-password' })]),
      el('label', { class: 'field' }, ['Nouveau mot de passe', el('input', { type: 'password', name: 'newPassword', minlength: 8, autocomplete: 'new-password' })]),
      err,
      el('button', { class: 'btn primary', type: 'submit', text: 'Enregistrer' })
    ]);
    form.onsubmit = async (e) => {
      e.preventDefault();
      err.textContent = '';
      try {
        const r = await api('PATCH', '/api/auth/me', Object.fromEntries(new FormData(form)));
        me = r.user; renderUserArea(); toast('Modifications enregistrées'); account();
      } catch (ex) { err.textContent = ex.message; }
    };
    view.replaceChildren(el('div', { class: 'container' }, form));
  }

  // ------------------------------------------------------------ Administration

  async function adminPage() {
    if (me.role !== 'admin') return go('/');
    const [stats, { users }] = await Promise.all([api('GET', '/api/admin/stats'), api('GET', '/api/admin/users')]);
    const update = async (u, patch, msg) => {
      try { await api('PATCH', '/api/admin/users/' + u.id, patch); toast(msg); adminPage(); } catch (ex) { toast(ex.message, true); }
    };
    const rows = users.map((u) => el('tr', null, [
      el('td', null, [el('b', { text: u.name }), el('br'), el('span', { class: 'muted small', text: u.email })]),
      el('td', null, [
        el('span', { class: 'badge' + (u.role === 'admin' ? ' admin' : ''), text: u.role === 'admin' ? 'Admin' : 'Utilisateur' }), ' ',
        u.disabled ? el('span', { class: 'badge off', text: 'Désactivé' }) : null
      ]),
      el('td', { text: String(u.maps) }),
      el('td', { class: 'small', text: formatDate(u.created_at) }),
      el('td', { class: 'small', text: formatDate(u.last_login_at) }),
      el('td', null, el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap' }, [
        el('button', { class: 'btn sm', text: u.role === 'admin' ? 'Retirer admin' : 'Rendre admin',
          onclick: () => update(u, { role: u.role === 'admin' ? 'user' : 'admin' }, 'Rôle modifié') }),
        u.id !== me.id ? el('button', { class: 'btn sm', text: u.disabled ? 'Réactiver' : 'Désactiver',
          onclick: () => update(u, { disabled: !u.disabled }, u.disabled ? 'Compte réactivé' : 'Compte désactivé') }) : null,
        el('button', { class: 'btn sm', text: 'Mot de passe', onclick: async () => {
          const p = await promptBox(`Nouveau mot de passe pour ${u.email}`, '', 'Définir');
          if (p) update(u, { password: p }, 'Mot de passe modifié');
        } }),
        u.id !== me.id ? el('button', { class: 'btn sm danger', text: 'Supprimer', onclick: async () => {
          if (!(await confirmBox(`Supprimer ${u.email} et ses ${u.maps} carte(s) ? Action définitive.`, 'Supprimer'))) return;
          try { await api('DELETE', '/api/admin/users/' + u.id); toast('Utilisateur supprimé'); adminPage(); } catch (ex) { toast(ex.message, true); }
        } }) : null
      ]))
    ]));
    view.replaceChildren(el('div', { class: 'container' }, [
      el('h1', { text: 'Administration' }),
      el('div', { class: 'stats' }, [
        el('div', { class: 'stat' }, [el('b', { text: String(stats.users) }), 'utilisateurs']),
        el('div', { class: 'stat' }, [el('b', { text: String(stats.maps) }), 'cartes']),
        el('div', { class: 'stat' }, [el('b', { text: String(stats.files) }), 'fichiers']),
        el('div', { class: 'stat' }, [el('b', { text: formatSize(stats.storage) }), 'stockage'])
      ]),
      el('div', { class: 'card table-scroll' }, el('table', { class: 'data' }, [
        el('thead', null, el('tr', null, ['Utilisateur', 'Rôle', 'Cartes', 'Inscrit le', 'Dernière connexion', 'Actions'].map((h) => el('th', { text: h })))),
        el('tbody', null, rows)
      ]))
    ]));
  }

  // ------------------------------------------------------------ Routeur

  async function route() {
    const p = location.pathname;
    try {
      if (!me && p !== '/login' && p !== '/register') return go('/login' + (p !== '/' ? '?next=' + encodeURIComponent(p) : ''));
      if (me && (p === '/login' || p === '/register')) return go('/');
      if (p === '/login') return authPage('login');
      if (p === '/register') return signupOpen ? authPage('register') : go('/login');
      if (p === '/account') return account();
      if (p === '/admin') return adminPage();
      return dashboard();
    } catch (e) {
      if (e.status === 401) { me = null; renderUserArea(); return go('/login'); }
      toast(e.message, true);
    }
  }

  api('GET', '/api/auth/me').then((r) => {
    me = r.user;
    signupOpen = r.signupOpen;
    renderUserArea();
    route();
  }).catch(() => toast('Serveur injoignable', true));
})();
