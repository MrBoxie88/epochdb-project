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
    createdAt:     { type: Date, default: Date.now },
    isAdmin:       { type: Boolean, default: false }
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

        const token = jwt.sign({ id: user._id, email: user.email, name: user.name, isAdmin: user.isAdmin }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user._id, email: user.email, name: user.name, isAdmin: user.isAdmin } });
    } catch (err) {
        console.error('[AUTH] Login error:', err);
        res.status(500).json({ error: 'Login failed' });
    }
});

function adminMiddleware(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Login required' });
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (!decoded.isAdmin) return res.status(403).json({ error: 'Admin access required' });
        req.user = decoded;
        next();
    } catch (err) { return res.status(401).json({ error: 'Invalid or expired token' }); }
}

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
// 3f. INVTYPE SLOT MAPPING
// ═══════════════════════════════════════════════════════════════
const SLOT_MAP = {
    'INVTYPE_HEAD': 'Head', 'INVTYPE_NECK': 'Neck', 'INVTYPE_SHOULDER': 'Shoulder',
    'INVTYPE_BODY': 'Shirt', 'INVTYPE_CHEST': 'Chest', 'INVTYPE_ROBE': 'Chest',
    'INVTYPE_WAIST': 'Waist', 'INVTYPE_LEGS': 'Legs', 'INVTYPE_FEET': 'Feet',
    'INVTYPE_WRIST': 'Wrist', 'INVTYPE_HAND': 'Hands', 'INVTYPE_FINGER': 'Finger',
    'INVTYPE_TRINKET': 'Trinket', 'INVTYPE_CLOAK': 'Back', 'INVTYPE_WEAPON': 'One-Hand',
    'INVTYPE_SHIELD': 'Off Hand', 'INVTYPE_2HWEAPON': 'Two-Hand',
    'INVTYPE_WEAPONMAINHAND': 'Main Hand', 'INVTYPE_WEAPONOFFHAND': 'Off Hand',
    'INVTYPE_HOLDABLE': 'Held In Off-Hand', 'INVTYPE_RANGED': 'Ranged',
    'INVTYPE_THROWN': 'Thrown', 'INVTYPE_RANGEDRIGHT': 'Ranged',
    'INVTYPE_RELIC': 'Relic', 'INVTYPE_TABARD': 'Tabard', 'INVTYPE_BAG': 'Bag',
    'INVTYPE_QUIVER': 'Quiver', 'INVTYPE_AMMO': 'Ammo',
};

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

function getBool(field, block) {
    const m = block.match(new RegExp(`\\["${field}"\\]\\s*=\\s*(true|false)`));
    return m ? m[1] === 'true' : null;
}

function getArray(field, block) {
    const inner = extractTable(field, block);
    if (!inner) return [];
    const results = [];
    const re = /"([^"]*)"/g;
    let m;
    while ((m = re.exec(inner)) !== null) {
        if (m[1].trim()) results.push(m[1]);
    }
    return results;
}

function getFloat(field, block) {
    const m = block.match(new RegExp(`\\["${field}"\\]\\s*=\\s*(-?[\\d.]+)`));
    return m ? parseFloat(m[1]) : null;
}

function parseSubTables(tableContent) {
    const results = [];
    let depth = 0, start = -1;
    for (let i = 0; i < tableContent.length; i++) {
        if (tableContent[i] === '{') {
            if (depth === 0) start = i + 1;
            depth++;
        } else if (tableContent[i] === '}') {
            depth--;
            if (depth === 0 && start >= 0) {
                results.push(tableContent.slice(start, i));
                start = -1;
            }
        }
    }
    return results;
}

function parseKVNums(tableName, block) { 
    const inner = extractTable(tableName, block);
    if (!inner) return null;
    const result = {};
    const re = /\["([^"]+)"\]\s*=\s*(-?[\d.]+)/g;
    let m;
    while ((m = re.exec(inner)) !== null) {
        result[m[1]] = parseFloat(m[2]);
    }
    return Object.keys(result).length ? result : null;
}

function cleanSourceName(name) {
    return name.replace(/\s*\([\d.]+,\s*[\d.]+\)\s*$/, '');
}

function wowIconUrl(iconPath) {
    if (!iconPath || typeof iconPath !== 'string') return '';
    // WoW GetItemInfo returns paths like "Interface\\Icons\\INV_Sword_04"
    const name = iconPath.replace(/^Interface\\Icons\\/i, '').replace(/^Interface\/Icons\//i, '').toLowerCase();
    if (!name) return '';
    return `https://wow.zamimg.com/images/wow/icons/medium/${name}.jpg`;
}

const BIND_MAP = {
    'BOP': 'Binds when picked up',
    'BOE': 'Binds when equipped',
    'BOU': 'Binds when used',
    'QUEST': 'Quest Item',
};

const STAT_LABELS = {
    str: 'Strength', agi: 'Agility', sta: 'Stamina', int: 'Intellect', spi: 'Spirit',
    crit: 'Critical Strike Rating', hit: 'Hit Rating', haste: 'Haste Rating',
    ap: 'Attack Power', sp: 'Spell Power', mp5: 'MP5', def: 'Defense Rating',
};

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
    const result = { kills: [], items: [], loot: [], quests: [], vendors: [], meta: null };

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
                name:           getStr('name', block)           || key.split('|')[0],
                npcId:          getNum('npcId', block)          || null,
                zone:           getStr('zone', block)           || '',
                subZone:        getStr('subZone', block)        || '',
                coords:         getStr('coords', block)         || '',
                level:          getNum('level', block)          || null,
                classification: getStr('classification', block) || null,
                creatureType:   getStr('creatureType', block)   || null,
                maxHp:          getNum('maxHp', block)          || null,
                count:          getNum('count', block)          || 1,
            });
        }
    }

    // ── ITEMS ──
    const itemsTable = extractTable('items', content);
    if (itemsTable) {
        const itemEntries = parseEntries(itemsTable);
        console.log(`[PARSE] Found items table with ${itemEntries.length} entries`);
        for (const { key, block } of itemEntries) {
            const rawSlot = getStr('slot', block) || '';

            // Parse the extras subtable (tooltip-scanned rich data)
            const extrasBlock = extractTable('extras', block);
            let bindType = '', slotName = '', armorType = '';
            let armorVal = 0, attrs = null, weapon = null;
            let effects = [], requires = [], setBonuses = [];

            if (extrasBlock) {
                bindType  = getStr('bindType', extrasBlock) || '';
                slotName  = getStr('slotName', extrasBlock) || '';
                armorType = getStr('armorType', extrasBlock) || '';
                armorVal  = getNum('armor', extrasBlock) || 0;

                // Parse attrs table { str=N, agi=N, ... }
                attrs = parseKVNums('attrs', extrasBlock);

                // Parse weapon table { min=N, max=N, dps=N, speed=N }
                const weaponInner = extractTable('weapon', extrasBlock);
                if (weaponInner) {
                    weapon = {};
                    const wMin = getFloat('min', weaponInner);
                    const wMax = getFloat('max', weaponInner);
                    const wDps = getFloat('dps', weaponInner);
                    const wSpd = getFloat('speed', weaponInner);
                    if (wMin != null) weapon.min = wMin;
                    if (wMax != null) weapon.max = wMax;
                    if (wDps != null) weapon.dps = wDps;
                    if (wSpd != null) weapon.speed = wSpd;
                    if (!Object.keys(weapon).length) weapon = null;
                }

                // Parse effects array of { type, text } sub-tables
                const effectsInner = extractTable('effects', extrasBlock);
                if (effectsInner) {
                    const subs = parseSubTables(effectsInner);
                    for (const sub of subs) {
                        const t = getStr('type', sub);
                        const txt = getStr('text', sub);
                        if (t && txt) effects.push({ type: t, text: txt });
                    }
                }

                // Parse requires array of strings
                requires = getArray('requires', extrasBlock);

                // Parse setBonuses array of strings
                setBonuses = getArray('setBonuses', extrasBlock);
            }

            // Format effects as display strings
            const effectStrings = effects.map(e => {
                const prefix = e.type === 'equip' ? 'Equip' : e.type === 'use' ? 'Use' : e.type === 'chance' ? 'Chance on hit' : e.type;
                return `${prefix}: ${e.text}`;
            });

            // Format attrs as display strings
            const statStrings = [];
            if (attrs) {
                for (const [k, v] of Object.entries(attrs)) {
                    const label = STAT_LABELS[k] || k;
                    statStrings.push(`+${v} ${label}`);
                }
            }

            // Format weapon as display strings
            const dmgStr = weapon && weapon.min != null && weapon.max != null
                ? `${weapon.min} - ${weapon.max} Damage` : '';
            const spdStr = weapon && weapon.speed != null ? String(weapon.speed) : '';
            const dpsStr = weapon && weapon.dps != null ? String(weapon.dps) : '';

            // Map binding code to display string
            const bindingStr = BIND_MAP[bindType] || '';

            // Extract reqLevel from requires array
            let reqLevel = 0;
            for (const req of requires) {
                const lvlMatch = req.match(/Requires Level (\d+)/i);
                if (lvlMatch) reqLevel = parseInt(lvlMatch[1]);
            }

            result.items.push({
                id:         getStr('id', block) || key,
                name:       getStr('name', block) || '',
                type:       getStr('type', block) || '',
                subType:    getStr('subType', block) || '',
                slot:       rawSlot,
                slotName,
                ilvl:       getNum('ilvl', block) || 0,
                quality:    getNum('quality', block) ?? 1,
                icon:       wowIconUrl(getStr('icon', block)),
                binding:    bindingStr,
                bindType,
                armorType,
                armor:      armorVal,
                attrs,
                weapon,
                effects:    effectStrings,
                stats:      statStrings,
                requires,
                setBonuses,
                reqLevel,
                dmg:        dmgStr,
                speed:      spdStr,
                dps:        dpsStr,
            });
        }
    }

    // ── LOOT ──
    const lootTable = extractTable('loot', content);
    if (lootTable) {
        const lootEntries = parseEntries(lootTable);
        console.log(`[PARSE] Found loot table with ${lootEntries.length} entries`);
        for (const { key, block } of lootEntries) {
            // Parse raw sources with coordinate suffixes
            const rawSources = {};
            const sourcesInner = extractTable('sources', block);
            if (sourcesInner) {
                const srcRe = /\["([^"]+)"\]\s*=\s*(\d+)/g;
                let sm;
                while ((sm = srcRe.exec(sourcesInner)) !== null) {
                    rawSources[sm[1]] = parseInt(sm[2]);
                }
            }
            // Clean source names by stripping coordinate suffixes and merging
            const sources = {};
            for (const [src, cnt] of Object.entries(rawSources)) {
                const clean = cleanSourceName(src);
                sources[clean] = (sources[clean] || 0) + cnt;
            }
            const totalDrops = Object.values(sources).reduce((a, b) => a + b, 0);
            result.loot.push({
                id:         getStr('id', block) || key,
                name:       getStr('name', block) || '',
                quality:    getNum('quality', block) ?? 1,
                count:      getNum('count', block) || 1,
                sources,
                source:     Object.keys(sources)[0] || '',
                totalDrops,
            });
        }
    }

    // ── QUESTS ──
    const questsTable = extractTable('quests', content);
    if (questsTable) {
        const questEntries = parseEntries(questsTable);
        console.log(`[PARSE] Found quests table with ${questEntries.length} entries`);
        for (const { key, block } of questEntries) {
            // Choice rewards (pick one)
            const rewards = {};
            const rewardsInner = extractTable('rewards', block);
            if (rewardsInner) {
                const rwRe = /\["([^"]+)"\]\s*=\s*(\d+)/g;
                let rm;
                while ((rm = rwRe.exec(rewardsInner)) !== null) {
                    rewards[rm[1]] = parseInt(rm[2]);
                }
            }
            // Fixed rewards (always given) — stored as subtable { [id] = { id, name, count } }
            const rewardItems = [];
            const rewardItemsInner = extractTable('rewardItems', block);
            if (rewardItemsInner) {
                const riEntries = parseEntries(rewardItemsInner);
                for (const ri of riEntries) {
                    rewardItems.push({
                        id:    getStr('id', ri.block) || ri.key,
                        name:  getStr('name', ri.block) || '',
                        count: getNum('count', ri.block) || 1,
                    });
                }
            }
            // Required items — stored as subtable { [id] = { id, name, count } }
            const requiredItems = [];
            const requiredItemsInner = extractTable('requiredItems', block);
            if (requiredItemsInner) {
                const rqEntries = parseEntries(requiredItemsInner);
                for (const rq of rqEntries) {
                    requiredItems.push({
                        id:    getStr('id', rq.block) || rq.key,
                        name:  getStr('name', rq.block) || '',
                        count: getNum('count', rq.block) || 1,
                    });
                }
            }
            const questId = getStr('questId', block) || getNum('questId', block) || null;
            result.quests.push({
                key,
                questId:        questId ? String(questId) : null,
                name:           getStr('name', block) || key,
                zone:           getStr('zone', block) || '',
                coords:         getStr('coords', block) || '',
                completions:    getNum('completions', block) || 1,
                questText:      getStr('questText', block) || '',
                objectiveText:  getStr('objectiveText', block) || '',
                progressText:   getStr('progressText', block) || '',
                rewardText:     getStr('rewardText', block) || '',
                rewardMoney:    getNum('rewardMoney', block) || 0,
                suggestedGroup: getNum('suggestedGroup', block) || 0,
                rewards,
                rewardItems,
                requiredItems,
            });
        }
    }

    // ── VENDORS ──
    const vendorsTable = extractTable('vendors', content);
    if (vendorsTable) {
        const vendorEntries = parseEntries(vendorsTable);
        console.log(`[PARSE] Found vendors table with ${vendorEntries.length} entries`);
        for (const { key, block } of vendorEntries) {
            const itemsInner = extractTable('items', block);
            let itemCount = 0;
            const vendorItems = [];
            if (itemsInner) {
                const subs = parseSubTables(itemsInner);
                itemCount = subs.length;
                for (const sub of subs) {
                    const iId = getStr('id', sub) || String(getNum('id', sub) || '');
                    const iName = getStr('name', sub);
                    const iQuality = getNum('quality', sub);
                    const iPrice = getNum('priceCopper', sub);
                    const iIcon = wowIconUrl(getStr('icon', sub));
                    if (iId && iName) {
                        vendorItems.push({ id: iId, name: iName, quality: iQuality, priceCopper: iPrice, icon: iIcon });
                    }
                }
            }
            result.vendors.push({
                key,
                name:      getStr('name', block) || key,
                npcId:     getNum('npcId', block) || null,
                zone:      getStr('zone', block) || '',
                subZone:   getStr('subZone', block) || '',
                canRepair: getBool('canRepair', block) || false,
                lastSeen:  getStr('lastSeen', block) || '',
                itemCount,
                items:     vendorItems,
            });
        }
    }

    // ── META ──
    const metaTable = extractTable('meta', content);
    if (metaTable) {
        console.log(`[PARSE] Found meta table`);
        result.meta = {
            player:    getStr('player', metaTable) || '',
            realm:     getStr('realm', metaTable) || '',
            class:     getStr('class', metaTable) || '',
            race:      getStr('race', metaTable) || '',
            faction:   getStr('faction', metaTable) || '',
            level:     getNum('level', metaTable) || 0,
            sessions:  getNum('sessions', metaTable) || 0,
            lastSeen:  getStr('lastSeen', metaTable) || '',
            firstSeen: getStr('firstSeen', metaTable) || '',
        };
    }

    console.log(`[PARSE] Complete: ${result.kills.length} kills, ${result.items.length} items, ${result.loot.length} loot, ${result.quests.length} quests, ${result.vendors.length} vendors`);
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

        console.log(`[UPLOAD] Parse result: ${parsed.kills.length} kills, ${parsed.items.length} items, ${parsed.loot.length} loot, ${parsed.quests.length} quests, ${parsed.vendors.length} vendors`);

        if (parsed.kills.length === 0 && parsed.items.length === 0 && parsed.loot.length === 0 && parsed.quests.length === 0 && parsed.vendors.length === 0) {
            console.warn(`[UPLOAD] Warning: No data extracted from file.`);
        }

        const ops = [];

        // ── KILLS → npcs ──
        for (const npc of parsed.kills) {
            const setFields = {
                name: npc.name,
                'data.zone': npc.zone, 'data.subZone': npc.subZone, 'data.coords': npc.coords,
            };
            if (npc.npcId) setFields['data.npcId'] = npc.npcId;
            if (npc.level) { setFields['data.level'] = npc.level; setFields.level = npc.level; }
            if (npc.classification) {
                setFields['data.classification'] = npc.classification;
                const typeMap = { worldboss: 'boss', rareelite: 'rare', rare: 'rare', elite: 'elite', normal: 'normal' };
                setFields['data.type'] = typeMap[npc.classification] || npc.classification;
            }
            if (npc.creatureType) setFields['data.creatureType'] = npc.creatureType;
            if (npc.maxHp) setFields['data.maxHp'] = npc.maxHp;
            ops.push({
                updateOne: {
                    filter: { type: 'npcs', id: npc.key },
                    update: { $set: setFields, $inc: { 'data.kills': npc.count } },
                    upsert: true
                }
            });
        }

        // ── ITEMS ──
        for (const item of parsed.items) {
            if (!item.name) continue;
            const mappedSlot = SLOT_MAP[item.slot] || item.slotName || item.slot;
            const setFields = {
                name: item.name, quality: item.quality, level: item.ilvl,
                'data.type': item.type, 'data.subType': item.subType,
                'data.slot': mappedSlot, 'data.armorType': item.armorType,
            };
            if (item.icon) setFields['data.icon'] = item.icon;
            if (item.effects.length) setFields.effects = item.effects;
            if (item.binding) setFields['data.binding'] = item.binding;
            if (item.bindType) setFields['data.bindType'] = item.bindType;
            if (item.reqLevel) setFields['data.reqLevel'] = item.reqLevel;
            if (item.armor) setFields['data.armor'] = item.armor;
            if (item.stats.length) setFields['data.stats'] = item.stats;
            if (item.attrs) setFields['data.attrs'] = item.attrs;
            if (item.weapon) setFields['data.weapon'] = item.weapon;
            if (item.dmg) setFields['data.dmg'] = item.dmg;
            if (item.speed) setFields['data.speed'] = item.speed;
            if (item.dps) setFields['data.dps'] = item.dps;
            if (item.requires.length) setFields['data.requires'] = item.requires;
            if (item.setBonuses.length) setFields['data.setBonuses'] = item.setBonuses;
            ops.push({
                updateOne: {
                    filter: { type: 'items', id: item.id },
                    update: { $set: setFields, $inc: { 'data.seen': 1 } },
                    upsert: true
                }
            });
        }

        // ── LOOT ──
        for (const drop of parsed.loot) {
            if (!drop.name) continue;
            const sourceInc = {};
            for (const [src, cnt] of Object.entries(drop.sources)) {
                sourceInc[`data.sources.${src.replace(/[.\$]/g, '_')}`] = cnt;
            }
            ops.push({
                updateOne: {
                    filter: { type: 'loot', id: drop.id },
                    update: {
                        $set: { name: drop.name, quality: drop.quality, 'data.source': drop.source },
                        $inc: { 'data.drops': drop.totalDrops, 'data.samples': drop.count, ...sourceInc },
                    },
                    upsert: true
                }
            });
        }

        // ── QUESTS ──
        for (const quest of parsed.quests) {
            if (!quest.name) continue;
            // Use questId as record id when available, fall back to key (name) for old data
            const questRecordId = quest.questId || quest.key;
            const setFields = {
                name: quest.name,
                'data.zone': quest.zone, 'data.coords': quest.coords,
            };
            if (quest.questId) setFields['data.questId'] = quest.questId;
            // Store text fields (only overwrite if non-empty so we don't blank out existing data)
            if (quest.questText)      setFields['data.questText']      = quest.questText;
            if (quest.objectiveText)  setFields['data.objectiveText']  = quest.objectiveText;
            if (quest.progressText)   setFields['data.progressText']   = quest.progressText;
            if (quest.rewardText)     setFields['data.rewardText']     = quest.rewardText;
            if (quest.rewardMoney)    setFields['data.rewardMoney']    = quest.rewardMoney;
            if (quest.suggestedGroup) setFields['data.suggestedGroup'] = quest.suggestedGroup;
            if (quest.rewardItems && quest.rewardItems.length)   setFields['data.rewardItems']   = quest.rewardItems;
            if (quest.requiredItems && quest.requiredItems.length) setFields['data.requiredItems'] = quest.requiredItems;
            const rewardInc = {};
            for (const [itemId, cnt] of Object.entries(quest.rewards)) {
                rewardInc[`data.rewards.${itemId}`] = cnt;
            }
            ops.push({
                updateOne: {
                    filter: { type: 'quests', id: questRecordId },
                    update: {
                        $set: setFields,
                        $inc: { 'data.completions': quest.completions, ...rewardInc },
                    },
                    upsert: true
                }
            });
        }

        // ── VENDORS ──
        for (const vendor of parsed.vendors) {
            if (!vendor.name) continue;
            ops.push({
                updateOne: {
                    filter: { type: 'vendors', id: vendor.key },
                    update: {
                        $set: {
                            name: vendor.name,
                            'data.zone': vendor.zone, 'data.subZone': vendor.subZone,
                            'data.npcId': vendor.npcId, 'data.canRepair': vendor.canRepair,
                            'data.lastSeen': vendor.lastSeen, 'data.itemCount': vendor.itemCount,
                            'data.items': vendor.items,
                        },
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
            breakdown: {
                kills: parsed.kills.length, items: parsed.items.length, loot: parsed.loot.length,
                quests: parsed.quests.length, vendors: parsed.vendors.length,
            }
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
        const query = (req.query.q || '').trim();
        if (!query) return res.json([]);
        const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const results = await Record.find({ name: { $regex: escaped, $options: 'i' } }).limit(50);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: 'Search failed' });
    }
});

app.get('/api/list/:category', async (req, res) => {
    try {
        const data = await Record.find({ type: req.params.category, name: { $exists: true, $ne: '' } }).limit(1000);
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

// Cross-reference: find all loot records that drop a given item (by name)
app.get('/api/item-sources/:name', async (req, res) => {
    try {
        const itemName = decodeURIComponent(req.params.name);
        const lootRecords = await Record.find({
            type: 'loot',
            name: { $regex: `^${itemName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' }
        }).limit(50).lean();
        const sources = lootRecords.map(l => ({
            id: l.id,
            source: (l.data && l.data.source) || 'Unknown',
            sources: (l.data && l.data.sources) || {},
            drops: (l.data && l.data.drops) || 0,
            samples: (l.data && l.data.samples) || 0,
            rate: (l.data && l.data.samples) ? (l.data.drops / l.data.samples) : 0,
            quality: l.quality || 0,
        }));
        res.json(sources);
    } catch (err) {
        res.status(500).json({ error: 'Could not fetch item sources' });
    }
});

// Cross-reference: find all loot dropped by a given NPC (by source name)
app.get('/api/npc-drops/:name', async (req, res) => {
    try {
        const npcName = decodeURIComponent(req.params.name);
        const escapedName = npcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const lootRecords = await Record.find({
            type: 'loot',
            $or: [
                { 'data.source': { $regex: `^${escapedName}$`, $options: 'i' } },
                { [`data.sources.${npcName.replace(/[.\$]/g, '_')}`]: { $exists: true } }
            ]
        }).limit(100).lean();
        const drops = lootRecords.map(l => {
            const srcKey = npcName.replace(/[.\$]/g, '_');
            const npcDrops = (l.data && l.data.sources && l.data.sources[srcKey]) || (l.data && l.data.drops) || 0;
            return {
                id: l.id,
                name: l.name || 'Unknown',
                quality: l.quality || 0,
                drops: npcDrops,
                samples: (l.data && l.data.samples) || 0,
                rate: (l.data && l.data.samples) ? (npcDrops / l.data.samples) : 0,
            };
        });
            drops.sort((a, b) => b.quality - a.quality || b.drops - a.drops);
                res.json(drops);
            } catch (err) {
                res.status(500).json({ error: 'Could not fetch NPC drops' });
            }
        });

        // Cross-reference: resolve item IDs to item details (for quest rewards display)
        app.post('/api/resolve-items', async (req, res) => {
            try {
                const { ids } = req.body;
                if (!ids || !Array.isArray(ids) || ids.length === 0) return res.json([]);
                // Search by item ID in the record id field, limited to items type
                const items = await Record.find({
                    type: 'items',
                    $or: ids.map(id => ({ id: String(id) }))
                }).limit(100).lean();
                const result = items.map(i => ({
                    id: i.id,
                    name: i.name || 'Unknown',
                    quality: i.quality || 0,
                    level: i.level || 0,
                    slot: (i.data && i.data.slot) || '',
                    type: (i.data && i.data.type) || '',
                    subType: (i.data && i.data.subType) || '',
                    icon: (i.data && i.data.icon) || '⚔',
                }));
                res.json(result);
            } catch (err) {
                res.status(500).json({ error: 'Could not resolve items' });
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
        // 7b. ROGUE DAMAGE CALCULATOR (normalized weapon damage + ability formulas)
        // ═══════════════════════════════════════════════════════════════
        function computeRogueDamage(body) {
            const ap = Math.max(0, Number(body.ap) || 0);
            const mh = body.mh || {};
            const oh = body.oh || {};
            const mLow = Number(mh.low);
            const mHigh = Number(mh.high);
            const mSpd = Number(mh.speed);
            const oLow = Number(oh.low);
            const oHigh = Number(oh.high);
            const oSpd = Number(oh.speed);
            const mhDagger = !!mh.dagger;
            const ohDagger = !!oh.dagger;
            const normMH = mhDagger ? 1.7 : 2.4;
            const normOH = ohDagger ? 1.7 : 2.4;

            const mhMid = (Number.isFinite(mLow) && Number.isFinite(mHigh)) ? (mLow + mHigh) / 2 : 0;
            const ohMid = (Number.isFinite(oLow) && Number.isFinite(oHigh)) ? (oLow + oHigh) / 2 : 0;
            const ap14 = ap / 14;
            const mSpdF = Number.isFinite(mSpd) ? mSpd : 0;
            const oSpdF = Number.isFinite(oSpd) ? oSpd : 0;

            const t = body.talents || {};
            const rank = (name) => Math.max(0, Number(t[name]) || 0);

            const aggression = rank('Aggression');
            const surprise = rank('Surprise Attacks');
            const sinisterCalling = rank('Sinister Calling');
            const opportunity = rank('Opportunity');
            const dws = rank('Dual Wield Specialization');
            const impEvis = rank('Improved Eviscerate');
            const serrated = rank('Serrated Blades');
            const lethality = rank('Lethality');
            const vile = rank('Vile Poisons');

            const awd = ap14 * mSpdF + mhMid;
            const nwd = ap14 * normMH + mhMid;
            const ohRawWeapon = ap14 * oSpdF + ohMid;
            const ohawd = ohRawWeapon * 0.5 * (1 + 0.1 * dws);
            const ohnwd = ap14 * normOH + ohMid;

            const surpriseMul = 1 + 0.1 * surprise;
            const lethCritMult = 2 + 0.06 * lethality;
            const stdCritMult = 2;

            const abilities = [];

            const addAbi = (name, avg, critMult, canCrit) => {
                const c = canCrit ? avg * critMult : null;
                abilities.push({
                    name,
                    avg,
                    crit: c,
                    canCrit,
                    critMult: canCrit ? critMult : null,
                });
            };

            const sinStrike = (nwd + 68) * (1 + 0.02 * aggression) * (1 + 0.1 * surprise);
            addAbi('Sinister Strike', sinStrike, lethCritMult, true);

            const hemo = awd * (1.1 + 0.01 * sinisterCalling);
            addAbi('Hemorrhage', hemo, lethCritMult, true);

            const bs = (nwd * (1.5 + 0.01 * sinisterCalling) + 210) * (1 + 0.02 * aggression) * (1 + 0.04 * opportunity) * surpriseMul;
            addAbi('Backstab', bs, lethCritMult, true);

            const mutInner = (nwd + 88) + (ohnwd + 88 * (1 + 0.1 * dws));
            const muti = mutInner * (1 + 0.04 * opportunity) * 1.5;
            addAbi('Mutilate', muti, lethCritMult, true);

            const shiv = ohawd * surpriseMul;
            addAbi('Shiv', shiv, lethCritMult, true);

            addAbi('Ghostly Strike', awd * 1.25, lethCritMult, true);
            addAbi('Riposte', awd * 1.5, stdCritMult, true);

            const garrote = (92 + ap * 0.032) * 6 * (1 + 0.04 * opportunity);
            addAbi('Garrote', garrote, null, false);

            const ambush = (nwd * 2.75 + 290) * (1 + 0.04 * opportunity);
            addAbi('Ambush', ambush, stdCritMult, true);

            const evis = ((54 + 162) / 2 + 170 * 5 + ap * 0.03 * 5) * (1 + 0.05 * impEvis) * (1 + 0.02 * aggression);
            addAbi('Eviscerate', evis, stdCritMult, true);

            const rupt = ((60 + 8 * 5) * (3 + 5) + 0.064 * 5 * ap) * (1 + 0.1 * serrated);
            addAbi('Rupture', rupt, null, false);

            const envenom = 144 * 5 + 0.03 * 5 * ap;
            addAbi('Envenom', envenom, stdCritMult, true);

            const vpMul = 1 + 0.04 * vile;
            const poisons = [
                { name: 'Instant Poison VI', avg: Math.round((112 + 0.1 * ap) * vpMul), canCrit: false },
                { name: 'Deadly Poison IV', avg: Math.round((108 + 0.12 * ap) * vpMul), canCrit: false },
                { name: 'Wound Poison IV', avg: 53 * vpMul, canCrit: false },
            ];

            return {
                awd, nwd, ohawd, ohnwd,
                abilities,
                poisons,
            };
        }

        app.post('/api/rogue-damage', (req, res) => {
            try {
                const out = computeRogueDamage(req.body || {});
                res.json(out);
            } catch (err) {
                console.error('[rogue-damage]', err);
                res.status(500).json({ error: 'Rogue damage calculation failed' });
            }
        });

        // ═══════════════════════════════════════════════════════════════
        // 7c. MAGE SPELL DAMAGE (spell power + talent modifiers)
        // ═══════════════════════════════════════════════════════════════
        /** ~TBC: spell hit rating per 1% hit vs +3 level target */
        const MAGE_SPELL_HIT_RATING_PER_PCT = 12.615;

        function computeMageDamage(body) {
            const spGear = Math.max(0, Number(body.spellPower) || 0);
            const intBase = Math.max(0, Number(body.intellect) || 0);
            const hitRating = Math.max(0, Number(body.hitRating) || 0);
            const t = body.talents || {};
            const rank = (name) => Math.max(0, Number(t[name]) || 0);

            const arcaneMind = rank('Arcane Mind');
            const mindMastery = rank('Mind Mastery');
            const arcaneFocus = rank('Arcane Focus');
            const elementalPrecision = rank('Elemental Precision');

            const intEff = intBase * (1 + 0.03 * Math.min(arcaneMind, 5));
            const mindMasteryBonus = intEff * 0.05 * Math.min(mindMastery, 5);
            const sp = spGear + mindMasteryBonus;

            const hitFromGearPct = hitRating / MAGE_SPELL_HIT_RATING_PER_PCT;
            const arcaneSpellHitPct = hitFromGearPct + 2 * Math.min(arcaneFocus, 5);
            const fireFrostSpellHitPct = hitFromGearPct + 2 * Math.min(elementalPrecision, 3);

            const playingWithFire = rank('Playing with Fire');
            const arcaneInstability = rank('Arcane Instability');
            const firePower = rank('Fire Power');
            const piercingIce = rank('Piercing Ice');
            const arcticWinds = rank('Arctic Winds');
            const empoweredFireball = rank('Empowered Fireball');
            const empoweredFrostbolt = rank('Empowered Frostbolt');
            const empoweredAM = rank('Empowered Arcane Missiles');
            const spellPowerTalent = rank('Spell Power');
            const iceShards = rank('Ice Shards');

            const globalPct = playingWithFire + arcaneInstability;
            const fireMod = 1 + (globalPct + firePower * 2) / 100;
            const frostMod = 1 + (globalPct + piercingIce * 2 + arcticWinds) / 100;
            const arcaneMod = 1 + globalPct / 100;

            const fbCoef = 1.0 + 0.03 * empoweredFireball;
            const fireball = (600 + fbCoef * sp) * fireMod;

            const fsCoef = 0.814 + 0.02 * empoweredFrostbolt;
            const frostbolt = (550 + fsCoef * sp) * frostMod;

            const amCoef = 1.0 + 0.15 * empoweredAM;
            const arcaneMissiles = (450 + amCoef * sp) * arcaneMod;

            const fireBlast = (425 + 0.429 * sp) * fireMod;
            const pyroblast = (228 + 1.35 * sp) * fireMod;
            const blizzard = (960 + 0.952 * sp) * frostMod;
            const arcaneBlast = (101.5 + 0.429 * sp) * arcaneMod;

            const iceLanceNorm = (248 + 0.429 * sp) * frostMod;
            const iceLanceFrozen = iceLanceNorm * 3;

            const arcaneFireCritMult = 1.5 + 0.25 * Math.min(spellPowerTalent, 2);
            const frostCritMult = arcaneFireCritMult * (1 + 0.2 * Math.min(iceShards, 5));

            const abilities = [
                { name: 'Fireball', avg: fireball, crit: fireball * arcaneFireCritMult },
                { name: 'Frostbolt', avg: frostbolt, crit: frostbolt * frostCritMult },
                { name: 'Arcane Missiles', avg: arcaneMissiles, crit: arcaneMissiles * arcaneFireCritMult },
                { name: 'Fire Blast', avg: fireBlast, crit: fireBlast * arcaneFireCritMult },
                { name: 'Pyroblast', avg: pyroblast, crit: pyroblast * arcaneFireCritMult },
                { name: 'Blizzard', avg: blizzard, crit: blizzard * frostCritMult },
                { name: 'Arcane Blast', avg: arcaneBlast, crit: arcaneBlast * arcaneFireCritMult },
                {
                    name: 'Ice Lance',
                    avg: iceLanceNorm,
                    crit: iceLanceNorm * frostCritMult,
                    iceLanceFrozen: {
                        avg: iceLanceFrozen,
                        crit: iceLanceFrozen * frostCritMult,
                    },
                },
            ];

            const stats = {
                intellectBase: intBase,
                intellectEffective: intEff,
                mindMasteryBonus,
                spellPowerFromGear: spGear,
                spellPowerTotal: sp,
                hitRating,
                hitFromGearPercent: hitFromGearPct,
                arcaneSpellHitPercent: arcaneSpellHitPct,
                fireFrostSpellHitPercent: fireFrostSpellHitPct,
            };

            return { abilities, stats };
        }

        app.post('/api/mage-damage', (req, res) => {
            try {
                const out = computeMageDamage(req.body || {});
                res.json(out);
            } catch (err) {
                console.error('[mage-damage]', err);
                res.status(500).json({ error: 'Mage damage calculation failed' });
            }
        });

        // ═══════════════════════════════════════════════════════════════
        // 7d. WARRIOR DAMAGE (AP + hit rating; default 2H weapon model)
        // ═══════════════════════════════════════════════════════════════
        const WARRIOR_MELEE_HIT_RATING_PER_PCT = 15.77;

        function computeWarriorDamage(body) {
            const apBase = Math.max(0, Number(body.attackPower) || 0);
            const hitRating = Math.max(0, Number(body.hitRating) || 0);
            const t = body.talents || {};
            const rank = (name) => Math.max(0, Number(t[name]) || 0);

            const improvedBerserker = rank('Improved Berserker Stance');
            const ap = apBase * (1 + 0.02 * Math.min(improvedBerserker, 5));

            const mhSpd = Math.max(0.1, Number(body.mh?.speed) || 3.6);
            const mhLo  = Math.max(0, Number(body.mh?.low)   || 90);
            const mhHi  = Math.max(0, Number(body.mh?.high)  || 168);
            const awd   = (ap / 14) * mhSpd + (mhLo + mhHi) / 2;
            const twoH  = !!body.twoHanded;
            const ohSpd = Math.max(0.1, Number(body.oh?.speed) || 2.6);
            const ohLo  = Math.max(0, Number(body.oh?.low)   || 100);
            const ohHi  = Math.max(0, Number(body.oh?.high)  || 180);
            const ohawd = twoH ? null : (ap / 14) * ohSpd + (ohLo + ohHi) / 2;

            const twoHanded = rank('Two-Handed Weapon Specialization');
            const twoHMod = 1 + 0.01 * Math.min(twoHanded, 5);
            const impale = rank('Impale');
            const bloodFrenzy = rank('Blood Frenzy');
            const impRend = rank('Improved Rend');
            const impTC = rank('Improved Thunder Clap');
            const prescision = rank('Prescision');
            const ohSpec = rank('One-Handed Weapon Specialization');

            const bfMod = 1 + 0.02 * Math.min(bloodFrenzy, 2);
            const phys2h = bfMod * twoHMod;
            const ohDmgMod = 1 + 0.02 * Math.min(ohSpec, 5);

            const tcImpMul = impTC <= 0 ? 1 : impTC === 1 ? 1.4 : impTC === 2 ? 1.7 : 2.0;

            const heroic = (awd + 176) * phys2h;
            const rend = ((awd * 0.35) + ap * 0.05) * (1 + 0.25 * Math.min(impRend, 3)) * bfMod;
            const overpower = (awd + 45) * phys2h;
            const thunderClap = (180 + ap * 0.1) * tcImpMul * phys2h;
            const slam = (awd * 1.1 + 140) * phys2h;
            const mortalStrike = (awd * 1.1 + 88) * phys2h;
            const whirlwind = awd * phys2h;
            const execute = Math.min(4500, 200 + Math.max(0, ap - 20) * 4.5) * bfMod;
            const bloodthirst = ap * 0.45 * bfMod;
            const berserkerStrike = ap * 0.4 * bfMod;
            const awd1h = awd;
            const shieldSlam = (230 + ap * 0.06) * ohDmgMod * bfMod;
            const devastate = (awd1h * 0.5 + 75) * ohDmgMod * bfMod;

            const critMult = 2 * (1 + 0.1 * Math.min(impale, 2));

            const hitFromGearPct = hitRating / WARRIOR_MELEE_HIT_RATING_PER_PCT;
            const meleeHitPct = hitFromGearPct + 1 * Math.min(prescision, 3);

            const addAbi = (name, avg) => ({
                name,
                avg,
                crit: avg * critMult,
            });

            const abilities = [
                addAbi('Heroic Strike', heroic),
                addAbi('Rend', rend),
                addAbi('Overpower', overpower),
                addAbi('Thunder Clap', thunderClap),
                addAbi('Slam', slam),
                addAbi('Mortal Strike', mortalStrike),
                addAbi('Whirlwind', whirlwind),
                addAbi('Execute', execute),
                addAbi('Berserker Strike', berserkerStrike),
                addAbi('Shield Slam', shieldSlam),
                addAbi('Devastate', devastate),
            ];

            const stats = {
                awd,
                ohawd,
                attackPowerBase: apBase,
                attackPowerEffective: ap,
                hitRating,
                hitFromGearPercent: hitFromGearPct,
                meleeHitPercent: meleeHitPct,
            };

            return { abilities, stats };
        }

        app.post('/api/warrior-damage', (req, res) => {
            try {
                const out = computeWarriorDamage(req.body || {});
                res.json(out);
            } catch (err) {
                console.error('[warrior-damage]', err);
                res.status(500).json({ error: 'Warrior damage calculation failed' });
            }
        });

        // ═══════════════════════════════════════════════════════════════
        // 7e. WARLOCK SPELL DAMAGE (spell power + talent modifiers)
        // ═══════════════════════════════════════════════════════════════
        const WARLOCK_SPELL_HIT_RATING_PER_PCT = 12.615;

        function computeWarlockDamage(body) {
            const spGear = Math.max(0, Number(body.spellPower) || 0);
            const critPct = Math.max(0, Number(body.critPercent) || 0);
            const hitRating = Math.max(0, Number(body.hitRating) || 0);
            const t = body.talents || {};
            const rank = (name) => Math.max(0, Number(t[name]) || 0);

            const suppression   = rank('Suppression');        // 2% hit/rank → up to 10%
            const shadowMastery = rank('Shadow Mastery');     // 2% shadow dmg/rank → up to 10%
            const ruin          = rank('Ruin');               // +100% crit damage for Destruction
            const emberstorm    = rank('Emberstorm');         // 2% fire dmg/rank → up to 10%
            const contagion     = rank('Contagion');          // 1% DoT dmg/rank → up to 5%
            const shadowAndFlame = rank('Shadow and Flame');  // +4% Shadow Bolt SP coeff/rank

            const hitFromGearPct = hitRating / WARLOCK_SPELL_HIT_RATING_PER_PCT;
            const totalHitPct    = hitFromGearPct + suppression * 2;

            const shadowMod = 1 + (shadowMastery * 2) / 100;
            const fireMod   = 1 + (emberstorm   * 2) / 100;
            const dotMod    = 1 + contagion / 100;

            // Destruction spells: 3× on crit with Ruin, else 2×
            const destCritMult = ruin >= 1 ? 3.0 : 2.0;

            // Shadow Bolt rank 9: 482–539 base, coeff 0.857 + Shadow and Flame bonus
            const sbCoef       = 0.857 + 0.04 * Math.min(shadowAndFlame, 5);
            const shadowBoltAvg = ((482 + 539) / 2 + sbCoef * spGear) * shadowMod;

            // Corruption rank 8: 172 total DoT over 18 s, coeff 0.936 — DoTs cannot crit
            const corruptionAvg = (172 + 0.936 * spGear) * shadowMod * dotMod;

            // Immolate rank 9: 327 initial + 510 DoT over 15 s, coeffs 0.143 + 0.65
            const immolateInitial = (327 + 0.143 * spGear) * fireMod;
            const immolateDot     = (510 + 0.65  * spGear) * fireMod * dotMod;
            const immolateTotal   = immolateInitial + immolateDot;

            // Drain Life rank 7: 750 total (5 ticks × 150), coeff 0.5 — channeled, no crit
            const drainLifeAvg = (750 + 0.5 * spGear) * shadowMod;

            // Searing Pain rank 8: 143–165, coeff 0.429
            const searingPainAvg = ((143 + 165) / 2 + 0.429 * spGear) * fireMod;

            // Conflagrate: 447–553, coeff 0.429
            const conflagrateAvg = ((447 + 553) / 2 + 0.429 * spGear) * fireMod;

            // Unstable Affliction rank 3: 1050 DoT over 18 s, coeff 1.0 — DoT, no crit
            const uaAvg = (1050 + 1.0 * spGear) * shadowMod * dotMod;

            // Incinerate rank 2: 444–514, coeff 0.714
            const incinerateAvg = ((444 + 514) / 2 + 0.714 * spGear) * fireMod;

            const abilities = [
                { name: 'Shadow Bolt',         avg: shadowBoltAvg,  crit: shadowBoltAvg * destCritMult },
                { name: 'Corruption',          avg: corruptionAvg,  crit: null },
                { name: 'Immolate',            avg: immolateTotal,  crit: immolateInitial * destCritMult },
                { name: 'Drain Life',          avg: drainLifeAvg,   crit: null },
                { name: 'Searing Pain',        avg: searingPainAvg, crit: searingPainAvg * destCritMult },
                { name: 'Conflagrate',         avg: conflagrateAvg, crit: conflagrateAvg * destCritMult },
                { name: 'Unstable Affliction', avg: uaAvg,          crit: null },
                { name: 'Incinerate',          avg: incinerateAvg,  crit: incinerateAvg * destCritMult },
            ];

            const stats = {
                spellPower: spGear,
                critPercent: critPct,
                hitRating,
                hitFromGearPercent: hitFromGearPct,
                totalHitPercent: totalHitPct,
            };

            return { abilities, stats };
        }

        app.post('/api/warlock-damage', (req, res) => {
            try {
                const out = computeWarlockDamage(req.body || {});
                res.json(out);
            } catch (err) {
                console.error('[warlock-damage]', err);
                res.status(500).json({ error: 'Warlock damage calculation failed' });
            }
        });

        // ═══════════════════════════════════════════════════════════════
        // 8. ADMIN ROUTES
        // ═══════════════════════════════════════════════════════════════
        const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

        // Promote a user to admin
        app.post('/api/admin/promote', async (req, res) => {
            try {
                const { email, secret } = req.body || {};
                if (!secret || !ADMIN_SECRET || secret !== ADMIN_SECRET)
                    return res.status(403).json({ error: 'Invalid admin secret' });
                const user = await User.findOneAndUpdate(
                    { email: email.toLowerCase().trim() },
                    { isAdmin: true },
                    { new: true }
                );
                if (!user) return res.status(404).json({ error: 'User not found' });
                res.json({ ok: true, email: user.email, isAdmin: user.isAdmin });
            } catch (err) {
                console.error('[admin/promote]', err);
                res.status(500).json({ error: 'Promote failed' });
            }
        });

        // List / search records
        app.get('/api/admin/records', adminMiddleware, async (req, res) => {
            try {
                const { q = '', type = '', page = '1' } = req.query;
                const limit = 50;
                const skip = (Math.max(1, parseInt(page)) - 1) * limit;
                const filter = {};
                if (type) filter.type = type;
                if (q) filter.name = { $regex: q, $options: 'i' };
                const [docs, total] = await Promise.all([
                    Record.find(filter).sort({ name: 1 }).skip(skip).limit(limit).select('type id name quality level'),
                    Record.countDocuments(filter)
                ]);
                res.json({ docs, total, page: parseInt(page), pages: Math.ceil(total / limit) });
            } catch (err) {
                console.error('[admin/records]', err);
                res.status(500).json({ error: 'Query failed' });
            }
        });

        // Delete a record
        app.delete('/api/admin/records/:type/:id', adminMiddleware, async (req, res) => {
            try {
                const { type, id } = req.params;
                const result = await Record.deleteOne({ type, id });
                if (result.deletedCount === 0) return res.status(404).json({ error: 'Record not found' });
                res.json({ ok: true });
            } catch (err) {
                console.error('[admin/records delete]', err);
                res.status(500).json({ error: 'Delete failed' });
            }
        });

        // List comments (admin — all, filterable)
        app.get('/api/admin/comments', adminMiddleware, async (req, res) => {
            try {
                const { type = '', recordId = '', page = '1' } = req.query;
                const limit = 50;
                const skip = (Math.max(1, parseInt(page)) - 1) * limit;
                const filter = {};
                if (type) filter.type = type;
                if (recordId) filter.recordId = recordId;
                const [docs, total] = await Promise.all([
                    Comment.find(filter).sort({ ts: -1 }).skip(skip).limit(limit),
                    Comment.countDocuments(filter)
                ]);
                res.json({ docs, total, page: parseInt(page), pages: Math.ceil(total / limit) });
            } catch (err) {
                console.error('[admin/comments]', err);
                res.status(500).json({ error: 'Query failed' });
            }
        });

        // Delete any comment (admin — bypasses uid check)
        app.delete('/api/admin/comments/:id', adminMiddleware, async (req, res) => {
            try {
                const result = await Comment.deleteOne({ _id: req.params.id });
                if (result.deletedCount === 0) return res.status(404).json({ error: 'Comment not found' });
                res.json({ ok: true });
            } catch (err) {
                console.error('[admin/comments delete]', err);
                res.status(500).json({ error: 'Delete failed' });
            }
        });

        // ═══════════════════════════════════════════════════════════════
        // 9. SPA FALLBACK — serve index.html for all non-API routes
        // ═══════════════════════════════════════════════════════════════
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══════════════════════════════════════════════════════════════
// 9. START
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`EpochDB Backend running on port ${PORT}`));
