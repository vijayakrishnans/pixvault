// In-memory stand-ins for serve-worker's bindings. No real images: bytes are random.
import type { Env } from "@serve-worker/env";

export class FakeKv {
  readonly data = new Map<string, string>();
  reads = 0;
  async get(key: string): Promise<string | null> {
    this.reads++;
    return this.data.get(key) ?? null;
  }
}

export class FakeR2 {
  readonly objects = new Map<string, Uint8Array>();
  gets: string[] = [];
  async get(key: string, opts?: { range?: { offset: number; length: number } }) {
    this.gets.push(key);
    const b = this.objects.get(key);
    if (!b) return null;
    const slice = opts?.range ? b.subarray(opts.range.offset, opts.range.offset + opts.range.length) : b;
    return { key, size: b.length, body: new Response(slice).body! };
  }
}

/** Images binding: records the transform and returns a tagged body. */
export class FakeImages {
  calls: { opts: unknown; format: string }[] = [];
  input(stream: ReadableStream) {
    const self = this;
    let opts: unknown;
    return {
      transform(o: unknown) {
        opts = o;
        return this;
      },
      async output(o: { format: string }) {
        await new Response(stream).arrayBuffer();
        self.calls.push({ opts, format: o.format });
        const body = new TextEncoder().encode(`transformed:${o.format}`);
        return { response: () => new Response(body, { headers: { "content-type": o.format, "content-length": String(body.length) } }) };
      },
    };
  }
}

export class FakeCache {
  readonly store = new Map<string, { body: ArrayBuffer; headers: [string, string][] }>();
  async match(req: Request) {
    const e = this.store.get(req.url);
    return e ? new Response(e.body, { headers: e.headers }) : undefined;
  }
  async put(req: Request, res: Response) {
    this.store.set(req.url, { body: await res.arrayBuffer(), headers: [...res.headers] });
  }
}

export interface World {
  env: Env;
  kv: FakeKv;
  r2: FakeR2;
  images: FakeImages;
  ae: { blobs: unknown[]; doubles: unknown[] }[];
  limited: Set<string>;
  randomCalls: unknown[];
  randomResult: { path: string } | null;
}

export function world(): World {
  const kv = new FakeKv();
  const r2 = new FakeR2();
  const images = new FakeImages();
  const ae: World["ae"] = [];
  const limited = new Set<string>();
  const w: World = { env: {} as Env, kv, r2, images, ae, limited, randomCalls: [], randomResult: null };
  w.env = {
    ENVIRONMENT: "test",
    ROUTES_KV: kv as unknown as KVNamespace,
    MEDIA_BUCKET: r2 as unknown as R2Bucket,
    IMAGES: images as unknown as ImagesBinding,
    SERVE_AE: { writeDataPoint: (p: { blobs: unknown[]; doubles: unknown[] }) => void ae.push(p) } as unknown as AnalyticsEngineDataset,
    SERVE_RL: { limit: async ({ key }: { key: string }) => ({ success: !limited.has(key) }) } as unknown as RateLimit,
    LIBRARY_INDEX: {
      idFromName: (n: string) => n,
      get: (id: string) => ({
        call: async (scope: unknown, req: unknown) => {
          w.randomCalls.push({ id, scope, req });
          return { ok: true, value: w.randomResult };
        },
      }),
    } as unknown as DurableObjectNamespace,
  };
  return w;
}
