const mongoose = require('mongoose');

const RecordSchema = new mongoose.Schema({
    type: String, id: String, name: String, quality: Number,
    level: Number, effects: [String], data: Object,
    timestamp: { type: Date, default: Date.now }
});
const Record = mongoose.models.Record || mongoose.model('Record', RecordSchema);

async function connect() {
    if (mongoose.connection.readyState === 1) return;
    await mongoose.connect(process.env.NETLIFY_DATABASE_URL || process.env.MONGODB_URI);
}

exports.handler = async (event) => {
    try {
        await connect();
        // path: /.netlify/functions/list/:type
        const parts = (event.path || '').split('/').filter(Boolean);
        const fi = parts.indexOf('functions');
        const after = fi >= 0 ? parts.slice(fi + 1) : parts;
        // after[0] is function name, after[1] is type (if present)
        const type = after[1] || after[0];
        if (!type) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'Missing type' };

        const docs = await Record.find({ type }).lean().limit(1000);
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify(docs)
        };
    } catch (err) {
        console.error('List error:', err);
        return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
    }
};
