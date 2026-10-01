import crypto from 'node:crypto';
export function createPipelineClient({
  target = process.env.API_TARGET,
  secret = process.env.PIPELINE_SECRET,
  retries = 3,
  retryMs = 1000,
} = {}) {
  if (!target || !secret) throw new Error('API_TARGET and PIPELINE_SECRET are required');
  return async function request(operation, body = {}) {
    const raw = JSON.stringify(body);
    let error;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const timestamp = String(Date.now());
      try {
        const response = await fetch(`${target.replace(/\/+$/, '')}/api/internal/${operation}`, {
          method: 'POST',
          body: raw,
          headers: {
            'Content-Type': 'application/json',
            'X-Mosaic-Time': timestamp,
            'X-Mosaic-Signature': crypto.createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex'),
          },
          signal: AbortSignal.timeout(30000),
        });
        const result = await response.json();
        if (!response.ok) {
          const failure = Object.assign(new Error(result.error || `Pipeline HTTP ${response.status}`), {
            status: response.status,
          });
          if (response.status < 500) throw failure;
          error = failure;
        } else return result;
      } catch (failure) {
        if (failure.status && failure.status < 500) throw failure;
        error = failure;
      }
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, retryMs * (attempt + 1)));
    }
    throw error;
  };
}
