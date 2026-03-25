const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Ensure 'uploads' directory exists
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

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
    quality: Number,
    level: Number,
    effects: [String],
    data: Object,
    timestamp: { type: Date, default: Date.now }
});

const Record = mongoose.model('Record', RecordSchema);

// ═══════════════════════════════════════════════════════════════
// 2. CONNECT TO DATABASE
// ═══════════════════════════════════════════════════════════════
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/epochdb';

mongoose.connect(MONGODB_URI)
    .then(() => console.log("Successfully connected to MongoDB"))
    .catch(err => console.error("Database connection error:", err));

// ═══════════════════════════════════════════════════════════════
// 3. LUA PARSER LOGIC
// ═══════════════════════════════════════════════════════════════
function parseLuaFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = { kills: {}, items: {} };

    // Regex to find NPC kill counts: ["NPC_NAME|ZONE"] = count
    const killRegex = /\["(.+?)"\]\s*=\s*(\d+)/g;
    let match;
    while ((match = killRegex.exec(content)) !== null) {
        const [fullId, count] = [match[1], parseInt(match[2])];
        const name = fullId.split('|')[0];
        data.kills[fullId] = { name, count };
    }
    return data;
}

// ═══════════════════════════════════════════════════════════════
// 4. UPLOAD & SYNC ROUTE
// ═══════════════════════════════════════════════════════════════
app.post('/api/upload', upload.single('luaFile'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: "No file uploaded." });

        const parsedData = parseLuaFile(req.file.path);
        const ops = [];

        // Sync NPC Kills
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

        // Cleanup temp file
        fs.unlinkSync(req.file.path);

        res.json({ message: "Sync complete!", items: ops.length });
    } catch (err) {
        console.error("Upload Error:", err);
        res.status(500).json({ error: "Processing failed" });
    }
});

// ═══════════════════════════════════════════════════════════════
// 5. SEARCH & FETCH ROUTES
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

app.get('/api/list/:category', async (req, res) => {
    try {
        const data = await Record.find({ type: req.params.category }).limit(100);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Could not fetch list" });
    }
});

app.get('/api/record/:type/:id', async (req, res) => {
    try {
        const record = await Record.findOne({ type: req.params.type, id: req.params.id });
        if (!record) return res.status(404).json({ error: "Not found" });
        res.json(record);
    } catch (err) {
        res.status(500).json({ error: "Internal error" });
    }
});

// ═══════════════════════════════════════════════════════════════
// 6. START SERVER
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`EpochDB Backend running on port ${PORT}`);
});