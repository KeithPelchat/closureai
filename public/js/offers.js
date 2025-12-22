// =====================================================================
// OFFER CARD RENDERER
// =====================================================================

/**
 * Renders offer cards when the session reaches wrap-up
 *
 * @param {Array} offers - Array of offer objects from the API
 * @param {HTMLElement} container - Container element to render cards into
 */
function renderOfferCards(offers, container) {
  if (!offers || offers.length === 0 || !container) {
    return;
  }

  // Create the offers section
  const section = document.createElement("div");
  section.className = "offer-card-container";
  section.innerHTML = `
    <p class="offers-section-header">Want to keep going?</p>
  `;

  // Render each offer
  offers.forEach((offer, index) => {
    const card = createOfferCard(offer, index === 0);
    section.appendChild(card);
  });

  container.appendChild(section);

  // Animate in
  requestAnimationFrame(() => {
    section.style.opacity = "0";
    section.style.transform = "translateY(10px)";
    section.style.transition = "all 0.3s ease";

    requestAnimationFrame(() => {
      section.style.opacity = "1";
      section.style.transform = "translateY(0)";
    });
  });
}

/**
 * Creates a single offer card element
 *
 * @param {Object} offer - Offer object
 * @param {boolean} isPrimary - Whether this is the primary (first) offer
 * @returns {HTMLElement}
 */
function createOfferCard(offer, isPrimary = true) {
  const card = document.createElement("div");
  card.className = `offer-card ${isPrimary ? "" : "offer-card--subtle"}`;

  const badgeText = getOfferBadge(offer.offerType);

  card.innerHTML = `
    <div class="offer-card-header">
      <h4 class="offer-card-title">${escapeHtml(offer.title)}</h4>
      ${badgeText ? `<span class="offer-card-badge">${badgeText}</span>` : ""}
    </div>
    ${offer.description ? `<p class="offer-card-description">${escapeHtml(offer.description)}</p>` : ""}
    ${
      offer.url
        ? `
      <a href="${escapeHtml(offer.url)}" target="_blank" rel="noopener noreferrer" class="offer-card-cta">
        ${escapeHtml(offer.ctaText || "Learn More")}
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3" />
        </svg>
      </a>
    `
        : ""
    }
  `;

  // Track click for analytics (optional)
  const ctaButton = card.querySelector(".offer-card-cta");
  if (ctaButton) {
    ctaButton.addEventListener("click", () => {
      trackOfferClick(offer.id, offer.title);
    });
  }

  return card;
}

/**
 * Get badge text based on offer type
 */
function getOfferBadge(offerType) {
  const badges = {
    discovery_call: "Free Call",
    group_program: "Group Program",
    course: "Course",
    accountability: "Accountability",
    workshop: "Workshop",
    resource: "Resource",
    coaching: "1:1 Coaching",
  };
  return badges[offerType] || null;
}

/**
 * Track offer clicks (integrate with your analytics)
 */
function trackOfferClick(offerId, offerTitle) {
  console.log(`[Analytics] Offer clicked: ${offerTitle} (${offerId})`);

  // If you have analytics, send the event:
  // gtag('event', 'offer_click', { offer_id: offerId, offer_title: offerTitle });
  // or
  // plausible('Offer Click', { props: { offer: offerTitle } });
}

/**
 * HTML escape helper
 */
function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// =====================================================================
// INTEGRATION EXAMPLE
// =====================================================================
//
// In your session page JS, after receiving the AI response:
//
// async function handleAIResponse(response) {
//   // ... render the AI message ...
//
//   // Check if we should show offer cards
//   if (response.isWrapUp && response.offers && response.offers.length > 0) {
//     const conversationContainer = document.getElementById('conversation');
//     renderOfferCards(response.offers, conversationContainer);
//   }
// }
//
// =====================================================================

// Export for module use
if (typeof module !== "undefined" && module.exports) {
  module.exports = { renderOfferCards, createOfferCard };
}
