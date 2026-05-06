#!/usr/bin/env node

/*
 * Import readline for interactive CLI input, fs to read files. Set MI_DIR
 * for tool modules to locate bundled assets. Exit if OPENAI_API_KEY missing.
 */
import { createInterface } from 'readline'; import { readFileSync, existsSync, readdirSync } from 'fs'; import { spawn } from 'child_process'; import { homedir } from 'os';
Object.assign(global, { spawn, readFileSync, existsSync, readdirSync, homedir }); const DIR = new URL('.', import.meta.url).pathname; process.env.MI_DIR = DIR; process.env.MI_PATH = new URL(import.meta.url).pathname; if (!process.env.OPENAI_API_KEY && !process.argv.includes('-h')) { console.error('OPENAI_API_KEY required'); process.exit(1); }

/* Discover and load tools from tools/ directory. Each module default-exports {name, description, parameters, handler}. */
const toolMods = await Promise.all(readdirSync(DIR + 'tools').filter(f => f.endsWith('.mjs')).map(f => import(DIR + 'tools/' + f))), defs = toolMods.map(m => m.default), dim = s => `\x1b[90m${s}\x1b[0m`, { listSkills } = toolMods.find(m => m.listSkills);
const tools = Object.fromEntries(defs.map(d => [d.name, d.handler])), toolsDef = defs.map(d => ({ type: 'function', function: { name: d.name, description: d.description, parameters: d.parameters } }));

/*
 * Call the chat API in a loop, executing tool calls, until the model
 * returns a plain text reply. Streams content tokens to stdout as they arrive.
 */
async function run(messages) { while (true) {

  /* POST with stream:true; throw on non-200 by reading the JSON error body. */
  const response = await fetch(`${(process.env.OPENAI_BASE_URL || 'https://api.openai.com').replace(/\/+$/, '')}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model: process.env.MODEL || 'gpt-5.4', messages, tools: toolsDef, stream: true }) }); if (!response.ok) { const error = await response.json().catch(()=>({})); throw new Error(error.error?.message || `HTTP ${response.status}`); }

  /* Iterate SSE deltas: write content tokens to stdout, merge tool_call fragments by index into one assistant message. */
  const message = { role: 'assistant', content: '' }, decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of response.body) { buffer += decoder.decode(chunk, {stream:true}); let pos; while ((pos = buffer.indexOf('\n\n')) >= 0) { const event = buffer.slice(0, pos); buffer = buffer.slice(pos+2); for (const line of event.split('\n')) { if (!line.startsWith('data: ')) continue; const data = line.slice(6); if (data === '[DONE]') continue; let json; try { json = JSON.parse(data); } catch { continue; } if (json.error) throw new Error(json.error.message || JSON.stringify(json.error)); const delta = json.choices?.[0]?.delta; if (!delta) continue; if (delta.content) { process.stdout.write(delta.content); message.content += delta.content; } if (delta.tool_calls) { message.tool_calls ||= []; for (const toolDelta of delta.tool_calls) { const merged = message.tool_calls[toolDelta.index] ||= { id:'', type:'function', function:{name:'',arguments:''} }; if (toolDelta.id) merged.id = toolDelta.id; if (toolDelta.type) merged.type = toolDelta.type; if (toolDelta.function?.name) merged.function.name += toolDelta.function.name; if (toolDelta.function?.arguments) merged.function.arguments += toolDelta.function.arguments; } } } } }
  if (message.content) process.stdout.write('\n'); messages.push(message); if (!message.tool_calls) return;

  for (const toolCall of message.tool_calls) {
    const {name} = toolCall.function, args = JSON.parse(toolCall.function.arguments);

    /* Log the call, run the tool, log a truncated result, push to history. */
    console.log(dim(`⟡ ${name}(${JSON.stringify(args)})`)); if (!tools[name]) { messages.push({ role: 'tool', tool_call_id: toolCall.id, content: `Error: unknown tool "${name}". Available: ${Object.keys(tools).join(', ')}` }); continue; } const result = String(await tools[name](args));
    console.log(dim(result.length > 200 ? result.slice(0, 200) + '…' : result)); messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });

  } } }

/* System prompt: built-in instructions plus current directory and date. */
const SYSTEM = (process.env.SYSTEM_PROMPT || 'You are mi, an autonomous agent. You run in a raw terminal—no markdown renderer, so avoid **, `, #, and ```. Use whitespace and plain punctuation. Be concise.\n\nAct rather than speculate. Explore the problem, form a plan, execute one step at a time, verify each step before proceeding. If something fails, diagnose and retry. Keep going until the task is complete. When a request matches a skill description below, load that skill and follow it.\n\nMinimize context usage when reading files: head -20 for starts, tail -20 for ends, sed -n \'10,30p\' for ranges, grep -n to locate then read around matches. Reserve cat for short files. Edit with sed -i or heredocs (cat > file <<\'EOF\'). Always read before editing.\n\nWhen done, show the command output that proves it—not a summary.') + `\nCWD: ${process.cwd()}\nDate: ${new Date().toISOString()}`;

/* History seeded with the system prompt; getArg reads a named CLI flag. */
const history = [{ role: 'system', content: SYSTEM }], getArg = key => { const i = process.argv.indexOf(key); return i >= 0 && process.argv[i + 1]; };

if (process.argv.includes('-h')) { console.log('usage: mi [-p prompt] [-f file] [-h]\n  pipe: echo "..." | mi    repl: /reset clears history\nenv: OPENAI_API_KEY, MODEL, OPENAI_BASE_URL, SYSTEM_PROMPT\nbash tool args: timeout=<ms> kills after delay · bg=truthy detaches and returns pid+log'); process.exit(0); }

/* Prepend -f file, AGENTS.md, and the skills index (if present) to the system message. */
const fileArg = getArg('-f'); if (fileArg) history[0].content += `\n\nFile (${fileArg}):\n` + readFileSync(fileArg, 'utf8'); if (existsSync('AGENTS.md')) history[0].content += '\n' + readFileSync('AGENTS.md', 'utf8'); const skills = listSkills(); if (skills.length) history[0].content += '\n\nSkill descriptions:\n' + skills.join('\n');

if (getArg('-p')) { history.push({ role: 'user', content: getArg('-p') }); await run(history); process.exit(0); }

if (!process.stdin.isTTY) { let input = ''; for await (const chunk of process.stdin) input += chunk; history.push({ role: 'user', content: input.trim() }); await run(history); process.exit(0); }

/* Set up the readline interface and enter the interactive REPL. */
const readLine = createInterface({ input: process.stdin, output: process.stdout }); const promptUser = query => new Promise(resolve => readLine.question(query, resolve)); const version = JSON.parse(readFileSync(DIR+'package.json','utf8')).version; console.log('\x1b[38;5;208m◰ mi\x1b[90m/'+version+'\x1b[0m');

readLine.on('close', () => process.exit(0)); while (true) { const input = await promptUser('\n> '); if (input === '/reset') { history.splice(1); console.log(dim('✓ reset')); continue; } if (input.trim()) { history.push({ role: 'user', content: input }); process.stdout.write(dim('─────')+'\n'); try { await run(history); } catch(error) { console.error('\x1b[31m✗ ' + error.message + '\x1b[0m'); history.pop(); } } }
