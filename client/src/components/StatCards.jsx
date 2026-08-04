import React from 'react';
import { Briefcase, GraduationCap, Clock, Bot } from 'lucide-react';

export default function StatCards({ stats }) {
  const jobsTotal = stats?.jobs_total ?? 0;
  const internshipsTotal = stats?.internships_total ?? 0;
  const recent36h = stats?.recent_36h_total ?? 0;
  const scraperActive = stats?.scraper_active ?? false;

  return (
    <section className="stats-grid">
      <div className="glass-panel stat-card">
        <div className="stat-icon-wrapper" style={{ background: 'rgba(16, 185, 129, 0.15)', color: '#10b981' }}>
          <Briefcase size={26} />
        </div>
        <div className="stat-info">
          <span className="stat-label">Total Jobs</span>
          <span className="stat-value" style={{ color: '#10b981' }}>{jobsTotal}</span>
        </div>
      </div>

      <div className="glass-panel stat-card">
        <div className="stat-icon-wrapper" style={{ background: 'rgba(99, 102, 241, 0.15)', color: '#818cf8' }}>
          <GraduationCap size={26} />
        </div>
        <div className="stat-info">
          <span className="stat-label">Total Internships</span>
          <span className="stat-value" style={{ color: '#818cf8' }}>{internshipsTotal}</span>
        </div>
      </div>

      <div className="glass-panel stat-card" style={{ border: '1px solid rgba(6, 182, 212, 0.3)' }}>
        <div className="stat-icon-wrapper" style={{ background: 'rgba(6, 182, 212, 0.15)', color: '#06b6d4' }}>
          <Clock size={26} />
        </div>
        <div className="stat-info">
          <span className="stat-label">Last 36 Hours</span>
          <span className="stat-value" style={{ color: '#06b6d4' }}>{recent36h}</span>
        </div>
      </div>

      <div className="glass-panel stat-card">
        <div className="stat-icon-wrapper" style={{ background: 'rgba(245, 158, 11, 0.15)', color: '#f59e0b' }}>
          <Bot size={26} />
        </div>
        <div className="stat-info">
          <span className="stat-label">Python Scraper Engine</span>
          <span className="stat-value" style={{ fontSize: '1.1rem', color: scraperActive ? '#06b6d4' : '#f59e0b', marginTop: '0.4rem' }}>
            {scraperActive ? 'Scraping...' : 'Ready'}
          </span>
        </div>
      </div>
    </section>
  );
}
