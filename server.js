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

// ═══════════════════════════════════════════════════════════════
// 1. SCHEMA
// ═══════════════════════════════════════════════════════════════
const RecordSchema = new mongoose.Schema({
    type: String, id: String, name: String, quality: Number,
    level: Number, effects: [String], data: Object,
    timestamp: { type: Date, default: Date.now }
});
const Record = mongoose.model('Record', RecordSchema);

// ═══════════════════════════════════════════════════════════════
// 2. DATABASE
// ═══════════════════════════════════════════════════════════════
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/epochdb';
mongoose.connect(MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('DB connection error:', err));

// ═══════════════════════════════════════════════════════════════
// 3. LUA PARSER
// Handles the EpochDBData structure:
//   EpochDBData = {
//     ["kills"] = { ["NPC Name|Zone"] = { ["count"] = N, ... } }
//     ["items"] = { ["itemId"]        = { ["name"] = "...", ... } }
//     ["loot"]  = { ["itemId"]        = { ["sources"] = {...}, ... } }
//   }
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
    const content = fs.readFileSync(filePath, 'utf8');
    const result = { kills: [], items: [], loot: [] };

    // ── KILLS ──
    const killsTable = extractTable('kills', content);
    if (killsTable) {
        for (const { key, block } of parseEntries(killsTable)) {
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
        for (const { key, block } of parseEntries(itemsTable)) {
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
        for (const { key, block } of parseEntries(lootTable)) {
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

    return result;
}

// ═══════════════════════════════════════════════════════════════
// 4. UPLOAD & SYNC ROUTE
// ═══════════════════════════════════════════════════════════════
app.post('/api/upload', upload.single('luaFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

        const parsed = parseLuaFile(req.file.path);
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

        if (ops.length > 0) await Record.bulkWrite(ops);
        fs.unlinkSync(req.file.path);

        res.json({
            message: 'Sync complete!',
            items: ops.length,
            breakdown: { kills: parsed.kills.length, items: parsed.items.length, loot: parsed.loot.length }
        });
    } catch (err) {
        console.error('Upload Error:', err);
        res.status(500).json({ error: 'Processing failed' });
    }
});

// ═══════════════════════════════════════════════════════════════
// 5. SEARCH & FETCH ROUTES
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
        const data = await Record.find({ type: req.params.category }).limit(100);
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
// 6. START
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`EpochDB Backend running on port ${PORT}`));
