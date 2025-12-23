// Onboarding Form Logic

(function() {
  // Get token from URL
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('token');

  if (!token) {
    window.location.href = '/onboard';
    return;
  }

  // State
  let currentStep = 1;
  const totalSteps = 6;
  let formData = {};
  let offers = [];
  let logoFile = null;
  let logoUrl = null;

  // Elements
  const steps = document.querySelectorAll('.form-step');
  const progressFill = document.getElementById('progress-fill');
  const progressText = document.getElementById('progress-text');
  const prevBtn = document.getElementById('prev-btn');
  const nextBtn = document.getElementById('next-btn');
  const submitBtn = document.getElementById('submit-btn');

  // Initialize
  async function init() {
    // Load existing data
    try {
      const res = await fetch(`/api/onboard/${token}`);
      const data = await res.json();

      if (!res.ok) {
        alert(data.error || 'Invalid or expired link');
        window.location.href = '/onboard';
        return;
      }

      // Pre-fill email
      document.getElementById('coach_email').value = data.email || '';

      // Restore saved data if any
      if (data.formData) {
        formData = data.formData;
        restoreFormData();
      }

      if (data.offers) {
        offers = data.offers;
        renderOffers();
      }

      if (data.logoUrl) {
        logoUrl = data.logoUrl;
        showLogoPreview(logoUrl);
      }

    } catch (err) {
      console.error('Failed to load onboarding data:', err);
    }

    setupEventListeners();
    updateProgress();
    updateNavigation();
  }

  function setupEventListeners() {
    // Navigation
    prevBtn.addEventListener('click', () => goToStep(currentStep - 1));
    nextBtn.addEventListener('click', () => goToStep(currentStep + 1));
    submitBtn.addEventListener('click', submitForm);

    // Edit buttons on review
    document.querySelectorAll('.btn-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        goToStep(parseInt(btn.dataset.goto));
      });
    });

    // Logo upload
    const logoUpload = document.getElementById('logo-upload');
    const logoInput = document.getElementById('logo_file');
    logoUpload.addEventListener('click', () => logoInput.click());
    logoInput.addEventListener('change', handleLogoUpload);

    // Color pickers sync
    document.getElementById('primary_color').addEventListener('input', (e) => {
      document.getElementById('primary_color_hex').value = e.target.value;
      updateBrandPreview();
    });
    document.getElementById('primary_color_hex').addEventListener('input', (e) => {
      document.getElementById('primary_color').value = e.target.value;
      updateBrandPreview();
    });
    document.getElementById('secondary_color').addEventListener('input', (e) => {
      document.getElementById('secondary_color_hex').value = e.target.value;
      updateBrandPreview();
    });
    document.getElementById('secondary_color_hex').addEventListener('input', (e) => {
      document.getElementById('secondary_color').value = e.target.value;
      updateBrandPreview();
    });

    // Add offer button
    document.getElementById('add-offer-btn').addEventListener('click', addOffer);

    // Domain type toggle
    document.querySelectorAll('input[name="domain_type"]').forEach(radio => {
      radio.addEventListener('change', toggleDomainInputs);
    });

    // Subdomain auto-generate from business name
    document.getElementById('business_name').addEventListener('input', (e) => {
      const subdomain = e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
      document.getElementById('subdomain').value = subdomain;
      updateSubdomainPreview();
    });

    document.getElementById('subdomain').addEventListener('input', updateSubdomainPreview);

    // Business name updates preview
    document.getElementById('business_name').addEventListener('input', (e) => {
      document.getElementById('preview-name').textContent = e.target.value || 'Your App';
    });

    // Initial render
    if (offers.length === 0) {
      addOffer(); // Add one empty offer
    }
    toggleDomainInputs();
  }

  function goToStep(step) {
    if (step < 1 || step > totalSteps) return;

    // Save current step data
    collectStepData(currentStep);

    // Validate current step before proceeding forward
    if (step > currentStep && !validateStep(currentStep)) {
      return;
    }

    // Auto-save
    saveProgress();

    currentStep = step;

    // Update UI
    steps.forEach(s => s.classList.remove('active'));
    document.querySelector(`[data-step="${step}"]`).classList.add('active');

    updateProgress();
    updateNavigation();

    // Populate review on step 6
    if (step === 6) {
      populateReview();
    }

    window.scrollTo(0, 0);
  }

  function updateProgress() {
    const percent = (currentStep / totalSteps) * 100;
    progressFill.style.width = `${percent}%`;
    progressText.textContent = `Step ${currentStep} of ${totalSteps}`;
  }

  function updateNavigation() {
    prevBtn.style.visibility = currentStep === 1 ? 'hidden' : 'visible';

    if (currentStep === totalSteps) {
      nextBtn.style.display = 'none';
      submitBtn.style.display = 'inline-flex';
    } else {
      nextBtn.style.display = 'inline-flex';
      submitBtn.style.display = 'none';
    }
  }

  function collectStepData(step) {
    switch (step) {
      case 1:
        formData.business_name = document.getElementById('business_name').value.trim();
        formData.coach_name = document.getElementById('coach_name').value.trim();
        formData.coach_phone = document.getElementById('coach_phone').value.trim();
        formData.coach_email = document.getElementById('coach_email').value.trim();
        formData.coaching_niche = document.getElementById('coaching_niche').value;
        formData.target_audience = document.getElementById('target_audience').value.trim();
        break;
      case 2:
        formData.primary_color = document.getElementById('primary_color').value;
        formData.secondary_color = document.getElementById('secondary_color').value;
        break;
      case 3:
        formData.coaching_style = document.getElementById('coaching_style').value.trim();
        formData.coach_bio = document.getElementById('coach_bio').value.trim();
        formData.coach_phrases = document.getElementById('coach_phrases').value.trim();
        break;
      case 4:
        collectOffers();
        break;
      case 5:
        formData.domain_type = document.querySelector('input[name="domain_type"]:checked').value;
        formData.subdomain = document.getElementById('subdomain').value.trim().toLowerCase();
        formData.custom_domain = document.getElementById('custom_domain').value.trim().toLowerCase();
        break;
    }
  }

  function validateStep(step) {
    switch (step) {
      case 1:
        if (!formData.business_name) {
          alert('Please enter your business name');
          return false;
        }
        if (!formData.coach_name) {
          alert('Please enter your name');
          return false;
        }
        if (!formData.coaching_niche) {
          alert('Please select your coaching niche');
          return false;
        }
        break;
      case 5:
        if (formData.domain_type === 'subdomain' && !formData.subdomain) {
          alert('Please enter a subdomain');
          return false;
        }
        if (formData.domain_type === 'custom' && !formData.custom_domain) {
          alert('Please enter your custom domain');
          return false;
        }
        break;
    }
    return true;
  }

  function restoreFormData() {
    // Step 1
    if (formData.business_name) document.getElementById('business_name').value = formData.business_name;
    if (formData.coach_name) document.getElementById('coach_name').value = formData.coach_name;
    if (formData.coach_phone) document.getElementById('coach_phone').value = formData.coach_phone;
    if (formData.coaching_niche) document.getElementById('coaching_niche').value = formData.coaching_niche;
    if (formData.target_audience) document.getElementById('target_audience').value = formData.target_audience;

    // Step 2
    if (formData.primary_color) {
      document.getElementById('primary_color').value = formData.primary_color;
      document.getElementById('primary_color_hex').value = formData.primary_color;
    }
    if (formData.secondary_color) {
      document.getElementById('secondary_color').value = formData.secondary_color;
      document.getElementById('secondary_color_hex').value = formData.secondary_color;
    }

    // Step 3
    if (formData.coaching_style) document.getElementById('coaching_style').value = formData.coaching_style;
    if (formData.coach_bio) document.getElementById('coach_bio').value = formData.coach_bio;
    if (formData.coach_phrases) document.getElementById('coach_phrases').value = formData.coach_phrases;

    // Step 5
    if (formData.domain_type === 'custom') {
      document.querySelector('input[name="domain_type"][value="custom"]').checked = true;
    }
    if (formData.subdomain) document.getElementById('subdomain').value = formData.subdomain;
    if (formData.custom_domain) document.getElementById('custom_domain').value = formData.custom_domain;

    updateBrandPreview();
    updateSubdomainPreview();
  }

  // Logo handling
  async function handleLogoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    logoFile = file;

    // Show preview
    const reader = new FileReader();
    reader.onload = (e) => {
      showLogoPreview(e.target.result);
    };
    reader.readAsDataURL(file);

    // Upload to S3
    try {
      const res = await fetch(`/api/onboard/${token}/upload-logo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          filename: file.name,
          contentType: file.type
        })
      });

      const data = await res.json();

      if (data.uploadUrl) {
        // Upload to S3
        await fetch(data.uploadUrl, {
          method: 'PUT',
          body: file,
          headers: { 'Content-Type': file.type }
        });

        logoUrl = data.fileUrl;
      }
    } catch (err) {
      console.error('Logo upload failed:', err);
    }
  }

  function showLogoPreview(src) {
    const preview = document.getElementById('logo-preview');
    preview.innerHTML = `<img src="${src}" alt="Logo preview" />`;
    preview.classList.add('has-logo');

    // Update brand preview
    document.getElementById('preview-logo').style.backgroundImage = `url(${src})`;
  }

  function updateBrandPreview() {
    const primary = document.getElementById('primary_color').value;
    const secondary = document.getElementById('secondary_color').value;

    const card = document.getElementById('brand-preview-card');
    card.style.setProperty('--preview-primary', primary);
    card.style.setProperty('--preview-secondary', secondary);
  }

  // Offers
  function addOffer() {
    if (offers.length >= 5) {
      alert('Maximum 5 offers');
      return;
    }

    offers.push({
      title: '',
      description: '',
      url: '',
      cta_text: 'Learn More'
    });

    renderOffers();
  }

  function removeOffer(index) {
    offers.splice(index, 1);
    renderOffers();
  }

  function collectOffers() {
    offers = [];
    document.querySelectorAll('.offer-card').forEach((card, i) => {
      offers.push({
        title: card.querySelector('.offer-title').value.trim(),
        description: card.querySelector('.offer-desc').value.trim(),
        url: card.querySelector('.offer-url').value.trim(),
        cta_text: card.querySelector('.offer-cta').value.trim() || 'Learn More'
      });
    });
  }

  function renderOffers() {
    const container = document.getElementById('offers-container');
    container.innerHTML = offers.map((offer, i) => `
      <div class="offer-card">
        <div class="offer-header">
          <span class="offer-number">Offer ${i + 1}</span>
          ${offers.length > 1 ? `<button type="button" class="offer-remove" onclick="window.removeOffer(${i})">Remove</button>` : ''}
        </div>
        <div class="form-group">
          <input type="text" class="form-input offer-title" placeholder="Offer title" value="${escapeHtml(offer.title)}" />
        </div>
        <div class="form-group">
          <textarea class="form-textarea offer-desc" rows="2" placeholder="Brief description">${escapeHtml(offer.description)}</textarea>
        </div>
        <div class="form-row">
          <div class="form-group">
            <input type="url" class="form-input offer-url" placeholder="https://..." value="${escapeHtml(offer.url)}" />
          </div>
          <div class="form-group">
            <input type="text" class="form-input offer-cta" placeholder="Button text" value="${escapeHtml(offer.cta_text)}" />
          </div>
        </div>
      </div>
    `).join('');
  }

  // Expose for inline onclick
  window.removeOffer = removeOffer;

  // Domain
  function toggleDomainInputs() {
    const type = document.querySelector('input[name="domain_type"]:checked').value;
    document.getElementById('subdomain-input-group').style.display = type === 'subdomain' ? 'block' : 'none';
    document.getElementById('custom-domain-group').style.display = type === 'custom' ? 'block' : 'none';
  }

  function updateSubdomainPreview() {
    const subdomain = document.getElementById('subdomain').value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    document.getElementById('subdomain-preview').textContent = `${subdomain || 'yourname'}.getclosureai.com`;
  }

  // Review
  function populateReview() {
    // Business
    document.getElementById('review-business').innerHTML = `
      <p><strong>Business:</strong> ${escapeHtml(formData.business_name)}</p>
      <p><strong>Coach:</strong> ${escapeHtml(formData.coach_name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(formData.coach_email)}</p>
      <p><strong>Niche:</strong> ${escapeHtml(formData.coaching_niche)}</p>
    `;

    // Branding
    document.getElementById('review-branding').innerHTML = `
      <p><strong>Primary:</strong> <span style="display:inline-block;width:16px;height:16px;background:${formData.primary_color};border-radius:3px;vertical-align:middle;"></span> ${formData.primary_color}</p>
      <p><strong>Secondary:</strong> <span style="display:inline-block;width:16px;height:16px;background:${formData.secondary_color};border-radius:3px;vertical-align:middle;"></span> ${formData.secondary_color}</p>
      ${logoUrl ? '<p><strong>Logo:</strong> Uploaded</p>' : '<p><strong>Logo:</strong> Not uploaded</p>'}
    `;

    // Coaching
    document.getElementById('review-coaching').innerHTML = `
      <p><strong>Style:</strong> ${escapeHtml(formData.coaching_style || 'Not provided')}</p>
      <p><strong>Bio:</strong> ${escapeHtml(formData.coach_bio || 'Not provided')}</p>
    `;

    // Offers
    collectOffers();
    const validOffers = offers.filter(o => o.title);
    document.getElementById('review-offers').innerHTML = validOffers.length
      ? validOffers.map(o => `<p>• ${escapeHtml(o.title)}</p>`).join('')
      : '<p>No offers added</p>';

    // Domain
    document.getElementById('review-domain').innerHTML = formData.domain_type === 'custom'
      ? `<p><strong>Custom domain:</strong> ${escapeHtml(formData.custom_domain)}</p>`
      : `<p><strong>Subdomain:</strong> ${escapeHtml(formData.subdomain)}.getclosureai.com</p>`;
  }

  // Save progress
  async function saveProgress() {
    try {
      collectOffers();
      await fetch(`/api/onboard/${token}/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          formData,
          offers: offers.filter(o => o.title),
          logoUrl
        })
      });
    } catch (err) {
      console.error('Failed to save progress:', err);
    }
  }

  // Submit
  async function submitForm() {
    submitBtn.disabled = true;
    submitBtn.textContent = 'Submitting...';

    try {
      collectStepData(currentStep);
      collectOffers();

      const res = await fetch(`/api/onboard/${token}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          formData,
          offers: offers.filter(o => o.title),
          logoUrl
        })
      });

      const data = await res.json();

      if (res.ok) {
        window.location.href = `/onboard/success?token=${token}`;
      } else {
        throw new Error(data.error || 'Submission failed');
      }
    } catch (err) {
      console.error('Submit error:', err);
      alert('Something went wrong. Please try again.');
      submitBtn.disabled = false;
      submitBtn.textContent = 'Submit for Setup';
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Start
  init();
})();
