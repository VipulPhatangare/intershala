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
let connecting = null;

/**
 * Connect to MongoDB and seed default admin user
 */
async function getDb() {
  if (db) {
    return db;
  }
  // The dashboard fires several requests at once on load; without this guard
  // each one would open its own client.
  if (!connecting) {
    connecting = connectToMongo().finally(() => { connecting = null; });
  }
  return connecting;
}

async function connectToMongo() {
  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
  try {
    await client.connect();
  } catch (err) {
    // Never keep a client that failed to connect: a cached one makes every
    // later request return a null db, which surfaces as a confusing
    // "cannot read properties of null" instead of the real connection error.
    await client.close().catch(() => {});
    throw err;
  }

  mongoClient = client;
  db = client.db(DB_NAME);
  await seedAdminUser(db);
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

/**
 * Generate a new API key string
 */
function generateApiKeyString() {
  return 'ik_live_' + crypto.randomBytes(24).toString('hex');
}

/**
 * Get or initialize the single active API key document
 */
async function getOrGenerateApiKey() {
  const database = await getDb();
  const apiKeysColl = database.collection('api_keys');

  let activeKeyDoc = await apiKeysColl.findOne({ status: 'active' });
  if (!activeKeyDoc) {
    const newKey = generateApiKeyString();
    activeKeyDoc = {
      key: newKey,
      status: 'active',
      created_at: new Date(),
      last_used_at: null,
      created_by: 'system'
    };
    await apiKeysColl.insertOne(activeKeyDoc);
  }
  return activeKeyDoc;
}

/**
 * Regenerate the single active API key. Deactivates any existing keys.
 */
async function regenerateApiKey(createdBy = 'admin') {
  const database = await getDb();
  const apiKeysColl = database.collection('api_keys');

  await apiKeysColl.updateMany(
    { status: 'active' },
    { $set: { status: 'revoked', revoked_at: new Date() } }
  );

  const newKey = generateApiKeyString();
  const newKeyDoc = {
    key: newKey,
    status: 'active',
    created_at: new Date(),
    last_used_at: null,
    created_by: createdBy
  };
  await apiKeysColl.insertOne(newKeyDoc);
  return newKeyDoc;
}

/**
 * Middleware to authenticate requests via API key
 */
async function requireApiKey(req, res, next) {
  try {
    let apiKey = req.headers['x-api-key'];

    if (!apiKey && req.headers.authorization) {
      if (req.headers.authorization.startsWith('Bearer ')) {
        const tokenVal = req.headers.authorization.split(' ')[1];
        if (tokenVal.startsWith('ik_live_')) {
          apiKey = tokenVal;
        }
      } else if (req.headers.authorization.startsWith('ik_live_')) {
        apiKey = req.headers.authorization;
      }
    }

    if (!apiKey && req.query && req.query.api_key) {
      apiKey = req.query.api_key;
    }

    if (!apiKey && req.body && req.body.api_key) {
      apiKey = req.body.api_key;
    }

    if (!apiKey) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: API key missing. Pass key via x-api-key header, Authorization: Bearer <key>, query param ?api_key=..., or JSON body { "api_key": "..." }'
      });
    }

    const activeDoc = await getOrGenerateApiKey();
    
    if (apiKey !== activeDoc.key) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid or revoked API key'
      });
    }

    // Update last_used_at timestamp in background
    const database = await getDb();
    database.collection('api_keys').updateOne(
      { _id: activeDoc._id },
      { $set: { last_used_at: new Date() } }
    ).catch(err => console.error('[API Key last_used_at update error]:', err.message));

    req.apiKeyDoc = activeDoc;
    next();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  getDb,
  JWT_SECRET,
  scraperState,
  requireAdmin,
  getOrGenerateApiKey,
  regenerateApiKey,
  requireApiKey
};

