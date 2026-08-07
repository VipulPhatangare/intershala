import React from 'react';
import { Building2, MapPin, DollarSign, Calendar, Clock, ExternalLink } from 'lucide-react';

export default function ListingCard({ item, onClick }) {
  const isJob = item.source === 'jobs';
  const pay = item.stipend || item.salary || item.ctc || 'Not specified';
  const location = item.location || 'Work From Home / Remote';
  const duration = item.duration || 'Full Time';
  const applyBy = item.apply_by || item.posted_date || 'N/A';
  const skillsList = Array.isArray(item.skills) 
    ? item.skills 
    : (item.skills ? String(item.skills).split(',').map(s => s.trim()) : []);

  return (
    <div className="listing-card" onClick={() => onClick(item)}>
      <div>
        <div className="card-top">
          <span className={`source-badge ${isJob ? 'jobs' : 'internships'}`}>
            {isJob ? 'Job' : 'Internship'}
          </span>
          {item.status === 'external' && (
            <span className="sponsored-badge">Sponsored</span>
          )}
          {item.is_36h_new && (
            <span style={{ fontSize: '0.7rem', color: '#06b6d4', fontWeight: 700, background: 'rgba(6, 182, 212, 0.1)', padding: '0.2rem 0.5rem', borderRadius: '4px' }}>
              ⚡ Recent
            </span>
          )}
        </div>

        <h3 className="card-title">{item.title || 'Untitled Listing'}</h3>
        
        <div className="card-company">
          <Building2 size={15} color="#94a3b8" />
          <span>{item.company || 'Company confidential'}</span>
        </div>

        <div className="card-details-grid">
          <div className="detail-item">
            <MapPin size={14} />
            <span>{location}</span>
          </div>
          <div className="detail-item">
            <DollarSign size={14} />
            <span>{pay}</span>
          </div>
          <div className="detail-item">
            <Clock size={14} />
            <span>{duration}</span>
          </div>
          <div className="detail-item">
            <Calendar size={14} />
            <span>Apply by: {applyBy}</span>
          </div>
        </div>

        {skillsList.length > 0 && (
          <div className="skills-row">
            {skillsList.slice(0, 4).map((skill, idx) => (
              <span key={idx} className="skill-tag">{skill}</span>
            ))}
            {skillsList.length > 4 && (
              <span className="skill-tag">+{skillsList.length - 4} more</span>
            )}
          </div>
        )}
      </div>

      <div className="card-footer">
        <span className="post-date">ID: {item.job_id}</span>
        <button
          className="btn btn-secondary"
          style={{ padding: '0.35rem 0.75rem', fontSize: '0.8rem' }}
        >
          View Details <ExternalLink size={13} />
        </button>
      </div>
    </div>
  );
}
