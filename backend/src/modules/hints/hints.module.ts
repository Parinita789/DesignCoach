import { Module, forwardRef } from '@nestjs/common';
import { HintsController } from './handlers/hints.controller';
import { HintsService } from './services/hints.service';
import { AIInteractionsRepository } from './repositories/ai-interactions.repository';
import { SessionsModule } from '../sessions/sessions.module';
import { SnapshotsModule } from '../snapshots/snapshots.module';
import { LlmModule } from '../llm/llm.module';
import { GuardrailsModule } from '../guardrails/guardrails.module';

@Module({
  imports: [forwardRef(() => SessionsModule), SnapshotsModule, LlmModule, GuardrailsModule],
  controllers: [HintsController],
  providers: [HintsService, AIInteractionsRepository],
  exports: [AIInteractionsRepository],
})
export class HintsModule {}
