const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB || 'internshala';
const JWT_SECRET = process.env.JWT_SECRET || 'internshala_admin_secret_key_2026';

let mongoClient = null;
let db = null;

/**
 * Connect to MongoDB and seed default admin user
 */
async function getDb() {
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
    await seedAdminUser(db);
  }
  return db;
}

/**
 * Seed default admin user (vipulphatangare3@gmail.com / 123456) in MongoDB users collection
 */
async function seedAdminUser(database) {
  try {
    const usersColl = database.collection('users');
    await usersColl.createIndex({ email: 1 }, { unique: true });
    
    const adminEmail = 'vipulphatangare3@gmail.com';
    const existing = await usersColl.findOne({ email: adminEmail });
    if (!existing) {
      const hashedPassword = await bcrypt.hash('123456', 10);
      await usersColl.insertOne({
        email: adminEmail,
        password: hashedPassword,
        name: 'Vipul Phatangare (Admin)',
        role: 'admin',
        createdAt: new Date(),
        updatedAt: new Date()
      });
      console.log(`[Admin Seed] Admin user created: ${adminEmail}`);
    }
  } catch (err) {
    console.error('[Admin Seed Error]:', err.message);
  }
}

// Global state tracking active Python scraper process
const scraperState = {
  activeProcess: null,
  currentLogId: null
};

/**
 * Auth middleware for admin endpoints
 */
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid or expired token' });
  }
}

module.exports = {
  getDb,
  JWT_SECRET,
  scraperState,
  requireAdmin
};
