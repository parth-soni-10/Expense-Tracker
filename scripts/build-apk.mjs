#!/usr/bin/env node
/* Build the cents. Android APK with Capacitor.
   Stage 1 — copy the static web app into www/ (Capacitor's webDir).
   Stage 2 — `cap add android` if the platform is missing (generated, gitignored).
   Stage 3 — `cap sync android` (copies www/ into the Android project).
   Stage 4 — Gradle assembleDebug, producing the installable APK.
   Requires Node 22+; the Gradle step additionally needs JDK 21 and the
   Android SDK, which are preinstalled on GitHub Actions ubuntu runners.
   Usage: node scripts/build-apk.mjs [stage|add|sync|gradle|all]   (default: all)
   The generated APK lands at android/app/build/outputs/apk/debug/app-debug.apk. */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WWW = join(ROOT, 'www');
const ANDROID = join(ROOT, 'android');

// The static site has no build step — this is the same set of files the
// deployed Netlify site serves, and the same set that ships inside the APK.
const WEB_FILES = [
  'index.html', 'app.js', 'styles.css', 'settings.js', 'storage.js',
  'seed.js', 'sync.js', 'sync-merge.js', 'vendor',
];

const step = process.argv[2] || 'all';

function run(cmd) {
  console.log('>', cmd);
  execSync(cmd, { cwd: ROOT, stdio: 'inherit' });
}

function stage() {
  rmSync(WWW, { recursive: true, force: true });
  mkdirSync(WWW, { recursive: true });
  for (const f of WEB_FILES) cpSync(join(ROOT, f), join(WWW, f), { recursive: true });
  console.log(`www/ staged with ${WEB_FILES.length} entries`);
}

function add() {
  if (existsSync(ANDROID)) {
    console.log('android/ already exists — skipping cap add');
  } else {
    run('npx cap add android');
  }
}

function sync() {
  run('npx cap sync android');
}

function gradle() {
  run('cd android && ./gradlew assembleDebug');
  console.log('APK ready: android/app/build/outputs/apk/debug/app-debug.apk');
}

if (step === 'stage') stage();
else if (step === 'add') add();
else if (step === 'sync') sync();
else if (step === 'gradle') gradle();
else { stage(); add(); sync(); gradle(); }
