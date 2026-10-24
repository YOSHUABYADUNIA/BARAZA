import express from 'express';
import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';
import crypto from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Config ---
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-use-long-random-string';
const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ MONGO_URI manquant. Définissez process.env.MONGO_URI (ex. MongoDB Atlas).');
  process.exit(1);
}

// ---------- Models ----------
const userSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    bio: { type: String, default: '' },
    avatar: { type: String, default: '' },
    createdAt: { type: Number, default: () => Date.now() },
    role: { type: String, enum: ['user', 'admin'], default: 'user' }
  },
  { versionKey: false }
);

const friendSchema = new mongoose.Schema(
  {
    a: { type: String, required: true, index: true },
    b: { type: String, required: true, index: true },
    status: { type: String, enum: ['pending', 'accepted'], default: 'pending' }
  },
  { versionKey: false }
);
friendSchema.index({ a: 1, b: 1 }, { unique: true });

const messageSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    from: { type: String, required: true, index: true },
    to: { type: String, required: true, index: true },
    type: { type: String, default: 'text' },
    text: { type: String, default: '' },
    audio: { type: String, default: '' },
    image: { type: String, default: '' },
    createdAt: { type: Number, default: () => Date.now() }
  },
  { versionKey: false }
);

const postSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    userId: { type: String, required: true, index: true },
    text: { type: String, default: '' },
    image: { type: String, default: '' },
    createdAt: { type: Number, default: () => Date.now() },
    visibility: { type: String, default: 'public' },
    likes: { type: [String], default: [] },
    shares: { type: [String], default: [] },
    comments: {
      type: [
        {
          id: String,
          userId: String,
          text: String,
          createdAt: Number
        }
      ],
      default: []
    },
    sharedFrom: { type: mongoose.Schema.Types.Mixed, default: null }
  },
  { versionKey: false }
);

const notificationSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    type: { type: String, required: true },
    message: { type: String, required: true },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} },
    read: { type: Boolean, default: false },
    createdAt: { type: Number, default: () => Date.now() }
  },
  { versionKey: false }
);

const User = mongoose.model('User', userSchema);
const Friend = mongoose.model('Friend', friendSchema);
const Message = mongoose.model('Message', messageSchema);
const Post = mongoose.model('Post', postSchema);
const Notification = mongoose.model('Notification', notificationSchema);

// ---------- Helpers ----------
function normalizeUserRole(role) {
  return role === 'admin' ? 'admin' : 'user';
}

function newId(prefix) {
  return prefix + crypto.randomBytes(6).toString('hex');
}

function pubUser(u) {
  if (!u) return null;
  const doc = u.toObject ? u.toObject() : u;
  return {
    id: doc.id,
    username: doc.username,
    name: doc.name,
    bio: doc.bio || '',
    avatar: doc.avatar || '',
    createdAt: doc.createdAt,
    role: normalizeUserRole(doc.role)
  };
}

async function getUser(userId) {
  return User.findOne({ id: userId }).lean();
}

async function serializePost(post, currentUserId = null) {
  const p = post.toObject ? post.toObject() : post;
  const author = pubUser(await getUser(p.userId));
  const likes = Array.isArray(p.likes) ? p.likes : [];
  const comments = Array.isArray(p.comments) ? p.comments : [];
  const shares = Array.isArray(p.shares) ? p.shares : [];

  const commentsOut = [];
  for (const comment of comments) {
    commentsOut.push({
      id: comment.id,
      userId: comment.userId,
      text: comment.text || '',
      createdAt: comment.createdAt,
      author: pubUser(await getUser(comment.userId))
    });
  }

  return {
    id: p.id,
    userId: p.userId,
    text: p.text || '',
    image: p.image || '',
    createdAt: p.createdAt,
    visibility: p.visibility || 'public',
    author,
    likedByMe: currentUserId ? likes.includes(currentUserId) : false,
    likesCount: likes.length,
    comments: commentsOut,
    commentsCount: comments.length,
    sharesCount: shares.length,
    sharedFrom: p.sharedFrom || null
  };
}

async function createNotification(userId, type, message, meta = {}) {
  if (!userId || !message) return null;
  const notification = await Notification.create({
    id: newId('n'),
    userId,
    type,
    message,
    meta: meta || {},
    read: false,
    createdAt: Date.now()
  });

  const ws = sockets.get(userId);
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify({ type: 'notification', notification: notification.toObject() }));
    } catch {}
  }
  return notification;
}

function sendTo(userId, obj) {
  const ws = sockets.get(userId);
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }
}

async function friendRow(a, b) {
  return Friend.findOne({
    $or: [
      { a, b },
      { a: b, b: a }
    ]
  });
}

// ---------- Express ----------
const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname, { index: false }));

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

async function requireAdmin(req, res, next) {
  try {
    const user = await getUser(req.user.id);
    if (!user || user.role !== 'admin') {
      return res.status(403).json({ error: 'accès administrateur requis' });
    }
    return next();
  } catch {
    return res.status(500).json({ error: 'erreur serveur' });
  }
}

// ---------- Auth ----------
app.post('/api/register', async (req, res) => {
  try {
    const { username, name, password } = req.body || {};
    if (!username || !name || !password || password.length < 4) {
      return res.status(400).json({ error: 'champs invalides (mot de passe ≥ 4 caractères)' });
    }

    const normalizedUsername = String(username).trim().toLowerCase();
    const exists = await User.findOne({ username: normalizedUsername });
    if (exists) {
      return res.status(409).json({ error: "nom d'utilisateur déjà pris" });
    }

    const role =
      process.env.ADMIN_USERNAME &&
      normalizedUsername === String(process.env.ADMIN_USERNAME).trim().toLowerCase()
        ? 'admin'
        : 'user';

    const user = await User.create({
      id: newId('u'),
      username: normalizedUsername,
      name: String(name).trim(),
      passwordHash: await bcrypt.hash(password, 10),
      bio: '',
      avatar: '',
      createdAt: Date.now(),
      role
    });

    await createNotification(user.id, 'welcome', 'Bienvenue dans Baraza ! Votre compte a été créé avec succès.', {
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
    const user = await User.findOne({
      username: String(username || '').trim().toLowerCase()
    });

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
app.get('/api/me', auth, async (req, res) => {
  const u = await getUser(req.user.id);
  if (!u) return res.status(404).json({ error: 'compte introuvable' });
  return res.json(pubUser(u));
});

app.put('/api/me', auth, async (req, res) => {
  try {
    const u = await User.findOne({ id: req.user.id });
    if (!u) return res.status(404).json({ error: 'compte introuvable' });

    const { name, bio, avatar, password } = req.body || {};
    if (name) u.name = String(name).slice(0, 50).trim();
    if (bio !== undefined) u.bio = String(bio).slice(0, 200);
    if (avatar !== undefined) u.avatar = String(avatar).slice(0, 500000);
    if (password && String(password).length >= 4) {
      u.passwordHash = await bcrypt.hash(String(password), 10);
    }

    await u.save();
    return res.json(pubUser(u));
  } catch (err) {
    console.error('update me error:', err);
    return res.status(500).json({ error: 'erreur serveur' });
  }
});

app.delete('/api/me', auth, async (req, res) => {
  const id = req.user.id;
  await User.deleteOne({ id });
  await Friend.deleteMany({ $or: [{ a: id }, { b: id }] });
  await Message.deleteMany({ $or: [{ from: id }, { to: id }] });
  await Post.deleteMany({ userId: id });
  await Notification.deleteMany({ userId: id });

  const ws = sockets.get(id);
  if (ws) {
    try {
      ws.close();
    } catch {}
  }
  sockets.delete(id);
  return res.json({ ok: true });
});

// ---------- Recherche ----------
app.get('/api/users/search', auth, async (req, res) => {
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);

  const results = await User.find({
    id: { $ne: req.user.id },
    $or: [
      { username: { $regex: q, $options: 'i' } },
      { name: { $regex: q, $options: 'i' } }
    ]
  })
    .limit(20)
    .lean();

  return res.json(results.map(pubUser));
});

// ---------- Amis ----------
app.get('/api/friends', auth, async (req, res) => {
  const id = req.user.id;
  const rows = await Friend.find({
    $or: [{ a: id }, { b: id }],
    status: 'accepted'
  }).lean();

  const list = [];
  for (const f of rows) {
    const fid = f.a === id ? f.b : f.a;
    const u = await getUser(fid);
    if (u) list.push(pubUser(u));
  }
  return res.json(list);
});

app.get('/api/friends/requests', auth, async (req, res) => {
  const id = req.user.id;
  const rows = await Friend.find({ b: id, status: 'pending' }).lean();
  const reqs = [];
  for (const f of rows) {
    const u = await getUser(f.a);
    if (u) reqs.push(pubUser(u));
  }
  return res.json(reqs);
});

app.post('/api/friends/request', auth, async (req, res) => {
  const { userId } = req.body || {};
  const me = req.user.id;

  if (!userId || userId === me) return res.status(400).json({ error: 'invalide' });
  if (!(await getUser(userId))) return res.status(404).json({ error: 'utilisateur introuvable' });
  if (await friendRow(me, userId)) return res.status(409).json({ error: 'déjà ami ou demande en cours' });

  await Friend.create({ a: me, b: userId, status: 'pending' });

  await createNotification(userId, 'friend-request', 'Nouvelle demande d’amis reçue.', { fromUserId: me });
  sendTo(userId, { type: 'friend-request', from: pubUser(await getUser(me)) });

  return res.json({ ok: true });
});

app.post('/api/friends/accept', auth, async (req, res) => {
  const { userId } = req.body || {};
  const row = await friendRow(req.user.id, userId);

  if (!row || row.status !== 'pending') return res.status(404).json({ error: 'demande introuvable' });

  row.status = 'accepted';
  await row.save();

  await createNotification(userId, 'friend-accepted', 'Votre demande d’amis a été acceptée.', {
    fromUserId: req.user.id
  });
  sendTo(userId, {
    type: 'friend-accepted',
    from: pubUser(await getUser(req.user.id))
  });

  return res.json({ ok: true });
});

app.post('/api/friends/remove', auth, async (req, res) => {
  const { userId } = req.body || {};
  await Friend.deleteMany({
    $or: [
      { a: req.user.id, b: userId },
      { a: userId, b: req.user.id }
    ]
  });
  return res.json({ ok: true });
});

// ---------- Messages ----------
app.get('/api/messages/:friendId', auth, async (req, res) => {
  const me = req.user.id;
  const fid = req.params.friendId;
  const row = await friendRow(me, fid);

  if (!row || row.status !== 'accepted') return res.status(403).json({ error: 'pas ami' });

  const msgs = await Message.find({
    $or: [
      { from: me, to: fid },
      { from: fid, to: me }
    ]
  })
    .sort({ createdAt: 1 })
    .limit(100)
    .lean();

  return res.json(msgs);
});

app.post('/api/messages', auth, async (req, res) => {
  const me = req.user.id;
  const { toUserId, type, text, audio, image } = req.body || {};
  const row = await friendRow(me, toUserId);

  if (!row || row.status !== 'accepted') return res.status(403).json({ error: 'pas ami' });

  const msg = await Message.create({
    id: newId('m'),
    from: me,
    to: toUserId,
    type: type || 'text',
    text: text ? String(text).slice(0, 2000) : '',
    audio: audio ? String(audio).slice(0, 500000) : '',
    image: image ? String(image).slice(0, 500000) : '',
    createdAt: Date.now()
  });

  await createNotification(toUserId, 'message', 'Vous avez un nouveau message.', {
    fromUserId: me,
    messageId: msg.id
  });
  sendTo(toUserId, { type: 'message', message: msg.toObject() });
  return res.json(msg.toObject());
});

// ---------- Posts ----------
app.get('/api/posts', auth, async (req, res) => {
  const posts = await Post.find().sort({ createdAt: -1 }).limit(100).lean();
  const out = [];
  for (const post of posts) {
    out.push(await serializePost(post, req.user.id));
  }
  return res.json(out);
});

app.post('/api/posts', auth, async (req, res) => {
  const { text, image } = req.body || {};
  const cleanText = String(text || '').trim();
  const cleanImage = String(image || '').trim();

  if (!cleanText && !cleanImage) {
    return res.status(400).json({ error: 'ajoutez un texte ou une photo' });
  }

  const post = await Post.create({
    id: newId('p'),
    userId: req.user.id,
    text: cleanText.slice(0, 2500),
    image: cleanImage.slice(0, 500000),
    createdAt: Date.now(),
    visibility: 'public',
    likes: [],
    shares: [],
    comments: []
  });

  return res.json(await serializePost(post, req.user.id));
});

app.post('/api/posts/:postId/comment', auth, async (req, res) => {
  const { text } = req.body || {};
  const cleanText = String(text || '').trim();
  if (!cleanText) return res.status(400).json({ error: 'le commentaire est vide' });

  const post = await Post.findOne({ id: req.params.postId });
  if (!post) return res.status(404).json({ error: 'publication introuvable' });

  post.comments.push({
    id: newId('c'),
    userId: req.user.id,
    text: cleanText.slice(0, 500),
    createdAt: Date.now()
  });
  await post.save();

  if (post.userId !== req.user.id) {
    await createNotification(post.userId, 'post-comment', 'Quelqu’un a commenté votre publication.', {
      postId: post.id,
      byUserId: req.user.id
    });
  }

  return res.json(await serializePost(post, req.user.id));
});

app.post('/api/posts/:postId/like', auth, async (req, res) => {
  const post = await Post.findOne({ id: req.params.postId });
  if (!post) return res.status(404).json({ error: 'publication introuvable' });

  const idx = post.likes.indexOf(req.user.id);
  if (idx >= 0) {
    post.likes.splice(idx, 1);
  } else {
    post.likes.push(req.user.id);
    if (post.userId !== req.user.id) {
      await createNotification(post.userId, 'post-like', 'Quelqu’un a aimé votre publication.', {
        postId: post.id,
        byUserId: req.user.id
      });
    }
  }
  await post.save();

  return res.json(await serializePost(post, req.user.id));
});

app.post('/api/posts/:postId/share', auth, async (req, res) => {
  const sourcePost = await Post.findOne({ id: req.params.postId }).lean();
  if (!sourcePost) return res.status(404).json({ error: 'publication introuvable' });

  const share = await Post.create({
    id: newId('p'),
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
      author: pubUser(await getUser(sourcePost.userId))
    }
  });

  if (sourcePost.userId !== req.user.id) {
    await createNotification(sourcePost.userId, 'post-share', 'Quelqu’un a partagé votre publication.', {
      postId: sourcePost.id,
      byUserId: req.user.id
    });
  }

  return res.json(await serializePost(share, req.user.id));
});

// ---------- Notifications ----------
app.get('/api/notifications', auth, async (req, res) => {
  const items = await Notification.find({ userId: req.user.id })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  return res.json(items.map((n) => ({ ...n, userId: req.user.id })));
});

app.post('/api/notifications/:notificationId/read', auth, async (req, res) => {
  const notification = await Notification.findOne({
    id: req.params.notificationId,
    userId: req.user.id
  });
  if (!notification) return res.status(404).json({ error: 'notification introuvable' });
  notification.read = true;
  await notification.save();
  return res.json({ ok: true, notification: notification.toObject() });
});

// ---------- Admin ----------
app.get('/api/admin/summary', auth, requireAdmin, async (req, res) => {
  const [totalUsers, totalPosts, totalFriends, totalMessages, admins] = await Promise.all([
    User.countDocuments(),
    Post.countDocuments(),
    Friend.countDocuments(),
    Message.countDocuments(),
    User.countDocuments({ role: 'admin' })
  ]);

  return res.json({
    totalUsers,
    totalPosts,
    totalFriends,
    totalMessages,
    admins,
    lastUpdated: Date.now()
  });
});

app.get('/api/admin/users', auth, requireAdmin, async (req, res) => {
  const users = await User.find().lean();
  return res.json(users.map(pubUser));
});

app.post('/api/admin/users/:userId/role', auth, requireAdmin, async (req, res) => {
  const { role } = req.body || {};
  const target = await User.findOne({ id: req.params.userId });
  if (!target) return res.status(404).json({ error: 'utilisateur introuvable' });

  const nextRole = normalizeUserRole(role);
  if (!['user', 'admin'].includes(nextRole)) {
    return res.status(400).json({ error: 'rôle invalide' });
  }

  target.role = nextRole;
  await target.save();

  await createNotification(
    target.id,
    'role-updated',
    `Votre accès a été mis à jour : ${nextRole === 'admin' ? 'administrateur' : 'utilisateur'}.`,
    { role: nextRole }
  );

  return res.json(pubUser(target));
});

app.get('/api/hello', (req, res) => {
  res.json({
    message: '✅ BARAZANI Server is running (MongoDB)',
    time: new Date().toISOString(),
    mongo: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
  });
});

// SPA fallback
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

// ---------- Start ----------
async function start() {
  try {
    await mongoose.connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000
    });
    console.log('✅ MongoDB connecté');

    server.listen(PORT, HOST, () => {
      console.log(`BARAZANI Online - listening on http://${HOST}:${PORT}`);
    });
  } catch (err) {
    console.error('❌ Connexion MongoDB échouée:', err.message);
    process.exit(1);
  }
}

start();
