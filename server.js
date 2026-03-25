const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const upload = multer({ dest: 'uploads/' });
const app = express();

app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════
// 1. DATA STRUCTURE (Schema)
// ═══════════════════════════════════════════════════════════════
const RecordSchema = new mongoose.Schema({
    type: String, // 'npcs', 'items', 'quests', 'loot'
    id: String,
    name: String,
    quality: Number, // 0-6 for items
    level: Number,
    effects: [String], // This tells MongoDB to expect an array of strings
    data: Object,   // Extra info like kills, stats, drop rates
    timestamp: { type: Date, default: Date.now }
});

const Record = mongoose.model('Record', RecordSchema);

// ═══════════════════════════════════════════════════════════════
// 2. CONNECT TO DATABASE
// ═══════════════════════════════════════════════════════════════
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/epochdb')
    .then(() => console.log("Successfully connected to MongoDB"))
    .catch(err => console.error("Database connection error:", err));

// ═══════════════════════════════════════════════════════════════
// 3. LUA PARSER
// Reads the EpochDB.lua SavedVariables file and extracts
// kills, items, quests, and loot into structured objects.
// ═══════════════════════════════════════════════════════════════
function parseLuaFile(filePath) {
    const raw = fs.readFileSync(filePath, 'utf8');

    const result = {
        kills: {},
        items: {},
        quests: {},
        loot: {},
        meta: {}
    };

    // ── SECTION EXTRACTOR ──────────────────────────────────────
    // Pulls the raw text block for a top-level table like
    // EpochDBData.kills = { ... }
    function extractSection(sectionName) {
        const pattern = new RegExp(
            `EpochDBData\\.${sectionName}\\s*=\\s*\\{([\\s\\S]*?)\\n\\}`, 'i'
        );
        const match = raw.match(pattern);
        return match ? match[1] : '';
    }

    // ── STRING VALUE HELPER ────────────────────────────────────
    function strVal(block, key) {
        const m = block.match(new RegExp(`["']?${key}["']?\\s*=\\s*["']([^"']+)["']`));
        return m ? m[1] : null;
    }

    // ── NUMBER VALUE HELPER ────────────────────────────────────
    function numVal(block, key) {
        const m = block.match(new RegExp(`["']?${key}["']?\\s*=\\s*(\\d+)`));
        return m ? parseInt(m[1]) : 0;
    }

    // ── PARSE KILLS ────────────────────────────────────────────
    // Each kill entry key is "NpcName|ZoneName"
    // Structure: { name, zone, subZone, count, firstKill, lastKill }
    const killsRaw = extractSection('kills');
    const killBlocks = killsRaw.split(/\["[^"]+"\]\s*=/);
    killBlocks.forEach(block => {
        const name = strVal(block, 'name');
        const zone = strVal(block, 'zone');
        const subZone = strVal(block, 'subZone');
        const count = numVal(block, 'count');
        const firstKill = strVal(block, 'firstKill');
        const lastKill = strVal(block, 'lastKill');
        if (name && zone && count > 0) {
            const key = `${name}|${zone}`;
            if (result.kills[key]) {
                result.kills[key].count += count;
            } else {
                result.kills[key] = { name, zone, subZone, count, firstKill, lastKill };
            }
        }
    });

    // ── PARSE ITEMS ────────────────────────────────────────────
    // Each item entry key is the item ID string
    // Structure: { id, name, link, quality, ilvl, type, subType, slot, firstSeen }
    const itemsRaw = extractSection('items');
    const itemBlocks = itemsRaw.split(/\["\d+"\]\s*=/);
    itemBlocks.forEach(block => {
        const id = strVal(block, 'id');
        const name = strVal(block, 'name');
        const quality = numVal(block, 'quality');
        const ilvl = numVal(block, 'ilvl');
        const type = strVal(block, 'type');
        const subType = strVal(block, 'subType');
        const slot = strVal(block, 'slot');
        if (id && name) {
            result.items[id] = { id, name, quality, ilvl, type, subType, slot };
        }
    });

    // ── PARSE QUESTS ───────────────────────────────────────────
    // Each quest entry key is the quest title string
    // Structure: { name, zone, completions, firstDone, lastDone }
    const questsRaw = extractSection('quests');
    const questBlocks = questsRaw.split(/\["[^"]+"\]\s*=/);
    questBlocks.forEach(block => {
        const name = strVal(block, 'name');
        const zone = strVal(block, 'zone');
        const completions = numVal(block, 'completions');
        const firstDone = strVal(block, 'firstDone');
        const lastDone = strVal(block, 'lastDone');
        if (name && completions > 0) {
            if (result.quests[name]) {
                result.quests[name].completions += completions;
            } else {
                result.quests[name] = { name, zone, completions, firstDone, lastDone };
            }
        }
    });

    // ── PARSE LOOT ─────────────────────────────────────────────
    // Each loot entry key is the item ID string
    // Structure: { id, name, quality, count, sources:{npcName: dropCount} }
    const lootRaw = extractSection('loot');
    const lootBlocks = lootRaw.split(/\["\d+"\]\s*=/);
    lootBlocks.forEach(block => {
        const id = strVal(block, 'id');
        const name = strVal(block, 'name');
        const quality = numVal(block, 'quality');
        const count = numVal(block, 'count');

        // Extract sources sub-table: { ["NpcName"] = dropCount, ... }
        const sources = {};
        const sourcesMatch = block.match(/sources\s*=\s*\{([^}]*)\}/);
        if (sourcesMatch) {
            const srcEntries = sourcesMatch[1].matchAll(/\["([^"]+)"\]\s*=\s*(\d+)/g);
            for (const [, srcName, srcCount] of srcEntries) {
                sources[srcName] = parseInt(srcCount);
            }
        }

        if (id && name && count > 0) {
            if (result.loot[id]) {
                result.loot[id].count += count;
                for (const [src, cnt] of Object.entries(sources)) {
                    result.loot[id].sources[src] = (result.loot[id].sources[src] || 0) + cnt;
                }
            } else {
                result.loot[id] = { id, name, quality, count, sources };
            }
        }
    });

    // ── PARSE META ─────────────────────────────────────────────
    const metaRaw = extractSection('meta');
    result.meta = {
        player: strVal(metaRaw, 'player'),
        realm: strVal(metaRaw, 'realm'),
        class: strVal(metaRaw, 'class'),
        faction: strVal(metaRaw, 'faction'),
        sessions: numVal(metaRaw, 'sessions'),
        lastSeen: strVal(metaRaw, 'lastSeen'),
    };

    return result;
}

// ═══════════════════════════════════════════════════════════════
// 4. CONVERT PARSED DATA → MONGODB RECORDS
// ═══════════════════════════════════════════════════════════════
async function saveToDatabase(parsed) {
    const stats = { npcs: 0, items: 0, quests: 0, loot: 0, updated: 0 };

    // ── KILLS → npcs ───────────────────────────────────────────
    for (const [key, kill] of Object.entries(parsed.kills)) {
        const id = Buffer.from(key).toString('base64').slice(0, 24);
        const existing = await Record.findOne({ type: 'npcs', id });

        if (existing) {
            existing.data.kills = (existing.data.kills || 0) + kill.count;
            existing.data.lastKill = kill.lastKill;
            existing.markModified('data');
            await existing.save();
            stats.updated++;
        } else {
            await Record.create({
                type: 'npcs',
                id,
                name: kill.name,
                data: {
                    zone: kill.zone,
                    subZone: kill.subZone,
                    kills: kill.count,
                    firstKill: kill.firstKill,
                    lastKill: kill.lastKill,
                    icon: '👹',
                    type: 'normal',
                    faction: 'Unknown',
                    class: 'Unknown',
                }
            });
            stats.npcs++;
        }
    }

    // ── ITEMS ──────────────────────────────────────────────────
    for (const [itemId, item] of Object.entries(parsed.items)) {
        const existing = await Record.findOne({ type: 'items', id: itemId });

        if (existing) {
            existing.data.seen = (existing.data.seen || 0) + 1;
            existing.markModified('data');
            await existing.save();
            stats.updated++;
        } else {
            await Record.create({
                type: 'items',
                id: itemId,
                name: item.name,
                quality: item.quality,
                level: item.ilvl,
                data: {
                    ilvl: item.ilvl,
                    type: item.type,
                    subType: item.subType,
                    slot: item.slot,
                    quality: item.quality,
                    seen: 1,
                    icon: '⚔',
                }
            });
            stats.items++;
        }
    }

    // ── QUESTS ─────────────────────────────────────────────────
    for (const [questName, quest] of Object.entries(parsed.quests)) {
        const id = Buffer.from(questName).toString('base64').slice(0, 24);
        const existing = await Record.findOne({ type: 'quests', id });

        if (existing) {
            existing.data.completions = (existing.data.completions || 0) + quest.completions;
            existing.data.lastDone = quest.lastDone;
            existing.markModified('data');
            await existing.save();
            stats.updated++;
        } else {
            await Record.create({
                type: 'quests',
                id,
                name: quest.name,
                data: {
                    zone: quest.zone,
                    completions: quest.completions,
                    firstDone: quest.firstDone,
                    lastDone: quest.lastDone,
                    icon: '📜',
                    type: 'solo',
                    xp: '—',
                    reward: '—',
                }
            });
            stats.quests++;
        }
    }

    // ── LOOT ───────────────────────────────────────────────────
    for (const [itemId, loot] of Object.entries(parsed.loot)) {
        const id = `loot_${itemId}`;
        const existing = await Record.findOne({ type: 'loot', id });

        // Find the top source (NPC that dropped it most)
        const topSource = Object.entries(loot.sources).sort((a, b) => b[1] - a[1])[0];
        const sourceName = topSource ? topSource[0] : 'Unknown';

        if (existing) {
            existing.data.drops = (existing.data.drops || 0) + loot.count;
            existing.data.samples = (existing.data.samples || 0) + loot.count;
            existing.markModified('data');
            await existing.save();
            stats.updated++;
        } else {
            await Record.create({
                type: 'loot',
                id,
                name: loot.name,
                quality: loot.quality,
                data: {
                    item: loot.name,
                    quality: loot.quality,
                    source: sourceName,
                    sources: loot.sources,
                    drops: loot.count,
                    samples: loot.count,
                    rate: 0,
                }
            });
            stats.loot++;
        }
    }

    return stats;
}

// 4. UPLOAD & SYNC ENDPOINT
app.post('/api/upload', upload.single('luaFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded" });

        // Parse the Lua file using your existing parser
        const parsedData = parseLuaFile(req.file.path);

        // Prepare bulk operations for MongoDB
        const ops = [];

        // Example: Syncing Kills/NPCs
        for (const key in parsedData.kills) {
            const kill = parsedData.kills[key];
            ops.push({
                updateOne: {
                    filter: { type: 'npcs', id: key }, // Using name|zone as ID
                    update: {
                        $set: { name: kill.name, level: 0 },
                        $inc: { "data.kills": kill.count }
                    },
                    upsert: true
                }
            });
        }

        // Execute bulk write
        if (ops.length > 0) await Record.bulkWrite(ops);

        // Clean up the uploaded temp file
        fs.unlinkSync(req.file.path);

        res.json({ message: "Database updated successfully", items: ops.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Processing failed" });
    }
});

// ═══════════════════════════════════════════════════════════════
// 5. FILE UPLOAD ENDPOINT
// ═══════════════════════════════════════════════════════════════
app.post('/api/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: "No file received" });
    }

    console.log("File received:", req.file.originalname);

    try {
        const parsed = parseLuaFile(req.file.path);

        const killCount = Object.keys(parsed.kills).length;
        const itemCount = Object.keys(parsed.items).length;
        const questCount = Object.keys(parsed.quests).length;
        const lootCount = Object.keys(parsed.loot).length;

        console.log(`Parsed: ${killCount} kills, ${itemCount} items, ${questCount} quests, ${lootCount} loot entries`);

        const stats = await saveToDatabase(parsed);

        // Clean up temp file
        fs.unlinkSync(req.file.path);

        res.json({
            success: true,
            message: `Processed! Added ${stats.npcs} NPCs, ${stats.items} items, ${stats.quests} quests, ${stats.loot} loot entries. Updated ${stats.updated} existing records.`,
            stats
        });

    } catch (err) {
        console.error("Upload processing error:", err);
        try { fs.unlinkSync(req.file.path); } catch (_) { }
        res.status(500).json({ error: "Failed to process file: " + err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// 6. SEARCH ENDPOINT
// ═══════════════════════════════════════════════════════════════
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        const results = await Record.find({
            name: { $regex: query, $options: 'i' }
        }).limit(10);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: "Search failed" });
    }
});

// ═══════════════════════════════════════════════════════════════
// 7. CATEGORY LIST ENDPOINT
// ═══════════════════════════════════════════════════════════════
app.get('/api/list/:category', async (req, res) => {
    try {
        const data = await Record.find({ type: req.params.category }).limit(100);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Could not fetch list" });
    }
});

// ═══════════════════════════════════════════════════════════════
// 8. SINGLE RECORD ENDPOINT
// ═══════════════════════════════════════════════════════════════
app.get('/api/record/:type/:id', async (req, res) => {
    try {
        const record = await Record.findOne({
            type: req.params.type,
            id: req.params.id
        });
        if (!record) return res.status(404).json({ error: "Not found" });
        res.json(record);
    } catch (err) {
        res.status(500).json({ error: "Lookup failed" });
    }
});

// ═══════════════════════════════════════════════════════════════
// 9. STATUS ROUTE
// ═══════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
    res.json({ status: 'EpochDB API is running' });
});

app.listen(3000, () => console.log('Backend server running at http://localhost:3000'));