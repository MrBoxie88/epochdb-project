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
    type: String,
    id: String,
    name: String,
    quality: Number,
    level: Number,
    data: Object,
    timestamp: { type: Date, default: Date.now }
});

const Record = mongoose.model('Record', RecordSchema);

// 2. CONNECT TO DATABASE
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/epochdb')
    .then(() => console.log("Successfully connected to MongoDB"))
    .catch(err => console.error("Database connection error:", err));

// 3. SEARCH ENDPOINT
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

// 7. SEED DATABASE WITH LOCAL DATA
app.get('/api/seed', async (req, res) => {
    try {
        await Record.deleteMany({});

        const npcs = [
            { type: 'npcs', id: '1', name: 'The Lich King', level: 80, data: { icon: '💀', zone: 'Icecrown Citadel', type: 'boss', faction: 'Undead', class: 'Lich', kills: 847291 } },
            { type: 'npcs', id: '2', name: 'Lord Marrowgar', level: 80, data: { icon: '💀', zone: 'Icecrown Citadel', type: 'boss', faction: 'Undead', class: 'Skeleton', kills: 412043 } },
            { type: 'npcs', id: '3', name: 'Deathbringer Saurfang', level: 80, data: { icon: '🗡', zone: 'Icecrown Citadel', type: 'boss', faction: 'Horde', class: 'Warrior', kills: 389210 } },
            { type: 'npcs', id: '4', name: 'Professor Putricide', level: 80, data: { icon: '🧪', zone: 'Icecrown Citadel', type: 'boss', faction: 'Undead', class: 'Alchemist', kills: 301842 } },
            { type: 'npcs', id: '5', name: 'Sindragosa', level: 80, data: { icon: '🐉', zone: 'Icecrown Citadel', type: 'boss', faction: 'Undead', class: 'Frost Wyrm', kills: 298441 } },
            { type: 'npcs', id: '6', name: 'Lady Deathwhisper', level: 80, data: { icon: '👻', zone: 'Icecrown Citadel', type: 'boss', faction: 'Undead', class: 'Cultist', kills: 276103 } },
            { type: 'npcs', id: '7', name: 'Yogg-Saron', level: 80, data: { icon: '👁', zone: 'Ulduar', type: 'boss', faction: 'Ancient', class: 'Old God', kills: 187432 } },
            { type: 'npcs', id: '8', name: 'Algalon the Observer', level: 80, data: { icon: '⭐', zone: 'Ulduar', type: 'boss', faction: 'Titan', class: 'Celestial', kills: 143201 } },
            { type: 'npcs', id: '9', name: 'Anub\'arak', level: 80, data: { icon: '🕷', zone: 'Trial of Crusader', type: 'boss', faction: 'Undead', class: 'Nerubian', kills: 201884 } },
            { type: 'npcs', id: '10', name: 'Icecrown Ghoul', level: 77, data: { icon: '💀', zone: 'Icecrown', type: 'normal', faction: 'Undead', class: 'Undead', kills: 2841022 } },
            { type: 'npcs', id: '11', name: 'Converted Hero', level: 80, data: { icon: '⚔', zone: 'Icecrown Citadel', type: 'elite', faction: 'Undead', class: 'Death Knight', kills: 94201 } },
            { type: 'npcs', id: '12', name: 'Frostwing Whelp', level: 79, data: { icon: '🐉', zone: 'Icecrown Citadel', type: 'normal', faction: 'Undead', class: 'Dragonkin', kills: 482011 } },
        ];

        await Record.insertMany(npcs);
        res.json({ success: true, message: `Seeded ${npcs.length} records.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(3000, () => console.log('Backend server running at http://localhost:3000'