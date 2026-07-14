export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class TinyFishConnectorError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number | null,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TinyFishConnectorError';
  }
}

function statusError(status: number): TinyFishConnectorError {
  if (status === 401 || status === 403) {
    return new TinyFishConnectorError(
      'invalid_credentials',
      'TinyFish credentials or access are not valid.',
      status,
      false,
    );
  }
  if (status === 429) {
    return new TinyFishConnectorError('rate_limited', 'TinyFish rate limit exceeded.', status, true);
  }
  if (status === 500 || status === 503) {
    return new TinyFishConnectorError(
      'upstream_unavailable',
      'TinyFish is temporarily unavailable.',
      status,
      true,
    );
  }
  if (status === 400) {
    return new TinyFishConnectorError('upstream_invalid_request', 'TinyFish rejected the request.', status, false);
  }
  if (status === 402) {
    return new TinyFishConnectorError('payment_required', 'TinyFish account access is required.', status, false);
  }
  return new TinyFishConnectorError('upstream_error', 'TinyFish request failed.', status, false);
}

export async function tinyFishJsonRequest(input: {
  url: URL;
  apiKey: string;
  method: 'GET' | 'POST';
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  maxResponseBytes?: number;
}): Promise<unknown> {
  if (input.signal?.aborted) {
    throw new TinyFishConnectorError('tool_aborted', 'Tool request was cancelled.', null, false);
  }
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs ?? 10_000);
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });

  try {
    const response = await (input.fetchImpl ?? fetch)(input.url, {
      method: input.method,
      headers: {
        Accept: 'application/json',
        'X-API-Key': input.apiKey,
        ...(input.body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: input.body,
      signal: controller.signal,
    });
    if (!response.ok) throw statusError(response.status);
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > (input.maxResponseBytes ?? 1_048_576)) {
      throw new TinyFishConnectorError(
        'upstream_response_too_large',
        'TinyFish response exceeded the safe size limit.',
        response.status,
        false,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new TinyFishConnectorError(
        'upstream_invalid_response',
        'TinyFish returned an invalid response.',
        response.status,
        false,
      );
    }
  } catch (error) {
    if (error instanceof TinyFishConnectorError) throw error;
    if (input.signal?.aborted) {
      throw new TinyFishConnectorError('tool_aborted', 'Tool request was cancelled.', null, false);
    }
    if (timedOut) {
      throw new TinyFishConnectorError('tool_timeout', 'TinyFish request timed out.', null, true);
    }
    throw new TinyFishConnectorError('network', 'TinyFish network request failed.', null, true);
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
  }
}
