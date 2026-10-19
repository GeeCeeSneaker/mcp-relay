// Fixture-only real MCP client. Each invocation performs an actual handshake
// and tools/list or tools/call over the node's existing Streamable HTTP path.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const [url, command] = process.argv.slice(2);
const endpoint = new URL(url);
if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:') throw new Error('Fixture loopback only');
const request = JSON.parse(command);
const client = new Client({ name: 'controller-bridge-fixture', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(endpoint));
  const start = performance.now();
  const result = request.list_tools ? await client.listTools() : await client.callTool(request);
  console.log(JSON.stringify({ result, call_ms: performance.now() - start }));
} finally { await client.close(); }
