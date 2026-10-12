#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { performFullScan, detectDisksAndVolumes, formatBytes } = require('./lib/scanner');
const snapshotEngine = require('./lib/snapshotEngine');
const restoreEngine = require('./lib/restoreEngine');

// ANSI Colors
const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  red: '\x1b[31m',
  bgDark: '\x1b[40m'
};

function banner() {
  console.clear();
  console.log(`
${C.cyan}${C.bold}   ███████╗███╗   ██╗ █████╗ ██████╗ ███████╗██╗  ██╗██╗███████╗████████╗
   ██╔════╝████╗  ██║██╔══██╗██╔══██╗██╔════╝██║  ██║██║██╔════╝╚══██╔══╝
   ███████╗██╔██╗ ██║███████║██████╔╝███████╗███████║██║█████╗     ██║   
   ╚════██║██║╚██╗██║██╔══██║██╔═══╝ ╚════██║██╔══██║██║██╔══╝     ██║   
   ███████║██║ ╚████║██║  ██║██║     ███████║██║  ██║██║██║        ██║   
   ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝     ╚══════╝╚═╝  ╚═╝╚═╝╚═╝        ╚═╝   ${C.reset}
   ${C.magenta}${C.bold}>> SSD UPGRADE & WORKSPACE MIGRATION SUITE <<${C.reset}
   ${C.dim}Safe, 1-Click Snapshot & Restore without OS bloat${C.reset}
  `);
}

function prompt(question) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function renderProgressBar(percent, width = 35) {
  const complete = Math.round((width * percent) / 100);
  const incomplete = width - complete;
  const bar = '█'.repeat(complete) + '░'.repeat(incomplete);
  return `[${C.cyan}${bar}${C.reset}] ${percent}%`;
}

async function runCli() {
  const args = process.argv.slice(2);

  banner();

  console.log(`${C.yellow}>> Scanning storage topology and hardware devices...${C.reset}\n`);
  const scanData = await performFullScan();

  // Print Storage Map
  console.log(`${C.bold}--- PHYSICAL STORAGE TOPOLOGY ---${C.reset}`);
  scanData.disks.physicalDisks.forEach(d => {
    const isSSD = d.isSourceSSD;
    const tag = isSSD ? `${C.red}[SOURCE SSD TO REPLACE]${C.reset}` : `${C.green}[SAFE INTERNAL HDD]${C.reset}`;
    console.log(`  * ${C.bold}${d.name}${C.reset} (${d.mediaType}, ${d.sizeFormatted}) -> ${tag}`);
  });

  console.log(`\n${C.bold}--- VOLUMES & AVAILABLE SPACE ---${C.reset}`);
  scanData.disks.volumes.forEach(v => {
    const isC = v.isSystemDrive;
    const badge = isC ? `${C.red}[C: Windows Drive]${C.reset}` : `${C.green}[Safe Storage: ${v.freeFormatted} Free]${C.reset}`;
    console.log(`  * ${C.bold}${v.driveLetter}${C.reset} (${v.label}) - Total: ${v.totalFormatted} | Free: ${v.freeFormatted} -> ${badge}`);
  });

  console.log(`\n${C.bold}--- USER WORKSPACE ASSESSMENT ---${C.reset}`);
  console.log(`  * User Profile: ${C.cyan}${scanData.systemInfo.userProfile}${C.reset}`);
  console.log(`  * Total Estimated Backup: ${C.bold}${C.green}${scanData.summary.totalFormatted}${C.reset} across ${scanData.summary.totalFiles} files`);
  console.log(`  * Winget Software Identified: ${C.cyan}${scanData.summary.wingetCount} applications${C.reset}`);
  console.log(`  * VS Code Extensions: ${C.cyan}${scanData.summary.vscodeExtCount} extensions${C.reset}`);
  console.log(`  * Recommended Safe Target: ${C.bold}${C.green}${scanData.disks.recommendedBackupDrive}${C.reset} (Internal HDD)\n`);

  // CLI Arguments handling
  if (args.includes('--scan-only')) {
    console.log(`${C.green}Scan completed.${C.reset}`);
    process.exit(0);
  }

  if (args.includes('--auto-snapshot')) {
    const targetDrive = scanData.disks.recommendedBackupDrive || 'D:';
    await executeSnapshot(scanData, targetDrive);
    process.exit(0);
  }

  // Interactive Menu Loop
  while (true) {
    console.log(`\n${C.bold}MAIN MENU:${C.reset}`);
    console.log(`  ${C.cyan}[1]${C.reset} Capture Full Workspace Snapshot to HDD (Recommended)`);
    console.log(`  ${C.cyan}[2]${C.reset} Restore Workspace from an Existing Snapshot`);
    console.log(`  ${C.cyan}[3]${C.reset} View Installed Software / Winget Reinstall Script`);
    console.log(`  ${C.cyan}[4]${C.reset} Launch Web Dashboard (Modern Glassmorphic UI)`);
    console.log(`  ${C.cyan}[5]${C.reset} Exit\n`);

    const choice = await prompt(`${C.bold}Select an option (1-5): ${C.reset}`);

    if (choice === '1') {
      const defaultDrive = scanData.disks.recommendedBackupDrive || 'D:';
      const driveChoice = await prompt(`Enter destination drive letter (Default: ${defaultDrive}): `);
      const targetDrive = driveChoice ? (driveChoice.includes(':') ? driveChoice.toUpperCase() : `${driveChoice.toUpperCase()}:`) : defaultDrive;
      await executeSnapshot(scanData, targetDrive);
    } else if (choice === '2') {
      await executeRestore();
    } else if (choice === '3') {
      displaySoftwareList(scanData);
    } else if (choice === '4') {
      console.log(`\n${C.green}Starting SnapShift Web Studio...${C.reset}`);
      const { startServer } = require('./server');
      await startServer(4242);
      const { exec } = require('child_process');
      exec('start http://127.0.0.1:4242');
      console.log(`Web Studio running at ${C.cyan}http://127.0.0.1:4242${C.reset}.`);
    } else if (choice === '5') {
      console.log('\nGoodbye!');
      process.exit(0);
    } else {
      console.log(`${C.yellow}Invalid option. Please enter 1-5.${C.reset}`);
    }
  }
}

async function executeSnapshot(scanData, targetDrive) {
  console.log(`\n${C.yellow}Starting Snapshot to ${targetDrive}\\SnapShift_Snapshots...${C.reset}`);

  const allItems = [
    ...scanData.categories.personal,
    ...scanData.categories.developer,
    ...scanData.categories.settings
  ];

  // Prepare items selection (exclude downloads if user wants or keep all)
  const items = allItems.map(i => ({ ...i, selected: i.id !== 'downloads' || i.bytes < 5 * 1024 * 1024 * 1024 }));
  const selectedItems = items.filter(i => i.selected);
  const estimatedBytes = selectedItems.reduce((acc, cur) => acc + (cur.bytes || 0), 0);
  const estimatedFiles = selectedItems.reduce((acc, cur) => acc + (cur.fileCount || 0), 0);

  const options = {
    targetDrive,
    items,
    includeEnvironment: true,
    environmentData: scanData.categories.environment,
    includeSoftware: true,
    software: scanData.software,
    estimatedBytes,
    estimatedFiles
  };

  let lastLineLength = 0;

  try {
    const result = await snapshotEngine.createSnapshot(options, (status) => {
      const bar = renderProgressBar(status.percent);
      const speed = status.speedMBps ? `[${status.speedMBps} MB/s]` : '';
      const text = `\r${bar} ${C.dim}${status.copiedBytesFormatted} / ${status.totalBytesFormatted}${C.reset} ${speed} ${C.yellow}${status.currentCategory}${C.reset}: ${C.dim}${status.currentFile.slice(0, 30)}${C.reset} `;
      process.stdout.write(text.padEnd(lastLineLength));
      lastLineLength = text.length;
    });

    console.log(`\n\n${C.green}${C.bold}======================================================${C.reset}`);
    console.log(`${C.green}${C.bold} [SUCCESS] SNAPSHOT CREATED SUCCESSFULLY!${C.reset}`);
    console.log(`${C.green}${C.bold}======================================================${C.reset}`);
    console.log(`Location: ${C.cyan}${result.snapshotDir}${C.reset}\n`);
    console.log(`${C.bold}Zero-Dependency Restore Tools generated inside snapshot:${C.reset}`);
    console.log(`  * ${C.green}RESTORE_ALL_FILES.bat${C.reset} -> Run this on new Windows to restore everything!`);
    console.log(`  * ${C.green}RESTORE_INTERACTIVE.ps1${C.reset} -> Interactive PowerShell restorer`);
    console.log(`  * ${C.green}RESTORE_VIEWER.html${C.reset} -> Offline HTML viewer (open directly in Edge/Chrome)`);
    console.log(`  * ${C.green}MIGRATION_GUIDE.md${C.reset} -> Complete step-by-step physical replacement manual\n`);
  } catch (err) {
    console.log(`\n${C.red}[ERROR] Snapshot failed: ${err.message}${C.reset}`);
  }
}

async function executeRestore() {
  console.log(`\n${C.cyan}Searching for existing snapshots on HDD...${C.reset}`);
  const snapshots = restoreEngine.findSnapshots();

  if (snapshots.length === 0) {
    console.log(`${C.yellow}No snapshots found in D:\\SnapShift_Snapshots or F:\\SnapShift_Snapshots.${C.reset}`);
    return;
  }

  console.log(`\nFound ${snapshots.length} snapshot(s):`);
  snapshots.forEach((s, idx) => {
    console.log(`  [${idx + 1}] ${s.id} (Created: ${s.createdAt}) on Drive ${s.drive}`);
  });

  const choice = await prompt(`\nSelect snapshot number to restore (1-${snapshots.length}): `);
  const idx = parseInt(choice, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= snapshots.length) {
    console.log('Invalid selection.');
    return;
  }

  const selected = snapshots[idx];
  console.log(`\nRestoring from: ${selected.path}...`);

  try {
    await restoreEngine.restoreSnapshot(selected.path, {}, (status) => {
      process.stdout.write(`\r${C.cyan}Restoring:${C.reset} ${status.currentCategory} - Files: ${status.copiedFiles} (${status.copiedBytesFormatted})`);
    });
    console.log(`\n\n${C.green}[SUCCESS] Files restored into ${process.env.USERPROFILE}!${C.reset}\n`);
  } catch (err) {
    console.log(`\n${C.red}[ERROR] Restore failed: ${err.message}${C.reset}`);
  }
}

function displaySoftwareList(scanData) {
  console.log(`\n${C.bold}--- INVENTORIED SOFTWARE (${scanData.software.wingetApps.length} packages) ---${C.reset}`);
  scanData.software.wingetApps.forEach(a => {
    console.log(`  - ${C.cyan}${a.name.padEnd(35)}${C.reset} ID: ${C.dim}${a.id}${C.reset}`);
  });
  console.log(`\nTo install on new PC: Run ${C.green}SoftwareReinstaller\\Reinstall_All_Apps.bat${C.reset}`);
}

if (require.main === module) {
  runCli().catch(err => console.error(err));
}

module.exports = { runCli };
