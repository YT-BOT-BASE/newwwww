const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const axios = require('axios');
const config = require('./config');

// Get bot stats
router.get('/stats', (req, res) => {
    res.json({
        botName: config.BOT_NAME,
        owner: config.OWNER_NAME,
        version: config.BOT_VERSION,
        prefix: config.PREFIX,
        uptime: process.uptime()
    });
});

// Get commands list
router.get('/commands', (req, res) => {
    const commands = {
        download: ['ytv', 'yta', 'tiktok', 'instagram', 'facebook', 'mediafire', 'apk', 'pinterest'],
        ai: ['ai', 'ocr', 'translate', 'define'],
        image: ['sticker', 'blur', 'resize', 'addtext', 'toimg', 'topdf', 'removebg'],
        group: ['groupinfo', 'add', 'kick', 'promote', 'demote', 'mute', 'unmute', 'grouplink', 'revoke', 'tagall', 'welcome'],
        special: ['statusdl', 'autoreact', 'autoread', 'broadcast', 'antilink', 'profile', 'calc', 'weather', 'quote', 'meme', 'news', 'shorturl'],
        other: ['menu', 'alive', 'ping', 'owner', 'delete']
    };
    res.json(commands);
});

// Get active sessions
router.get('/sessions', (req, res) => {
    const sessions = Array.from(activeSockets?.keys() || []);
    res.json({
        count: sessions.length,
        sessions
    });
});

// Health check
router.get('/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        memory: process.memoryUsage(),
        uptime: process.uptime()
    });
});

module.exports = router;