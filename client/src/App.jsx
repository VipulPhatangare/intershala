import React, { useState, useEffect, useCallback } from 'react';
import Header from './components/Header';
import StatCards from './components/StatCards';
import FilterBar from './components/FilterBar';
import ListingCard from './components/ListingCard';
import DetailModal from './components/DetailModal';
import { ChevronLeft, ChevronRight, FolderOpen } from 'lucide-react';

export default function App() {
  const [stats, setStats] = useState(null);
  const [source, setSource] = useState('all');
  const [search, setSearch] = useState('');
  const [location, setLocation] = useState('');
  const [recentOnly, setRecentOnly] = useState(false);
  const [wfhOnly, setWfhOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [listingsData, setListingsData] = useState({ items: [], total: 0, total_pages: 1 });
  const [loading, setLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState(null);
  const [isScraping, setIsScraping] = useState(false);
  const [scraperMessage, setScraperMessage] = useState('');

  // Fetch Dashboard Stats
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/stats');
      const json = await res.json();
      if (json.success) {
        setStats(json.data);
        setIsScraping(json.data.scraper_active);
      }
    } catch (err) {
      console.error('Error fetching stats:', err);
    }
  }, []);

  // Fetch Listings with Filters
  const fetchListings = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('source', source);
      if (search) params.append('search', search);
      if (location) params.append('location', location);
      if (recentOnly) params.append('recent_hours', '36');
      if (wfhOnly) params.append('wfh', 'true');
      params.append('page', page.toString());
      params.append('limit', '18');

      const res = await fetch(`/api/listings?${params.toString()}`);
      const json = await res.json();
      if (json.success) {
        setListingsData(json.data);
      }
    } catch (err) {
      console.error('Error fetching listings:', err);
    } finally {
      setLoading(false);
    }
  }, [source, search, location, recentOnly, wfhOnly, page]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    setPage(1);
  }, [source, search, location, recentOnly, wfhOnly]);

  useEffect(() => {
    fetchListings();
  }, [fetchListings]);

  // Handle Trigger Scrape
  const handleTriggerScrape = async () => {
    try {
      setIsScraping(true);
      setScraperMessage('Starting Python Scraper...');
      const res = await fetch('/api/scrape/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: source === 'all' ? 'all' : source, max_pages: 2 }),
      });
      const json = await res.json();
      setScraperMessage(json.message || 'Scraper triggered successfully!');
      setTimeout(fetchStats, 3000);
    } catch (err) {
      setScraperMessage('Failed to trigger scraper.');
      setIsScraping(false);
    }
  };

  return (
    <div className="app-container">
      <Header
        onTriggerScrape={handleTriggerScrape}
        isScraping={isScraping}
        scraperMessage={scraperMessage}
      />

      <StatCards stats={stats} />

      <FilterBar
        source={source}
        setSource={setSource}
        search={search}
        setSearch={setSearch}
        location={location}
        setLocation={setLocation}
        recentOnly={recentOnly}
        setRecentOnly={setRecentOnly}
        wfhOnly={wfhOnly}
        setWfhOnly={setWfhOnly}
      />

      <main>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <span style={{ fontSize: '0.9rem', color: '#94a3b8', fontWeight: 600 }}>
            Showing {listingsData.items.length} of {listingsData.total} listings
          </span>
        </div>

        {loading ? (
          <div className="loader-container">
            <div className="spinner"></div>
            <p>Loading listings from MongoDB database...</p>
          </div>
        ) : listingsData.items.length === 0 ? (
          <div className="glass-panel" style={{ textAlign: 'center', padding: '4rem 2rem' }}>
            <FolderOpen size={48} color="#64748b" style={{ marginBottom: '1rem' }} />
            <h3 style={{ fontSize: '1.25rem', marginBottom: '0.5rem' }}>No matching listings found</h3>
            <p style={{ color: '#94a3b8', fontSize: '0.9rem', marginBottom: '1.5rem' }}>
              Try adjusting your search criteria or triggering a Python scrape to update MongoDB.
            </p>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setSearch('');
                setLocation('');
                setRecentOnly(false);
                setWfhOnly(false);
                setSource('all');
              }}
            >
              Reset All Filters
            </button>
          </div>
        ) : (
          <>
            <div className="cards-grid">
              {listingsData.items.map((item) => (
                <ListingCard
                  key={`${item.source}-${item.job_id}`}
                  item={item}
                  onClick={setSelectedItem}
                />
              ))}
            </div>

            {listingsData.total_pages > 1 && (
              <div className="pagination">
                <button
                  className="btn btn-secondary"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                >
                  <ChevronLeft size={18} /> Previous
                </button>

                <span className="page-info">
                  Page {page} of {listingsData.total_pages}
                </span>

                <button
                  className="btn btn-secondary"
                  onClick={() => setPage((p) => Math.min(listingsData.total_pages, p + 1))}
                  disabled={page >= listingsData.total_pages}
                >
                  Next <ChevronRight size={18} />
                </button>
              </div>
            )}
          </>
        )}
      </main>

      {selectedItem && (
        <DetailModal
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </div>
  );
}
