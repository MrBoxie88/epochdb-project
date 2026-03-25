const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const app = express();

app.use(cors());
app.use(express.json());

// 1. DATA STRUCTURE (Schema)
const RecordSchema = new mongoose.Schema({
    type: String, // 'npcs', 'items', 'quests', 'loot'
    id: String,
    name: String,
    quality: Number, // 0-6 for items
    level: Number,
    data: Object,    // Extra info like health, stats, or drop rates
    timestamp: { type: Date, default: Date.now }
});

const Record = mongoose.model('Record', RecordSchema);

// 2. CONNECT TO DATABASE
mongoose.connect('mongodb://localhost:27017/epochdb')
    .then(() => console.log("Successfully connected to MongoDB"))
    .catch(err => console.error("Database connection error:", err));

// 3. SEARCH ENDPOINT
app.get('/api/search', async (req, res) => {
    try {
        const query = req.query.q;
        // Searches names that "contain" the user's input (case-insensitive)
        const results = await Record.find({ 
            name: { $regex: query, $options: 'i' } 
        }).limit(10);
        res.json(results);
    } catch (err) {
        res.status(500).json({ error: "Search failed" });
    }
});

// 4. CATEGORY LIST ENDPOINT
app.get('/api/list/:category', async (req, res) => {
    try {
        const data = await Record.find({ type: req.params.category }).limit(100);
        res.json(data);
    } catch (err) {
        res.status(500).json({ error: "Could not fetch list" });
    }
});

// 5. FILE UPLOAD (FOR .LUA DATA)
app.post('/api/upload', upload.single('file'), (req, res) => {
    console.log("File received:", req.file.originalname);
    // In a production app, you would add a Lua-to-JSON parser here.
    res.json({ success: true, message: "Upload successful. Processing data..." });
});
// 6. SINGLE RECORD ENDPOINT
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
app.listen(3000, () => console.log('Backend server running at http://localhost:3000'));