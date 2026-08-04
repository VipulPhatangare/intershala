import React, { useEffect, useState } from 'react';
import { X, Building2, MapPin, DollarSign, Calendar, Clock, ExternalLink, CheckCircle } from 'lucide-react';

export default function DetailModal({ item, onClose }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!item) return;
    setLoading(true);
    fetch(`/api/listing/${item.source || 'jobs'}/${item.job_id}`)
      .then((res) => res.json())
      .then((resData) => {
        if (resData.success) {
          setDetail(resData.data);
        } else {
          setDetail(item);
        }
      })
      .catch(() => setDetail(item))
      .finally(() => setLoading(false));
  }, [item]);

  if (!item) return null;

  const data = detail || item;
  const url = data.url || data.link || `https://internshala.com/${data.source || 'internship'}/detail/${data.job_id}`;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="glass-panel modal-content" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" onClick={onClose}>
          <X size={20} />
        </button>

        {loading ? (
          <div className="loader-container">
            <div className="spinner"></div>
            <p>Fetching job details from MongoDB...</p>
          </div>
        ) : (
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
              <span className={`source-badge ${data.source === 'jobs' ? 'jobs' : 'internships'}`}>
                {data.source === 'jobs' ? 'Job' : 'Internship'}
              </span>
              <span style={{ fontSize: '0.8rem', color: '#94a3b8' }}>ID: {data.job_id}</span>
            </div>

            <h2 style={{ fontSize: '1.5rem', fontWeight: 800, marginBottom: '0.25rem' }}>{data.title}</h2>
            <div className="card-company" style={{ fontSize: '1.05rem', marginBottom: '1.5rem' }}>
              <Building2 size={18} color="#94a3b8" />
              <span>{data.company}</span>
            </div>

            <div className="card-details-grid" style={{ background: 'rgba(0,0,0,0.2)', padding: '1rem', borderRadius: '12px', marginBottom: '1.5rem' }}>
              <div className="detail-item">
                <MapPin size={16} />
                <span><strong>Location:</strong> {data.location || 'N/A'}</span>
              </div>
              <div className="detail-item">
                <DollarSign size={16} />
                <span><strong>Stipend / Salary:</strong> {data.stipend || data.salary || data.ctc || 'N/A'}</span>
              </div>
              <div className="detail-item">
                <Clock size={16} />
                <span><strong>Duration / Type:</strong> {data.duration || 'Full Time'}</span>
              </div>
              <div className="detail-item">
                <Calendar size={16} />
                <span><strong>Apply By:</strong> {data.apply_by || data.posted_date || 'N/A'}</span>
              </div>
            </div>

            {data.description && (
              <div style={{ marginBottom: '1.5rem' }}>
                <h4 style={{ fontSize: '1rem', color: '#f8fafc', marginBottom: '0.5rem' }}>About the Role</h4>
                <p style={{ fontSize: '0.9rem', color: '#cbd5e1', whiteSpace: 'pre-line', lineHeight: '1.6' }}>
                  {data.description}
                </p>
              </div>
            )}

            {data.responsibilities && (
              <div style={{ marginBottom: '1.5rem' }}>
                <h4 style={{ fontSize: '1rem', color: '#f8fafc', marginBottom: '0.5rem' }}>Day-to-day Responsibilities</h4>
                <p style={{ fontSize: '0.9rem', color: '#cbd5e1', whiteSpace: 'pre-line', lineHeight: '1.6' }}>
                  {data.responsibilities}
                </p>
              </div>
            )}

            {data.who_can_apply && (
              <div style={{ marginBottom: '1.5rem' }}>
                <h4 style={{ fontSize: '1rem', color: '#f8fafc', marginBottom: '0.5rem' }}>Who Can Apply</h4>
                <p style={{ fontSize: '0.9rem', color: '#cbd5e1', whiteSpace: 'pre-line', lineHeight: '1.6' }}>
                  {data.who_can_apply}
                </p>
              </div>
            )}

            {data.perks && (
              <div style={{ marginBottom: '1.5rem' }}>
                <h4 style={{ fontSize: '1rem', color: '#f8fafc', marginBottom: '0.5rem' }}>Perks</h4>
                <p style={{ fontSize: '0.9rem', color: '#cbd5e1' }}>
                  {Array.isArray(data.perks) ? data.perks.join(', ') : data.perks}
                </p>
              </div>
            )}

            <div style={{ display: 'flex', gap: '1rem', marginTop: '2rem' }}>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
                style={{ textDecoration: 'none' }}
              >
                Apply on Internshala <ExternalLink size={16} />
              </a>
              <button className="btn btn-secondary" onClick={onClose}>
                Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
