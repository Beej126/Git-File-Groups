import * as vscode from 'vscode';

// Centralized logging utilities and output channel for the extension.
const outputChannel = vscode.window.createOutputChannel('Git File Groups');

// Module-level set of enabled features for logging.
let loggedFeaturesGlobal: Set<string> = new Set();
export function setLoggedFeatures(features: string[] | undefined) {
  if (!Array.isArray(features)) {
    loggedFeaturesGlobal = new Set();
    return;
  }
  loggedFeaturesGlobal = new Set(features.filter(f => typeof f === 'string' && f.trim().length > 0).map(f => f.trim()));
}

export function log(message: string, feature: string) {
  if (loggedFeaturesGlobal.size > 0 && !loggedFeaturesGlobal.has(feature)) {
    return;
  }
  const timestamp = new Date().toISOString();
  const formattedMessage = `[${timestamp} ${feature}] ${message}`;
  console.log(message);
  outputChannel.appendLine(formattedMessage);
}

// Storage-specific logger that always writes (used for storage errors etc.)
export default {
  log,
  setLoggedFeatures
};
