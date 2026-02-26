const express = require('express');
const app = express();
const path = require('path');
const bodyParser = require("body-parser");
const PORT = process.env.PORT || 8000;

__path = process.cwd();

// Increase event listeners limit
require('events').EventEmitter.defaultMaxListeners = 500;

// Import routes
let code = require('./pair');
let api = require('./api');

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Routes
app.use('/code', code);
app.use('/api', api);
app.use('/pair', async (req, res) => {
    res.sendFile(path.join(__path, 'pair.html'));
});
app.use('/', async (req, res) => {
    res.sendFile(path.join(__path, 'main.html'));
});

// Start server
app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════╗
║       SO MD WhatsApp Bot           ║
║     Created by SHANUKA SHAMEEN     ║
╠════════════════════════════════════╣
║  Server running on port: ${PORT}       ║
║  Owner: 94724389699                ║
╚════════════════════════════════════╝
    `);
});

module.exports = app;