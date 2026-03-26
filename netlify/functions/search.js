const mongoose = require('mongoose');

const RecordSchema = new mongoose.Schema({
    type: String, id: String, name: String, quality: Number,
    level: Number, effects: [String], data: Object,
    timestamp: { type: Date, default: Date.now }
});
const Record = mongoose.models.Record || mongoose.model('Record', RecordSchema);

async function connect() {
    if (mongoose.connection.readyState === 1) return;
    await mongoose.connect(process.env.MONGODB_URI);
}

exports.handler = async (event) => {
    try {
        await connect();
        const q = (event.queryStringParameters && event.queryStringParameters.q) || '';
        if (!q || q.length < 1) return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify([]) };
        const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        const docs = await Record.find({ name: re }).limit(20).lean();
        const out = docs.map(d => ({ id: d.id, name: d.name, type: d.type }));
        return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(out) };
    } catch (err) {
        console.error('Search error:', err);
        return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
    }
};
