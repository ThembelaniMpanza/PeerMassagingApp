// Read-only repository inventory; writes documentation artifacts, never app data.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const yaml = require('yaml');
const root = path.resolve(__dirname, '..');
const out = path.join(root, 'docs/architecture');
fs.mkdirSync(out, { recursive: true });
const read = p => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8').replace(/^\uFEFF/, ''));
const lock = read('package-lock.json');
const scopes = ['.', 'apps/mobile', 'apps/desktop', 'packages/models', 'packages/protocol', 'packages/networking', 'packages/shared'];
const relative = p => path.relative(root, p).replaceAll('\\', '/');
function locate(base, name) {
  let dir = path.resolve(root, base);
  while (dir.startsWith(root)) {
    const p = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(p)) return relative(fs.realpathSync(path.dirname(p)));
    const next = path.dirname(dir); if (next === dir) break; dir = next;
  }
  return null;
}
const direct = scopes.flatMap(scope => {
  const manifest = read(path.posix.join(scope, 'package.json'));
  return ['dependencies', 'devDependencies'].flatMap(kind => Object.entries(manifest[kind] || {}).map(([name, declared]) => {
    const location = locate(scope, name);
    const meta = location ? read(location + '/package.json') : {};
    return { scope, kind, name, declared, installed: meta.version || 'not installed', location, description: meta.description || '' };
  }));
});
const npm = Object.entries(lock.packages).filter(([p, v]) => p && p.includes('node_modules/') && !v.link).map(([location, item]) => {
  let meta = {}; try { meta = read(location + '/package.json'); } catch {}
  const name = item.name || location.split('node_modules/').pop();
  return { name, version: item.version, location, installed: !!meta.version, description: meta.description || '', license: item.license || meta.license || '', developmentOnly: !!item.dev, optional: !!item.optional, requestedBy: [], dependencies: item.dependencies || {}, optionalDependencies: item.optionalDependencies || {} };
});
const byLocation = new Map(npm.map(p => [p.location, p]));
for (const [location, item] of Object.entries(lock.packages)) {
  if (item.link) continue;
  for (const [name, range] of Object.entries({ ...item.dependencies, ...item.devDependencies, ...item.optionalDependencies })) {
    const resolved = locate(location, name);
    if (byLocation.has(resolved)) byLocation.get(resolved).requestedBy.push(`${location || '.'} -> ${name}@${range}`);
  }
}
const dartLock = yaml.parse(fs.readFileSync(path.join(root, 'pubspec.lock'), 'utf8'));
const dartConfig = read('.dart_tool/package_config.json');
const flutter = Object.entries(dartLock.packages).map(([name, item]) => {
  let meta = {}; const config = dartConfig.packages.find(p => p.name === name);
  try { const dir = fileURLToPath(new URL(config.rootUri, 'file:///' + root.replaceAll('\\', '/') + '/.dart_tool/package_config.json')); meta = yaml.parse(fs.readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8')); } catch {}
  return { name, version: item.version, dependency: item.dependency, source: item.source, description: meta.description || '', dependencies: Object.keys(meta.dependencies || {}) };
});
let dotnet = {};
try {
  const assets = read('apps/windows-native/obj/project.assets.json');
  dotnet = { libraries: assets.libraries, frameworks: assets.project.frameworks, restoreProjectName: assets.project.restore.projectName };
} catch { dotnet = { note: 'No restored project.assets.json available' }; }
const inventory = { generated: '2026-09-22', scope: 'Repository manifests, npm lock entries, installed package metadata, Flutter lockfile, local .NET restore metadata. Not a binary SBOM or license audit.', direct, npm, flutter, dotnet };
fs.writeFileSync(path.join(out, 'dependencies.json'), JSON.stringify(inventory, null, 2));
const csv = (rows, fields) => [fields, ...rows.map(r => fields.map(f => Array.isArray(r[f]) ? r[f].join('; ') : r[f] ?? ''))].map(row => row.map(v => '"' + String(v).replaceAll('"', '""') + '"').join(',')).join('\r\n');
fs.writeFileSync(path.join(out, 'npm-dependencies.csv'), csv(npm, ['name','version','location','installed','developmentOnly','optional','license','description','requestedBy']));
fs.writeFileSync(path.join(out, 'flutter-dependencies.csv'), csv(flutter, ['name','version','dependency','source','description','dependencies']));
const md = ['# Declared npm dependencies', '', 'Generated from each manifest and its installed resolution. A declared range is not an installed version.', '', '| Scope | Kind | Library | Declared | Installed |', '|---|---|---|---|---|', ...direct.map(d => `| ${d.scope} | ${d.kind} | ${d.name} | ${d.declared} | ${d.installed} |`)];
fs.writeFileSync(path.join(out, 'declared-dependencies.md'), md.join('\n'));
console.log(JSON.stringify({ declarations: direct.length, npmLockEntries: npm.length, flutterPackages: flutter.length, dotnetLibraries: Object.keys(dotnet.libraries || {}).length, direct: direct.filter(d => ['.','apps/mobile','apps/desktop'].includes(d.scope)).map(({scope,name,installed}) => ({scope,name,installed})) }, null, 2));
