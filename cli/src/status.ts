import chalk from 'chalk';
import { EventBuffer } from './buffer';
import { AIBuffer } from './aiBuffer';
import { configDir, readSession, readState } from './config';

export async function runStatus(): Promise<void> {
  const session = readSession();
  const state = readState();
  const buffer = new EventBuffer();
  const aiBuffer = new AIBuffer();
  const { total, unsent } = buffer.size();
  const ai = aiBuffer.size();

  console.log(chalk.cyan('mentor — local status'));
  console.log(chalk.gray(`  config dir:    ${configDir()}`));
  if (!session) {
    console.log(chalk.yellow('  session:       (none — run `mentor watch <token>`)'));
  } else {
    console.log(`  server:        ${session.server}`);
    console.log(`  token:         ${redact(session.token)}`);
    if (session.buildStartedAt) {
      console.log(`  build start:   ${session.buildStartedAt}`);
    }
  }
  console.log(`  buffer:        ${total} events (${unsent} unsent)`);
  console.log(`  ai buffer:     ${ai.total} turns (${ai.unsent} unsent)`);
  if (state.startedAt) console.log(`  started:       ${state.startedAt}`);
  if (state.lastFlushAt) {
    const ok = state.lastFlushOk ? chalk.green('ok') : chalk.red('failed');
    console.log(`  last flush:    ${state.lastFlushAt} (${ok})`);
    if (!state.lastFlushOk && state.lastFlushError) {
      console.log(chalk.red(`                 ${state.lastFlushError}`));
    }
  }
}

function redact(s: string): string {
  if (s.length <= 8) return '****';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
