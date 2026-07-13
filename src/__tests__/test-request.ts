import type { Express } from 'express';
import http from 'node:http';

type Response = {
  status: number;
  headers: Record<string, string>;
  body: any;
};

class TestRequest {
  private headers: Record<string, string> = {};
  private payload: unknown = undefined;
  private method = 'GET';
  private path = '/';

  constructor(private app: Express) {}

  get(path: string) {
    this.method = 'GET';
    this.path = path;
    return this;
  }

  post(path: string) {
    this.method = 'POST';
    this.path = path;
    return this;
  }

  put(path: string) {
    this.method = 'PUT';
    this.path = path;
    return this;
  }

  patch(path: string) {
    this.method = 'PATCH';
    this.path = path;
    return this;
  }

  delete(path: string) {
    this.method = 'DELETE';
    this.path = path;
    return this;
  }

  set(key: string, value: string) {
    this.headers[key.toLowerCase()] = value;
    return this;
  }

  send(body: unknown) {
    this.payload = body;
    return this;
  }

  then(resolve: (value: Response) => void, reject?: (reason?: unknown) => void) {
    return this.execute().then(resolve, reject);
  }

  private execute(): Promise<Response> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(this.app);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (!addr || typeof addr === 'string') {
          server.close();
          reject(new Error('Failed to bind test server'));
          return;
        }

        const body =
          this.payload === undefined ? undefined : JSON.stringify(this.payload);
        const headers: Record<string, string> = { ...this.headers };
        if (body !== undefined) {
          headers['content-type'] = 'application/json';
          headers['content-length'] = String(Buffer.byteLength(body));
        }

        const req = http.request(
          {
            hostname: '127.0.0.1',
            port: addr.port,
            path: this.path,
            method: this.method,
            headers,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
              const raw = Buffer.concat(chunks).toString('utf8');
              let parsed: unknown = raw;
              try {
                parsed = raw ? JSON.parse(raw) : null;
              } catch {
                // keep raw
              }
              const headerMap: Record<string, string> = {};
              for (const [k, v] of Object.entries(res.headers)) {
                if (typeof v === 'string') headerMap[k] = v;
                else if (Array.isArray(v)) headerMap[k] = v.join(', ');
              }
              server.close();
              resolve({
                status: res.statusCode ?? 0,
                headers: headerMap,
                body: parsed,
              });
            });
          }
        );

        req.on('error', (err) => {
          server.close();
          reject(err);
        });

        if (body !== undefined) req.write(body);
        req.end();
      });
    });
  }
}

export default function request(app: Express) {
  return new TestRequest(app);
}
