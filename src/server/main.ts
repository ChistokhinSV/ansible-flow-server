// The server's entry. For now it says what it is and reads the flow files it is given; the HTTP
// server comes with AFS-10.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { probeDir } from '@ansible-flow/assets';
import { summarizeFlow } from './flows';
import { serverMeta } from './meta';

const meta = serverMeta();
console.log(`${meta.name} ${meta.version}`);
console.log(
  `Built on Ansible Flow Designer ${meta.designer.version}; reads flows up to format ${meta.designer.format}`,
);
console.log(
  `Ansible probe: ${existsSync(join(probeDir, 'afd_probe', 'serve.py')) ? probeDir : 'not found'}`,
);

let failed = false;
for (const file of process.argv.slice(2)) {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`${file}: ${(e as Error).message}`);
    failed = true;
    continue;
  }
  const flow = summarizeFlow(file, text);
  if (!flow.ok) {
    console.error(`${file}: ${flow.problem}`);
    failed = true;
  } else {
    console.log(
      `${file}: ${flow.name} (${flow.key} v${flow.version}, format ${flow.format}), ${flow.steps} steps, ${flow.errors} errors, ${flow.warnings} warnings`,
    );
  }
}
if (failed) process.exitCode = 1;
