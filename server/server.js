const express = require('express');
const cors = require('cors');
const path = require('path');
const apiRoutes = require('./routes/api');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// API Routes
app.use('/api', apiRoutes);

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
            <p>API Base URL: <code>http://localhost:${PORT}/api</code></p>
            <p>Endpoints:</p>
            <ul>
              <li><a href="/api/stats" style="color: #38bdf8;">/api/stats</a></li>
              <li><a href="/api/listings" style="color: #38bdf8;">/api/listings</a></li>
              <li><a href="/api/scrape/status" style="color: #38bdf8;">/api/scrape/status</a></li>
            </ul>
          </body>
        </html>
      `);
    }
  });
});

let port = process.env.PORT || 5000;

function startServer(p) {
  const server = app.listen(p, () => {
    console.log(`========================================================`);
    console.log(`🚀 Internshala MERN Stack Express Backend Running`);
    console.log(`📡 API URL: http://localhost:${p}/api`);
    console.log(`========================================================`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`Port ${p} is in use, trying port ${p + 1}...`);
      startServer(p + 1);
    } else {
      console.error('Server error:', err);
    }
  });
}

startServer(port);

