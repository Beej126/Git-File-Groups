#!/usr/bin/env node

const { execSync } = require('child_process');

// This script will trigger a reload of the extension host
// by sending a command to VS Code/Windsurf

try {
  // Try to use VS Code's command line interface to send the reload command
  execSync('code --command "workbench.action.reloadWindow"', { stdio: 'inherit' });
} catch (error) {
  try {
    // Fallback for Windsurf
    execSync('windsurf --command "workbench.action.reloadWindow"', { stdio: 'inherit' });
  catch (error2) {
    console.log('Could not auto-reload. Please manually reload with Ctrl+Shift+P → "Developer: Reload Window"');
  }
}
