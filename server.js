const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.text({ limit: '10mb' }));

// Serve static frontend files from /public
app.use(express.static(path.join(__dirname, 'public')));

// ═══════════════════════════════════════════════════════════════
// 1. SCHEMAS
// ═══════════════════════════════════════════════════════════════
const RecordSchema = new mongoose.Schema({
    type: String, id: String, name: String, quality: Number,
    level: Number, effects: [String], data: Object,
    timestamp: { type: Date, default: Date.now }
});
const Record = mongoose.model('Record', RecordSchema);

const CommentSchema = new mongoose.Schema({
    type: String,
    recordId: String,
    author: String,
    cls: String,
    text: String,
    ts: { type: Date, default: Date.now },
    uid: String
});
const Comment = mongoose.model('Comment', CommentSchema);

const UserSchema = new mongoose.Schema({
    email:    { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    name:     { type: String, default: '' },
    verified: { type: Boolean, default: false },
    verifyToken:   { type: String, default: null },
    verifyExpires: { type: Date, default: null },
    createdAt:     { type: Date, default: Date.now }
});
const User = mongoose.model('User', UserSchema);

const JWT_SECRET = process.env.JWT_SECRET || 'epochdb-dev-secret-change-me';
const RECAPTCHA_SECRET = process.env.RECAPTCHA_SECRET_KEY || '';
const BASE_URL = process.env.BASE_URL || 'http://localhost:5000';

// ═══════════════════════════════════════════════════════════════
// 2. DATABASE
// ═══════════════════════════════════════════════════════════════
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/epochdb';

if (!process.env.MONGODB_URI) {
    console.warn('WARNING: MONGODB_URI env var not set, using localhost fallback');
}

mongoose.connect(MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    socketTimeoutMS: 45000,
})
    .then(() => console.log('Connected to MongoDB:', MONGODB_URI.replace(/\/\/.*@/, '//<credentials>@')))
    .catch(err => console.error('DB connection error:', err.message));

mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected'));
mongoose.connection.on('reconnected', () => console.log('MongoDB reconnected'));

// ═══════════════════════════════════════════════════════════════
// 3. HEALTH CHECK (Render uses this to verify the service is up)
// ═══════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
    const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
    res.json({ status: 'ok', db: states[mongoose.connection.readyState] || 'unknown' });
});

// ═══════════════════════════════════════════════════════════════
// 3b. EMAIL TRANSPORTER
// ═══════════════════════════════════════════════════════════════
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: false,
    auth: {
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || ''
    }
});

// ═══════════════════════════════════════════════════════════════
// 3c. reCAPTCHA VERIFICATION
// ═══════════════════════════════════════════════════════════════
async function verifyCaptcha(token) {
    if (!RECAPTCHA_SECRET) { console.warn('RECAPTCHA_SECRET_KEY not set, skipping verification'); return true; }
    if (!token) return false;
    try {
        const params = new URLSearchParams({ secret: RECAPTCHA_SECRET, response: token });
        const res = await fetch('https://www.google.com/recaptcha/api/siteverify', { method: 'POST', body: params });
        const data = await res.json();
        return data.success === true;
    } catch (err) { console.error('reCAPTCHA verify error:', err); return false; }
}

// ═══════════════════════════════════════════════════════════════
// 3d. JWT MIDDLEWARE
// ═══════════════════════════════════════════════════════════════
function authMiddleware(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Login required' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

// ═══════════════════════════════════════════════════════════════
// 3e. AUTH ROUTES
// ═══════════════════════════════════════════════════════════════
app.post('/api/auth/register', async (req, res) => {
    try {
        const { email, password, name, captchaToken } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

        const captchaOk = await verifyCaptcha(captchaToken);
        if (!captchaOk) return res.status(400).json({ error: 'Please complete the CAPTCHA' });

        const existing = await User.findOne({ email: email.toLowerCase().trim() });
        if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

        const hash = await bcrypt.hash(password, 12);
        const verifyToken = crypto.randomBytes(32).toString('hex');
        const user = new User({
            email: email.toLowerCase().trim(),
            password: hash,
            name: (name || email.split('@')[0]).trim(),
            verified: false,
            verifyToken,
            verifyExpires: new Date(Date.now() + 24 * 60 * 60 * 1000)
        });
        await user.save();

        const verifyUrl = `${BASE_URL}/api/auth/verify/${verifyToken}`;
        try {
            await transporter.sendMail({
                from: process.env.SMTP_FROM || process.env.SMTP_USER || 'noreply@epochdb.com',
                to: user.email,
                subject: 'EpochDB — Verify your email',
                html: `<h2>Welcome to EpochDB!</h2>
                       <p>Click the link below to verify your email:</p>
                       <p><a href="${verifyUrl}">${verifyUrl}</a></p>
                       <p>This link expires in 24 hours.</p>`
            });
            console.log(`[AUTH] Verification email sent to ${user.email}`);
        } catch (mailErr) {
            console.error('[AUTH] Email send failed:', mailErr.message);
        }

        res.status(201).json({ message: 'Account created! Check your email to verify.' });
    } catch (err) {
        console.error('[AUTH] Register error:', err);
        res.status(500).json({ error: 'Registration failed' });
    }
});

app.get('/api/auth/verify/:token', async (req, res) => {
    try {
        const user = await User.findOne({ verifyToken: req.params.token, verifyExpires: { $gt: new Date() } });
        if (!user) return res.status(400).send('<h2>Invalid or expired verification link.</h2><p><a href="/">Return to EpochDB</a></p>');
        user.verified = true;
        user.verifyToken = null;
        user.verifyExpires = null;
        await user.save();
        res.send('<h2 style="color:green">✔ Email verified!</h2><p>You can now log in. <a href="/">Return to EpochDB</a></p>');
    } catch (err) {
        console.error('[AUTH] Verify error:', err);
        res.status(500).send('<h2>Verification failed.</h2>');
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password, captchaToken } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const captchaOk = await verifyCaptcha(captchaToken);
        if (!captchaOk) return res.status(400).json({ error: 'Please complete the CAPTCHA' });

        const user = await User.findOne({ email: email.toLowerCase().trim() });
        if (!user) return res.status(401).json({ error: 'Invalid email or password' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Invalid email or password' });

        if (!user.verified) return res.status(403).json({ error: 'Please verify your email first. Check your inbox.' });

        const token = jwt.sign({ id: user._id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user._id, email: user.email, name: user.name } });
    } catch (err) {
        console.error('[AUTH] Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
        const user = await User.findById(req.user.id).select('-password -verifyToken');
        if (!user) return res.status(404).json({ error: 'User not found' });
        res.json({ id: user._id, email: user.email, name: user.name, verified: user.verified });
    } catch (err) {
        res.status(500).json({ error: 'Could not fetch user' });
    }
});

// ═══════════════════════════════════════════════════════════════
// 4. LUA PARSER
// ═══════════════════════════════════════════════════════════════

function extractTable(tableName, content) {
    const startRe = new RegExp(`\\["${tableName}"\\]\\s*=\\s*\\{`);
    const startMatch = startRe.exec(content);
    if (!startMatch) return null;
    let depth = 0, i = startMatch.index + startMatch[0].length - 1;
    const start = i + 1;
    while (i < content.length) {
        if (content[i] === '{') depth++;
        else if (content[i] === '}') { depth--; if (depth === 0) return content.slice(start, i); }
        i++;
    }
    return null;
}

function getStr(field, block) {
    const m = block.match(new RegExp(`\\["${field}"\\]\\s*=\\s*"([^"]*?)"`));
    return m ? m[1] : null;
}

function getNum(field, block) {
    const m = block.match(new RegExp(`\\["${field}"\\]\\s*=\\s*(-?\\d+)`));
    return m ? parseInt(m[1]) : null;
}

function parseEntries(tableContent) {
    const entries = [];
    const keyRe = /\["([^"]+)"\]\s*=\s*\{/g;
    let m;
    while ((m = keyRe.exec(tableContent)) !== null) {
        const key = m[1];
        let depth = 0, i = m.index + m[0].length - 1;
        const start = i + 1;
        while (i < tableContent.length) {
            if (tableContent[i] === '{') depth++;
            else if (tableContent[i] === '}') {
                depth--;
                if (depth === 0) { entries.push({ key, block: tableContent.slice(start, i) }); break; }
            }
            i++;
        }
    }
    return entries;
}

function parseLuaContent(content) {
    const result = { kills: [], items: [], loot: [] };

    console.log(`[PARSE] Starting Lua parse`);
    console.log(`[PARSE] Content size: ${content.length} bytes`);

    const savedVarsMatch = content.match(/^EpochDBData\s*=\s*(\{[\s\S]*\})[\s\S]*$/);
    if (savedVarsMatch) {
        console.log(`[PARSE] Detected SavedVariables format, extracting data table`);
        content = savedVarsMatch[1];
    } else {
        console.log(`[PARSE] Not SavedVariables format, using content as-is`);
    }

    // ── KILLS ──
    const killsTable = extractTable('kills', content);
    if (killsTable) {
        const killEntries = parseEntries(killsTable);
        console.log(`[PARSE] Found kills table with ${killEntries.length} entries`);
        for (const { key, block } of killEntries) {
            result.kills.push({
                key,
                name:      getStr('name', block)      || key.split('|')[0],
                zone:      getStr('zone', block)      || '',
                subZone:   getStr('subZone', block)   || '',
                coords:    getStr('coords', block)    || '',
                count:     getNum('count', block)     || 1,
                firstKill: getStr('firstKill', block) || '',
                lastKill:  getStr('lastKill', block)  || '',
            });
        }
    }

    // ── ITEMS ──
    const itemsTable = extractTable('items', content);
    if (itemsTable) {
        const itemEntries = parseEntries(itemsTable);
        console.log(`[PARSE] Found items table with ${itemEntries.length} entries`);
        for (const { key, block } of itemEntries) {
            result.items.push({
                id:        getStr('id', block)        || key,
                name:      getStr('name', block)      || '',
                type:      getStr('type', block)      || '',
                subType:   getStr('subType', block)   || '',
                slot:      getStr('slot', block)      || '',
                ilvl:      getNum('ilvl', block)      || 0,
                quality:   getNum('quality', block)   ?? 1,
                firstSeen: getStr('firstSeen', block) || '',
            });
        }
    }

    // ── LOOT ──
    const lootTable = extractTable('loot', content);
    if (lootTable) {
        const lootEntries = parseEntries(lootTable);
        console.log(`[PARSE] Found loot table with ${lootEntries.length} entries`);
        for (const { key, block } of lootEntries) {
            const sources = {};
            const sourcesInner = extractTable('sources', block);
            if (sourcesInner) {
                const srcRe = /\["([^"]+)"\]\s*=\s*(\d+)/g;
                let sm;
                while ((sm = srcRe.exec(sourcesInner)) !== null) {
                    sources[sm[1]] = parseInt(sm[2]);
                }
            }
            const totalDrops = Object.values(sources).reduce((a, b) => a + b, 0);
            result.loot.push({
                id:        getStr('id', block)        || key,
                name:      getStr('name', block)      || '',
                quality:   getNum('quality', block)   ?? 1,
                count:     getNum('count', block)     || 1,
                sources,
                source:    Object.keys(sources)[0]   || '',
                totalDrops,
                firstSeen: getStr('firstSeen', block) || '',
                lastSeen:  getStr('lastSeen', block)  || '',
            });
        }
    }

    console.log(`[PARSE] Complete: ${result.kills.length} kills, ${result.items.length} items, ${result.loot.length} loot`);
    return result;
}

// ═══════════════════════════════════════════════════════════════
// 5. UPLOAD & SYNC ROUTE
// ═══════════════════════════════════════════════════════════════
app.post('/api/upload', async (req, res) => {
    try {
        const content = req.body;
        if (!content || typeof content !== 'string' || content.trim().length === 0) {
            return res.status(400).json({ error: 'No file content received.' });
        }

        console.log(`[UPLOAD] Processing upload (${content.length} bytes)`);
        let parsed;
        try {
            parsed = parseLuaContent(content);
        } catch (parseErr) {
            console.error(`[UPLOAD] Parse error:`, parseErr.message);
            return res.status(400).json({ error: `Failed to parse Lua file: ${parseErr.message}` });
        }

        console.log(`[UPLOAD] Parse result: ${parsed.kills.length} kills, ${parsed.items.length} items, ${parsed.loot.length} loot`);

        if (parsed.kills.length === 0 && parsed.items.length === 0 && parsed.loot.length === 0) {
            console.warn(`[UPLOAD] Warning: No data extracted from file.`);
        }

        const ops = [];

        for (const npc of parsed.kills) {
            ops.push({
                updateOne: {
                    filter: { type: 'npcs', id: npc.key },
                    update: {
                        $set: { name: npc.name, 'data.zone': npc.zone, 'data.subZone': npc.subZone, 'data.coords': npc.coords },
                        $inc: { 'data.kills': npc.count },
                        $min: { 'data.firstKill': npc.firstKill },
                        $max: { 'data.lastKill': npc.lastKill },
                    },
                    upsert: true
                }
            });
        }

        for (const item of parsed.items) {
            ops.push({
                updateOne: {
                    filter: { type: 'items', id: item.id },
                    update: {
                        $set: { name: item.name, quality: item.quality, level: item.ilvl,
                                'data.type': item.type, 'data.subType': item.subType,
                                'data.slot': item.slot, 'data.firstSeen': item.firstSeen },
                        $inc: { 'data.seen': 1 },
                    },
                    upsert: true
                }
            });
        }

        for (const drop of parsed.loot) {
            const sourceInc = {};
            for (const [src, cnt] of Object.entries(drop.sources)) {
                sourceInc[`data.sources.${src.replace(/[.\$]/g, '_')}`] = cnt;
            }
            ops.push({
                updateOne: {
                    filter: { type: 'loot', id: drop.id },
                    update: {
                        $set: { name: drop.name, quality: drop.quality,
                                'data.source': drop.source, 'data.lastSeen': drop.lastSeen },
                        $inc: { 'data.drops': drop.totalDrops, 'data.samples': 1, ...sourceInc },
                        $min: { 'data.firstSeen': drop.firstSeen },
                    },
                    upsert: true
                }
            });
        }

        if (ops.length > 0) {
            try {
                await Record.bulkWrite(ops);
                console.log(`[UPLOAD] MongoDB bulk write successful: ${ops.length} operations`);
            } catch (dbErr) {
                console.error(`[UPLOAD] Database error:`, dbErr.message);
                return res.status(500).json({ error: `Database sync failed: ${dbErr.message}` });
            }
        }

        res.json({
            message: 'Sync complete!',
            items: ops.length,
            breakdown: { kills: parsed.kills.length, items: parsed.items.length, loot: parsed.loot.length }
        });
    } catch (err) {
        console.error('[UPLOAD] Unexpected error:', err);
        res.status(500).json({ error: 'Processing failed' });
    }
});

// ═══════════════════════════════════════════════════════════════
// 6. SEARCH & FETCH ROUTES
// ═══════════════════════════════════════════════════════════════
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        const results = await Record.find({ name: { $regex: query, $options: 'i' } }).limit(10);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: 'Search failed' });
    }
});

app.get('/api/list/:category', async (req, res) => {
    try {
        const data = await Record.find({ type: req.params.category }).limit(1000);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: 'Could not fetch list' });
    }
});

app.get('/api/record/:type/:id', async (req, res) => {
    try {
        const record = await Record.findOne({ type: req.params.type, id: req.params.id });
        if (!record) return res.status(404).json({ error: 'Not found' });
        res.json(record);
    } catch (err) {
        res.status(500).json({ error: 'Internal error' });
    }
});

// ═══════════════════════════════════════════════════════════════
// 7. COMMENTS API (ported from Netlify function)
// ═══════════════════════════════════════════════════════════════
app.get('/api/comments/:type/:id', async (req, res) => {
    try {
        const docs = await Comment.find({ type: req.params.type, recordId: req.params.id }).sort({ ts: -1 }).lean();
        res.json(docs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/comments/:type/:id', authMiddleware, async (req, res) => {
    try {
        const { text, cls } = req.body;
        if (!text) return res.status(400).json({ error: 'Missing text' });
        const c = new Comment({
            type: req.params.type,
            recordId: req.params.id,
            text,
            cls: cls || '',
            author: req.user.name || req.user.email,
            uid: req.user.id,
            ts: Date.now()
        });
        await c.save();
        res.status(201).json(c);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/comments/:type/:id/:commentId', authMiddleware, async (req, res) => {
    try {
        const c = await Comment.findById(req.params.commentId);
        if (!c) return res.status(404).json({ error: 'Comment not found' });
        if (c.uid !== req.user.id) return res.status(403).json({ error: 'You can only delete your own comments' });
        await Comment.findByIdAndDelete(req.params.commentId);
        res.json({ deleted: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// 8. SPA FALLBACK — serve index.html for all non-API routes
// ═══════════════════════════════════════════════════════════════
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══════════════════════════════════════════════════════════════
// 9. START
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`EpochDB Backend running on port ${PORT}`));
