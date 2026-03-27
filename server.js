const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const upload = multer({ dest: 'uploads/' });
const app = express();
app.use(cors());
app.use(express.json());

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

// ═══════════════════════════════════════════════════════════════
// 2. DATABASE
// ═══════════════════════════════════════════════════════════════
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/epochdb';
mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('DB connection error:', err));

// ═══════════════════════════════════════════════════════════════
// 3. HEALTH CHECK (Render uses this to verify the service is up)
// ═══════════════════════════════════════════════════════════════
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', db: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected' });
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

function parseLuaFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf8');
    const result = { kills: [], items: [], loot: [] };

    console.log(`[PARSE] Starting Lua parse from: ${filePath}`);
    console.log(`[PARSE] File size: ${content.length} bytes`);

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
app.post('/api/upload', upload.single('luaFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

        console.log(`[UPLOAD] Processing file: ${req.file.originalname} (${req.file.size} bytes)`);
        let parsed;
        try {
            parsed = parseLuaFile(req.file.path);
        } catch (parseErr) {
            console.error(`[UPLOAD] Parse error:`, parseErr.message);
            fs.unlinkSync(req.file.path);
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
                fs.unlinkSync(req.file.path);
                return res.status(500).json({ error: `Database sync failed: ${dbErr.message}` });
            }
        }

        fs.unlinkSync(req.file.path);

        res.json({
            message: 'Sync complete!',
            items: ops.length,
            breakdown: { kills: parsed.kills.length, items: parsed.items.length, loot: parsed.loot.length }
        });
    } catch (err) {
        console.error('[UPLOAD] Unexpected error:', err);
        try { if (req.file) fs.unlinkSync(req.file.path); } catch (_) {}
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

app.post('/api/comments/:type/:id', async (req, res) => {
    try {
        const { text, cls, author } = req.body;
        if (!text) return res.status(400).json({ error: 'Missing text' });
        const c = new Comment({
            type: req.params.type,
            recordId: req.params.id,
            text,
            cls: cls || '',
            author: author || 'Anonymous',
            ts: Date.now()
        });
        await c.save();
        res.status(201).json(c);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/comments/:type/:id/:commentId', async (req, res) => {
    try {
        const result = await Comment.findByIdAndDelete(req.params.commentId);
        if (!result) return res.status(404).json({ error: 'Comment not found' });
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
