import React from 'react';
import { Zap, RefreshCw, Layers } from 'lucide-react';

export default function Header({ onTriggerScrape, isScraping, scraperMessage }) {
  return (
    <header className="glass-panel header-bar">
      <div className="brand">
        <div className="brand-icon">
          <Zap size={26} />
        </div>
        <div className="brand-text">
          <h1>Internshala MERN & Python Live Hub</h1>
          <p>MongoDB Query Engine • React UI • Python Fast Scraper Subprocess</p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
        {scraperMessage && (
          <span style={{ fontSize: '0.8rem', color: isScraping ? '#38bdf8' : '#10b981', fontWeight: 600 }}>
            {scraperMessage}
          </span>
        )}
        <button
          className="btn btn-primary"
          onClick={onTriggerScrape}
          disabled={isScraping}
        >
          <RefreshCw className={isScraping ? 'spinner' : ''} size={18} />
          {isScraping ? 'Scraping in progress...' : 'Trigger Scrape Now'}
        </button>
      </div>
    </header>
  );
}
