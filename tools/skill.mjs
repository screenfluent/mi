// tools/skill.mjs — Skill discovery and loading: find SKILL.md files, parse frontmatter, list or read them

// ── Frontmatter parsing & skill resolution ──────────────────────────
// Regex: ^name:\s*(.+)$ with /m flag — anchors match per-line so we find "name:" at any line start,
// skip whitespace after the colon, and capture everything to EOL. Optional chaining returns undefined
// if the field is missing (not all SKILL.md files include both fields).
const parseFrontmatter = content => ({ name: content.match(/^name:\s*(.+)$/m)?.[1], description: content.match(/^description:\s*(.+)$/m)?.[1] || '' }), skillDirs = () => [`${process.env.MI_DIR}skills/`, `${process.env.HOME || homedir()}/.agents/skills/`], loadSkill = name => { const path = skillDirs().map(d => `${d}${name}/SKILL.md`).find(existsSync); return path && readFileSync(path, 'utf8'); };

// ── Skill listing ───────────────────────────────────────────────────
// Scan all skill directories; return "- name: description" bullets for each valid SKILL.md found
export const listSkills = () => skillDirs().flatMap(dir => existsSync(dir) ? readdirSync(dir).filter(entry => existsSync(`${dir}${entry}/SKILL.md`)).map(entry => { const { name, description } = parseFrontmatter(readFileSync(`${dir}${entry}/SKILL.md`, 'utf8')); return `- ${name || entry}: ${description}`; }) : []);

// ── Tool export ─────────────────────────────────────────────────────
export default { name: 'skill', description: 'With name: returns that skill\'s SKILL.md body. Without name: lists available skills with descriptions.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [] }, handler: ({name}) => name ? loadSkill(name) : listSkills().join('\n') };
