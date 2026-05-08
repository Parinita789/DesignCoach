import { LlmService, LlmTimeoutError } from './llm.service';
import { ChatRole } from '../constants';

function fakeResponse(text = 'pong') {
  return {
    text,
    modelUsed: 'fake-model',
    tokensIn: 1,
    tokensOut: 2,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };
}

describe('LlmService (facade)', () => {
  it('delegates to whichever provider the factory picks', async () => {
    const fakeProvider = { name: 'fake', call: jest.fn().mockResolvedValue(fakeResponse()) };
    const factory = { get: jest.fn().mockReturnValue(fakeProvider) };
    const service = new LlmService(factory as never);

    const result = await service.call([{ role: ChatRole.User, content: 'ping' }], {
      maxTokens: 10,
    });

    expect(factory.get).toHaveBeenCalled();
    expect(fakeProvider.call).toHaveBeenCalledWith(
      [{ role: ChatRole.User, content: 'ping' }],
      { maxTokens: 10 },
    );
    expect(result.text).toBe('pong');
  });

  it('passes an empty options object when none is provided', async () => {
    const fakeProvider = { name: 'fake', call: jest.fn().mockResolvedValue(fakeResponse('')) };
    const service = new LlmService({ get: () => fakeProvider } as never);

    await service.call([{ role: ChatRole.User, content: 'hi' }]);

    expect(fakeProvider.call).toHaveBeenCalledWith(
      [{ role: ChatRole.User, content: 'hi' }],
      {},
    );
  });
});

describe('LlmService — retry + timeout', () => {
  function makeService(opts: { maxAttempts?: number; timeoutMs?: number; backoffBaseMs?: number } = {}) {
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'LLM_MAX_ATTEMPTS') return String(opts.maxAttempts ?? 3);
        if (key === 'LLM_TIMEOUT_MS') return String(opts.timeoutMs ?? 90_000);
        if (key === 'LLM_BACKOFF_BASE_MS') return String(opts.backoffBaseMs ?? 1);
        return undefined;
      }),
    };
    const provider = { name: 'fake', call: jest.fn() };
    const factory = { get: jest.fn().mockReturnValue(provider) };
    return {
      service: new LlmService(factory as never, config as never),
      provider,
    };
  }

  it('retries on a 5xx and succeeds on the second attempt', async () => {
    const { service, provider } = makeService({ maxAttempts: 3, backoffBaseMs: 1 });
    const transient = Object.assign(new Error('upstream blew up'), { status: 503 });
    provider.call.mockRejectedValueOnce(transient).mockResolvedValueOnce(fakeResponse('after-retry'));

    const result = await service.call([{ role: ChatRole.User, content: 'q' }]);

    expect(result.text).toBe('after-retry');
    expect(provider.call).toHaveBeenCalledTimes(2);
  });

  it('retries on a 429 and includes jittered backoff', async () => {
    const { service, provider } = makeService({ maxAttempts: 2, backoffBaseMs: 1 });
    const rateLimited = Object.assign(new Error('rate limited'), { status: 429 });
    provider.call.mockRejectedValueOnce(rateLimited).mockResolvedValueOnce(fakeResponse());

    const result = await service.call([{ role: ChatRole.User, content: 'q' }]);

    expect(result.text).toBe('pong');
    expect(provider.call).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on a 4xx other than 429', async () => {
    const { service, provider } = makeService({ maxAttempts: 3, backoffBaseMs: 1 });
    const badReq = Object.assign(new Error('bad request'), { status: 400 });
    provider.call.mockRejectedValueOnce(badReq);

    await expect(service.call([{ role: ChatRole.User, content: 'q' }])).rejects.toBe(badReq);
    expect(provider.call).toHaveBeenCalledTimes(1);
  });

  it('throws the last error after exhausting maxAttempts', async () => {
    const { service, provider } = makeService({ maxAttempts: 2, backoffBaseMs: 1 });
    const transient = Object.assign(new Error('always 500'), { status: 500 });
    provider.call.mockRejectedValue(transient);

    await expect(service.call([{ role: ChatRole.User, content: 'q' }])).rejects.toBe(transient);
    expect(provider.call).toHaveBeenCalledTimes(2);
  });

  it('treats network-y messages as retryable', async () => {
    const { service, provider } = makeService({ maxAttempts: 2, backoffBaseMs: 1 });
    provider.call
      .mockRejectedValueOnce(new Error('fetch failed: ECONNRESET'))
      .mockResolvedValueOnce(fakeResponse('ok'));

    const result = await service.call([{ role: ChatRole.User, content: 'q' }]);
    expect(result.text).toBe('ok');
  });

  it('raises LlmTimeoutError when a single attempt exceeds the budget, and retries', async () => {
    const { service, provider } = makeService({
      maxAttempts: 2,
      timeoutMs: 30,
      backoffBaseMs: 1,
    });
    provider.call
      .mockImplementationOnce(() => new Promise(() => {})) // never resolves
      .mockResolvedValueOnce(fakeResponse('after-timeout'));

    const result = await service.call([{ role: ChatRole.User, content: 'q' }]);
    expect(result.text).toBe('after-timeout');
    expect(provider.call).toHaveBeenCalledTimes(2);
  });

  it('surfaces LlmTimeoutError when every attempt times out', async () => {
    const { service, provider } = makeService({
      maxAttempts: 2,
      timeoutMs: 20,
      backoffBaseMs: 1,
    });
    provider.call.mockImplementation(() => new Promise(() => {}));

    await expect(
      service.call([{ role: ChatRole.User, content: 'q' }]),
    ).rejects.toBeInstanceOf(LlmTimeoutError);
    expect(provider.call).toHaveBeenCalledTimes(2);
  });
});
