// theme.js - Global theme manager for all pages

// Apply theme on page load
function applyTheme(theme) {
  if (!theme) {
    theme = localStorage.getItem('theme') || 'esc';
  }
  
  // Remove any existing theme classes
  document.body.className = document.body.className
    .split(' ')
    .filter(c => !c.startsWith('theme-'))
    .join(' ');
  
  // Apply the theme
  document.body.classList.add('theme-' + theme);
  
  // Update preview cards if they exist (for settings page)
  document.querySelectorAll('.theme-preview-card').forEach(c => {
    c.classList.toggle('active', c.dataset.theme === theme);
  });
  
  // Show only the selected theme preview (if previews exist)
  document.querySelectorAll('.theme-preview-content').forEach(content => {
    content.style.display = 'none';
  });
  
  const selectedPreview = document.querySelector(`.theme-preview-content.${theme}-preview`);
  if (selectedPreview) {
    selectedPreview.style.display = 'flex';
  }
}

// Apply accent color globally
function applyAccent() {
  const savedAccent = localStorage.getItem('accent');
  if (savedAccent) {
    document.documentElement.style.setProperty('--accent', savedAccent);
    // Update accent swatches if they exist
    document.querySelectorAll('.accent-swatch').forEach(el => {
      el.classList.toggle('active', el.dataset.color === savedAccent);
    });
  }
}

// Set theme (call this when user clicks a theme card)
function setTheme(theme) {
  localStorage.setItem('theme', theme);
  applyTheme(theme);
  
  // Show toast if available
  if (typeof toast === 'function') {
    toast('Theme changed to: ' + theme.toUpperCase());
  }
}

// Set accent color (call this when user clicks an accent swatch)
function setAccent(color) {
  // Update active swatch
  document.querySelectorAll('.accent-swatch').forEach(s => s.classList.remove('active'));
  document.querySelector(`.accent-swatch[data-color="${color}"]`)?.classList.add('active');
  
  // Apply the accent color
  document.documentElement.style.setProperty('--accent', color);
  localStorage.setItem('accent', color);
  
  // Show toast if available
  if (typeof toast === 'function') {
    toast('Accent color updated');
  }
}

// Auto-apply theme and accent when page loads
document.addEventListener('DOMContentLoaded', function() {
  applyTheme(localStorage.getItem('theme') || 'esc');
  applyAccent();
});