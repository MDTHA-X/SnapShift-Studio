const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { formatBytes, getFolderStats } = require('./scanner');

class SnapshotEngine {
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
   * Helper to safely copy directory recursively with progress tracking
   */
  async copyDirRecursive(src, dest, progressCb) {
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
          message: `Skipped inaccessible directory: ${src} (${err.code || err.message})`
        });
      }
      return 0;
    }

    for (const entry of entries) {
      if (this.cancelRequested) break;

      // Skip Windows junctions and symbolic links to prevent loop traps and access denied
      try {
        if (entry.isSymbolicLink()) continue;
      } catch (e) {
        continue;
      }

      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        try {
          count += await this.copyDirRecursive(srcPath, destPath, progressCb);
        } catch (err) {
          if (progressCb) {
            progressCb({
              type: 'warning',
              message: `Skipped nested folder ${entry.name}: ${err.message}`
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
              filePath: srcPath,
              fileName: entry.name,
              bytes: stat.size
            });
          }
        } catch (err) {
          // Locked, in-use, or protected system file - safely log and continue
          if (progressCb) {
            progressCb({
              type: 'warning',
              message: `Skipped locked/system file: ${entry.name}`
            });
          }
        }
      }
    }
    return count;
  }

  /**
   * Execute full snapshot creation
   */
  async createSnapshot(options, progressCb) {
    if (this.isBusy()) {
      throw new Error('A snapshot task is already in progress.');
    }

    this.cancelRequested = false;
    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const targetDrive = options.targetDrive || 'D:';
    const baseDir = path.join(targetDrive, 'SnapShift_Snapshots');
    const snapshotDir = path.join(baseDir, `Snapshot_${timestampStr}`);

    if (!fs.existsSync(snapshotDir)) {
      fs.mkdirSync(snapshotDir, { recursive: true });
    }

    this.currentTask = {
      id: `snap_${Date.now()}`,
      status: 'running',
      startTime: Date.now(),
      snapshotDir,
      totalBytes: options.estimatedBytes || 0,
      copiedBytes: 0,
      totalFiles: options.estimatedFiles || 0,
      copiedFiles: 0,
      currentCategory: 'Initializing',
      currentFile: '',
      errors: [],
      speedMBps: 0
    };

    const startTime = Date.now();
    let lastTime = startTime;
    let lastBytes = 0;

    const emitProgress = (payload = {}) => {
      const now = Date.now();
      const elapsedSec = (now - startTime) / 1000;
      if (now - lastTime > 500 && elapsedSec > 0) {
        const bytesDiff = this.currentTask.copiedBytes - lastBytes;
        const timeDiff = (now - lastTime) / 1000;
        this.currentTask.speedMBps = ((bytesDiff / (1024 * 1024)) / timeDiff).toFixed(1);
        lastTime = now;
        lastBytes = this.currentTask.copiedBytes;
      }

      const percent = this.currentTask.totalBytes > 0
        ? Math.min(100, Math.round((this.currentTask.copiedBytes / this.currentTask.totalBytes) * 100))
        : (this.currentTask.status === 'completed' ? 100 : 0);

      const statusObj = {
        ...this.currentTask,
        percent,
        elapsedSec: Math.round(elapsedSec),
        copiedBytesFormatted: formatBytes(this.currentTask.copiedBytes),
        totalBytesFormatted: formatBytes(this.currentTask.totalBytes),
        ...payload
      };

      if (progressCb) progressCb(statusObj);
    };

    try {
      emitProgress({ currentCategory: 'System Assessment' });

      const manifest = {
        version: '1.0.0',
        createdAt: new Date().toISOString(),
        sourceSystem: {
          username: process.env.USERNAME,
          userProfile: process.env.USERPROFILE,
          computerName: process.env.COMPUTERNAME,
          os: process.env.OS
        },
        snapshotPath: snapshotDir,
        categoriesCopied: [],
        items: []
      };

      // 1. Process Personal User Folders
      const personalItems = options.items.filter(i => i.category === 'personal' && i.selected);
      for (const item of personalItems) {
        if (this.cancelRequested) break;
        this.currentTask.currentCategory = `Personal: ${item.name}`;
        emitProgress();

        const destItemDir = path.join(snapshotDir, 'UserProfile', item.name);
        fs.mkdirSync(destItemDir, { recursive: true });

        const count = await this.copyDirRecursive(item.path, destItemDir, (evt) => {
          if (evt.type === 'file') {
            this.currentTask.copiedBytes += evt.bytes;
            this.currentTask.copiedFiles++;
            this.currentTask.currentFile = evt.fileName;
            emitProgress();
          }
        });

        manifest.items.push({
          id: item.id,
          name: item.name,
          category: 'personal',
          originalPath: item.path,
          relativeSnapshotPath: path.join('UserProfile', item.name),
          fileCount: count
        });
      }

      // 2. Process Developer Dotfiles & Configs
      const devItems = options.items.filter(i => i.category === 'developer' && i.selected);
      for (const item of devItems) {
        if (this.cancelRequested) break;
        if (!fs.existsSync(item.path)) continue;

        this.currentTask.currentCategory = `Developer: ${item.name}`;
        emitProgress();

        const stat = fs.statSync(item.path);
        const itemName = path.basename(item.path);

        if (stat.isDirectory()) {
          const destItemDir = path.join(snapshotDir, 'DeveloperConfigs', itemName);
          fs.mkdirSync(destItemDir, { recursive: true });

          const count = await this.copyDirRecursive(item.path, destItemDir, (evt) => {
            if (evt.type === 'file') {
              this.currentTask.copiedBytes += evt.bytes;
              this.currentTask.copiedFiles++;
              this.currentTask.currentFile = evt.fileName;
              emitProgress();
            }
          });

          manifest.items.push({
            id: item.id,
            name: item.name,
            category: 'developer',
            type: 'directory',
            originalPath: item.path,
            relativeSnapshotPath: path.join('DeveloperConfigs', itemName),
            fileCount: count
          });
        } else {
          // Single file (e.g., .gitconfig, .npmrc, .wslconfig)
          const destDir = path.join(snapshotDir, 'DeveloperConfigs');
          fs.mkdirSync(destDir, { recursive: true });
          const destFile = path.join(destDir, itemName);

          try {
            fs.copyFileSync(item.path, destFile);
            this.currentTask.copiedBytes += stat.size;
            this.currentTask.copiedFiles++;
            this.currentTask.currentFile = itemName;
            emitProgress();

            manifest.items.push({
              id: item.id,
              name: item.name,
              category: 'developer',
              type: 'file',
              originalPath: item.path,
              relativeSnapshotPath: path.join('DeveloperConfigs', itemName),
              fileCount: 1
            });
          } catch (e) {
            // Ignored if file locked
          }
        }
      }

      // 3. Process App Settings & Browser Data
      const settingItems = options.items.filter(i => i.category === 'settings' && i.selected);
      for (const item of settingItems) {
        if (this.cancelRequested) break;
        this.currentTask.currentCategory = `Settings: ${item.name}`;
        emitProgress();

        const destItemDir = path.join(snapshotDir, 'AppSettings', item.id);
        fs.mkdirSync(destItemDir, { recursive: true });

        if (fs.existsSync(item.path)) {
          const stat = fs.statSync(item.path);
          if (stat.isDirectory()) {
            await this.copyDirRecursive(item.path, destItemDir, (evt) => {
              if (evt.type === 'file') {
                this.currentTask.copiedBytes += evt.bytes;
                this.currentTask.copiedFiles++;
                this.currentTask.currentFile = evt.fileName;
                emitProgress();
              }
            });
          } else {
            const destFile = path.join(destItemDir, path.basename(item.path));
            fs.copyFileSync(item.path, destFile);
            this.currentTask.copiedBytes += stat.size;
            this.currentTask.copiedFiles++;
            this.currentTask.currentFile = path.basename(item.path);
            emitProgress();
          }
        }

        manifest.items.push({
          id: item.id,
          name: item.name,
          category: 'settings',
          originalPath: item.path,
          relativeSnapshotPath: path.join('AppSettings', item.id)
        });
      }

      // 4. Export Environment Variables
      if (options.includeEnvironment) {
        this.currentTask.currentCategory = 'Exporting Environment Variables';
        emitProgress();

        const envDir = path.join(snapshotDir, 'EnvironmentVariables');
        fs.mkdirSync(envDir, { recursive: true });

        const envData = options.environmentData || {};
        fs.writeFileSync(
          path.join(envDir, 'environment_variables.json'),
          JSON.stringify(envData, null, 2),
          'utf8'
        );

        // Generate Restore_Environment_Vars.bat
        let batLines = [
          '@echo off',
          'echo ========================================================',
          'echo SnapShift: Restoring User Environment Variables...',
          'echo ========================================================',
          'echo.'
        ];

        if (envData.userVars) {
          for (const [k, v] of Object.entries(envData.userVars)) {
            if (k && v && !k.startsWith('ANTIGRAVITY_') && k !== 'TEMP' && k !== 'TMP') {
              const safeVal = v.replace(/"/g, '\\"');
              batLines.push(`echo Setting User Variable: ${k}`);
              batLines.push(`setx "${k}" "${safeVal}" >nul`);
            }
          }
        }

        batLines.push('echo.');
        batLines.push('echo [SUCCESS] Environment variables restored successfully!');
        batLines.push('pause');
        fs.writeFileSync(path.join(envDir, 'Restore_Environment_Vars.bat'), batLines.join('\r\n'), 'utf8');

        manifest.items.push({
          id: 'environment_vars',
          name: 'Environment Variables',
          category: 'system',
          relativeSnapshotPath: 'EnvironmentVariables'
        });
      }

      // 5. Export Software Reinstallation Packages
      if (options.includeSoftware && options.software) {
        this.currentTask.currentCategory = 'Generating Software Installers';
        emitProgress();

        const softDir = path.join(snapshotDir, 'SoftwareReinstaller');
        fs.mkdirSync(softDir, { recursive: true });

        fs.writeFileSync(
          path.join(softDir, 'software_inventory.json'),
          JSON.stringify(options.software, null, 2),
          'utf8'
        );

        // Generate Reinstall_Apps.bat (Automated Winget batch installer)
        const wingetApps = options.software.wingetApps || [];
        let wingetBat = [
          '@echo off',
          'echo ========================================================',
          'echo SnapShift: 1-Click Automated Software Reinstallation',
          'echo ========================================================',
          'echo.',
          'echo This script will automatically reinstall your previous software suite using Windows Winget.',
          'echo Please keep your internet connection active.',
          'echo.',
          'pause',
          'echo.'
        ];

        for (const app of wingetApps) {
          wingetBat.push(`echo [INSTALLING] ${app.name} (${app.id})...`);
          wingetBat.push(`winget install --id "${app.id}" --accept-source-agreements --accept-package-agreements --silent`);
          wingetBat.push('echo.');
        }

        wingetBat.push('echo ========================================================');
        wingetBat.push('echo [COMPLETED] All available software installations finished!');
        wingetBat.push('echo ========================================================');
        wingetBat.push('pause');

        fs.writeFileSync(path.join(softDir, 'Reinstall_All_Apps.bat'), wingetBat.join('\r\n'), 'utf8');

        // Generate VS Code Extensions installer
        const vscodeExts = options.software.vscodeExtensions || [];
        if (vscodeExts.length > 0) {
          let extBat = [
            '@echo off',
            'echo ========================================================',
            'echo SnapShift: Reinstalling VS Code Extensions',
            'echo ========================================================',
            'echo.'
          ];
          for (const ext of vscodeExts) {
            extBat.push(`echo Installing extension: ${ext}`);
            extBat.push(`code --install-extension "${ext}"`);
          }
          extBat.push('echo.');
          extBat.push('echo [COMPLETED] VS Code extensions restored!');
          extBat.push('pause');
          fs.writeFileSync(path.join(softDir, 'Install_VSCode_Extensions.bat'), extBat.join('\r\n'), 'utf8');
        }

        manifest.items.push({
          id: 'software_inventory',
          name: 'Software Inventory',
          category: 'software',
          relativeSnapshotPath: 'SoftwareReinstaller',
          wingetCount: wingetApps.length,
          vscodeExtCount: vscodeExts.length
        });
      }

      // 6. Generate Self-Contained Zero-Dependency Restore Suite
      this.currentTask.currentCategory = 'Building Zero-Dependency Restore Suite';
      emitProgress();

      this.generateStandaloneRestoreSuite(snapshotDir, manifest, options);

      // Save final Manifest
      fs.writeFileSync(
        path.join(snapshotDir, 'snapshot_manifest.json'),
        JSON.stringify(manifest, null, 2),
        'utf8'
      );

      this.currentTask.status = this.cancelRequested ? 'cancelled' : 'completed';
      emitProgress({ currentCategory: this.cancelRequested ? 'Cancelled' : 'Completed Successfully!' });

      return {
        success: !this.cancelRequested,
        snapshotDir,
        manifest
      };

    } catch (err) {
      this.currentTask.status = 'error';
      this.currentTask.errors.push(err.message);
      emitProgress({ currentCategory: 'Error occurred' });
      throw err;
    }
  }

  /**
   * Generates the zero-dependency scripts & offline viewer in the snapshot folder
   */
  generateStandaloneRestoreSuite(snapshotDir, manifest, options) {
    // 1. One-Click Batch Restorer: RESTORE_ALL_FILES.bat
    const restoreBat = [
      '@echo off',
      'title SnapShift 1-Click System Restorer',
      'color 0A',
      'echo =====================================================================',
      'echo        SNAPSHIFT: ZERO-DEPENDENCY RESTORATION SUITE',
      'echo =====================================================================',
      'echo Current Windows User: %USERNAME%',
      'echo Target Profile Path : %USERPROFILE%',
      'echo.',
      'echo This script will restore all your saved personal files and configurations',
      'echo directly into your new Windows profile from this backup.',
      'echo.',
      'set /p confirm="Do you want to proceed with full restoration? (Y/N): "',
      'if /i not "%confirm%"=="Y" exit /b',
      'echo.',
      'echo [1/5] Restoring Personal User Folders...',
      'if exist "UserProfile" (',
      '  for /D %%d in ("UserProfile\\*") do (',
      '    echo  - Restoring %%~nxd...',
      '    robocopy "%%d" "%USERPROFILE%\\%%~nxd" /E /XJ /R:1 /W:1 /MT:8 /NP',
      '  )',
      ')',
      'echo.',
      'echo [2/5] Restoring Developer Keys & Configurations...',
      'if exist "DeveloperConfigs" (',
      '  for /D %%d in ("DeveloperConfigs\\*") do (',
      '    echo  - Restoring directory %%~nxd...',
      '    robocopy "%%d" "%USERPROFILE%\\%%~nxd" /E /XJ /R:1 /W:1 /MT:8 /NP',
      '  )',
      '  for %%f in ("DeveloperConfigs\\*") do (',
      '    echo  - Restoring file %%~nxf...',
      '    copy /Y "%%f" "%USERPROFILE%\\%%~nxf" >nul',
      '  )',
      ')',
      'echo.',
      'echo [3/5] Restoring Application Settings & Bookmarks...',
      'if exist "AppSettings\\vscode_user_settings" (',
      '  echo  - Restoring VS Code User Settings...',
      '  robocopy "AppSettings\\vscode_user_settings" "%APPDATA%\\Code\\User" /E /XJ /R:1 /W:1 /MT:8 /NP',
      ')',
      'if exist "AppSettings\\chrome_bookmarks\\Bookmarks" (',
      '  echo  - Restoring Google Chrome Bookmarks...',
      '  if not exist "%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default" mkdir "%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default"',
      '  copy /Y "AppSettings\\chrome_bookmarks\\Bookmarks" "%LOCALAPPDATA%\\Google\\Chrome\\User Data\\Default\\Bookmarks" >nul',
      ')',
      'if exist "AppSettings\\edge_bookmarks\\Bookmarks" (',
      '  echo  - Restoring Microsoft Edge Bookmarks...',
      '  if not exist "%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\Default" mkdir "%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\Default"',
      '  copy /Y "AppSettings\\edge_bookmarks\\Bookmarks" "%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\Default\\Bookmarks" >nul',
      ')',
      'if exist "AppSettings\\windows_terminal\\settings.json" (',
      '  echo  - Restoring Windows Terminal Settings...',
      '  if not exist "%LOCALAPPDATA%\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState" mkdir "%LOCALAPPDATA%\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState"',
      '  copy /Y "AppSettings\\windows_terminal\\settings.json" "%LOCALAPPDATA%\\Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState\\settings.json" >nul',
      ')',
      'if exist "AppSettings\\qbittorrent_data" (',
      '  echo  - Restoring qBittorrent Data & State...',
      '  robocopy "AppSettings\\qbittorrent_data" "%APPDATA%\\qBittorrent" /E /XJ /R:1 /W:1 /MT:8 /NP',
      ')',
      'if exist "AppSettings\\localsend_data" (',
      '  echo  - Restoring LocalSend Preferences...',
      '  robocopy "AppSettings\\localsend_data" "%APPDATA%\\LocalSend" /E /XJ /R:1 /W:1 /MT:8 /NP',
      ')',
      'if exist "AppSettings\\vlc_settings" (',
      '  echo  - Restoring VLC Settings...',
      '  robocopy "AppSettings\\vlc_settings" "%APPDATA%\\vlc" /E /XJ /R:1 /W:1 /MT:8 /NP',
      ')',
      'if exist "AppSettings\\game_saves_emu" (',
      '  echo  - Restoring Game Saves...',
      '  robocopy "AppSettings\\game_saves_emu" "%APPDATA%\\Goldberg SocialClub Emu Saves" /E /XJ /R:1 /W:1 /MT:8 /NP',
      ')',
      'echo.',
      'echo [4/5] Restoring Environment Variables...',
      'if exist "EnvironmentVariables\\Restore_Environment_Vars.bat" call "EnvironmentVariables\\Restore_Environment_Vars.bat"',
      'echo.',
      'echo [5/5] Reinstalling Previous Software Suite...',
      'set /p installApps="Would you like to auto-reinstall your previous software now? (Y/N): "',
      'if /i "%installApps%"=="Y" (',
      '  if exist "SoftwareReinstaller\\Reinstall_All_Apps.bat" call "SoftwareReinstaller\\Reinstall_All_Apps.bat"',
      '  if exist "SoftwareReinstaller\\Install_VSCode_Extensions.bat" call "SoftwareReinstaller\\Install_VSCode_Extensions.bat"',
      ')',
      'echo.',
      'echo =====================================================================',
      'echo   [COMPLETED] All your files and environment have been restored!',
      'echo =====================================================================',
      'pause'
    ];
    fs.writeFileSync(path.join(snapshotDir, 'RESTORE_ALL_FILES.bat'), restoreBat.join('\r\n'), 'utf8');

    // 2. Interactive PowerShell Restorer: RESTORE_INTERACTIVE.ps1
    const psRestore = [
      '# SnapShift Interactive Selective Restorer',
      'Write-Host "=================================================" -ForegroundColor Cyan',
      'Write-Host "  SNAPSHIFT: SELECTIVE RESTORATION ASSISTANT     " -ForegroundColor Yellow',
      'Write-Host "=================================================" -ForegroundColor Cyan',
      'Write-Host "Target User Profile: $env:USERPROFILE" -ForegroundColor Gray',
      'Write-Host ""',
      'Write-Host "[1] Restore Personal Folders (Desktop, Documents, Pictures, Videos, etc.)"',
      'Write-Host "[2] Restore Developer Toolchains (.ssh, .vscode, .gemini, git, etc.)"',
      'Write-Host "[3] Restore App Settings (VS Code User Settings & Browser Bookmarks)"',
      'Write-Host "[4] Restore User Environment Variables (PATH, etc.)"',
      'Write-Host "[5] Reinstall All Software Packages (Winget Automated Batch)"',
      'Write-Host "[A] RESTORE EVERYTHING (1-Click Full System Restore)"',
      'Write-Host "[Q] Quit"',
      'Write-Host ""',
      '$choice = (Read-Host "Enter your choice (1-5, A, or Q)").ToUpper()',
      '',
      'switch ($choice) {',
      '  "1" {',
      '    Write-Host "`n>> Restoring Personal Folders..." -ForegroundColor Green',
      '    if (Test-Path "$PSScriptRoot\\UserProfile") {',
      '      Get-ChildItem -Path "$PSScriptRoot\\UserProfile" -Directory | ForEach-Object {',
      '        $dest = Join-Path $env:USERPROFILE $_.Name',
      '        robocopy $_.FullName $dest /E /XJ /R:1 /W:1 /MT:8 /NP',
      '      }',
      '    }',
      '  }',
      '  "2" {',
      '    Write-Host "`n>> Restoring Developer Configs..." -ForegroundColor Green',
      '    if (Test-Path "$PSScriptRoot\\DeveloperConfigs") {',
      '      Get-ChildItem -Path "$PSScriptRoot\\DeveloperConfigs" -Directory | ForEach-Object {',
      '        $dest = Join-Path $env:USERPROFILE $_.Name',
      '        robocopy $_.FullName $dest /E /XJ /R:1 /W:1 /MT:8 /NP',
      '      }',
      '      Get-ChildItem -Path "$PSScriptRoot\\DeveloperConfigs" -File | ForEach-Object {',
      '        Copy-Item -Path $_.FullName -Destination (Join-Path $env:USERPROFILE $_.Name) -Force',
      '      }',
      '    }',
      '  }',
      '  "3" {',
      '    Write-Host "`n>> Restoring App Settings & Bookmarks..." -ForegroundColor Green',
      '    if (Test-Path "$PSScriptRoot\\AppSettings\\vscode_user_settings") {',
      '      $vscodeDest = Join-Path $env:APPDATA "Code\\User"',
      '      robocopy "$PSScriptRoot\\AppSettings\\vscode_user_settings" $vscodeDest /E /XJ /R:1 /W:1 /MT:8 /NP',
      '    }',
      '    if (Test-Path "$PSScriptRoot\\AppSettings\\chrome_bookmarks\\Bookmarks") {',
      '      $chromeDir = Join-Path $env:LOCALAPPDATA "Google\\Chrome\\User Data\\Default"',
      '      New-Item -ItemType Directory -Path $chromeDir -Force | Out-Null',
      '      Copy-Item "$PSScriptRoot\\AppSettings\\chrome_bookmarks\\Bookmarks" "$chromeDir\\Bookmarks" -Force',
      '    }',
      '    if (Test-Path "$PSScriptRoot\\AppSettings\\edge_bookmarks\\Bookmarks") {',
      '      $edgeDir = Join-Path $env:LOCALAPPDATA "Microsoft\\Edge\\User Data\\Default"',
      '      New-Item -ItemType Directory -Path $edgeDir -Force | Out-Null',
      '      Copy-Item "$PSScriptRoot\\AppSettings\\edge_bookmarks\\Bookmarks" "$edgeDir\\Bookmarks" -Force',
      '    }',
      '    if (Test-Path "$PSScriptRoot\\AppSettings\\windows_terminal\\settings.json") {',
      '      $termDir = Join-Path $env:LOCALAPPDATA "Packages\\Microsoft.WindowsTerminal_8wekyb3d8bbwe\\LocalState"',
      '      New-Item -ItemType Directory -Path $termDir -Force | Out-Null',
      '      Copy-Item "$PSScriptRoot\\AppSettings\\windows_terminal\\settings.json" "$termDir\\settings.json" -Force',
      '    }',
      '    if (Test-Path "$PSScriptRoot\\AppSettings\\qbittorrent_data") {',
      '      robocopy "$PSScriptRoot\\AppSettings\\qbittorrent_data" (Join-Path $env:APPDATA "qBittorrent") /E /XJ /R:1 /W:1 /MT:8 /NP',
      '    }',
      '    if (Test-Path "$PSScriptRoot\\AppSettings\\localsend_data") {',
      '      robocopy "$PSScriptRoot\\AppSettings\\localsend_data" (Join-Path $env:APPDATA "LocalSend") /E /XJ /R:1 /W:1 /MT:8 /NP',
      '    }',
      '    if (Test-Path "$PSScriptRoot\\AppSettings\\vlc_settings") {',
      '      robocopy "$PSScriptRoot\\AppSettings\\vlc_settings" (Join-Path $env:APPDATA "vlc") /E /XJ /R:1 /W:1 /MT:8 /NP',
      '    }',
      '    if (Test-Path "$PSScriptRoot\\AppSettings\\game_saves_emu") {',
      '      robocopy "$PSScriptRoot\\AppSettings\\game_saves_emu" (Join-Path $env:APPDATA "Goldberg SocialClub Emu Saves") /E /XJ /R:1 /W:1 /MT:8 /NP',
      '    }',
      '  }',
      '  "4" {',
      '    Write-Host "`n>> Restoring Environment Variables..." -ForegroundColor Green',
      '    if (Test-Path "$PSScriptRoot\\EnvironmentVariables\\Restore_Environment_Vars.bat") {',
      '      Start-Process -FilePath "$PSScriptRoot\\EnvironmentVariables\\Restore_Environment_Vars.bat" -Wait',
      '    }',
      '  }',
      '  "5" {',
      '    Write-Host "`n>> Reinstalling Software Suite..." -ForegroundColor Green',
      '    if (Test-Path "$PSScriptRoot\\SoftwareReinstaller\\Reinstall_All_Apps.bat") {',
      '      Start-Process -FilePath "$PSScriptRoot\\SoftwareReinstaller\\Reinstall_All_Apps.bat" -Wait',
      '    }',
      '  }',
      '  "A" {',
      '    Start-Process -FilePath "$PSScriptRoot\\RESTORE_ALL_FILES.bat" -Wait',
      '  }',
      '  default {',
      '    Write-Host "Exiting without changes." -ForegroundColor Yellow',
      '  }',
      '}',
      'Write-Host "`nRestoration task completed!" -ForegroundColor Cyan',
      'pause'
    ];
    fs.writeFileSync(path.join(snapshotDir, 'RESTORE_INTERACTIVE.ps1'), psRestore.join('\r\n'), 'utf8');

    // 3. Offline HTML Viewer: RESTORE_VIEWER.html
    const htmlViewer = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SnapShift — Offline Snapshot Recovery Viewer</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card: #141b2d;
      --accent: #38bdf8;
      --text: #f1f5f9;
      --muted: #94a3b8;
      --border: #1e293b;
      --success: #10b981;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 30px;
    }
    .container { max-width: 900px; margin: 0 auto; }
    .header { border-bottom: 1px solid var(--border); padding-bottom: 20px; margin-bottom: 25px; }
    .badge { background: rgba(56, 189, 248, 0.15); color: var(--accent); padding: 4px 10px; border-radius: 6px; font-size: 13px; font-weight: 600; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; }
    h1 { margin: 10px 0; font-size: 28px; }
    h2 { font-size: 18px; margin-top: 0; color: var(--accent); }
    .btn { display: inline-block; background: var(--accent); color: #0b0f19; padding: 10px 18px; border-radius: 8px; font-weight: 700; text-decoration: none; margin-right: 10px; cursor: pointer; }
    .cmd-box { background: #080c14; border: 1px solid #1e293b; padding: 12px; border-radius: 6px; font-family: monospace; margin: 10px 0; word-break: break-all; }
    ul { padding-left: 20px; }
    li { margin-bottom: 6px; color: var(--muted); }
    li strong { color: var(--text); }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <span class="badge">OFFLINE RESTORE ASSISTANT</span>
      <h1>System Snapshot Details</h1>
      <p style="color:var(--muted)">Created: ${manifest.createdAt} | Original PC: ${manifest.sourceSystem.computerName} | User: ${manifest.sourceSystem.username}</p>
    </div>

    <div class="card">
      <h2>🚀 How to Restore on your New Windows Installation</h2>
      <p>Inside this folder, you have multiple ways to restore your data completely:</p>
      <ol>
        <li><strong>Automated 1-Click (Recommended):</strong> Double-click <code style="color:var(--accent)">RESTORE_ALL_FILES.bat</code></li>
        <li><strong>Interactive Selector:</strong> Right-click <code style="color:var(--accent)">RESTORE_INTERACTIVE.ps1</code> and choose "Run with PowerShell"</li>
        <li><strong>Reinstall Apps Only:</strong> Open folder <code style="color:var(--accent)">SoftwareReinstaller</code> and run <code style="color:var(--accent)">Reinstall_All_Apps.bat</code></li>
      </ol>
    </div>

    <div class="card">
      <h2>📦 Backed Up Components</h2>
      <ul>
        ${manifest.items.map(i => `<li><strong>${i.name}</strong> (${i.category}) ${i.fileCount ? `— ${i.fileCount} files` : ''}</li>`).join('')}
      </ul>
    </div>

    <div class="card">
      <h2>💻 Inventoried Software for Winget</h2>
      <p style="color:var(--muted)">These apps can be automatically reinstalled with 1 click:</p>
      <ul>
        ${(options.software && options.software.wingetApps ? options.software.wingetApps.slice(0, 20).map(a => `<li><strong>${a.name}</strong> <code>${a.id}</code></li>`).join('') : '<li>None</li>')}
        ${(options.software && options.software.wingetApps && options.software.wingetApps.length > 20 ? `<li><em>...and ${options.software.wingetApps.length - 20} more applications</em></li>` : '')}
      </ul>
    </div>
  </div>
</body>
</html>`;
    fs.writeFileSync(path.join(snapshotDir, 'RESTORE_VIEWER.html'), htmlViewer, 'utf8');

    // 4. Migration Step-by-Step Guide: MIGRATION_GUIDE.md
    const guideMd = `# ⚡ SnapShift SSD Migration Guide

This guide walks you through replacing your SSD and restoring all your data seamlessly.

---

### Phase 1: Physical SSD Replacement
1. **Safety First:** Shut down your PC completely and turn off the power supply switch / unplug the power cable.
2. **Open the Case / Laptop:**
   - Remove the old 128GB SSD (PNY CS2040).
   - Install your brand new SSD in the M.2 / SATA slot.
   - **IMPORTANT:** Keep your internal Western Digital HDD connected! It holds all your backup data safely.

---

### Phase 2: Installing Windows on the New SSD
1. Insert your **Windows 11 / 10 USB Installation Media**.
2. Turn on the PC and boot from the USB.
3. When prompted where to install Windows, choose your **new SSD** (Drive 1 or the unallocated space).
4. Complete the Windows setup steps (language, account, etc.).

---

### Phase 3: Restoring All Your Data from the HDD
1. Once Windows boots up, open **File Explorer** and go to your **HDD drive** (\`D:\` or \`F:\`).
2. Navigate to:
   \`\`\`
   SnapShift_Snapshots -> ${path.basename(snapshotDir)}
   \`\`\`
3. Double-click:
   \`\`\`
   RESTORE_ALL_FILES.bat
   \`\`\`
4. Press \`Y\` to begin. It will automatically:
   - Restore your **Desktop, Documents, Pictures, Videos, Music, Downloads**.
   - Restore your **SSH keys (.ssh)** and **Git config**.
   - Restore **VS Code extensions and settings**.
   - Restore your **Environment variables (PATH)**.
   - Prompt you to auto-reinstall all your software with **Winget**!
`;
    fs.writeFileSync(path.join(snapshotDir, 'MIGRATION_GUIDE.md'), guideMd, 'utf8');
  }
}

module.exports = new SnapshotEngine();
