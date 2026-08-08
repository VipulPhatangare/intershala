import React, { useState, useEffect, useCallback } from 'react';
import {
  Play,
  RotateCw,
  CheckCircle2,
  XCircle,
  Clock,
  Briefcase,
  GraduationCap,
  Database,
  Layers,
  Search,
  LogOut,
  ShieldCheck,
  AlertTriangle,
  FileText,
  Key,
  Copy,
  Check,
  Eye,
  EyeOff,
  Code,
  Terminal,
  RefreshCw,
  ExternalLink
} from 'lucide-react';
import ListingCard from './ListingCard';
import DetailModal from './DetailModal';

const KEY_PLACEHOLDER = 'ik_live_YOUR_API_KEY_HERE';

function originOrFallback() {
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3005';
}

/* Both export endpoints, described once and reused by the docs, the request
   builder and every code snippet, so they can never drift apart. */
const EXPORT_ENDPOINTS = {
  range: {
    id: 'range',
    label: 'Range (start / end)',
    path: '/api/v1/export/range',
    tagline: 'Pull the dataset in windows, or all of it at once.',
    summary:
      'start and end address jobs and internships as one continuous stream, so (end - start) is the most rows you can get back. There is no server-side cap: ask for 100000 rows when 50000 exist and you receive all 50000. Omit end to read to the very end.',
    sampleBody: { start: 0, end: 1000, source: 'all' },
    params: [
      ['start', 'number', '0', '0-based offset, inclusive.'],
      ['end', 'number', 'end of data', 'Exclusive upper bound. Omit for everything from start on.'],
      ['source', 'string', '"all"', '"all", "jobs" or "internships".'],
      ['include_sponsored', 'boolean', 'false', 'Include sponsored ("external") listings, hidden by default.']
    ]
  },
  recent: {
    id: 'recent',
    label: 'Recent (hours)',
    path: '/api/v1/export/recent',
    tagline: 'Everything added or updated in a recent time window.',
    summary:
      'Returns every listing whose updated_at or first_seen_at falls within the last N hours. Defaults to 36 hours and has no row cap, so it is the endpoint to poll on a schedule to keep an external platform in sync.',
    sampleBody: { hours: 36, source: 'all' },
    params: [
      ['hours', 'number', '36', 'Size of the look-back window in hours. Accepts fractions.'],
      ['source', 'string', '"all"', '"all", "jobs" or "internships".'],
      ['include_sponsored', 'boolean', 'false', 'Include sponsored ("external") listings, hidden by default.']
    ]
  }
};

/**
 * Build the four integration snippets for an endpoint. Kept as one function so
 * the copy button and the rendered block can never show different code.
 */
function buildSnippets(endpoint, apiKey) {
  const url = `${originOrFallback()}${endpoint.path}`;
  const key = apiKey || KEY_PLACEHOLDER;
  const body = JSON.stringify(endpoint.sampleBody);
  const bodyPretty = JSON.stringify(endpoint.sampleBody, null, 4);
  const pyBody = bodyPretty.replace(/"([a-z_]+)":/g, '"$1":');

  return {
    curl: `curl -X POST "${url}" \\
  -H "x-api-key: ${key}" \\
  -H "Content-Type: application/json" \\
  -d '${body}'`,

    python: `import requests

url = "${url}"
headers = {
    "x-api-key": "${key}",
    "Content-Type": "application/json"
}
payload = ${pyBody}

response = requests.post(url, headers=headers, json=payload)
data = response.json()

print(f"Returned: {data['returned']} of {data['total_available']}")
for job in data["data"]["jobs"]:
    print(job["title"], "-", job["company"])`,

    js: `const response = await fetch("${url}", {
  method: "POST",
  headers: {
    "x-api-key": "${key}",
    "Content-Type": "application/json"
  },
  body: JSON.stringify(${bodyPretty})
});

const result = await response.json();
console.log(\`Returned \${result.returned} of \${result.total_available}\`);
console.log("Jobs:", result.data.jobs);
console.log("Internships:", result.data.internships);`,

    php: `<?php
$ch = curl_init("${url}");
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, [
    "x-api-key: ${key}",
    "Content-Type: application/json"
]);
curl_setopt($ch, CURLOPT_POSTFIELDS, '${body}');

$data = json_decode(curl_exec($ch), true);
curl_close($ch);

echo "Returned: " . $data["returned"] . " of " . $data["total_available"];
?>`
  };
}

/* Paging loop for the range endpoint — the answer to "how do I pull
   everything without holding it all in memory at once". */
function buildPagingSnippet(apiKey) {
  const url = `${originOrFallback()}${EXPORT_ENDPOINTS.range.path}`;
  return `import requests

url = "${url}"
headers = {"x-api-key": "${apiKey || KEY_PLACEHOLDER}"}

start, page_size, all_rows = 0, 2000, []
while True:
    r = requests.post(url, headers=headers,
                      json={"start": start, "end": start + page_size}).json()
    all_rows += r["data"]["jobs"] + r["data"]["internships"]
    if not r["has_more"]:
        break
    start = r["next_start"]

print(f"Pulled {len(all_rows)} listings")`;
}

const SAMPLE_RESPONSE = `{
  "success": true,
  "timestamp": "2026-08-08T13:30:00.000Z",
  "source": "all",
  "mode": "range",
  "window": { "start": 0, "end": 1000 },
  "returned": 1000,
  "total_available": 10083,
  "has_more": true,
  "next_start": 1000,
  "include_sponsored": false,
  "counts": { "jobs": 1000, "internships": 0 },
  "data": {
    "jobs": [
      {
        "job_id": "3208202",
        "title": "Senior Sales Executive",
        "company": "SIMROL INNOVATIVE PRODUCTS PRIVATE LIMITED",
        "location": "Jaipur",
        "url": "https://internshala.com/job/detail/...",
        "logo": "https://internshala.com/static/images/...",

        "stipend": "₹ 4,000 - 15,000 /month",
        "salary": "₹ 2,40,000",
        "annual_ctc": "₹ 2,40,000 /year",
        "salary_detail": "Probation: Duration: ...",

        "description": "Key responsibilities: 1. Visit potential customers ...",
        "company_description": "Simrol innovative products is ...",
        "skills": "Effective Communication Negotiation",
        "perks": "5 days a week Health Insurance",
        "who_can_apply": "Only those candidates can apply who: ...",
        "certifications": "Earn certifications in these skills ...",
        "hiring_activity": "Activity on Internshala Hiring since July 2026 ...",
        "additional_information": "Stipend Structure: Fixed pay: ...",

        "duration": "3 Months",
        "experience": "1 year(s)",
        "openings": "2",
        "start_date": "Immediately",
        "apply_by": "13 Aug' 26",
        "posted": "2 weeks ago",
        "labels": "Be an early applicant",
        "part_time": false,
        "work_from_home": false,
        "actively_hiring": true,

        "ld_company": "SIMROL INNOVATIVE PRODUCTS PRIVATE LIMITED",
        "ld_description": "About the job: ...",
        "ld_employment_type": "FULL_TIME",
        "ld_location": "IN Jaipur Rajasthan",
        "ld_date_posted": "2026-07-14",
        "ld_valid_through": "2026-08-13 23:59:59",
        "ld_salary": "240000",
        "ld_salary_unit": "YEAR",

        "source": "jobs",
        "employment_type": "job",
        "status": "ok",
        "detail_title": "Senior Sales Executive",
        "company_location": "Thane Website",
        "scraped_at": "2026-08-04T00:10:14+05:30",
        "scraper_version": "1.1.0",
        "first_seen_at": "2026-08-03T18:40:19.867Z",
        "updated_at": "2026-08-04T12:12:56.749Z"
      }
    ],
    "internships": [
      // Identical field set, with "source": "internships"
      // and "employment_type": "internship"
    ]
  }
}`;

export default function AdminDashboard({ token, adminUser, onLogout }) {
  const [metrics, setMetrics] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logPage, setLogPage] = useState(1);
  const [totalLogPages, setTotalLogPages] = useState(1);
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeSource, setScrapeSource] = useState('all');
  const [scrapeHours, setScrapeHours] = useState(36);
  const [scrapeMaxPages, setScrapeMaxPages] = useState(0);
  const [scrapeMessage, setScraperMessage] = useState('');
  
  // Data view state
  const [activeTab, setActiveTab] = useState('logs'); // 'logs' | 'data' | 'apikey'
  const [listings, setListings] = useState([]);
  const [totalListings, setTotalListings] = useState(0);
  const [dataSearch, setDataSearch] = useState('');
  const [dataCategory, setDataCategory] = useState('All Categories');
  const [dataSource, setDataSource] = useState('all');
  const [categories, setCategories] = useState([]);
  const [selectedItem, setSelectedItem] = useState(null);
  const [loadingData, setLoadingData] = useState(false);

  // API Key & Docs State
  const [apiKeyInfo, setApiKeyInfo] = useState(null);
  const [showKey, setShowKey] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [copiedSchema, setCopiedSchema] = useState(false);
  const [copiedPaging, setCopiedPaging] = useState(false);
  const [isRegeneratingKey, setIsRegeneratingKey] = useState(false);
  const [activeCodeLang, setActiveCodeLang] = useState('curl');
  const [activeEndpoint, setActiveEndpoint] = useState('range'); // 'range' | 'recent'

  // Fetch Active API Key
  const fetchApiKey = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/api-key', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const json = await res.json();
      if (json.success) {
        setApiKeyInfo(json.apiKey);
      }
    } catch (err) {
      console.error('Error fetching API key:', err);
    }
  }, [token]);

  // Regenerate API Key Handler
  const handleRegenerateKey = async () => {
    if (!window.confirm('⚠️ Are you sure you want to REGENERATE the API key?\n\nThis will permanently revoke the current API key. Only 1 active API key works at a time. Any external application using the current key will immediately fail until updated.')) {
      return;
    }
    setIsRegeneratingKey(true);
    try {
      const res = await fetch('/api/admin/api-key/regenerate', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const json = await res.json();
      if (json.success) {
        setApiKeyInfo(json.apiKey);
        setShowKey(true);
      } else {
        alert('Failed to regenerate key: ' + (json.error || json.message));
      }
    } catch (err) {
      alert('Error regenerating API key');
    } finally {
      setIsRegeneratingKey(false);
    }
  };

  const handleCopyKey = () => {
    if (!apiKeyInfo?.key) return;
    navigator.clipboard.writeText(apiKeyInfo.key);
    setCopiedKey(true);
    setTimeout(() => setCopiedKey(false), 2500);
  };

  const copyText = (text, setFlag) => {
    navigator.clipboard.writeText(text);
    setFlag(true);
    setTimeout(() => setFlag(false), 2500);
  };

  const endpoint = EXPORT_ENDPOINTS[activeEndpoint];
  const endpointUrl = `${originOrFallback()}${endpoint.path}`;
  const snippets = buildSnippets(endpoint, apiKeyInfo?.key);

  // Fetch Categories
  useEffect(() => {
    fetch('/api/jobs/categories')
      .then((res) => res.json())
      .then((json) => {
        if (json.success) setCategories(json.categories);
      })
      .catch(console.error);
  }, []);


  // Fetch Metrics & Scrape Logs
  const fetchAdminData = useCallback(async () => {
    try {
      // Metrics
      const resMetrics = await fetch('/api/admin/scrape-metrics', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const jsonMetrics = await resMetrics.json();
      if (jsonMetrics.success) {
        setMetrics(jsonMetrics.data);
        setIsScraping(jsonMetrics.data.is_running);
      }

      // Logs
      const resLogs = await fetch(`/api/admin/scrape-logs?page=${logPage}&limit=10`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const jsonLogs = await resLogs.json();
      if (jsonLogs.success) {
        setLogs(jsonLogs.logs || []);
        setTotalLogPages(jsonLogs.total_pages || 1);
      }
    } catch (err) {
      console.error('Error fetching admin dashboard data:', err);
    }
  }, [token, logPage]);

  // Fetch Data Listings for Data tab
  const fetchListings = useCallback(async () => {
    setLoadingData(true);
    try {
      const params = new URLSearchParams();
      params.append('source', dataSource);
      if (dataCategory && dataCategory !== 'All Categories') {
        params.append('category', dataCategory);
      }
      if (dataSearch) params.append('search', dataSearch);
      params.append('page', '1');
      params.append('limit', '12');

      const res = await fetch(`/api/jobs/listings?${params.toString()}`);
      const json = await res.json();
      if (json.success) {
        setListings(json.data.items || []);
        setTotalListings(json.data.total || 0);
      }
    } catch (err) {
      console.error('Error fetching listings:', err);
    } finally {
      setLoadingData(false);
    }
  }, [dataSource, dataCategory, dataSearch]);

  useEffect(() => {
    fetchAdminData();
    fetchApiKey();
    const interval = setInterval(fetchAdminData, 4000);
    return () => clearInterval(interval);
  }, [fetchAdminData, fetchApiKey]);

  useEffect(() => {
    if (activeTab === 'data') {
      fetchListings();
    } else if (activeTab === 'apikey') {
      fetchApiKey();
    }
  }, [activeTab, fetchListings, fetchApiKey]);

  // Trigger Manual Scrape
  const handleTriggerScrape = async () => {
    try {
      setIsScraping(true);
      setScraperMessage(`Triggering manual Python scraper for ${scrapeHours ? `last ${scrapeHours} hours` : 'all time'}...`);
      const res = await fetch('/api/admin/scrape/trigger', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          source: scrapeSource,
          recent_hours: parseFloat(scrapeHours),
          max_pages: parseInt(scrapeMaxPages, 10),
          triggered_by: 'admin_manual'
        })
      });
      const json = await res.json();
      if (json.success) {
        setScraperMessage('Scraper successfully started in background!');
        setTimeout(fetchAdminData, 2000);
      } else {
        setScraperMessage(json.message || 'Failed to start scraper');
        setIsScraping(false);
      }
    } catch (err) {
      setScraperMessage('Error starting scraper process');
      setIsScraping(false);
    }
  };

  const formatDate = (dt) => {
    if (!dt) return 'N/A';
    return new Date(dt).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
  };

  return (
    <div className="admin-container">
      {/* Top Admin Header Bar */}
      <div className="admin-header-panel glass-panel">
        <div className="admin-user-info">
          <div className="admin-avatar">
            <ShieldCheck size={24} color="#38bdf8" />
          </div>
          <div>
            <h3 style={{ fontSize: '1.1rem', margin: 0, fontWeight: 700 }}>
              Admin Control Center
            </h3>
            <p style={{ fontSize: '0.85rem', color: '#94a3b8', margin: 0 }}>
              Logged in as: <strong style={{ color: '#e2e8f0' }}>{adminUser?.email || 'vipulphatangare3@gmail.com'}</strong>
            </p>
          </div>
        </div>

        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
          <div className="admin-tab-pills">
            <button
              className={`tab-btn ${activeTab === 'logs' ? 'active' : ''}`}
              onClick={() => setActiveTab('logs')}
            >
              <FileText size={16} /> Scraping Logs & Control
            </button>
            <button
              className={`tab-btn ${activeTab === 'data' ? 'active' : ''}`}
              onClick={() => setActiveTab('data')}
            >
              <Database size={16} /> All Database Data ({totalListings})
            </button>
            <button
              className={`tab-btn ${activeTab === 'apikey' ? 'active' : ''}`}
              onClick={() => setActiveTab('apikey')}
            >
              <Key size={16} /> API Key & Export Docs
            </button>
          </div>

          <button className="btn btn-secondary logout-btn" onClick={onLogout}>
            <LogOut size={16} /> Logout
          </button>
        </div>
      </div>


      {activeTab === 'logs' ? (
        <>
          {/* Today's Metrics & Database Totals Overview Cards */}
          <div className="admin-metrics-grid">
            <div className="metric-card glass-panel">
              <div className="metric-icon" style={{ background: 'rgba(52, 211, 153, 0.15)', color: '#34d399' }}>
                <Briefcase size={24} />
              </div>
              <div className="metric-content">
                <span className="metric-label">Total Jobs in DB</span>
                <span className="metric-value">{(metrics?.jobs_total ?? 0).toLocaleString()}</span>
                <span className="metric-sub">Stored in MongoDB</span>
              </div>
            </div>

            <div className="metric-card glass-panel">
              <div className="metric-icon" style={{ background: 'rgba(168, 85, 247, 0.15)', color: '#c084fc' }}>
                <GraduationCap size={24} />
              </div>
              <div className="metric-content">
                <span className="metric-label">Total Internships in DB</span>
                <span className="metric-value">{(metrics?.internships_total ?? 0).toLocaleString()}</span>
                <span className="metric-sub">Stored in MongoDB</span>
              </div>
            </div>

            <div className="metric-card glass-panel">
              <div className="metric-icon" style={{ background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8' }}>
                <RotateCw size={24} />
              </div>
              <div className="metric-content">
                <span className="metric-label">Today's Scrapes Count</span>
                <span className="metric-value">{metrics?.total_scrapes_today ?? 0}</span>
                <span className="metric-sub">Runs executed today</span>
              </div>
            </div>

            <div className="metric-card glass-panel">
              <div className="metric-icon" style={{ background: 'rgba(52, 211, 153, 0.15)', color: '#34d399' }}>
                <Briefcase size={24} />
              </div>
              <div className="metric-content">
                <span className="metric-label">New Jobs Today</span>
                <span className="metric-value">+{metrics?.new_jobs_added_today ?? 0}</span>
                <span className="metric-sub">Added to MongoDB</span>
              </div>
            </div>

            <div className="metric-card glass-panel">
              <div className="metric-icon" style={{ background: 'rgba(168, 85, 247, 0.15)', color: '#c084fc' }}>
                <GraduationCap size={24} />
              </div>
              <div className="metric-content">
                <span className="metric-label">New Internships Today</span>
                <span className="metric-value">+{metrics?.new_internships_added_today ?? 0}</span>
                <span className="metric-sub">Added to MongoDB</span>
              </div>
            </div>

            <div className="metric-card glass-panel">
              <div
                className="metric-icon"
                style={{
                  background: metrics?.last_scrape?.status === 'success'
                    ? 'rgba(52, 211, 153, 0.15)'
                    : 'rgba(248, 113, 113, 0.15)',
                  color: metrics?.last_scrape?.status === 'success' ? '#34d399' : '#f87171'
                }}
              >
                {metrics?.last_scrape?.status === 'success' ? <CheckCircle2 size={24} /> : <XCircle size={24} />}
              </div>
              <div className="metric-content">
                <span className="metric-label">Last Scrape Status</span>
                <span
                  className={`status-pill ${metrics?.last_scrape?.status || 'idle'}`}
                  style={{ display: 'inline-block', width: 'fit-content', marginTop: '0.2rem' }}
                >
                  {metrics?.last_scrape?.status?.toUpperCase() || 'IDLE'}
                </span>
                <span className="metric-sub">{formatDate(metrics?.last_scrape?.started_at)}</span>
              </div>
            </div>
          </div>

          {/* Manual Scraping Action Panel */}
          <div className="scrape-control-panel glass-panel">
            <div className="control-header">
              <div>
                <h3 style={{ fontSize: '1.2rem', marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <Play size={20} color="#38bdf8" /> Manual Scrape Trigger
                </h3>
                <p style={{ color: '#94a3b8', fontSize: '0.85rem', margin: 0 }}>
                  Initiate a real-time scrape job to extract the latest Internshala listings.
                </p>
              </div>

              {isScraping && (
                <div className="running-indicator">
                  <span className="pulse-dot"></span> Scraper is currently executing...
                </div>
              )}
            </div>

            <div className="scrape-options">
              <div className="option-group">
                <label>Source</label>
                <select
                  value={scrapeSource}
                  onChange={(e) => setScrapeSource(e.target.value)}
                  disabled={isScraping}
                >
                  <option value="all">All (Jobs + Internships)</option>
                  <option value="jobs">Jobs Only</option>
                  <option value="internships">Internships Only</option>
                </select>
              </div>

              <div className="option-group">
                <label>Target Hours Window</label>
                <select
                  value={scrapeHours}
                  onChange={(e) => setScrapeHours(e.target.value)}
                  disabled={isScraping}
                >
                  <option value="12">Last 12 Hours (Quick Refresh)</option>
                  <option value="24">Last 24 Hours (Today's Data)</option>
                  <option value="36">Last 36 Hours (Standard Scope)</option>
                  <option value="48">Last 48 Hours (2 Days)</option>
                  <option value="72">Last 72 Hours (3 Days)</option>
                  <option value="0">All Time (Full Deep Scrape)</option>
                </select>
              </div>

              <div className="option-group">
                <label>Max Pages Per Source</label>
                <select
                  value={scrapeMaxPages}
                  onChange={(e) => setScrapeMaxPages(e.target.value)}
                  disabled={isScraping}
                >
                  <option value="0">Auto / Unlimited</option>
                  <option value="1">1 Page (~40 listings)</option>
                  <option value="2">2 Pages (~80 listings)</option>
                  <option value="5">5 Pages (~200 listings)</option>
                  <option value="10">10 Pages (~400 listings)</option>
                </select>
              </div>

              <button
                className={`btn btn-primary scrape-trigger-btn ${isScraping ? 'disabled' : ''}`}
                onClick={handleTriggerScrape}
                disabled={isScraping}
              >
                {isScraping ? (
                  <>
                    <RotateCw size={18} className="spin" /> Scraping in Progress...
                  </>
                ) : (
                  <>
                    <Play size={18} /> Run Manual Scrape Now
                  </>
                )}
              </button>
            </div>

            {scrapeMessage && (
              <div className="scrape-message-banner">
                <span>{scrapeMessage}</span>
              </div>
            )}
          </div>

          {/* Detailed Scraping Logs Table */}
          <div className="logs-section glass-panel">
            <div className="logs-header">
              <div>
                <h3 style={{ fontSize: '1.15rem', marginBottom: '0.2rem' }}>
                  📋 Scraping Execution History Logs
                </h3>
                <p style={{ fontSize: '0.85rem', color: '#94a3b8', margin: 0 }}>
                  Real-time history of all manual and scheduled scraping runs stored in MongoDB <code>scrape_logs</code> collection.
                </p>
              </div>
              <button className="btn btn-secondary" onClick={fetchAdminData}>
                <RotateCw size={16} /> Refresh Logs
              </button>
            </div>

            {logs.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '3rem', color: '#94a3b8' }}>
                <Clock size={36} style={{ marginBottom: '0.5rem', opacity: 0.5 }} />
                <p>No scraping execution logs recorded yet. Click "Run Manual Scrape Now" to test!</p>
              </div>
            ) : (
              <>
                <div className="table-responsive">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th>Time (Started At)</th>
                        <th>Status</th>
                        <th>Source</th>
                        <th>Already Stored</th>
                        <th>New Added</th>
                        <th>Total Post-Scrape</th>
                        <th>Triggered By</th>
                        <th>Log Message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.map((log) => {
                        const preTotal = (log.pre_jobs_count || 0) + (log.pre_internships_count || 0);
                        const newTotal = log.total_scraped || 0;
                        const postTotal = log.post_jobs_count !== undefined && log.post_internships_count !== undefined
                          ? (log.post_jobs_count + log.post_internships_count)
                          : (preTotal + newTotal);

                        return (
                          <tr key={log._id || log.log_id}>
                            <td>
                              <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                                {formatDate(log.started_at)}
                              </div>
                            </td>
                            <td>
                              <span className={`status-pill ${log.status}`}>
                                {log.status === 'running' && <RotateCw size={12} className="spin" />}
                                {log.status === 'success' && <CheckCircle2 size={12} />}
                                {log.status === 'failed' && <XCircle size={12} />}
                                {log.status}
                              </span>
                            </td>
                            <td>
                              <span className="source-tag">{log.source?.toUpperCase()}</span>
                            </td>
                            <td>
                              <span style={{ color: '#94a3b8', fontWeight: 600 }}>
                                {preTotal.toLocaleString()}
                              </span>
                            </td>
                            <td>
                              <strong style={{ color: '#38bdf8' }}>
                                +{newTotal.toLocaleString()}
                              </strong>
                              <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                                (+{log.new_jobs_added || 0} J / +{log.new_internships_added || 0} I)
                              </div>
                            </td>
                            <td>
                              <strong style={{ color: '#34d399', fontSize: '0.95rem' }}>
                                {postTotal.toLocaleString()}
                              </strong>
                            </td>
                            <td>
                              <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>
                                {log.triggered_by || 'manual'}
                              </span>
                            </td>
                            <td style={{ maxWidth: '280px' }}>
                              <div className="log-msg" title={log.message}>
                                {log.message}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {totalLogPages > 1 && (
                  <div className="pagination" style={{ marginTop: '1rem' }}>
                    <button
                      className="btn btn-secondary"
                      onClick={() => setLogPage((p) => Math.max(1, p - 1))}
                      disabled={logPage === 1}
                    >
                      Previous
                    </button>
                    <span className="page-info">
                      Page {logPage} of {totalLogPages}
                    </span>
                    <button
                      className="btn btn-secondary"
                      onClick={() => setLogPage((p) => Math.min(totalLogPages, p + 1))}
                      disabled={logPage >= totalLogPages}
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </>
      ) : activeTab === 'data' ? (
        /* Data Inspection Tab */

        <div className="admin-data-section glass-panel">
          <div className="data-controls">
            <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap', width: '100%' }}>
              {/* Category Filter */}
              <div className="filter-group">
                <label>Filter Category</label>
                <select
                  value={dataCategory}
                  onChange={(e) => setDataCategory(e.target.value)}
                  className="filter-select"
                >
                  <option value="All Categories">All Categories</option>
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              </div>

              {/* Source Filter */}
              <div className="filter-group">
                <label>Source Type</label>
                <select
                  value={dataSource}
                  onChange={(e) => setDataSource(e.target.value)}
                  className="filter-select"
                >
                  <option value="all">All Sources</option>
                  <option value="jobs">Jobs Only</option>
                  <option value="internships">Internships Only</option>
                </select>
              </div>

              {/* Search Bar */}
              <div className="filter-group" style={{ flex: 1, minWidth: '220px' }}>
                <label>Search MongoDB Data</label>
                <div className="input-with-icon">
                  <Search size={16} className="input-icon" />
                  <input
                    type="text"
                    value={dataSearch}
                    onChange={(e) => setDataSearch(e.target.value)}
                    placeholder="Search by title, company, skills..."
                    className="filter-input"
                  />
                </div>
              </div>
            </div>
          </div>

          <div style={{ marginBottom: '1rem', fontSize: '0.85rem', color: '#94a3b8' }}>
            Found {totalListings} total documents in MongoDB matching selected filters.
          </div>

          {loadingData ? (
            <div className="loader-container">
              <div className="spinner"></div>
              <p>Fetching documents from MongoDB...</p>
            </div>
          ) : listings.length === 0 ? (
            <div style={{ padding: '3rem', textAlign: 'center', color: '#94a3b8' }}>
              <Layers size={36} style={{ marginBottom: '0.5rem' }} />
              <p>No listings matched your criteria in MongoDB.</p>
            </div>
          ) : (
            <div className="cards-grid">
              {listings.map((item) => (
                <ListingCard
                  key={`${item.source}-${item.job_id}`}
                  item={item}
                  onClick={setSelectedItem}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        /* API Key & Integration Docs Tab */
        <div className="api-key-section">
          {/* API Key Management Box */}
          <div className="api-key-box glass-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: '1rem' }}>
              <div>
                <h3 style={{ fontSize: '1.25rem', marginBottom: '0.3rem', display: 'flex', alignItems: 'center', gap: '0.6rem', color: '#f8fafc' }}>
                  <Key size={22} color="#38bdf8" /> API Key Authentication Management
                </h3>
                <p style={{ color: '#94a3b8', fontSize: '0.875rem', margin: 0, maxWidth: '720px' }}>
                  Manage the single active system API key used to export all jobs and internships data into JSON format for external platforms and services.
                </p>
              </div>
              <span className="status-pill success" style={{ padding: '0.35rem 0.8rem', fontSize: '0.8rem' }}>
                <CheckCircle2 size={14} /> Single Key Enforced
              </span>
            </div>

            <div style={{ marginTop: '1.5rem', background: 'rgba(15, 23, 42, 0.5)', padding: '1.25rem', borderRadius: '12px', border: '1px solid rgba(255, 255, 255, 0.08)' }}>
              <label style={{ fontSize: '0.75rem', color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: '0.5rem' }}>
                Active System API Key
              </label>
              
              <div className="api-key-display">
                <div className="api-key-input-wrapper">
                  <input
                    type={showKey ? 'text' : 'password'}
                    readOnly
                    value={apiKeyInfo?.key || 'Fetching API Key...'}
                    className="api-key-input"
                  />
                  <button
                    type="button"
                    className="key-toggle-btn"
                    onClick={() => setShowKey(!showKey)}
                    title={showKey ? 'Hide API Key' : 'Show API Key'}
                  >
                    {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>

                <button
                  className="btn btn-secondary"
                  onClick={handleCopyKey}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.75rem 1.25rem' }}
                >
                  {copiedKey ? <Check size={18} color="#34d399" /> : <Copy size={18} />}
                  {copiedKey ? 'Copied!' : 'Copy Key'}
                </button>

                <button
                  className="btn"
                  onClick={handleRegenerateKey}
                  disabled={isRegeneratingKey}
                  style={{
                    background: 'rgba(239, 68, 68, 0.15)',
                    border: '1px solid rgba(239, 68, 68, 0.3)',
                    color: '#f87171',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5rem',
                    padding: '0.75rem 1.25rem',
                    fontWeight: 600
                  }}
                >
                  {isRegeneratingKey ? <RotateCw size={18} className="spin" /> : <RefreshCw size={18} />}
                  {isRegeneratingKey ? 'Regenerating...' : 'Regenerate API Key'}
                </button>
              </div>

              <div className="key-meta-grid">
                <div className="key-meta-item">
                  <span style={{ color: '#64748b' }}>Status:</span>
                  <strong style={{ color: '#34d399' }}>{apiKeyInfo?.status?.toUpperCase() || 'ACTIVE'}</strong>
                </div>
                <div className="key-meta-item">
                  <span style={{ color: '#64748b' }}>Created:</span>
                  <strong style={{ color: '#e2e8f0' }}>{formatDate(apiKeyInfo?.created_at)}</strong>
                </div>
                <div className="key-meta-item">
                  <span style={{ color: '#64748b' }}>Last Used:</span>
                  <strong style={{ color: '#e2e8f0' }}>{formatDate(apiKeyInfo?.last_used_at)}</strong>
                </div>
              </div>
            </div>

            <div style={{ marginTop: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.825rem', color: '#fbbf24', background: 'rgba(251, 191, 36, 0.08)', padding: '0.75rem 1rem', borderRadius: '8px', border: '1px solid rgba(251, 191, 36, 0.2)' }}>
              <AlertTriangle size={16} style={{ flexShrink: 0 }} />
              <span>
                <strong>Key Rotation Security Note:</strong> Only one API key can be active at a time. Click "Regenerate API Key" to revoke the old key and issue a brand new key immediately.
              </span>
            </div>
          </div>

          {/* Documentation & Integration Box */}
          <div className="api-key-box glass-panel">
            <h3 style={{ fontSize: '1.25rem', marginBottom: '0.3rem', display: 'flex', alignItems: 'center', gap: '0.6rem', color: '#f8fafc' }}>
              <Code size={22} color="#38bdf8" /> Data Export Endpoint Documentation
            </h3>
            <p style={{ color: '#94a3b8', fontSize: '0.875rem', marginBottom: '1.25rem' }}>
              Use this endpoint to export all jobs and internships from MongoDB in raw JSON format to feed into external dashboards, mobile apps, or analytics engines.
            </p>

            <div className="endpoint-switch">
              {Object.values(EXPORT_ENDPOINTS).map((ep) => (
                <button
                  key={ep.id}
                  className={`endpoint-switch-btn ${activeEndpoint === ep.id ? 'active' : ''}`}
                  onClick={() => setActiveEndpoint(ep.id)}
                >
                  <strong>{ep.label}</strong>
                  <span>{ep.tagline}</span>
                </button>
              ))}
            </div>

            <div className="endpoint-banner">
              <div style={{ minWidth: 0 }}>
                <span style={{ fontSize: '0.75rem', textTransform: 'uppercase', color: '#94a3b8', fontWeight: 700, display: 'block', marginBottom: '0.2rem' }}>
                  Target POST URL (No Limit / Sends All Data)
                </span>
                <code className="endpoint-url">
                  POST {endpointUrl}
                </code>
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
                <span className="source-tag" style={{ background: 'rgba(56, 189, 248, 0.15)', color: '#38bdf8' }}>
                  HTTP POST / GET
                </span>
                <span className="source-tag" style={{ background: 'rgba(52, 211, 153, 0.15)', color: '#34d399' }}>
                  JSON Format
                </span>
                <button
                  className="inline-copy-btn"
                  onClick={() => copyText(endpointUrl, setCopiedUrl)}
                  title="Copy endpoint URL"
                >
                  {copiedUrl ? <Check size={14} color="#34d399" /> : <Copy size={14} />}
                  {copiedUrl ? 'Copied!' : 'Copy URL'}
                </button>
              </div>
            </div>

            <p style={{ color: '#94a3b8', fontSize: '0.85rem', lineHeight: 1.65, marginTop: '1rem' }}>
              {endpoint.summary}
            </p>

            <div style={{ marginTop: '1.25rem' }}>
              <h4 style={{ fontSize: '0.95rem', color: '#e2e8f0', marginBottom: '0.6rem', fontWeight: 700 }}>
                Request Body Parameters
              </h4>
              <div className="param-table-wrap">
                <table className="param-table">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Type</th>
                      <th>Default</th>
                      <th>Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {endpoint.params.map(([name, type, def, desc]) => (
                      <tr key={name}>
                        <td><code>{name}</code></td>
                        <td>{type}</td>
                        <td><code>{def}</code></td>
                        <td>{desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p style={{ color: '#64748b', fontSize: '0.8rem', marginTop: '0.6rem' }}>
                Authenticate with the <code style={{ color: '#38bdf8' }}>x-api-key</code> header. Only the single active key above is accepted &mdash; regenerating immediately revokes the previous one.
              </p>
            </div>

            {/* Code Snippets Section */}
            <div style={{ marginTop: '1.5rem' }}>
              <div className="code-tabs">
                <button
                  className={`code-tab-btn ${activeCodeLang === 'curl' ? 'active' : ''}`}
                  onClick={() => setActiveCodeLang('curl')}
                >
                  <Terminal size={14} style={{ display: 'inline', marginRight: '0.4rem' }} /> cURL
                </button>
                <button
                  className={`code-tab-btn ${activeCodeLang === 'python' ? 'active' : ''}`}
                  onClick={() => setActiveCodeLang('python')}
                >
                  Python (requests)
                </button>
                <button
                  className={`code-tab-btn ${activeCodeLang === 'js' ? 'active' : ''}`}
                  onClick={() => setActiveCodeLang('js')}
                >
                  JavaScript / Node.js
                </button>
                <button
                  className={`code-tab-btn ${activeCodeLang === 'php' ? 'active' : ''}`}
                  onClick={() => setActiveCodeLang('php')}
                >
                  PHP (cURL)
                </button>
              </div>

              <div className="code-block-container">
                <button
                  className="code-copy-btn"
                  onClick={() => copyText(snippets[activeCodeLang], setCopiedSnippet)}
                >
                  {copiedSnippet ? <Check size={14} color="#34d399" /> : <Copy size={14} />}
                  {copiedSnippet ? 'Copied Snippet!' : 'Copy Code'}
                </button>

                <pre className="code-block">
                  {snippets[activeCodeLang]}
                </pre>
              </div>
            </div>

            {activeEndpoint === 'range' && (
              <div style={{ marginTop: '1.5rem' }}>
                <h4 style={{ fontSize: '0.95rem', color: '#e2e8f0', marginBottom: '0.5rem', fontWeight: 700 }}>
                  Pulling Everything In Pages
                </h4>
                <p style={{ color: '#94a3b8', fontSize: '0.85rem', marginBottom: '0.75rem', lineHeight: 1.6 }}>
                  Follow <code style={{ color: '#38bdf8' }}>next_start</code> until <code style={{ color: '#38bdf8' }}>has_more</code> is false. Rows are ordered stably, so no listing is ever skipped or repeated between pages.
                </p>
                <div className="code-block-container">
                  <button
                    className="code-copy-btn"
                    onClick={() => copyText(buildPagingSnippet(apiKeyInfo?.key), setCopiedPaging)}
                  >
                    {copiedPaging ? <Check size={14} color="#34d399" /> : <Copy size={14} />}
                    {copiedPaging ? 'Copied!' : 'Copy Code'}
                  </button>
                  <pre className="code-block">{buildPagingSnippet(apiKeyInfo?.key)}</pre>
                </div>
              </div>
            )}

            {/* Expected JSON Structure */}
            <div style={{ marginTop: '1.5rem' }}>
              <h4 style={{ fontSize: '0.95rem', color: '#e2e8f0', marginBottom: '0.4rem', fontWeight: 700 }}>
                Sample JSON Response Schema
              </h4>
              <p style={{ color: '#94a3b8', fontSize: '0.85rem', marginBottom: '0.75rem', lineHeight: 1.6 }}>
                Every field below is returned except <code style={{ color: '#38bdf8' }}>_id</code>, <code style={{ color: '#38bdf8' }}>ld_json</code> and <code style={{ color: '#38bdf8' }}>sections_json</code>. Detail fields such as <code style={{ color: '#38bdf8' }}>description</code> are absent on listings whose detail page was never scraped, so check before use. Numbers arrive as strings.
              </p>
              <div className="code-block-container" style={{ background: '#070a12' }}>
                <button
                  className="code-copy-btn"
                  onClick={() => copyText(SAMPLE_RESPONSE, setCopiedSchema)}
                >
                  {copiedSchema ? <Check size={14} color="#34d399" /> : <Copy size={14} />}
                  {copiedSchema ? 'Copied Schema!' : 'Copy Schema'}
                </button>
                <pre className="code-block" style={{ color: '#38bdf8' }}>
                  {SAMPLE_RESPONSE}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}


      {selectedItem && (
        <DetailModal item={selectedItem} onClose={() => setSelectedItem(null)} />
      )}
    </div>
  );
}
