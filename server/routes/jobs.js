const express = require('express');
const { getDb, scraperState } = require('../db');

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

module.exports = router;
