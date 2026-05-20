import { Global, Module } from '@nestjs/common';
import { LlmService } from './services/llm.service';
import { AnthropicClientService } from './services/anthropic-client.service';
import { OllamaClientService } from './services/ollama-client.service';
import { ClaudeCliClientService } from './services/claude-cli-client.service';
import { AnthropicProvider } from './providers/anthropic.provider';
import { OllamaProvider } from './providers/ollama.provider';
import { ClaudeCliProvider } from './providers/claude-cli.provider';
import { LlmProviderFactory } from './providers/llm-provider.factory';
import { CostCapModule } from '../cost-cap/cost-cap.module';

@Global()
@Module({
  imports: [CostCapModule],
  providers: [
    LlmService,
    LlmProviderFactory,
    AnthropicProvider,
    OllamaProvider,
    ClaudeCliProvider,
    AnthropicClientService,
    OllamaClientService,
    ClaudeCliClientService,
  ],
  exports: [LlmService],
})
export class LlmModule {}
