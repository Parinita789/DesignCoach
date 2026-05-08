import { Module, forwardRef } from '@nestjs/common';
import { EvaluationsController } from './handlers/evaluations.controller';
import { RubricsController } from './handlers/rubrics.controller';
import { EvaluationsService } from './services/evaluations.service';
import { EvaluationsRepository } from './repositories/evaluations.repository';
import { OrchestratorService } from './services/orchestrator.service';
import { RubricLoaderService } from './services/rubric-loader.service';
import { PlanAgent } from './agents/plan.agent';
import { BuildAgent } from './agents/build.agent';
import { ValidateAgent } from './agents/validate.agent';
import { WrapAgent } from './agents/wrap.agent';
import { SynthesizerAgent } from './agents/synthesizer.agent';
import { ArtifactsModule } from '../artifacts/artifacts.module';
import { PhaseTaggerModule } from '../phase-tagger/phase-tagger.module';
import { SessionsModule } from '../sessions/sessions.module';
import { SnapshotsModule } from '../snapshots/snapshots.module';
import { HintsModule } from '../hints/hints.module';
import { MentorModule } from '../mentor/mentor.module';
import { SignalMentorModule } from '../signal-mentor/signal-mentor.module';
import { BuildSessionsModule } from '../build-sessions/build-sessions.module';

@Module({
  imports: [
    ArtifactsModule,
    PhaseTaggerModule,
    SnapshotsModule,
    HintsModule,
    forwardRef(() => SessionsModule),
    forwardRef(() => MentorModule),
    forwardRef(() => SignalMentorModule),
    forwardRef(() => BuildSessionsModule),
  ],
  controllers: [EvaluationsController, RubricsController],
  providers: [
    EvaluationsService,
    EvaluationsRepository,
    OrchestratorService,
    RubricLoaderService,
    PlanAgent,
    BuildAgent,
    ValidateAgent,
    WrapAgent,
    SynthesizerAgent,
  ],
  exports: [EvaluationsService, EvaluationsRepository, RubricLoaderService],
})
export class EvaluationsModule {}
