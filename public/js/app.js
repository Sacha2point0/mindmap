/* Pages hors éditeur : connexion, inscription, tableau de bord, compte, administration. */
(function () {
  'use strict';
  const { api, el, toast, confirmBox, promptBox, formatDate, formatSize } = window.App;
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

  // ------------------------------------------------------------ Tableau de bord

  async function dashboard() {
    const grid = el('div', { class: 'maps-grid' });
    view.replaceChildren(el('div', { class: 'container' }, [
      el('div', { style: 'display:flex;align-items:center;gap:12px;flex-wrap:wrap' }, [
        el('h1', { style: 'margin:0', text: 'Mes cartes' }), el('span', { class: 'spacer' }),
        el('button', { class: 'btn primary', text: '+ Nouvelle carte', onclick: createMap })
      ]),
      grid
    ]));
    const { maps } = await api('GET', '/api/maps');
    grid.append(el('div', { class: 'map-card new', tabindex: 0, onclick: createMap, onkeydown: (e) => { if (e.key === 'Enter') createMap(); } }, '+ Nouvelle carte'));
    maps.forEach((m) => grid.append(el('div', { class: 'map-card' }, [
      el('a', { class: 'title', href: '/m/' + m.id, text: m.title || 'Sans titre' }),
      el('div', { class: 'muted small', text: 'Modifiée le ' + formatDate(m.updated_at) }),
      el('div', { class: 'actions' }, [
        el('button', { class: 'btn sm', text: 'Dupliquer', onclick: async () => { await api('POST', `/api/maps/${m.id}/duplicate`, {}); toast('Carte dupliquée'); dashboard(); } }),
        el('button', { class: 'btn sm danger', text: 'Supprimer', onclick: async () => {
          if (!(await confirmBox(`Supprimer « ${m.title} » et tous ses fichiers ? Cette action est définitive.`, 'Supprimer'))) return;
          await api('DELETE', '/api/maps/' + m.id); toast('Carte supprimée'); dashboard();
        } })
      ])
    ])));
    if (!maps.length) grid.append(el('div', { class: 'muted', style: 'align-self:center', text: 'Créez votre première carte pour commencer.' }));
  }

  async function createMap() {
    const title = await promptBox('Nouvelle carte', 'Idée centrale', 'Créer');
    if (title === null) return;
    const { id } = await api('POST', '/api/maps', { title: title || 'Idée centrale' });
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
