import {spawn} from 'node:child_process';
import {lstat, realpath} from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {fileURLToPath} from 'node:url';
import {createStageRecentOperationsStore,recoverVerifiedFreshonDispatch} from '../src/stageRecentOperations.js';
import {opsmapArchiveSite,opsmapArchiveWriteApproved} from '../src/stageScope.js';

const scopeError=()=>Error('RECENT_OPERATIONS_RECOVERY_SCOPE');

const readCurrentUserEvidence=String.raw`
$ErrorActionPreference = 'Stop'
try {
    Add-Type -AssemblyName System.Security
    $files = @(Get-ChildItem -LiteralPath $env:OPSMAP_DISPATCH_DPAPI_DIRECTORY -File -Filter '*.dpapi' -Force)
    if ($files.Count -lt 1 -or $files.Count -gt 270) { exit 1 }
    foreach ($file in $files) {
        if ($file.Name -cnotmatch '^\d{4}-\d{2}-\d{2}-(011|012|013)\.dpapi$' -or
            ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            $file.Length -lt 1 -or $file.Length -gt (3 * 1024 * 1024)) { exit 1 }
        $encrypted = [IO.File]::ReadAllBytes($file.FullName)
        $clear = [Security.Cryptography.ProtectedData]::Unprotect(
            $encrypted, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser
        )
        try {
            if ($clear.Length -lt 1 -or $clear.Length -gt (2 * 1024 * 1024)) { exit 1 }
            [Console]::WriteLine($file.Name + [char]9 + [Convert]::ToBase64String($clear))
        } finally {
            [Array]::Clear($clear, 0, $clear.Length)
        }
    }
} catch { exit 1 }
`;

export async function* readArchives(directory) {
  // Child stdout is a private pipe. Print only the normalized aggregate report.
  const {SystemRoot,USERPROFILE,APPDATA,LOCALAPPDATA,TEMP,TMP}=process.env;
  const shell=path.join(SystemRoot||'C:/Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const child=spawn(shell,['-NoProfile','-NonInteractive','-Command',readCurrentUserEvidence],{
    windowsHide:true,stdio:['ignore','pipe','ignore'],
    env:{SystemRoot,USERPROFILE,APPDATA,LOCALAPPDATA,TEMP,TMP,OPSMAP_DISPATCH_DPAPI_DIRECTORY:directory}
  });
  const completed=new Promise(resolve=>{
    child.once('error',()=>resolve(false));
    child.once('close',code=>resolve(code===0));
  });
  const lines=createInterface({input:child.stdout,crlfDelay:Infinity});
  try {
    for await (const line of lines) {
      const separator=line.indexOf('\t');
      if (separator<1||line.length>3*1024*1024) throw scopeError();
      const bytes=Buffer.from(line.slice(separator+1),'base64');
      try {yield {name:line.slice(0,separator),bytes};}
      finally {bytes.fill(0);}
    }
    if (!await completed) throw Error('RECENT_OPERATIONS_DISPATCH_DPAPI_FAILED');
  } finally {
    lines.close();
    if (child.exitCode===null&&child.signalCode===null) child.kill();
  }
}

async function main() {
  const [mode,directory,...extra]=process.argv.slice(2);
  if (process.platform!=='win32'||!['--preview','--publish'].includes(mode)||!directory||
      !/^[A-Za-z]:[\\/]/.test(directory)||extra.length) throw scopeError();
  const info=await lstat(directory);
  if (!info.isDirectory()||info.isSymbolicLink()) throw scopeError();
  const resolved=await realpath(directory);
  if (!/^[A-Za-z]:[\\/]/.test(resolved)) throw scopeError();
  const publish=mode==='--publish';
  const env=process.env, site=opsmapArchiveSite(env), primary=site==='primary';
  const reader=primary?env.OPSMAP_PRIMARY_ARCHIVE_READ_TOKEN:
    env.OPSMAP_STAGE_SYNC_READ_TOKEN||env.OPSMAP_SNAPSHOT_STORE_TOKEN||env.OPSMAP_SHADOW_GITHUB_READ_TOKEN;
  const writer=primary?env.OPSMAP_PRIMARY_ARCHIVE_WRITE_TOKEN:env.OPSMAP_STAGE_SYNC_WRITE_TOKEN;
  if(!site||!reader||publish&&(!writer||writer===reader||!opsmapArchiveWriteApproved(env))) throw scopeError();
  const scopedEnv={...env,OPSMAP_STAGE_SYNC_READ_TOKEN:reader,OPSMAP_STAGE_SYNC_WRITE_TOKEN:writer,
    OPSMAP_STAGE_SYNC_USE_SNAPSHOT_WRITER:'0',...(primary?{
      OPSMAP_STAGE_SYNC_REMOTE_APPROVED:'1',
      OPSMAP_STAGE_SYNC_PUBLISH_APPROVED:opsmapArchiveWriteApproved(env)?'1':'0'
    }:{})};
  const readStore=createStageRecentOperationsStore({env:scopedEnv,withSha:true});
  const writeStore=publish?createStageRecentOperationsStore({env:scopedEnv,write:true}):null;
  if(!readStore||publish&&!writeStore) throw scopeError();
  const store={read:readStore.read,...(writeStore?{write:writeStore.write}:{})};
  const result=await recoverVerifiedFreshonDispatch({
    store,archives:readArchives(resolved),publish,
    approvedSha256:publish?process.env.OPSMAP_STAGE_RECENT_OPERATIONS_DISPATCH_ARCHIVE_SHA256:undefined
  });
  console.log(JSON.stringify(result));
  if (['BUSY','NO_ACCEPTED_EVIDENCE'].includes(result.state)) process.exitCode=1;
}

if (process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(error=>{
  const code=error.code||error.message;
  console.error(/^(?:RECENT_OPERATIONS|FIXED_STORE)_[A-Z_]+$/.test(code??'')?code:'RECENT_OPERATIONS_RECOVERY_FAILED');
  process.exitCode=1;
});
