import React, { useState, useEffect, useCallback } from 'react';
import Header from './components/Header';
import StatCards from './components/StatCards';
import FilterBar from './components/FilterBar';
import ListingCard from './components/ListingCard';
import DetailModal from './components/DetailModal';
import AdminLogin from './components/AdminLogin';
import AdminDashboard from './components/AdminDashboard';
import { ChevronLeft, ChevronRight, FolderOpen } from 'lucide-react';

export default function App() {
  const [viewMode, setViewMode] = useState('public'); // 'public' | 'admin'
  
  // Admin Auth State
  const [adminToken, setAdminToken] = useState(() => localStorage.getItem('adminToken') || '');
  const [adminUser, setAdminUser] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('adminUser')) || null;
    } catch (e) {
      return null;
    }
  });

  // Public View State
  const [stats, setStats] = useState(null);
  const [source, setSource] = useState('all');
  const [category, setCategory] = useState('All Categories');
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [location, setLocation] = useState('');
  const [recentOnly, setRecentOnly] = useState(false);
  const [wfhOnly, setWfhOnly] = useState(false);
  const [hideSponsored, setHideSponsored] = useState(false);
  const [page, setPage] = useState(1);
  const [listingsData, setListingsData] = useState({ items: [], total: 0, total_pages: 1 });
  const [loading, setLoading] = useState(true);
  const [selectedItem, setSelectedItem] = useState(null);

  // Verify stored admin token on boot
  useEffect(() => {
    if (adminToken) {
      fetch('/api/admin/verify', {
        headers: { Authorization: `Bearer ${adminToken}` }
      })
        .then((res) => res.json())
        .then((json) => {
          if (!json.success) {
            handleLogout();
          } else {
            setAdminUser(json.user);
          }
        })
        .catch(() => handleLogout());
    }
  }, [adminToken]);

  // Fetch Categories
  useEffect(() => {
    fetch('/api/jobs/categories')
      .then((res) => res.json())
      .then((json) => {
        if (json.success) setCategories(json.categories);
      })
      .catch(console.error);
  }, []);

  // Fetch Dashboard Stats
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch('/api/jobs/stats');
      const json = await res.json();
      if (json.success) {
        setStats(json.data);
      }
    } catch (err) {
      console.error('Error fetching stats:', err);
    }
  }, []);

  // Fetch Listings with Category & Search Filters
  const fetchListings = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.append('source', source);
      if (category && category !== 'All Categories') params.append('category', category);
      if (search) params.append('search', search);
      if (location) params.append('location', location);
      if (recentOnly) params.append('recent_hours', '36');
      if (wfhOnly) params.append('wfh', 'true');
      if (hideSponsored) params.append('hide_sponsored', 'true');
      params.append('page', page.toString());
      params.append('limit', '18');

      const res = await fetch(`/api/jobs/listings?${params.toString()}`);
      const json = await res.json();
      if (json.success) {
        setListingsData(json.data);
      }
    } catch (err) {
      console.error('Error fetching listings:', err);
    } finally {
      setLoading(false);
    }
  }, [source, category, search, location, recentOnly, wfhOnly, hideSponsored, page]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    setPage(1);
  }, [source, category, search, location, recentOnly, wfhOnly, hideSponsored]);

  useEffect(() => {
    if (viewMode === 'public') {
      fetchListings();
    }
  }, [viewMode, fetchListings]);

  const handleLoginSuccess = (token, user) => {
    setAdminToken(token);
    setAdminUser(user);
  };

  const handleLogout = () => {
    localStorage.removeItem('adminToken');
    localStorage.removeItem('adminUser');
    setAdminToken('');
    setAdminUser(null);
  };

  return (
    <div className="app-container">
      <Header
        viewMode={viewMode}
        setViewMode={setViewMode}
        isAdminLoggedIn={!!adminToken}
        adminUser={adminUser}
      />

      {viewMode === 'public' ? (
        <>
          <StatCards stats={stats} />

          <FilterBar
            source={source}
            setSource={setSource}
            category={category}
            setCategory={setCategory}
            categories={categories}
            search={search}
            setSearch={setSearch}
            location={location}
            setLocation={setLocation}
            recentOnly={recentOnly}
            setRecentOnly={setRecentOnly}
            wfhOnly={wfhOnly}
            hideSponsored={hideSponsored}
            setHideSponsored={setHideSponsored}
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
                  Try adjusting your search criteria or category filter.
                </p>
                <button
                  className="btn btn-secondary"
                  onClick={() => {
                    setSearch('');
                    setLocation('');
                    setCategory('All Categories');
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
        </>
      ) : (
        /* Admin View Mode */
        adminToken ? (
          <AdminDashboard
            token={adminToken}
            adminUser={adminUser}
            onLogout={handleLogout}
          />
        ) : (
          <AdminLogin onLoginSuccess={handleLoginSuccess} />
        )
      )}
    </div>
  );
}
