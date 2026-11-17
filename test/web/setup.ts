// AFS-81: the pages' tests wait for what a page shows (findBy, waitFor) up to 5 s, not Testing
// Library's 1 s. On a loaded machine (the full suite beside another, or CI) a page with the code
// editor or several requests took longer than 1 s to show, and the test failed though nothing was
// wrong; alone they pass in well under a second, so a longer wait costs nothing when they pass.
import { configure } from '@testing-library/react';

configure({ asyncUtilTimeout: 5_000 });
