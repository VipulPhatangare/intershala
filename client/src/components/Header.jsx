import React from 'react';
import { Zap, Globe, ShieldCheck } from 'lucide-react';

export default function Header({ viewMode, setViewMode, isAdminLoggedIn, adminUser }) {
  return (
    <header className="glass-panel header-bar">
      <div className="brand">
        <div className="brand-icon">
          <Zap size={26} />
        </div>
        <div className="brand-text">
          <h1>Internshala Job Hub & Scraper</h1>
          <p>Real-Time MongoDB Listings • Category Filters • Admin Scraping Control</p>
        </div>
      </div>

      <div className="header-view-switcher">
        <button
          className={`view-pill ${viewMode === 'public' ? 'active' : ''}`}
          onClick={() => setViewMode('public')}
        >
          <Globe size={16} /> Jobs & Internships View
        </button>

        <button
          className={`view-pill ${viewMode === 'admin' ? 'active' : ''}`}
          onClick={() => setViewMode('admin')}
        >
          <ShieldCheck size={16} /> Admin Portal
          {isAdminLoggedIn && <span className="active-dot" title="Logged In"></span>}
        </button>
      </div>
    </header>
  );
}
