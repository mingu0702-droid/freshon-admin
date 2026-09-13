import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createStaffPasswordHash } from '../src/mapStaffAuth.js';

export async function staffSetupValues(first, second) {
  if (first !== second) throw new Error('PASSWORD_MISMATCH');
  return { hash: await createStaffPasswordHash(first), secret: randomBytes(32).toString('base64url') };
}
function hidden(prompt) {
  process.stdout.write(prompt);
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => { process.stdin.setRawMode(false); process.stdin.pause(); process.stdin.off('data', onData); process.stdout.write('\n'); };
    function onData(chunk) {
      for (const char of String(chunk)) {
        if (char === '\u0003') { finish(); reject(new Error('CANCELLED')); return; }
        if (char === '\r' || char === '\n') { finish(); resolve(value); return; }
        if (char === '\u007f' || char === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (char >= ' ' && value.length < 1024) value += char;
      }
    }
    process.stdin.setEncoding('utf8'); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onData);
  });
}
function clipboard(value) {
  return new Promise((resolve, reject) => {
    // Secret travels via stdin, never argv, console, a temp file, or shell history.
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$v=[Console]::In.ReadToEnd(); Set-Clipboard -Value $v'], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', () => reject(new Error('CLIPBOARD_FAILED')));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('CLIPBOARD_FAILED')));
    child.stdin.on('error', () => reject(new Error('CLIPBOARD_FAILED'))); child.stdin.end(value);
  });
}
async function main() {
  if (process.platform !== 'win32' || !process.stdin.isTTY || process.argv.length !== 2) throw new Error('WINDOWS_INTERACTIVE_ONLY');
  process.stdout.write('Stage 전용 · Render freshon-admin-stage-preview-template → Environment\nMAP_STAFF_ID는 원하시는 공용 아이디를 직접 설정하세요.\n비밀번호는 16자 이상, 다른 계정과 다른 값을 사용하세요.\n');
  let first = await hidden('공용 비밀번호 (숨김): '), second = await hidden('다시 입력 (숨김): ');
  const values = await staffSetupValues(first, second); first = ''; second = '';
  await clipboard(values.hash); values.hash = '';
  await hidden('MAP_STAFF_PASSWORD_HASH 값이 복사됐습니다. Stage에 붙여넣은 뒤 Enter: ');
  await clipboard(values.secret); values.secret = '';
  await hidden('MAP_STAFF_SESSION_SECRET 값이 복사됐습니다. Stage에 붙여넣은 뒤 Enter: ');
  await clipboard('');
  process.stdout.write('클립보드를 비웠습니다. Stage 지정 SHA를 확인하고 저장하세요. 재시작 후에는 재로그인이 필요합니다.\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { process.stderr.write('설정을 완료하지 못했습니다. 비밀번호 일치/길이와 대화형 Windows 터미널을 확인하세요.\n'); process.exitCode = 1; });
