export default () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  database: {
    url: process.env.DATABASE_URL,
  },
  llm: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.LLM_MODEL ?? 'claude-opus-4-7',
    maxTokens: parseInt(process.env.LLM_MAX_TOKENS ?? '4096', 10),
  },
  rubric: {
    version: process.env.RUBRIC_VERSION ?? 'v3.0',
    dir: process.env.RUBRIC_DIR ?? './rubrics',
  },
  claudeCode: {
    projectsDir: process.env.CLAUDE_CODE_PROJECTS_DIR,
  },
});
