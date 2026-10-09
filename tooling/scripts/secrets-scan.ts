import { scanSecrets } from '../src/secrets';
import { ROOT } from './lib';

const findings = scanSecrets(ROOT);
for (const finding of findings) console.error(`${finding.rule}  ${finding.file}`);
console.log(findings.length === 0 ? 'secret scan: clean' : `${findings.length} finding(s)`);
process.exit(findings.length === 0 ? 0 : 1);
