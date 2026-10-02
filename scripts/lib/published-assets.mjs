import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { buildSync } from 'esbuild';
export function filesIn(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? filesIn(file) : [file];
    })
    .sort();
}
export function stampApp(directory) {
  const app = path.join(directory, 'assets/js/app.js');
  const hash = crypto.createHash('sha256').update(fs.readFileSync(app)).digest('hex').slice(0, 16);
  const name = `app.${hash}.js`;
  fs.copyFileSync(app, path.join(path.dirname(app), name));
  for (const file of filesIn(directory).filter((file) => file.endsWith('.html'))) {
    const html = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, html.replaceAll('assets/js/app.js', `assets/js/${name}`));
  }
  return name;
}
export function stageAdmin(source, output, workspace) {
  const target = path.resolve(output),
    root = path.resolve(workspace);
  if (
    target === root ||
    !target.startsWith(root + path.sep) ||
    target === source ||
    source.startsWith(target + path.sep)
  )
    throw new Error('Unsafe admin output directory');
  const inputs = filesIn(source).filter(
    (file) => /\.(js|css|html)$/.test(file) && !file.includes(path.sep + 'functions' + path.sep),
  );
  const entry = path.join(source, 'js/admin.js');
  const bundle = fs.existsSync(entry)
    ? buildSync({
        entryPoints: [entry],
        bundle: true,
        write: false,
        format: 'esm',
        minify: true,
        target: 'es2020',
        logLevel: 'silent',
      }).outputFiles[0].text
    : null;
  const hash = crypto.createHash('sha256');
  for (const file of inputs) hash.update(path.relative(source, file)).update(fs.readFileSync(file));
  if (bundle) hash.update(bundle);
  const version = hash.digest('hex').slice(0, 16);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(source, target, { recursive: true });
  if (bundle) fs.writeFileSync(path.join(target, 'js/admin.js'), bundle);
  for (const file of filesIn(target)) {
    if (
      !/\.(js|html)$/.test(file) ||
      file.includes(path.sep + 'functions' + path.sep) ||
      file.includes(path.sep + 'vendor' + path.sep)
    )
      continue;
    let value = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.js'))
      value = value.replace(/(from\s+['"])([^'"?]+\.m?js)(?:\?[^'"]*)?(['"])/g, `$1$2?v=${version}$3`);
    else value = value.replace(/((?:src|href)=["'])([^"'?]+\.(?:js|css))(?:\?[^"']*)?(["'])/g, `$1$2?v=${version}$3`);
    fs.writeFileSync(file, value);
  }
  return version;
}
