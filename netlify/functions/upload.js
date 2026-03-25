const mongoose = require('mongoose');
const RecordSchema = new mongoose.Schema({
    type: String, id: String, name: String, quality: Number,
    level: Number, effects: [String], data: Object, 
    timestamp: { type: Date, default: Date.now }
});
const Record = mongoose.models.Record || mongoose.model('Record', RecordSchema);

// Known metadata keys that appear as ["key"] = number in the Lua file
// but are NOT NPC names — filter these out.
const METADATA_KEYS = new Set([
    'ilvl', 'quality', 'count', 'sessions', 'level', 'id', 'type',
    'timestamp', 'version', 'seen', 'drops', 'samples', 'rate',
    'kills', 'items', 'quests', 'loot', 'zones', 'players'
]);

// A valid NPC kill entry must:
//   1. Not be a known metadata key
//   2. Contain at least one uppercase letter OR a space (real names have these)
//   3. Not be purely numeric
function isValidNpcKey(key) {
    const name = key.split('|')[0]; // strip zone part if present
    if (METADATA_KEYS.has(name.toLowerCase())) return false;
    if (/^\d+$/.test(name)) return false;
    if (!/[A-Z ]/.test(name)) return false; // must have a capital or space
    return true;
}

// Helper to parse Lua from a string — only reads entries inside the Kills table
function parseLuaContent(content) {
    const data = { kills: {} };

    // Find the kills table block: EpochDB_Kills = { ... } or similar
    // We look for a top-level table that contains NPC entries
    const killsTableMatch = content.match(/\w*[Kk]ills\w*\s*=\s*\{([\s\S]*?)\n\}/);
    const scope = killsTableMatch ? killsTableMatch[1] : content;

    const killRegex = /^\s*\["(.+?)"\]\s*=\s*(\d+)/gm;
    let match;
    while ((match = killRegex.exec(scope)) !== null) {
        const fullId = match[1];
        const count = parseInt(match[2]);
        if (!isValidNpcKey(fullId)) continue;
        const name = fullId.split('|')[0];
        data.kills[fullId] = { name, count };
    }
    return data;
}

exports.handler = async (event) => {
    if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

    try {
        await mongoose.connect(process.env.MONGODB_URI);
        
        // The frontend will send the file content as the body
        const parsedData = parseLuaContent(event.body);
        const ops = [];

        if (parsedData.kills) {
            for (const [id, details] of Object.entries(parsedData.kills)) {
                ops.push({
                    updateOne: {
                        filter: { type: 'npcs', id: id },
                        update: { 
                            $set: { name: details.name },
                            $inc: { "data.kills": details.count } 
                        },
                        upsert: true
                    }
                });
            }
        }

        if (ops.length > 0) await Record.bulkWrite(ops);

        return {
            statusCode: 200,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message: "Sync Success", items: ops.length })
        };
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
    }
};