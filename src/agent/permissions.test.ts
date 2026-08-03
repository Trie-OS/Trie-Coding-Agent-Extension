import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  SessionPermissionStore,
  PersistentPermissionStore,
  isSensitivePath,
  isOverbroadPattern,
} from './permissions.ts'

describe('SessionPermissionStore', () => {
  it('normalizes whitespace in keys', () => {
    assert.equal(SessionPermissionStore.normalize('  npm   test  '), 'npm test')
  })

  it('detects shell metacharacters', () => {
    assert.equal(SessionPermissionStore.hasShellMetacharacters('npm test && curl evil'), true)
    assert.equal(SessionPermissionStore.hasShellMetacharacters('npm test'), false)
    assert.equal(SessionPermissionStore.hasShellMetacharacters('echo hi | wc'), true)
  })

  it('percent is metachar only on win32', () => {
    if (process.platform === 'win32') {
      assert.equal(SessionPermissionStore.hasShellMetacharacters('echo %PATH%'), true)
    } else {
      assert.equal(SessionPermissionStore.hasShellMetacharacters('echo %PATH%'), false)
    }
  })

  it('argv prefix match allows extended args for simple commands', () => {
    assert.equal(SessionPermissionStore.argvPrefixMatch('npm test', 'npm test -- --watch=false'), true)
    assert.equal(SessionPermissionStore.argvPrefixMatch('npm test', 'npm run build'), false)
    assert.equal(SessionPermissionStore.argvPrefixMatch('npm test && evil', 'npm test'), false)
  })

  it('remembers argv-safe allows across matching simple commands', () => {
    const store = new SessionPermissionStore()
    store.rememberCommand('npm test', 'allow')
    assert.equal(store.lookupCommand('npm test --bar'), 'allow')
    assert.equal(store.lookupCommand('npm run build'), undefined)
  })

  it('metachar commands require exact session match', () => {
    const store = new SessionPermissionStore()
    store.rememberCommand('npm test && echo ok', 'allow')
    assert.equal(store.lookupCommand('npm test && echo ok'), 'allow')
    assert.equal(store.lookupCommand('npm test && echo bad'), undefined)
    assert.equal(store.lookupCommand('npm test'), undefined)
  })

  it('exact deny wins for that command only', () => {
    const store = new SessionPermissionStore()
    store.rememberCommand('rm -rf /', 'deny')
    assert.equal(store.lookupCommand('rm -rf /'), 'deny')
    assert.equal(store.lookupCommand('rm -rf ./tmp'), undefined)
  })

  it('remembers path allows by exact path key', () => {
    const store = new SessionPermissionStore()
    store.rememberPath('.env.local', 'allow')
    assert.equal(store.lookupPath('.env.local'), 'allow')
    assert.equal(store.lookupPath('.env'), undefined)
  })

  it('supports wildcard path rules in session', () => {
    const store = new SessionPermissionStore()
    store.rememberPathPattern('src/secrets/*', 'allow')
    assert.equal(store.lookupPath('src/secrets/dev.env'), 'allow')
    assert.equal(store.lookupPath('src/public/app.ts'), undefined)
  })
})

describe('isOverbroadPattern', () => {
  it('flags unsafe wildcard patterns', () => {
    assert.equal(isOverbroadPattern('*'), true)
    assert.equal(isOverbroadPattern('npm *'), true)
    assert.equal(isOverbroadPattern('src/*'), true)
    assert.equal(isOverbroadPattern('src/secrets/*'), false)
    assert.equal(isOverbroadPattern('https://api.example.com/*'), false)
  })
})

describe('PersistentPermissionStore', () => {
  let root: string
  let userStorageDir: string

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-perm-'))
    userStorageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trie-user-'))
  })

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(userStorageDir, { recursive: true, force: true })
  })

  it('persists command allows to user storage, not repo permissions.json', () => {
    const store = new PersistentPermissionStore(root, userStorageDir)
    store.rememberCommandAlways('npm test')
    const repoFile = path.join(root, '.trie-ide', 'permissions.json')
    assert.equal(fs.existsSync(repoFile), false)
    const userDir = path.join(userStorageDir, 'agent-permissions')
    assert.ok(fs.existsSync(userDir))
    const userFiles = fs.readdirSync(userDir)
    assert.equal(userFiles.length, 1)
    const reloaded = new PersistentPermissionStore(root, userStorageDir)
    assert.equal(reloaded.lookupCommand('npm test --watch'), 'allow')
  })

  it('persists path allows by exact key in user storage', () => {
    const store = new PersistentPermissionStore(root, userStorageDir)
    store.rememberPathAlways('.env.local')
    const reloaded = new PersistentPermissionStore(root, userStorageDir)
    assert.equal(reloaded.lookupPath('.env.local'), 'allow')
    assert.equal(reloaded.lookupPath('.env'), undefined)
  })

  it('session deny overrides before persisted allow is checked', () => {
    const store = new PersistentPermissionStore(root, userStorageDir)
    store.rememberCommandAlways('npm test')
    store.rememberCommand('npm test', 'deny')
    assert.equal(store.lookupCommand('npm test'), 'deny')
  })

  it('rejects overbroad persisted command patterns', () => {
    const store = new PersistentPermissionStore(root, userStorageDir)
    store.rememberCommandPatternAlways('npm *')
    const reloaded = new PersistentPermissionStore(root, userStorageDir)
    assert.equal(reloaded.lookupCommand('npm test -- --watch'), undefined)
  })

  it('ignores repo allowedCommands and allowed*Patterns (restrictive-only repo file)', () => {
    fs.mkdirSync(path.join(root, '.trie-ide'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.trie-ide', 'permissions.json'),
      JSON.stringify({
        allowedCommands: ['rm -rf /'],
        allowedPaths: ['.env'],
        allowedCommandPatterns: ['npm *'],
        toolDefaults: { run_command: 'allow' },
      }),
      'utf8',
    )
    const store = new PersistentPermissionStore(root, userStorageDir)
    assert.equal(store.lookupCommand('rm -rf /'), undefined)
    assert.equal(store.lookupPath('.env'), undefined)
    assert.equal(store.lookupCommand('npm test'), undefined)
    assert.equal(store.toolDefault('run_command', 'default', 'ask'), 'ask')
  })

  it('applies repo deny/ask toolDefaults but not allow', () => {
    fs.mkdirSync(path.join(root, '.trie-ide'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.trie-ide', 'permissions.json'),
      JSON.stringify({ toolDefaults: { run_command: 'deny', sensitive_write: 'ask' } }),
      'utf8',
    )
    const store = new PersistentPermissionStore(root, userStorageDir)
    assert.equal(store.toolDefault('run_command', 'default', 'ask'), 'deny')
    assert.equal(store.toolDefault('sensitive_write', 'default', 'ask'), 'ask')
  })

  it('applies profile-based tool defaults when repo has no override', () => {
    const store = new PersistentPermissionStore(root, userStorageDir)
    assert.equal(store.toolDefault('run_command', 'default', 'ask'), 'ask')
    assert.equal(store.toolDefault('run_command', 'auto-approve', 'ask'), 'allow')
    assert.equal(store.toolDefault('sensitive_write', 'explore', 'ask'), 'deny')
  })

  it('supports persisted URL wildcard patterns in user storage', () => {
    const store = new PersistentPermissionStore(root, userStorageDir)
    store.rememberUrlPatternAlways('https://api.example.com/*')
    const reloaded = new PersistentPermissionStore(root, userStorageDir)
    assert.equal(reloaded.lookupUrl('https://api.example.com/v1/list'), 'allow')
  })
})

describe('isSensitivePath', () => {
  it('flags env files, keys, hooks, and credential paths', () => {
    assert.equal(isSensitivePath('.env'), true)
    assert.equal(isSensitivePath('.env.production'), true)
    assert.equal(isSensitivePath('secrets/api.pem'), true)
    assert.equal(isSensitivePath('.git/hooks/pre-commit'), true)
    assert.equal(isSensitivePath('src/index.ts'), false)
  })
})
