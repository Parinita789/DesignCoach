import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableCors({ origin: config.get<string>('CORS_ORIGIN') ?? 'http://localhost:5173' });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Interview Assistant API')
    .setDescription(
      'REST endpoints for the practice-and-feedback interview tool. Sessions, snapshots, hints, evaluations, and the two post-eval coaching layers (mentor + signal-mentor).',
    )
    .setVersion('1.0')
    .addTag('questions', 'Question prompts (the design problems candidates pick from)')
    .addTag('sessions', 'Attempt lifecycle — start, pause, end')
    .addTag('snapshots', 'plan.md autosaves')
    .addTag('evaluations', 'Rubric-driven LLM scoring')
    .addTag('rubrics', 'Rubric YAML access (read-only)')
    .addTag('hints', 'Socratic-coach chat during a session')
    .addTag('mentor', 'Post-eval deep-dive teaching artifact')
    .addTag('signal-mentor', 'Post-eval per-signal inline coaching')
    .addTag('dashboard', 'Cross-session aggregates')
    .addTag('build-sessions', 'CLI watcher integration: token mint + event batch + finish')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'bearer')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  });

  const port = config.get<number>('PORT') ?? 3000;
  await app.listen(port);
}

bootstrap();
