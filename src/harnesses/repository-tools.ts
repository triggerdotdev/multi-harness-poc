// Run an MCP server in a child process with access limited to the repository.
export const repositoryTools = `
import { McpServer } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/mcp.js"))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve("@modelcontextprotocol/sdk/server/stdio.js"))};
import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
import { realpath, readFile, readdir, stat, lstat, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { resolve, relative, isAbsolute, sep, join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
const root = await realpath(process.env.AGENT_WORKSPACE);
const server = new McpServer({ name: 'repository', version: '1.0.0' });
server.registerTool('read_file', {
  description: 'Read a UTF-8 file inside the workspace. Use nextOffset to continue through large files.',
  inputSchema: { path: z.string(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(64000).default(32000) },
  annotations: { readOnlyHint: true },
}, async ({ path, offset, limit }) => {
  const target = await realpath(resolve(root, path));
  const local = relative(root, target);
  if (local === '..' || local.startsWith('..' + sep) || isAbsolute(local)) throw new Error('Path is outside the repository');
  const info = await stat(target);
  if (!info.isFile()) throw new Error('Expected a file');
  const text = await readFile(target, 'utf8');
  return { content: [{ type: 'text', text: text.slice(offset, offset + limit) }], structuredContent: { offset, nextOffset: offset + limit < text.length ? offset + limit : null, totalCharacters: text.length } };
});
server.registerTool('list_files', {
  description: 'List workspace files in pages. Use nextOffset for more files. Set path to .conversation to discover saved turns.',
  inputSchema: { path: z.string().default('.'), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(1000).default(200) },
  annotations: { readOnlyHint: true },
}, async ({ path, offset, limit }) => {
  const directory = await realpath(resolve(root, path));
  const local = relative(root, directory);
  if (local === '..' || local.startsWith('..' + sep) || isAbsolute(local)) throw new Error('Path is outside the repository');
  const files = [];
  let seen = 0;
  async function walk(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (files.length > limit) return;
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && seen++ >= offset) files.push(relative(root, path));
    }
  }
  await walk(directory);
  return { content: [{ type: 'text', text: JSON.stringify({ files: files.slice(0, limit), nextOffset: files.length > limit ? offset + limit : null }) }] };
});
async function writable(path) {
  const candidate = resolve(process.env.AGENT_WORKSPACE, path);
  const outside = value => value === '..' || value.startsWith('..' + sep) || isAbsolute(value);
  let local = relative(root, candidate);
  if (outside(local)) local = relative(resolve(process.env.AGENT_WORKSPACE), candidate);
  const target = resolve(root, local);
  if (!local || local === '..' || local.startsWith('..' + sep) || isAbsolute(local)) throw new Error('Write path is outside the workspace');
  const parts = local.split(sep);
  if (['.conversation', '.git'].includes(parts[0]) || parts[0].startsWith('.checkpoint-')) throw new Error('This workspace path is managed by the application');
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (info?.isSymbolicLink()) throw new Error('Writes through symlinks are not allowed');
  }
  return target;
}
async function save(path, content) {
  const target = await writable(path);
  await mkdir(dirname(target), { recursive: true });
  const temp = join(dirname(target), '.write-' + randomUUID());
  try { await writeFile(temp, content, { flag: 'wx', mode: 0o600 }); await rename(temp, target); }
  finally { await rm(temp, { force: true }); }
}
server.registerTool('write_file', {
  description: 'Create or replace a file in the workspace copy. Creates parent directories. Saved conversation files are protected.',
  inputSchema: { path: z.string(), content: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, async ({ path, content }) => {
  await save(path, content);
  return { content: [{ type: 'text', text: 'Saved ' + path }] };
});
server.registerTool('edit_file', {
  description: 'Replace one exact, unique occurrence of oldText in a workspace file. Read the file first.',
  inputSchema: { path: z.string(), oldText: z.string().min(1), newText: z.string() },
  annotations: { readOnlyHint: false, destructiveHint: true },
}, async ({ path, oldText, newText }) => {
  const target = await writable(path);
  const text = await readFile(target, 'utf8');
  const first = text.indexOf(oldText);
  if (first < 0 || text.indexOf(oldText, first + oldText.length) >= 0) throw new Error('oldText must match exactly once');
  await save(path, text.slice(0, first) + newText + text.slice(first + oldText.length));
  return { content: [{ type: 'text', text: 'Edited ' + path }] };
});
await server.connect(new StdioServerTransport());
`;
