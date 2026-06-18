import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

/** Compute a SHA-256 hex hash of the given content string */
export function computeContentHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Compute a SHA-256 hex hash of a file by streaming it through the digest.
 *
 * Streams rather than reading the whole file into memory so it stays bounded for
 * GB-scale artifacts (e.g. the GGUF model weights this is used to pin). Rejects
 * if the file cannot be read.
 */
export function computeFileHash(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}
