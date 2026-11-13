// The mark on the API calls the MCP tools make in-process (AFS-24), so the audit log says they came
// from an agent (source mcp). Made at each start and never sent out: a request from outside
// cannot claim it.
import { randomBytes } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

export const MCP_CALL = randomBytes(24).toString('base64url');
export const MCP_HEADER = 'x-afs-mcp';

export const viaMcp = (request: FastifyRequest) => request.headers[MCP_HEADER] === MCP_CALL;
