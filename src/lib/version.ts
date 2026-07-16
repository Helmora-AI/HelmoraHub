import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageMetadata = require('../../package.json') as { version?: unknown };

if (typeof packageMetadata.version !== 'string' || packageMetadata.version.length === 0) {
  throw new Error('Hub package version is missing');
}

/** Product version shared by source execution and the compiled dist layout. */
export const HUB_VERSION = packageMetadata.version;
