const mongoose = require('mongoose');
const RecordSchema = new mongoose.Schema({
    type: String, id: String, name: String, quality: Number,
    level: Number, effects: [String], data: Object, 
    timestamp: { type: Date, default: Date.now }
});
const Record = mongoose.models.Record || mongoose.model('Record', RecordSchema);

// Helper to parse Lua from a string (since we have no file system)
function parseLuaContent(content) {
    const data = { kills: {} };
    const killRegex = /\["(.+?)"\]\s*=\s*(\d+)/g;
    let match;
    while ((match = killRegex.exec(content)) !== null) {
        const [fullId, count] = [match[1], parseInt(match[2])];
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