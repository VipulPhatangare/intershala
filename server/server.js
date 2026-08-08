const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const adminRoutes = require('./routes/admin');
const jobsRoutes = require('./routes/jobs');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3005;
const HOST = process.env.HOST || '127.0.0.1';

app.set('trust proxy', 1);
app.use(cors());
app.use(express.json());

// Distinct Dedicated Endpoint Routes
app.use('/api/admin', adminRoutes);
app.use('/api/jobs', jobsRoutes);

// Legacy backward-compatibility routes
app.use('/api', jobsRoutes);
app.use('/api', adminRoutes);

// Serve static React production build files if client/dist exists
const clientBuildPath = path.join(__dirname, '../client/dist');
app.use(express.static(clientBuildPath));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(clientBuildPath, 'index.html'), (err) => {
    if (err) {
      res.status(200).send(`
        <!DOCTYPE html>
        <html>
          <head><title>Internshala MERN API Server</title></head>
          <body style="font-family: sans-serif; background: #0f172a; color: #f8fafc; padding: 2rem;">
            <h2>⚡ Internshala MERN API Server Running on Port ${PORT}</h2>
            <p><strong>Jobs Portal Base Endpoint:</strong> <code>http://localhost:${PORT}/api/jobs</code></p>
            <p><strong>Admin Portal Base Endpoint:</strong> <code>http://localhost:${PORT}/api/admin</code></p>
            <p>Endpoints:</p>
            <ul>
              <li><a href="/api/jobs/stats" style="color: #38bdf8;">/api/jobs/stats</a></li>
              <li><a href="/api/jobs/listings" style="color: #38bdf8;">/api/jobs/listings</a></li>
              <li><a href="/api/jobs/categories" style="color: #38bdf8;">/api/jobs/categories</a></li>
              <li><a href="/api/v1/export/data" style="color: #38bdf8;">/api/v1/export/data (POST/GET - API Key Protected)</a></li>
              <li><a href="/api/admin/api-key" style="color: #38bdf8;">/api/admin/api-key (Admin Token Protected)</a></li>
              <li><a href="/api/admin/scrape-metrics" style="color: #38bdf8;">/api/admin/scrape-metrics</a></li>
              <li><a href="/api/admin/scrape-logs" style="color: #38bdf8;">/api/admin/scrape-logs</a></li>

            </ul>
          </body>
        </html>
      `);
    }
  });
});

const server = app.listen(PORT, HOST, () => {
  console.log(`========================================================`);
  console.log(`🚀 Internshala MERN Stack Express Backend Running`);
  console.log(`📡 Listening on http://${HOST}:${PORT}/api`);
  console.log(`========================================================`);
});

// Behind a reverse proxy the port is fixed — never silently move to another
// one, or nginx keeps proxying to a port nothing is listening on.
server.on('error', (err) => {
  console.error(`Failed to bind ${HOST}:${PORT} — ${err.message}`);
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}

