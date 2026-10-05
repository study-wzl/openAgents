import { AgentFoundationClient } from '../client/agent-foundation-client';

describe('AgentFoundationClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  // @spec GAF-002 — Retry preserves the caller-owned stable request identity
  it('keeps task identity and parent context on the authenticated transport', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 'existing' }), {
          headers: { 'content-type': 'application/json' },
        })
      );
    vi.stubGlobal('fetch', fetch);
    const client = new AgentFoundationClient({ host: 'https://agent.test', apiKey: 'test-key' });
    const input = {
      agent_id: 'research/main',
      task: 'Compare options',
      idempotency_key: 'stable-request',
      artifact_ids: ['artifact-1'],
    };
    await client.createTask(input);
    expect(fetch.mock.calls[0][0]).toBe('https://agent.test/api/agent-foundation/tasks');
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(input);
    expect(fetch.mock.calls[0][1].headers['X-Session-API-Key']).toBe('test-key');
  });

  // @spec GAF-004 — Files preserve bytes and browser multipart boundaries
  it('uploads a multipart file and downloads authenticated binary content', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'file-1' }), {
          headers: { 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0, 255, 42]), {
          headers: { 'content-type': 'application/octet-stream' },
        })
      );
    vi.stubGlobal('fetch', fetch);
    const client = new AgentFoundationClient({ host: 'https://agent.test', apiKey: 'test-key' });
    const file = new File(['sample'], 'report.txt');
    await client.uploadArtifact('conversation-1', file);
    const request = fetch.mock.calls[0][1];
    expect(request.body.get('file').name).toBe('report.txt');
    expect(request.headers['Content-Type']).toBeUndefined();
    expect(fetch.mock.calls[0][0]).toContain('conversation_id=conversation-1');
    const data = await client.downloadArtifact('file-1');
    expect(new Uint8Array(await data.arrayBuffer())).toEqual(new Uint8Array([0, 255, 42]));
  });
});
