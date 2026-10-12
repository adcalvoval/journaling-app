// Initialize the app
document.addEventListener('DOMContentLoaded', () => {
    setupAuthUI();
    checkAuth();
});

// Global state
let currentMedia = [];
let entries = [];
let currentUser = null;
let unsubscribeSnapshot = null;

// Calendar state
let currentCalendarDate = new Date();
let selectedDate = null;

// UI State
let selectedEntryId = null;
let currentViewMode = 'list'; // 'list' | 'view' | 'edit' | 'new'
let quillEditor = null;
let currentEditingEntry = null;

// Unsaved-changes tracking for the editor
let editorDirty = false;
let appInitialized = false;

// Firestore documents are capped at 1 MiB; leave headroom for metadata
const MAX_ENTRY_BYTES = 900 * 1024;
const MAX_VIDEO_BYTES = 600 * 1024;

// ========== Helpers ==========

function pad2(n) {
    return String(n).padStart(2, '0');
}

// Local-time YYYY-MM-DD (toISOString() gives the UTC date, which is off by one near midnight)
function toLocalDateString(d = new Date()) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// Parse YYYY-MM-DD as a local date (new Date('YYYY-MM-DD') is parsed as UTC midnight)
function parseEntryDate(dateStr) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
}

function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// Only allow http(s) links, blocking javascript:, data: and similar schemes
function sanitizeUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
        return null;
    }
}

// Media data must be an inline data: URL of the expected kind
function isSafeMediaData(media) {
    if (!media || typeof media.data !== 'string') return false;
    if (media.type === 'image') return media.data.startsWith('data:image/');
    if (media.type === 'video') return media.data.startsWith('data:video/');
    return false;
}

function createSafeLink(url, className) {
    const safe = sanitizeUrl(url);
    const el = document.createElement(safe ? 'a' : 'span');
    el.textContent = url;
    if (className) el.className = className;
    if (safe) {
        el.href = safe;
        el.target = '_blank';
        el.rel = 'noopener noreferrer';
    }
    return el;
}

function confirmDiscardChanges() {
    if ((currentViewMode === 'edit' || currentViewMode === 'new') && editorDirty) {
        return confirm('You have unsaved changes. Discard them?');
    }
    return true;
}

// On narrow screens the sidebar (calendar + entry list) is an overlay toggled from the header
function isNarrowScreen() {
    return window.matchMedia('(max-width: 600px)').matches;
}

function setSidebarOpen(open) {
    const sidebar = document.querySelector('.sidebar');
    const toggle = document.getElementById('sidebar-toggle');
    if (!sidebar || !toggle) return;

    if (open) {
        // Sit just below the header, whatever its height
        sidebar.style.top = document.querySelector('header').offsetHeight + 'px';
    }
    sidebar.classList.toggle('mobile-show', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? '✕ Close' : '☰ Calendar';
}

function showLoginMessage(message, isSuccess = false) {
    const el = document.getElementById('login-error');
    el.textContent = message;
    el.classList.toggle('success', isSuccess);
}

// Photo library state
let currentPhotoView = 'entries'; // 'entries' | 'photos'
let selectedMonth = 'all';
let selectedYear = 'all';
let currentLightboxIndex = 0;
let lightboxPhotos = [];

// Setup Auth UI Event Listeners
function setupAuthUI() {
    // Sign in form
    document.getElementById('signin-form-element').addEventListener('submit', handleSignIn);

    // Sign up form
    document.getElementById('signup-form-element').addEventListener('submit', handleSignUp);

    // Toggle between sign in and sign up
    document.getElementById('show-signup').addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('signin-form').style.display = 'none';
        document.getElementById('signup-form').style.display = 'block';
        showLoginMessage('');
    });

    document.getElementById('show-signin').addEventListener('click', (e) => {
        e.preventDefault();
        document.getElementById('signup-form').style.display = 'none';
        document.getElementById('signin-form').style.display = 'block';
        showLoginMessage('');
    });

    // Forgot password
    document.getElementById('forgot-password').addEventListener('click', handleForgotPassword);

    // Migration modal buttons
    document.getElementById('migrate-yes').addEventListener('click', () => {
        migrateLocalStorageToFirebase();
    });

    document.getElementById('migrate-no').addEventListener('click', () => {
        document.getElementById('migration-modal').style.display = 'none';
        localStorage.removeItem('journalPassword'); // Clean up old password
    });
}

// Firebase Authentication
function checkAuth() {
    // Listen for auth state changes
    auth.onAuthStateChanged((user) => {
        if (user) {
            currentUser = user;
            showApp();
        } else {
            currentUser = null;
            showLogin();
        }
    });
}

function showLogin() {
    document.getElementById('login-container').style.display = 'flex';
    document.getElementById('app-container').style.display = 'none';
    document.getElementById('migration-modal').style.display = 'none';

    // Stop listening to Firestore if logged out
    if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
    }
}

async function showApp() {
    document.getElementById('login-container').style.display = 'none';
    document.getElementById('app-container').style.display = 'block';
    document.getElementById('user-email').textContent = currentUser.email || '';

    // Check for localStorage migration
    await checkForMigration();

    // Wire up the UI once; onAuthStateChanged can fire more than once per page load
    if (!appInitialized) {
        initApp();
        appInitialized = true;
    }

    // Load entries from Firestore and setup real-time sync
    setupRealtimeSync();
}

// Sign In
async function handleSignIn(e) {
    e.preventDefault();
    const email = document.getElementById('signin-email').value.trim();
    const password = document.getElementById('signin-password').value;

    try {
        await auth.signInWithEmailAndPassword(email, password);
        showLoginMessage('');
        document.getElementById('signin-password').value = '';
    } catch (error) {
        console.error('Sign in error:', error.code);
        switch (error.code) {
            case 'auth/user-not-found':
            case 'auth/wrong-password':
            case 'auth/invalid-credential':
            case 'auth/invalid-login-credentials':
                // One message for both cases so the form doesn't reveal which emails have accounts
                showLoginMessage('Incorrect email or password.');
                break;
            case 'auth/invalid-email':
                showLoginMessage('Invalid email address.');
                break;
            case 'auth/too-many-requests':
                showLoginMessage('Too many failed attempts. Try again later.');
                break;
            case 'auth/network-request-failed':
                showLoginMessage('Network error. Check your connection and try again.');
                break;
            default:
                showLoginMessage('Sign in failed. Please try again.');
        }
    }
}

// Sign Up
async function handleSignUp(e) {
    e.preventDefault();
    const email = document.getElementById('signup-email').value.trim();
    const password = document.getElementById('signup-password').value;

    if (password.length < 8) {
        showLoginMessage('Password must be at least 8 characters.');
        return;
    }

    try {
        await auth.createUserWithEmailAndPassword(email, password);
        showLoginMessage('');
        document.getElementById('signup-password').value = '';
    } catch (error) {
        console.error('Sign up error:', error.code);
        switch (error.code) {
            case 'auth/email-already-in-use':
                showLoginMessage('Could not create an account with this email. Try signing in instead.');
                break;
            case 'auth/invalid-email':
                showLoginMessage('Invalid email address.');
                break;
            case 'auth/weak-password':
            case 'auth/password-does-not-meet-requirements':
                showLoginMessage('Password is too weak. Use a longer password with a mix of characters.');
                break;
            case 'auth/operation-not-allowed':
            case 'auth/admin-restricted-operation':
                showLoginMessage('New account registration is disabled.');
                break;
            default:
                showLoginMessage('Sign up failed. Please try again.');
        }
    }
}

// Forgot Password
async function handleForgotPassword(e) {
    e.preventDefault();
    const email = document.getElementById('signin-email').value.trim();

    const resetSentMessage = 'If an account exists for this email, a reset link has been sent.';

    if (!email) {
        showLoginMessage('Enter your email address above, then click "Forgot password?" again.');
        return;
    }

    try {
        await auth.sendPasswordResetEmail(email);
        showLoginMessage(resetSentMessage, true);
    } catch (error) {
        console.error('Password reset error:', error.code);
        if (error.code === 'auth/user-not-found') {
            // Don't reveal whether the account exists
            showLoginMessage(resetSentMessage, true);
        } else if (error.code === 'auth/invalid-email') {
            showLoginMessage('Invalid email address.');
        } else {
            showLoginMessage('Failed to send password reset email. Please try again.');
        }
    }
}

// Logout
async function logout() {
    if (!confirmDiscardChanges()) return;

    if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
        unsubscribeSnapshot = null;
    }

    try {
        await auth.signOut();
    } catch (error) {
        console.error('Logout error:', error);
        alert('Failed to log out. Please try again.');
        return;
    }

    // Remove the offline copy of the journal from this device (IndexedDB cache)
    try {
        await db.terminate();
        await db.clearPersistence();
    } catch (error) {
        // Fails if the app is open in another tab; it is cleared on a later logout
        console.warn('Could not clear offline cache:', error.code || error);
    }

    // Reload so no entries stay in memory or in the hidden DOM
    window.location.reload();
}

// Calendar Functions
function initCalendar() {
    renderCalendar();

    // Event listeners
    document.getElementById('calendar-prev').addEventListener('click', () => {
        currentCalendarDate.setMonth(currentCalendarDate.getMonth() - 1);
        renderCalendar();
    });

    document.getElementById('calendar-next').addEventListener('click', () => {
        currentCalendarDate.setMonth(currentCalendarDate.getMonth() + 1);
        renderCalendar();
    });

    document.getElementById('clear-date-filter').addEventListener('click', () => {
        selectedDate = null;
        document.getElementById('clear-date-filter').style.display = 'none';
        renderCalendar();
        displayEntryList();
    });
}

function renderCalendar() {
    const year = currentCalendarDate.getFullYear();
    const month = currentCalendarDate.getMonth();

    // Update header
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                        'July', 'August', 'September', 'October', 'November', 'December'];
    document.getElementById('calendar-month-year').textContent = `${monthNames[month]} ${year}`;

    // Get first day of month and number of days
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();

    // Get dates that have entries
    const entryDates = new Set(entries.map(entry => entry.date));

    // Build calendar days
    const calendarDaysEl = document.getElementById('calendar-days');
    calendarDaysEl.innerHTML = '';

    // Previous month's trailing days
    for (let i = firstDay - 1; i >= 0; i--) {
        const day = daysInPrevMonth - i;
        const dayEl = createCalendarDay(day, true, null);
        calendarDaysEl.appendChild(dayEl);
    }

    // Current month's days
    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const hasEntry = entryDates.has(dateStr);
        const isToday = dateStr === toLocalDateString();
        const isSelected = dateStr === selectedDate;

        const dayEl = createCalendarDay(day, false, dateStr, hasEntry, isToday, isSelected);
        calendarDaysEl.appendChild(dayEl);
    }

    // Next month's leading days
    const totalCells = calendarDaysEl.children.length;
    const remainingCells = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let day = 1; day <= remainingCells; day++) {
        const dayEl = createCalendarDay(day, true, null);
        calendarDaysEl.appendChild(dayEl);
    }
}

function createCalendarDay(day, isOtherMonth, dateStr, hasEntry = false, isToday = false, isSelected = false) {
    const dayEl = document.createElement('div');
    dayEl.className = 'calendar-day';
    dayEl.textContent = day;

    if (isOtherMonth) {
        dayEl.classList.add('other-month');
    }

    if (isToday) {
        dayEl.classList.add('today');
    }

    if (hasEntry) {
        dayEl.classList.add('has-entry');
    }

    if (isSelected) {
        dayEl.classList.add('selected');
    }

    // Add click handler for current month days only
    if (!isOtherMonth && dateStr) {
        dayEl.addEventListener('click', () => handleDateClick(dateStr));
    }

    return dayEl;
}

function handleDateClick(dateStr) {
    selectedDate = dateStr;

    // Show clear filter button
    const clearBtn = document.getElementById('clear-date-filter');
    if (clearBtn) clearBtn.style.display = 'block';

    // Re-render calendar to show selected state
    renderCalendar();

    // Show the entries tab filtered by this date
    if (currentPhotoView !== 'entries') switchTab('entries');
    displayEntryList();
}

// ========== Photo Library Functions ==========

// Switch between entries and photos view
function switchTab(tabName) {
    currentPhotoView = tabName;

    // Update tab buttons
    document.querySelectorAll('.sidebar-tab').forEach(tab => {
        tab.classList.remove('active');
    });
    document.querySelector(`[data-tab="${tabName}"]`).classList.add('active');

    // Show/hide content
    if (tabName === 'entries') {
        document.getElementById('entries-view').style.display = 'block';
        document.getElementById('photos-view').style.display = 'none';
        document.getElementById('new-entry-btn').style.display = 'flex';
    } else if (tabName === 'photos') {
        document.getElementById('entries-view').style.display = 'none';
        document.getElementById('photos-view').style.display = 'block';
        document.getElementById('new-entry-btn').style.display = 'none';
        displayPhotoLibrary();
    }
}

// Get all photos with metadata
function getAllPhotos() {
    const allPhotos = [];

    entries.forEach(entry => allPhotos.push(...getEntryPhotos(entry)));

    // Sort by date (newest first)
    allPhotos.sort((a, b) => b.entryDate.localeCompare(a.entryDate));

    return allPhotos;
}

// Images and videos of a single entry, with entry metadata for the lightbox
function getEntryPhotos(entry) {
    return (entry.media || [])
        .map((media, index) => ({
            ...media,
            entryId: entry.id,
            entryDate: entry.date,
            entryText: entry.text || '',
            mediaIndex: index
        }))
        .filter(isSafeMediaData);
}

// Filter photos by month/year
function filterPhotos(photos) {
    return photos.filter(photo => {
        const photoDate = parseEntryDate(photo.entryDate);

        // Check month filter
        if (selectedMonth !== 'all') {
            if (photoDate.getMonth() !== parseInt(selectedMonth)) {
                return false;
            }
        }

        // Check year filter
        if (selectedYear !== 'all') {
            if (photoDate.getFullYear() !== parseInt(selectedYear)) {
                return false;
            }
        }

        return true;
    });
}

// Display photo library grid
function displayPhotoLibrary() {
    const allPhotos = getAllPhotos();
    const filteredPhotos = filterPhotos(allPhotos);

    // Update count
    const countText = document.getElementById('photo-count-text');
    const count = filteredPhotos.length;
    countText.textContent = `${count} ${count === 1 ? 'photo' : 'photos'}`;

    // Populate year dropdown
    populateYearFilter(allPhotos);

    // Display grid
    const container = document.getElementById('photos-grid-container');
    container.innerHTML = '';

    if (filteredPhotos.length === 0) {
        container.innerHTML = '<div class="no-entries">No photos found</div>';
        return;
    }

    filteredPhotos.forEach((photo, index) => {
        const item = createPhotoGridItem(photo, index);
        container.appendChild(item);
    });

    // Store for lightbox navigation
    lightboxPhotos = filteredPhotos;
}

// Create photo grid item
function createPhotoGridItem(photo, index) {
    const item = document.createElement('div');
    item.className = 'photo-grid-item';
    if (photo.type === 'video') {
        item.classList.add('is-video');
    }

    // Format date
    const date = parseEntryDate(photo.entryDate);
    const formattedDate = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric'
    });

    const mediaEl = document.createElement(photo.type === 'video' ? 'video' : 'img');
    mediaEl.src = photo.data;
    if (photo.type === 'image') {
        mediaEl.alt = `Photo from ${formattedDate}`;
        mediaEl.loading = 'lazy';
    } else {
        mediaEl.preload = 'metadata';
    }

    const badge = document.createElement('div');
    badge.className = 'photo-date-badge';
    badge.textContent = formattedDate;

    item.append(mediaEl, badge);

    item.addEventListener('click', () => openLightbox(index));

    return item;
}

// Populate year filter dropdown
function populateYearFilter(photos) {
    const years = new Set();
    photos.forEach(photo => {
        const year = parseEntryDate(photo.entryDate).getFullYear();
        years.add(year);
    });

    const yearSelect = document.getElementById('filter-year');
    // Keep "All Years" option
    const options = ['<option value="all">All Years</option>'];

    Array.from(years)
        .sort((a, b) => b - a)
        .forEach(year => {
            options.push(`<option value="${year}">${year}</option>`);
        });

    yearSelect.innerHTML = options.join('');
    yearSelect.value = selectedYear;
}

// Open lightbox at specific photo
function openLightbox(index, photos = lightboxPhotos) {
    lightboxPhotos = photos;
    currentLightboxIndex = index;
    const photo = lightboxPhotos[index];

    const modal = document.getElementById('photo-lightbox');
    modal.style.display = 'flex';

    displayLightboxPhoto(photo);

    // Add keyboard navigation
    document.addEventListener('keydown', handleLightboxKeyboard);
}

// Display photo in lightbox
function displayLightboxPhoto(photo) {
    const img = document.getElementById('lightbox-image');
    const video = document.getElementById('lightbox-video');

    if (photo.type === 'image') {
        img.src = photo.data;
        img.style.display = 'block';
        video.style.display = 'none';
    } else if (photo.type === 'video') {
        video.src = photo.data;
        video.style.display = 'block';
        img.style.display = 'none';
    }

    // Set entry info
    const date = parseEntryDate(photo.entryDate);
    const formattedDate = date.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
    });

    document.querySelector('.lightbox-date').textContent = formattedDate;

    const textPreview = photo.entryText.substring(0, 200);
    document.querySelector('.lightbox-text').textContent =
        textPreview + (photo.entryText.length > 200 ? '...' : '');

    // View full entry button
    document.getElementById('lightbox-view-entry').onclick = () => {
        closeLightbox();
        switchTab('entries');
        selectEntry(photo.entryId);
    };

    // Update navigation button states
    updateLightboxNavButtons();
}

// Navigate lightbox
function navigateLightbox(direction) {
    currentLightboxIndex += direction;

    // Wrap around
    if (currentLightboxIndex < 0) {
        currentLightboxIndex = lightboxPhotos.length - 1;
    } else if (currentLightboxIndex >= lightboxPhotos.length) {
        currentLightboxIndex = 0;
    }

    displayLightboxPhoto(lightboxPhotos[currentLightboxIndex]);
}

// Update navigation button states
function updateLightboxNavButtons() {
    const prevBtn = document.querySelector('.lightbox-prev');
    const nextBtn = document.querySelector('.lightbox-next');

    // For wrap-around, always show buttons
    prevBtn.style.display = 'flex';
    nextBtn.style.display = 'flex';
}

// Handle keyboard navigation in lightbox
function handleLightboxKeyboard(e) {
    if (e.key === 'Escape') {
        closeLightbox();
    } else if (e.key === 'ArrowLeft') {
        navigateLightbox(-1);
    } else if (e.key === 'ArrowRight') {
        navigateLightbox(1);
    }
}

// Close lightbox
function closeLightbox() {
    document.getElementById('photo-lightbox').style.display = 'none';
    document.removeEventListener('keydown', handleLightboxKeyboard);

    // Stop video if playing
    const video = document.getElementById('lightbox-video');
    video.pause();
    video.currentTime = 0;
}

// ========== End Photo Library Functions ==========

// Initialize Quill editor
function initQuillEditor() {
    quillEditor = new Quill('#quill-editor', {
        theme: 'snow',
        modules: {
            toolbar: [
                [{ 'header': [1, 2, 3, false] }],
                ['bold', 'italic', 'underline', 'strike'],
                [{ 'list': 'ordered'}, { 'list': 'bullet' }],
                ['blockquote', 'code-block'],
                ['link'],
                ['clean']
            ]
        },
        placeholder: 'Write your thoughts here...'
    });

    quillEditor.on('text-change', (delta, oldDelta, source) => {
        if (source === 'user') editorDirty = true;
    });
}

// Display entries as compact list items in sidebar
function displayEntryList() {
    const container = document.getElementById('entry-list-container');
    if (!container) return;

    container.innerHTML = '';

    // Respect the calendar date filter, if any
    const visibleEntries = selectedDate ? entries.filter(entry => entry.date === selectedDate) : entries;

    if (visibleEntries.length === 0) {
        container.innerHTML = selectedDate
            ? '<div class="no-entries">No entries for this date</div>'
            : '<div class="no-entries">No entries yet. Create your first entry!</div>';
        return;
    }

    // Sort by date (newest first)
    const sortedEntries = [...visibleEntries].sort((a, b) => b.date.localeCompare(a.date));

    sortedEntries.forEach(entry => {
        const item = createEntryListItem(entry);
        container.appendChild(item);
    });
}

// Create compact entry list item
function createEntryListItem(entry) {
    const item = document.createElement('div');
    item.className = 'entry-list-item';
    if (entry.id === selectedEntryId) {
        item.classList.add('selected');
    }

    // Format date
    const date = parseEntryDate(entry.date);
    const formattedDate = date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
    });

    // Get text preview (first 100 chars)
    const textPreview = entry.text ? entry.text.substring(0, 100) : 'No text';

    // Get first image thumbnail
    const firstImage = (entry.media || []).find(m => m.type === 'image' && isSafeMediaData(m));
    const thumbnail = firstImage ? firstImage.data : null;

    // Count media
    const mediaCount = entry.media ? entry.media.length : 0;

    // Build HTML (all user content is escaped)
    item.innerHTML = `
        <div class="entry-list-date">${escapeHtml(formattedDate)}</div>
        <div class="entry-list-preview">
            ${thumbnail ? `<img src="${escapeHtml(thumbnail)}" class="entry-list-thumbnail" alt="Entry thumbnail" loading="lazy">` : ''}
            <div class="entry-list-text">
                <p>${escapeHtml(textPreview)}</p>
                ${mediaCount > 0 ? `<div class="entry-list-meta"><span>📎 ${mediaCount} media</span></div>` : ''}
            </div>
        </div>
    `;

    item.addEventListener('click', () => {
        selectEntry(entry.id);
    });

    return item;
}

// Select an entry and show detail view
function selectEntry(entryId, { skipConfirm = false } = {}) {
    if (!skipConfirm && !confirmDiscardChanges()) return;
    editorDirty = false;

    selectedEntryId = entryId;
    currentViewMode = 'view';

    // Update list selection
    displayEntryList();

    // Show entry detail
    // Get the overlay out of the way so the entry is visible on small screens
    setSidebarOpen(false);

    const entry = entries.find(e => e.id === entryId);
    if (!entry) return;

    displayEntryDetail(entry);
}

// Display full entry in detail pane
function displayEntryDetail(entry) {
    // Hide other panes
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('entry-editor').style.display = 'none';
    document.getElementById('entry-detail').style.display = 'block';

    // Format date
    const date = parseEntryDate(entry.date);
    const formattedDate = date.toLocaleDateString('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
    });

    // Set date
    document.querySelector('.detail-date').textContent = formattedDate;

    const entryPhotos = getEntryPhotos(entry);

    // Set text content (check for rich content first)
    const detailText = document.getElementById('detail-text');
    if (entry.content && entry.content.ops) {
        // Rich text content (Quill Delta)
        const tempQuill = new Quill(document.createElement('div'));
        tempQuill.setContents(entry.content);
        detailText.innerHTML = tempQuill.root.innerHTML;
    } else {
        // Plain text
        detailText.textContent = entry.text || '';
    }

    // Display media
    const detailMedia = document.getElementById('detail-media');
    detailMedia.innerHTML = '';

    if (entry.media && entry.media.length > 0) {
        entry.media.forEach((item, mediaIndex) => {
            if (item.type === 'url') {
                detailMedia.appendChild(createSafeLink(item.data, 'entry-url'));
                return;
            }
            if (!isSafeMediaData(item)) return;

            if (item.type === 'image') {
                const img = document.createElement('img');
                img.src = item.data;
                img.alt = 'Entry image';
                // Browsers block opening data: URLs in a new tab, so show it in the lightbox
                const photoIndex = entryPhotos.findIndex(p => p.mediaIndex === mediaIndex);
                img.addEventListener('click', () => openLightbox(photoIndex, entryPhotos));
                detailMedia.appendChild(img);
            } else if (item.type === 'video') {
                const video = document.createElement('video');
                video.src = item.data;
                video.controls = true;
                video.style.width = '100%';
                video.style.borderRadius = '12px';
                detailMedia.appendChild(video);
            }
        });
    }

    // Setup action buttons
    document.getElementById('edit-entry-btn').onclick = () => editEntry(entry);
    document.getElementById('delete-entry-btn').onclick = () => deleteEntry(entry.id);
    document.getElementById('download-entry-btn').onclick = () => downloadEntryAsPDF(entry);
}

// Show editor for new entry
function showNewEntryEditor() {
    if (!confirmDiscardChanges()) return;

    setSidebarOpen(false);

    selectedEntryId = null;
    currentViewMode = 'new';
    currentEditingEntry = null;

    // Update list selection
    displayEntryList();

    // Show editor pane
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('entry-detail').style.display = 'none';
    document.getElementById('entry-editor').style.display = 'block';

    // Set default date to today (or the date selected in the calendar)
    document.getElementById('editor-date').value = selectedDate || toLocalDateString();

    // Clear editor
    quillEditor.setContents([]);
    currentMedia = [];
    editorDirty = false;
    const previewEl = document.getElementById('editor-media-preview');
    if (previewEl) previewEl.innerHTML = '';

    // Setup buttons
    document.getElementById('cancel-edit-btn').onclick = cancelEdit;
    document.getElementById('save-edit-btn').onclick = saveCurrentEntry;
}

// Show editor for editing existing entry
function editEntry(entry) {
    selectedEntryId = entry.id;
    currentViewMode = 'edit';
    currentEditingEntry = entry;

    // Show editor pane
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('entry-detail').style.display = 'none';
    document.getElementById('entry-editor').style.display = 'block';

    // Load entry data
    document.getElementById('editor-date').value = entry.date;

    // Load content into Quill
    if (entry.content && entry.content.ops) {
        quillEditor.setContents(entry.content);
    } else {
        quillEditor.setText(entry.text || '');
    }

    // Load media
    currentMedia = entry.media ? [...entry.media] : [];
    displayMediaPreview();
    editorDirty = false;

    // Setup buttons
    document.getElementById('cancel-edit-btn').onclick = cancelEdit;
    document.getElementById('save-edit-btn').onclick = saveCurrentEntry;
}

// Approximate serialized size of an entry, to stay under Firestore's 1 MiB document limit
function estimateEntryBytes(entryData) {
    return new Blob([JSON.stringify(entryData)]).size;
}

// Save current entry (new or edit)
async function saveCurrentEntry() {
    const date = document.getElementById('editor-date').value;
    const content = quillEditor.getContents(); // Quill Delta format
    const text = quillEditor.getText().trim(); // Plain text for backward compat

    // Validation
    if (!date) {
        alert('Please select a date');
        return;
    }

    if (!text && currentMedia.length === 0) {
        alert('Please add some content or media');
        return;
    }

    if (!currentUser) {
        alert('You must be signed in to save entries');
        return;
    }

    const entryData = {
        date: date,
        text: text, // Plain text for backward compatibility
        content: { ops: content.ops }, // Rich text Delta format (plain object)
        media: currentMedia
    };

    const sizeBytes = estimateEntryBytes(entryData);
    if (sizeBytes > MAX_ENTRY_BYTES) {
        alert(`This entry is too large to save (${Math.round(sizeBytes / 1024)} KB, limit ${Math.round(MAX_ENTRY_BYTES / 1024)} KB).\n\nRemove some images or videos, or add videos as a URL link instead.`);
        return;
    }

    entryData.updatedAt = firebase.firestore.FieldValue.serverTimestamp();

    const saveBtn = document.getElementById('save-edit-btn');
    saveBtn.disabled = true;

    try {
        const collection = db.collection(`users/${currentUser.uid}/entries`);
        let docRef;
        let writePromise;

        if (currentViewMode === 'new') {
            entryData.createdAt = firebase.firestore.FieldValue.serverTimestamp();
            docRef = collection.doc();
            writePromise = docRef.set(entryData);
        } else if (currentViewMode === 'edit') {
            docRef = collection.doc(currentEditingEntry.id);
            writePromise = docRef.update(entryData);
        } else {
            return;
        }

        // Firestore applies the write locally right away; switch to view mode without
        // waiting for the server so saving also works while offline
        editorDirty = false;
        selectEntry(docRef.id, { skipConfirm: true });

        await writePromise;
    } catch (error) {
        console.error('Error saving entry:', error);
        alert('Failed to save entry: ' + error.message);
    } finally {
        saveBtn.disabled = false;
    }
}

// Cancel edit
function cancelEdit() {
    if (!confirmDiscardChanges()) return;
    editorDirty = false;

    if (currentViewMode === 'edit' && currentEditingEntry) {
        selectEntry(currentEditingEntry.id);
    } else {
        // Return to empty state
        selectedEntryId = null;
        currentViewMode = 'list';
        displayEntryList();
        showEmptyState();
    }
}

// Show empty state
function showEmptyState() {
    document.getElementById('empty-state').style.display = 'flex';
    document.getElementById('entry-detail').style.display = 'none';
    document.getElementById('entry-editor').style.display = 'none';

    // Nothing to show in the main pane, so on small screens show the calendar and list instead
    if (isNarrowScreen()) setSidebarOpen(true);
}

function initApp() {
    // Set current date in header
    const currentDateEl = document.getElementById('current-date');
    currentDateEl.textContent = new Date().toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });

    // Initialize Quill editor
    initQuillEditor();

    // Event listeners for editor
    const newEntryBtn = document.getElementById('new-entry-btn');
    if (newEntryBtn) newEntryBtn.addEventListener('click', showNewEntryEditor);

    const editorImageUpload = document.getElementById('editor-image-upload');
    if (editorImageUpload) editorImageUpload.addEventListener('change', handleImageUpload);

    const editorVideoUpload = document.getElementById('editor-video-upload');
    if (editorVideoUpload) editorVideoUpload.addEventListener('change', handleVideoUpload);

    const editorAddUrlBtn = document.getElementById('editor-add-url-btn');
    if (editorAddUrlBtn) editorAddUrlBtn.addEventListener('click', handleAddURL);

    // Keep existing listeners for logout and download
    document.getElementById('logout-btn').addEventListener('click', logout);

    const downloadAllBtn = document.getElementById('download-all-btn');
    if (downloadAllBtn) downloadAllBtn.addEventListener('click', downloadAllAsPDF);

    // Photo library tab switching
    const tabEntriesBtn = document.getElementById('tab-entries');
    if (tabEntriesBtn) tabEntriesBtn.addEventListener('click', () => switchTab('entries'));

    const tabPhotosBtn = document.getElementById('tab-photos');
    if (tabPhotosBtn) tabPhotosBtn.addEventListener('click', () => switchTab('photos'));

    // Photo filters
    const filterMonth = document.getElementById('filter-month');
    if (filterMonth) filterMonth.addEventListener('change', (e) => {
        selectedMonth = e.target.value;
        displayPhotoLibrary();
    });

    const filterYear = document.getElementById('filter-year');
    if (filterYear) filterYear.addEventListener('change', (e) => {
        selectedYear = e.target.value;
        displayPhotoLibrary();
    });

    // Lightbox controls
    const lightboxClose = document.querySelector('.lightbox-close');
    if (lightboxClose) lightboxClose.addEventListener('click', closeLightbox);

    const lightboxOverlay = document.querySelector('.lightbox-overlay');
    if (lightboxOverlay) lightboxOverlay.addEventListener('click', closeLightbox);

    const lightboxPrev = document.querySelector('.lightbox-prev');
    if (lightboxPrev) lightboxPrev.addEventListener('click', () => navigateLightbox(-1));

    const lightboxNext = document.querySelector('.lightbox-next');
    if (lightboxNext) lightboxNext.addEventListener('click', () => navigateLightbox(1));

    document.getElementById('sidebar-toggle').addEventListener('click', () => {
        const isOpen = document.querySelector('.sidebar').classList.contains('mobile-show');
        setSidebarOpen(!isOpen);
    });

    const editorDate = document.getElementById('editor-date');
    if (editorDate) editorDate.addEventListener('change', () => { editorDirty = true; });

    // Warn before closing the tab with unsaved writing
    window.addEventListener('beforeunload', (e) => {
        if ((currentViewMode === 'edit' || currentViewMode === 'new') && editorDirty) {
            e.preventDefault();
            e.returnValue = '';
        }
    });

    // Display entries
    displayEntryList();
    showEmptyState();

    // Initialize calendar
    initCalendar();
}

// Compress image helper function
function compressImage(file, maxWidth = 1200, maxHeight = 1200, quality = 0.8) {
    return new Promise((resolve, reject) => {
        // Check file size - warn if over 5MB
        if (file.size > 5 * 1024 * 1024) {
            if (!confirm('This image is quite large. It will be compressed to prevent issues. Continue?')) {
                reject('User cancelled large file upload');
                return;
            }
        }

        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                // Calculate new dimensions
                if (width > height) {
                    if (width > maxWidth) {
                        height = Math.round((height * maxWidth) / width);
                        width = maxWidth;
                    }
                } else {
                    if (height > maxHeight) {
                        width = Math.round((width * maxHeight) / height);
                        height = maxHeight;
                    }
                }

                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d');
                // White background so transparent PNGs don't turn black as JPEG
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, width, height);
                ctx.drawImage(img, 0, 0, width, height);

                // Convert to compressed JPEG
                const compressedDataUrl = canvas.toDataURL('image/jpeg', quality);
                resolve(compressedDataUrl);
            };
            img.onerror = () => reject('Failed to load image');
            img.src = event.target.result;
        };
        reader.onerror = () => reject('Failed to read file');
        reader.readAsDataURL(file);
    });
}

// Handle image upload
async function handleImageUpload(e) {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (let file of files) {
        if (!file.type.startsWith('image/')) {
            alert(`"${file.name}" is not an image.`);
            continue;
        }
        try {
            const compressedImage = await compressImage(file);
            currentMedia.push({
                type: 'image',
                data: compressedImage
            });
            editorDirty = true;
            displayMediaPreview();
        } catch (error) {
            console.error('Error processing image:', error);
            if (error !== 'User cancelled large file upload') {
                alert('Failed to process image: ' + error + '\n\nPlease try a different image or a smaller file.');
            }
        }
    }

    // Clear the input so the same file can be selected again
    e.target.value = '';
}

// Handle video upload
function handleVideoUpload(e) {
    const files = e.target.files;

    for (let file of files) {
        if (!file.type.startsWith('video/')) {
            alert(`"${file.name}" is not a video.`);
            continue;
        }

        // Videos are stored inline in the entry document, which Firestore caps at 1 MiB
        if (file.size > MAX_VIDEO_BYTES) {
            alert(`"${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Videos must be under ${Math.round(MAX_VIDEO_BYTES / 1024)} KB.\n\nUpload it to a video service and add it as a URL instead.`);
            continue;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                currentMedia.push({
                    type: 'video',
                    data: event.target.result
                });
                editorDirty = true;
                displayMediaPreview();
            } catch (error) {
                console.error('Error processing video:', error);
                alert('Failed to process video. The file may be too large. Try using a URL link instead.');
            }
        };
        reader.onerror = () => {
            alert('Failed to read video file.');
        };
        reader.readAsDataURL(file);
    }

    // Clear the input
    e.target.value = '';
}

// Handle URL addition
function handleAddURL() {
    const urlInput = document.getElementById('editor-url-input');
    if (!urlInput) return;

    let url = urlInput.value.trim();
    if (!url) return;

    // Accept "example.com" by assuming https
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) {
        url = 'https://' + url;
    }

    const safeUrl = sanitizeUrl(url);
    if (!safeUrl) {
        alert('Please enter a valid http:// or https:// link.');
        return;
    }

    currentMedia.push({
        type: 'url',
        data: safeUrl
    });
    editorDirty = true;
    urlInput.value = '';
    displayMediaPreview();
}

// Display media preview
function displayMediaPreview() {
    const previewContainer = document.getElementById('editor-media-preview');
    if (!previewContainer) return;

    previewContainer.innerHTML = '';

    currentMedia.forEach((media, index) => {
        const mediaItem = document.createElement('div');
        mediaItem.className = 'media-item';

        if (media.type === 'url') {
            mediaItem.appendChild(createSafeLink(media.data, 'url-link'));
        } else if (isSafeMediaData(media) && media.type === 'image') {
            const img = document.createElement('img');
            img.src = media.data;
            mediaItem.appendChild(img);
        } else if (isSafeMediaData(media) && media.type === 'video') {
            const video = document.createElement('video');
            video.src = media.data;
            video.controls = true;
            mediaItem.appendChild(video);
        }

        const removeBtn = document.createElement('button');
        removeBtn.className = 'remove-media';
        removeBtn.textContent = '×';
        removeBtn.setAttribute('aria-label', 'Remove media');
        removeBtn.onclick = () => removeMedia(index);
        mediaItem.appendChild(removeBtn);

        previewContainer.appendChild(mediaItem);
    });
}

// Remove media item
function removeMedia(index) {
    currentMedia.splice(index, 1);
    editorDirty = true;
    displayMediaPreview();
}

// Setup real-time sync with Firestore
function setupRealtimeSync() {
    if (!currentUser) return;

    // Unsubscribe from previous listener if exists
    if (unsubscribeSnapshot) {
        unsubscribeSnapshot();
    }

    // Listen to real-time updates
    unsubscribeSnapshot = db.collection(`users/${currentUser.uid}/entries`)
        .orderBy('date', 'desc')
        .onSnapshot((snapshot) => {
            entries = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data()
            }));

            displayEntryList(); // Update sidebar list
            renderCalendar(); // Update calendar

            // If in photos view, refresh photo library
            if (currentPhotoView === 'photos') {
                displayPhotoLibrary();
            }

            // If viewing an entry, refresh the detail view
            if (currentViewMode === 'view' && selectedEntryId) {
                const entry = entries.find(e => e.id === selectedEntryId);
                if (entry) {
                    displayEntryDetail(entry);
                }
            }
        }, (error) => {
            console.error('Error fetching entries:', error);
        });
}

// Read legacy entries from localStorage, ignoring corrupt or malformed data
function readLocalEntries() {
    try {
        const parsed = JSON.parse(localStorage.getItem('journalEntries') || '[]');
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(entry => entry && /^\d{4}-\d{2}-\d{2}$/.test(entry.date));
    } catch (error) {
        console.warn('Ignoring unreadable local entries:', error);
        return [];
    }
}

// Check for localStorage data and offer migration
async function checkForMigration() {
    const entriesArray = readLocalEntries();

    if (entriesArray.length > 0) {
        // Show migration modal
        const message = `We found ${entriesArray.length} ${entriesArray.length === 1 ? 'entry' : 'entries'} on this device. Would you like to import ${entriesArray.length === 1 ? 'it' : 'them'} to your cloud account?`;
        document.getElementById('migration-message').textContent = message;
        document.getElementById('migration-modal').style.display = 'flex';
    }
}

// Migrate localStorage entries to Firestore
async function migrateLocalStorageToFirebase() {
    const entriesArray = readLocalEntries();

    if (entriesArray.length === 0 || !currentUser) {
        document.getElementById('migration-modal').style.display = 'none';
        return;
    }

    try {
        document.getElementById('migration-message').textContent = `Importing ${entriesArray.length} entries...`;

        // Firestore batches are limited to 500 writes
        const BATCH_SIZE = 400;
        for (let i = 0; i < entriesArray.length; i += BATCH_SIZE) {
            const batch = db.batch();

            entriesArray.slice(i, i + BATCH_SIZE).forEach(entry => {
                const docRef = db.collection(`users/${currentUser.uid}/entries`).doc();
                const timestamp = entry.timestamp ? new Date(entry.timestamp) : null;
                batch.set(docRef, {
                    date: entry.date,
                    text: typeof entry.text === 'string' ? entry.text : '',
                    media: Array.isArray(entry.media) ? entry.media : [],
                    createdAt: timestamp && !isNaN(timestamp)
                        ? firebase.firestore.Timestamp.fromDate(timestamp)
                        : firebase.firestore.FieldValue.serverTimestamp(),
                    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
                });
            });

            await batch.commit();
        }

        // Clear localStorage after successful migration
        localStorage.removeItem('journalEntries');
        localStorage.removeItem('journalPassword');

        document.getElementById('migration-modal').style.display = 'none';
        alert(`Successfully imported ${entriesArray.length} ${entriesArray.length === 1 ? 'entry' : 'entries'}!`);
    } catch (error) {
        console.error('Migration error:', error);
        alert('Failed to import entries. Please try again.');
    }
}

// Delete entry from Firestore
async function deleteEntry(id) {
    if (!confirm('Are you sure you want to delete this entry?')) {
        return;
    }

    if (!currentUser) {
        alert('You must be signed in to delete entries.');
        return;
    }

    try {
        const deletePromise = db.collection(`users/${currentUser.uid}/entries`).doc(id).delete();

        // Don't keep showing an entry that no longer exists
        if (selectedEntryId === id) {
            selectedEntryId = null;
            currentViewMode = 'list';
            showEmptyState();
        }

        // The list refreshes via the real-time listener
        await deletePromise;
    } catch (error) {
        console.error('Failed to delete entry:', error);
        alert('Failed to delete entry. Please try again.');
    }
}

// PDF Download Functions
async function downloadEntryAsPDF(entry) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 20;
    const maxWidth = pageWidth - 2 * margin;
    let yPosition = 20;

    // Add title
    doc.setFontSize(20);
    doc.setTextColor(102, 126, 234);
    doc.text('My Journal', margin, yPosition);
    yPosition += 15;

    // Add date
    doc.setFontSize(14);
    doc.setTextColor(0, 0, 0);
    const entryDate = parseEntryDate(entry.date);
    const dateText = entryDate.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    doc.text(dateText, margin, yPosition);
    yPosition += 15;

    // Add text content
    if (entry.text) {
        doc.setFontSize(12);
        const lines = doc.splitTextToSize(entry.text, maxWidth);
        lines.forEach(line => {
            if (yPosition > 270) {
                doc.addPage();
                yPosition = 20;
            }
            doc.text(line, margin, yPosition);
            yPosition += 7;
        });
        yPosition += 10;
    }

    // Add media information
    if (entry.media && entry.media.length > 0) {
        doc.setFontSize(14);
        doc.setTextColor(118, 75, 162);

        if (yPosition > 260) {
            doc.addPage();
            yPosition = 20;
        }

        doc.text('Attached Media:', margin, yPosition);
        yPosition += 10;

        doc.setFontSize(11);
        doc.setTextColor(0, 0, 0);

        for (let i = 0; i < entry.media.length; i++) {
            const media = entry.media[i];

            if (yPosition > 270) {
                doc.addPage();
                yPosition = 20;
            }

            if (media.type === 'image') {
                try {
                    doc.text(`Image ${i + 1}:`, margin, yPosition);
                    yPosition += 7;

                    const imgData = media.data;
                    const imgWidth = 80;
                    const imgHeight = 60;

                    if (yPosition + imgHeight > 280) {
                        doc.addPage();
                        yPosition = 20;
                    }

                    doc.addImage(imgData, 'JPEG', margin, yPosition, imgWidth, imgHeight);
                    yPosition += imgHeight + 10;
                } catch (error) {
                    doc.text(`Image ${i + 1}: [Could not embed image]`, margin, yPosition);
                    yPosition += 7;
                }
            } else if (media.type === 'video') {
                doc.text(`Video ${i + 1}: [Video file attached]`, margin, yPosition);
                yPosition += 7;
            } else if (media.type === 'url') {
                const safeUrl = sanitizeUrl(media.data);
                if (safeUrl) {
                    doc.textWithLink(`URL ${i + 1}: ${media.data}`, margin, yPosition, { url: safeUrl });
                } else {
                    doc.text(`URL ${i + 1}: ${media.data}`, margin, yPosition);
                }
                yPosition += 7;
            }
        }
    }

    // Save the PDF
    const filename = `journal_${entry.date}.pdf`;
    doc.save(filename);
}

async function downloadAllAsPDF() {
    if (entries.length === 0) {
        alert('No entries to download.');
        return;
    }

    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();

    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 20;
    const maxWidth = pageWidth - 2 * margin;
    let yPosition = 20;

    // Add title page
    doc.setFontSize(24);
    doc.setTextColor(102, 126, 234);
    doc.text('My Journal', pageWidth / 2, yPosition, { align: 'center' });
    yPosition += 15;

    doc.setFontSize(12);
    doc.setTextColor(0, 0, 0);
    const today = new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
    });
    doc.text(`Generated on ${today}`, pageWidth / 2, yPosition, { align: 'center' });
    doc.text(`Total entries: ${entries.length}`, pageWidth / 2, yPosition + 7, { align: 'center' });

    // Sort entries by date (oldest first for chronological reading)
    const sortedEntries = [...entries].sort((a, b) => a.date.localeCompare(b.date));

    for (let entryIndex = 0; entryIndex < sortedEntries.length; entryIndex++) {
        const entry = sortedEntries[entryIndex];

        doc.addPage();
        yPosition = 20;

        // Add entry date
        doc.setFontSize(16);
        doc.setTextColor(102, 126, 234);
        const entryDate = parseEntryDate(entry.date);
        const dateText = entryDate.toLocaleDateString('en-US', {
            weekday: 'long',
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
        doc.text(dateText, margin, yPosition);
        yPosition += 12;

        // Add separator line
        doc.setDrawColor(102, 126, 234);
        doc.line(margin, yPosition, pageWidth - margin, yPosition);
        yPosition += 10;

        // Add text content
        if (entry.text) {
            doc.setFontSize(12);
            doc.setTextColor(0, 0, 0);
            const lines = doc.splitTextToSize(entry.text, maxWidth);
            lines.forEach(line => {
                if (yPosition > 270) {
                    doc.addPage();
                    yPosition = 20;
                }
                doc.text(line, margin, yPosition);
                yPosition += 7;
            });
            yPosition += 10;
        }

        // Add media information
        if (entry.media && entry.media.length > 0) {
            doc.setFontSize(12);
            doc.setTextColor(118, 75, 162);

            if (yPosition > 260) {
                doc.addPage();
                yPosition = 20;
            }

            doc.text('Attached Media:', margin, yPosition);
            yPosition += 8;

            doc.setFontSize(10);
            doc.setTextColor(0, 0, 0);

            for (let i = 0; i < entry.media.length; i++) {
                const media = entry.media[i];

                if (yPosition > 270) {
                    doc.addPage();
                    yPosition = 20;
                }

                if (media.type === 'image') {
                    try {
                        doc.text(`Image ${i + 1}:`, margin, yPosition);
                        yPosition += 5;

                        const imgData = media.data;
                        const imgWidth = 70;
                        const imgHeight = 50;

                        if (yPosition + imgHeight > 280) {
                            doc.addPage();
                            yPosition = 20;
                        }

                        doc.addImage(imgData, 'JPEG', margin, yPosition, imgWidth, imgHeight);
                        yPosition += imgHeight + 8;
                    } catch (error) {
                        doc.text(`Image ${i + 1}: [Could not embed image]`, margin, yPosition);
                        yPosition += 5;
                    }
                } else if (media.type === 'video') {
                    doc.text(`Video ${i + 1}: [Video file attached]`, margin, yPosition);
                    yPosition += 5;
                } else if (media.type === 'url') {
                    const urlLines = doc.splitTextToSize(`URL ${i + 1}: ${media.data}`, maxWidth);
                    urlLines.forEach(line => {
                        if (yPosition > 270) {
                            doc.addPage();
                            yPosition = 20;
                        }
                        doc.text(line, margin, yPosition);
                        yPosition += 5;
                    });
                }
            }
        }
    }

    // Save the PDF
    const filename = `journal_all_entries_${toLocalDateString()}.pdf`;
    doc.save(filename);
}
