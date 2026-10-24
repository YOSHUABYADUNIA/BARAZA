import express from 'express';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config Render-ready ---
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-use-long-random-string';
const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';
const DATA_FILE = process.env.DATA_PATH || path.join(__dirname, 'data.json');

let db = {
  users: [],
  friends: [],
  messages: [],
  posts: [],
  notifications: [],
  nextId: 1
};

function normalizeUserRole(role) {
  return role === 'admin' ? 'admin' : 'user';
}

function ensureDataFile() {
  try {
    if (!fs.existsSync(DATA_FILE)) {
      fs.writeFileSync(
        DATA_FILE,
        JSON.stringify(
          { users: [], friends: [], messages: [], posts: [], notifications: [], nextId: 1 },
          null,
          2
        )
      );
    }
  } catch (error) {
    console.warn('Impossible de créer data.json:', error.message);
  }
}

function load() {
  try {
    ensureDataFile();
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    db = {
      users: Array.isArray(parsed.users)
        ? parsed.users.map((u) => ({ ...u, role: normalizeUserRole(u.role) }))
        : [],
      friends: Array.isArray(parsed.friends) ? parsed.friends : [],
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
      notifications: Array.isArray(parsed.notifications) ? parsed.notifications : [],
      nextId: Number(parsed.nextId) || 1
    };
  } catch (error) {
    console.warn('Erreur de lecture de data.json, réinitialisation:', error.message);
    db = { users: [], friends: [], messages: [], posts: [], notifications: [], nextId: 1 };
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
    } catch (saveError) {
      console.warn('Impossible d’écrire le fichier de données:', saveError.message);
    }
  }
}

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  } catch (error) {
    console.warn('Impossible de sauvegarder les données:', error.message);
  }
}

load();
setInterval(save, 5000);

const uid = () => 'u' + db.nextId++;
const postUid = () => 'p' + db.nextId++;
const commentUid = () => 'c' + db.nextId++;
const notificationUid = () => 'n' + db.nextId++;

const app = express();
app.use(express.json({ limit: '20mb' }));

// Servir les fichiers statiques (HTML, CSS, JS frontend)
app.use(express.static(__dirname, { index: false }));

// SPA: page d'accueil
app.get(['/', '/index.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const sockets = new Map();

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'non authentifié' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    return next();
  } catch {
    return res.status(401).json({ error: 'session expirée' });
  }
}

function requireAdmin(req, res, next) {
  const user = getUser(req.user.id);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'accès administrateur requis' });
  }
  return next();
}

function pubUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    name: u.name,
    bio: u.bio || '',
    avatar: u.avatar || '',
    createdAt: u.createdAt,
    role: normalizeUserRole(u.role)
  };
}

function getUser(userId) {
  return db.users.find((u) => u.id === userId) || null;
}

function getPostAuthor(post) {
  return pubUser(getUser(post.userId));
}

function serializePost(post, currentUserId = null) {
  const author = getPostAuthor(post);
  const likes = Array.isArray(post.likes) ? post.likes : [];
  const comments = Array.isArray(post.comments) ? post.comments : [];
  const shares = Array.isArray(post.shares) ? post.shares : [];

  return {
    id: post.id,
    userId: post.userId,
    text: post.text || '',
    image: post.image || '',
    createdAt: post.createdAt,
    visibility: post.visibility || 'public',
    author,
    likedByMe: currentUserId ? likes.includes(currentUserId) : false,
    likesCount: likes.length,
    comments: comments.map((comment) => ({
      id: comment.id,
      userId: comment.userId,
      text: comment.text || '',
      createdAt: comment.createdAt,
      author: pubUser(getUser(comment.userId))
    })),
    commentsCount: comments.length,
    sharesCount: shares.length,
    sharedFrom: post.sharedFrom || null
  };
}

function createNotification(userId, type, message, meta = {}) {
  if (!userId || !message) return null;
  const notification = {
    id: notificationUid(),
    userId,
    type,
    message,
    meta: meta || {},
    read: false,
    createdAt: Date.now()
  };
  db.notifications.push(notification);
  save();

  const ws = sockets.get(userId);
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify({ type: 'notification', notification }));
    } catch {}
  }

  return notification;
}

function getUserNotifications(userId) {
  return [...db.notifications]
    .filter((n) => n.userId === userId)
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, 200);
}

function sendTo(userId, obj) {
  const ws = sockets.get(userId);
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }
}

// ---------- Auth ----------
app.post('/api/register', async (req, res) => {
  try {
    const { username, name, password } = req.body || {};
    if (!username || !name || !password || password.length < 4) {
      return res.status(400).json({ error: 'champs invalides (mot de passe ≥ 4 caractères)' });
    }

    const normalizedUsername = String(username).trim();
    if (db.users.find((u) => u.username.toLowerCase() === normalizedUsername.toLowerCase())) {
      return res.status(409).json({ error: "nom d'utilisateur déjà pris" });
    }

    const role =
      process.env.ADMIN_USERNAME &&
      normalizedUsername.toLowerCase() === String(process.env.ADMIN_USERNAME).trim().toLowerCase()
        ? 'admin'
        : 'user';

    const user = {
      id: uid(),
      username: normalizedUsername,
      name: String(name).trim(),
      passwordHash: await bcrypt.hash(password, 10),
      bio: '',
      avatar: '',
      createdAt: Date.now(),
      role
    };

    db.users.push(user);
    save();

    createNotification(user.id, 'welcome', 'Bienvenue dans Baraza ! Votre compte a été créé avec succès.', {
      role
    });

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '365d' });
    return res.json({ token, user: pubUser(user) });
  } catch (err) {
    console.error('register error:', err);
    return res.status(500).json({ error: 'erreur serveur' });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const user = db.users.find(
      (u) => u.username.toLowerCase() === String(username || '').trim().toLowerCase()
    );

    if (!user || !(await bcrypt.compare(password || '', user.passwordHash))) {
      return res.status(401).json({ error: 'identifiants incorrects' });
    }

    const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: '365d' });
    return res.json({ token, user: pubUser(user) });
  } catch (err) {
    console.error('login error:', err);
    return res.status(500).json({ error: 'erreur serveur' });
  }
});

// ---------- Profil ----------
app.get('/api/me', auth, (req, res) => {
  const u = db.users.find((x) => x.id === req.user.id);
  if (!u) return res.status(404).json({ error: 'compte introuvable' });
  return res.json(pubUser(u));
});

app.put('/api/me', auth, async (req, res) => {
  try {
    const u = db.users.find((x) => x.id === req.user.id);
    if (!u) return res.status(404).json({ error: 'compte introuvable' });

    const { name, bio, avatar, password } = req.body || {};
    if (name) u.name = String(name).slice(0, 50).trim();
    if (bio !== undefined) u.bio = String(bio).slice(0, 200);
    if (avatar !== undefined) u.avatar = String(avatar).slice(0, 500000);
    if (password && String(password).length >= 4) {
      u.passwordHash = await bcrypt.hash(String(password), 10);
    }

    save();
    return res.json(pubUser(u));
  } catch (err) {
    console.error('update me error:', err);
    return res.status(500).json({ error: 'erreur serveur' });
  }
});

app.delete('/api/me', auth, (req, res) => {
  const id = req.user.id;
  db.users = db.users.filter((u) => u.id !== id);
  db.friends = db.friends.filter((f) => f.a !== id && f.b !== id);
  db.messages = db.messages.filter((m) => m.from !== id && m.to !== id);
  db.posts = db.posts.filter((p) => p.userId !== id);
  db.notifications = db.notifications.filter((n) => n.userId !== id);
  save();

  const ws = sockets.get(id);
  if (ws) {
    try {
      ws.close();
    } catch {}
  }
  sockets.delete(id);
  return res.json({ ok: true });
});

// ---------- Recherche utilisateurs ----------
app.get('/api/users/search', auth, (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);

  const results = db.users
    .filter(
      (u) =>
        u.id !== req.user.id &&
        (u.username.toLowerCase().includes(q) || u.name.toLowerCase().includes(q))
    )
    .slice(0, 20)
    .map(pubUser);

  return res.json(results);
});

// ---------- Amis ----------
function friendRow(a, b) {
  return db.friends.find((f) => (f.a === a && f.b === b) || (f.a === b && f.b === a));
}

app.get('/api/friends', auth, (req, res) => {
  const id = req.user.id;
  const list = db.friends
    .filter((f) => (f.a === id || f.b === id) && f.status === 'accepted')
    .map((f) => {
      const fid = f.a === id ? f.b : f.a;
      const u = db.users.find((x) => x.id === fid);
      return u ? pubUser(u) : null;
    })
    .filter(Boolean);

  return res.json(list);
});

app.get('/api/friends/requests', auth, (req, res) => {
  const id = req.user.id;
  const reqs = db.friends
    .filter((f) => f.b === id && f.status === 'pending')
    .map((f) => {
      const u = db.users.find((x) => x.id === f.a);
      return u ? pubUser(u) : null;
    })
    .filter(Boolean);

  return res.json(reqs);
});

app.post('/api/friends/request', auth, (req, res) => {
  const { userId } = req.body || {};
  const me = req.user.id;

  if (!userId || userId === me) return res.status(400).json({ error: 'invalide' });
  if (!db.users.find((u) => u.id === userId)) return res.status(404).json({ error: 'utilisateur introuvable' });
  if (friendRow(me, userId)) return res.status(409).json({ error: 'déjà ami ou demande en cours' });

  db.friends.push({ a: me, b: userId, status: 'pending' });
  save();

  createNotification(userId, 'friend-request', 'Nouvelle demande d’amis reçue.', { fromUserId: me });
  sendTo(userId, { type: 'friend-request', from: pubUser(db.users.find((u) => u.id === me)) });

  return res.json({ ok: true });
});

app.post('/api/friends/accept', auth, (req, res) => {
  const { userId } = req.body || {};
  const row = friendRow(req.user.id, userId);

  if (!row || row.status !== 'pending') return res.status(404).json({ error: 'demande introuvable' });

  row.status = 'accepted';
  save();

  createNotification(userId, 'friend-accepted', 'Votre demande d’amis a été acceptée.', {
    fromUserId: req.user.id
  });
  sendTo(userId, {
    type: 'friend-accepted',
    from: pubUser(db.users.find((u) => u.id === req.user.id))
  });

  return res.json({ ok: true });
});

app.post('/api/friends/remove', auth, (req, res) => {
  const { userId } = req.body || {};
  db.friends = db.friends.filter(
    (f) => !((f.a === req.user.id && f.b === userId) || (f.a === userId && f.b === req.user.id))
  );
  save();
  return res.json({ ok: true });
});

// ---------- Messages ----------
app.get('/api/messages/:friendId', auth, (req, res) => {
  const me = req.user.id;
  const fid = req.params.friendId;
  const row = friendRow(me, fid);

  if (!row || row.status !== 'accepted') return res.status(403).json({ error: 'pas ami' });

  const msgs = db.messages
    .filter((m) => (m.from === me && m.to === fid) || (m.from === fid && m.to === me))
    .slice(-100);

  return res.json(msgs);
});

app.post('/api/messages', auth, (req, res) => {
  const me = req.user.id;
  const { toUserId, type, text, audio, image } = req.body || {};
  const row = friendRow(me, toUserId);

  if (!row || row.status !== 'accepted') return res.status(403).json({ error: 'pas ami' });

  const msg = {
    id: 'm' + db.nextId++,
    from: me,
    to: toUserId,
    type: type || 'text',
    text: text ? String(text).slice(0, 2000) : '',
    audio: audio ? String(audio).slice(0, 500000) : '',
    image: image ? String(image).slice(0, 500000) : '',
    createdAt: Date.now()
  };

  db.messages.push(msg);
  save();

  createNotification(toUserId, 'message', 'Vous avez un nouveau message.', {
    fromUserId: me,
    messageId: msg.id
  });
  sendTo(toUserId, { type: 'message', message: msg });
  return res.json(msg);
});

// ---------- Baraza / Feed ----------
app.get('/api/posts', auth, (req, res) => {
  const posts = [...db.posts]
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .map((post) => serializePost(post, req.user.id));

  return res.json(posts);
});

app.post('/api/posts', auth, (req, res) => {
  const { text, image } = req.body || {};
  const cleanText = String(text || '').trim();
  const cleanImage = String(image || '').trim();

  if (!cleanText && !cleanImage) {
    return res.status(400).json({ error: 'ajoutez un texte ou une photo' });
  }

  const post = {
    id: postUid(),
    userId: req.user.id,
    text: cleanText.slice(0, 2500),
    image: cleanImage.slice(0, 500000),
    createdAt: Date.now(),
    visibility: 'public',
    likes: [],
    shares: [],
    comments: []
  };

  db.posts.push(post);
  save();
  return res.json(serializePost(post, req.user.id));
});

app.post('/api/posts/:postId/comment', auth, (req, res) => {
  const { text } = req.body || {};
  const cleanText = String(text || '').trim();
  if (!cleanText) return res.status(400).json({ error: 'le commentaire est vide' });

  const post = db.posts.find((p) => p.id === req.params.postId);
  if (!post) return res.status(404).json({ error: 'publication introuvable' });

  post.comments = Array.isArray(post.comments) ? post.comments : [];
  const comment = {
    id: commentUid(),
    userId: req.user.id,
    text: cleanText.slice(0, 500),
    createdAt: Date.now()
  };
  post.comments.push(comment);
  save();

  if (post.userId !== req.user.id) {
    createNotification(post.userId, 'post-comment', 'Quelqu’un a commenté votre publication.', {
      postId: post.id,
      byUserId: req.user.id
    });
  }

  return res.json(serializePost(post, req.user.id));
});

app.post('/api/posts/:postId/like', auth, (req, res) => {
  const post = db.posts.find((p) => p.id === req.params.postId);
  if (!post) return res.status(404).json({ error: 'publication introuvable' });

  post.likes = Array.isArray(post.likes) ? post.likes : [];
  const idx = post.likes.indexOf(req.user.id);
  if (idx >= 0) {
    post.likes.splice(idx, 1);
  } else {
    post.likes.push(req.user.id);
    if (post.userId !== req.user.id) {
      createNotification(post.userId, 'post-like', 'Quelqu’un a aimé votre publication.', {
        postId: post.id,
        byUserId: req.user.id
      });
    }
  }
  save();

  return res.json(serializePost(post, req.user.id));
});

app.post('/api/posts/:postId/share', auth, (req, res) => {
  const sourcePost = db.posts.find((p) => p.id === req.params.postId);
  if (!sourcePost) return res.status(404).json({ error: 'publication introuvable' });

  const share = {
    id: postUid(),
    userId: req.user.id,
    text: sourcePost.text || '',
    image: sourcePost.image || '',
    createdAt: Date.now(),
    visibility: 'public',
    likes: [],
    shares: [],
    comments: [],
    sharedFrom: {
      id: sourcePost.id,
      text: sourcePost.text || '',
      image: sourcePost.image || '',
      author: pubUser(getUser(sourcePost.userId))
    }
  };

  db.posts.push(share);
  save();

  if (sourcePost.userId !== req.user.id) {
    createNotification(sourcePost.userId, 'post-share', 'Quelqu’un a partagé votre publication.', {
      postId: sourcePost.id,
      byUserId: req.user.id
    });
  }

  return res.json(serializePost(share, req.user.id));
});

app.get('/api/notifications', auth, (req, res) => {
  const items = getUserNotifications(req.user.id).map((n) => ({
    ...n,
    userId: req.user.id
  }));
  return res.json(items);
});

app.post('/api/notifications/:notificationId/read', auth, (req, res) => {
  const notification = db.notifications.find(
    (n) => n.id === req.params.notificationId && n.userId === req.user.id
  );
  if (!notification) return res.status(404).json({ error: 'notification introuvable' });
  notification.read = true;
  save();
  return res.json({ ok: true, notification });
});

app.get('/api/admin/summary', auth, requireAdmin, (req, res) => {
  const totalUsers = db.users.length;
  const totalPosts = db.posts.length;
  const totalFriends = db.friends.length;
  const totalMessages = db.messages.length;
  const admins = db.users.filter((u) => normalizeUserRole(u.role) === 'admin').length;

  return res.json({
    totalUsers,
    totalPosts,
    totalFriends,
    totalMessages,
    admins,
    lastUpdated: Date.now()
  });
});

app.get('/api/admin/users', auth, requireAdmin, (req, res) => {
  return res.json(db.users.map(pubUser));
});

app.post('/api/admin/users/:userId/role', auth, requireAdmin, (req, res) => {
  const { role } = req.body || {};
  const target = db.users.find((u) => u.id === req.params.userId);
  if (!target) return res.status(404).json({ error: 'utilisateur introuvable' });

  const nextRole = normalizeUserRole(role);
  if (!['user', 'admin'].includes(nextRole)) {
    return res.status(400).json({ error: 'rôle invalide' });
  }

  target.role = nextRole;
  save();

  createNotification(
    target.id,
    'role-updated',
    `Votre accès a été mis à jour : ${nextRole === 'admin' ? 'administrateur' : 'utilisateur'}.`,
    { role: nextRole }
  );

  return res.json(pubUser(target));
});

app.get('/api/hello', (req, res) => {
  res.json({
    message: '✅ BARAZANI Server is running!',
    time: new Date().toISOString()
  });
});

// SPA fallback (après les routes API)
app.get(/^\/(?!api|ws).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Route introuvable' });
  }
  return res.sendFile(path.join(__dirname, 'index.html'));
});

// ---------- WebSocket ----------
wss.on('connection', (ws, req) => {
  try {
    const url = new URL(req.url || '', 'http://localhost');
    const token = url.searchParams.get('token');
    if (!token) {
      ws.close();
      return;
    }

    let user;
    try {
      user = jwt.verify(token, JWT_SECRET);
    } catch {
      ws.close();
      return;
    }

    sockets.set(user.id, ws);
    ws.on('close', () => {
      if (sockets.get(user.id) === ws) sockets.delete(user.id);
    });
    ws.on('error', () => {
      if (sockets.get(user.id) === ws) sockets.delete(user.id);
    });
  } catch {
    try {
      ws.close();
    } catch {}
  }
});

// Démarrage compatible Render (0.0.0.0 + PORT)
server.listen(PORT, HOST, () => {
  console.log(`BARAZANI Online - listening on http://${HOST}:${PORT}`);
});
