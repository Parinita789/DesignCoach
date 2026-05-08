#!/usr/bin/env node
import { Command } from 'commander';
import { runWatch } from './watch';
import { runFinish } from './finish';
import { runStatus } from './status';

const program = new Command();

program
  .name('mentor')
  .description('Interview Assistant build-phase watcher')
  .version('0.1.0');

program
  .command('watch')
  .description('Watch the current directory and capture file-save events into a local buffer; ship them to the backend in 30s batches.')
  .argument('<token>', 'session token from the web app')
  .option('--cwd <path>', 'directory to watch', process.cwd())
  .option('--server <url>', 'backend base URL', 'http://localhost:3000')
  .option('--duration <minutes>', 'auto-finish after this many minutes', '60')
  .option('--no-ai-logs', 'opt out of capturing Claude Code conversation logs for this build')
  .option(
    '--build-started-at <iso>',
    'ISO8601 from start-build response; used to filter pre-build Claude Code sessions',
  )
  .action(
    async (
      token: string,
      opts: {
        cwd: string;
        server: string;
        duration: string;
        aiLogs: boolean;
        buildStartedAt?: string;
      },
    ) => {
      const durationMinutes = Number(opts.duration);
      if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
        console.error(`mentor: --duration must be a positive number (got "${opts.duration}")`);
        process.exit(1);
      }
      if (durationMinutes > 24 * 60) {
        console.error(
          `mentor: --duration must be at most 1440 minutes (24h); got ${durationMinutes}`,
        );
        process.exit(1);
      }
      if (opts.buildStartedAt && Number.isNaN(Date.parse(opts.buildStartedAt))) {
        console.error(
          `mentor: --build-started-at must be an ISO8601 timestamp (got "${opts.buildStartedAt}")`,
        );
        process.exit(1);
      }
      await runWatch({
        token,
        cwd: opts.cwd,
        server: opts.server,
        durationMinutes,
        captureAiLogs: opts.aiLogs,
        buildStartedAtIso: opts.buildStartedAt,
      });
    },
  );

program
  .command('finish')
  .description('Flush remaining buffered events and finalize the build session.')
  .option('--server <url>', 'backend base URL (defaults to the one stored from `watch`)')
  .action(async (opts: { server?: string }) => {
    const code = await runFinish({ server: opts.server });
    process.exit(code);
  });

program
  .command('status')
  .description('Print local buffer state and last-flush info. Does not hit the network.')
  .action(async () => {
    await runStatus();
  });

program.parseAsync(process.argv).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('mentor: fatal:', (err as Error).message);
  process.exit(1);
});
