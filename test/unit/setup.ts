// AFS-245: the server's tests check every answer a route gives against the schema the catalog
// says it answers with (helpers/answers.ts). Each app the tests build gets the check; a test whose
// requests had a wrong answer fails with what was wrong.
import { afterEach, expect, vi } from 'vitest';
import { checkAnswers, problems } from './helpers/answers';

vi.mock('../../src/server/app', async (real) => {
  const app = await real<typeof import('../../src/server/app')>();
  return {
    ...app,
    buildApp: (...args: Parameters<typeof app.buildApp>) => {
      const built = app.buildApp(...args);
      checkAnswers(built);
      return built;
    },
  };
});

afterEach(() => {
  const found = problems.splice(0);
  expect(found, 'answers that are not what api/catalog.ts says').toEqual([]);
});
