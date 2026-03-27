const mongoose = require('mongoose');

const RecordSchema = new mongoose.Schema({
    type: String, id: String, name: String, quality: Number,
    level: Number, effects: [String], data: Object,
    timestamp: { type: Date, default: Date.now }
});
const Record = mongoose.models.Record || mongoose.model('Record', RecordSchema);

async function connect() {
    if (mongoose.connection.readyState === 1) return;
    const dbUri = process.env.NETLIFY_DATABASE_URL || process.env.MONGODB_URI;
    if (!dbUri) {
        throw new Error('Database URI not configured. Set NETLIFY_DATABASE_URL or MONGODB_URI environment variable.');
    }
    await mongoose.connect(dbUri);
}

exports.handler = async (event) => {
    try {
        await connect();
        const parts = (event.path || '').split('/').filter(Boolean);
        const fi = parts.indexOf('functions');
        const after = fi >= 0 ? parts.slice(fi + 1) : parts;
        // after = [ 'record', ':type', ':id' ]
        const type = after[1] || after[0];
        const id = after[2];
        if (!type || !id) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Missing type or id' }) };

        const doc = await Record.findOne({ type, id }).lean();
        if (!doc) return { statusCode: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Not found' }) };
        return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(doc) };
    } catch (err) {
        console.error('Record error:', err);
        return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
    }
};
