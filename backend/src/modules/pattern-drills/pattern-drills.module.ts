import { Module } from '@nestjs/common';
import { PatternDrillsController } from './handlers/pattern-drills.controller';
import { PatternDrillsService } from './services/pattern-drills.service';
import { PatternDrillBankService } from './services/pattern-drill-bank.service';
import { PatternDrillSetsRepository } from './repositories/pattern-drill-sets.repository';
import { LlmModule } from '../llm/llm.module';
import { GuardrailsModule } from '../guardrails/guardrails.module';
import { AuthModule } from '../auth/auth.module';

@Module({
  imports: [LlmModule, GuardrailsModule, AuthModule],
  controllers: [PatternDrillsController],
  providers: [PatternDrillsService, PatternDrillBankService, PatternDrillSetsRepository],
})
export class PatternDrillsModule {}
