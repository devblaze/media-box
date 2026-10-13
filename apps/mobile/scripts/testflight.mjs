#!/usr/bin/env node
// TESTFLIGHT: builds the iPhone app (apps/mobile) from GitHub's `main` and uploads it to TestFlight, by hand or by itself
// on a clock (a LaunchAgent on the owner's Mac), so the app on the owner's phone keeps up with main. It works in its own
// clone under ~/.mediabox-testflight, never in your checkout.
//
//   node apps/mobile/scripts/testflight.mjs build [--commit <sha>]   build origin/main (or a commit of it) now
//   node apps/mobile/scripts/testflight.mjs check                    the clock's job: build when main moved and the app
//                                                                    changed (anything in apps/mobile/ but docs)
//   node apps/mobile/scripts/testflight.mjs status                   what it last did and the newest builds on App Store Connect
//   node apps/mobile/scripts/testflight.mjs install [--minutes 10]   copy this script to ~/.mediabox-testflight, start the clock
//   node apps/mobile/scripts/testflight.mjs uninstall                stop the clock (the clone and logs stay)
//
// A build: check out the commit, `npm ci` in apps/mobile when its lock file changed, write the TestFlight settings into
// the clone's app.json (BUNDLE_ID below, the next build number — the highest on App Store Connect + 1 — and "no
// non-exempt encryption", so builds don't wait on the export compliance question), `expo prebuild` the native project,
// raise pod deployment targets Xcode 27 refuses, `pod install`, build the ExpoModulesJSI slice ahead of Xcode, archive
// with the team's App Store Connect key (automatic signing), export and upload, wait until Apple has processed it, then write "What to test" from the app's commits since
// the last build. Internal groups with every build ("Owner") get it at once. A macOS notification says how it went; the
// full log is in ~/.mediabox-testflight/logs. A commit that fails is tried again at most twice, then the clock waits for
// the next one. When the app's version (`expo.version` in apps/mobile/app.json, e.g. 1.0.0) is out on the App Store,
// TestFlight takes no more builds of it: raise it on main.
//
// Needs: Xcode, CocoaPods, Node 24, git with access to the GitHub repo, and the team API key (Admin) at
// ~/.appstoreconnect/private_keys/AuthKey_<id>.p8. Env overrides: MEDIABOX_TESTFLIGHT_HOME, MEDIABOX_REPO_URL,
// ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH. Change this file? Run `install` again to copy it over.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// MARK: Settings

const HOME = process.env.MEDIABOX_TESTFLIGHT_HOME ?? path.join(os.homedir(), '.mediabox-testflight');
const REPO_URL = process.env.MEDIABOX_REPO_URL ?? 'git@github.com:devblaze/media-box.git';
const BRANCH = 'main';
/** The App Store Connect app is registered under this ID; app.json's own (org.mediabox.app) stays for Android and dev. */
const BUNDLE_ID = 'org.ncatechsolutions.mediabox';
const TEAM_ID = 'ZL3FMLFVRF';
const KEY_ID = process.env.ASC_KEY_ID ?? 'J6N632W7W6';
const ISSUER_ID = process.env.ASC_ISSUER_ID ?? '24ac22a0-335d-4f71-ba72-dcdd8548e360';
const KEY_PATH = process.env.ASC_KEY_PATH ?? path.join(os.homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${KEY_ID}.p8`);
const LABEL = 'org.ncatechsolutions.mediabox.testflight';
const AGENT_PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
/** A change under here needs a new app; server-only changes don't. */
const APP_DIR = 'apps/mobile/';
const NOT_APP = [/\.md$/, /^apps\/mobile\/(\.vscode|\.claude)\//, /^apps\/mobile\/LICENSE$/, /^apps\/mobile\/scripts\/testflight\.mjs$/];
/** Xcode 27 refuses pod targets below this (async-storage's resource bundle still says 13.4). */
const MIN_POD_TARGET = '15.1';
/** CocoaPods refuses to run without a UTF-8 locale, and launchd gives none; CI keeps `expo` from asking anything. */
const BUILD_ENV = { LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', CI: '1' };
const RETRIES = 2;          // a failed commit is tried this many times more
const KEEP_ARCHIVES = 3;
const KEEP_LOGS = 40;
const PROCESSING_MINUTES = 45;
/** App Store states after which the version's TestFlight train is closed to new builds. */
const CLOSED = new Set(['PENDING_APPLE_RELEASE', 'PENDING_DEVELOPER_RELEASE', 'PROCESSING_FOR_APP_STORE', 'READY_FOR_DISTRIBUTION',
  'READY_FOR_SALE', 'REPLACED_WITH_NEW_VERSION', 'REMOVED_FROM_SALE', 'DEVELOPER_REMOVED_FROM_SALE']);

const REPO = path.join(HOME, 'repo');
const MOBILE = path.join(REPO, APP_DIR);
const STATE = path.join(HOME, 'state.json');
const LOGS = path.join(HOME, 'logs');
const LOCK = path.join(HOME, 'lock');

// MARK: Small helpers

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
let logFile = null;
function say(line) {
  const text = `[${stamp()}] ${line}`;
  console.log(text);
  if (logFile) fs.appendFileSync(logFile, text + '\n');
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return { failures: {}, history: [] }; }
}
function writeState(s) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(STATE, JSON.stringify(s, null, 2));
}

/** Runs a command; its output goes to the log (and the terminal when `show`). Resolves with the exit code and the tail. */
function run(cmd, args, { cwd = REPO, env = {}, show = false, quiet = false } = {}) {
  if (!quiet) say(`$ ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    let out = '';
    const take = (chunk) => {
      const text = chunk.toString();
      out += text.length < 200_000 ? text : '';
      if (out.length > 400_000) out = out.slice(-200_000);
      if (logFile && !quiet) fs.appendFileSync(logFile, text);
      if (show) process.stdout.write(text);
      for (const l of text.split('\n')) if (l.trim()) { tail.push(l); if (tail.length > 60) tail.shift(); }
    };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    child.on('error', (e) => resolve({ code: 127, out: String(e), tail: [String(e)] }));
    child.on('close', (code) => resolve({ code: code ?? 1, out, tail }));
  });
}
async function must(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (r.code !== 0) {
    const errors = r.tail.filter((l) => /error|fail|denied|unable/i.test(l)).slice(-8);
    throw new Error(`${cmd} ${args[0] ?? ''} failed (exit ${r.code}): ${(errors.length ? errors : r.tail.slice(-8)).join(' | ')}`);
  }
  return r;
}
const git = (args, opts) => must('git', args, { quiet: true, ...opts });

function notify(title, text) {
  const q = (s) => `"${String(s).replace(/["\\]/g, '\\$&').slice(0, 220)}"`;
  spawn('osascript', ['-e', `display notification ${q(text)} with title ${q(title)}`], { stdio: 'ignore' }).on('error', () => {});
}

/** One run at a time (the clock and a build by hand). */
function takeLock() {
  fs.mkdirSync(HOME, { recursive: true });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      process.on('exit', () => { try { if (fs.readFileSync(LOCK, 'utf8') === String(process.pid)) fs.unlinkSync(LOCK); } catch { /* gone */ } });
      return true;
    } catch {
      const pid = Number(fs.readFileSync(LOCK, 'utf8'));
      try { process.kill(pid, 0); return false; } catch { fs.rmSync(LOCK, { force: true }); }
    }
  }
  return false;
}

// MARK: App Store Connect

function ascToken() {
  const key = fs.readFileSync(KEY_PATH, 'utf8');
  const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' })}.${b64({ iss: ISSUER_ID, iat: now, exp: now + 1100, aud: 'appstoreconnect-v1' })}`;
  return `${data}.${crypto.sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
async function asc(method, p, body) {
  const r = await fetch(`https://api.appstoreconnect.apple.com${p}`, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${ascToken()}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) throw new Error(`App Store Connect ${method} ${p.split('?')[0]}: ${r.status} ${json?.errors?.map((e) => e.detail ?? e.title).join('; ') ?? text.slice(0, 200)}`);
  return json;
}
/** The app record has to be made by hand once: Apple's API can't create apps. */
async function appId() {
  const a = await asc('GET', `/v1/apps?filter[bundleId]=${BUNDLE_ID}&fields[apps]=bundleId`);
  const app = a.data.find((x) => x.attributes.bundleId === BUNDLE_ID);
  if (!app) throw new Error(`No App Store Connect app has the bundle ID ${BUNDLE_ID}. Make it once: appstoreconnect.apple.com → Apps → + → New App (iOS, bundle ID ${BUNDLE_ID}).`);
  return app.id;
}
async function newestBuildNumber(app) {
  const b = await asc('GET', `/v1/builds?filter[app]=${app}&sort=-uploadedDate&limit=200&fields[builds]=version`);
  return Math.max(0, ...b.data.map((x) => Number(x.attributes.version)).filter(Number.isFinite));
}
async function trainProblem(app, version) {
  const v = await asc('GET', `/v1/apps/${app}/appStoreVersions?filter[versionString]=${encodeURIComponent(version)}&filter[platform]=IOS&fields[appStoreVersions]=versionString,appStoreState`);
  const state = v.data[0]?.attributes.appStoreState;
  return state && CLOSED.has(state)
    ? `Version ${version} is ${state.toLowerCase().replaceAll('_', ' ')} on the App Store, so TestFlight takes no more ${version} builds: raise expo.version in apps/mobile/app.json on main (e.g. ${bump(version)}).`
    : null;
}
const bump = (v) => v.split('.').length < 3 ? `${v}.1` : v.replace(/\d+$/, (n) => String(Number(n) + 1));
async function waitForBuild(app, number) {
  const until = Date.now() + PROCESSING_MINUTES * 60_000;
  let last = '';
  while (Date.now() < until) {
    const b = await asc('GET', `/v1/builds?filter[app]=${app}&filter[version]=${number}&fields[builds]=version,processingState`);
    const build = b.data[0];
    const state = build?.attributes.processingState ?? 'NOT_THERE_YET';
    if (state !== last) { say(`App Store Connect: build ${number} ${state.toLowerCase().replaceAll('_', ' ')}`); last = state; }
    if (state === 'VALID') return build.id;
    if (state === 'FAILED' || state === 'INVALID') throw new Error(`Apple marked build ${number} ${state.toLowerCase()} (see the email from App Store Connect).`);
    await sleep(30_000);
  }
  throw new Error(`Build ${number} was uploaded but still not processed after ${PROCESSING_MINUTES} minutes; it should turn up on TestFlight by itself.`);
}
async function setWhatToTest(buildId, text) {
  const have = await asc('GET', `/v1/builds/${buildId}/betaBuildLocalizations`);
  const en = have.data.find((x) => x.attributes.locale === 'en-US') ?? have.data[0];
  if (en) await asc('PATCH', `/v1/betaBuildLocalizations/${en.id}`, { data: { type: 'betaBuildLocalizations', id: en.id, attributes: { whatsNew: text } } });
  else await asc('POST', '/v1/betaBuildLocalizations', { data: { type: 'betaBuildLocalizations', attributes: { locale: 'en-US', whatsNew: text }, relationships: { build: { data: { type: 'builds', id: buildId } } } } });
}
/** Internal groups that don't get every build by themselves are given this one. */
async function shareWithGroups(app, buildId) {
  const g = await asc('GET', `/v1/apps/${app}/betaGroups?fields[betaGroups]=name,isInternalGroup,hasAccessToAllBuilds`);
  const names = [];
  for (const group of g.data.filter((x) => x.attributes.isInternalGroup)) {
    if (!group.attributes.hasAccessToAllBuilds) await asc('POST', `/v1/betaGroups/${group.id}/relationships/builds`, { data: [{ type: 'builds', id: buildId }] });
    names.push(group.attributes.name);
  }
  return names;
}

// MARK: The clone

async function ensureRepo() {
  if (!fs.existsSync(path.join(REPO, '.git'))) {
    fs.mkdirSync(HOME, { recursive: true });
    // Borrow objects from the checkout this script sits in (when it is one), so the first clone is quick.
    const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
    const borrow = fs.existsSync(path.join(here, '.git')) ? ['--reference-if-able', here, '--dissociate'] : [];
    say(`Cloning ${REPO_URL} into ${REPO}`);
    await must('git', ['clone', '--quiet', ...borrow, REPO_URL, REPO], { cwd: HOME });
  }
  await git(['fetch', '--quiet', 'origin', `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`]);
  return (await git(['rev-parse', `origin/${BRANCH}`])).out.trim();
}
async function isAncestor(a, b) {
  return (await run('git', ['merge-base', '--is-ancestor', a, b], { quiet: true })).code === 0;
}
async function appChanged(from, to) {
  const files = (await git(['diff', '--name-only', from, to])).out.split('\n').filter(Boolean);
  return files.filter((f) => f.startsWith(APP_DIR) && !NOT_APP.some((re) => re.test(f)));
}
/** "What to test": the first sentence of each app commit since the last build (the repo's subjects are long). */
async function whatToTest(from, sha) {
  const since = from && await isAncestor(from, sha) ? [`${from}..${sha}`] : ['-1', sha];
  const subjects = (await git(['log', '--no-merges', '--format=%s', ...since, '--', APP_DIR])).out.split('\n').filter(Boolean);
  const first = (s) => { const m = s.match(/^.*?[.!?](?=\s|$)/); const t = (m ? m[0] : s).trim(); return t.length > 180 ? `${t.slice(0, 177)}…` : t; };
  const lines = subjects.slice(0, 20).map((s) => `• ${first(s)}`);
  if (subjects.length > 20) lines.push(`• …and ${subjects.length - 20} more.`);
  if (!lines.length) lines.push('• Rebuilt by hand; the app is unchanged since the last build.');
  return `From main at ${sha.slice(0, 7)}:\n${lines.join('\n')}`.slice(0, 3900);
}

// MARK: Building

/** TestFlight's settings go into the clone's app.json only; the checkout and main keep theirs. */
function writeAppJson(number) {
  const file = path.join(MOBILE, 'app.json');
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ios = config.expo.ios ?? {};
  config.expo.ios = { ...ios, bundleIdentifier: BUNDLE_ID, buildNumber: String(number), config: { ...ios.config, usesNonExemptEncryption: false } };
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
}

/** React Native's post_install raises its own pods' deployment targets but not resource bundles, which Xcode 27 rejects. */
function raisePodTargets() {
  const file = path.join(MOBILE, 'ios', 'Podfile');
  const hook = '  post_install do |installer|\n';
  const podfile = fs.readFileSync(file, 'utf8');
  if (!podfile.includes(hook)) throw new Error("The generated Podfile has no post_install hook to raise pod deployment targets in; expo prebuild's template changed.");
  fs.writeFileSync(file, podfile.replace(hook, `${hook}    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        current = config.build_settings["IPHONEOS_DEPLOYMENT_TARGET"]
        config.build_settings["IPHONEOS_DEPLOYMENT_TARGET"] = "${MIN_POD_TARGET}" if current && Gem::Version.new(current) < Gem::Version.new("15.0")
      end
    end
`));
}

async function build(sha, why) {
  fs.mkdirSync(LOGS, { recursive: true });
  logFile = path.join(LOGS, `${stamp().replace(/[: ]/g, '-')}-${sha.slice(0, 7)}.log`);
  const started = Date.now();
  const state = readState();
  say(`Building ${sha.slice(0, 7)} for TestFlight (${why}). Log: ${logFile}`);
  try {
    const app = await appId();
    await git(['checkout', '--quiet', '--force', '--detach', sha]);
    await git(['clean', '-ffdqx', '-e', 'node_modules/']);
    const lock = crypto.createHash('sha256').update(fs.readFileSync(path.join(MOBILE, 'package-lock.json'))).digest('hex');
    if (state.lockHash !== lock || !fs.existsSync(path.join(MOBILE, 'node_modules'))) {
      await must('npm', ['ci', '--no-audit', '--no-fund'], { cwd: MOBILE });
      state.lockHash = lock;
      writeState(state);
    }

    const version = JSON.parse(fs.readFileSync(path.join(MOBILE, 'app.json'), 'utf8')).expo.version ?? '1.0.0';
    const closed = await trainProblem(app, version);
    if (closed) throw new Error(closed);
    const number = (await newestBuildNumber(app)) + 1;
    say(`Version ${version}, build ${number}`);

    writeAppJson(number);
    await must('npx', ['expo', 'prebuild', '--platform', 'ios', '--clean', '--no-install'], { cwd: MOBILE, env: BUILD_ENV });
    raisePodTargets();
    const ios = path.join(MOBILE, 'ios');
    await must('pod', ['install'], { cwd: ios, env: BUILD_ENV });
    const workspace = fs.readdirSync(ios).find((n) => n.endsWith('.xcworkspace'));
    if (!workspace) throw new Error('expo prebuild made no .xcworkspace in apps/mobile/ios.');
    const scheme = workspace.replace(/\.xcworkspace$/, '');
    // A build phase compiles ExpoModulesJSI in a nested xcodebuild. Under Xcode 27 that build succeeds but prints
    // "error: the following command failed with exit code 0", and Xcode fails the archive on any "error:" line a
    // script prints. Built here first, where only the exit code counts, the slice is up to date and the phase skips.
    const jsi = path.join(MOBILE, 'node_modules', 'expo-modules-jsi', 'apple', 'scripts', 'build-xcframework.sh');
    if (fs.existsSync(jsi)) await must('bash', [jsi], { cwd: MOBILE, env: { ...BUILD_ENV, PODS_ROOT: path.join(ios, 'Pods'), PLATFORM_NAME: 'iphoneos' } });

    const archives = path.join(HOME, 'archives');
    fs.mkdirSync(archives, { recursive: true });
    const archive = path.join(archives, `MediaBox-${number}.xcarchive`);
    const auth = ['-allowProvisioningUpdates', '-authenticationKeyPath', KEY_PATH, '-authenticationKeyID', KEY_ID, '-authenticationKeyIssuerID', ISSUER_ID];
    await must('xcodebuild', ['-workspace', path.join(ios, workspace), '-scheme', scheme, '-configuration', 'Release', '-destination', 'generic/platform=iOS',
      '-derivedDataPath', path.join(HOME, 'DerivedData'), '-archivePath', archive, 'archive',
      `DEVELOPMENT_TEAM=${TEAM_ID}`, 'CODE_SIGN_STYLE=Automatic', ...auth], { cwd: MOBILE, env: BUILD_ENV });

    const options = path.join(HOME, 'export.plist');
    fs.writeFileSync(options, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>method</key><string>app-store-connect</string>
<key>destination</key><string>upload</string>
<key>teamID</key><string>${TEAM_ID}</string>
<key>signingStyle</key><string>automatic</string>
<key>manageAppVersionAndBuildNumber</key><false/>
</dict></plist>
`);
    const exported = await must('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', options,
      '-exportPath', path.join(HOME, 'export', String(number)), ...auth], { cwd: MOBILE });
    if (!/Upload succeeded|EXPORT SUCCEEDED/.test(exported.out)) throw new Error(`The upload didn't say it succeeded: ${exported.tail.slice(-4).join(' | ')}`);
    say(`Uploaded build ${number}; waiting for Apple to process it`);

    const buildId = await waitForBuild(app, number);
    const notes = await whatToTest(state.lastSha, sha);
    await setWhatToTest(buildId, notes);
    const groups = await shareWithGroups(app, buildId);

    const minutes = Math.round((Date.now() - started) / 60_000);
    const s = readState();
    Object.assign(s, { lastSha: sha, lastBuild: number, lastAt: new Date().toISOString(), lastError: null });
    s.failures = s.failures ?? {};
    delete s.failures[sha];
    s.history = [{ sha, build: number, at: s.lastAt, minutes }, ...(s.history ?? [])].slice(0, 30);
    writeState(s);
    say(`Build ${number} (${version}) is on TestFlight for ${groups.join(', ') || 'no internal group'} after ${minutes} min.\n${notes}`);
    notify('Media Box on TestFlight', `Build ${number} is ready for ${groups.join(', ') || 'testers'} (main ${sha.slice(0, 7)}).`);
    tidy();
    return true;
  } catch (e) {
    const s = readState();
    s.failures = s.failures ?? {};
    s.failures[sha] = (s.failures[sha] ?? 0) + 1;
    s.lastError = { sha, at: new Date().toISOString(), message: e.message, log: logFile };
    writeState(s);
    say(`FAILED: ${e.message}`);
    notify('Media Box TestFlight build failed', e.message);
    return false;
  }
}

/** Keeps the newest few archives, exports and logs. */
function tidy() {
  const prune = (dir, keep) => {
    if (!fs.existsSync(dir)) return;
    const items = fs.readdirSync(dir).map((n) => ({ n, t: fs.statSync(path.join(dir, n)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const { n } of items.slice(keep)) fs.rmSync(path.join(dir, n), { recursive: true, force: true });
  };
  prune(path.join(HOME, 'archives'), KEEP_ARCHIVES);
  prune(path.join(HOME, 'export'), KEEP_ARCHIVES);
  prune(LOGS, KEEP_LOGS);
}

// MARK: Commands

async function cmdBuild(args) {
  if (!takeLock()) { console.log('A TestFlight build is already running.'); return 1; }
  const head = await ensureRepo();
  const at = args.indexOf('--commit');
  const sha = at >= 0 ? (await git(['rev-parse', `${args[at + 1]}^{commit}`])).out.trim() : head;
  if (!(await isAncestor(sha, head))) { console.log(`${sha.slice(0, 7)} isn't on ${BRANCH}: TestFlight builds come from ${BRANCH} only.`); return 1; }
  return (await build(sha, 'by hand')) ? 0 : 1;
}

async function cmdCheck() {
  if (!takeLock()) return 0;
  const head = await ensureRepo();
  const state = readState();
  if (!state.lastSha) {
    // First look: nothing is known about what's on TestFlight, so start from here; the next push builds.
    writeState({ ...state, lastSha: head, checkedSha: head });
    say(`First look: main is at ${head.slice(0, 7)}; the next change to the app's code is built.`);
    return 0;
  }
  if (head === state.lastSha || head === state.checkedSha) return 0;
  if ((state.failures?.[head] ?? 0) > RETRIES) return 0;
  const changed = await appChanged(state.lastSha, head);
  if (!changed.length) {
    writeState({ ...state, checkedSha: head });
    say(`main moved to ${head.slice(0, 7)}: nothing in the app changed (server or docs only), no build.`);
    return 0;
  }
  return (await build(head, `main moved: ${changed.length} app file${changed.length === 1 ? '' : 's'} changed`)) ? 0 : 1;
}

async function cmdStatus() {
  const s = readState();
  console.log(`Home: ${HOME}`);
  console.log(`Last build: ${s.lastBuild ?? '—'} from ${s.lastSha?.slice(0, 7) ?? '—'} at ${s.lastAt ?? '—'}`);
  if (s.lastError) console.log(`Last failure: ${s.lastError.at} ${s.lastError.sha.slice(0, 7)}: ${s.lastError.message}\n  log: ${s.lastError.log}`);
  const loaded = (await run('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { quiet: true, cwd: os.homedir() })).code === 0;
  console.log(`Clock: ${loaded ? 'on' : 'off'} (${AGENT_PLIST})`);
  if (fs.existsSync(LOCK)) console.log(`Running now: pid ${fs.readFileSync(LOCK, 'utf8')}`);
  const app = await appId();
  const b = await asc('GET', `/v1/builds?filter[app]=${app}&sort=-uploadedDate&limit=5&fields[builds]=version,uploadedDate,processingState`);
  for (const x of b.data) console.log(`  App Store Connect build ${x.attributes.version}: ${x.attributes.processingState.toLowerCase()}, uploaded ${x.attributes.uploadedDate}`);
  return 0;
}

async function cmdInstall(args) {
  const at = args.indexOf('--minutes');
  const minutes = Math.max(5, Number(at >= 0 ? args[at + 1] : 10) || 10);
  fs.mkdirSync(path.join(HOME, 'logs'), { recursive: true });
  const script = path.join(HOME, 'testflight.mjs');
  fs.copyFileSync(fileURLToPath(import.meta.url), script);
  // Homebrew's /opt/homebrew/bin/node survives a `brew upgrade node`; process.execPath (the Cellar path) doesn't.
  const node = fs.existsSync('/opt/homebrew/bin/node') ? '/opt/homebrew/bin/node' : process.execPath;
  const PATH = [...new Set([path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  const x = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  fs.mkdirSync(path.dirname(AGENT_PLIST), { recursive: true });
  fs.writeFileSync(AGENT_PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${x(node)}</string><string>${x(script)}</string><string>check</string></array>
  <key>StartInterval</key><integer>${minutes * 60}</integer>
  <key>RunAtLoad</key><true/>
  <key>Nice</key><integer>5</integer>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${x(PATH)}</string><key>LANG</key><string>en_US.UTF-8</string></dict>
  <key>StandardOutPath</key><string>${x(path.join(HOME, 'logs', 'clock.log'))}</string>
  <key>StandardErrorPath</key><string>${x(path.join(HOME, 'logs', 'clock.log'))}</string>
</dict></plist>
`);
  const domain = `gui/${process.getuid()}`;
  await run('launchctl', ['bootout', `${domain}/${LABEL}`], { quiet: true, cwd: os.homedir() });
  const r = await run('launchctl', ['bootstrap', domain, AGENT_PLIST], { quiet: true, cwd: os.homedir() });
  if (r.code !== 0) { console.log(`launchctl bootstrap failed: ${r.tail.join(' ')}`); return 1; }
  console.log(`The TestFlight clock is on: every ${minutes} min it looks at ${BRANCH} and builds when the app's code changed.\n  script ${script}\n  agent  ${AGENT_PLIST}\n  logs   ${path.join(HOME, 'logs')}`);
  return 0;
}

async function cmdUninstall() {
  await run('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { quiet: true, cwd: os.homedir() });
  fs.rmSync(AGENT_PLIST, { force: true });
  console.log(`The TestFlight clock is off. ${HOME} (the clone, logs, archives) is left; delete it by hand if you like.`);
  return 0;
}

const [command = 'status', ...args] = process.argv.slice(2);
const commands = { build: cmdBuild, check: cmdCheck, status: cmdStatus, install: cmdInstall, uninstall: cmdUninstall };
if (!commands[command]) {
  console.log('Usage: testflight.mjs build [--commit <sha>] | check | status | install [--minutes 10] | uninstall');
  process.exit(2);
}
try {
  process.exitCode = await commands[command](args);
} catch (e) {
  say(`FAILED: ${e.message}`);
  if (command === 'check') notify('Media Box TestFlight check failed', e.message);
  process.exitCode = 1;
}
