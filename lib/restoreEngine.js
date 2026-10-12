const fs = require('fs');
const path = require('path');
const { formatBytes } = require('./scanner');

class RestoreEngine {
  constructor() {
    this.currentTask = null;
    this.cancelRequested = false;
  }

  isBusy() {
    return this.currentTask && this.currentTask.status === 'running';
  }

  getStatus() {
    return this.currentTask || { status: 'idle' };
  }

  cancel() {
    if (this.currentTask && this.currentTask.status === 'running') {
      this.cancelRequested = true;
      this.currentTask.status = 'cancelled';
      return true;
    }
    return false;
  }

  /**
   * Scan drives for existing snapshots
   */
  findSnapshots(searchDrives = ['D:', 'F:', 'E:', 'G:', 'C:']) {
    const snapshots = [];

    for (const drive of searchDrives) {
      const snapFolder = path.join(drive, 'SnapShift_Snapshots');
      if (fs.existsSync(snapFolder)) {
        try {
          const entries = fs.readdirSync(snapFolder, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const fullPath = path.join(snapFolder, entry.name);
              const manifestPath = path.join(fullPath, 'snapshot_manifest.json');
              if (fs.existsSync(manifestPath)) {
                try {
                  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
                  snapshots.push({
                    id: entry.name,
                    path: fullPath,
                    manifest,
                    createdAt: manifest.createdAt || entry.name,
                    drive
                  });
                } catch (e) {
                  // corrupt manifest
                }
              }
            }
          }
        } catch (e) {}
      }
    }

    // Sort newest first
    snapshots.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return snapshots;
  }

  /**
   * Copy directory recursively with progress tracking
   */
  async copyDir(src, dest, progressCb) {
    if (!fs.existsSync(src)) return 0;
    if (!fs.existsSync(dest)) {
      try {
        fs.mkdirSync(dest, { recursive: true });
      } catch (e) {
        return 0;
      }
    }

    let count = 0;
    let entries = [];
    try {
      entries = fs.readdirSync(src, { withFileTypes: true });
    } catch (err) {
      if (progressCb) {
        progressCb({
          type: 'warning',
          message: `Could not read ${src}: ${err.message}`
        });
      }
      return 0;
    }

    for (const entry of entries) {
      if (this.cancelRequested) break;

      try {
        if (entry.isSymbolicLink()) continue;
      } catch (e) {
        continue;
      }

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        try {
          count += await this.copyDir(srcPath, destPath, progressCb);
        } catch (err) {
          if (progressCb) {
            progressCb({
              type: 'warning',
              message: `Could not copy directory ${entry.name}: ${err.message}`
            });
          }
        }
      } else if (entry.isFile()) {
        try {
          fs.copyFileSync(srcPath, destPath);
          const stat = fs.statSync(destPath);
          count++;
          if (progressCb) {
            progressCb({
              type: 'file',
              filePath: destPath,
              fileName: entry.name,
              bytes: stat.size
            });
          }
        } catch (err) {
          if (progressCb) {
            progressCb({
              type: 'warning',
              message: `Could not copy ${entry.name}: ${err.message}`
            });
          }
        }
      }
    }
    return count;
  }

  /**
   * Execute selective or full restoration
   */
  async restoreSnapshot(snapshotPath, options = {}, progressCb) {
    if (this.isBusy()) {
      throw new Error('A restoration task is already in progress.');
    }

    const manifestPath = path.join(snapshotPath, 'snapshot_manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Invalid snapshot directory: manifest not found in ${snapshotPath}`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const targetUser = options.targetUserProfile || process.env.USERPROFILE;
    const targetAppData = process.env.APPDATA || path.join(targetUser, 'AppData', 'Roaming');
    const targetLocalAppData = process.env.LOCALAPPDATA || path.join(targetUser, 'AppData', 'Local');

    this.cancelRequested = false;
    this.currentTask = {
      id: `restore_${Date.now()}`,
      status: 'running',
      startTime: Date.now(),
      snapshotPath,
      copiedFiles: 0,
      copiedBytes: 0,
      currentCategory: 'Starting Restoration',
      currentFile: '',
      errors: []
    };

    const emitProgress = (payload = {}) => {
      const statusObj = {
        ...this.currentTask,
        copiedBytesFormatted: formatBytes(this.currentTask.copiedBytes),
        ...payload
      };
      if (progressCb) progressCb(statusObj);
    };

    try {
      emitProgress();

      // 1. Restore User Folders
      const userProfileBackup = path.join(snapshotPath, 'UserProfile');
      if (fs.existsSync(userProfileBackup) && options.restorePersonal !== false) {
        const folders = fs.readdirSync(userProfileBackup);
        for (const folder of folders) {
          if (this.cancelRequested) break;
          this.currentTask.currentCategory = `Restoring ${folder}`;
          emitProgress();

          const srcFolder = path.join(userProfileBackup, folder);
          const destFolder = path.join(targetUser, folder);
          await this.copyDir(srcFolder, destFolder, (evt) => {
            if (evt.type === 'file') {
              this.currentTask.copiedBytes += evt.bytes;
              this.currentTask.copiedFiles++;
              this.currentTask.currentFile = evt.fileName;
              emitProgress();
            }
          });
        }
      }

      // 2. Restore Developer Configs (both directories and single files)
      const devBackup = path.join(snapshotPath, 'DeveloperConfigs');
      if (fs.existsSync(devBackup) && options.restoreDeveloper !== false) {
        const devItems = fs.readdirSync(devBackup);
        for (const item of devItems) {
          if (this.cancelRequested) break;
          this.currentTask.currentCategory = `Restoring Developer Config: ${item}`;
          emitProgress();

          const srcItem = path.join(devBackup, item);
          const destItem = path.join(targetUser, item);
          const stat = fs.statSync(srcItem);

          if (stat.isDirectory()) {
            await this.copyDir(srcItem, destItem, (evt) => {
              if (evt.type === 'file') {
                this.currentTask.copiedBytes += evt.bytes;
                this.currentTask.copiedFiles++;
                this.currentTask.currentFile = evt.fileName;
                emitProgress();
              }
            });
          } else {
            try {
              fs.copyFileSync(srcItem, destItem);
              this.currentTask.copiedBytes += stat.size;
              this.currentTask.copiedFiles++;
              this.currentTask.currentFile = item;
              emitProgress();
            } catch (err) {}
          }
        }
      }

      // 3. Restore App Settings (VS Code, Chrome Bookmarks, Edge Bookmarks, Windows Terminal)
      const settingsBackup = path.join(snapshotPath, 'AppSettings');
      if (fs.existsSync(settingsBackup) && options.restoreSettings !== false) {
        // VS Code
        const vscodeSettings = path.join(settingsBackup, 'vscode_user_settings');
        if (fs.existsSync(vscodeSettings)) {
          this.currentTask.currentCategory = 'Restoring VS Code Settings';
          emitProgress();
          const targetVscode = path.join(targetAppData, 'Code', 'User');
          await this.copyDir(vscodeSettings, targetVscode, (evt) => {
            if (evt.type === 'file') {
              this.currentTask.copiedBytes += evt.bytes;
              this.currentTask.copiedFiles++;
              this.currentTask.currentFile = evt.fileName;
              emitProgress();
            }
          });
        }

        // Chrome Bookmarks
        const chromeBk = path.join(settingsBackup, 'chrome_bookmarks', 'Bookmarks');
        if (fs.existsSync(chromeBk)) {
          this.currentTask.currentCategory = 'Restoring Chrome Bookmarks';
          emitProgress();
          const targetDir = path.join(targetLocalAppData, 'Google', 'Chrome', 'User Data', 'Default');
          try {
            fs.mkdirSync(targetDir, { recursive: true });
            fs.copyFileSync(chromeBk, path.join(targetDir, 'Bookmarks'));
            this.currentTask.copiedFiles++;
          } catch (e) {}
        }

        // Edge Bookmarks
        const edgeBk = path.join(settingsBackup, 'edge_bookmarks', 'Bookmarks');
        if (fs.existsSync(edgeBk)) {
          this.currentTask.currentCategory = 'Restoring Edge Bookmarks';
          emitProgress();
          const targetDir = path.join(targetLocalAppData, 'Microsoft', 'Edge', 'User Data', 'Default');
          try {
            fs.mkdirSync(targetDir, { recursive: true });
            fs.copyFileSync(edgeBk, path.join(targetDir, 'Bookmarks'));
            this.currentTask.copiedFiles++;
          } catch (e) {}
        }

        // Windows Terminal Settings
        const termSettings = path.join(settingsBackup, 'windows_terminal', 'settings.json');
        if (fs.existsSync(termSettings)) {
          this.currentTask.currentCategory = 'Restoring Windows Terminal Settings';
          emitProgress();
          const targetDir = path.join(targetLocalAppData, 'Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState');
          try {
            fs.mkdirSync(targetDir, { recursive: true });
            fs.copyFileSync(termSettings, path.join(targetDir, 'settings.json'));
            this.currentTask.copiedFiles++;
          } catch (e) {}
        }

        // qBittorrent
        const qbitDir = path.join(settingsBackup, 'qbittorrent_data');
        if (fs.existsSync(qbitDir)) {
          this.currentTask.currentCategory = 'Restoring qBittorrent State';
          emitProgress();
          await this.copyDir(qbitDir, path.join(targetAppData, 'qBittorrent'));
        }

        // LocalSend
        const lsendDir = path.join(settingsBackup, 'localsend_data');
        if (fs.existsSync(lsendDir)) {
          this.currentTask.currentCategory = 'Restoring LocalSend Preferences';
          emitProgress();
          await this.copyDir(lsendDir, path.join(targetAppData, 'LocalSend'));
        }

        // VLC
        const vlcDir = path.join(settingsBackup, 'vlc_settings');
        if (fs.existsSync(vlcDir)) {
          this.currentTask.currentCategory = 'Restoring VLC Settings';
          emitProgress();
          await this.copyDir(vlcDir, path.join(targetAppData, 'vlc'));
        }

        // Game Saves
        const gameSavesDir = path.join(settingsBackup, 'game_saves_emu');
        if (fs.existsSync(gameSavesDir)) {
          this.currentTask.currentCategory = 'Restoring Game Saves';
          emitProgress();
          await this.copyDir(gameSavesDir, path.join(targetAppData, 'Goldberg SocialClub Emu Saves'));
        }
      }

      // 4. Restore Environment Variables
      const envDir = path.join(snapshotPath, 'EnvironmentVariables');
      const envJsonPath = path.join(envDir, 'environment_variables.json');
      if (fs.existsSync(envJsonPath) && options.restoreEnvironment !== false) {
        this.currentTask.currentCategory = 'Restoring Environment Variables';
        emitProgress();
        try {
          const envData = JSON.parse(fs.readFileSync(envJsonPath, 'utf8'));
          if (envData.userVars) {
            const { execSync } = require('child_process');
            for (const [k, v] of Object.entries(envData.userVars)) {
              if (k && v && !k.startsWith('ANTIGRAVITY_') && k !== 'TEMP' && k !== 'TMP') {
                try {
                  const safeVal = v.replace(/"/g, '\\"');
                  execSync(`setx "${k}" "${safeVal}"`, { stdio: 'ignore' });
                } catch (e) {}
              }
            }
          }
        } catch (e) {}
      }

      this.currentTask.status = this.cancelRequested ? 'cancelled' : 'completed';
      emitProgress({ currentCategory: this.cancelRequested ? 'Cancelled' : 'Restoration Finished Successfully' });

      return {
        success: !this.cancelRequested,
        copiedFiles: this.currentTask.copiedFiles,
        copiedBytes: this.currentTask.copiedBytes,
        copiedBytesFormatted: formatBytes(this.currentTask.copiedBytes)
      };

    } catch (err) {
      this.currentTask.status = 'error';
      this.currentTask.errors.push(err.message);
      emitProgress({ currentCategory: 'Restoration error' });
      throw err;
    }
  }
}

module.exports = new RestoreEngine();
