const crypto = require('crypto');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB || 'internshala';

// Never fall back to a literal secret: this repo is public, so a committed
// value lets anyone sign their own admin token. Without JWT_SECRET we mint a
// random one per process — sessions then end at restart, which is a far better
// failure mode than a forgeable one.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
  console.warn('[Auth] JWT_SECRET not set — using a random per-process secret; admin sessions end on restart.');
}

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
 * Seed the admin user in the MongoDB `users` collection.
 *
 * Credentials come from ADMIN_EMAIL / ADMIN_PASSWORD so a deployment is not
 * stuck with the values in this file. Only runs when the user is absent, so a
 * password changed later is never reset back.
 */
async function seedAdminUser(database) {
  try {
    const usersColl = database.collection('users');
    await usersColl.createIndex({ email: 1 }, { unique: true });

    const adminEmail = (process.env.ADMIN_EMAIL || 'vipulphatangare3@gmail.com').trim().toLowerCase();
    const adminPassword = process.env.ADMIN_PASSWORD || '123456';

    const existing = await usersColl.findOne({ email: adminEmail });
    if (!existing) {
      if (!process.env.ADMIN_PASSWORD) {
        console.warn('[Admin Seed] ADMIN_PASSWORD not set — seeding the default password. Change it before exposing this server.');
      }
      const hashedPassword = await bcrypt.hash(adminPassword, 10);
      await usersColl.insertOne({
        email: adminEmail,
        password: hashedPassword,
        name: process.env.ADMIN_NAME || 'Vipul Phatangare (Admin)',
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
