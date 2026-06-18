import { cp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const outDir = path.join(root, 'public');
const files = [
  'admin-login.html',
  'admin-signup.html',
  'analytics.html',
  'app.js',
  'auth.js',
  'certificate-generator.html',
  'create-exam.html',
  'curriculum.js',
  'devices.html',
  'firebase-config.js',
  'handle-exams.html',
  'index.html',
  'passwords.html',
  'question-bank.html',
  'result-analyse.html',
  'scan-omr.html',
  'solution-download.html',
  'student-login.html',
  'student-profile.html',
  'student-signup.html',
  'students.html',
  'super-admin.html',
  'styles.css',
];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const file of files) {
  await cp(path.join(root, file), path.join(outDir, file));
}

console.log(`Built ${files.length} public assets in ${path.relative(root, outDir)}`);
