// SnapShift Studio — Frontend Application Logic

let scanData = null;
let eventSource = null;
let currentTab = 'dashboard';
let itemsState = {}; // id -> boolean (checked)

// Helper: Format Bytes
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Show Toast Notification
function showToast(message, type = 'info') {
  const shelf = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span><span>${message}</span>`;
  shelf.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// Tab Switching
function initTabs() {
  const navBtns = document.querySelectorAll('.nav-item');
  navBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      switchTab(tabId);
    });
  });

  const headerBtn = document.getElementById('header-quick-snapshot-btn');
  if (headerBtn) {
    headerBtn.addEventListener('click', () => switchTab('snapshot'));
  }
}

function switchTab(tabId) {
  currentTab = tabId;
  document.querySelectorAll('.nav-item').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === tabId);
  });
  document.querySelectorAll('.tab-pane').forEach(p => {
    p.classList.toggle('active', p.id === `tab-${tabId}`);
  });

  const pageTitle = document.getElementById('page-title');
  const pageDesc = document.getElementById('page-desc');

  switch (tabId) {
    case 'dashboard':
      pageTitle.innerText = 'Storage Topology & System Matrix';
      pageDesc.innerText = 'Real-time inspection of your physical drives, partitions, and user workspace.';
      break;
    case 'snapshot':
      pageTitle.innerText = 'Workspace Snapshot Studio';
      pageDesc.innerText = 'Select items to safely preserve on your internal HDD before replacing the SSD.';
      break;
    case 'restore':
      pageTitle.innerText = 'New System Restore Center';
      pageDesc.innerText = 'Effortlessly bring back your workspace into fresh Windows from your HDD snapshots.';
      loadSnapshotsList();
      break;
    case 'software':
      pageTitle.innerText = 'Software Hub & Automated Reinstaller';
      pageDesc.innerText = 'Inventory of all installed apps ready for 1-click Winget bulk installation.';
      break;
    case 'guide':
      pageTitle.innerText = 'SSD Replacement Compass';
      pageDesc.innerText = 'Complete visual roadmap for safely installing your new SSD and restoring everything.';
      break;
  }
}

// Fetch System Scan
async function fetchScanData() {
  const rescanBtn = document.getElementById('rescan-system-btn');
  if (rescanBtn) {
    rescanBtn.disabled = true;
    rescanBtn.innerHTML = '<span class="spinner-dot" style="display:inline-block; margin-right:6px;"></span><span>Scanning System...</span>';
  }
  try {
    const res = await fetch('/api/scan');
    scanData = await res.json();
    renderDashboard();
    renderSnapshotStudio();
    renderSoftwareHub();
    showToast('System assessment updated successfully', 'success');
  } catch (err) {
    showToast(`Scan error: ${err.message}`, 'error');
  } finally {
    if (rescanBtn) {
      rescanBtn.disabled = false;
      rescanBtn.innerHTML = '<span class="btn-icon">🔄</span><span>Rescan System</span>';
    }
  }
}

// Render Dashboard
function renderDashboard() {
  if (!scanData) return;

  // Sidebar indicators
  const ssd = scanData.disks.physicalDisks.find(d => d.isSourceSSD);
  const hdd = scanData.disks.physicalDisks.find(d => !d.isSourceSSD);
  if (ssd) document.getElementById('sidebar-ssd-name').innerText = ssd.name;
  if (hdd) document.getElementById('sidebar-hdd-name').innerText = hdd.name;

  // Disks Grid
  const disksGrid = document.getElementById('physical-disks-grid');
  disksGrid.innerHTML = '';
  scanData.disks.physicalDisks.forEach(d => {
    const isSSD = d.isSourceSSD;
    const card = document.createElement('div');
    card.className = `disk-card ${isSSD ? 'target-source' : 'safe-hdd'}`;
    card.innerHTML = `
      <div class="disk-card-header">
        <div class="disk-title-group">
          <h3>${d.name}</h3>
          <div class="disk-sub">${d.mediaType} • Bus: ${d.busType} • ${d.sizeFormatted}</div>
        </div>
        <span class="disk-badge ${isSSD ? 'badge-danger' : 'badge-success'}">
          ${isSSD ? '⚠️ SOURCE SSD (TO REPLACE)' : '🛡️ SAFE INTERNAL HDD'}
        </span>
      </div>
      <p style="font-size:12px; color: ${isSSD ? '#fca5a5' : '#86efac'};">
        ${isSSD 
          ? 'Hosts C: (Windows OS). Will be removed from motherboard during upgrade.' 
          : 'Permanent storage. Remains connected in PC. Ideal location for snapshots!'}
      </p>
    `;
    disksGrid.appendChild(card);
  });

  // Volumes Grid
  const volsGrid = document.getElementById('volumes-grid');
  volsGrid.innerHTML = '';
  scanData.disks.volumes.forEach(v => {
    const isC = v.isSystemDrive;
    const card = document.createElement('div');
    card.className = 'disk-card';
    card.innerHTML = `
      <div class="disk-card-header">
        <div class="disk-title-group">
          <h3>Drive ${v.driveLetter}</h3>
          <div class="disk-sub">${v.label}</div>
        </div>
        <span class="disk-badge ${isC ? 'badge-danger' : 'badge-success'}">
          ${isC ? 'C: (OS Drive)' : 'Safe Volume'}
        </span>
      </div>
      <div class="disk-meter">
        <div class="meter-labels">
          <span>Used: ${v.usedPercent}%</span>
          <span>Free: ${v.freeFormatted}</span>
        </div>
        <div class="meter-track">
          <div class="meter-fill ${isC ? 'fill-red' : 'fill-emerald'}" style="width: ${v.usedPercent}%"></div>
        </div>
      </div>
      <div style="font-size:11px; color:var(--text-dim); text-align:right;">
        Total Capacity: ${v.totalFormatted}
      </div>
    `;
    volsGrid.appendChild(card);
  });

  // Top Stats
  const personalBytes = scanData.categories.personal.reduce((a, c) => a + (c.bytes || 0), 0);
  const devBytes = scanData.categories.developer.reduce((a, c) => a + (c.bytes || 0), 0);
  document.getElementById('stat-personal-size').innerText = formatBytes(personalBytes);
  document.getElementById('stat-dev-size').innerText = formatBytes(devBytes);
  document.getElementById('stat-apps-count').innerText = `${scanData.software.wingetApps.length} Apps`;
  document.getElementById('badge-software-count').innerText = scanData.software.wingetApps.length;
  document.getElementById('badge-total-size').innerText = scanData.summary.totalFormatted;
}

// Render Snapshot Studio
function renderSnapshotStudio() {
  if (!scanData) return;

  // Initialize Destination select
  const select = document.getElementById('destination-drive-select');
  select.innerHTML = '';
  scanData.disks.volumes.filter(v => !v.isSystemDrive).forEach(v => {
    const opt = document.createElement('option');
    opt.value = v.driveLetter;
    opt.innerText = `${v.driveLetter} (${v.label} - ${v.freeFormatted} Free)`;
    if (v.driveLetter === scanData.disks.recommendedBackupDrive) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });

  // Render Category Grids
  renderCategoryItems('personal', scanData.categories.personal, 'items-personal-list', 'personal-category-size');
  renderCategoryItems('developer', scanData.categories.developer, 'items-developer-list', 'developer-category-size');
  renderCategoryItems('settings', scanData.categories.settings, 'items-settings-list', 'settings-category-size');

  // Render System Items (Env vars & Software)
  const sysContainer = document.getElementById('items-system-list');
  sysContainer.innerHTML = '';

  const envItem = scanData.categories.environment;
  const envCard = createItemCard(envItem, 'system');
  sysContainer.appendChild(envCard);

  const softItem = {
    id: 'software_inventory',
    name: '54 Installed Apps & VS Code Extensions',
    desc: 'Automated 1-click Winget batch installer script',
    icon: '📦',
    sizeFormatted: 'Batch Script',
    bytes: 1024,
    defaultChecked: true
  };
  const softCard = createItemCard(softItem, 'system');
  sysContainer.appendChild(softCard);

  updateSelectionSummary();
  bindMasterCheckboxes();
}

function renderCategoryItems(categoryId, items, containerId, sizeBadgeId) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  let catTotal = 0;

  items.forEach(item => {
    catTotal += item.bytes || 0;
    const card = createItemCard(item, categoryId);
    container.appendChild(card);
  });

  const badge = document.getElementById(sizeBadgeId);
  if (badge) badge.innerText = formatBytes(catTotal);
}

function createItemCard(item, category) {
  const card = document.createElement('div');
  const isChecked = itemsState[item.id] !== undefined ? itemsState[item.id] : (item.defaultChecked !== false && item.exists !== false);
  itemsState[item.id] = isChecked;

  card.className = `item-card ${isChecked ? 'selected' : ''}`;
  card.id = `item-card-${item.id}`;
  card.innerHTML = `
    <div class="item-info-group">
      <span class="item-icon">${item.icon || '📄'}</span>
      <div>
        <div class="item-name">${item.name}</div>
        <div class="item-desc">${item.desc || ''}</div>
      </div>
    </div>
    <div class="item-meta">
      <span class="item-size">${item.sizeFormatted || '0 B'}</span>
      <input type="checkbox" id="check-${item.id}" class="item-checkbox" ${isChecked ? 'checked' : ''} ${item.exists === false ? 'disabled' : ''}>
    </div>
  `;

  const checkbox = card.querySelector(`#check-${item.id}`);
  checkbox.addEventListener('change', (e) => {
    e.stopPropagation();
    itemsState[item.id] = checkbox.checked;
    card.classList.toggle('selected', checkbox.checked);
    updateSelectionSummary();
  });

  card.addEventListener('click', (e) => {
    if (e.target !== checkbox && item.exists !== false) {
      checkbox.checked = !checkbox.checked;
      itemsState[item.id] = checkbox.checked;
      card.classList.toggle('selected', checkbox.checked);
      updateSelectionSummary();
    }
  });

  return card;
}

function bindMasterCheckboxes() {
  ['personal', 'developer', 'settings', 'system'].forEach(cat => {
    const master = document.getElementById(`check-group-${cat}`);
    if (master) {
      master.addEventListener('change', () => {
        const checked = master.checked;
        const items = cat === 'system'
          ? [{ id: 'environment_vars' }, { id: 'software_inventory' }]
          : (scanData.categories[cat] || []);
        items.forEach(i => {
          itemsState[i.id] = checked;
          const chk = document.getElementById(`check-${i.id}`);
          const card = document.getElementById(`item-card-${i.id}`);
          if (chk) chk.checked = checked;
          if (card) card.classList.toggle('selected', checked);
        });
        updateSelectionSummary();
      });
    }
  });

  document.getElementById('select-all-items-btn').addEventListener('click', () => {
    Object.keys(itemsState).forEach(k => {
      itemsState[k] = true;
      const chk = document.getElementById(`check-${k}`);
      const card = document.getElementById(`item-card-${k}`);
      if (chk) chk.checked = true;
      if (card) card.classList.add('selected');
    });
    document.querySelectorAll('.category-master-check').forEach(m => m.checked = true);
    updateSelectionSummary();
  });

  document.getElementById('deselect-all-items-btn').addEventListener('click', () => {
    Object.keys(itemsState).forEach(k => {
      itemsState[k] = false;
      const chk = document.getElementById(`check-${k}`);
      const card = document.getElementById(`item-card-${k}`);
      if (chk) chk.checked = false;
      if (card) card.classList.remove('selected');
    });
    document.querySelectorAll('.category-master-check').forEach(m => m.checked = false);
    updateSelectionSummary();
  });
}

function updateSelectionSummary() {
  if (!scanData) return;
  const allItems = [
    ...scanData.categories.personal,
    ...scanData.categories.developer,
    ...scanData.categories.settings
  ];

  let totalBytes = 0;
  let totalFiles = 0;

  allItems.forEach(item => {
    if (itemsState[item.id]) {
      totalBytes += item.bytes || 0;
      totalFiles += item.fileCount || 0;
    }
  });

  document.getElementById('selected-total-size').innerText = formatBytes(totalBytes);
  document.getElementById('selected-total-files').innerText = `(${totalFiles.toLocaleString()} files)`;
}

// Render Software Hub
function renderSoftwareHub() {
  if (!scanData || !scanData.software) return;
  const tbody = document.getElementById('software-table-body');
  tbody.innerHTML = '';

  const apps = scanData.software.wingetApps || [];
  apps.forEach(app => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><strong>${app.name}</strong></td>
      <td><code>${app.id}</code></td>
      <td>${app.version || 'Latest'}</td>
      <td><span class="disk-badge badge-success">✓ 1-Click Winget</span></td>
    `;
    tbody.appendChild(tr);
  });

  const searchInput = document.getElementById('software-search-input');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase();
    Array.from(tbody.querySelectorAll('tr')).forEach(tr => {
      const text = tr.innerText.toLowerCase();
      tr.style.display = text.includes(q) ? '' : 'none';
    });
  });
}

// Snapshots Discovery & Restoration
async function loadSnapshotsList() {
  const container = document.getElementById('snapshots-list-container');
  container.innerHTML = '<div style="color:var(--text-muted); padding:20px;">Scanning HDD for snapshots...</div>';

  try {
    const res = await fetch('/api/snapshots');
    const snapshots = await res.json();
    container.innerHTML = '';

    if (snapshots.length === 0) {
      container.innerHTML = `
        <div style="background:var(--bg-card); padding:30px; border-radius:12px; text-align:center; border:1px dashed var(--border-medium);">
          <div style="font-size:32px; margin-bottom:10px;">📸</div>
          <h3>No Snapshots Found Yet</h3>
          <p style="color:var(--text-muted); font-size:13px; margin:8px 0 16px;">
            Go to <strong>Snapshot Studio</strong> to capture your current system to Drive D: or F: before replacing the SSD.
          </p>
          <button class="btn btn-primary" onclick="switchTab('snapshot')">Create First Snapshot</button>
        </div>
      `;
      return;
    }

    snapshots.forEach(s => {
      const card = document.createElement('div');
      card.className = 'disk-card';
      card.style.marginBottom = '14px';
      card.innerHTML = `
        <div class="disk-card-header">
          <div>
            <h3>${s.id}</h3>
            <div class="disk-sub">Saved on Drive ${s.drive} • Created: ${new Date(s.createdAt).toLocaleString()}</div>
          </div>
          <span class="disk-badge badge-success">Valid Snapshot</span>
        </div>
        <p style="font-size:12px; color:var(--text-muted); margin:8px 0;">
          Source System: <strong>${s.manifest.sourceSystem.computerName}</strong> (User: ${s.manifest.sourceSystem.username})
        </p>
        <div style="display:flex; gap:10px; margin-top:10px;">
          <button class="btn btn-primary" onclick="triggerRestore('${s.path.replace(/\\/g, '\\\\')}')">
            ⚡ Restore to Current User
          </button>
          <a href="file:///${s.path.replace(/\\/g, '/')}/RESTORE_VIEWER.html" target="_blank" class="btn btn-secondary">
            Open Offline Viewer
          </a>
        </div>
      `;
      container.appendChild(card);
    });
  } catch (err) {
    container.innerHTML = `<div style="color:var(--accent-red);">Error loading snapshots: ${err.message}</div>`;
  }
}

// Snapshot Execution
async function startSnapshot() {
  const targetDrive = document.getElementById('destination-drive-select').value;
  const allItems = [
    ...scanData.categories.personal,
    ...scanData.categories.developer,
    ...scanData.categories.settings
  ];

  const items = allItems.map(i => ({
    ...i,
    selected: !!itemsState[i.id]
  }));

  const selectedItems = items.filter(i => i.selected);
  const estimatedBytes = selectedItems.reduce((acc, cur) => acc + (cur.bytes || 0), 0);
  const estimatedFiles = selectedItems.reduce((acc, cur) => acc + (cur.fileCount || 0), 0);

  const payload = {
    targetDrive,
    items,
    includeEnvironment: !!itemsState['environment_vars'],
    environmentData: scanData.categories.environment,
    includeSoftware: !!itemsState['software_inventory'],
    software: scanData.software,
    estimatedBytes,
    estimatedFiles
  };

  // Open Modal
  const modal = document.getElementById('progress-modal');
  modal.classList.remove('hidden');
  document.getElementById('modal-title').innerText = 'Capturing System Snapshot to HDD';
  document.getElementById('modal-footer-success').classList.add('hidden');
  document.getElementById('modal-log-stream').innerHTML = '<div class="log-line info">Starting snapshot process...</div>';

  try {
    const res = await fetch('/api/snapshot/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to start snapshot');
    }
  } catch (err) {
    showToast(err.message, 'error');
    modal.classList.add('hidden');
  }
}

// Restore Execution
async function triggerRestore(snapshotPath) {
  if (!confirm(`Restore all files from snapshot into your current user account (${scanData.systemInfo.username})?`)) {
    return;
  }

  const modal = document.getElementById('progress-modal');
  modal.classList.remove('hidden');
  document.getElementById('modal-title').innerText = 'Restoring Workspace from HDD';
  document.getElementById('modal-footer-success').classList.add('hidden');
  document.getElementById('modal-log-stream').innerHTML = '<div class="log-line info">Restoration engine starting...</div>';

  try {
    const res = await fetch('/api/restore/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshotPath, options: {} })
    });
    if (!res.ok) {
      const errData = await res.json();
      throw new Error(errData.error || 'Failed to start restoration');
    }
  } catch (err) {
    showToast(err.message, 'error');
    modal.classList.add('hidden');
  }
}

// SSE Connection for Live Progress
function initSSE() {
  eventSource = new EventSource('/api/stream');

  eventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.type === 'snapshot_progress') {
        updateProgressUI(payload.data);
      } else if (payload.type === 'snapshot_done') {
        finishSnapshotUI(payload.data);
      } else if (payload.type === 'restore_progress') {
        updateRestoreUI(payload.data);
      } else if (payload.type === 'restore_done') {
        finishRestoreUI(payload.data);
      }
    } catch (e) {}
  };

  eventSource.onerror = () => {
    // Reconnects automatically
  };

  // Fallback status check in case SSE disconnects during heavy file copy
  setInterval(async () => {
    const modal = document.getElementById('progress-modal');
    if (modal && !modal.classList.contains('hidden')) {
      try {
        const res = await fetch('/api/snapshot/status');
        const st = await res.json();
        if (st.status === 'completed') {
          finishSnapshotUI(st);
        } else if (st.status === 'running') {
          updateProgressUI(st);
        }
      } catch (e) {}
    }
  }, 2500);
}

function updateProgressUI(data) {
  const percent = data.percent || 0;
  document.getElementById('modal-progress-bar').style.width = `${percent}%`;
  document.getElementById('progress-percent-label').innerText = `${percent}%`;

  // Update SVG Ring
  const circle = document.getElementById('progress-ring-circle');
  if (circle) {
    const offset = 314 - (314 * percent) / 100;
    circle.style.strokeDashoffset = offset;
  }

  if (data.currentCategory) document.getElementById('progress-category-label').innerText = data.currentCategory;
  if (data.currentFile) document.getElementById('progress-file-label').innerText = data.currentFile;
  document.getElementById('progress-bytes-label').innerText = `${data.copiedBytesFormatted} / ${data.totalBytesFormatted}`;
  if (data.speedMBps) document.getElementById('progress-speed-label').innerText = `${data.speedMBps} MB/s`;

  // Log line
  const logBox = document.getElementById('modal-log-stream');
  if (data.currentFile) {
    const line = document.createElement('div');
    line.className = 'log-line';
    line.innerText = `[${data.percent}%] Copied: ${data.currentFile}`;
    logBox.appendChild(line);
    logBox.scrollTop = logBox.scrollHeight;
  }
}

function finishSnapshotUI(result) {
  document.getElementById('modal-progress-bar').style.width = '100%';
  document.getElementById('progress-percent-label').innerText = '100%';
  document.getElementById('modal-footer-success').classList.remove('hidden');
  showToast('Snapshot completed successfully!', 'success');
}

function updateRestoreUI(data) {
  document.getElementById('progress-category-label').innerText = data.currentCategory || 'Restoring...';
  if (data.currentFile) document.getElementById('progress-file-label').innerText = data.currentFile;
  document.getElementById('progress-bytes-label').innerText = `${data.copiedBytesFormatted} (${data.copiedFiles} files)`;
}

function finishRestoreUI(data) {
  document.getElementById('modal-footer-success').classList.remove('hidden');
  showToast('All files restored successfully!', 'success');
}

// Initial Boot
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initSSE();
  fetchScanData();

  document.getElementById('rescan-system-btn').addEventListener('click', fetchScanData);
  document.getElementById('start-snapshot-btn').addEventListener('click', startSnapshot);
  document.getElementById('refresh-snapshots-btn').addEventListener('click', loadSnapshotsList);

  document.getElementById('modal-close-btn').addEventListener('click', () => {
    document.getElementById('progress-modal').classList.add('hidden');
    switchTab('restore');
  });

  document.getElementById('cancel-task-btn').addEventListener('click', async () => {
    await fetch('/api/snapshot/cancel', { method: 'POST' });
    document.getElementById('progress-modal').classList.add('hidden');
    showToast('Task cancelled', 'info');
  });
});
