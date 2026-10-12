const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const os = require('os');

/**
 * Fast directory stats calculation
 */
function getFolderStats(dirPath, maxDepth = 5, currentDepth = 0) {
  let totalBytes = 0;
  let fileCount = 0;
  try {
    if (!fs.existsSync(dirPath)) return { totalBytes: 0, fileCount: 0, exists: false };
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
      return { totalBytes: stat.size, fileCount: 1, exists: true };
    }

    const items = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const item of items) {
      const fullPath = path.join(dirPath, item.name);
      try {
        if (item.isDirectory() && !item.isSymbolicLink()) {
          if (currentDepth < maxDepth) {
            const sub = getFolderStats(fullPath, maxDepth, currentDepth + 1);
            totalBytes += sub.totalBytes;
            fileCount += sub.fileCount;
          }
        } else if (item.isFile()) {
          const s = fs.statSync(fullPath);
          totalBytes += s.size;
          fileCount++;
        }
      } catch (err) {
        // Skip inaccessible files
      }
    }
    return { totalBytes, fileCount, exists: true };
  } catch (err) {
    return { totalBytes: 0, fileCount: 0, exists: false, error: err.message };
  }
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Detect Physical Disks and Volumes using PowerShell via execFileSync
 */
async function detectDisksAndVolumes() {
  const result = {
    physicalDisks: [],
    volumes: [],
    recommendedBackupDrive: 'D:',
    sourceDrive: 'C:'
  };

  try {
    const diskScript = 'Get-PhysicalDisk | Select-Object DeviceId, FriendlyName, MediaType, BusType, Size | ConvertTo-Json -Compress';
    const diskOut = execFileSync('powershell.exe', ['-NoProfile', '-Command', diskScript], { encoding: 'utf8', timeout: 8000 });
    const parsedDisks = JSON.parse(diskOut.trim() || '[]');
    const rawDisks = Array.isArray(parsedDisks) ? parsedDisks : [parsedDisks].filter(Boolean);

    result.physicalDisks = rawDisks.map(d => ({
      id: d.DeviceId,
      name: d.FriendlyName || 'Storage Disk',
      mediaType: d.MediaType || (d.FriendlyName && d.FriendlyName.toLowerCase().includes('ssd') ? 'SSD' : 'HDD'),
      busType: d.BusType || 'SATA',
      sizeBytes: Number(d.Size) || 0,
      sizeFormatted: formatBytes(Number(d.Size) || 0),
      isSourceSSD: (d.MediaType === 'SSD' || (d.FriendlyName && d.FriendlyName.toLowerCase().includes('ssd')))
    }));
  } catch (err) {
    console.error('Physical disks detection failed:', err.message);
  }

  try {
    const volScript = 'Get-Volume | Where-Object { $_.DriveLetter -ne $null } | Select-Object DriveLetter, FileSystemLabel, DriveType, SizeRemaining, Size | ConvertTo-Json -Compress';
    const volOut = execFileSync('powershell.exe', ['-NoProfile', '-Command', volScript], { encoding: 'utf8', timeout: 8000 });
    const parsedVols = JSON.parse(volOut.trim() || '[]');
    const rawVols = Array.isArray(parsedVols) ? parsedVols : [parsedVols].filter(Boolean);

    result.volumes = rawVols.map(v => {
      const free = Number(v.SizeRemaining) || 0;
      const total = Number(v.Size) || 0;
      const used = total - free;
      const letter = v.DriveLetter ? `${v.DriveLetter}:` : '';
      const isSystem = letter.toUpperCase() === 'C:';

      return {
        driveLetter: letter,
        label: v.FileSystemLabel || (isSystem ? 'Windows System' : 'Data Drive'),
        freeBytes: free,
        totalBytes: total,
        usedBytes: used,
        freeFormatted: formatBytes(free),
        totalFormatted: formatBytes(total),
        usedPercent: total > 0 ? Math.round((used / total) * 100) : 0,
        isSystemDrive: isSystem,
        isSafeHDD: !isSystem
      };
    });

    // Pick drive with largest free space on HDD (D: or F:)
    const safeCandidates = result.volumes
      .filter(v => !v.isSystemDrive && v.freeBytes > 5 * 1024 * 1024 * 1024)
      .sort((a, b) => b.freeBytes - a.freeBytes);

    if (safeCandidates.length > 0) {
      result.recommendedBackupDrive = safeCandidates[0].driveLetter;
    }
  } catch (err) {
    console.error('Volumes detection failed:', err.message);
  }

  return result;
}

/**
 * Scan User Profile Standard Directories
 */
function scanUserProfileFolders(userProfile = process.env.USERPROFILE) {
  const targets = [
    { id: 'desktop', name: 'Desktop', path: path.join(userProfile, 'Desktop'), category: 'personal', defaultChecked: true, icon: '🖥️', desc: 'Shortcuts, work files, and desktop items' },
    { id: 'documents', name: 'Documents', path: path.join(userProfile, 'Documents'), category: 'personal', defaultChecked: true, icon: '📄', desc: 'Personal documents, code projects, notes' },
    { id: 'downloads', name: 'Downloads', path: path.join(userProfile, 'Downloads'), category: 'personal', defaultChecked: false, icon: '📥', desc: 'Downloaded installers, media, archives' },
    { id: 'pictures', name: 'Pictures', path: path.join(userProfile, 'Pictures'), category: 'personal', defaultChecked: true, icon: '🖼️', desc: 'Photos, screenshots, and artwork' },
    { id: 'videos', name: 'Videos', path: path.join(userProfile, 'Videos'), category: 'personal', defaultChecked: true, icon: '🎥', desc: 'Screen recordings, videos, and media' },
    { id: 'music', name: 'Music', path: path.join(userProfile, 'Music'), category: 'personal', defaultChecked: true, icon: '🎵', desc: 'Audio tracks and music library' },
    { id: 'saved_games', name: 'Saved Games', path: path.join(userProfile, 'Saved Games'), category: 'personal', defaultChecked: true, icon: '🎮', desc: 'Game save files, campaign states, and player profiles' },
    { id: 'packet_tracer', name: 'Cisco Packet Tracer Labs', path: path.join(userProfile, 'Cisco Packet Tracer 6.2sv'), category: 'personal', defaultChecked: true, icon: '🌐', desc: 'Packet tracer network lab projects and topologies' }
  ];

  return targets.map(t => {
    const stats = getFolderStats(t.path);
    return {
      ...t,
      exists: stats.exists,
      bytes: stats.totalBytes,
      sizeFormatted: formatBytes(stats.totalBytes),
      fileCount: stats.fileCount
    };
  });
}

/**
 * Scan Developer Environment & Dotfiles
 */
function scanDeveloperConfigs(userProfile = process.env.USERPROFILE) {
  const dotfiles = [
    { id: 'ssh', name: 'SSH Keys & Config (~/.ssh)', path: path.join(userProfile, '.ssh'), category: 'developer', defaultChecked: true, icon: '🔑', desc: 'Git / Server SSH keys and known_hosts' },
    { id: 'gitconfig', name: 'Git Configuration (.gitconfig)', path: path.join(userProfile, '.gitconfig'), category: 'developer', defaultChecked: true, icon: '🐙', desc: 'Global git username, email, and aliases' },
    { id: 'vscode_profile', name: 'VS Code Extensions & State (.vscode)', path: path.join(userProfile, '.vscode'), category: 'developer', defaultChecked: true, icon: '💻', desc: 'Installed VS Code extensions data' },
    { id: 'codex_state', name: 'Codex Agent Workspace (.codex)', path: path.join(userProfile, '.codex'), category: 'developer', defaultChecked: true, icon: '🤖', desc: 'Codex AI workspace sessions and settings' },
    { id: 'copilot_state', name: 'GitHub Copilot Config (.copilot)', path: path.join(userProfile, '.copilot'), category: 'developer', defaultChecked: true, icon: '🔮', desc: 'Copilot state and telemetry settings' },
    { id: 'npmrc', name: 'NPM Global Config (.npmrc)', path: path.join(userProfile, '.npmrc'), category: 'developer', defaultChecked: true, icon: '📦', desc: 'Custom npm registries, tokens, and prefixes' },
    { id: 'wslconfig', name: 'WSL Configuration (.wslconfig)', path: path.join(userProfile, '.wslconfig'), category: 'developer', defaultChecked: true, icon: '🐧', desc: 'WSL2 memory, processor, and kernel options' },
    { id: 'ollama_models', name: 'Ollama Models & Config (.ollama)', path: path.join(userProfile, '.ollama'), category: 'developer', defaultChecked: false, icon: '🦙', desc: 'Local AI models & Ollama cache' },
    { id: 'gemini_config', name: 'Gemini Agent Config (.gemini)', path: path.join(userProfile, '.gemini'), category: 'developer', defaultChecked: true, icon: '✨', desc: 'Agent settings, skills, and history' },
    { id: 'antigravity_config', name: 'Antigravity IDE User Config', path: path.join(userProfile, '.antigravity-ide'), category: 'developer', defaultChecked: true, icon: '🚀', desc: 'IDE plugins, skills, and preferences' }
  ];

  return dotfiles.map(d => {
    const stats = getFolderStats(d.path);
    return {
      ...d,
      exists: stats.exists,
      bytes: stats.totalBytes,
      sizeFormatted: formatBytes(stats.totalBytes),
      fileCount: stats.fileCount
    };
  });
}

/**
 * Scan App Settings & Configurations (AppData)
 */
function scanAppSettings(userProfile = process.env.USERPROFILE) {
  const appData = process.env.APPDATA || path.join(userProfile, 'AppData', 'Roaming');
  const localAppData = process.env.LOCALAPPDATA || path.join(userProfile, 'AppData', 'Local');

  const configs = [
    {
      id: 'vscode_user_settings',
      name: 'VS Code User Settings & Snippets',
      path: path.join(appData, 'Code', 'User'),
      category: 'settings',
      defaultChecked: true,
      icon: '⚙️',
      desc: 'settings.json, keybindings.json, user snippets'
    },
    {
      id: 'chrome_bookmarks',
      name: 'Google Chrome Bookmarks',
      path: path.join(localAppData, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks'),
      category: 'settings',
      defaultChecked: true,
      icon: '🌐',
      desc: 'All saved Chrome bookmarks & favorites'
    },
    {
      id: 'edge_bookmarks',
      name: 'Microsoft Edge Bookmarks',
      path: path.join(localAppData, 'Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks'),
      category: 'settings',
      defaultChecked: true,
      icon: '🧭',
      desc: 'All saved Edge bookmarks & favorites'
    },
    {
      id: 'windows_terminal',
      name: 'Windows Terminal Settings',
      path: path.join(localAppData, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'),
      category: 'settings',
      defaultChecked: true,
      icon: '⌨️',
      desc: 'Custom color schemes, fonts, and terminal profiles'
    },
    {
      id: 'qbittorrent_data',
      name: 'qBittorrent Resume & Configuration',
      path: path.join(appData, 'qBittorrent'),
      category: 'settings',
      defaultChecked: true,
      icon: '🧲',
      desc: 'Active torrent lists, resume data, and client preferences'
    },
    {
      id: 'localsend_data',
      name: 'LocalSend Preferences',
      path: path.join(appData, 'LocalSend'),
      category: 'settings',
      defaultChecked: true,
      icon: '📲',
      desc: 'LocalSend network settings and device preferences'
    },
    {
      id: 'vlc_settings',
      name: 'VLC Media Player Settings',
      path: path.join(appData, 'vlc'),
      category: 'settings',
      defaultChecked: true,
      icon: '🎬',
      desc: 'VLC playback settings, volume, and interface preferences'
    },
    {
      id: 'game_saves_emu',
      name: 'Game Saves (SocialClub Emulator)',
      path: path.join(appData, 'Goldberg SocialClub Emu Saves'),
      category: 'settings',
      defaultChecked: true,
      icon: '🕹️',
      desc: 'Game progression and emulator save files'
    }
  ];

  return configs.map(c => {
    const stats = getFolderStats(c.path);
    return {
      ...c,
      exists: stats.exists,
      bytes: stats.totalBytes,
      sizeFormatted: formatBytes(stats.totalBytes),
      fileCount: stats.fileCount
    };
  });
}

/**
 * Scan Environment Variables from Windows Registry
 */
function scanEnvironmentVariables() {
  const userVars = {};
  const systemVars = {};

  try {
    const userScript = 'Get-ItemProperty "HKCU:\\Environment" | Select-Object * -ExcludeProperty PSPath, PSParentPath, PSChildName, PSDrive, PSProvider | ConvertTo-Json -Compress';
    const userOut = execFileSync('powershell.exe', ['-NoProfile', '-Command', userScript], { encoding: 'utf8', timeout: 5000 });
    const parsedUser = JSON.parse(userOut.trim() || '{}');
    for (const [k, v] of Object.entries(parsedUser)) {
      if (v && typeof v === 'string') userVars[k] = v;
    }
  } catch (err) {}

  try {
    const sysScript = 'Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" | Select-Object * -ExcludeProperty PSPath, PSParentPath, PSChildName, PSDrive, PSProvider | ConvertTo-Json -Compress';
    const sysOut = execFileSync('powershell.exe', ['-NoProfile', '-Command', sysScript], { encoding: 'utf8', timeout: 5000 });
    const parsedSys = JSON.parse(sysOut.trim() || '{}');
    for (const [k, v] of Object.entries(parsedSys)) {
      if (v && typeof v === 'string') systemVars[k] = v;
    }
  } catch (err) {}

  return {
    id: 'environment_vars',
    name: 'User & System Environment Variables',
    category: 'system',
    defaultChecked: true,
    icon: '🏷️',
    desc: 'Custom PATH, dev paths, and environment variables',
    userCount: Object.keys(userVars).length,
    systemCount: Object.keys(systemVars).length,
    userVars,
    systemVars,
    bytes: 2048,
    sizeFormatted: '2 KB',
    exists: true,
    fileCount: 2
  };
}

/**
 * Scan Installed Software (Winget + VS Code Extensions)
 */
async function scanSoftwareInventory() {
  const result = {
    wingetApps: [],
    vscodeExtensions: [],
    npmGlobals: []
  };

  // 1. Winget installed packages
  try {
    const wingetCmd = 'winget list --source winget --accept-source-agreements';
    const stdout = execSync(wingetCmd, { encoding: 'utf8', timeout: 15000 });
    const lines = stdout.split('\n');

    let headerPassed = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.includes('---')) {
        headerPassed = true;
        continue;
      }
      if (!headerPassed) continue;

      const parts = rawLine.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const name = parts[0];
        const id = parts[1];
        const version = parts[2] || '';
        if (id && id.includes('.')) {
          result.wingetApps.push({ name, id, version });
        }
      }
    }
  } catch (err) {}

  // 2. VS Code Extensions
  try {
    const extOutput = execSync('code --list-extensions', { encoding: 'utf8', timeout: 5000 });
    result.vscodeExtensions = extOutput.split('\n').map(s => s.trim()).filter(Boolean);
  } catch (err) {}

  // 3. Global NPM packages (ignore errors)
  try {
    const npmOut = execSync('cmd /c "npm list -g --depth=0 --json 2>nul"', { encoding: 'utf8', timeout: 5000 });
    const npmParsed = JSON.parse(npmOut);
    if (npmParsed.dependencies) {
      result.npmGlobals = Object.keys(npmParsed.dependencies);
    }
  } catch (err) {}

  return result;
}

/**
 * Perform Master System Scan
 */
async function performFullScan() {
  const disks = await detectDisksAndVolumes();
  const personalFolders = scanUserProfileFolders();
  const devConfigs = scanDeveloperConfigs();
  const appSettings = scanAppSettings();
  const envVars = scanEnvironmentVariables();
  const software = await scanSoftwareInventory();

  // Combine items
  const allItems = [...personalFolders, ...devConfigs, ...appSettings];
  const totalBytes = allItems.filter(i => i.exists).reduce((acc, cur) => acc + (cur.bytes || 0), 0);
  const totalFiles = allItems.filter(i => i.exists).reduce((acc, cur) => acc + (cur.fileCount || 0), 0);

  return {
    timestamp: new Date().toISOString(),
    systemInfo: {
      username: process.env.USERNAME,
      userProfile: process.env.USERPROFILE,
      computerName: process.env.COMPUTERNAME,
      osVersion: os.release(),
      arch: os.arch(),
      totalRamGB: Math.round(os.totalmem() / (1024 * 1024 * 1024))
    },
    disks,
    categories: {
      personal: personalFolders,
      developer: devConfigs,
      settings: appSettings,
      environment: envVars
    },
    software,
    summary: {
      totalBytes,
      totalFormatted: formatBytes(totalBytes),
      totalFiles,
      itemCount: allItems.length,
      wingetCount: software.wingetApps.length,
      vscodeExtCount: software.vscodeExtensions.length
    }
  };
}

module.exports = {
  detectDisksAndVolumes,
  scanUserProfileFolders,
  scanDeveloperConfigs,
  scanAppSettings,
  scanEnvironmentVariables,
  scanSoftwareInventory,
  performFullScan,
  formatBytes,
  getFolderStats
};
