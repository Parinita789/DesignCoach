import chalk from 'chalk';
import { EventBuffer } from './buffer';
import { AIBuffer } from './aiBuffer';
import {
  describeError,
  drainAiBuffer,
  drainBuffer,
  MentorApiClient,
} from './api';
import { readSession } from './config';

const FLUSH_BATCH_SIZE = 100;

export interface FinishOptions {
  server?: string;
}

export async function runFinish(opts: FinishOptions): Promise<number> {
  const session = readSession();
  if (!session) {
    console.error(
      chalk.red('mentor: no session found. Run `mentor watch <token>` first.'),
    );
    return 1;
  }

  const server = opts.server ?? session.server;
  const buffer = new EventBuffer();
  const aiBuffer = new AIBuffer();
  const api = new MentorApiClient({ token: session.token, server });

  const drain = await drainBuffer(api, buffer, FLUSH_BATCH_SIZE);
  if (drain.error) {
    console.warn(
      chalk.yellow(
        `mentor: flush failed — ${drain.flushed} sent, ${drain.remaining} unsent (${drain.error})`,
      ),
    );
  }

  const aiDrain = await drainAiBuffer(api, aiBuffer, FLUSH_BATCH_SIZE);
  if (aiDrain.error) {
    console.warn(
      chalk.yellow(
        `mentor: ai flush failed — ${aiDrain.flushed} sent, ${aiDrain.remaining} unsent (${aiDrain.error})`,
      ),
    );
  }

  let finishOk = false;
  try {
    await api.finishBuild();
    finishOk = true;
  } catch (err) {
    console.warn(chalk.yellow(`mentor: finish call failed: ${describeError(err)}`));
  }

  const { total, unsent } = buffer.size();
  const ai = aiBuffer.size();
  console.log(
    chalk.cyan(
      `mentor: done · ${total} events · ${drain.flushed} flushed in this call · ${unsent} unsent`,
    ),
  );
  if (ai.total > 0 || aiDrain.flushed > 0) {
    console.log(
      chalk.cyan(
        `mentor: ai · ${ai.total} turns · ${aiDrain.flushed} flushed in this call · ${ai.unsent} unsent`,
      ),
    );
  }
  return finishOk && unsent === 0 && ai.unsent === 0 ? 0 : 1;
}
