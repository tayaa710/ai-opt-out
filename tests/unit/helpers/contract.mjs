// Message types declared in ARCHITECTURE.md, parsed from the document itself so
// the router test fails if the contract gains a type the background lacks.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './chrome-mock.mjs';

const doc = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8');
const messaging = doc.slice(doc.indexOf('### Messaging'), doc.indexOf('### Opt-out run flow'));
const runFlow = doc.slice(doc.indexOf('### Opt-out run flow'), doc.indexOf('### Monitoring'));

const uiTypes = [...messaging.matchAll(/^\| `(\w+)` +\|/gm)].map((m) => m[1]);
const contentTypes = [...runFlow.matchAll(/\{ type: '(\w+)'/g)].map((m) => m[1]);

export const ARCHITECTURE_MESSAGE_TYPES = Object.freeze([...new Set([...uiTypes, ...contentTypes])]);

if (uiTypes.length < 10 || contentTypes.length < 5) {
  throw new Error('Could not parse the message types from ARCHITECTURE.md');
}
