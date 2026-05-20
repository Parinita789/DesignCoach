import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CommonModule } from './common/common.module';
import { AuthGuard } from './modules/auth/guards/auth.guard';
import { ThrottlingModule } from './modules/throttling/throttling.module';
import { UserOrIpThrottlerGuard } from './modules/throttling/user-or-ip-throttler.guard';
import { DatabaseModule } from './database/database.module';
import { SessionsModule } from './modules/sessions/sessions.module';
import { SessionReadModule } from './modules/session-read/session-read.module';
import { AuthModule } from './modules/auth/auth.module';
import { SnapshotsModule } from './modules/snapshots/snapshots.module';
import { ArtifactsModule } from './modules/artifacts/artifacts.module';
import { EvaluationsModule } from './modules/evaluations/evaluations.module';
import { LlmModule } from './modules/llm/llm.module';
import { PhaseTaggerModule } from './modules/phase-tagger/phase-tagger.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { HintsModule } from './modules/hints/hints.module';
import { QuestionsModule } from './modules/questions/questions.module';
import { MentorModule } from './modules/mentor/mentor.module';
import { SignalMentorModule } from './modules/signal-mentor/signal-mentor.module';
import { BuildSessionsModule } from './modules/build-sessions/build-sessions.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    CommonModule,
    AuthModule,
    ThrottlingModule,
    DatabaseModule,
    LlmModule,
    ArtifactsModule,
    PhaseTaggerModule,
    SnapshotsModule,
    SessionReadModule,
    EvaluationsModule,
    SessionsModule,
    QuestionsModule,
    DashboardModule,
    HintsModule,
    MentorModule,
    SignalMentorModule,
    BuildSessionsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: UserOrIpThrottlerGuard },
  ],
})
export class AppModule {}
