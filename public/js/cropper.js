// cropper.js – Discord‑style image cropper with circular mask, drag & zoom
(function() {
  'use strict';

  // ─── DOM refs ──────────────────────────────────────────
  function getEl(id) { return document.getElementById(id); }

  const overlay = getEl('cropper-overlay');
  const canvas = getEl('cropper-canvas');
  const titleEl = getEl('cropper-title');
  const errorEl = getEl('cropper-error');
  const confirmBtn = getEl('cropper-confirm');
  const cancelBtn = getEl('cropper-cancel');
  const zoomSlider = getEl('cropper-zoom');
  const zoomLabel = getEl('cropper-zoom-label');

  // ─── State ──────────────────────────────────────────────
  let imageObj = null;
  let targetType = 'avatar';
  const canvasSize = 512;
  let baseScale = 1;
  let zoomFactor = 1;
  let offsetX = 0, offsetY = 0;
  let isDragging = false;
  let dragStartX = 0, dragStartY = 0;
  let dragOffsetX = 0, dragOffsetY = 0;
  let ctx = null;
  let isUploading = false;
  let _listenersBound = false;

  // ─── Helpers ────────────────────────────────────────────
  function clamp(v, min, max) { return Math.min(Math.max(v, min), max); }

  function showError(msg) {
    if (errorEl) {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
      setTimeout(() => { errorEl.style.display = 'none'; }, 5000);
    }
  }

  function clearError() {
    if (errorEl) { errorEl.textContent = ''; errorEl.style.display = 'none'; }
  }

  function isValidImageType(file) {
    const allowed = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
    const ext = file.name.split('.').pop().toLowerCase();
    return allowed.includes(ext) || file.type.startsWith('image/');
  }

  function safeToast(msg) {
    if (typeof toast === 'function') toast(msg);
    else alert(msg);
  }

  // ─── Drawing ────────────────────────────────────────────
  function draw() {
    if (!imageObj || !ctx) return;
    const cw = canvas.width, ch = canvas.height;
    ctx.clearRect(0, 0, cw, ch);
    const scale = baseScale * zoomFactor;
    const imgW = imageObj.width, imgH = imageObj.height;
    const drawX = (cw - imgW * scale) / 2 + offsetX;
    const drawY = (ch - imgH * scale) / 2 + offsetY;
    ctx.drawImage(imageObj, drawX, drawY, imgW * scale, imgH * scale);
  }

  function computeBaseScale() {
    if (!imageObj) return 1;
    const cw = canvas.width, ch = canvas.height;
    return Math.max(cw / imageObj.width, ch / imageObj.height);
  }

  function clampOffset() {
    if (!imageObj) return;
    const scale = baseScale * zoomFactor;
    const imgW = imageObj.width * scale, imgH = imageObj.height * scale;
    const cw = canvas.width, ch = canvas.height;
    offsetX = clamp(offsetX, -Math.max(0, (imgW - cw) / 2), Math.max(0, (imgW - cw) / 2));
    offsetY = clamp(offsetY, -Math.max(0, (imgH - ch) / 2), Math.max(0, (imgH - ch) / 2));
  }

  function redraw() {
    clampOffset();
    draw();
  }

  // ─── Init cropper ──────────────────────────────────────
  function initCropper(file, type) {
    if (!isValidImageType(file)) {
      showError('Unsupported file format. Use .jpg, .jpeg, .png, .gif, or .webp.');
      return;
    }
    if (!overlay) return;

    targetType = type;
    const reader = new FileReader();
    reader.onload = function(e) {
      const img = new Image();
      img.onload = function() {
        imageObj = img;
        canvas.width = canvasSize;
        canvas.height = canvasSize;
        ctx = canvas.getContext('2d');

        const container = canvas.parentElement;
        // The crop box used to be hardcoded to 400x400 regardless of
        // screen size. .cropper-modal is `width: 95vw` (capped at
        // 560px) with 24px of padding — on a ~360-390px-wide phone that
        // leaves well under 400px of actual room, so the fixed 400px box
        // overflowed the modal (and often the viewport itself), making
        // the whole cropper unusable/clipped on mobile. Size it from
        // what's actually available instead, same as desktop just with a
        // smaller number.
        const wrap = container.parentElement; // .cropper-preview-wrap
        const available = (wrap && wrap.clientWidth) || (window.innerWidth - 64);
        const size = Math.max(220, Math.min(400, Math.floor(available)));
        container.style.width = size + 'px';
        container.style.height = size + 'px';
        canvas.style.width = size + 'px';
        canvas.style.height = size + 'px';

        const mask = document.getElementById('cropper-mask');
        if (mask) {
          if (type === 'avatar') {
            mask.style.borderRadius = '50%';
            mask.style.display = 'block';
          } else {
            mask.style.display = 'none';
          }
        }

        baseScale = computeBaseScale();
        zoomFactor = 1;
        offsetX = 0; offsetY = 0;
        zoomSlider.value = zoomFactor;
        zoomLabel.textContent = zoomFactor.toFixed(1) + 'x';

        if (!_listenersBound) {
          bindEvents();
          _listenersBound = true;
        }

        overlay.classList.add('open');
        clearError();
        titleEl.textContent = type === 'avatar' ? 'Crop Avatar' : 'Crop Banner';
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Crop & Upload';
        redraw();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  // ─── Pointer events ─────────────────────────────────────
  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    let clientX, clientY;
    if (e.touches) {
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
      e.preventDefault();
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    const x = (clientX - rect.left) * scaleX;
    const y = (clientY - rect.top) * scaleY;
    return { x: clamp(x, 0, canvas.width), y: clamp(y, 0, canvas.height) };
  }

  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (!imageObj) return;
    const pos = getCanvasCoords(e);
    isDragging = true;
    dragStartX = pos.x;
    dragStartY = pos.y;
    dragOffsetX = offsetX;
    dragOffsetY = offsetY;
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!isDragging || !imageObj) return;
    const pos = getCanvasCoords(e);
    offsetX = dragOffsetX + (pos.x - dragStartX);
    offsetY = dragOffsetY + (pos.y - dragStartY);
    redraw();
  }

  function onPointerUp() {
    isDragging = false;
  }

  // ─── Zoom ──────────────────────────────────────────────
  function onZoomChange() {
    zoomFactor = parseFloat(zoomSlider.value);
    zoomLabel.textContent = zoomFactor.toFixed(1) + 'x';
    redraw();
  }

  // ─── Upload ─────────────────────────────────────────────
  async function uploadCropped() {
    if (isUploading) return;
    isUploading = true;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Uploading…';

    try {
      const finalCanvas = document.createElement('canvas');
      finalCanvas.width = canvasSize;
      finalCanvas.height = canvasSize;
      const finalCtx = finalCanvas.getContext('2d');

      const scale = baseScale * zoomFactor;
      const imgW = imageObj.width, imgH = imageObj.height;
      const drawX = (canvasSize - imgW * scale) / 2 + offsetX;
      const drawY = (canvasSize - imgH * scale) / 2 + offsetY;
      finalCtx.drawImage(imageObj, drawX, drawY, imgW * scale, imgH * scale);

      const mimeType = targetType === 'avatar' ? 'image/jpeg' : 'image/png';
      const blob = await new Promise(resolve => finalCanvas.toBlob(resolve, mimeType, 0.92));
      if (!blob) throw new Error('Failed to create image blob');

      const formData = new FormData();
      const ext = mimeType === 'image/jpeg' ? 'jpg' : 'png';
      formData.append(targetType === 'avatar' ? 'avatar' : 'banner', blob, `cropped_${targetType}_${Date.now()}.${ext}`);

      const endpoint = targetType === 'avatar' ? '/api/users/avatar' : '/api/users/banner';
      const token = localStorage.getItem('nyxie_token');
      if (!token) throw new Error('No token');

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + token },
        body: formData
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      safeToast(`${targetType === 'avatar' ? 'Avatar' : 'Banner'} updated!`);
      // Force a fresh cache-busting token for this URL now that its
      // content has actually changed (see versionedMediaUrl in utils.js —
      // every other render reuses the memoized token so the browser can
      // cache normally instead of re-fetching on every navigation).
      if (typeof versionedMediaUrl === 'function') {
        if (targetType === 'avatar' && data.avatar) versionedMediaUrl(data.avatar, true);
        else if (targetType === 'banner' && data.banner) versionedMediaUrl(data.banner, true);
      }
      const user = JSON.parse(localStorage.getItem('nyxie_user') || '{}');
      if (targetType === 'avatar') user.avatar = data.avatar;
      else { user.banner = data.banner; user.banner_color = null; }
      localStorage.setItem('nyxie_user', JSON.stringify(user));
      if (typeof currentUser !== 'undefined') {
        if (targetType === 'avatar') currentUser.avatar = data.avatar;
        else { currentUser.banner = data.banner; currentUser.banner_color = null; }
      }
      if (typeof loadProfileForm === 'function') loadProfileForm();
      if (typeof updateAvatarUI === 'function') updateAvatarUI(data.avatar || user.avatar);
      closeCropper();
    } catch (err) {
      showError(err.message);
      safeToast('Upload error: ' + err.message);
    } finally {
      isUploading = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Crop & Upload';
    }
  }

  function closeCropper() {
    overlay.classList.remove('open');
    imageObj = null;
    isDragging = false;
    if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    document.querySelectorAll('input[type="file"]').forEach(inp => inp.value = '');
    clearError();
  }

  // ─── Bind events ──────────────────────────────────────
  function bindEvents() {
    canvas.addEventListener('mousedown', onPointerDown);
    canvas.addEventListener('touchstart', onPointerDown, { passive: false });
    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('touchmove', onPointerMove, { passive: false });
    document.addEventListener('mouseup', onPointerUp);
    document.addEventListener('touchend', onPointerUp);

    zoomSlider.addEventListener('input', onZoomChange);
    confirmBtn.addEventListener('click', uploadCropped);
    cancelBtn.addEventListener('click', closeCropper);
    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) closeCropper();
    });
    // Recompute the crop box size on rotate/resize instead of leaving a
    // stale size that could now be too wide (or leave the box smaller
    // than necessary) for the new viewport.
    window.addEventListener('resize', function() {
      if (!overlay.classList.contains('open') || !imageObj) return;
      const container = canvas.parentElement;
      const wrap = container.parentElement;
      const available = (wrap && wrap.clientWidth) || (window.innerWidth - 64);
      const size = Math.max(220, Math.min(400, Math.floor(available)));
      container.style.width = size + 'px';
      container.style.height = size + 'px';
      canvas.style.width = size + 'px';
      canvas.style.height = size + 'px';
      baseScale = computeBaseScale();
      redraw();
    });
  }

  // ─── Global exports ────────────────────────────────────
  window.openAvatarCropper = function(file) {
    if (file) initCropper(file, 'avatar');
  };
  window.openBannerCropper = function(file) {
    if (file) initCropper(file, 'banner');
  };
  window.closeCropper = closeCropper;
})();