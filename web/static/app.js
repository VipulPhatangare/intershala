// App State Management
const state = {
  source: 'all',
  search: '',
  location: '',
  recent36h: false,
  onlyWFH: false,
  page: 1,
  limit: 18,
  totalPages: 1
};

// DOM Elements
const DOM = {
  statJobs: document.getElementById('statJobs'),
  statInternships: document.getElementById('statInternships'),
  statRecent: document.getElementById('statRecent'),
  statScheduler: document.getElementById('statScheduler'),
  tabBtns: document.querySelectorAll('.tab-btn'),
  toggle36hBtn: document.getElementById('toggle36h'),
  toggleWFHBtn: document.getElementById('toggleWFH'),
  searchInput: document.getElementById('searchInput'),
  locationInput: document.getElementById('locationInput'),
  clearSearchBtn: document.getElementById('clearSearch'),
  triggerScrapeBtn: document.getElementById('triggerScrapeBtn'),
  resultsCount: document.getElementById('resultsCount'),
  activeFiltersTag: document.getElementById('activeFiltersTag'),
  listingsGrid: document.getElementById('listingsGrid'),
  loader: document.getElementById('loader'),
  emptyState: document.getElementById('emptyState'),
  resetFiltersBtn: document.getElementById('resetFiltersBtn'),
  pagination: document.getElementById('pagination'),
  prevPageBtn: document.getElementById('prevPage'),
  nextPageBtn: document.getElementById('nextPage'),
  pageIndicator: document.getElementById('pageIndicator')
};

// Initialize Application
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  fetchStats();
  fetchListings();

  // Periodic stats poll every 15 seconds
  setInterval(fetchStats, 15000);
});

function setupEventListeners() {
  // Source Tabs
  DOM.tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      DOM.tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.source = btn.dataset.source;
      state.page = 1;
      fetchListings();
    });
  });

  // 36h Quick Filter
  DOM.toggle36hBtn.addEventListener('click', () => {
    state.recent36h = !state.recent36h;
    DOM.toggle36hBtn.classList.toggle('active', state.recent36h);
    state.page = 1;
    fetchListings();
  });

  // WFH Quick Filter
  DOM.toggleWFHBtn.addEventListener('click', () => {
    state.onlyWFH = !state.onlyWFH;
    DOM.toggleWFHBtn.classList.toggle('active', state.onlyWFH);
    if (state.onlyWFH) {
      DOM.locationInput.value = 'Work From Home';
      state.location = 'Work From Home';
    } else if (DOM.locationInput.value === 'Work From Home') {
      DOM.locationInput.value = '';
      state.location = '';
    }
    state.page = 1;
    fetchListings();
  });

  // Debounced Search Input
  let searchTimeout;
  DOM.searchInput.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    DOM.clearSearchBtn.classList.toggle('hidden', !val);
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      state.search = val;
      state.page = 1;
      fetchListings();
    }, 350);
  });

  DOM.clearSearchBtn.addEventListener('click', () => {
    DOM.searchInput.value = '';
    DOM.clearSearchBtn.classList.add('hidden');
    state.search = '';
    state.page = 1;
    fetchListings();
  });

  // Location Filter
  let locTimeout;
  DOM.locationInput.addEventListener('input', (e) => {
    clearTimeout(locTimeout);
    locTimeout = setTimeout(() => {
      state.location = e.target.value.trim();
      state.page = 1;
      fetchListings();
    }, 350);
  });

  // Reset Filters
  DOM.resetFiltersBtn.addEventListener('click', () => {
    state.search = '';
    state.location = '';
    state.recent36h = false;
    state.onlyWFH = false;
    state.page = 1;
    DOM.searchInput.value = '';
    DOM.locationInput.value = '';
    DOM.clearSearchBtn.classList.add('hidden');
    DOM.toggle36hBtn.classList.remove('active');
    DOM.toggleWFHBtn.classList.remove('active');
    fetchListings();
  });

  // Pagination
  DOM.prevPageBtn.addEventListener('click', () => {
    if (state.page > 1) {
      state.page--;
      fetchListings();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  DOM.nextPageBtn.addEventListener('click', () => {
    if (state.page < state.totalPages) {
      state.page++;
      fetchListings();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  // Grid click delegation for card details modal
  DOM.listingsGrid.addEventListener('click', (e) => {
    // If clicked on Apply button, let it open external link
    if (e.target.closest('.apply-btn')) return;

    const card = e.target.closest('.job-card');
    if (card) {
      const source = card.getAttribute('data-source') || 'jobs';
      const jobId = card.getAttribute('data-job-id');
      if (jobId) {
        openDetailModal(source, jobId);
      }
    }
  });

  // Trigger Scrape
  DOM.triggerScrapeBtn.addEventListener('click', async () => {
    DOM.triggerScrapeBtn.disabled = true;
    DOM.triggerScrapeBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Triggering...';
    try {
      const res = await fetch('/api/admin/scrape/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: state.source })
      });
      const data = await res.json();
      alert(data.message || (data.success ? 'Scrape started in background!' : 'Failed to start scrape'));
    } catch (err) {
      alert('Error triggering scrape: ' + err.message);
    } finally {
      DOM.triggerScrapeBtn.disabled = false;
      DOM.triggerScrapeBtn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Trigger Scrape Now';
      fetchStats();
    }
  });
}

// Fetch Stats
async function fetchStats() {
  try {
    const res = await fetch('/api/jobs/stats');
    const json = await res.json();
    if (json.success) {
      const data = json.data;
      DOM.statJobs.textContent = data.jobs_total.toLocaleString();
      DOM.statInternships.textContent = data.internships_total.toLocaleString();
      DOM.statRecent.textContent = data.recent_36h_total.toLocaleString();
      
      const sched = data.scheduler || {};
      if (sched.running) {
        DOM.statScheduler.textContent = 'Scraping...';
        DOM.statScheduler.style.color = 'var(--accent-gold)';
      } else {
        DOM.statScheduler.textContent = 'Active (36h)';
        DOM.statScheduler.style.color = 'var(--accent-job)';
      }
    }
  } catch (err) {
    console.error('Error fetching stats:', err);
  }
}

// Fetch Listings
async function fetchListings() {
  showLoader(true);

  const params = new URLSearchParams({
    source: state.source,
    page: state.page,
    limit: state.limit
  });

  if (state.search) params.append('search', state.search);
  if (state.location) params.append('location', state.location);
  if (state.recent36h) params.append('recent_hours', '36');

  try {
    const res = await fetch(`/api/jobs/listings?${params.toString()}`);
    const json = await res.json();

    if (json.success) {
      const data = json.data;
      state.totalPages = data.total_pages;
      renderListings(data.items, data.total);
      updatePagination(data.page, data.total_pages);
    } else {
      showEmptyState(true);
    }
  } catch (err) {
    console.error('Error fetching listings:', err);
    showEmptyState(true);
  } finally {
    showLoader(false);
  }
}

// Render Job Cards
function renderListings(items, total) {
  DOM.listingsGrid.innerHTML = '';
  DOM.resultsCount.textContent = `Showing ${items.length} of ${total.toLocaleString()} listings`;

  // Active filters summary
  const filters = [];
  if (state.source !== 'all') filters.push(`Section: ${state.source}`);
  if (state.recent36h) filters.push('⚡ Last 36h');
  if (state.search) filters.push(`Search: "${state.search}"`);
  if (state.location) filters.push(`Location: "${state.location}"`);

  if (filters.length > 0) {
    DOM.activeFiltersTag.textContent = filters.join(' • ');
    DOM.activeFiltersTag.classList.remove('hidden');
  } else {
    DOM.activeFiltersTag.classList.add('hidden');
  }

  if (items.length === 0) {
    showEmptyState(true);
    return;
  }

  showEmptyState(false);

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'job-card';
    card.setAttribute('data-source', item.source || 'jobs');
    card.setAttribute('data-job-id', item.job_id);

    const isJob = item.source === 'jobs';
    const sourceClass = isJob ? 'job' : 'internship';
    const sourceLabel = isJob ? 'Job' : 'Internship';

    const title = item.title || 'Untitled Listing';
    const company = item.company || 'Company Confidential';
    const location = item.location || 'Multiple Locations';
    const stipend = item.stipend || item.salary || item.ctc || 'Not Disclosed';
    const duration = item.duration || item.experience || '';
    const applyBy = item.apply_by || '';
    const link = item.url || item.link || `https://internshala.com/${item.source || 'internship'}/detail/${item.job_id}`;

    // Render Skills tags
    let skillsHTML = '';
    if (item.skills) {
      const skillList = Array.isArray(item.skills) 
        ? item.skills 
        : String(item.skills).split(',').map(s => s.trim()).filter(Boolean);
      
      skillsHTML = skillList.slice(0, 4).map(s => `<span class="skill-pill">${escapeHTML(s)}</span>`).join('');
    }

    card.innerHTML = `
      <div>
        <div class="card-top">
          <span class="badge-source ${sourceClass}">${sourceLabel}</span>
          ${item.start_date ? `<span class="detail-item" style="font-size:11px;"><i class="fa-regular fa-calendar"></i> ${escapeHTML(item.start_date)}</span>` : ''}
        </div>
        
        <h2 class="card-title">${escapeHTML(title)}</h2>
        <div class="company-name">
          <i class="fa-solid fa-building"></i> ${escapeHTML(company)}
        </div>

        <div class="card-details">
          <div class="detail-item">
            <i class="fa-solid fa-location-dot"></i> ${escapeHTML(location)}
          </div>
          <div class="detail-item highlight">
            <i class="fa-solid fa-money-bill-wave"></i> ${escapeHTML(stipend)}
          </div>
          ${duration ? `<div class="detail-item"><i class="fa-solid fa-hourglass-half"></i> ${escapeHTML(duration)}</div>` : ''}
          ${applyBy ? `<div class="detail-item"><i class="fa-solid fa-clock"></i> Apply by: ${escapeHTML(applyBy)}</div>` : ''}
        </div>

        ${skillsHTML ? `<div class="skills-tags">${skillsHTML}</div>` : ''}
      </div>

      <div class="card-footer">
        <span class="posted-time">${formatDate(item.updated_at || item.first_seen_at)}</span>
        <a href="${escapeHTML(link)}" target="_blank" rel="noopener noreferrer" class="apply-btn">
          Apply Now <i class="fa-solid fa-arrow-up-right-from-square"></i>
        </a>
      </div>
    `;

    card.addEventListener('click', (e) => {
      // If user clicked directly on the Apply link, let default new tab open happen
      if (e.target.closest('.apply-btn')) return;
      openDetailModal(item.source || 'jobs', item.job_id, item);
    });

    DOM.listingsGrid.appendChild(card);
  });
}

// Open Detail Modal
async function openDetailModal(source, jobId, fallbackItem) {
  const modal = document.getElementById('detailModal');
  const modalBody = document.getElementById('modalBody');
  const closeBtn = document.getElementById('closeModalBtn');

  modalBody.innerHTML = `
    <div class="loader-container">
      <div class="spinner"></div>
      <p>Loading full details...</p>
    </div>
  `;
  modal.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  // Event handlers for closing
  const closeModal = () => {
    modal.classList.add('hidden');
    document.body.style.overflow = '';
  };

  closeBtn.onclick = closeModal;
  modal.onclick = (e) => {
    if (e.target === modal) closeModal();
  };
  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      closeModal();
      document.removeEventListener('keydown', keyHandler);
    }
  };
  document.addEventListener('keydown', keyHandler);

  let item = fallbackItem;
  try {
    const res = await fetch(`/api/jobs/listing/${source}/${jobId}`);
    const json = await res.json();
    if (json.success && json.data) {
      item = json.data;
    }
  } catch (err) {
    console.error('Error fetching detail:', err);
  }

  // Build Detail Modal HTML
  const isJob = (item.source || source) === 'jobs';
  const sourceLabel = isJob ? 'Job' : 'Internship';
  const sourceClass = isJob ? 'job' : 'internship';
  const title = item.title || item.detail_title || 'Untitled Listing';
  const company = item.company || 'Company Confidential';
  const location = item.location || 'Multiple Locations';
  const salary = item.stipend || item.salary || item.annual_ctc || 'Not Disclosed';
  const duration = item.duration || item.experience || 'Not Specified';
  const startDate = item.start_date || 'Immediately';
  const applyBy = item.apply_by || 'N/A';
  const openings = item.openings || 'Not Specified';
  const posted = item.posted || formatDate(item.updated_at || item.first_seen_at);
  const link = item.url || item.link || `https://internshala.com/${source}/detail/${jobId}`;

  // Skills
  let skillsList = [];
  if (item.skills) {
    skillsList = Array.isArray(item.skills)
      ? item.skills
      : String(item.skills).split(',').map(s => s.trim()).filter(Boolean);
  }

  const skillsHTML = skillsList.length > 0
    ? skillsList.map(s => `<span class="skill-pill">${escapeHTML(s)}</span>`).join('')
    : '<span class="posted-time">No specific skills listed</span>';

  // Description & About Company
  const descriptionText = item.description || item.ld_description || 'No detailed description available.';
  const companyDesc = item.company_description || '';
  const whoCanApply = item.who_can_apply || '';
  const perks = item.perks || '';

  modalBody.innerHTML = `
    <div class="modal-header-area">
      <span class="badge-source ${sourceClass}">${sourceLabel}</span>
      <h2>${escapeHTML(title)}</h2>
      <div class="modal-company">
        <i class="fa-solid fa-building"></i> ${escapeHTML(company)}
      </div>
    </div>

    <div class="modal-key-grid">
      <div class="modal-key-item">
        <span class="label">Location</span>
        <span class="val"><i class="fa-solid fa-location-dot"></i> ${escapeHTML(location)}</span>
      </div>
      <div class="modal-key-item">
        <span class="label">Stipend / CTC</span>
        <span class="val" style="color: var(--accent-job);"><i class="fa-solid fa-money-bill-wave"></i> ${escapeHTML(salary)}</span>
      </div>
      <div class="modal-key-item">
        <span class="label">Start Date / Duration</span>
        <span class="val"><i class="fa-solid fa-calendar"></i> ${escapeHTML(startDate)} (${escapeHTML(duration)})</span>
      </div>
      <div class="modal-key-item">
        <span class="label">Apply By</span>
        <span class="val"><i class="fa-solid fa-clock"></i> ${escapeHTML(applyBy)}</span>
      </div>
      <div class="modal-key-item">
        <span class="label">Openings</span>
        <span class="val"><i class="fa-solid fa-users"></i> ${escapeHTML(openings)}</span>
      </div>
      <div class="modal-key-item">
        <span class="label">Posted Date</span>
        <span class="val"><i class="fa-solid fa-clock-rotate-left"></i> ${escapeHTML(posted)}</span>
      </div>
    </div>

    <div class="modal-section">
      <h3><i class="fa-solid fa-file-lines"></i> Role Description & Responsibilities</h3>
      <p>${escapeHTML(descriptionText)}</p>
    </div>

    ${whoCanApply ? `
    <div class="modal-section">
      <h3><i class="fa-solid fa-user-check"></i> Who Can Apply</h3>
      <p>${escapeHTML(whoCanApply)}</p>
    </div>` : ''}

    <div class="modal-section">
      <h3><i class="fa-solid fa-brain"></i> Required Skills</h3>
      <div class="skills-tags">${skillsHTML}</div>
    </div>

    ${perks ? `
    <div class="modal-section">
      <h3><i class="fa-solid fa-gift"></i> Perks & Benefits</h3>
      <p>${escapeHTML(perks)}</p>
    </div>` : ''}

    ${companyDesc ? `
    <div class="modal-section">
      <h3><i class="fa-solid fa-building-user"></i> About ${escapeHTML(company)}</h3>
      <p>${escapeHTML(companyDesc)}</p>
    </div>` : ''}

    <div class="modal-footer-area">
      <span class="posted-time">Listing ID: ${escapeHTML(jobId)}</span>
      <a href="${escapeHTML(link)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary">
        Apply Now on Internshala <i class="fa-solid fa-arrow-up-right-from-square"></i>
      </a>
    </div>
  `;
}


function updatePagination(page, totalPages) {
  if (totalPages <= 1) {
    DOM.pagination.classList.add('hidden');
    return;
  }
  DOM.pagination.classList.remove('hidden');
  DOM.pageIndicator.textContent = `Page ${page} of ${totalPages}`;
  DOM.prevPageBtn.disabled = page <= 1;
  DOM.nextPageBtn.disabled = page >= totalPages;
}

function showLoader(show) {
  DOM.loader.classList.toggle('hidden', !show);
  if (show) {
    DOM.listingsGrid.classList.add('hidden');
    DOM.emptyState.classList.add('hidden');
  } else {
    DOM.listingsGrid.classList.remove('hidden');
  }
}

function showEmptyState(show) {
  DOM.emptyState.classList.toggle('hidden', !show);
  if (show) {
    DOM.listingsGrid.classList.add('hidden');
    DOM.pagination.classList.add('hidden');
  }
}

function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatDate(isoStr) {
  if (!isoStr) return 'Recently';
  try {
    const d = new Date(isoStr);
    const now = new Date();
    const diffHours = Math.floor((now - d) / (1000 * 60 * 60));

    if (diffHours < 1) return 'Just now';
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return 'Yesterday';
    return `${diffDays}d ago`;
  } catch (e) {
    return 'Recently';
  }
}
