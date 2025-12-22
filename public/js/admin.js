// =====================================================================
// ADMIN DASHBOARD UTILITIES
// =====================================================================

/**
 * Fetch JSON from API with error handling
 */
async function adminFetch(path, options = {}) {
  const res = await fetch(path, {
    credentials: "include",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || data.message || `HTTP ${res.status}`);
  }

  return res.json();
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Format date for display
 */
function formatDate(dateString) {
  if (!dateString) return "-";
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Format date with time
 */
function formatDateTime(dateString) {
  if (!dateString) return "-";
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Format relative time (e.g., "2 hours ago")
 */
function formatRelativeTime(dateString) {
  if (!dateString) return "-";
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return formatDate(dateString);
}

/**
 * Truncate text with ellipsis
 */
function truncate(text, maxLength = 100) {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 1) + "…";
}

/**
 * Show a toast notification
 */
function showToast(message, type = "success") {
  // Remove existing toasts
  document.querySelectorAll(".admin-toast").forEach((t) => t.remove());

  const toast = document.createElement("div");
  toast.className = `admin-toast admin-toast-${type}`;
  toast.textContent = message;
  toast.style.cssText = `
    position: fixed;
    bottom: 24px;
    right: 24px;
    padding: 14px 20px;
    border-radius: 10px;
    font-size: 14px;
    font-weight: 500;
    z-index: 200;
    animation: slideIn 0.3s ease;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.15);
    ${type === "success" ? "background: #22c55e; color: #ffffff;" : ""}
    ${type === "error" ? "background: #ef4444; color: #ffffff;" : ""}
    ${type === "info" ? "background: #0ea5e9; color: #ffffff;" : ""}
  `;

  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    toast.style.transition = "all 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/**
 * Modal management
 */
function openModal(modalId) {
  const overlay = document.getElementById(modalId);
  if (overlay) {
    overlay.classList.add("open");
    document.body.style.overflow = "hidden";
  }
}

function closeModal(modalId) {
  const overlay = document.getElementById(modalId);
  if (overlay) {
    overlay.classList.remove("open");
    document.body.style.overflow = "";
  }
}

// Close modal on overlay click
document.addEventListener("click", (e) => {
  if (e.target.classList.contains("admin-modal-overlay")) {
    e.target.classList.remove("open");
    document.body.style.overflow = "";
  }
});

// Close modal on escape key
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    document.querySelectorAll(".admin-modal-overlay.open").forEach((m) => {
      m.classList.remove("open");
    });
    document.body.style.overflow = "";
  }
});

/**
 * Confirm dialog
 */
async function confirmAction(message) {
  return new Promise((resolve) => {
    // For now, use native confirm. Can be upgraded to custom modal.
    resolve(window.confirm(message));
  });
}

/**
 * Debounce function for search inputs
 */
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Parse query parameters
 */
function getQueryParams() {
  const params = new URLSearchParams(window.location.search);
  return Object.fromEntries(params.entries());
}

/**
 * Update URL query parameters without page reload
 */
function updateQueryParams(params) {
  const url = new URL(window.location);
  Object.entries(params).forEach(([key, value]) => {
    if (value === null || value === undefined || value === "") {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  });
  window.history.replaceState({}, "", url);
}

/**
 * Render pagination controls
 */
function renderPagination(container, { page, totalPages, total, limit }) {
  const startItem = (page - 1) * limit + 1;
  const endItem = Math.min(page * limit, total);

  container.innerHTML = `
    <div class="admin-pagination-info">
      Showing ${startItem}-${endItem} of ${total}
    </div>
    <div class="admin-pagination-controls">
      <button
        class="admin-pagination-btn"
        onclick="goToPage(${page - 1})"
        ${page <= 1 ? "disabled" : ""}
      >
        Previous
      </button>
      <button
        class="admin-pagination-btn"
        onclick="goToPage(${page + 1})"
        ${page >= totalPages ? "disabled" : ""}
      >
        Next
      </button>
    </div>
  `;
}

/**
 * Format number with commas
 */
function formatNumber(num) {
  if (num === null || num === undefined) return "0";
  return num.toLocaleString();
}

/**
 * Get status badge HTML
 */
function getStatusBadge(isActive, expiresAt) {
  if (!expiresAt) {
    return '<span class="status-badge pending">No Pass</span>';
  }

  const expires = new Date(expiresAt);
  const now = new Date();

  if (expires < now) {
    return '<span class="status-badge expired">Expired</span>';
  }

  return '<span class="status-badge active">Active</span>';
}

/**
 * Render loading state
 */
function showLoading(container) {
  container.innerHTML = `
    <div class="admin-loading">
      <div class="admin-spinner"></div>
    </div>
  `;
}

/**
 * Render empty state
 */
function showEmptyState(container, title, text) {
  container.innerHTML = `
    <div class="admin-empty-state">
      <svg class="admin-empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/>
      </svg>
      <h3 class="admin-empty-state-title">${escapeHtml(title)}</h3>
      <p class="admin-empty-state-text">${escapeHtml(text)}</p>
    </div>
  `;
}

/**
 * Simple SVG icons
 */
const icons = {
  users: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  sessions: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
  offers: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>`,
  settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
  dashboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>`,
  back: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
};

/**
 * Get icon SVG
 */
function getIcon(name, className = "admin-nav-icon") {
  const svg = icons[name] || "";
  return svg.replace("<svg", `<svg class="${className}"`);
}

// Add animation keyframe style
const style = document.createElement("style");
style.textContent = `
  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
`;
document.head.appendChild(style);
