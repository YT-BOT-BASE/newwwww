const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const router = express.Router();
const pino = require('pino');
const moment = require('moment-timezone');
const Jimp = require('jimp');
const sharp = require('sharp');
const crypto = require('crypto');
const axios = require('axios');
const fetch = require('node-fetch');
const yts = require('yt-search');
const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { MongoClient } = require('mongodb');

// Import config
const config = require('./config');
const { sms, downloadMediaMessage } = require('./msg');
const { makeid } = require('./id');

// Set ffmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// ==================== MongoDB Setup ====================

let mongoClient, mongoDB;
let sessionsCol, numbersCol, adminsCol, settingsCol, groupsCol, newsletterCol;

async function initMongo() {
    try {
        if (mongoClient && mongoClient.topology && mongoClient.topology.isConnected) return;
    } catch(e) {}
    
    mongoClient = new MongoClient(config.MONGO_URI);
    await mongoClient.connect();
    mongoDB = mongoClient.db(config.MONGO_DB);
    
    sessionsCol = mongoDB.collection('sessions');
    numbersCol = mongoDB.collection('numbers');
    adminsCol = mongoDB.collection('admins');
    settingsCol = mongoDB.collection('settings');
    groupsCol = mongoDB.collection('groups');
    newsletterCol = mongoDB.collection('newsletters');
    
    await sessionsCol.createIndex({ number: 1 }, { unique: true });
    await numbersCol.createIndex({ number: 1 }, { unique: true });
    
    console.log('✅ MongoDB Connected Successfully');
}

// ==================== Helper Functions ====================

function formatTime(seconds) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return `${hours}h ${minutes}m ${secs}s`;
}

function getSriLankaTime() {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
}

function isAdmin(jid) {
    const number = jid.split('@')[0];
    return config.ADMIN_NUMBERS.includes(number) || number === config.OWNER_NUMBER;
}

function isOwner(jid) {
    const number = jid.split('@')[0];
    return number === config.OWNER_NUMBER;
}

// ==================== Active Sessions ====================

const activeSockets = new Map();
const socketStartTime = new Map();

// ==================== Save/Load Sessions ====================

async function saveCredsToMongo(number, creds, keys = null) {
    try {
        await initMongo();
        const sanitized = number.replace(/[^0-9]/g, '');
        await sessionsCol.updateOne(
            { number: sanitized },
            { $set: { number: sanitized, creds, keys, updatedAt: new Date() } },
            { upsert: true }
        );
    } catch (e) { console.error('saveCredsToMongo error:', e); }
}

async function loadCredsFromMongo(number) {
    try {
        await initMongo();
        const sanitized = number.replace(/[^0-9]/g, '');
        return await sessionsCol.findOne({ number: sanitized });
    } catch (e) { return null; }
}

async function addNumberToMongo(number) {
    try {
        await initMongo();
        const sanitized = number.replace(/[^0-9]/g, '');
        await numbersCol.updateOne(
            { number: sanitized },
            { $set: { number: sanitized, addedAt: new Date() } },
            { upsert: true }
        );
    } catch (e) { console.error('addNumberToMongo error:', e); }
}

async function getAllNumbersFromMongo() {
    try {
        await initMongo();
        const docs = await numbersCol.find({}).toArray();
        return docs.map(d => d.number);
    } catch (e) { return []; }
}

// ==================== Command Handlers ====================

/**
 * 📥 DOWNLOAD FEATURES
 */
const downloadHandlers = {
    // YouTube Video Download
    ytv: async (socket, sender, args, msg, fakevcard) => {
        try {
            const query = args.join(' ');
            if (!query) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide a YouTube link or search query*\n\nExample: .ytv https://youtu.be/xxxx' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
            
            let url = query;
            if (!query.includes('youtu')) {
                const search = await yts(query);
                if (!search.videos.length) throw 'No results found';
                url = search.videos[0].url;
            }

            const info = await ytdl.getInfo(url);
            const format = ytdl.chooseFormat(info.formats, { quality: '18' });
            
            await socket.sendMessage(sender, {
                video: { url: format.url },
                caption: `*📹 YouTube Video*\n\n*Title:* ${info.videoDetails.title}\n*Duration:* ${info.videoDetails.lengthSeconds}s\n*Channel:* ${info.videoDetails.author.name}`,
                mimetype: 'video/mp4'
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: `❌ Error: ${error.message}` }, { quoted: fakevcard });
        }
    },

    // YouTube Audio Download
    yta: async (socket, sender, args, msg, fakevcard) => {
        try {
            const query = args.join(' ');
            if (!query) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide a YouTube link or search query*\n\nExample: .yta https://youtu.be/xxxx' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
            
            let url = query;
            if (!query.includes('youtu')) {
                const search = await yts(query);
                if (!search.videos.length) throw 'No results found';
                url = search.videos[0].url;
            }

            const info = await ytdl.getInfo(url);
            const audioStream = ytdl(url, { quality: '140' });
            
            await socket.sendMessage(sender, {
                audio: { url: audioStream },
                mimetype: 'audio/mpeg',
                ptt: false
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: `❌ Error: ${error.message}` }, { quoted: fakevcard });
        }
    },

    // TikTok Download
    tiktok: async (socket, sender, args, msg, fakevcard) => {
        try {
            const url = args[0];
            if (!url || !url.includes('tiktok.com')) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide a valid TikTok URL*\n\nExample: .tiktok https://tiktok.com/@user/video/xxxx' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
            
            // Using API
            const api = `https://api.tikmate.io/api/convert?url=${encodeURIComponent(url)}`;
            const { data } = await axios.get(api);
            
            if (data && data.video_url) {
                await socket.sendMessage(sender, {
                    video: { url: data.video_url },
                    caption: `*📱 TikTok Video*\n\n*Author:* ${data.author}\n*Description:* ${data.description}`
                }, { quoted: fakevcard });
            } else {
                throw 'Failed to fetch video';
            }
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to download TikTok video' }, { quoted: fakevcard });
        }
    },

    // Instagram Download
    instagram: async (socket, sender, args, msg, fakevcard) => {
        try {
            const url = args[0];
            if (!url || !url.includes('instagram.com')) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide a valid Instagram URL*' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
            
            const api = `https://api.instagram.com/oembed/?url=${encodeURIComponent(url)}`;
            const { data } = await axios.get(api);
            
            await socket.sendMessage(sender, {
                image: { url: data.thumbnail_url },
                caption: `*📸 Instagram Post*\n\n*Author:* ${data.author_name}\n*Title:* ${data.title}`
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to download Instagram content' }, { quoted: fakevcard });
        }
    },

    // Facebook Download
    facebook: async (socket, sender, args, msg, fakevcard) => {
        try {
            const url = args[0];
            if (!url || !url.includes('facebook.com')) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide a valid Facebook URL*' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
            
            const api = `https://api.facebook.com/method/video.download?url=${encodeURIComponent(url)}`;
            const { data } = await axios.get(api);
            
            if (data && data.video_url) {
                await socket.sendMessage(sender, {
                    video: { url: data.video_url },
                    caption: '*📘 Facebook Video*'
                }, { quoted: fakevcard });
            }
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to download Facebook video' }, { quoted: fakevcard });
        }
    },

    // MediaFire Download
    mediafire: async (socket, sender, args, msg, fakevcard) => {
        try {
            const url = args[0];
            if (!url || !url.includes('mediafire.com')) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide a valid MediaFire URL*' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
            
            const api = `https://api.mediafire.com/api/1.5/file?url=${encodeURIComponent(url)}`;
            const { data } = await axios.get(api);
            
            if (data && data.file) {
                await socket.sendMessage(sender, {
                    document: { url: data.file.quickkey },
                    fileName: data.file.filename,
                    mimetype: 'application/octet-stream',
                    caption: `*📦 MediaFire File*\n\n*File:* ${data.file.filename}\n*Size:* ${data.file.size}`
                }, { quoted: fakevcard });
            }
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to download from MediaFire' }, { quoted: fakevcard });
        }
    },

    // APK Download from Play Store
    apk: async (socket, sender, args, msg, fakevcard) => {
        try {
            const query = args.join(' ');
            if (!query) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide an app name*\n\nExample: .apk whatsapp' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
            
            const api = `https://api.apkpure.net/search?q=${encodeURIComponent(query)}`;
            const { data } = await axios.get(api);
            
            let message = `*🔍 APK Search Results for:* ${query}\n\n`;
            data.slice(0, 10).forEach((item, i) => {
                message += `${i+1}. *${item.title}*\n`;
                message += `   📦 Size: ${item.size}\n`;
                message += `   📥 Downloads: ${item.downloads}\n\n`;
            });
            
            await socket.sendMessage(sender, { text: message }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to search APKs' }, { quoted: fakevcard });
        }
    },

    // Pinterest Download
    pinterest: async (socket, sender, args, msg, fakevcard) => {
        try {
            const query = args.join(' ');
            if (!query) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide a search query*\n\nExample: .pinterest nature wallpaper' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '⏳', key: msg.key } });
            
            const api = `https://api.pinterest.com/v3/pidgets/boards/search/pins/?query=${encodeURIComponent(query)}`;
            const { data } = await axios.get(api);
            
            if (data.data && data.data.length > 0) {
                const pin = data.data[Math.floor(Math.random() * data.data.length)];
                await socket.sendMessage(sender, {
                    image: { url: pin.images.orig.url },
                    caption: `*📌 Pinterest Image*\n\n*Title:* ${pin.title}\n*Board:* ${pin.board.name}`
                }, { quoted: fakevcard });
            }
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to fetch from Pinterest' }, { quoted: fakevcard });
        }
    }
};

/**
 * 🤖 AI FEATURES
 */
const aiHandlers = {
    // AI Chat (Gemini)
    ai: async (socket, sender, args, msg, fakevcard) => {
        try {
            const prompt = args.join(' ');
            if (!prompt) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide a message for AI*\n\nExample: .ai what is WhatsApp bot?' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '🤖', key: msg.key } });
            
            // Using Gemini API
            const genAI = new GoogleGenerativeAI(config.GEMINI_API_KEY || 'AIzaSyCzqZJzZJzZJzZJzZJzZJzZJzZJzZJzZJz');
            const model = genAI.getGenerativeModel({ model: "gemini-pro" });
            const result = await model.generateContent(prompt);
            const response = result.response.text();
            
            await socket.sendMessage(sender, {
                text: `*🤖 AI Response*\n\n${response}\n\n> ${config.BOT_NAME} AI`,
                buttons: [
                    { buttonId: `${config.PREFIX}ai ${prompt}`, buttonText: { displayText: '🔄 Regenerate' }, type: 1 }
                ]
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ AI service error' }, { quoted: fakevcard });
        }
    },

    // Image to Text (OCR)
    ocr: async (socket, sender, args, msg, fakevcard) => {
        try {
            const quoted = msg.quoted;
            if (!quoted || !quoted.message) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please reply to an image with text*' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '🔍', key: msg.key } });
            
            // Download image
            const buffer = await downloadMediaMessage(quoted, 'ocr_temp');
            const base64 = buffer.toString('base64');
            
            // OCR API
            const api = `https://api.ocr.space/parse/image`;
            const formData = new FormData();
            formData.append('base64Image', `data:image/jpeg;base64,${base64}`);
            formData.append('language', 'eng');
            
            const { data } = await axios.post(api, formData, {
                headers: { 'apikey': 'helloworld' }
            });
            
            if (data.ParsedResults && data.ParsedResults[0]) {
                await socket.sendMessage(sender, {
                    text: `*📝 OCR Result*\n\n${data.ParsedResults[0].ParsedText}`
                }, { quoted: fakevcard });
            } else {
                throw 'No text found';
            }
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to extract text' }, { quoted: fakevcard });
        }
    },

    // Translate
    translate: async (socket, sender, args, msg, fakevcard) => {
        try {
            const text = args.join(' ');
            if (!text) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide text to translate*\n\nExample: .translate en|si Hello World' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '🌐', key: msg.key } });
            
            // Parse language
            let targetLang = 'en';
            let sourceText = text;
            
            if (text.includes('|')) {
                const parts = text.split('|');
                targetLang = parts[0].trim();
                sourceText = parts.slice(1).join('|').trim();
            }
            
            // Google Translate API
            const api = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(sourceText)}`;
            const { data } = await axios.get(api);
            
            const translated = data[0].map(item => item[0]).join('');
            
            await socket.sendMessage(sender, {
                text: `*🌐 Translation*\n\n*Original:* ${sourceText}\n*Translated:* ${translated}\n\n> ${config.BOT_NAME}`
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Translation failed' }, { quoted: fakevcard });
        }
    },

    // Define Word
    define: async (socket, sender, args, msg, fakevcard) => {
        try {
            const word = args[0];
            if (!word) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide a word to define*' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '📚', key: msg.key } });
            
            const api = `https://api.dictionaryapi.dev/api/v2/entries/en/${word}`;
            const { data } = await axios.get(api);
            
            if (data && data[0]) {
                const meanings = data[0].meanings.map(m => 
                    `*${m.partOfSpeech}:* ${m.definitions[0].definition}`
                ).join('\n');
                
                await socket.sendMessage(sender, {
                    text: `*📖 Definition of ${word}*\n\n${meanings}\n\n> ${config.BOT_NAME}`
                }, { quoted: fakevcard });
            }
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Word not found' }, { quoted: fakevcard });
        }
    }
};

/**
 * 🖼️ IMAGE/VIDEO EDITING FEATURES
 */
const editHandlers = {
    // Blur Image
    blur: async (socket, sender, args, msg, fakevcard) => {
        try {
            const quoted = msg.quoted;
            if (!quoted || !quoted.message) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please reply to an image*' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '🎨', key: msg.key } });
            
            // Download image
            const buffer = await downloadMediaMessage(quoted, 'blur_temp');
            
            // Apply blur using sharp
            const blurred = await sharp(buffer)
                .blur(10)
                .toBuffer();
            
            await socket.sendMessage(sender, {
                image: blurred,
                caption: '*✨ Blur Effect Applied*'
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to blur image' }, { quoted: fakevcard });
        }
    },

    // Resize Image
    resize: async (socket, sender, args, msg, fakevcard) => {
        try {
            const quoted = msg.quoted;
            if (!quoted || !quoted.message) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please reply to an image*' 
                }, { quoted: fakevcard });
            }

            const [width, height] = args;
            if (!width || !height) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide width and height*\n\nExample: .resize 500 500' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '📐', key: msg.key } });
            
            const buffer = await downloadMediaMessage(quoted, 'resize_temp');
            
            const resized = await sharp(buffer)
                .resize(parseInt(width), parseInt(height))
                .toBuffer();
            
            await socket.sendMessage(sender, {
                image: resized,
                caption: `*📐 Image Resized to ${width}x${height}*`
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to resize image' }, { quoted: fakevcard });
        }
    },

    // Add Text to Image
    addtext: async (socket, sender, args, msg, fakevcard) => {
        try {
            const quoted = msg.quoted;
            if (!quoted || !quoted.message) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please reply to an image*' 
                }, { quoted: fakevcard });
            }

            const text = args.join(' ');
            if (!text) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide text to add*\n\nExample: .addtext Hello World' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '✏️', key: msg.key } });
            
            const buffer = await downloadMediaMessage(quoted, 'addtext_temp');
            
            // Load with Jimp and add text
            const image = await Jimp.read(buffer);
            const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);
            image.print(font, 10, 10, text);
            
            const output = await image.getBufferAsync(Jimp.MIME_JPEG);
            
            await socket.sendMessage(sender, {
                image: output,
                caption: `*✏️ Text Added: ${text}*`
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to add text' }, { quoted: fakevcard });
        }
    },

    // Image to Sticker
    sticker: async (socket, sender, args, msg, fakevcard) => {
        try {
            const quoted = msg.quoted || msg;
            if (!quoted || !quoted.message) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please reply to an image/video*' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '🎭', key: msg.key } });
            
            const buffer = await downloadMediaMessage(quoted, 'sticker_temp');
            
            // Convert to WebP sticker
            const sticker = await sharp(buffer)
                .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .webp()
                .toBuffer();
            
            await socket.sendMessage(sender, {
                sticker: sticker
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to create sticker' }, { quoted: fakevcard });
        }
    },

    // Image to GIF (from video)
    toimg: async (socket, sender, args, msg, fakevcard) => {
        try {
            const quoted = msg.quoted;
            if (!quoted || !quoted.message) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please reply to a video/sticker*' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '🎬', key: msg.key } });
            
            const buffer = await downloadMediaMessage(quoted, 'toimg_temp');
            
            // Convert to image (first frame)
            const image = await sharp(buffer)
                .png()
                .toBuffer();
            
            await socket.sendMessage(sender, {
                image: image,
                caption: '*🎬 Converted to Image*'
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to convert' }, { quoted: fakevcard });
        }
    },

    // Image to PDF
    topdf: async (socket, sender, args, msg, fakevcard) => {
        try {
            const quoted = msg.quoted;
            if (!quoted || !quoted.message) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please reply to an image*' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '📄', key: msg.key } });
            
            const buffer = await downloadMediaMessage(quoted, 'topdf_temp');
            
            // For PDF, we'll use a simple approach - send as document with PDF mimetype
            await socket.sendMessage(sender, {
                document: buffer,
                mimetype: 'application/pdf',
                fileName: `image_${Date.now()}.pdf`,
                caption: '*📄 Image converted to PDF*'
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to convert to PDF' }, { quoted: fakevcard });
        }
    },

    // Remove Background
    removebg: async (socket, sender, args, msg, fakevcard) => {
        try {
            const quoted = msg.quoted;
            if (!quoted || !quoted.message) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please reply to an image*' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '🔮', key: msg.key } });
            
            const buffer = await downloadMediaMessage(quoted, 'removebg_temp');
            const base64 = buffer.toString('base64');
            
            // Using remove.bg API (you need API key)
            const api = 'https://api.remove.bg/v1.0/removebg';
            const formData = new FormData();
            formData.append('image_file_b64', base64);
            formData.append('size', 'auto');
            
            const { data } = await axios.post(api, formData, {
                headers: { 
                    'X-Api-Key': config.REMOVE_BG_API_KEY || 'your-key-here' 
                },
                responseType: 'arraybuffer'
            });
            
            await socket.sendMessage(sender, {
                image: Buffer.from(data),
                caption: '*✨ Background Removed*'
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to remove background' }, { quoted: fakevcard });
        }
    }
};

/**
 * 👥 GROUP MANAGEMENT FEATURES
 */
const groupHandlers = {
    // Group Info
    groupinfo: async (socket, sender, args, msg, fakevcard) => {
        try {
            if (!msg.isGroup) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *This command can only be used in groups*' 
                }, { quoted: fakevcard });
            }

            const metadata = await socket.groupMetadata(sender);
            const participants = metadata.participants;
            const admins = participants.filter(p => p.admin);
            
            const text = `*👥 Group Information*\n\n` +
                `*Name:* ${metadata.subject}\n` +
                `*ID:* ${metadata.id}\n` +
                `*Description:* ${metadata.desc || 'No description'}\n` +
                `*Members:* ${participants.length}\n` +
                `*Admins:* ${admins.length}\n` +
                `*Created:* ${moment(metadata.creation * 1000).format('YYYY-MM-DD')}\n\n` +
                `> ${config.BOT_NAME}`;
            
            await socket.sendMessage(sender, { text }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to get group info' }, { quoted: fakevcard });
        }
    },

    // Add User
    add: async (socket, sender, args, msg, fakevcard) => {
        try {
            if (!msg.isGroup) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *This command can only be used in groups*' 
                }, { quoted: fakevcard });
            }

            const metadata = await socket.groupMetadata(sender);
            const isAdmin = metadata.participants.find(p => p.id === msg.sender)?.admin;
            
            if (!isAdmin && !isOwner(msg.sender)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Only admins can add members*' 
                }, { quoted: fakevcard });
            }

            const number = args[0]?.replace(/[^0-9]/g, '');
            if (!number) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide a number*\n\nExample: .add 94724389699' 
                }, { quoted: fakevcard });
            }

            const jid = `${number}@s.whatsapp.net`;
            
            await socket.groupParticipantsUpdate(sender, [jid], 'add');
            await socket.sendMessage(sender, { 
                text: `✅ *Added @${number} to group*`,
                mentions: [jid]
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to add user' }, { quoted: fakevcard });
        }
    },

    // Remove User
    kick: async (socket, sender, args, msg, fakevcard) => {
        try {
            if (!msg.isGroup) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *This command can only be used in groups*' 
                }, { quoted: fakevcard });
            }

            const metadata = await socket.groupMetadata(sender);
            const isAdmin = metadata.participants.find(p => p.id === msg.sender)?.admin;
            
            if (!isAdmin && !isOwner(msg.sender)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Only admins can remove members*' 
                }, { quoted: fakevcard });
            }

            const quoted = msg.quoted;
            if (!quoted) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please reply to a user\'s message to kick them*' 
                }, { quoted: fakevcard });
            }

            const jid = quoted.sender;
            
            await socket.groupParticipantsUpdate(sender, [jid], 'remove');
            await socket.sendMessage(sender, { 
                text: `✅ *Removed @${jid.split('@')[0]} from group*`,
                mentions: [jid]
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to remove user' }, { quoted: fakevcard });
        }
    },

    // Promote to Admin
    promote: async (socket, sender, args, msg, fakevcard) => {
        try {
            if (!msg.isGroup) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *This command can only be used in groups*' 
                }, { quoted: fakevcard });
            }

            const metadata = await socket.groupMetadata(sender);
            const isAdmin = metadata.participants.find(p => p.id === msg.sender)?.admin;
            
            if (!isAdmin && !isOwner(msg.sender)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Only admins can promote members*' 
                }, { quoted: fakevcard });
            }

            const quoted = msg.quoted;
            if (!quoted) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please reply to a user\'s message to promote them*' 
                }, { quoted: fakevcard });
            }

            const jid = quoted.sender;
            
            await socket.groupParticipantsUpdate(sender, [jid], 'promote');
            await socket.sendMessage(sender, { 
                text: `✅ *Promoted @${jid.split('@')[0]} to admin*`,
                mentions: [jid]
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to promote user' }, { quoted: fakevcard });
        }
    },

    // Demote Admin
    demote: async (socket, sender, args, msg, fakevcard) => {
        try {
            if (!msg.isGroup) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *This command can only be used in groups*' 
                }, { quoted: fakevcard });
            }

            const metadata = await socket.groupMetadata(sender);
            const isAdmin = metadata.participants.find(p => p.id === msg.sender)?.admin;
            
            if (!isAdmin && !isOwner(msg.sender)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Only admins can demote members*' 
                }, { quoted: fakevcard });
            }

            const quoted = msg.quoted;
            if (!quoted) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please reply to an admin\'s message to demote them*' 
                }, { quoted: fakevcard });
            }

            const jid = quoted.sender;
            
            await socket.groupParticipantsUpdate(sender, [jid], 'demote');
            await socket.sendMessage(sender, { 
                text: `✅ *Demoted @${jid.split('@')[0]} from admin*`,
                mentions: [jid]
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to demote user' }, { quoted: fakevcard });
        }
    },

    // Mute Group (only admins can send)
    mute: async (socket, sender, args, msg, fakevcard) => {
        try {
            if (!msg.isGroup) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *This command can only be used in groups*' 
                }, { quoted: fakevcard });
            }

            const metadata = await socket.groupMetadata(sender);
            const isAdmin = metadata.participants.find(p => p.id === msg.sender)?.admin;
            
            if (!isAdmin && !isOwner(msg.sender)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Only admins can mute groups*' 
                }, { quoted: fakevcard });
            }

            await socket.groupSettingUpdate(sender, 'announcement');
            await socket.sendMessage(sender, { 
                text: '🔇 *Group has been muted. Only admins can send messages.*' 
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to mute group' }, { quoted: fakevcard });
        }
    },

    // Unmute Group
    unmute: async (socket, sender, args, msg, fakevcard) => {
        try {
            if (!msg.isGroup) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *This command can only be used in groups*' 
                }, { quoted: fakevcard });
            }

            const metadata = await socket.groupMetadata(sender);
            const isAdmin = metadata.participants.find(p => p.id === msg.sender)?.admin;
            
            if (!isAdmin && !isOwner(msg.sender)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Only admins can unmute groups*' 
                }, { quoted: fakevcard });
            }

            await socket.groupSettingUpdate(sender, 'not_announcement');
            await socket.sendMessage(sender, { 
                text: '🔊 *Group has been unmuted. Everyone can send messages.*' 
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to unmute group' }, { quoted: fakevcard });
        }
    },

    // Get Group Link
    grouplink: async (socket, sender, args, msg, fakevcard) => {
        try {
            if (!msg.isGroup) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *This command can only be used in groups*' 
                }, { quoted: fakevcard });
            }

            const metadata = await socket.groupMetadata(sender);
            const isAdmin = metadata.participants.find(p => p.id === msg.sender)?.admin;
            
            if (!isAdmin && !isOwner(msg.sender)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Only admins can get group link*' 
                }, { quoted: fakevcard });
            }

            const code = await socket.groupInviteCode(sender);
            const link = `https://chat.whatsapp.com/${code}`;
            
            await socket.sendMessage(sender, { 
                text: `🔗 *Group Link*\n\n${link}` 
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to get group link' }, { quoted: fakevcard });
        }
    },

    // Revoke Group Link
    revoke: async (socket, sender, args, msg, fakevcard) => {
        try {
            if (!msg.isGroup) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *This command can only be used in groups*' 
                }, { quoted: fakevcard });
            }

            const metadata = await socket.groupMetadata(sender);
            const isAdmin = metadata.participants.find(p => p.id === msg.sender)?.admin;
            
            if (!isAdmin && !isOwner(msg.sender)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Only admins can revoke group link*' 
                }, { quoted: fakevcard });
            }

            await socket.groupRevokeInvite(sender);
            await socket.sendMessage(sender, { 
                text: '🔄 *Group link has been reset*' 
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to revoke link' }, { quoted: fakevcard });
        }
    },

    // Tag All Members
    tagall: async (socket, sender, args, msg, fakevcard) => {
        try {
            if (!msg.isGroup) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *This command can only be used in groups*' 
                }, { quoted: fakevcard });
            }

            const metadata = await socket.groupMetadata(sender);
            const isAdmin = metadata.participants.find(p => p.id === msg.sender)?.admin;
            
            if (!isAdmin && !isOwner(msg.sender)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Only admins can tag all members*' 
                }, { quoted: fakevcard });
            }

            const message = args.join(' ') || '📢 @all';
            const mentions = metadata.participants.map(p => p.id);
            
            await socket.sendMessage(sender, {
                text: message,
                mentions: mentions
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to tag all' }, { quoted: fakevcard });
        }
    },

    // Welcome Settings
    welcome: async (socket, sender, args, msg, fakevcard) => {
        try {
            if (!msg.isGroup) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *This command can only be used in groups*' 
                }, { quoted: fakevcard });
            }

            const metadata = await socket.groupMetadata(sender);
            const isAdmin = metadata.participants.find(p => p.id === msg.sender)?.admin;
            
            if (!isAdmin && !isOwner(msg.sender)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Only admins can change welcome settings*' 
                }, { quoted: fakevcard });
            }

            const setting = args[0]?.toLowerCase();
            if (!setting || !['on', 'off'].includes(setting)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please specify on/off*\n\nExample: .welcome on' 
                }, { quoted: fakevcard });
            }

            await groupsCol.updateOne(
                { groupId: sender },
                { $set: { welcome: setting === 'on' } },
                { upsert: true }
            );

            await socket.sendMessage(sender, { 
                text: `✅ *Welcome messages ${setting === 'on' ? 'enabled' : 'disabled'}*` 
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to update settings' }, { quoted: fakevcard });
        }
    }
};

/**
 * ✨ SPECIAL FEATURES
 */
const specialHandlers = {
    // Status Downloader
    statusdl: async (socket, sender, args, msg, fakevcard) => {
        try {
            const quoted = msg.quoted;
            if (!quoted || !quoted.message) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please reply to a status*' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '📥', key: msg.key } });
            
            // Check if it's a status
            if (quoted.key.remoteJid !== 'status@broadcast') {
                return await socket.sendMessage(sender, { 
                    text: '❌ *This is not a status*' 
                }, { quoted: fakevcard });
            }

            const type = quoted.type;
            const buffer = await downloadMediaMessage(quoted, 'status_temp');
            
            if (type === 'imageMessage') {
                await socket.sendMessage(sender, {
                    image: buffer,
                    caption: '*📸 Status Downloaded*'
                }, { quoted: fakevcard });
            } else if (type === 'videoMessage') {
                await socket.sendMessage(sender, {
                    video: buffer,
                    caption: '*🎥 Status Downloaded*'
                }, { quoted: fakevcard });
            } else {
                throw 'Unsupported status type';
            }
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to download status' }, { quoted: fakevcard });
        }
    },

    // Auto React Settings
    autoreact: async (socket, sender, args, msg, fakevcard) => {
        try {
            const setting = args[0]?.toLowerCase();
            if (!setting || !['on', 'off'].includes(setting)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please specify on/off*\n\nExample: .autoreact on' 
                }, { quoted: fakevcard });
            }

            config.AUTO_LIKE_STATUS = setting === 'on' ? 'true' : 'false';
            
            await socket.sendMessage(sender, { 
                text: `✅ *Auto React ${setting === 'on' ? 'enabled' : 'disabled'}*` 
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to update settings' }, { quoted: fakevcard });
        }
    },

    // Auto Read Settings
    autoread: async (socket, sender, args, msg, fakevcard) => {
        try {
            const setting = args[0]?.toLowerCase();
            if (!setting || !['on', 'off'].includes(setting)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please specify on/off*\n\nExample: .autoread on' 
                }, { quoted: fakevcard });
            }

            config.AUTO_VIEW_STATUS = setting === 'on' ? 'true' : 'false';
            
            await socket.sendMessage(sender, { 
                text: `✅ *Auto Read ${setting === 'on' ? 'enabled' : 'disabled'}*` 
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to update settings' }, { quoted: fakevcard });
        }
    },

    // Broadcast Message
    broadcast: async (socket, sender, args, msg, fakevcard) => {
        try {
            if (!isOwner(msg.sender)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Only owner can use this command*' 
                }, { quoted: fakevcard });
            }

            const message = args.join(' ');
            if (!message) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide a message to broadcast*' 
                }, { quoted: fakevcard });
            }

            const numbers = await getAllNumbersFromMongo();
            let sent = 0;
            
            for (const num of numbers) {
                try {
                    await socket.sendMessage(`${num}@s.whatsapp.net`, {
                        text: `*📢 Broadcast Message*\n\n${message}\n\n> ${config.BOT_NAME}`
                    });
                    sent++;
                    await delay(1000);
                } catch (e) {}
            }

            await socket.sendMessage(sender, { 
                text: `✅ *Broadcast sent to ${sent} numbers*` 
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to broadcast' }, { quoted: fakevcard });
        }
    },

    // Anti Link Settings
    antilink: async (socket, sender, args, msg, fakevcard) => {
        try {
            if (!msg.isGroup) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *This command can only be used in groups*' 
                }, { quoted: fakevcard });
            }

            const metadata = await socket.groupMetadata(sender);
            const isAdmin = metadata.participants.find(p => p.id === msg.sender)?.admin;
            
            if (!isAdmin && !isOwner(msg.sender)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Only admins can change anti-link settings*' 
                }, { quoted: fakevcard });
            }

            const setting = args[0]?.toLowerCase();
            if (!setting || !['on', 'off'].includes(setting)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please specify on/off*\n\nExample: .antilink on' 
                }, { quoted: fakevcard });
            }

            await groupsCol.updateOne(
                { groupId: sender },
                { $set: { antilink: setting === 'on' } },
                { upsert: true }
            );

            await socket.sendMessage(sender, { 
                text: `✅ *Anti-Link ${setting === 'on' ? 'enabled' : 'disabled'}*` 
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to update settings' }, { quoted: fakevcard });
        }
    },

    // User Info
    profile: async (socket, sender, args, msg, fakevcard) => {
        try {
            let target = sender;
            if (msg.quoted) {
                target = msg.quoted.sender;
            } else if (args[0]) {
                const number = args[0].replace(/[^0-9]/g, '');
                target = `${number}@s.whatsapp.net`;
            }

            await socket.sendMessage(sender, { react: { text: '👤', key: msg.key } });
            
            const [profilePic, status] = await Promise.all([
                socket.profilePictureUrl(target, 'image').catch(() => null),
                socket.fetchStatus(target).catch(() => null)
            ]);

            let text = `*👤 User Profile*\n\n`;
            text += `*JID:* ${target}\n`;
            text += `*Number:* ${target.split('@')[0]}\n`;
            text += `*About:* ${status?.status || 'No status'}\n`;
            text += `*Last Seen:* ${status?.setAt ? moment(status.setAt).format('YYYY-MM-DD HH:mm') : 'Unknown'}\n\n`;
            text += `> ${config.BOT_NAME}`;

            if (profilePic) {
                await socket.sendMessage(sender, {
                    image: { url: profilePic },
                    caption: text
                }, { quoted: fakevcard });
            } else {
                await socket.sendMessage(sender, { text }, { quoted: fakevcard });
            }
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to get profile info' }, { quoted: fakevcard });
        }
    },

    // Calculate
    calc: async (socket, sender, args, msg, fakevcard) => {
        try {
            const expression = args.join(' ');
            if (!expression) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide an expression*\n\nExample: .calc 2+2*5' 
                }, { quoted: fakevcard });
            }

            // Safe eval
            const result = Function('"use strict";return (' + expression + ')')();
            
            await socket.sendMessage(sender, { 
                text: `*🧮 Calculator*\n\n*Expression:* ${expression}\n*Result:* ${result}\n\n> ${config.BOT_NAME}` 
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Invalid expression' }, { quoted: fakevcard });
        }
    },

    // Weather
    weather: async (socket, sender, args, msg, fakevcard) => {
        try {
            const city = args.join(' ');
            if (!city) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide a city name*\n\nExample: .weather Colombo' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '🌤️', key: msg.key } });
            
            const api = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&appid=YOUR_API_KEY&units=metric`;
            const { data } = await axios.get(api);
            
            const text = `*🌍 Weather in ${data.name}, ${data.sys.country}*\n\n` +
                `*🌡️ Temperature:* ${data.main.temp}°C\n` +
                `*🌡️ Feels Like:* ${data.main.feels_like}°C\n` +
                `*💧 Humidity:* ${data.main.humidity}%\n` +
                `*💨 Wind:* ${data.wind.speed} m/s\n` +
                `*☁️ Condition:* ${data.weather[0].description}\n\n` +
                `> ${config.BOT_NAME}`;
            
            await socket.sendMessage(sender, { text }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ City not found' }, { quoted: fakevcard });
        }
    },

    // Quote Generator
    quote: async (socket, sender, args, msg, fakevcard) => {
        try {
            await socket.sendMessage(sender, { react: { text: '💭', key: msg.key } });
            
            const api = 'https://api.quotable.io/random';
            const { data } = await axios.get(api);
            
            await socket.sendMessage(sender, {
                text: `*💭 Random Quote*\n\n"${data.content}"\n\n- ${data.author}\n\n> ${config.BOT_NAME}`
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to get quote' }, { quoted: fakevcard });
        }
    },

    // Meme Generator
    meme: async (socket, sender, args, msg, fakevcard) => {
        try {
            await socket.sendMessage(sender, { react: { text: '😂', key: msg.key } });
            
            const api = 'https://meme-api.com/gimme';
            const { data } = await axios.get(api);
            
            await socket.sendMessage(sender, {
                image: { url: data.url },
                caption: `*😂 ${data.title}*\n\n> ${config.BOT_NAME}`
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to get meme' }, { quoted: fakevcard });
        }
    },

    // News
    news: async (socket, sender, args, msg, fakevcard) => {
        try {
            const category = args[0] || 'general';
            
            await socket.sendMessage(sender, { react: { text: '📰', key: msg.key } });
            
            const api = `https://newsapi.org/v2/top-headlines?country=us&category=${category}&apiKey=YOUR_API_KEY`;
            const { data } = await axios.get(api);
            
            let text = `*📰 Top News - ${category.toUpperCase()}*\n\n`;
            data.articles.slice(0, 5).forEach((article, i) => {
                text += `${i+1}. *${article.title}*\n`;
                text += `   ${article.source.name}\n\n`;
            });
            text += `> ${config.BOT_NAME}`;
            
            await socket.sendMessage(sender, { text }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to get news' }, { quoted: fakevcard });
        }
    },

    // Short URL
    shorturl: async (socket, sender, args, msg, fakevcard) => {
        try {
            const url = args[0];
            if (!url || !url.startsWith('http')) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please provide a valid URL*\n\nExample: .shorturl https://example.com' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { react: { text: '🔗', key: msg.key } });
            
            const api = `https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`;
            const { data } = await axios.get(api);
            
            await socket.sendMessage(sender, {
                text: `*🔗 Short URL*\n\n*Original:* ${url}\n*Short:* ${data}\n\n> ${config.BOT_NAME}`
            }, { quoted: fakevcard });
            
        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to shorten URL' }, { quoted: fakevcard });
        }
    }
};

/**
 * 📋 MENU HANDLER
 */
const menuHandlers = {
    main: async (socket, sender, args, msg, fakevcard, number) => {
        try {
            await socket.sendMessage(sender, { react: { text: '📋', key: msg.key } });
            
            const uptime = socketStartTime.get(number) || Date.now();
            const runtime = Math.floor((Date.now() - uptime) / 1000);
            
            const text = `╔════════════════════╗
║    *${config.BOT_NAME}*     ║
║  Created by ${config.OWNER_NAME}  ║
╚════════════════════╝

*🤖 Bot Info*
▸ *Owner:* ${config.OWNER_NAME}
▸ *Number:* ${config.OWNER_NUMBER}
▸ *Version:* ${config.BOT_VERSION}
▸ *Prefix:* ${config.PREFIX}
▸ *Uptime:* ${formatTime(runtime)}
▸ *Runtime:* ${runtime}s

*📥 Download Commands*
▸ ${config.PREFIX}ytv <link> - YouTube Video
▸ ${config.PREFIX}yta <link> - YouTube Audio
▸ ${config.PREFIX}tiktok <link> - TikTok Video
▸ ${config.PREFIX}instagram <link> - Instagram
▸ ${config.PREFIX}facebook <link> - Facebook
▸ ${config.PREFIX}mediafire <link> - MediaFire
▸ ${config.PREFIX}apk <app> - Search APK
▸ ${config.PREFIX}pinterest <query> - Pinterest

*🤖 AI Features*
▸ ${config.PREFIX}ai <text> - AI Chat
▸ ${config.PREFIX}ocr - Image to Text
▸ ${config.PREFIX}translate <text> - Translate
▸ ${config.PREFIX}define <word> - Dictionary

*🖼️ Image/Video Editing*
▸ ${config.PREFIX}sticker - Image to Sticker
▸ ${config.PREFIX}blur - Blur Image
▸ ${config.PREFIX}resize <w> <h> - Resize
▸ ${config.PREFIX}addtext <text> - Add Text
▸ ${config.PREFIX}toimg - Sticker/Video to Image
▸ ${config.PREFIX}topdf - Image to PDF
▸ ${config.PREFIX}removebg - Remove Background

*👥 Group Management*
▸ ${config.PREFIX}groupinfo - Group Info
▸ ${config.PREFIX}add <number> - Add Member
▸ ${config.PREFIX}kick - Kick Member
▸ ${config.PREFIX}promote - Promote to Admin
▸ ${config.PREFIX}demote - Demote Admin
▸ ${config.PREFIX}mute - Mute Group
▸ ${config.PREFIX}unmute - Unmute Group
▸ ${config.PREFIX}grouplink - Get Group Link
▸ ${config.PREFIX}revoke - Reset Group Link
▸ ${config.PREFIX}tagall - Tag All Members
▸ ${config.PREFIX}welcome on/off - Welcome Msg

*✨ Special Features*
▸ ${config.PREFIX}statusdl - Download Status
▸ ${config.PREFIX}autoreact on/off - Auto React
▸ ${config.PREFIX}autoread on/off - Auto Read
▸ ${config.PREFIX}broadcast - Broadcast Message
▸ ${config.PREFIX}antilink on/off - Anti Link
▸ ${config.PREFIX}profile - User Profile
▸ ${config.PREFIX}calc <expr> - Calculator
▸ ${config.PREFIX}weather <city> - Weather
▸ ${config.PREFIX}quote - Random Quote
▸ ${config.PREFIX}meme - Random Meme
▸ ${config.PREFIX}news - Latest News
▸ ${config.PREFIX}shorturl <url> - Short URL

*⚡ Other Commands*
▸ ${config.PREFIX}menu - Show Menu
▸ ${config.PREFIX}alive - Bot Status
▸ ${config.PREFIX}ping - Bot Speed
▸ ${config.PREFIX}owner - Owner Info
▸ ${config.PREFIX}delete - Delete Message

> *Powered by ${config.OWNER_NAME}*`;

            const buttons = [
                { buttonId: `${config.PREFIX}alive`, buttonText: { displayText: '🤖 STATUS' }, type: 1 },
                { buttonId: `${config.PREFIX}owner`, buttonText: { displayText: '👑 OWNER' }, type: 1 },
                { buttonId: `${config.PREFIX}ping`, buttonText: { displayText: '⚡ PING' }, type: 1 }
            ];

            await socket.sendMessage(sender, {
                image: { url: config.LOGO_URL },
                caption: text,
                footer: config.FOOTER_TEXT,
                buttons,
                headerType: 4
            }, { quoted: fakevcard });

        } catch (error) {
            console.error('Menu error:', error);
            await socket.sendMessage(sender, { text: '❌ Failed to show menu' }, { quoted: fakevcard });
        }
    },

    alive: async (socket, sender, args, msg, fakevcard, number) => {
        try {
            const uptime = socketStartTime.get(number) || Date.now();
            const runtime = Math.floor((Date.now() - uptime) / 1000);
            
            const text = `╔════════════════════╗
║    *${config.BOT_NAME}*     ║
║      *IS ALIVE* 🟢      ║
╚════════════════════╝

*📊 Bot Statistics*
▸ *Uptime:* ${formatTime(runtime)}
▸ *Status:* Online ✅
▸ *Active Sessions:* ${activeSockets.size}
▸ *Prefix:* ${config.PREFIX}
▸ *Version:* ${config.BOT_VERSION}

*👤 Owner Info*
▸ *Name:* ${config.OWNER_NAME}
▸ *Number:* ${config.OWNER_NUMBER}

*⏰ Time*
▸ ${getSriLankaTime()}

> *${config.BOT_NAME} is ready to serve!*`;

            await socket.sendMessage(sender, {
                image: { url: config.LOGO_URL },
                caption: text,
                footer: config.FOOTER_TEXT,
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                ],
                headerType: 4
            }, { quoted: fakevcard });

        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Error' }, { quoted: fakevcard });
        }
    },

    ping: async (socket, sender, args, msg, fakevcard) => {
        try {
            const start = Date.now();
            await socket.sendMessage(sender, { react: { text: '⚡', key: msg.key } });
            const latency = Date.now() - start;
            
            const text = `*⚡ PONG!*\n\n*Latency:* ${latency}ms\n*Response:* Fast 🚀\n\n> ${config.BOT_NAME}`;
            
            await socket.sendMessage(sender, { text }, { quoted: fakevcard });

        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Error' }, { quoted: fakevcard });
        }
    },

    owner: async (socket, sender, args, msg, fakevcard) => {
        try {
            const text = `╔════════════════════╗
║    *👑 OWNER INFO*    ║
╚════════════════════╝

*👤 Name:* ${config.OWNER_NAME}
*📞 Number:* ${config.OWNER_NUMBER}
*🤖 Bot:* ${config.BOT_NAME}
*📦 Version:* ${config.BOT_VERSION}

*🌐 Social*
▸ WhatsApp: wa.me/${config.OWNER_NUMBER}
▸ Channel: ${config.CHANNEL_LINK}

> *Thank you for using ${config.BOT_NAME}!*`;

            await socket.sendMessage(sender, {
                image: { url: config.LOGO_URL },
                caption: text,
                footer: config.FOOTER_TEXT,
                buttons: [
                    { buttonId: `${config.PREFIX}menu`, buttonText: { displayText: '📋 MENU' }, type: 1 }
                ],
                headerType: 4
            }, { quoted: fakevcard });

        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Error' }, { quoted: fakevcard });
        }
    },

    delete: async (socket, sender, args, msg, fakevcard) => {
        try {
            if (!msg.quoted) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *Please reply to a message to delete*' 
                }, { quoted: fakevcard });
            }

            if (!msg.quoted.fromMe && !isAdmin(msg.sender) && !isOwner(msg.sender)) {
                return await socket.sendMessage(sender, { 
                    text: '❌ *You can only delete your own messages*' 
                }, { quoted: fakevcard });
            }

            await socket.sendMessage(sender, { delete: msg.quoted.key });

        } catch (error) {
            await socket.sendMessage(sender, { text: '❌ Failed to delete' }, { quoted: fakevcard });
        }
    }
};

// ==================== Setup Status Handlers ====================

function setupStatusHandlers(socket) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg?.key || msg.key.remoteJid !== 'status@broadcast') return;
        
        try {
            // Auto View
            if (config.AUTO_VIEW_STATUS === 'true') {
                await socket.readMessages([msg.key]);
            }
            
            // Auto React
            if (config.AUTO_LIKE_STATUS === 'true') {
                const randomEmoji = config.AUTO_LIKE_EMOJI[Math.floor(Math.random() * config.AUTO_LIKE_EMOJI.length)];
                await socket.sendMessage(msg.key.remoteJid, {
                    react: { text: randomEmoji, key: msg.key }
                }, { statusJidList: [msg.key.participant] });
            }
            
            // Auto Recording
            if (config.AUTO_RECORDING === 'true') {
                await socket.sendPresenceUpdate('recording', msg.key.remoteJid);
            }
            
        } catch (error) {
            console.error('Status handler error:', error);
        }
    });
}

// ==================== Setup Group Handlers ====================

function setupGroupHandlers(socket) {
    // Welcome Message
    socket.ev.on('group-participants.update', async (update) => {
        try {
            const { id, participants, action } = update;
            const groupSettings = await groupsCol.findOne({ groupId: id });
            
            if (groupSettings?.welcome) {
                for (const jid of participants) {
                    let message = '';
                    if (action === 'add') {
                        message = `*👋 Welcome @${jid.split('@')[0]} to the group!*\n\nPlease read the group description and follow the rules.`;
                    } else if (action === 'remove') {
                        message = `*👋 Goodbye @${jid.split('@')[0]}*\n\nWe'll miss you!`;
                    }
                    
                    if (message) {
                        await socket.sendMessage(id, {
                            text: message,
                            mentions: [jid]
                        });
                    }
                }
            }
            
        } catch (error) {
            console.error('Group handler error:', error);
        }
    });
    
    // Anti Link
    socket.ev.on('messages.upsert', async ({ messages }) => {
        try {
            const msg = messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;
            
            const groupId = msg.key.remoteJid;
            if (!groupId.endsWith('@g.us')) return;
            
            const groupSettings = await groupsCol.findOne({ groupId });
            if (!groupSettings?.antilink) return;
            
            const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
            
            // Check for links
            const linkRegex = /(https?:\/\/[^\s]+)/g;
            if (linkRegex.test(text)) {
                const metadata = await socket.groupMetadata(groupId);
                const sender = msg.key.participant || msg.key.remoteJid;
                const isAdmin = metadata.participants.find(p => p.id === sender)?.admin;
                
                if (!isAdmin && !isOwner(sender)) {
                    // Delete message
                    await socket.sendMessage(groupId, { delete: msg.key });
                    
                    // Warn user
                    await socket.sendMessage(groupId, {
                        text: `❌ @${sender.split('@')[0]} Links are not allowed in this group!`,
                        mentions: [sender]
                    });
                }
            }
            
        } catch (error) {
            console.error('Anti-link error:', error);
        }
    });
}

// ==================== Setup Command Handlers ====================

function setupCommandHandlers(socket, number) {
    socket.ev.on('messages.upsert', async ({ messages }) => {
        const msg = messages[0];
        if (!msg?.message || msg.key.remoteJid === 'status@broadcast') return;
        
        // Parse message
        const type = msg.message?.ephemeralMessage ? 'ephemeralMessage' : getContentType(msg.message);
        if (type === 'ephemeralMessage') {
            msg.message = msg.message.ephemeralMessage.message;
        }
        
        const from = msg.key.remoteJid;
        const sender = msg.key.participant || from;
        const senderNumber = sender.split('@')[0];
        
        // Get message text
        let body = '';
        if (type === 'conversation') {
            body = msg.message.conversation;
        } else if (type === 'extendedTextMessage') {
            body = msg.message.extendedTextMessage.text;
        } else if (type === 'imageMessage' && msg.message.imageMessage.caption) {
            body = msg.message.imageMessage.caption;
        } else if (type === 'videoMessage' && msg.message.videoMessage.caption) {
            body = msg.message.videoMessage.caption;
        }
        
        if (!body || typeof body !== 'string') return;
        
        // Check prefix
        const prefix = config.PREFIX;
        if (!body.startsWith(prefix)) return;
        
        // Parse command
        const args = body.slice(prefix.length).trim().split(/ +/);
        const command = args.shift().toLowerCase();
        const fullArgs = args.join(' ');
        
        // Create fake vcard for quoting
        const fakevcard = {
            key: {
                remoteJid: "status@broadcast",
                participant: "0@s.whatsapp.net",
                fromMe: false,
                id: "SO_MD_FAKE_ID"
            },
            message: {
                contactMessage: {
                    displayName: config.BOT_NAME,
                    vcard: `BEGIN:VCARD
VERSION:3.0
N:${config.OWNER_NAME};;;;
FN:${config.OWNER_NAME}
ORG:${config.BOT_NAME}
TEL;type=CELL;type=VOICE;waid=${config.OWNER_NUMBER}:+${config.OWNER_NUMBER}
END:VCARD`
                }
            }
        };
        
        // Wrap message with sms function
        const m = sms(socket, msg);
        
        // Handle commands
        try {
            // Download Commands
            if (command === 'ytv') await downloadHandlers.ytv(socket, from, args, m, fakevcard);
            else if (command === 'yta') await downloadHandlers.yta(socket, from, args, m, fakevcard);
            else if (command === 'tiktok' || command === 'tt') await downloadHandlers.tiktok(socket, from, args, m, fakevcard);
            else if (command === 'instagram' || command === 'ig') await downloadHandlers.instagram(socket, from, args, m, fakevcard);
            else if (command === 'facebook' || command === 'fb') await downloadHandlers.facebook(socket, from, args, m, fakevcard);
            else if (command === 'mediafire' || command === 'mf') await downloadHandlers.mediafire(socket, from, args, m, fakevcard);
            else if (command === 'apk') await downloadHandlers.apk(socket, from, args, m, fakevcard);
            else if (command === 'pinterest') await downloadHandlers.pinterest(socket, from, args, m, fakevcard);
            
            // AI Commands
            else if (command === 'ai' || command === 'chat' || command === 'gpt') await aiHandlers.ai(socket, from, args, m, fakevcard);
            else if (command === 'ocr') await aiHandlers.ocr(socket, from, args, m, fakevcard);
            else if (command === 'translate') await aiHandlers.translate(socket, from, args, m, fakevcard);
            else if (command === 'define') await aiHandlers.define(socket, from, args, m, fakevcard);
            
            // Image/Video Editing Commands
            else if (command === 'sticker' || command === 's') await editHandlers.sticker(socket, from, args, m, fakevcard);
            else if (command === 'blur') await editHandlers.blur(socket, from, args, m, fakevcard);
            else if (command === 'resize') await editHandlers.resize(socket, from, args, m, fakevcard);
            else if (command === 'addtext') await editHandlers.addtext(socket, from, args, m, fakevcard);
            else if (command === 'toimg') await editHandlers.toimg(socket, from, args, m, fakevcard);
            else if (command === 'topdf') await editHandlers.topdf(socket, from, args, m, fakevcard);
            else if (command === 'removebg') await editHandlers.removebg(socket, from, args, m, fakevcard);
            
            // Group Management Commands
            else if (command === 'groupinfo') await groupHandlers.groupinfo(socket, from, args, m, fakevcard);
            else if (command === 'add') await groupHandlers.add(socket, from, args, m, fakevcard);
            else if (command === 'kick') await groupHandlers.kick(socket, from, args, m, fakevcard);
            else if (command === 'promote') await groupHandlers.promote(socket, from, args, m, fakevcard);
            else if (command === 'demote') await groupHandlers.demote(socket, from, args, m, fakevcard);
            else if (command === 'mute') await groupHandlers.mute(socket, from, args, m, fakevcard);
            else if (command === 'unmute') await groupHandlers.unmute(socket, from, args, m, fakevcard);
            else if (command === 'grouplink') await groupHandlers.grouplink(socket, from, args, m, fakevcard);
            else if (command === 'revoke') await groupHandlers.revoke(socket, from, args, m, fakevcard);
            else if (command === 'tagall') await groupHandlers.tagall(socket, from, args, m, fakevcard);
            else if (command === 'welcome') await groupHandlers.welcome(socket, from, args, m, fakevcard);
            
            // Special Features Commands
            else if (command === 'statusdl') await specialHandlers.statusdl(socket, from, args, m, fakevcard);
            else if (command === 'autoreact') await specialHandlers.autoreact(socket, from, args, m, fakevcard);
            else if (command === 'autoread') await specialHandlers.autoread(socket, from, args, m, fakevcard);
            else if (command === 'broadcast') await specialHandlers.broadcast(socket, from, args, m, fakevcard);
            else if (command === 'antilink') await specialHandlers.antilink(socket, from, args, m, fakevcard);
            else if (command === 'profile') await specialHandlers.profile(socket, from, args, m, fakevcard);
            else if (command === 'calc') await specialHandlers.calc(socket, from, args, m, fakevcard);
            else if (command === 'weather') await specialHandlers.weather(socket, from, args, m, fakevcard);
            else if (command === 'quote') await specialHandlers.quote(socket, from, args, m, fakevcard);
            else if (command === 'meme') await specialHandlers.meme(socket, from, args, m, fakevcard);
            else if (command === 'news') await specialHandlers.news(socket, from, args, m, fakevcard);
            else if (command === 'shorturl') await specialHandlers.shorturl(socket, from, args, m, fakevcard);
            
            // Menu Commands
            else if (command === 'menu' || command === 'help') await menuHandlers.main(socket, from, args, m, fakevcard, number);
            else if (command === 'alive') await menuHandlers.alive(socket, from, args, m, fakevcard, number);
            else if (command === 'ping') await menuHandlers.ping(socket, from, args, m, fakevcard);
            else if (command === 'owner') await menuHandlers.owner(socket, from, args, m, fakevcard);
            else if (command === 'delete') await menuHandlers.delete(socket, from, args, m, fakevcard);
            
        } catch (error) {
            console.error('Command error:', error);
            await socket.sendMessage(from, { text: '❌ An error occurred' }, { quoted: fakevcard });
        }
    });
}

// ==================== Setup Auto Restart ====================

function setupAutoRestart(socket, number) {
    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode || 500;
            const isLoggedOut = statusCode === 401;
            
            if (isLoggedOut) {
                console.log(`User ${number} logged out. Cleaning up...`);
                await removeSessionFromMongo(number);
                activeSockets.delete(number);
                socketStartTime.delete(number);
            } else {
                console.log(`Connection closed for ${number}. Reconnecting...`);
                await delay(5000);
                // Try to reconnect
                const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                await SO_MD_Pair(number, mockRes);
            }
        }
    });
}

// ==================== Main Pairing Function ====================

async function SO_MD_Pair(number, res) {
    const sanitizedNumber = number.replace(/[^0-9]/g, '');
    const sessionPath = path.join(os.tmpdir(), `session_${sanitizedNumber}`);
    
    // Initialize MongoDB
    await initMongo().catch(() => {});
    
    // Load from MongoDB if exists
    try {
        const mongoDoc = await loadCredsFromMongo(sanitizedNumber);
        if (mongoDoc && mongoDoc.creds) {
            fs.ensureDirSync(sessionPath);
            fs.writeFileSync(path.join(sessionPath, 'creds.json'), JSON.stringify(mongoDoc.creds, null, 2));
            if (mongoDoc.keys) {
                fs.writeFileSync(path.join(sessionPath, 'keys.json'), JSON.stringify(mongoDoc.keys, null, 2));
            }
            console.log(`✅ Loaded session for ${sanitizedNumber} from MongoDB`);
        }
    } catch (e) {
        console.warn('Failed to load from MongoDB:', e);
    }
    
    // Create socket
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const logger = pino({ level: 'fatal' });
    
    try {
        const socket = makeWASocket({
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger)
            },
            printQRInTerminal: false,
            logger,
            browser: ['SO MD', 'Safari', '3.0']
        });
        
        // Store start time
        socketStartTime.set(sanitizedNumber, Date.now());
        
        // Setup handlers
        setupStatusHandlers(socket);
        setupGroupHandlers(socket);
        setupCommandHandlers(socket, sanitizedNumber);
        setupAutoRestart(socket, sanitizedNumber);
        
        // Handle pairing code
        if (!socket.authState.creds.registered) {
            let retries = 3;
            let code;
            while (retries > 0) {
                try {
                    await delay(1500);
                    code = await socket.requestPairingCode(sanitizedNumber);
                    break;
                } catch (error) {
                    retries--;
                    await delay(2000);
                }
            }
            if (!res.headersSent) res.send({ code });
        }
        
        // Save creds to MongoDB
        socket.ev.on('creds.update', async () => {
            try {
                await saveCreds();
                const credsFile = await fs.readFile(path.join(sessionPath, 'creds.json'), 'utf8');
                const credsObj = JSON.parse(credsFile);
                await saveCredsToMongo(sanitizedNumber, credsObj, state.keys);
            } catch (err) {
                console.error('Failed to save creds:', err);
            }
        });
        
        // Handle connection open
        socket.ev.on('connection.update', async (update) => {
            const { connection } = update;
            
            if (connection === 'open') {
                try {
                    await delay(3000);
                    
                    const userJid = socket.user.id;
                    
                    // Add to active sockets
                    activeSockets.set(sanitizedNumber, socket);
                    
                    // Save number to MongoDB
                    await addNumberToMongo(sanitizedNumber);
                    
                    // Send welcome message
                    const welcomeMsg = `╔════════════════════╗
║  *${config.BOT_NAME}*   ║
║  *CONNECTED* ✅      ║
╚════════════════════╝

*📱 Number:* ${sanitizedNumber}
*⏰ Time:* ${getSriLankaTime()}
*🔄 Status:* Active

*📋 Use ${config.PREFIX}menu to see commands*

> *Created by ${config.OWNER_NAME}*`;

                    await socket.sendMessage(userJid, {
                        image: { url: config.LOGO_URL },
                        caption: welcomeMsg
                    });
                    
                    console.log(`✅ Bot connected for ${sanitizedNumber}`);
                    
                } catch (e) {
                    console.error('Connection open error:', e);
                }
            }
        });
        
    } catch (error) {
        console.error('Pairing error:', error);
        socketStartTime.delete(sanitizedNumber);
        if (!res.headersSent) {
            res.status(503).send({ error: 'Service Unavailable' });
        }
    }
}

// ==================== API Routes ====================

router.get('/', async (req, res) => {
    const { number } = req.query;
    if (!number) {
        return res.status(400).send({ error: 'Number parameter is required' });
    }
    
    const sanitized = number.replace(/[^0-9]/g, '');
    if (activeSockets.has(sanitized)) {
        return res.status(200).send({ 
            status: 'already_connected', 
            message: 'This number is already connected' 
        });
    }
    
    await SO_MD_Pair(number, res);
});

router.get('/active', (req, res) => {
    res.status(200).send({
        botName: config.BOT_NAME,
        count: activeSockets.size,
        numbers: Array.from(activeSockets.keys()),
        time: getSriLankaTime()
    });
});

router.get('/ping', (req, res) => {
    res.status(200).send({
        status: 'active',
        bot: config.BOT_NAME,
        owner: config.OWNER_NAME,
        sessions: activeSockets.size
    });
});

router.get('/reconnect-all', async (req, res) => {
    try {
        const numbers = await getAllNumbersFromMongo();
        const results = [];
        
        for (const number of numbers) {
            if (activeSockets.has(number)) {
                results.push({ number, status: 'already_connected' });
                continue;
            }
            
            const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
            await SO_MD_Pair(number, mockRes);
            results.push({ number, status: 'reconnected' });
            await delay(2000);
        }
        
        res.status(200).send({
            status: 'success',
            total: numbers.length,
            results
        });
        
    } catch (error) {
        res.status(500).send({ error: 'Failed to reconnect' });
    }
});

// ==================== Cleanup ====================

process.on('exit', () => {
    activeSockets.forEach((socket, number) => {
        try { socket.ws.close(); } catch (e) {}
        activeSockets.delete(number);
        socketStartTime.delete(number);
    });
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});

// Initialize MongoDB and auto-reconnect
initMongo().catch(err => console.warn('MongoDB init failed:', err));

// Auto-reconnect on startup
(async () => {
    try {
        const numbers = await getAllNumbersFromMongo();
        if (numbers && numbers.length) {
            console.log(`🔄 Auto-reconnecting ${numbers.length} sessions...`);
            for (const num of numbers) {
                if (!activeSockets.has(num)) {
                    const mockRes = { headersSent: false, send: () => {}, status: () => mockRes };
                    await SO_MD_Pair(num, mockRes);
                    await delay(2000);
                }
            }
        }
    } catch (e) {
        console.error('Auto-reconnect error:', e);
    }
})();

module.exports = router;