module.exports = {
    // Bot Information
    BOT_NAME: 'SO MD',
    OWNER_NAME: 'SHANUKA SHAMEEN',
    OWNER_NUMBER: '94724389699',
    BOT_VERSION: '2.0.0',
    PREFIX: '.',
    
    // Status Features
    AUTO_VIEW_STATUS: 'true',
    AUTO_LIKE_STATUS: 'true',
    AUTO_REPLY_STATUS: 'false',
    AUTO_RECORDING: 'false',
    AUTO_LIKE_EMOJI: ['❤️', '🔥', '💯', '👍', '😍', '🥰', '💙', '💚', '🫶', '✨', '⭐', '🌟'],
    
    // Group Management
    GROUP_INVITE_LINK: 'https://chat.whatsapp.com/YOUR_GROUP_LINK',
    WELCOME_MESSAGE: 'true',
    GOODBYE_MESSAGE: 'true',
    ANTI_LINK: 'true',
    ANTI_BAD_WORDS: 'true',
    
    // Special Features
    NEWS_LETTER_JID: '120363123456789123@g.us',
    OTP_EXPIRY: 300000,
    MAX_RETRIES: 3,
    
    // Paths & URLs
    IMAGE_PATH: 'https://files.catbox.moe/so-md-logo.jpg',
    LOGO_URL: 'https://files.catbox.moe/so-md-logo.jpg',
    FOOTER_TEXT: '*> Powered by SHANUKA SHAMEEN*',
    CHANNEL_LINK: 'https://whatsapp.com/channel/0029VaXXXXXXXXXXXX',
    
    // API Keys (Replace with your own)
    OPENAI_API_KEY: 'your-openai-key',
    GEMINI_API_KEY: 'your-gemini-key',
    REMOVE_BG_API_KEY: 'your-removebg-key',
    
    // MongoDB
    MONGO_URI: process.env.MONGO_URI || 'mongodb+srv://nilapuldiluinda_db_user:Rad02JiIM4PtOxR2@cluster0.xdfsht7.mongodb.net/?appName=Cluster0',
    MONGO_DB: 'nilapuldiluinda',
    
    // Admin List
    ADMIN_NUMBERS: ['94724389699', '9471XXXXXXX'],
    
    // Download Settings
    MAX_FILE_SIZE: 100 * 1024 * 1024, // 100MB
    
    // AI Settings
    AI_MODEL: 'gemini-pro',
    AI_TEMPERATURE: 0.7,
};