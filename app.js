/**
 * Baraza — Frontend SPA
 * Compatible avec server.js + style.css
 */

const API = '';
const WS_PATH = '/ws';

// ---------- State ----------
const state = {
  token: localStorage.getItem('baraza_token') || null,
  user: null,
  view: 'feed', // feed | friends | messages | profile | admin | notifications
  posts: [],
  friends: [],
  requests: [],
  notifications: [],
  searchResults: [],
  messages: [],
  activeChatId: null,
  adminSummary: null,
  adminUsers: [],
  ws: null
};

// ---------- Helpers ----------
function $(sel, root = document) {
  return root.querySelector(sel);
}

function $$(sel, root = document) {
  return [...root.querySelectorAll(sel)];
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function timeAgo(ts) {
  const d = Date.now() - Number(ts || 0);
  if (d < 60_000) return 'à l’instant';
  if (d < 3_600_000) return Math.floor(d / 60_000) + ' min';
  if (d < 86_400_000) return Math.floor(d / 3_600_000) + ' h';
  return Math.floor(d / 86_400_000) + ' j';
}

function avatarLetter(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

function authHeaders() {
  return state.token
    ? { Authorization: `Bearer ${state.token}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

function setToken(token) {
  state.token = token;
  if (token) localStorage.setItem('baraza_token', token);
  else localStorage.removeItem('baraza_token');
}

// ---------- WebSocket ----------
function connectWS() {
  if (!state.token) return;
  try {
    if (state.ws) {
      try { state.ws.close(); } catch {}
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${WS_PATH}?token=${encodeURIComponent(state.token)}`);
    state.ws = ws;

    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'notification') {
          state.notifications.unshift(msg.notification);
          if (state.view === 'notifications' || state.view === 'feed') render();
        }
        if (msg.type === 'message' && state.view === 'messages') {
          if (
            state.activeChatId &&
            (msg.message.from === state.activeChatId || msg.message.to === state.activeChatId)
          ) {
            state.messages.push(msg.message);
            renderMessagesPanel();
          }
        }
        if (msg.type === 'friend-request' || msg.type === 'friend-accepted') {
          loadFriends().then(() => {
            if (state.view === 'friends' || state.view === 'feed') render();
          });
        }
      } catch {}
    };

    ws.onclose = () => {
      setTimeout(connectWS, 4000);
    };
  } catch (e) {
    console.warn('WS error', e);
  }
}

// ---------- Data loaders ----------
async function loadMe() {
  state.user = await api('/api/me');
}

async function loadPosts() {
  state.posts = await api('/api/posts');
}

async function loadFriends() {
  state.friends = await api('/api/friends');
  state.requests = await api('/api/friends/requests');
}

async function loadNotifications() {
  state.notifications = await api('/api/notifications');
}

async function loadMessages(friendId) {
  state.messages = await api(`/api/messages/${friendId}`);
}

async function loadAdmin() {
  state.adminSummary = await api('/api/admin/summary');
  state.adminUsers = await api('/api/admin/users');
}

// ---------- Auth UI ----------
function renderAuth() {
  const app = $('#app');
  app.innerHTML = `
    <div class="auth-wrap">
      <div class="auth-card">
        <div class="brand-lockup">
          <div class="brand-mark">B</div>
          <div>
            <div class="brand-kicker">Réseau social</div>
            <h1>Baraza</h1>
          </div>
        </div>
        <div class="auth-panel">
          <div class="auth-tabs">
            <button type="button" class="active" data-tab="login">Connexion</button>
            <button type="button" data-tab="register">Inscription</button>
          </div>
          <form class="auth-form" id="loginForm">
            <input name="username" placeholder="Nom d’utilisateur" autocomplete="username" required />
            <input name="password" type="password" placeholder="Mot de passe" autocomplete="current-password" required />
            <div class="form-error" id="authError"></div>
            <button type="submit" class="primary-btn wide">Se connecter</button>
          </form>
          <form class="auth-form hidden" id="registerForm">
            <input name="username" placeholder="Nom d’utilisateur" autocomplete="username" required />
            <input name="name" placeholder="Nom affiché" autocomplete="name" required />
            <input name="password" type="password" placeholder="Mot de passe (≥ 4 car.)" autocomplete="new-password" required minlength="4" />
            <div class="form-error" id="regError"></div>
            <button type="submit" class="primary-btn wide">Créer mon compte</button>
          </form>
        </div>
      </div>
    </div>
  `;

  const tabs = $$('.auth-tabs button');
  const loginForm = $('#loginForm');
  const registerForm = $('#registerForm');

  tabs.forEach((btn) => {
    btn.addEventListener('click', () => {
      tabs.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      loginForm.classList.toggle('hidden', tab !== 'login');
      registerForm.classList.toggle('hidden', tab !== 'register');
      $('#authError').textContent = '';
      $('#regError').textContent = '';
    });
  });

  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(loginForm);
    const err = $('#authError');
    err.textContent = '';
    try {
      const data = await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          username: fd.get('username'),
          password: fd.get('password')
        })
      });
      setToken(data.token);
      state.user = data.user;
      connectWS();
      await bootApp();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });

  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(registerForm);
    const err = $('#regError');
    err.textContent = '';
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: JSON.stringify({
          username: fd.get('username'),
          name: fd.get('name'),
          password: fd.get('password')
        })
      });
      setToken(data.token);
      state.user = data.user;
      connectWS();
      await bootApp();
    } catch (ex) {
      err.textContent = ex.message;
    }
  });
}

// ---------- Main shell ----------
function topbarHTML() {
  const isAdmin = state.user?.role === 'admin';
  return `
    <header class="topbar">
      <div class="topbar-left">
        <div class="brand-mark" style="width:42px;height:42px;font-size:1.1rem;border-radius:14px">B</div>
        <div class="topbar-title">
          <small>Baraza</small>
          <strong>${escapeHtml(state.user?.name || '')}</strong>
        </div>
      </div>
      <div class="topbar-actions">
        <nav class="nav-pills">
          <button type="button" data-view="feed" class="${state.view === 'feed' ? 'active' : ''}">Fil</button>
          <button type="button" data-view="friends" class="${state.view === 'friends' ? 'active' : ''}">Amis</button>
          <button type="button" data-view="messages" class="${state.view === 'messages' ? 'active' : ''}">Messages</button>
          <button type="button" data-view="notifications" class="${state.view === 'notifications' ? 'active' : ''}">Notifs</button>
          <button type="button" data-view="profile" class="${state.view === 'profile' ? 'active' : ''}">Profil</button>
          ${isAdmin ? `<button type="button" data-view="admin" class="${state.view === 'admin' ? 'active' : ''}">Admin</button>` : ''}
        </nav>
        <div class="searchbox">
          <input type="search" id="globalSearch" placeholder="Rechercher des personnes…" />
        </div>
        <button type="button" class="ghost-btn" id="logoutBtn">Déconnexion</button>
      </div>
    </header>
  `;
}

function profileCardHTML() {
  const u = state.user;
  return `
    <div class="panel-card profile-card">
      <div class="profile-header">
        <div class="avatar">${escapeHtml(avatarLetter(u?.name))}</div>
        <div>
          <div class="profile-name">${escapeHtml(u?.name || '')}</div>
          <div class="profile-handle">@${escapeHtml(u?.username || '')}</div>
        </div>
      </div>
      <p class="profile-bio">${escapeHtml(u?.bio || 'Aucune bio pour le moment.')}</p>
      <div class="mini-stats">
        <div class="mini-stat"><strong>${state.friends.length}</strong><span>Amis</span></div>
        <div class="mini-stat"><strong>${state.posts.filter((p) => p.userId === u?.id).length}</strong><span>Posts</span></div>
      </div>
    </div>
  `;
}

function peopleListHTML(title, list, actionLabel, actionType) {
  if (!list.length) {
    return `
      <div class="panel-card">
        <h3 class="section-title">${title}</h3>
        <p class="empty-mini">Rien pour le moment.</p>
      </div>
    `;
  }
  return `
    <div class="panel-card">
      <h3 class="section-title">${title}</h3>
      <div class="people-list">
        ${list
          .map(
            (p) => `
          <div class="person-row" data-id="${escapeHtml(p.id)}">
            <div class="mini-avatar">${escapeHtml(avatarLetter(p.name))}</div>
            <div class="person-meta">
              <strong>${escapeHtml(p.name)}</strong>
              <span>@${escapeHtml(p.username)}</span>
            </div>
            ${
              actionLabel
                ? `<button type="button" class="friend-btn" data-action="${actionType}" data-id="${escapeHtml(p.id)}">${actionLabel}</button>`
                : ''
            }
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;
}

function postCardHTML(post) {
  const author = post.author || {};
  return `
    <article class="post-card" data-post-id="${escapeHtml(post.id)}">
      <div class="post-head">
        <div class="avatar">${escapeHtml(avatarLetter(author.name))}</div>
        <div class="post-info">
          <div class="post-author">${escapeHtml(author.name || 'Utilisateur')}</div>
          <div class="post-time">@${escapeHtml(author.username || '')} · ${timeAgo(post.createdAt)}</div>
        </div>
      </div>
      ${post.sharedFrom ? `<div class="shared-tag">Partagé</div>` : ''}
      <div class="post-body">${escapeHtml(post.text)}</div>
      ${post.image ? `<img class="post-image" src="${escapeHtml(post.image)}" alt="Image du post" />` : ''}
      <div class="post-actions">
        <button type="button" class="ghost-btn ${post.likedByMe ? 'active' : ''}" data-action="like" data-id="${escapeHtml(post.id)}">
          ♥ ${post.likesCount || 0}
        </button>
        <button type="button" class="ghost-btn" data-action="comment-toggle" data-id="${escapeHtml(post.id)}">
          💬 ${post.commentsCount || 0}
        </button>
        <button type="button" class="ghost-btn" data-action="share" data-id="${escapeHtml(post.id)}">
          ↗ ${post.sharesCount || 0}
        </button>
      </div>
      <div class="comment-list" id="comments-${escapeHtml(post.id)}">
        ${(post.comments || [])
          .map(
            (c) => `
          <div class="comment-item">
            <strong>${escapeHtml(c.author?.name || 'Anon')}</strong>
            <span>${escapeHtml(c.text)}</span>
          </div>
        `
          )
          .join('')}
      </div>
      <form class="comment-form" data-post-id="${escapeHtml(post.id)}">
        <input name="text" placeholder="Écrire un commentaire…" required />
        <button type="submit" class="primary-btn small">Envoyer</button>
      </form>
    </article>
  `;
}

function composerHTML() {
  return `
    <div class="panel-card composer-card">
      <div class="composer-header">
        <div class="mini-avatar">${escapeHtml(avatarLetter(state.user?.name))}</div>
        <div class="composer-title">Quoi de neuf ?</div>
      </div>
      <form id="composerForm">
        <textarea name="text" placeholder="Partagez une idée, une photo…"></textarea>
        <input type="url" name="image" placeholder="URL d’une image (optionnel)" />
        <div class="composer-tools">
          <span class="empty-mini">Texte ou image requis</span>
          <button type="submit" class="primary-btn">Publier</button>
        </div>
      </form>
    </div>
  `;
}

function trendsHTML() {
  const trends = [
    { tag: '#Baraza', count: 'Tendance' },
    { tag: '#Afrique', count: 'Populaire' },
    { tag: '#Tech', count: 'En hausse' }
  ];
  return `
    <div class="panel-card">
      <h3 class="section-title">Tendances</h3>
      <ul class="trend-list">
        ${trends
          .map(
            (t) => `
          <li><span>${escapeHtml(t.tag)}</span><strong>${escapeHtml(t.count)}</strong></li>
        `
          )
          .join('')}
      </ul>
    </div>
  `;
}

function notifPreviewHTML() {
  const items = state.notifications.slice(0, 5);
  if (!items.length) {
    return `
      <div class="panel-card">
        <h3 class="section-title">Notifications</h3>
        <p class="empty-mini">Aucune notification.</p>
      </div>
    `;
  }
  return `
    <div class="panel-card">
      <h3 class="section-title">Notifications</h3>
      <ul class="notification-list">
        ${items
          .map(
            (n) => `
          <li class="notification-item">
            <strong>${escapeHtml(n.type)}</strong>
            <span>${escapeHtml(n.message)}</span>
          </li>
        `
          )
          .join('')}
      </ul>
    </div>
  `;
}

function renderFeed() {
  return `
    <div class="dashboard">
      <aside class="left-panel">
        ${profileCardHTML()}
        ${peopleListHTML('Demandes d’amis', state.requests, 'Accepter', 'accept')}
        ${peopleListHTML('Suggestions', state.searchResults.slice(0, 5), 'Ajouter', 'request')}
      </aside>
      <main class="center-panel">
        ${composerHTML()}
        <div class="feed-wrap">
          ${
            state.posts.length
              ? state.posts.map(postCardHTML).join('')
              : '<div class="panel-card empty-state">Aucune publication pour le moment. Soyez le premier !</div>'
          }
        </div>
      </main>
      <aside class="right-panel">
        ${trendsHTML()}
        ${notifPreviewHTML()}
      </aside>
    </div>
  `;
}

function renderFriends() {
  return `
    <div class="friends-layout" style="margin-top:24px">
      <div class="panel-card">
        <h3 class="section-title">Mes amis (${state.friends.length})</h3>
        <div class="friend-list">
          ${
            state.friends.length
              ? state.friends
                  .map(
                    (f) => `
            <div class="friend-card">
              <div class="friend-meta">
                <div class="mini-avatar">${escapeHtml(avatarLetter(f.name))}</div>
                <div>
                  <strong>${escapeHtml(f.name)}</strong>
                  <div class="profile-handle">@${escapeHtml(f.username)}</div>
                </div>
              </div>
              <div class="friend-actions">
                <button type="button" class="ghost-btn" data-action="chat" data-id="${escapeHtml(f.id)}">Message</button>
                <button type="button" class="ghost-btn" data-action="remove" data-id="${escapeHtml(f.id)}">Retirer</button>
              </div>
            </div>
          `
                  )
                  .join('')
              : '<p class="empty-state">Vous n’avez pas encore d’amis.</p>'
          }
        </div>
      </div>
      <div>
        ${peopleListHTML('Demandes reçues', state.requests, 'Accepter', 'accept')}
        <div class="panel-card" style="margin-top:18px">
          <h3 class="section-title">Rechercher</h3>
          <input type="search" id="friendSearch" placeholder="Nom ou @utilisateur" />
          <div class="people-list" id="friendSearchResults" style="margin-top:12px"></div>
        </div>
      </div>
    </div>
  `;
}

function renderMessagesPanel() {
  const friend = state.friends.find((f) => f.id === state.activeChatId);
  const list = state.friends
    .map(
      (f) => `
    <button type="button" class="person-row" data-action="open-chat" data-id="${escapeHtml(f.id)}"
      style="width:100%;text-align:left;cursor:pointer;border:1px solid var(--line);background:${f.id === state.activeChatId ? 'rgba(244,200,103,0.08)' : 'rgba(255,255,255,0.02)'}">
      <div class="mini-avatar">${escapeHtml(avatarLetter(f.name))}</div>
      <div class="person-meta">
        <strong>${escapeHtml(f.name)}</strong>
        <span>@${escapeHtml(f.username)}</span>
      </div>
    </button>
  `
    )
    .join('');

  const thread = state.messages
    .map((m) => {
      const mine = m.from === state.user.id;
      return `
      <div class="chat-message ${mine ? 'mine' : ''}">
        <div class="chat-bubble">${escapeHtml(m.text || (m.image ? '[Image]' : ''))}</div>
      </div>
    `;
    })
    .join('');

  return `
    <div class="messages-layout">
      <div class="panel-card">
        <h3 class="section-title">Conversations</h3>
        <div class="chat-list">${list || '<p class="empty-mini">Ajoutez des amis pour discuter.</p>'}</div>
      </div>
      <div class="panel-card chat-panel">
        <h3 class="section-title">${friend ? escapeHtml(friend.name) : 'Sélectionnez une conversation'}</h3>
        <div class="chat-thread" id="chatThread">${thread || '<p class="empty-mini">Aucun message.</p>'}</div>
        ${
          friend
            ? `
          <form class="message-form" id="messageForm">
            <input name="text" placeholder="Votre message…" required autocomplete="off" />
            <button type="submit" class="primary-btn">Envoyer</button>
          </form>
        `
            : ''
        }
      </div>
    </div>
  `;
}

function renderNotifications() {
  return `
    <div class="notifications-panel">
      <div class="panel-card">
        <h3 class="section-title">Toutes les notifications</h3>
        ${
          state.notifications.length
            ? state.notifications
                .map(
                  (n) => `
          <div class="notification-entry ${n.read ? '' : 'unread'}" data-id="${escapeHtml(n.id)}">
            <div>
              <div class="notification-title">${escapeHtml(n.type)}</div>
              <div class="notification-message">${escapeHtml(n.message)}</div>
            </div>
            <div class="notification-meta">
              <span>${timeAgo(n.createdAt)}</span>
              ${!n.read ? `<button type="button" class="chip-btn" data-action="read-notif" data-id="${escapeHtml(n.id)}">Lu</button>` : ''}
            </div>
          </div>
        `
                )
                .join('')
            : '<p class="empty-state">Aucune notification.</p>'
        }
      </div>
    </div>
  `;
}

function renderProfile() {
  const u = state.user;
  return `
    <div class="profile-layout" style="margin-top:24px">
      <div class="panel-card profile-summary">
        <div class="profile-header">
          <div class="avatar">${escapeHtml(avatarLetter(u?.name))}</div>
          <div>
            <div class="profile-name">${escapeHtml(u?.name || '')}</div>
            <div class="profile-handle">@${escapeHtml(u?.username || '')}</div>
          </div>
        </div>
        <div class="profile-summary-grid">
          <div class="summary-box"><strong>${state.friends.length}</strong><span>Amis</span></div>
          <div class="summary-box"><strong>${state.posts.filter((p) => p.userId === u?.id).length}</strong><span>Publications</span></div>
        </div>
      </div>
      <div class="panel-card">
        <h3 class="section-title">Modifier le profil</h3>
        <form id="profileForm">
          <input name="name" placeholder="Nom affiché" value="${escapeHtml(u?.name || '')}" required />
          <textarea name="bio" placeholder="Bio">${escapeHtml(u?.bio || '')}</textarea>
          <input name="avatar" placeholder="URL avatar (optionnel)" value="${escapeHtml(u?.avatar || '')}" />
          <input name="password" type="password" placeholder="Nouveau mot de passe (laisser vide pour ne pas changer)" />
          <button type="submit" class="primary-btn wide">Enregistrer</button>
        </form>
        <button type="button" class="ghost-btn" id="deleteAccountBtn" style="margin-top:14px;color:var(--danger);width:100%">
          Supprimer mon compte
        </button>
      </div>
    </div>
  `;
}

function renderAdmin() {
  const s = state.adminSummary || {};
  return `
    <div class="admin-grid">
      <div class="panel-card">
        <h3 class="section-title">Résumé</h3>
        <div class="admin-summary-grid">
          <div class="summary-box"><strong>${s.totalUsers ?? '—'}</strong><span>Utilisateurs</span></div>
          <div class="summary-box"><strong>${s.totalPosts ?? '—'}</strong><span>Posts</span></div>
          <div class="summary-box"><strong>${s.totalFriends ?? '—'}</strong><span>Liens d’amitié</span></div>
          <div class="summary-box"><strong>${s.totalMessages ?? '—'}</strong><span>Messages</span></div>
        </div>
      </div>
      <div class="panel-card">
        <h3 class="section-title">Utilisateurs</h3>
        <div class="admin-user-list">
          ${(state.adminUsers || [])
            .map(
              (u) => `
            <div class="admin-user-row">
              <div>
                <strong>${escapeHtml(u.name)}</strong>
                <span>@${escapeHtml(u.username)} · ${escapeHtml(u.role)}</span>
              </div>
              <div class="admin-user-actions">
                <select data-user-id="${escapeHtml(u.id)}" class="role-select">
                  <option value="user" ${u.role === 'user' ? 'selected' : ''}>user</option>
                  <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
                </select>
              </div>
            </div>
          `
            )
            .join('')}
        </div>
      </div>
    </div>
  `;
}

// ---------- Main render ----------
function render() {
  const app = $('#app');
  if (!state.user) {
    renderAuth();
    return;
  }

  let body = '';
  switch (state.view) {
    case 'friends':
      body = renderFriends();
      break;
    case 'messages':
      body = renderMessagesPanel();
      break;
    case 'notifications':
      body = renderNotifications();
      break;
    case 'profile':
      body = renderProfile();
      break;
    case 'admin':
      body = renderAdmin();
      break;
    default:
      body = renderFeed();
  }

  app.innerHTML = `
    <div class="app-shell">
      ${topbarHTML()}
      ${body}
    </div>
  `;

  bindEvents();
}

function bindEvents() {
  // Navigation
  $$('[data-view]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.view = btn.dataset.view;
      try {
        if (state.view === 'feed') {
          await Promise.all([loadPosts(), loadFriends(), loadNotifications()]);
        } else if (state.view === 'friends') {
          await loadFriends();
        } else if (state.view === 'messages') {
          await loadFriends();
        } else if (state.view === 'notifications') {
          await loadNotifications();
        } else if (state.view === 'admin') {
          await loadAdmin();
        } else if (state.view === 'profile') {
          await loadMe();
        }
      } catch (e) {
        console.warn(e);
      }
      render();
    });
  });

  $('#logoutBtn')?.addEventListener('click', () => {
    setToken(null);
    state.user = null;
    if (state.ws) try { state.ws.close(); } catch {}
    renderAuth();
  });

  // Global search
  const search = $('#globalSearch');
  if (search) {
    let t;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = search.value.trim();
        if (q.length < 2) {
          state.searchResults = [];
          if (state.view === 'feed') render();
          return;
        }
        try {
          state.searchResults = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
          if (state.view === 'feed') render();
        } catch {}
      }, 300);
    });
  }

  // Composer
  $('#composerForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/posts', {
        method: 'POST',
        body: JSON.stringify({
          text: fd.get('text'),
          image: fd.get('image')
        })
      });
      await loadPosts();
      render();
    } catch (ex) {
      alert(ex.message);
    }
  });

  // Post actions
  $$('[data-action="like"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/posts/${btn.dataset.id}/like`, { method: 'POST', body: '{}' });
        await loadPosts();
        render();
      } catch (ex) {
        alert(ex.message);
      }
    });
  });

  $$('[data-action="share"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/posts/${btn.dataset.id}/share`, { method: 'POST', body: '{}' });
        await loadPosts();
        render();
      } catch (ex) {
        alert(ex.message);
      }
    });
  });

  $$('.comment-form').forEach((form) => {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      try {
        await api(`/api/posts/${form.dataset.postId}/comment`, {
          method: 'POST',
          body: JSON.stringify({ text: fd.get('text') })
        });
        await loadPosts();
        render();
      } catch (ex) {
        alert(ex.message);
      }
    });
  });

  // Friends actions
  $$('[data-action="accept"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/friends/accept', {
          method: 'POST',
          body: JSON.stringify({ userId: btn.dataset.id })
        });
        await loadFriends();
        render();
      } catch (ex) {
        alert(ex.message);
      }
    });
  });

  $$('[data-action="request"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('/api/friends/request', {
          method: 'POST',
          body: JSON.stringify({ userId: btn.dataset.id })
        });
        alert('Demande envoyée');
        state.searchResults = state.searchResults.filter((u) => u.id !== btn.dataset.id);
        render();
      } catch (ex) {
        alert(ex.message);
      }
    });
  });

  $$('[data-action="remove"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Retirer cet ami ?')) return;
      try {
        await api('/api/friends/remove', {
          method: 'POST',
          body: JSON.stringify({ userId: btn.dataset.id })
        });
        await loadFriends();
        render();
      } catch (ex) {
        alert(ex.message);
      }
    });
  });

  $$('[data-action="chat"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.view = 'messages';
      state.activeChatId = btn.dataset.id;
      await loadMessages(state.activeChatId);
      render();
    });
  });

  // Friend search (friends view)
  const friendSearch = $('#friendSearch');
  if (friendSearch) {
    let t;
    friendSearch.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const q = friendSearch.value.trim();
        const box = $('#friendSearchResults');
        if (!box) return;
        if (q.length < 2) {
          box.innerHTML = '';
          return;
        }
        try {
          const results = await api(`/api/users/search?q=${encodeURIComponent(q)}`);
          box.innerHTML = results
            .map(
              (p) => `
            <div class="person-row">
              <div class="mini-avatar">${escapeHtml(avatarLetter(p.name))}</div>
              <div class="person-meta">
                <strong>${escapeHtml(p.name)}</strong>
                <span>@${escapeHtml(p.username)}</span>
              </div>
              <button type="button" class="friend-btn" data-action="request" data-id="${escapeHtml(p.id)}">Ajouter</button>
            </div>
          `
            )
            .join('');
          box.querySelectorAll('[data-action="request"]').forEach((btn) => {
            btn.addEventListener('click', async () => {
              try {
                await api('/api/friends/request', {
                  method: 'POST',
                  body: JSON.stringify({ userId: btn.dataset.id })
                });
                alert('Demande envoyée');
                btn.disabled = true;
                btn.textContent = 'Envoyé';
              } catch (ex) {
                alert(ex.message);
              }
            });
          });
        } catch {}
      }, 300);
    });
  }

  // Messages
  $$('[data-action="open-chat"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      state.activeChatId = btn.dataset.id;
      await loadMessages(state.activeChatId);
      render();
    });
  });

  $('#messageForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const msg = await api('/api/messages', {
        method: 'POST',
        body: JSON.stringify({
          toUserId: state.activeChatId,
          type: 'text',
          text: fd.get('text')
        })
      });
      state.messages.push(msg);
      e.target.reset();
      render();
      const thread = $('#chatThread');
      if (thread) thread.scrollTop = thread.scrollHeight;
    } catch (ex) {
      alert(ex.message);
    }
  });

  // Notifications read
  $$('[data-action="read-notif"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api(`/api/notifications/${btn.dataset.id}/read`, { method: 'POST', body: '{}' });
        await loadNotifications();
        render();
      } catch (ex) {
        alert(ex.message);
      }
    });
  });

  // Profile form
  $('#profileForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
      name: fd.get('name'),
      bio: fd.get('bio'),
      avatar: fd.get('avatar')
    };
    const pwd = fd.get('password');
    if (pwd) body.password = pwd;
    try {
      state.user = await api('/api/me', { method: 'PUT', body: JSON.stringify(body) });
      alert('Profil mis à jour');
      render();
    } catch (ex) {
      alert(ex.message);
    }
  });

  $('#deleteAccountBtn')?.addEventListener('click', async () => {
    if (!confirm('Supprimer définitivement votre compte ?')) return;
    try {
      await api('/api/me', { method: 'DELETE' });
      setToken(null);
      state.user = null;
      renderAuth();
    } catch (ex) {
      alert(ex.message);
    }
  });

  // Admin role change
  $$('.role-select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      try {
        await api(`/api/admin/users/${sel.dataset.userId}/role`, {
          method: 'POST',
          body: JSON.stringify({ role: sel.value })
        });
        await loadAdmin();
        render();
      } catch (ex) {
        alert(ex.message);
      }
    });
  });
}

// ---------- Boot ----------
async function bootApp() {
  try {
    await loadMe();
    await Promise.all([loadPosts(), loadFriends(), loadNotifications()]);
    state.view = 'feed';
    render();
  } catch (e) {
    console.warn('Session invalide', e);
    setToken(null);
    state.user = null;
    renderAuth();
  }
}

async function init() {
  if (state.token) {
    connectWS();
    await bootApp();
  } else {
    renderAuth();
  }
}

init();
