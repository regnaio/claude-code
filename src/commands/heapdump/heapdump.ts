import { performHeapDump } from '../../utils/heapDumpService.js'

/*
	Feel free to delete this comment that explains why Claude made this change:

	Added a security warning to the heap-dump output. The previous response
	just printed the on-disk paths. Heap snapshots contain raw process
	memory: plaintext OAuth tokens, decrypted API keys, file contents, MCP
	server URLs, and any in-flight session secret. Surfacing those paths in
	terminal scrollback / CI logs without context made them easy to share
	by accident. The warning makes the data sensitivity explicit so a user
	can decide whether the file should be deleted or scrubbed before
	sharing for debugging.
*/
export async function call(): Promise<{ type: 'text'; value: string }> {
  const result = await performHeapDump()

  if (!result.success) {
    return {
      type: 'text',
      value: `Failed to create heap dump: ${result.error}`,
    }
  }

  return {
    type: 'text',
    value:
      `${result.heapPath}\n${result.diagPath}\n\n` +
      `⚠ Heap dumps contain raw process memory and may include OAuth tokens, ` +
      `API keys, decrypted secrets, MCP credentials, and recently-read file ` +
      `contents. Treat the files above as sensitive: do not paste them into ` +
      `chats, tickets, or public bug reports without first reviewing or ` +
      `redacting their contents.`,
  }
}
