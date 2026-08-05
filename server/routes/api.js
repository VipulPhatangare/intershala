const express = require('express');
const adminRoutes = require('./admin');
const jobsRoutes = require('./jobs');

const router = express.Router();

// Mount segregated endpoints
router.use('/admin', adminRoutes);
router.use('/jobs', jobsRoutes);

// Fallback top-level mounts for legacy compatibility
router.use('/', jobsRoutes);
router.use('/', adminRoutes);

module.exports = router;
