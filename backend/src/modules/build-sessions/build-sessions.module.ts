import { Module, forwardRef } from '@nestjs/common';
import { StartBuildController } from './handlers/start-build.controller';
import { BuildController } from './handlers/build.controller';
import { BuildSessionsService } from './services/build-sessions.service';
import { BuildTokenService } from './services/build-token.service';
import { BuildEventsRepository } from './repositories/build-events.repository';
import { BuildAIInteractionsRepository } from './repositories/build-ai-interactions.repository';
import { BuildSessionGuard } from './guards/build-session.guard';
import { EvaluationsModule } from '../evaluations/evaluations.module';

@Module({
  imports: [forwardRef(() => EvaluationsModule)],
  controllers: [StartBuildController, BuildController],
  providers: [
    BuildSessionsService,
    BuildTokenService,
    BuildEventsRepository,
    BuildAIInteractionsRepository,
    BuildSessionGuard,
  ],
  exports: [
    BuildSessionsService,
    BuildEventsRepository,
    BuildAIInteractionsRepository,
  ],
})
export class BuildSessionsModule {}
