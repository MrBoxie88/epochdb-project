const mongoose = require('mongoose');

const RecordSchema = new mongoose.Schema({
    type: String, id: String, name: String, quality: Number,
    level: Number, effects: [String], data: Object,
    timestamp: { type: Date, default: Date.now }
});
const Record = mongoose.models.Record || mongoose.model('Record', RecordSchema);

// ═══════════════════════════════════════════════════════════════
// LUA PARSER
// Handles the EpochDBData structure:
//   EpochDBData = {
//     ["kills"] = { ["NPC Name|Zone"] = { ["count"] = N, ... } }
//     ["items"] = { ["itemId"]        = { ["name"] = "...", ... } }
//     ["loot"]  = { ["itemId"]        = { ["sources"] = {...}, ... } }
//   }
// ═══════════════════════════════════════════════════════════════

/** Brace-balanced extraction of a named sub-table */
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
// NETLIFY HANDLER
// ═══════════════════════════════════════════════════════════════
exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        await mongoose.connect(process.env.MONGODB_URI);

        const parsed = parseLuaContent(event.body);
        const ops = [];

        // Sync kills
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

        // Sync items
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

        // Sync loot
        for (const drop of parsed.loot) {
            // Build per-source increment — dots in source names replaced to avoid MongoDB path issues
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

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message: 'Sync Success',
                items: ops.length,
                breakdown: { kills: parsed.kills.length, items: parsed.items.length, loot: parsed.loot.length }
            })
        };
    } catch (err) {
        console.error('Upload error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};
