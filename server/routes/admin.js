const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb, JWT_SECRET, scraperState, requireAdmin } = require('../db');

const router = express.Router();

/* ==========================================================================
   ADMIN AUTHENTICATION ENDPOINTS
   ========================================================================== */

/**
 * POST /api/admin/login
 * Database authentication using hashed password in MongoDB
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Email and password are required' });
    }

    const database = await getDb();
    const usersColl = database.collection('users');
    const user = await usersColl.findOne({ email: email.trim().toLowerCase() });

    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user._id.toString(), email: user.email, role: user.role || 'admin', name: user.name },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({
      success: true,
      message: 'Login successful',
      token,
      user: {
        email: user.email,
        name: user.name || 'Admin',
        role: user.role || 'admin'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/verify
 */
router.get('/verify', requireAdmin, (req, res) => {
  res.json({
    success: true,
    user: req.user
  });
});

/**
 * POST /api/admin/logout
 */
router.post('/logout', (req, res) => {
  res.json({ success: true, message: 'Logged out successfully' });
});


/* ==========================================================================
   SCRAPING & SCRAPE LOGS MONITORING (STORED IN MONGODB `scrape_logs`)
   ========================================================================== */

/**
 * Helper to trigger scrape process
 */
async function handleScrapeTrigger(req, res) {
  if (scraperState.activeProcess) {
    return res.status(400).json({
      success: false,
      message: 'Scrape process is already running'
    });
  }

  const { source = 'all', max_pages = 0, recent_hours = 36, triggered_by = 'manual' } = req.body || {};
  const projectRoot = path.resolve(__dirname, '../..');
  const pythonCmd = process.env.PYTHON_BIN
    || (process.platform === 'win32' ? 'python' : 'python3');
  
  const args = ['run_scraper.py', 'fast', '--source', source];
  if (recent_hours && parseFloat(recent_hours) > 0) {
    args.push('--recent-hours', recent_hours.toString());
  }
  if (max_pages && parseInt(max_pages, 10) > 0) {
    args.push('--max-pages', max_pages.toString());
  }

  try {
    const database = await getDb();
    const scrapeLogsColl = database.collection('scrape_logs');

    // Pre-scrape collection totals
    const preJobsCount = await database.collection('jobs').countDocuments();
    const preInternshipsCount = await database.collection('internships').countDocuments();

    // Insert new pending log entry into MongoDB
    const logDoc = {
      log_id: `scrape_${Date.now()}`,
      source,
      recent_hours: parseFloat(recent_hours) || 0,
      max_pages: parseInt(max_pages, 10) || 0,
      status: 'running',
      started_at: new Date(),
      ended_at: null,
      pre_jobs_count: preJobsCount,
      pre_internships_count: preInternshipsCount,
      new_jobs_added: 0,
      new_internships_added: 0,
      total_scraped: 0,
      triggered_by,
      message: `Triggered python run_scraper.py fast --source ${source} ${recent_hours ? `--recent-hours ${recent_hours}` : ''}`
    };

    const insertResult = await scrapeLogsColl.insertOne(logDoc);
    const logId = insertResult.insertedId;
    scraperState.currentLogId = logId;

    scraperState.activeProcess = spawn(pythonCmd, args, { cwd: projectRoot });

    scraperState.activeProcess.stdout.on('data', (data) => {
      console.log(`[Python Scraper stdout]: ${data}`);
    });

    scraperState.activeProcess.stderr.on('data', (data) => {
      console.error(`[Python Scraper stderr]: ${data}`);
    });

    scraperState.activeProcess.on('close', async (code) => {
      console.log(`[Python Scraper process exited with code ${code}]`);
      scraperState.activeProcess = null;

      try {
        const postDb = await getDb();
        const postJobsCount = await postDb.collection('jobs').countDocuments();
        const postInternshipsCount = await postDb.collection('internships').countDocuments();

        const newJobs = Math.max(0, postJobsCount - preJobsCount);
        const newInternships = Math.max(0, postInternshipsCount - preInternshipsCount);
        const isSuccess = code === 0;

        await scrapeLogsColl.updateOne(
          { _id: logId },
          {
            $set: {
              status: isSuccess ? 'success' : 'failed',
              ended_at: new Date(),
              post_jobs_count: postJobsCount,
              post_internships_count: postInternshipsCount,
              new_jobs_added: newJobs,
              new_internships_added: newInternships,
              total_scraped: newJobs + newInternships,
              message: isSuccess
                ? `Scrape completed successfully! Added ${newJobs} new jobs and ${newInternships} new internships.`
                : `Scrape process failed with exit code ${code}`
            }
          }
        );
      } catch (logErr) {
        console.error('[Scrape Log Update Error]:', logErr.message);
      } finally {
        scraperState.currentLogId = null;
      }
    });

    res.json({
      success: true,
      log_id: logDoc.log_id,
      message: `Scrape job successfully triggered for source '${source}' in background`
    });
  } catch (err) {
    scraperState.activeProcess = null;
    scraperState.currentLogId = null;
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/admin/scrape/trigger
 */
router.post('/scrape/trigger', handleScrapeTrigger);
router.post('/trigger-scrape', handleScrapeTrigger);

/**
 * GET /api/admin/scrape/status
 */
router.get('/scrape/status', async (req, res) => {
  try {
    const database = await getDb();
    const scrapeLogsColl = database.collection('scrape_logs');
    const latestLog = await scrapeLogsColl.find({}).sort({ started_at: -1 }).limit(1).toArray();

    res.json({
      success: true,
      running: scraperState.activeProcess !== null,
      lastScrapeLog: latestLog.length > 0 ? latestLog[0] : null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/scrape-logs
 * Fetch past scraping execution history stored in MongoDB `scrape_logs`
 */
router.get('/scrape-logs', async (req, res) => {
  try {
    const database = await getDb();
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 20;
    const skip = (page - 1) * limit;

    const scrapeLogsColl = database.collection('scrape_logs');
    const total = await scrapeLogsColl.countDocuments();
    const logs = await scrapeLogsColl.find({})
      .sort({ started_at: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.json({
      success: true,
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit) || 1,
      logs
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/admin/scrape-metrics
 * Summary of today's scraping runs, counts, timestamps, and added metrics
 */
router.get('/scrape-metrics', async (req, res) => {
  try {
    const database = await getDb();
    const scrapeLogsColl = database.collection('scrape_logs');

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const todayLogs = await scrapeLogsColl.find({
      started_at: { $gte: startOfToday }
    }).sort({ started_at: -1 }).toArray();

    const totalScrapesToday = todayLogs.length;
    let newJobsToday = 0;
    let newInternshipsToday = 0;
    let successfulToday = 0;
    let failedToday = 0;

    for (const log of todayLogs) {
      if (log.status === 'success') successfulToday++;
      if (log.status === 'failed') failedToday++;
      newJobsToday += log.new_jobs_added || 0;
      newInternshipsToday += log.new_internships_added || 0;
    }

    const jobsTotal = await database.collection('jobs').countDocuments();
    const internshipsTotal = await database.collection('internships').countDocuments();
    const latestLog = await scrapeLogsColl.find({}).sort({ started_at: -1 }).limit(1).toArray();

    res.json({
      success: true,
      data: {
        jobs_total: jobsTotal,
        internships_total: internshipsTotal,
        grand_total: jobsTotal + internshipsTotal,
        total_scrapes_today: totalScrapesToday,
        successful_today: successfulToday,
        failed_today: failedToday,
        new_jobs_added_today: newJobsToday,
        new_internships_added_today: newInternshipsToday,
        last_scrape: latestLog.length > 0 ? latestLog[0] : null,
        is_running: scraperState.activeProcess !== null
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
