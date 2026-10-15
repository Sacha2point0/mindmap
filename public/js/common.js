/* Utilitaires partagés entre les pages. */
(function () {
  'use strict';

  async function api(method, url, body, extraHeaders) {
    const opts = { method, headers: Object.assign({}, extraHeaders || {}), credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const res = await fetch(url, opts);
    let data = null;
    try { data = await res.json(); } catch (e) { /* réponse vide */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Erreur ' + res.status);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function el(tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach((k) => {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : v);
    });
    [].concat(children || []).forEach((c) => { if (c != null) n.append(c.nodeType ? c : document.createTextNode(c)); });
    return n;
  }

  let toastTimer;
  function toast(msg, isError) {
    let t = document.querySelector('.toast');
    if (!t) { t = el('div', { class: 'toast', role: 'status' }); document.body.append(t); }
    t.textContent = msg;
    t.classList.toggle('err', !!isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3000);
  }

  /** Fenêtre modale simple. content : élément DOM. Renvoie { close }. */
  function modal(content, onClose) {
    const back = el('div', { class: 'modal-back' }, el('div', { class: 'modal', role: 'dialog' }, content));
    function close() { back.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    const first = back.querySelector('input, textarea, select');
    if (first) setTimeout(() => { first.focus(); if (first.select) first.select(); }, 30);
    return { close };
  }

  function confirmBox(message, okLabel) {
    return new Promise((resolve) => {
      let done = false;
      const ok = el('button', { class: 'btn primary', text: okLabel || 'Confirmer' });
      const cancel = el('button', { class: 'btn', text: 'Annuler' });
      const m = modal(el('div', null, [el('p', { text: message }), el('div', { class: 'row' }, [cancel, ok])]), () => { if (!done) resolve(false); });
      ok.onclick = () => { done = true; m.close(); resolve(true); };
      cancel.onclick = () => m.close();
      setTimeout(() => ok.focus(), 30);
    });
  }

  function promptBox(title, value, okLabel) {
    return new Promise((resolve) => {
      let done = false;
      const input = el('input', { type: 'text', value: value || '' });
      const ok = el('button', { class: 'btn primary', type: 'submit', text: okLabel || 'Valider' });
      const cancel = el('button', { class: 'btn', type: 'button', text: 'Annuler' });
      const form = el('form', null, [el('h2', { text: title }), input, el('div', { class: 'row' }, [cancel, ok])]);
      const m = modal(form, () => { if (!done) resolve(null); });
      form.onsubmit = (e) => { e.preventDefault(); done = true; m.close(); resolve(input.value.trim()); };
      cancel.onclick = () => m.close();
    });
  }

  function formatDate(s) {
    if (!s) return '—';
    const d = new Date(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));
    return isNaN(d) ? '—' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatSize(n) {
    if (n < 1024) return n + ' o';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' Ko';
    return (n / 1024 / 1024).toFixed(1).replace('.', ',') + ' Mo';
  }

  window.App = { api, el, toast, modal, confirmBox, promptBox, formatDate, formatSize };
})();
