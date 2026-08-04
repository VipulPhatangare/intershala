const express = require('express');
const { MongoClient } = require('mongodb');
const { spawn } = require('child_process');
const path = require('path');
const router = express.Router();

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const DB_NAME = process.env.MONGO_DB || 'internshala';


let mongoClient = null;
let db = null;

async function getDb() {
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 3000 });
    await mongoClient.connect();
    db = mongoClient.db(DB_NAME);
  }
  return db;
}

// Global state tracking active Python scraper processes
let activeScrapeProcess = null;
let lastScrapeLog = {
  status: 'idle',
  startedAt: null,
  endedAt: null,
  message: 'No scraper run triggered yet.'
};

/**
 * GET /api/stats
 * Dashboard summary statistics: total jobs, internships, recent 36h updates, last updated timestamp.
 */
router.get('/stats', async (req, res) => {
  try {
    const database = await getDb();
    const sources = ['jobs', 'internships'];
    const cutoff36h = new Date(Date.now() - 36 * 60 * 60 * 1000);

    let jobsTotal = 0;
    let internshipsTotal = 0;
    let recent36hTotal = 0;
    let lastUpdated = null;

    for (const source of sources) {
      const coll = database.collection(source);
      const count = await coll.countDocuments();
      if (source === 'jobs') jobsTotal = count;
      else internshipsTotal = count;

      const recentCount = await coll.countDocuments({
        $or: [
          { updated_at: { $gte: cutoff36h } },
          { first_seen_at: { $gte: cutoff36h } }
        ]
      });
      recent36hTotal += recentCount;

      const latestDoc = await coll.find({}, { projection: { updated_at: 1, first_seen_at: 1 } })
        .sort({ updated_at: -1 })
        .limit(1)
        .toArray();

      if (latestDoc && latestDoc.length > 0) {
        const dt = latestDoc[0].updated_at || latestDoc[0].first_seen_at;
        if (dt) {
          const dtIso = new Date(dt).toISOString();
          if (!lastUpdated || dtIso > lastUpdated) {
            lastUpdated = dtIso;
          }
        }
      }
    }

    res.json({
      success: true,
      data: {
        jobs_total: jobsTotal,
        internships_total: internshipsTotal,
        recent_36h_total: recent36hTotal,
        grand_total: jobsTotal + internshipsTotal,
        last_updated: lastUpdated,
        scraper_active: activeScrapeProcess !== null,
        last_scrape_info: lastScrapeLog
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/listings
 * Query listings with filters (source, search, location, recent_hours, wfh, page, limit).
 */
router.get('/listings', async (req, res) => {
  try {
    const database = await getDb();
    const sourceParam = req.query.source || 'all';
    const searchParam = req.query.search ? req.query.search.trim() : null;
    const locationParam = req.query.location ? req.query.location.trim() : null;
    const wfhParam = req.query.wfh === 'true' || req.query.wfh === '1';
    const recentHours = parseFloat(req.query.recent_hours) || null;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 18;

    let sources = ['jobs', 'internships'];
    if (sourceParam === 'jobs') sources = ['jobs'];
    if (sourceParam === 'internships') sources = ['internships'];

    const query = {};
    if (searchParam) {
      query.$or = [
        { title: { $regex: searchParam, $options: 'i' } },
        { company: { $regex: searchParam, $options: 'i' } },
        { skills: { $regex: searchParam, $options: 'i' } },
        { location: { $regex: searchParam, $options: 'i' } }
      ];
    }

    if (locationParam) {
      query.location = { $regex: locationParam, $options: 'i' };
    }

    if (wfhParam) {
      const wfhRegex = { $regex: 'work from home|remote|wfh', $options: 'i' };
      if (query.location) {
        query.$and = [
          { location: query.location },
          { $or: [{ location: wfhRegex }, { title: wfhRegex }] }
        ];
        delete query.location;
      } else {
        query.$or = (query.$or || []).concat([
          { location: wfhRegex },
          { title: wfhRegex }
        ]);
      }
    }

    if (recentHours && recentHours > 0) {
      const cutoff = new Date(Date.now() - recentHours * 60 * 60 * 1000);
      const recentCond = [
        { updated_at: { $gte: cutoff } },
        { first_seen_at: { $gte: cutoff } }
      ];

      if (query.$or) {
        query.$and = (query.$and || []).concat([
          { $or: query.$or },
          { $or: recentCond }
        ]);
        delete query.$or;
      } else {
        query.$or = recentCond;
      }
    }

    let allDocs = [];
    let grandCount = 0;

    const projection = {
      ld_json: 0,
      sections_json: 0
    };

    for (const source of sources) {
      const coll = database.collection(source);
      const count = await coll.countDocuments(query);
      grandCount += count;
      const docs = await coll.find(query, { projection }).toArray();
      allDocs.push(...docs);
    }

    // Sort descending by updated_at or first_seen_at
    allDocs.sort((a, b) => {
      const timeA = new Date(a.updated_at || a.first_seen_at || 0).getTime();
      const timeB = new Date(b.updated_at || b.first_seen_at || 0).getTime();
      return timeB - timeA;
    });

    const skip = (page - 1) * limit;
    const paginatedItems = allDocs.slice(skip, skip + limit);

    res.json({
      success: true,
      data: {
        total: grandCount,
        page,
        limit,
        total_pages: Math.ceil(grandCount / limit) || 1,
        items: paginatedItems
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/listing/:source/:job_id
 * Detailed information for a specific job/internship.
 */
router.get('/listing/:source/:job_id', async (req, res) => {
  try {
    const { source, job_id } = req.params;
    if (!['jobs', 'internships'].includes(source)) {
      return res.status(400).json({ success: false, error: 'Invalid source parameter' });
    }

    const database = await getDb();
    const doc = await database.collection(source).findOne({ job_id: job_id });
    if (!doc) {
      return res.status(404).json({ success: false, error: 'Listing not found' });
    }

    delete doc._id;
    res.json({ success: true, data: doc });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/scrape/trigger
 * Spawns python scraper engine (`python run_scraper.py fast`) in background.
 */
router.post('/scrape/trigger', (req, res) => {
  if (activeScrapeProcess) {
    return res.status(400).json({
      success: false,
      message: 'Scrape process is already currently running'
    });
  }

  const { source = 'all', max_pages = 2 } = req.body || {};
  const projectRoot = path.resolve(__dirname, '../..');
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
  const args = ['run_scraper.py', 'fast', '--source', source];
  if (max_pages && parseInt(max_pages, 10) > 0) {
    args.push('--max-pages', max_pages.toString());
  }

  lastScrapeLog = {
    status: 'running',
    startedAt: new Date().toISOString(),
    endedAt: null,
    message: `Triggered python run_scraper.py fast --source ${source}`
  };

  try {
    activeScrapeProcess = spawn(pythonCmd, args, { cwd: projectRoot });

    activeScrapeProcess.stdout.on('data', (data) => {
      console.log(`[Python Scraper stdout]: ${data}`);
    });

    activeScrapeProcess.stderr.on('data', (data) => {
      console.error(`[Python Scraper stderr]: ${data}`);
    });

    activeScrapeProcess.on('close', (code) => {
      console.log(`[Python Scraper process exited with code ${code}]`);
      activeScrapeProcess = null;
      lastScrapeLog.status = code === 0 ? 'completed' : 'failed';
      lastScrapeLog.endedAt = new Date().toISOString();
      lastScrapeLog.message = code === 0 
        ? 'Scrape completed successfully!' 
        : `Scrape finished with exit code ${code}`;
    });

    res.json({
      success: true,
      message: `Scrape job successfully triggered for source '${source}' in background`
    });
  } catch (err) {
    activeScrapeProcess = null;
    lastScrapeLog.status = 'failed';
    lastScrapeLog.message = `Failed to spawn Python process: ${err.message}`;
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/scrape/status
 */
router.get('/scrape/status', (req, res) => {
  res.json({
    success: true,
    running: activeScrapeProcess !== null,
    lastScrapeLog
  });
});

module.exports = router;
