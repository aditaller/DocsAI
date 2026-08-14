// Runs the Angular dev server and the local RAG service together.
//
// They must be two processes — the RAG service holds a Postgres pool and spawns
// pdftoppm, neither of which can live inside ng serve — but that is no reason to
// need two terminals. Output is prefixed so it is obvious which side spoke, and
// either one exiting takes the other down so you never leave a half-running pair.
//
// ponytail: plain child_process instead of `concurrently`; ~40 lines beats a
// dependency. Swap it in if you start needing restart-on-crash or run ordering.
import { spawn } from 'node:child_process';

const targets = [
  { name: 'web', colour: '\x1b[35m', script: 'start:web' },
  { name: 'rag', colour: '\x1b[36m', script: 'start:rag' },
];

const RESET = '\x1b[0m';
const children = [];
let shuttingDown = false;

function prefix(name, colour, stream, chunk) {
  for (const line of chunk.toString().split(/\r?\n/)) {
    if (line.trim()) stream.write(`${colour}[${name}]${RESET} ${line}\n`);
  }
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) console.log(`\n\x1b[33m[dev]${RESET} ${reason} — stopping both.`);
  for (const child of children) {
    // On Windows a detached npm wrapper does not forward signals to its child,
    // so the whole process tree has to go.
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
}

for (const { name, colour, script } of targets) {
  const child = spawn('npm', ['run', script], { shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  child.stdout.on('data', (chunk) => prefix(name, colour, process.stdout, chunk));
  child.stderr.on('data', (chunk) => prefix(name, colour, process.stderr, chunk));
  child.once('exit', (code) => shutdown(`${name} exited with code ${code ?? 0}`));
  child.once('error', (error) => shutdown(`${name} could not start: ${error.message}`));
}

process.once('SIGINT', () => shutdown('interrupted'));
process.once('SIGTERM', () => shutdown('terminated'));
