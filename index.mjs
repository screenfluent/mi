#!/usr/bin/env node

// ── Imports & environment ────────────────────────────────────────────
import { createInterface } from 'readline'; import { readFileSync, existsSync, readdirSync } from 'fs'; import { spawn } from 'child_process'; import { homedir } from 'os';
Object.assign(global, { spawn, readFileSync, existsSync, readdirSync, homedir }); const DIR = new URL('.', import.meta.url).pathname; process.env.MI_DIR = DIR; process.env.MI_PATH = new URL(import.meta.url).pathname; if (!process.env.OPENAI_API_KEY && !process.argv.includes('-h')) { console.error('OPENAI_API_KEY required'); process.exit(1); }

// ── Tool discovery ───────────────────────────────────────────────────
/* Load tool modules; each exports {name, description, parameters, handler}. */
const toolMods = await Promise.all(readdirSync(DIR + 'tools').filter(f => f.endsWith('.mjs')).map(f => import(DIR + 'tools/' + f))), defs = toolMods.map(m => m.default), gray = s => `\x1b[90m${s}\x1b[0m`, { listSkills } = toolMods.find(m => m.listSkills);
const tools = Object.fromEntries(defs.map(d => [d.name, d.handler])), toolsDef = defs.map(d => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } }));

// ── Agent loop: chat → stream → execute tools → repeat ──────────────
/*
 * Streams the API response, executes any tool calls, and loops until the
 * model returns a plain text reply (no further tool invocations).
 */
async function run(messages) { while (true) {

  // — Send streaming chat completion request —
  const response = await fetch(`${(process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '')}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: process.env.MODEL || 'gpt-5.4', messages, tools: toolsDef, stream: true }) }); if (!response.ok) { const error = await response.json().catch(()=>({})); throw new Error(error.error?.message || `HTTP ${response.status}`); }

  // — Parse SSE stream: print content tokens, accumulate tool-call deltas by index —
  const message = { role: 'assistant', content: '' }, decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of response.body) { buffer += decoder.decode(chunk, {stream:true}); let pos; while ((pos = buffer.indexOf('\n\n')) >= 0) { const event = buffer.slice(0, pos); buffer = buffer.slice(pos + 2); for (const line of event.split('\n')) { if (!line.startsWith('data: ')) continue; const payload = line.slice(6); if (payload === '[DONE]') continue; let json; try { json = JSON.parse(payload); } catch { continue; } if (json.error) throw new Error(json.error.message || JSON.stringify(json.error)); const delta = json.choices?.[0]?.delta; if (!delta) continue; if (delta.content) { process.stdout.write(delta.content); message.content += delta.content; } if (delta.tool_calls) { message.tool_calls ||= []; for (const tc of delta.tool_calls) { const slot = message.tool_calls[tc.index] ||= { id:'', type:'function', function:{name:'',arguments:''} }; if (tc.id) slot.id = tc.id; if (tc.type) slot.type = tc.type; if (tc.function?.name) slot.function.name += tc.function.name; if (tc.function?.arguments) slot.function.arguments += tc.function.arguments; } } } } }
  if (message.content) process.stdout.write('\n'); messages.push(message); if (!message.tool_calls) return;

  // — Execute each tool call and push results back into history —
  for (const toolCall of message.tool_calls) {
    const {name} = toolCall.function, args = JSON.parse(toolCall.function.arguments);
    console.log(gray(`⟡ ${name}(${JSON.stringify(args)})`)); if (!tools[name]) { messages.push({ role: 'tool', tool_call_id: toolCall.id, content: `Error: unknown tool "${name}". Available: ${Object.keys(tools).join(', ')}` }); continue; } const result = String(await tools[name](args));
    console.log(gray(result.length > 200 ? result.slice(0, 200) + '…' : result)); messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });

  } } }

// ── System prompt ────────────────────────────────────────────────────
const SYSTEM = (process.env.SYSTEM_PROMPT || 'You are mi, an autonomous agent. You run in a raw terminal—no markdown renderer, so avoid **, `, #, and ```. Use whitespace and plain punctuation. Be concise.\n\nAct rather than speculate. Explore the problem, form a plan, execute one step at a time, verify each step before proceeding. If something fails, diagnose and retry. Keep going until the task is complete. When a request matches a skill description below, load that skill and follow it.\n\nMinimize context usage when reading files: head -20 for starts, tail -20 for ends, sed -n \'10,30p\' for ranges, grep -n to locate then read around matches. Reserve cat for short files. Edit with sed -i or heredocs (cat > file <<\'EOF\'). Always read before editing.\n\nWhen done, show the command output that proves it—not a summary.') + `\nCWD: ${process.cwd()}\nDate: ${new Date().toISOString()}`;

// ── CLI setup: history, flags, context injection ─────────────────────
const history = [{ role: 'system', content: SYSTEM }], getArg = key => { const i = process.argv.indexOf(key); return i >= 0 && process.argv[i + 1]; };

if (process.argv.includes('-h')) { console.log('usage: mi [-p prompt] [-f file] [-h]\n  pipe: echo "..." | mi    repl: /reset clears history\nenv: OPENAI_API_KEY, MODEL, OPENAI_BASE_URL, SYSTEM_PROMPT\nbash tool args: timeout=<ms> kills after delay · bg=truthy detaches and returns pid+log'); process.exit(0); }

/* Append -f file contents, AGENTS.md, and available skill descriptions to system message. */
const fileArg = getArg('-f'); if (fileArg) history[0].content += `\n\nFile (${fileArg}):\n` + readFileSync(fileArg, 'utf8'); if (existsSync('AGENTS.md')) history[0].content += '\n' + readFileSync('AGENTS.md', 'utf8'); const skills = listSkills(); if (skills.length) history[0].content += '\n\nSkill descriptions:\n' + skills.join('\n');

// ── One-shot modes: -p flag and stdin pipe ───────────────────────────
if (getArg('-p')) { history.push({ role: 'user', content: getArg('-p') }); await run(history); process.exit(0); }

if (!process.stdin.isTTY) { let input = ''; for await (const chunk of process.stdin) input += chunk; history.push({ role: 'user', content: input.trim() }); await run(history); process.exit(0); }

// ── Interactive REPL ─────────────────────────────────────────────────
const readLine = createInterface({ input: process.stdin, output: process.stdout }); const promptUser = query => new Promise(resolve => readLine.question(query, resolve)); const version = JSON.parse(readFileSync(DIR+'package.json','utf8')).version; console.log('\x1b[38;5;208m◰ mi\x1b[90m/'+version+'\x1b[0m');

readLine.on('close', () => process.exit(0)); while (true) { const input = await promptUser('\n> '); if (input === '/reset') { history.splice(1); console.log(gray('✓ reset')); continue; } if (input.trim()) { history.push({ role: 'user', content: input }); process.stdout.write(gray('─────')+'\n'); try { await run(history); } catch(error) { console.error('\x1b[31m✗ ' + error.message + '\x1b[0m'); history.pop(); } } }
