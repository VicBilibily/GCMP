/*---------------------------------------------------------------------------------------------
 *  提交消息模板系统
 *  定义各种提交消息格式的模板
 *--------------------------------------------------------------------------------------------*/

import { CommitFormat } from './types';

/**
 * Plain 模板：一句话描述
 */
const plainTemplate = `Generate a commit message as a single plain sentence.

Rules:
1. Output ONE line only.
2. No prefixes (no type/scope, no emoji, no issue refs).
3. Keep it concise (ideally <= 72 characters).
4. Describe what changed, not how you changed it.

Examples:
Improve commit message generation defaults
Fix configuration fallback for invalid formats`;

/**
 * Conventional Commits 模板
 */
const conventionalTemplate = `Generate a commit message following the Conventional Commits format:
<type>[optional scope]: <description>

[optional body with bullet points]

Rules:
1. First line: type(scope): description (max 50 chars)
2. For small changes use only first line
3. For complex changes list key points in body:
   - Each line starts with "- "
   - Each line max 50 chars
   - Limit to 5 bullet points
   - Summarize changes concisely

Type selection rules:
- docs: ANY changes to documentation files (*.md, docs/*)
- feat: New features or significant functional changes
- fix: Bug fixes and error corrections
- style: Formatting, semicolons, etc (no code change)
- refactor: Code changes that don't fix bugs or add features
- perf: Performance improvements
- test: Adding or updating tests
- build: Build system or dependencies
- ci: CI/CD changes
- chore: Other maintenance tasks

Examples:
Documentation change:
docs: update installation and usage guides

- Added new features description
- Updated configuration section
- Added usage examples

Feature change:
feat(auth): add user authentication

- Implemented OAuth2 provider integration
- Created auth service module
- Added session management`;

/**
 * Angular 风格模板
 */
const angularTemplate = `Generate a commit message following Angular commit format:
<type>(<scope>): <short summary>

<longer description if needed>

<footer with issue references>

Types: build, ci, docs, feat, fix, perf, refactor, style, test
Scope: component or module affected
Summary: imperative, present tense, lowercase, no period`;

/**
 * Karma 风格模板
 */
const karmaTemplate = `Generate a commit message following Karma format:
<type>(<scope>): <message>

Single line format. Types: feat, fix, docs, style, refactor, test, chore`;

/**
 * Semantic 风格模板
 */
const semanticTemplate = `Generate a commit message following Semantic format:
<type>: <message>

Simple format without scope. Types: feat, fix, docs, style, refactor, perf, test, chore`;

/**
 * Emoji 风格模板
 */
const emojiTemplate = `Generate a commit message using emoji prefix:
<emoji> <message>

Emoji mapping:
✨ feat: new feature
🐛 fix: bug fix
📝 docs: documentation
💄 style: formatting
♻️ refactor: refactoring
⚡ perf: performance
✅ test: tests
📦 build: build
👷 ci: CI/CD
🔧 chore: maintenance`;

/**
 * EmojiKarma 风格模板
 */
const emojiKarmaTemplate = `Generate a commit message combining emoji and Karma format:
<emoji> <type>(<scope>): <message>

Example: ✨ feat(auth): add user login

Emoji: ✨ feat, 🐛 fix, 📝 docs, 💄 style, ♻️ refactor, ⚡ perf, ✅ test`;

/**
 * Google 风格模板
 */
const googleTemplate = `Generate a commit message following Google style:
<Type>: <Description>

<Body>

<Footer>

Type starts with capital letter. Types: Feat, Fix, Docs, Style, Refactor, Perf, Test, Build, Ci, Chore`;

/**
 * Atom 风格模板
 */
const atomTemplate = `Generate a commit message following Atom style:
:<emoji>: <message>

Use colon-wrapped emoji shortcodes. Examples:
:sparkles: add new feature
:bug: fix bug
:memo: update documentation
:art: improve formatting
:recycle: refactor code
:zap: improve performance`;

/**
 * 模板注册表
 */
const templates = {
    plain: plainTemplate,
    conventional: conventionalTemplate,
    angular: angularTemplate,
    karma: karmaTemplate,
    semantic: semanticTemplate,
    emoji: emojiTemplate,
    emojiKarma: emojiKarmaTemplate,
    google: googleTemplate,
    atom: atomTemplate
} satisfies Record<Exclude<CommitFormat, 'custom'>, string>;

/**
 * 验证格式是否有效
 */
function isValidFormat(format: string): format is CommitFormat {
    return Object.keys(templates).includes(format);
}

/**
 * 获取模板
 */
export function getTemplate(format: CommitFormat): string {
    let validFormat = format;

    if (!isValidFormat(format)) {
        console.warn(`Invalid format "${format}", falling back to plain`);
        validFormat = 'plain';
    }

    // 模板内容仅定义英文提示词；具体输出语言由后续指令单独控制。
    return templates[validFormat as Exclude<CommitFormat, 'custom'>];
}

/**
 * 获取所有支持的格式
 */
export function getSupportedFormats(): CommitFormat[] {
    return Object.keys(templates) as CommitFormat[];
}
