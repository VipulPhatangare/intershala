const express = require('express');
const { getDb, scraperState, requireApiKey } = require('../db');

const router = express.Router();


const PREDEFINED_CATEGORIES = [
  'Software Development',
  'Web Development',
  'Data Science & Analytics',
  'Mobile App Development',
  'Python / AI / ML',
  'Digital Marketing',
  'Graphic Design & UI/UX',
  'Content Writing',
  'Finance & Accounting',
  'Human Resources (HR)',
  'Engineering / Core',
  'Other'
];

/**
 * GET /api/jobs/categories
 * Returns list of standard job & internship categories
 */
router.get('/categories', async (req, res) => {
  res.json({
    success: true,
    categories: PREDEFINED_CATEGORIES
  });
});

/**
 * GET /api/jobs/stats
 * Public summary statistics for jobs & internships
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

    // Match what /listings actually serves, or the KPI overstates the site.
    const notSponsored = { status: { $ne: 'external' } };

    for (const source of sources) {
      const coll = database.collection(source);
      const count = await coll.countDocuments(notSponsored);
      if (source === 'jobs') jobsTotal = count;
      else internshipsTotal = count;

      const recentCount = await coll.countDocuments({
        $and: [
          notSponsored,
          {
            $or: [
              { updated_at: { $gte: cutoff36h } },
              { first_seen_at: { $gte: cutoff36h } }
            ]
          }
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

    // Get latest scrape log
    const scrapeLogsColl = database.collection('scrape_logs');
    const latestLog = await scrapeLogsColl.find({}).sort({ started_at: -1 }).limit(1).toArray();

    res.json({
      success: true,
      data: {
        jobs_total: jobsTotal,
        internships_total: internshipsTotal,
        recent_36h_total: recent36hTotal,
        grand_total: jobsTotal + internshipsTotal,
        last_updated: lastUpdated,
        scraper_active: scraperState.activeProcess !== null,
        last_scrape_info: latestLog.length > 0 ? latestLog[0] : null
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/jobs/listings
 * Query job & internship listings with filters
 */
router.get('/listings', async (req, res) => {
  try {
    const database = await getDb();
    const sourceParam = req.query.source || 'all';
    const categoryParam = req.query.category ? req.query.category.trim() : null;
    const searchParam = req.query.search ? req.query.search.trim() : null;
    const locationParam = req.query.location ? req.query.location.trim() : null;
    const wfhParam = req.query.wfh === 'true' || req.query.wfh === '1';
    // Sponsored rows are excluded by default; pass include_sponsored=true to
    // see the ones older scrapes stored before SKIP_EXTERNAL was introduced.
    const includeSponsored = req.query.include_sponsored === 'true' || req.query.include_sponsored === '1';
    const recentHours = parseFloat(req.query.recent_hours) || null;
    const page = parseInt(req.query.page, 10) || 1;
    const limit = parseInt(req.query.limit, 10) || 18;

    let sources = ['jobs', 'internships'];
    if (sourceParam === 'jobs') sources = ['jobs'];
    if (sourceParam === 'internships') sources = ['internships'];

    const andConditions = [];

    // Search filter
    if (searchParam) {
      andConditions.push({
        $or: [
          { title: { $regex: searchParam, $options: 'i' } },
          { company: { $regex: searchParam, $options: 'i' } },
          { skills: { $regex: searchParam, $options: 'i' } },
          { location: { $regex: searchParam, $options: 'i' } }
        ]
      });
    }

    // Category filter
    if (categoryParam && categoryParam !== 'All Categories') {
      let catRegex = categoryParam;
      if (categoryParam.includes('Web')) catRegex = 'web|frontend|backend|full stack|html|react|node|vue|angular|php|wordpress';
      else if (categoryParam.includes('Data')) catRegex = 'data|analytics|machine learning|ai|bi|sql|tableau|python';
      else if (categoryParam.includes('Python')) catRegex = 'python|django|flask|fastapi';
      else if (categoryParam.includes('Mobile')) catRegex = 'mobile|android|ios|flutter|react native|app';
      else if (categoryParam.includes('Marketing')) catRegex = 'marketing|seo|social media|content|growth|digital';
      else if (categoryParam.includes('Design')) catRegex = 'design|ui|ux|graphic|figma|photoshop|illustrator';
      else if (categoryParam.includes('Finance')) catRegex = 'finance|accounting|audit|tally|banking|stock';
      else if (categoryParam.includes('Human Resources')) catRegex = 'hr|human resources|recruitment|talent';
      else if (categoryParam.includes('Software')) catRegex = 'software|developer|engineer|java|c\\+\\+|c#|coding';

      andConditions.push({
        $or: [
          { category: { $regex: categoryParam, $options: 'i' } },
          { title: { $regex: catRegex, $options: 'i' } },
          { skills: { $regex: catRegex, $options: 'i' } }
        ]
      });
    }

    // Location filter
    if (locationParam) {
      andConditions.push({ location: { $regex: locationParam, $options: 'i' } });
    }

    // Off-site ad cards carry no description, so they never reach the site.
    if (!includeSponsored) {
      andConditions.push({ status: { $ne: 'external' } });
    }

    // Work From Home filter
    if (wfhParam) {
      const wfhRegex = { $regex: 'work from home|remote|wfh', $options: 'i' };
      andConditions.push({
        $or: [{ location: wfhRegex }, { title: wfhRegex }]
      });
    }

    // Recent hours filter
    if (recentHours && recentHours > 0) {
      const cutoff = new Date(Date.now() - recentHours * 60 * 60 * 1000);
      andConditions.push({
        $or: [
          { updated_at: { $gte: cutoff } },
          { first_seen_at: { $gte: cutoff } }
        ]
      });
    }

    const query = andConditions.length > 0 ? { $and: andConditions } : {};

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
 * GET /api/jobs/listing/:source/:job_id
 * Get single listing details
 */
async function handleListingDetail(req, res) {
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
}

router.get('/listing/:source/:job_id', handleListingDetail);
router.get('/detail/:source/:job_id', handleListingDetail);

/* ==========================================================================
   Bulk JSON Export API for External Platforms
   All export routes are guarded by requireApiKey and apply no row cap:
   ask for more than exists and you simply get everything that exists.
   ========================================================================== */

// ld_json and sections_json are raw scraper payloads that duplicate fields
// already returned individually — dropping them roughly halves the response.
const EXPORT_PROJECTION = { _id: 0, ld_json: 0, sections_json: 0 };

const DEFAULT_RECENT_HOURS = 36;

// Jobs first, then internships: the order start/end pages through.
const EXPORT_COLLECTIONS = ['jobs', 'internships'];

/**
 * Read a parameter from the JSON body, falling back to the query string, so
 * the same handler serves both POST (documented) and GET (convenient).
 */
function readParam(req, name) {
  const fromBody = req.body ? req.body[name] : undefined;
  return fromBody !== undefined ? fromBody : req.query[name];
}

function isTruthy(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

/**
 * Build the shared export filter. Sponsored ("external") rows are excluded by
 * default so an export matches what /stats and /listings report.
 */
function buildExportQuery({ includeSponsored, since }) {
  const conditions = [];

  if (!includeSponsored) {
    conditions.push({ status: { $ne: 'external' } });
  }
  if (since) {
    // scraped_at is a string and cannot be range-queried; these two are Dates.
    conditions.push({
      $or: [
        { updated_at: { $gte: since } },
        { first_seen_at: { $gte: since } }
      ]
    });
  }

  return conditions.length ? { $and: conditions } : {};
}

function resolveCollections(sourceParam) {
  const source = (sourceParam || 'all').toString().toLowerCase();
  if (source === 'all') return { source, names: EXPORT_COLLECTIONS };
  if (EXPORT_COLLECTIONS.includes(source)) return { source, names: [source] };
  return null;
}

async function countPerCollection(database, names, query) {
  const counts = {};
  for (const name of names) {
    counts[name] = await database.collection(name).countDocuments(query);
  }
  return counts;
}

function emptyBuckets() {
  return { jobs: [], internships: [] };
}

/**
 * POST /api/v1/export/range
 * Body: { start, end, source, include_sponsored }
 *
 * start/end address jobs and internships as one continuous stream, so
 * (end - start) always bounds the number of rows returned. Omit `end` to read
 * to the very end. Results are sorted by _id so a window is stable across
 * calls — without an explicit sort, paging can silently skip or repeat rows.
 */
async function handleExportRange(req, res) {
  try {
    const resolved = resolveCollections(readParam(req, 'source'));
    if (!resolved) {
      return res.status(400).json({
        success: false,
        error: "Invalid source. Use 'all', 'jobs' or 'internships'."
      });
    }

    const startRaw = readParam(req, 'start');
    const endRaw = readParam(req, 'end');

    const start = startRaw === undefined || startRaw === null || startRaw === ''
      ? 0
      : Number(startRaw);
    if (!Number.isFinite(start) || start < 0) {
      return res.status(400).json({ success: false, error: 'start must be a number >= 0' });
    }

    const hasEnd = !(endRaw === undefined || endRaw === null || endRaw === '');
    const end = hasEnd ? Number(endRaw) : null;
    if (hasEnd && (!Number.isFinite(end) || end <= start)) {
      return res.status(400).json({ success: false, error: 'end must be a number greater than start' });
    }

    const database = await getDb();
    const includeSponsored = isTruthy(readParam(req, 'include_sponsored'));
    const query = buildExportQuery({ includeSponsored });

    const counts = await countPerCollection(database, resolved.names, query);
    const totalAvailable = resolved.names.reduce((sum, name) => sum + counts[name], 0);

    const windowStart = Math.floor(start);
    // No cap: an end past the last row just means "everything from start on".
    const windowEnd = hasEnd ? Math.floor(end) : totalAvailable;

    const data = emptyBuckets();
    let remaining = Math.max(0, windowEnd - windowStart);
    let collectionOffset = 0; // absolute index at which this collection starts

    for (const name of resolved.names) {
      const count = counts[name];
      const skipWithin = Math.max(0, windowStart - collectionOffset);

      if (remaining > 0 && skipWithin < count) {
        const take = Math.min(count - skipWithin, remaining);
        data[name] = await database.collection(name)
          .find(query, { projection: EXPORT_PROJECTION })
          .sort({ _id: 1 })
          .skip(skipWithin)
          .limit(take)
          .toArray();
        remaining -= data[name].length;
      }

      collectionOffset += count;
    }

    const returned = data.jobs.length + data.internships.length;

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      source: resolved.source,
      mode: 'range',
      window: { start: windowStart, end: hasEnd ? windowEnd : null },
      returned,
      total_available: totalAvailable,
      has_more: windowStart + returned < totalAvailable,
      next_start: windowStart + returned,
      include_sponsored: includeSponsored,
      counts: { jobs: data.jobs.length, internships: data.internships.length },
      data
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/v1/export/recent
 * Body: { hours, source, include_sponsored }
 *
 * Returns every listing added or updated within the last `hours` hours.
 * Defaults to 36. No row cap.
 */
async function handleExportRecent(req, res) {
  try {
    const resolved = resolveCollections(readParam(req, 'source'));
    if (!resolved) {
      return res.status(400).json({
        success: false,
        error: "Invalid source. Use 'all', 'jobs' or 'internships'."
      });
    }

    // recent_hours is accepted too, so callers of the older endpoint keep working.
    const hoursRaw = readParam(req, 'hours') !== undefined
      ? readParam(req, 'hours')
      : readParam(req, 'recent_hours');

    const hours = hoursRaw === undefined || hoursRaw === null || hoursRaw === ''
      ? DEFAULT_RECENT_HOURS
      : Number(hoursRaw);
    if (!Number.isFinite(hours) || hours <= 0) {
      return res.status(400).json({ success: false, error: 'hours must be a number greater than 0' });
    }

    const database = await getDb();
    const includeSponsored = isTruthy(readParam(req, 'include_sponsored'));
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);
    const query = buildExportQuery({ includeSponsored, since });

    const data = emptyBuckets();
    for (const name of resolved.names) {
      data[name] = await database.collection(name)
        .find(query, { projection: EXPORT_PROJECTION })
        .sort({ _id: 1 })
        .toArray();
    }

    const returned = data.jobs.length + data.internships.length;

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      source: resolved.source,
      mode: 'recent',
      window: { hours, since: since.toISOString() },
      returned,
      total_available: returned,
      has_more: false,
      include_sponsored: includeSponsored,
      counts: { jobs: data.jobs.length, internships: data.internships.length },
      data
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/v1/export/data — the original "everything" export, kept so any
 * existing integration continues to work. It is the range export with no window.
 */
async function handleExportAllData(req, res) {
  if (readParam(req, 'recent_hours') !== undefined) {
    return handleExportRecent(req, res);
  }
  return handleExportRange(req, res);
}

// Support multiple route paths for flexibility
router.post('/export', requireApiKey, handleExportAllData);
router.get('/export', requireApiKey, handleExportAllData);
router.post('/v1/export/data', requireApiKey, handleExportAllData);
router.get('/v1/export/data', requireApiKey, handleExportAllData);

router.post('/v1/export/range', requireApiKey, handleExportRange);
router.get('/v1/export/range', requireApiKey, handleExportRange);
router.post('/v1/export/recent', requireApiKey, handleExportRecent);
router.get('/v1/export/recent', requireApiKey, handleExportRecent);

module.exports = router;

