const mongoose = require('mongoose');

const CommentSchema = new mongoose.Schema({
    type: String,
    recordId: String,
    author: String,
    cls: String,
    text: String,
    ts: { type: Date, default: Date.now },
    uid: String
});

const Comment = mongoose.models.Comment || mongoose.model('Comment', CommentSchema);

async function connect() {
    if (mongoose.connection.readyState === 1) return;
    const dbUri = process.env.NETLIFY_DATABASE_URL || process.env.MONGODB_URI;
    if (!dbUri) {
        throw new Error('Database URI not configured. Set NETLIFY_DATABASE_URL or MONGODB_URI environment variable.');
    }
    await mongoose.connect(dbUri);
}

async function verifyToken(token) {
    if (!token) return null;
    // Determine identity base from environment (Netlify sets URL)
    const base = (process.env.URL || process.env.NETLIFY_SITE_URL || '').replace(/\/$/, '');
    if (!base) return null;
    const identityUserUrl = `${base}/.netlify/identity/user`;
    try {
        const resp = await fetch(identityUserUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!resp.ok) return null;
        const user = await resp.json();
        return user;
    } catch (e) {
        console.error('Token verify error', e);
        return null;
    }
}

exports.handler = async (event) => {
    try {
        await connect();
        const parts = (event.path || '').split('/').filter(Boolean);
        const fi = parts.indexOf('functions');
        const after = fi >= 0 ? parts.slice(fi + 1) : parts;
        // after[0] = 'comments', after[1]=type, after[2]=id, after[3]=commentId
        const type = after[1] || after[0];
        const id = after[2];
        const commentId = after[3];

        // Allow CORS preflight
        if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' }, body: '' };

        if (event.httpMethod === 'GET') {
            if (!type || !id) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Missing type or id' }) };
            const docs = await Comment.find({ type, recordId: id }).sort({ ts: -1 }).lean();
            return { statusCode: 200, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(docs) };
        }

        // For POST/DELETE require Authorization Bearer <token>
        const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
        const token = auth.split(' ')[1] || null;
        const user = await verifyToken(token);
        if (!user) return { statusCode: 401, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Unauthorized' }) };

        if (event.httpMethod === 'POST') {
            if (!type || !id) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Missing type or id' }) };
            let body = {};
            try { body = JSON.parse(event.body || '{}'); } catch (e) { body = {}; }
            const { text, cls, author } = body;
            if (!text) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Missing text' }) };
            const c = new Comment({ type, recordId: id, text, cls: cls || '', author: author || '', uid: user.id || user.sub || user.email || '', ts: Date.now() });
            await c.save();
            return { statusCode: 201, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(c) };
        }

        if (event.httpMethod === 'DELETE') {
            if (!type || !id || !commentId) return { statusCode: 400, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Missing parameters' }) };
            const c = await Comment.findById(commentId);
            if (!c) return { statusCode: 404, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Comment not found' }) };
            const uid = user.id || user.sub || user.email || null;
            if (c.uid && uid !== c.uid) return { statusCode: 403, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Not authorized' }) };
            await c.remove();
            return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, headers: { 'Access-Control-Allow-Origin': '*' }, body: 'Method Not Allowed' };
    } catch (err) {
        console.error('Comments error:', err);
        return { statusCode: 500, headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: err.message }) };
    }
};
