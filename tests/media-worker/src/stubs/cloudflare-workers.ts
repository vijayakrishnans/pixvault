// Node stand-in for the workerd-only `cloudflare:workers` module (tests construct the index core directly).
export class DurableObject<Env = unknown> {
  constructor(
    protected readonly ctx: unknown,
    protected readonly env: Env,
  ) {}
}
