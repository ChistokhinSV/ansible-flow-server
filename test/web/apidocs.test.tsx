// The API reference page, from an OpenAPI document played by the test.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/web/app';

const omar = { id: 'u2', login: 'omar', name: 'Omar Haddad', admin: false, groups: [] };
const doc = {
  openapi: '3.1.0',
  info: {
    title: 'Ansible Flow Server API',
    version: '0.1.0',
    description: 'Sign in with a token.',
  },
  paths: {
    '/api/v1/runs/{id}/cancel': {
      post: {
        summary: 'Stop a run',
        tags: ['Runs'],
        description: 'Who: administrators.',
        parameters: [
          { name: 'id', in: 'path', required: true, schema: { type: 'string', maxLength: 64 } },
        ],
      },
    },
    '/api/v1/tokens': {
      post: {
        summary: 'Make an access token',
        tags: ['Tokens'],
        description: 'Who: session.',
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['name'],
                properties: {
                  name: { type: 'string', maxLength: 100 },
                  readOnly: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
      get: { summary: 'Your access tokens', tags: ['Tokens'], description: 'Who: signed in.' },
    },
  },
};

beforeEach(() => {
  window.scrollTo = () => undefined;
  vi.stubGlobal('fetch', async (url: string) => {
    const body =
      url === '/api/v1/session' ? omar : url === '/api/v1/openapi.json' ? doc : undefined;
    return { ok: !!body, status: body ? 200 : 404, json: async () => body } as Response;
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the API reference', () => {
  it('lists every address by subject, with who may call it and what it takes; finds by words', async () => {
    window.history.replaceState(null, '', '/docs/api');
    render(<App />);
    await screen.findByRole('heading', { name: 'Runs' });
    expect(screen.getByRole('heading', { name: 'Tokens' })).toBeTruthy();
    expect(screen.getByText('Stop a run')).toBeTruthy();
    expect(screen.getByText('· administrators')).toBeTruthy();
    // GET before POST for one address.
    const methods = [...document.querySelectorAll('.method')].map((m) => m.textContent);
    expect(methods).toEqual(['POST', 'GET', 'POST']);
    expect(screen.getByText('string, at most 100 characters')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('runs, token, launch'), {
      target: { value: 'stop' },
    });
    expect(screen.queryByRole('heading', { name: 'Tokens' })).toBeNull();
    expect(screen.getByText('Stop a run')).toBeTruthy();
  });
});
