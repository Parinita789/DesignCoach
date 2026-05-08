# URL Shortener — Plan (build mode)

## Scope
In: POST /shorten, GET /:slug, basic click counter
Out of scope: custom slugs, link expiry, analytics dashboard

## Functional requirements
- Given a long URL, return a 6-char slug
- Given a slug, redirect to the long URL with 302
- Track click count per slug

## Non-functional requirements
- Demo: 100 RPS, p95 < 200ms for redirect
- Target: 10K RPS sustained

## Tool choices
- FastAPI: framework — fits the requested HTTP API
- Postgres: store — supports the small set of relations
- nanoid: slug generator — collision-free random tokens

## Data model
- Url(id, slug unique, target, click_count int default 0, created_at)

## Component boundaries
- handlers/ — HTTP layer
- services/url_service.py — slug generation, atomic counter increment
- repos/url_repo.py — Postgres access
Dependency direction: handlers -> services -> repos. No cross.

## Key interfaces
- UrlService.create(target: str) -> Url
- UrlService.resolve(slug: str) -> Url | None
- UrlRepo.insert(slug, target) -> Url
- UrlRepo.increment_click(slug) -> int

## Failure modes
- Handled: invalid slug (404), DB unreachable (retry once then 500),
  slug collision (regenerate up to 3 times)
- Punted: partial DB writes, multi-region replication

## Build sequence
1. data model + repo unit tests with in-memory fake
2. service + service tests
3. handlers + integration test
4. validation harness

## Validation plan
- pytest covers each endpoint happy path + one error path
- ab -n 100 -c 10 against /shorten verifies p95 < 200ms

## AI usage plan
- AI: FastAPI handlers boilerplate, SQLAlchemy model class
- Candidate: slug-generation logic, atomic counter increment in repo,
  validation harness
