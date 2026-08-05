import React from 'react';
import { Layers, Briefcase, GraduationCap, Zap, Home, Search, MapPin, Tag } from 'lucide-react';

export default function FilterBar({
  source,
  setSource,
  category,
  setCategory,
  categories = [],
  search,
  setSearch,
  location,
  setLocation,
  recentOnly,
  setRecentOnly,
  wfhOnly,
  setWfhOnly,
}) {
  return (
    <section className="glass-panel filter-panel">
      <div className="tabs-row">
        <button
          className={`tab-btn ${source === 'all' ? 'active' : ''}`}
          onClick={() => setSource('all')}
        >
          <Layers size={16} /> All Listings
        </button>
        <button
          className={`tab-btn ${source === 'jobs' ? 'active' : ''}`}
          onClick={() => setSource('jobs')}
        >
          <Briefcase size={16} /> Jobs
        </button>
        <button
          className={`tab-btn ${source === 'internships' ? 'active' : ''}`}
          onClick={() => setSource('internships')}
        >
          <GraduationCap size={16} /> Internships
        </button>
      </div>

      <div className="controls-row">
        <button
          className={`chip-btn ${recentOnly ? 'active' : ''}`}
          onClick={() => setRecentOnly(!recentOnly)}
        >
          <Zap size={15} /> Last 36 Hours
        </button>

        <button
          className={`chip-btn ${wfhOnly ? 'active' : ''}`}
          onClick={() => setWfhOnly(!wfhOnly)}
        >
          <Home size={15} /> Work From Home
        </button>

        <div className="category-select-wrap">
          <Tag className="input-icon" size={16} />
          <select
            className="category-dropdown"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="All Categories">All Categories</option>
            {categories.map((cat) => (
              <option key={cat} value={cat}>
                {cat}
              </option>
            ))}
          </select>
        </div>

        <div className="search-input-wrap">
          <Search className="input-icon" size={16} />
          <input
            type="text"
            placeholder="Search roles, companies, or skills (e.g. Python, React)..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="location-input-wrap">
          <MapPin className="input-icon" size={16} />
          <input
            type="text"
            placeholder="Filter location (e.g. Delhi, Remote)..."
            value={location}
            onChange={(e) => setLocation(e.target.value)}
          />
        </div>
      </div>
    </section>
  );
}
