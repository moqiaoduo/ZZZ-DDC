/**
 * 从 index.html 里抠出三张角色表（CHARACTER_DATA / ENKA_ID_MAP / aliasMap）。
 *
 * 为什么不用正则整段匹配：这三个字面量里有字符串、模板串、注释，
 * 简单的 `/\{[\s\S]*?\}/` 会在第一个 `}` 就停。这里用一个小的状态机配平括号，
 * 与 tools/split.mjs 里的切分器同源（都是配平括号的状态机）。
 *
 * 只在 Node 侧用（需要 fs），所以不放进 legacy-migration-core.mjs。
 */
import fs from 'node:fs';

/** 从 source 中切出 `const <name> = <expr>;` 的 expr 部分（不含末尾分号）。 */
export function extractConstSource(source, name) {
  return extractByRe(source, new RegExp('^(\\s*)const\\s+' + name + '\\s*=\\s*', 'm'), name);
}

function extractByRe(source, re, name) {
  const m = re.exec(source);
  if (!m) throw new Error('源文件里找不到常量 ' + name);

  let i = m.index + m[0].length;
  let depth = 0;
  let inStr = null;
  let inTpl = false;
  let inLine = false;
  let inBlock = false;

  for (; i < source.length; i++) {
    const c = source[i];
    const next = source[i + 1];

    if (inLine) { if (c === '\n') inLine = false; continue; }
    if (inBlock) { if (c === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inStr) { if (c === '\\') { i++; continue; } if (c === inStr) inStr = null; continue; }
    if (inTpl) { if (c === '\\') { i++; continue; } if (c === '`') inTpl = false; continue; }

    if (c === '/' && next === '/') { inLine = true; i++; continue; }
    if (c === '/' && next === '*') { inBlock = true; i++; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '`') { inTpl = true; continue; }

    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ';' && depth === 0) { i++; break; }
  }

  return source.slice(m.index + m[0].length, i).replace(/;\s*$/, '');
}

function evalExpr(src, label) {
  try {
    // eslint-disable-next-line no-new-func
    return new Function('"use strict"; return (' + src + ');')();
  } catch (e) {
    throw new Error('求值 ' + label + ' 失败：' + e.message);
  }
}

/**
 * 读单体 HTML（通常是 legacy/index.v0.html）并返回三张表。
 * @param {string} htmlPath
 */
export function loadRoleTablesFromHtml(htmlPath) {
  const html = fs.readFileSync(htmlPath, 'utf8');

  const CHARACTER_DATA = evalExpr(extractConstSource(html, 'CHARACTER_DATA'), 'CHARACTER_DATA');
  const ENKA_ID_MAP = evalExpr(extractConstSource(html, 'ENKA_ID_MAP'), 'ENKA_ID_MAP');

  // aliasMap 是 findCharacterByImportedName 内部的局部常量，不是顶层 const，
  // 所以单独用一次正则抓 —— 它的结构简单（扁平的字符串到字符串映射）。
  const aliasMatch = /const\s+aliasMap\s*=\s*(\{[\s\S]*?\});/.exec(html);
  if (!aliasMatch) throw new Error('源文件里找不到 aliasMap');
  const ALIAS_MAP = evalExpr(aliasMatch[1], 'aliasMap');

  return { CHARACTER_DATA, ENKA_ID_MAP, ALIAS_MAP };
}